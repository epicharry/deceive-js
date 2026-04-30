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

  for (const stanza of stanzas) {
    if (stanza.type === 'presence') {
      console.log('[proxy] Blocked presence stanza');
    } else {
      output += stanza.data;
    }
  }

  return { output, remaining };
}

// ============================================================
// Chat Proxy - Plain TCP on local side, TLS to Riot server
//
// Architecture:
//   Riot Client --[plain TCP]--> Local Proxy --[TLS]--> Riot Chat Server
//
// We tell Riot to disable TLS for chat (chat.use_tls.enabled=false)
// so it connects to us over plain TCP. We then establish a TLS
// connection to the real Riot server on the upstream side.
// This avoids all certificate trust issues.
// ============================================================

function startChatProxy(listenPort) {
  chatServer = net.createServer((clientSocket) => {
    console.log('[proxy] Riot Client connected (plain TCP)');

    let clientBuffer = '';
    let pendingData = [];
    let riotSocket = null;
    let riotConnected = false;
    let destroyed = false;

    function cleanup() {
      if (destroyed) return;
      destroyed = true;
      if (riotSocket && !riotSocket.destroyed) riotSocket.destroy();
      if (!clientSocket.destroyed) clientSocket.destroy();
      connections = connections.filter((c) => c !== clientSocket);
    }

    function attemptConnect() {
      if (destroyed) return;
      if (!chatHost || !chatPort) {
        setTimeout(attemptConnect, 100);
        return;
      }

      // Connect to the real Riot chat server over TLS
      riotSocket = tls.connect(
        {
          host: chatHost,
          port: chatPort,
          rejectUnauthorized: false,
        },
        () => {
          if (destroyed) { riotSocket.destroy(); return; }
          riotConnected = true;
          console.log(`[proxy] Connected to Riot chat (TLS): ${chatHost}:${chatPort}`);
          for (const chunk of pendingData) {
            processClientData(chunk);
          }
          pendingData = [];
        }
      );

      // Riot -> Client (passthrough)
      riotSocket.on('data', (data) => {
        if (!clientSocket.destroyed && clientSocket.writable) {
          clientSocket.write(data);
        }
      });

      riotSocket.on('end', () => { cleanup(); });
      riotSocket.on('close', () => { cleanup(); });
      riotSocket.on('error', (err) => {
        console.log('[proxy] Riot socket error:', err.message);
        cleanup();
      });
    }

    function processClientData(str) {
      clientBuffer += str;
      const { output, remaining } = filterOutgoingData(clientBuffer);
      clientBuffer = remaining;
      if (output.length > 0 && riotSocket && riotSocket.writable) {
        riotSocket.write(output);
      }
    }

    // Client -> Proxy (plain TCP, with presence filtering)
    clientSocket.on('data', (data) => {
      if (destroyed) return;
      const str = data.toString('utf-8');
      if (!riotConnected) {
        pendingData.push(str);
        return;
      }
      processClientData(str);
    });

    clientSocket.on('end', () => { cleanup(); });
    clientSocket.on('close', () => { cleanup(); });
    clientSocket.on('error', (err) => {
      if (err.code !== 'ECONNRESET') {
        console.log('[proxy] Client socket error:', err.message);
      }
      cleanup();
    });

    connections.push(clientSocket);
    attemptConnect();
  });

  chatServer.listen(listenPort, '127.0.0.1', () => {
    console.log(`[proxy] Chat proxy listening on 127.0.0.1:${chatServer.address().port} (plain TCP)`);
  });

  chatServer.on('error', (err) => {
    console.error('[proxy] Chat server error:', err.message);
  });

  return chatServer;
}

// ============================================================
// Config HTTP Proxy
// ============================================================

function startConfigProxy(chatProxyPort) {
  configServer = http.createServer(async (req, res) => {
    const url = `${RIOT_CONFIG_URL}${req.url}`;
    console.log(`[config-proxy] Proxying: ${req.url}`);

    try {
      const headers = {};
      // Forward all relevant headers
      const forwardHeaders = [
        'user-agent', 'authorization', 'x-riot-entitlements-jwt',
        'x-riot-rso-jwt', 'x-riot-clientplatform', 'x-riot-clientversion',
      ];
      for (const h of forwardHeaders) {
        if (req.headers[h]) headers[h] = req.headers[h];
      }
      if (!headers['user-agent']) headers['user-agent'] = 'RiotClient';

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

      // Only patch responses that contain chat configuration
      const hasChatConfig = 'chat.host' in config || 'chat.affinities' in config || 'chat.port' in config;

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
        config['chat.host'] = '127.0.0.1';
      }

      if (typeof config['chat.port'] === 'number') {
        resolvedChatPort = config['chat.port'];
      }
      config['chat.port'] = chatProxyPort;

      // Resolve player affinity
      if (config['chat.affinities'] && typeof config['chat.affinities'] === 'object') {
        const affinities = config['chat.affinities'];

        if (config['chat.affinity.enabled'] === true && req.headers['authorization']) {
          try {
            const pasResponse = await fetchUrlFull(GEO_PAS_URL, {
              Authorization: req.headers['authorization'],
            });
            const parts = pasResponse.body.split('.');
            if (parts.length >= 2) {
              const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
              if (payload.affinity && affinities[payload.affinity]) {
                resolvedChatHost = affinities[payload.affinity];
                console.log(`[config-proxy] Player affinity: ${payload.affinity} -> ${resolvedChatHost}`);
              }
            }
          } catch (err) {
            console.log('[config-proxy] Failed to resolve affinity:', err.message);
          }
        }

        for (const key of Object.keys(affinities)) {
          affinities[key] = '127.0.0.1';
        }
      }

      // CRITICAL: Disable TLS for chat so Riot connects to us over plain TCP
      // This eliminates all certificate trust issues
      config['chat.use_tls.enabled'] = false;

      // Disable affinity so it uses chat.host directly
      config['chat.affinity.enabled'] = false;

      // Store the real chat server for our upstream TLS connection
      if (resolvedChatHost) {
        chatHost = resolvedChatHost;
        chatPort = resolvedChatPort;
        console.log(`[config-proxy] Real chat server: ${chatHost}:${chatPort}`);
      }

      const modified = JSON.stringify(config);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(modified);
      console.log('[config-proxy] Patched chat config (TLS disabled for local connection)');
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
    req.setTimeout(10000, () => { req.destroy(new Error('Request timeout')); });
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
  const processes = ['RiotClientServices', 'RiotClientUx', 'RiotClientCrashHandler', 'VALORANT-Win64-Shipping'];
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
  const chatProxyPort = options.chatProxyPort || 0;

  const chatSrv = startChatProxy(chatProxyPort);

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
    if (!conn.destroyed) conn.destroy();
  }
  connections = [];
  if (chatServer) { chatServer.close(); chatServer = null; }
  if (configServer) { configServer.close(); configServer = null; }
  chatHost = '';
  chatPort = 0;
  console.log('[proxy] All proxies stopped');
}

module.exports = { startProxy, stopProxy };
