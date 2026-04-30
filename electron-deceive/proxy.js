const net = require('net');
const tls = require('tls');
const http = require('http');
const https = require('https');
const forge = require('node-forge');
const { execSync, spawn } = require('child_process');
const { existsSync, readFileSync } = require('fs');
const { join } = require('path');

// --- Constants ---
const RIOT_CONFIG_URL = 'https://clientconfig.rpg.riotgames.com';
const GEO_PAS_URL = 'https://riot-geo.pas.si.riotgames.com/pas/v1/service/chat';

// --- State ---
let configServer = null;
let chatServer = null;
let chatHost = '';
let chatPort = 0;
let connections = [];
let tlsCert = null;
let filteringEnabled = true;

// ============================================================
// Certificate Generation
// ============================================================

function generateCert() {
  if (tlsCert) return tlsCert;

  console.log('[cert] Generating self-signed certificate...');
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01' + Date.now().toString(16);
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 10);

  const attrs = [
    { name: 'commonName', value: '127.0.0.1' },
    { name: 'organizationName', value: 'Deceive' },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: 'basicConstraints', cA: true },
    { name: 'keyUsage', keyCertSign: true, digitalSignature: true, keyEncipherment: true },
    {
      name: 'subjectAltName',
      altNames: [
        { type: 2, value: 'localhost' },
        { type: 7, ip: '127.0.0.1' },
      ],
    },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());

  tlsCert = {
    cert: forge.pki.certificateToPem(cert),
    key: forge.pki.privateKeyToPem(keys.privateKey),
  };
  console.log('[cert] Certificate generated');
  return tlsCert;
}

// ============================================================
// XMPP Presence Filter
// Blocks outgoing <presence> stanzas (client -> server)
// Passes through everything else unchanged
// ============================================================

function removePresenceStanzas(str) {
  if (!filteringEnabled) return str;
  if (!str.includes('<presence')) return str;

  let result = str;
  let blocked = false;

  // Self-closing: <presence ... />
  result = result.replace(/<presence[^>]*\/>/g, () => { blocked = true; return ''; });
  // Full: <presence ...>...</presence>
  result = result.replace(/<presence[^>]*>[\s\S]*?<\/presence>/g, () => { blocked = true; return ''; });

  if (blocked) console.log('[chat] Blocked presence stanza');
  return result;
}

// ============================================================
// Chat TLS Proxy
//
// Architecture:
//   Riot Client --[TLS]--> Our TLS Server --[TLS]--> Riot Chat Server
//
// chat.allow_bad_cert.enabled=true tells Riot to accept our self-signed cert.
// The first few connections may fail before the client loads patched config.
// ============================================================

