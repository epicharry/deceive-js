const { app, BrowserWindow } = require('electron');
const { startProxy, stopProxy } = require('./proxy');

let mainWindow = null;

// --- Configuration ---
const PROXY_CONFIG = {
  riotChatHost: 'ap.chat.si.riotgames.com', // Change per region: na, eu, ap, kr, etc.
  riotChatPort: 5223,
  listenPort: 5223,
};

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 400,
    height: 300,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  // Replace with your actual app UI
  mainWindow.loadURL(`data:text/html,
    <html>
    <body style="font-family:sans-serif;padding:20px;background:#1a1a2e;color:#eee;">
      <h2>Deceive Proxy</h2>
      <p>Status: <strong style="color:#0f0;">Running</strong></p>
      <p>You appear <strong>offline</strong> in Valorant.</p>
      <p style="color:#888;font-size:12px;">Chat and game functionality remain active.</p>
    </body>
    </html>
  `);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.on('ready', () => {
  // Start the XMPP presence-blocking proxy
  startProxy(PROXY_CONFIG);
  console.log('[main] Deceive proxy started');

  createWindow();
});

app.on('window-all-closed', () => {
  stopProxy();
  app.quit();
});

app.on('before-quit', () => {
  stopProxy();
});

// ---
// Instructions:
//
// 1. Install dependencies:
//    npm install electron node-forge
//
// 2. Run:
//    npx electron main.js
//
// 3. The proxy intercepts Riot's XMPP chat connection on localhost:5223.
//    Configure your Riot Client to connect to 127.0.0.1:5223 instead of
//    the real chat server (this normally requires patching the Riot Client
//    config response or using a system hosts file redirect paired with the
//    self-signed cert).
//
// 4. Change PROXY_CONFIG.riotChatHost for your region:
//    - NA: na.chat.si.riotgames.com
//    - EU: eu.chat.si.riotgames.com
//    - AP: ap.chat.si.riotgames.com
//    - KR: kr.chat.si.riotgames.com
// ---
