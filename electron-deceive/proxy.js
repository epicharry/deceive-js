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

// ============================================================
// Certificate Generation
// ============================================================

function generateSelfSignedCert() {
  if (tlsCert) return tlsCert;

  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 10);

  const attrs = [
    { name: 'commonName', value: 'Deceive Proxy CA' },
    { name: 'organizationName', value: 'Deceive' },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: 'basicConstraints', cA: true },
    { name: 'keyUsage', keyCertSign: true, digitalSignature: true, keyEncipherment: true },
    { name: 'subjectAltName', altNames: [{ type: 2, value: 'localhost' }, { type: 7, ip: '127.0.0.1' }] },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());

  tlsCert = {
    cert: forge.pki.certificateToPem(cert),
    key: forge.pki.privateKeyToPem(keys.privateKey),
  };
  return tlsCert;
}

// ============================================================
// XMPP Stanza Parser + Presence Filter
// ============================================================

function extractCompleteStanzas(buffer) {
  const stanzas = [];
  let remaining = buffer;

  while (remaining.length > 0) {
    // Stream opening
    if (remaining.startsWith('<?xml') || remaining.startsWith('<stream:stream')) {
      const end = remaining.indexOf('>');
      if (end === -1) break;
      stanzas.push({ data: remaining.substring(0, end + 1), type: 'stream' });
      remaining = remaining.substring(end + 1);
      continue;
    }

    // Stream closing
    if (remaining.startsWith('</stream:stream>')) {
      stanzas.push({ data: '</stream:stream>', type: 'stream' });
      remaining = remaining.substring('</stream:stream>'.length);
      continue;
    }

    // Whitespace keepalive
    const trimmed = remaining.trimStart();
    if (trimmed.length === 0) {
      stanzas.push({ data: remaining, type: 'whitespace' });
      remaining = '';
      continue;
    }
    if (trimmed.length < remaining.length && !trimmed.startsWith('<')) {
      stanzas.push({ data: remaining.substring(0, remaining.length - trimmed.length), type: 'whitespace' });
      remaining = trimmed;
      continue;
    }

    // Find the tag name
    const tagMatch = remaining.match(/^<([a-zA-Z:][a-zA-Z0-9:._-]*)/);
    if (!tagMatch) break;
    const tagName = tagMatch[1];

    // Self-closing tag
    const selfCloseRegex = new RegExp(`^<${tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^>]*/>`);
    const selfCloseMatch = remaining.match(selfCloseRegex);
    if (selfCloseMatch) {
      stanzas.push({ data: selfCloseMatch[0], type: tagName });
      remaining = remaining.substring(selfCloseMatch[0].length);
      continue;
    }

    // Find matching close tag with nesting support
    const closeTag = `</${tagName}>`;
    let depth = 0;
    let pos = 0;
    let found = false;

    while (pos < remaining.length) {
      const openTag = remaining.indexOf(`<${tagName}`, pos);
      const closePos = remaining.indexOf(closeTag, pos);

      if (closePos === -1) break;

      if (openTag !== -1 && openTag < closePos) {
        const charAfterTag = remaining[openTag + tagName.length + 1];
        if (charAfterTag === ' ' || charAfterTag === '>' || charAfterTag === '/' || charAfterTag === undefined) {
          depth++;
        }
        pos = openTag + 1;
      } else {
        if (depth === 0) {
          const endPos = closePos + closeTag.length;
          stanzas.push({ data: remaining.substring(0, endPos), type: tagName });
          remaining = remaining.substring(endPos);
          found = true;
          break;
        }
        depth--;
        pos = closePos + 1;
      }
    }

    if (!found) break;
  }

  return { stanzas, remaining };
}

function filterOutgoingData(buffer) {
  const { stanzas, remaining } = extractCompleteStanzas(buffer);
  let output = '';
  let blocked = false;

  for (const stanza of stanzas) {
    if (stanza.type === 'presence') {
      blocked = true;
      console.log('[proxy] Blocked presence stanza');
    } else {
      output += stanza.data;
    }
  }

  return { output, remaining, blocked };
}

// ============================================================
// Chat TLS Proxy (localhost:chatProxyPort <-> Riot Chat Server)
// ============================================================