function startChatProxy(listenPort) {
  const { cert, key } = generateCert();

  chatServer = tls.createServer({ key, cert }, (clientSocket) => {
    console.log('[chat] Client connected (TLS handshake OK)');

    let riotSocket = null;
    let destroyed = false;
    let pendingData = [];

    function cleanup(reason) {
      if (destroyed) return;
      destroyed = true;
      if (reason) console.log(`[chat] Closed: ${reason}`);
      if (riotSocket && !riotSocket.destroyed) riotSocket.destroy();
      if (!clientSocket.destroyed) clientSocket.destroy();
      connections = connections.filter((c) => c !== clientSocket);
    }

    // Pause client until upstream is ready
    clientSocket.pause();

    function connectUpstream() {
      if (destroyed) return;
      if (!chatHost || !chatPort) {
        setTimeout(connectUpstream, 100);
        return;
      }

      riotSocket = tls.connect(
        { host: chatHost, port: chatPort, rejectUnauthorized: false },
        () => {
          if (destroyed) { riotSocket.destroy(); return; }
          console.log(`[chat] Upstream connected: ${chatHost}:${chatPort}`);

          // Flush buffered client data
          for (const chunk of pendingData) {
            const filtered = removePresenceStanzas(chunk);
            if (filtered.length > 0) riotSocket.write(filtered);
          }
          pendingData = [];

          // Resume client data flow
          clientSocket.resume();
        }
      );

      // Server -> Client (passthrough)
      riotSocket.on('data', (data) => {
        if (!clientSocket.destroyed && clientSocket.writable) {
          clientSocket.write(data);
        }
      });

      riotSocket.on('end', () => cleanup('upstream end'));
      riotSocket.on('close', () => cleanup('upstream close'));
      riotSocket.on('error', (err) => cleanup(`upstream error: ${err.message}`));

      riotSocket.on('drain', () => {
        if (!clientSocket.destroyed) clientSocket.resume();
      });
    }

    // Client -> Server (with presence filtering)
    clientSocket.on('data', (data) => {
      if (destroyed) return;
      const str = data.toString('utf-8');

      if (!riotSocket || riotSocket.connecting) {
        pendingData.push(str);
        return;
      }

      const filtered = removePresenceStanzas(str);
      if (filtered.length > 0 && riotSocket.writable) {
        const ok = riotSocket.write(filtered);
        if (!ok) clientSocket.pause();
      }
    });

    clientSocket.on('drain', () => {
      if (riotSocket && !riotSocket.destroyed) riotSocket.resume();
    });

    clientSocket.on('end', () => cleanup('client end'));
    clientSocket.on('close', () => cleanup('client close'));
    clientSocket.on('error', (err) => {
      if (err.code !== 'ECONNRESET') cleanup(`client error: ${err.message}`);
      else cleanup('client reset');
    });

    connections.push(clientSocket);
    connectUpstream();
  });

  // Log TLS handshake failures silently (expected before config is loaded)
  chatServer.on('tlsClientError', (err) => {
    // Only log once to avoid spam - these are expected before allow_bad_cert takes effect
    if (!chatServer._loggedTlsError) {
      console.log('[chat] TLS handshake rejected (expected before config loads)');
      chatServer._loggedTlsError = true;
    }
  });

  chatServer.listen(listenPort, '127.0.0.1', () => {
    console.log(`[chat] TLS proxy listening on 127.0.0.1:${chatServer.address().port}`);
  });

  return chatServer;
}

// ============================================================
// Config HTTP Proxy
// ============================================================

function startConfigProxy(chatProxyPort) {
  configServer = http.createServer(async (req, res) => {
    const url = `${RIOT_CONFIG_URL}${req.url}`;
    console.log(`[config] ${req.method} ${req.url}`);

    try {
      const headers = {};
      const forwardHeaders = [
        'user-agent', 'authorization', 'x-riot-entitlements-jwt',
        'x-riot-rso-jwt', 'x-riot-clientplatform', 'x-riot-clientversion',
        'accept',
      ];
      for (const h of forwardHeaders) {
        if (req.headers[h]) headers[h] = req.headers[h];
      }
      if (!headers['user-agent']) headers['user-agent'] = 'RiotClient';
      headers['accept-encoding'] = 'identity';

      const response = await fetchUrlFull(url, headers);

      if (response.statusCode !== 200) {
        res.writeHead(response.statusCode, { 'Content-Type': response.contentType });
        res.end(response.body);
        return;
      }

      let config;
      try {
        config = JSON.parse(response.body);
      } catch {
        res.writeHead(200, { 'Content-Type': response.contentType });
        res.end(response.body);
        return;
      }

      // Only patch responses containing chat configuration
      const hasChatConfig = 'chat.host' in config ||
        'chat.affinities' in config ||
        'chat.port' in config;

      if (!hasChatConfig) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(response.body);
        return;
      }

      // --- Patch chat configuration ---
      let resolvedChatHost = null;
      let resolvedChatPort = 5223;

      if (typeof config['chat.host'] === 'string') {
        resolvedChatHost = config['chat.host'];
      }
      if (typeof config['chat.port'] === 'number') {
        resolvedChatPort = config['chat.port'];
      }

      // Resolve player affinity
      if (config['chat.affinities'] && typeof config['chat.affinities'] === 'object') {
        const affinities = config['chat.affinities'];

        if (req.headers['authorization']) {
          try {
            const pasResponse = await fetchUrlFull(GEO_PAS_URL, {
              Authorization: req.headers['authorization'],
            });
            const parts = pasResponse.body.split('.');
            if (parts.length >= 2) {
              const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
              if (payload.affinity && affinities[payload.affinity]) {
                resolvedChatHost = affinities[payload.affinity];
                console.log(`[config] Affinity: ${payload.affinity} -> ${resolvedChatHost}`);
              }
            }
          } catch (err) {
            console.log(`[config] Affinity failed: ${err.message}`);
          }
        }

        // Redirect all affinities to localhost
        for (const key of Object.keys(affinities)) {
          affinities[key] = '127.0.0.1';
        }
      }

      // Redirect to our TLS proxy
      config['chat.host'] = '127.0.0.1';
      config['chat.port'] = chatProxyPort;

      // CRITICAL: Tell Riot to accept our self-signed certificate
      config['chat.allow_bad_cert.enabled'] = true;

      // Disable affinity routing
      config['chat.affinity.enabled'] = false;

      // Store real server for upstream
      if (resolvedChatHost) {
        chatHost = resolvedChatHost;
        chatPort = resolvedChatPort;
        console.log(`[config] Real server: ${chatHost}:${chatPort}`);
      }

      console.log(`[config] Patched: host=127.0.0.1:${chatProxyPort}, allow_bad_cert=true`);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(config));
    } catch (err) {
      console.error('[config] Error:', err.message);
      res.writeHead(502);
      res.end('Bad Gateway');
    }
  });

  configServer.listen(0, '127.0.0.1', () => {
    console.log(`[config] Listening on 127.0.0.1:${configServer.address().port}`);
  });

  return configServer;
}

