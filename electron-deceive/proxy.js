const net = require('net');
const tls = require('tls');
const http = require('http');
const https = require('https');
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

// ============================================================
// Chat Proxy - Plain TCP (local) <-> TLS (upstream Riot)
//
// We disable TLS on the client side via config patching:
//   chat.use_tls.enabled = false
//
// The client connects to us over plain TCP.
// We connect to Riot's chat server over TLS.
// We filter outgoing presence stanzas to hide online status.
// ============================================================

function startChatProxy(listenPort) {
  chatServer = net.createServer((clientSocket) => {
    console.log('[chat] New client connection');

    let riotSocket = null;
    let destroyed = false;
    let clientPaused = false;

    function cleanup(reason) {
      if (destroyed) return;
      destroyed = true;
      console.log(`[chat] Connection closed: ${reason}`);
      if (riotSocket && !riotSocket.destroyed) riotSocket.destroy();
      if (!clientSocket.destroyed) clientSocket.destroy();
      connections = connections.filter((c) => c !== clientSocket);
    }

    // Pause client until we're connected upstream
    clientSocket.pause();
    clientPaused = true;

    if (!chatHost || !chatPort) {
      console.log('[chat] Waiting for chat server config...');
      const interval = setInterval(() => {
        if (destroyed) { clearInterval(interval); return; }
        if (chatHost && chatPort) {
          clearInterval(interval);
          connectUpstream();
        }
      }, 50);
    } else {
      connectUpstream();
    }

    function connectUpstream() {
      riotSocket = tls.connect(
        { host: chatHost, port: chatPort, rejectUnauthorized: false },
        () => {
          if (destroyed) { riotSocket.destroy(); return; }
          console.log(`[chat] Upstream TLS connected: ${chatHost}:${chatPort}`);
          // Now resume the client - bidirectional pipe is ready
          if (clientPaused) {
            clientSocket.resume();
            clientPaused = false;
          }
        }
      );

      // Upstream -> Client (passthrough, no filtering needed on server responses)
      riotSocket.on('data', (data) => {
        if (!clientSocket.destroyed && clientSocket.writable) {
          const ok = clientSocket.write(data);
          if (!ok) riotSocket.pause();
          // Log first few bytes for debugging
          const preview = data.toString('utf-8').substring(0, 120);
          console.log(`[chat] S->C (${data.length}b): ${preview}`);
        }
      });

      riotSocket.on('end', () => cleanup('upstream FIN'));
      riotSocket.on('close', () => cleanup('upstream close'));
      riotSocket.on('error', (err) => cleanup(`upstream error: ${err.message}`));
    }

    // Client -> Upstream (with presence filtering)
    clientSocket.on('data', (data) => {
      if (destroyed || !riotSocket || !riotSocket.writable) return;

      const str = data.toString('utf-8');
      const preview = str.substring(0, 120);
      console.log(`[chat] C->S (${data.length}b): ${preview}`);

      // Filter presence stanzas
      if (str.includes('<presence')) {
        const filtered = removePresenceStanzas(str);
        if (filtered.length > 0) {
          riotSocket.write(filtered);
        }
      } else {
        const ok = riotSocket.write(data);
        if (!ok) clientSocket.pause();
      }
    });

    clientSocket.on('drain', () => {
      if (riotSocket && !riotSocket.destroyed) riotSocket.resume();
    });

    clientSocket.on('end', () => cleanup('client FIN'));
    clientSocket.on('close', () => cleanup('client close'));
    clientSocket.on('error', (err) => {
      if (err.code !== 'ECONNRESET') cleanup(`client error: ${err.message}`);
      else cleanup('client reset');
    });

    if (riotSocket) {
      riotSocket.on('drain', () => {
        if (!clientSocket.destroyed) clientSocket.resume();
      });
    }

    connections.push(clientSocket);
  });

  chatServer.listen(listenPort, '127.0.0.1', () => {
    console.log(`[chat] Listening on 127.0.0.1:${chatServer.address().port} (plain TCP)`);
  });

  chatServer.on('error', (err) => {
    console.error('[chat] Server error:', err.message);
  });

  return chatServer;
}

// Remove <presence>...</presence> and <presence .../> stanzas from a string
function removePresenceStanzas(str) {
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
// Config HTTP Proxy
// ============================================================

function startConfigProxy(chatProxyPort) {
  configServer = http.createServer(async (req, res) => {
    const url = `${RIOT_CONFIG_URL}${req.url}`;
    console.log(`[config] ${req.method} ${req.url}`);

    try {
      const headers = {};
      // DO NOT forward accept-encoding - we need plaintext responses to parse/patch
      const forwardHeaders = [
        'user-agent', 'authorization', 'x-riot-entitlements-jwt',
        'x-riot-rso-jwt', 'x-riot-clientplatform', 'x-riot-clientversion',
        'accept',
      ];
      for (const h of forwardHeaders) {
        if (req.headers[h]) headers[h] = req.headers[h];
      }
      if (!headers['user-agent']) headers['user-agent'] = 'RiotClient';
      // Force identity encoding so we get parseable text
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

      // Only patch if this has chat config
      const hasChatConfig = 'chat.host' in config ||
        'chat.affinities' in config ||
        'chat.port' in config;

      if (!hasChatConfig) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(response.body);
        return;
      }

      // --- Patch chat config ---
      let resolvedChatHost = null;
      let resolvedChatPort = 5223;

      // Save original host
      if (typeof config['chat.host'] === 'string') {
        resolvedChatHost = config['chat.host'];
      }
      if (typeof config['chat.port'] === 'number') {
        resolvedChatPort = config['chat.port'];
      }

      // Resolve affinity (get the actual regional server)
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
            console.log(`[config] Affinity lookup failed: ${err.message}`);
          }
        }

        // Redirect all affinities to localhost
        for (const key of Object.keys(affinities)) {
          affinities[key] = '127.0.0.1';
        }
      }

      // Redirect to our proxy
      config['chat.host'] = '127.0.0.1';
      config['chat.port'] = chatProxyPort;

      // CRITICAL: Disable TLS for the local connection
      // The client will connect to us over plain TCP
      config['chat.use_tls.enabled'] = false;

      // Disable affinity routing
      config['chat.affinity.enabled'] = false;

      // Store real server for upstream connection
      if (resolvedChatHost) {
        chatHost = resolvedChatHost;
        chatPort = resolvedChatPort;
        console.log(`[config] Real chat server: ${chatHost}:${chatPort}`);
      }

      // Log what we're sending back
      console.log(`[config] Patched: host=127.0.0.1:${chatProxyPort}, tls=false, affinity=false`);

      const modified = JSON.stringify(config);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(modified);
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

module.exports = { startProxy, stopProxy };