function startChatProxy(listenPort) {
  const { cert, key } = generateSelfSignedCert();

  chatServer = tls.createServer({ key, cert }, (clientSocket) => {
    console.log('[proxy] Riot Client connected to chat proxy');

    let clientBuffer = '';
    let pendingData = [];
    let riotSocket = null;

    // Wait for chatHost to be resolved by config proxy
    function attemptConnect() {
      if (!chatHost || !chatPort) {
        setTimeout(attemptConnect, 100);
        return;
      }

      riotSocket = tls.connect(
        { host: chatHost, port: chatPort, rejectUnauthorized: false },
        () => {
          console.log(`[proxy] Connected to Riot chat server: ${chatHost}:${chatPort}`);
          for (const chunk of pendingData) {
            processClientData(chunk);
          }
          pendingData = [];
        }
      );

      riotSocket.on('data', (data) => {
        if (clientSocket.writable) clientSocket.write(data);
      });

      riotSocket.on('close', () => {
        console.log('[proxy] Riot chat server disconnected');
        if (clientSocket.writable) clientSocket.destroy();
      });

      riotSocket.on('error', (err) => {
        console.log('[proxy] Riot socket error:', err.message);
        if (clientSocket.writable) clientSocket.destroy();
      });
    }

    function processClientData(data) {
      clientBuffer += data;
      const { output, remaining } = filterOutgoingData(clientBuffer);
      clientBuffer = remaining;
      if (output.length > 0 && riotSocket && riotSocket.writable) {
        riotSocket.write(output);
      }
    }

    clientSocket.on('data', (data) => {
      const str = data.toString('utf-8');
      if (!riotSocket || !riotSocket.writable) {
        pendingData.push(str);
        return;
      }
      processClientData(str);
    });

    clientSocket.on('close', () => {
      console.log('[proxy] Client disconnected from chat proxy');
      if (riotSocket) riotSocket.destroy();
      connections = connections.filter((c) => c !== clientSocket);
    });

    clientSocket.on('error', (err) => {
      console.log('[proxy] Client socket error:', err.message);
      if (riotSocket) riotSocket.destroy();
    });

    connections.push(clientSocket);
    attemptConnect();
  });

  chatServer.listen(listenPort, '127.0.0.1', () => {
    console.log(`[proxy] Chat TLS proxy listening on 127.0.0.1:${chatServer.address().port}`);
  });

  chatServer.on('error', (err) => {
    console.error('[proxy] Chat server error:', err.message);
  });

  return chatServer;
}

// ============================================================
// Config HTTP Proxy (intercepts Riot client config requests)
// ============================================================

function startConfigProxy(chatProxyPort) {
  configServer = http.createServer(async (req, res) => {
    const url = `${RIOT_CONFIG_URL}${req.url}`;
    console.log(`[config-proxy] Proxying: ${req.url}`);

    try {
      const headers = {
        'User-Agent': req.headers['user-agent'] || 'RiotClient',
      };
      if (req.headers['x-riot-entitlements-jwt']) {
        headers['X-Riot-Entitlements-JWT'] = req.headers['x-riot-entitlements-jwt'];
      }
      if (req.headers['authorization']) {
        headers['Authorization'] = req.headers['authorization'];
      }

      const body = await fetchUrl(url, headers);
      let config;

      try {
        config = JSON.parse(body);
      } catch {
        // Not JSON, pass through
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(body);
        return;
      }

      let resolvedChatHost = null;
      let resolvedChatPort = 0;

      // Patch chat.host
      if (config['chat.host'] && typeof config['chat.host'] === 'string') {
        resolvedChatHost = config['chat.host'];
        config['chat.host'] = '127.0.0.1';
      }

      // Patch chat.port
      if (config['chat.port'] && typeof config['chat.port'] === 'number') {
        resolvedChatPort = config['chat.port'];
        config['chat.port'] = chatProxyPort;
      }

      // Patch chat.affinities - resolve player's actual affinity
      if (config['chat.affinities'] && typeof config['chat.affinities'] === 'object') {
        const affinities = config['chat.affinities'];

        if (config['chat.affinity.enabled'] === true && req.headers['authorization']) {
          try {
            const pasJwt = await fetchUrl(GEO_PAS_URL, {
              Authorization: req.headers['authorization'],
            });
            const parts = pasJwt.split('.');
            if (parts.length >= 2) {
              const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
              const affinity = payload.affinity;
              if (affinity && affinities[affinity]) {
                resolvedChatHost = affinities[affinity];
                console.log(`[config-proxy] Player affinity: ${affinity} -> ${resolvedChatHost}`);
              }
            }
          } catch (err) {
            console.log('[config-proxy] Failed to resolve affinity:', err.message);
          }
        }

        // Redirect all affinities to localhost
        for (const key of Object.keys(affinities)) {
          affinities[key] = '127.0.0.1';
        }
      }

      // Allow bad cert (our self-signed)
      if ('chat.allow_bad_cert.enabled' in config) {
        config['chat.allow_bad_cert.enabled'] = true;
      }

      // Store resolved chat server for chat proxy to use
      if (resolvedChatHost && resolvedChatPort) {
        chatHost = resolvedChatHost;
        chatPort = resolvedChatPort;
        console.log(`[config-proxy] Real chat server: ${chatHost}:${chatPort}`);
      }

      const modified = JSON.stringify(config);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(modified);
    } catch (err) {
      console.error('[config-proxy] Error:', err.message);
      res.writeHead(502);
      res.end('Bad Gateway');
    }
  });

  configServer.listen(0, '127.0.0.1', () => {
    console.log(`[config-proxy] Config proxy listening on 127.0.0.1:${configServer.address().port}`);
  });

  return configServer;
}