function fetchUrlFull(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers, rejectUnauthorized: false }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          contentType: res.headers['content-type'] || 'application/octet-stream',
          body: data,
        });
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(new Error('timeout')); });
  });
}

// ============================================================
// Riot Client Launcher
// ============================================================

function findRiotClient() {
  const installPath = join(
    process.env.PROGRAMDATA || 'C:\\ProgramData',
    'Riot Games',
    'RiotClientInstalls.json'
  );
  if (!existsSync(installPath)) return null;
  try {
    const data = JSON.parse(readFileSync(installPath, 'utf-8'));
    const candidates = [data.rc_default, data.rc_live, data.rc_beta].filter(
      (p) => typeof p === 'string' && existsSync(p)
    );
    return candidates[0] || null;
  } catch { return null; }
}

function isRiotClientRunning() {
  try {
    return execSync('tasklist /fo csv /nh', { encoding: 'utf-8' }).toLowerCase().includes('riotclientservices');
  } catch { return false; }
}

function killRiotClient() {
  for (const name of ['RiotClientServices', 'RiotClientUx', 'RiotClientCrashHandler', 'VALORANT-Win64-Shipping']) {
    try { execSync(`taskkill /f /im ${name}.exe`, { stdio: 'ignore' }); } catch {}
  }
}

function launchRiotClient(riotClientPath, configProxyPort) {
  const args = [
    `--client-config-url=http://127.0.0.1:${configProxyPort}`,
    '--launch-product=valorant',
    '--launch-patchline=live',
  ];
  console.log(`[launcher] ${riotClientPath} ${args.join(' ')}`);
  const proc = spawn(riotClientPath, args, { detached: true, stdio: 'ignore' });
  proc.unref();
  proc.on('error', (err) => console.error('[launcher] Error:', err.message));
}

// ============================================================
// Public API
// ============================================================

function startProxy(options = {}) {
  const chatSrv = startChatProxy(options.chatProxyPort || 0);

  chatSrv.on('listening', () => {
    const actualChatPort = chatSrv.address().port;
    const cfgSrv = startConfigProxy(actualChatPort);

    cfgSrv.on('listening', () => {
      const configPort = cfgSrv.address().port;
      if (options.autoLaunch !== false) {
        if (isRiotClientRunning()) {
          console.log('[launcher] Killing existing Riot Client...');
          killRiotClient();
          setTimeout(() => launchAfterKill(configPort, options), 3000);
        } else {
          launchAfterKill(configPort, options);
        }
      }
    });
  });
}

function launchAfterKill(configPort, options) {
  const riotPath = options.riotClientPath || findRiotClient();
  if (!riotPath) {
    console.error('[launcher] Could not find Riot Client.');
    return;
  }
  launchRiotClient(riotPath, configPort);
}

function stopProxy() {
  for (const conn of connections) { if (!conn.destroyed) conn.destroy(); }
  connections = [];
  if (chatServer) { chatServer.close(); chatServer = null; }
  if (configServer) { configServer.close(); configServer = null; }
  chatHost = '';
  chatPort = 0;
  console.log('[proxy] Stopped');
}

module.exports = { startProxy, stopProxy, setFilteringEnabled: (v) => { filteringEnabled = v; } };
