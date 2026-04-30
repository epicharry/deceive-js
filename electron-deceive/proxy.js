const tls = require('tls');
const net = require('net');
const forge = require('node-forge');

const DEFAULT_CONFIG = {
  riotChatHost: 'ap.chat.si.riotgames.com',
  riotChatPort: 5223,
  listenPort: 5223,
};

let config = { ...DEFAULT_CONFIG };
let server = null;
let connections = [];

function generateSelfSignedCert() {
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

  return {
    cert: forge.pki.certificateToPem(cert),
    key: forge.pki.privateKeyToPem(keys.privateKey),
  };
}

function isPresenceStanza(data) {
  const openIdx = data.indexOf('<presence');
  if (openIdx === -1) return false;
  const closeIdx = data.indexOf('</presence>', openIdx);
  if (closeIdx === -1) {
    // Could be a self-closing presence tag
    const selfClose = data.indexOf('/>', openIdx);
    if (selfClose !== -1 && selfClose < data.indexOf('<', openIdx + 1)) return true;
  }
  return closeIdx !== -1;
}

function extractCompleteStanzas(buffer) {
  const stanzas = [];
  let remaining = buffer;

  while (remaining.length > 0) {
    // Handle stream opening/closing
    if (remaining.startsWith('<?xml') || remaining.startsWith('<stream:stream')) {
      const end = remaining.indexOf('>');
      if (end === -1) break;
      stanzas.push({ data: remaining.substring(0, end + 1), type: 'stream' });
      remaining = remaining.substring(end + 1);
      continue;
    }

    if (remaining.startsWith('</stream:stream>')) {
      stanzas.push({ data: '</stream:stream>', type: 'stream' });
      remaining = remaining.substring('</stream:stream>'.length);
      continue;
    }

    // Handle whitespace keepalive
    if (remaining.trimStart().length === 0) {
      stanzas.push({ data: remaining, type: 'whitespace' });
      remaining = '';
      continue;
    }

    const trimmed = remaining.trimStart();
    if (trimmed.length < remaining.length && !trimmed.startsWith('<')) {
      stanzas.push({ data: remaining.substring(0, remaining.length - trimmed.length), type: 'whitespace' });
      remaining = trimmed;
      continue;
    }

    // Find the tag name
    const tagMatch = remaining.match(/^<([a-zA-Z:][a-zA-Z0-9:._-]*)/);
    if (!tagMatch) break;

    const tagName = tagMatch[1];

    // Check for self-closing tag
    const selfCloseRegex = new RegExp(`^<${tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^>]*/>`);
    const selfCloseMatch = remaining.match(selfCloseRegex);
    if (selfCloseMatch) {
      stanzas.push({ data: selfCloseMatch[0], type: tagName });
      remaining = remaining.substring(selfCloseMatch[0].length);
      continue;
    }

    // Find matching close tag, handling nesting
    const closeTag = `</${tagName}>`;
    let depth = 0;
    let pos = 0;
    let found = false;

    while (pos < remaining.length) {
      const openTag = remaining.indexOf(`<${tagName}`, pos);
      const closePos = remaining.indexOf(closeTag, pos);

      if (closePos === -1) break;

      if (openTag !== -1 && openTag < closePos) {
        // Check it's actually an opening tag (not a different tag starting with same prefix)
        const charAfterTag = remaining[openTag + tagName.length + 1];
        if (charAfterTag === ' ' || charAfterTag === '>' || charAfterTag === '/') {
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

    if (!found) break; // Incomplete stanza, wait for more data
  }

  return { stanzas, remaining };
}

function filterOutgoingData(data) {
  const { stanzas, remaining } = extractCompleteStanzas(data);
  let output = '';
  let blocked = false;

  for (const stanza of stanzas) {
    if (stanza.type === 'presence') {
      blocked = true;
      console.log('[deceive-proxy] Blocked outgoing presence stanza');
    } else {
      output += stanza.data;
    }
  }

  return { output, remaining, blocked };
}

function handleConnection(clientSocket) {
  console.log('[deceive-proxy] Client connected');

  let clientBuffer = '';
  let riotSocket = null;
  let pendingData = [];

  // Connect to actual Riot chat server via TLS
  riotSocket = tls.connect(
    {
      host: config.riotChatHost,
      port: config.riotChatPort,
      rejectUnauthorized: false,
    },
    () => {
      console.log(`[deceive-proxy] Connected to Riot server ${config.riotChatHost}:${config.riotChatPort}`);

      // Flush pending data
      for (const chunk of pendingData) {
        processClientData(chunk);
      }
      pendingData = [];
    }
  );

  function processClientData(data) {
    clientBuffer += data;
    const { output, remaining, blocked } = filterOutgoingData(clientBuffer);
    clientBuffer = remaining;

    if (output.length > 0 && riotSocket && riotSocket.writable) {
      riotSocket.write(output);
    }
  }

  // Client -> Proxy -> Riot (with presence filtering)
  clientSocket.on('data', (data) => {
    const str = data.toString('utf-8');

    if (!riotSocket || !riotSocket.writable) {
      pendingData.push(str);
      return;
    }

    processClientData(str);
  });

  // Riot -> Proxy -> Client (passthrough)
  riotSocket.on('data', (data) => {
    if (clientSocket.writable) {
      clientSocket.write(data);
    }
  });

  // Cleanup
  clientSocket.on('close', () => {
    console.log('[deceive-proxy] Client disconnected');
    if (riotSocket) riotSocket.destroy();
    connections = connections.filter((c) => c !== clientSocket);
  });

  clientSocket.on('error', (err) => {
    console.log('[deceive-proxy] Client socket error:', err.message);
    if (riotSocket) riotSocket.destroy();
  });

  riotSocket.on('close', () => {
    console.log('[deceive-proxy] Riot server disconnected');
    if (clientSocket.writable) clientSocket.destroy();
  });

  riotSocket.on('error', (err) => {
    console.log('[deceive-proxy] Riot socket error:', err.message);
    if (clientSocket.writable) clientSocket.destroy();
  });

  connections.push(clientSocket);
}

function startProxy(options = {}) {
  config = { ...DEFAULT_CONFIG, ...options };

  const { cert, key } = generateSelfSignedCert();

  server = tls.createServer({ key, cert }, handleConnection);

  server.listen(config.listenPort, '127.0.0.1', () => {
    console.log(`[deceive-proxy] Listening on 127.0.0.1:${config.listenPort}`);
  });

  server.on('error', (err) => {
    console.error('[deceive-proxy] Server error:', err.message);
  });

  return server;
}

function stopProxy() {
  for (const conn of connections) {
    conn.destroy();
  }
  connections = [];
  if (server) {
    server.close();
    server = null;
  }
  console.log('[deceive-proxy] Proxy stopped');
}

module.exports = { startProxy, stopProxy };