function fetchUrl(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers, rejectUnauthorized: false }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
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

  if (!existsSync(installPath)) {
    console.log('[launcher] RiotClientInstalls.json not found');
    return null;
  }

  try {
    const data = JSON.parse(readFileSync(installPath, 'utf-8'));
    const candidates = [data.rc_default, data.rc_live, data.rc_beta].filter(
      (p) => typeof p === 'string' && existsSync(p)
    );
    return candidates[0] || null;
  } catch {
    return null;
  }
}

function isRiotClientRunning() {
  try {
    const result = execSync('tasklist /fo csv /nh', { encoding: 'utf-8' });
    return result.toLowerCase().includes('riotclientservices');
  } catch {
    return false;
  }
}

function killRiotClient() {
  const processes = ['RiotClientServices', 'RiotClientUx', 'RiotClientCrashHandler'];
  for (const name of processes) {
    try {
      execSync(`taskkill /f /im ${name}.exe`, { stdio: 'ignore' });
    } catch { /* ignore */ }
  }
}

function launchRiotClient(riotClientPath, configProxyPort) {
  const args = [
    `--client-config-url=http://127.0.0.1:${configProxyPort}`,
    '--launch-product=valorant',
    '--launch-patchline=live',
  ];

  console.log(`[launcher] Launching: ${riotClientPath} ${args.join(' ')}`);

  const proc = spawn(riotClientPath, args, { detached: true, stdio: 'ignore' });
  proc.unref();

  proc.on('error', (err) => {
    console.error('[launcher] Failed to launch Riot Client:', err.message);
  });
}

// ============================================================
// Public API
// ============================================================

function startProxy(options = {}) {
  const chatProxyPort = options.chatProxyPort || 0; // 0 = random available port

  // Generate cert early
  generateSelfSignedCert();

  // Start chat TLS proxy
  const chatSrv = startChatProxy(chatProxyPort);

  // Wait for chat server to bind, then start config proxy + launch game
  chatSrv.on('listening', () => {
    const actualChatPort = chatSrv.address().port;

    // Start config HTTP proxy
    const cfgSrv = startConfigProxy(actualChatPort);

    cfgSrv.on('listening', () => {
      const configPort = cfgSrv.address().port;

      // Kill existing Riot Client and relaunch with our config proxy
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

  return { chatServer: chatSrv, configServer };
}

function launchAfterKill(configPort, options) {
  const riotPath = options.riotClientPath || findRiotClient();
  if (!riotPath) {
    console.error('[launcher] Could not find Riot Client. Set options.riotClientPath manually.');
    return;
  }
  launchRiotClient(riotPath, configPort);
}

function stopProxy() {
  for (const conn of connections) {
    conn.destroy();
  }
  connections = [];
  if (chatServer) { chatServer.close(); chatServer = null; }
  if (configServer) { configServer.close(); configServer = null; }
  chatHost = '';
  chatPort = 0;
  console.log('[proxy] All proxies stopped');
}

module.exports = { startProxy, stopProxy };
