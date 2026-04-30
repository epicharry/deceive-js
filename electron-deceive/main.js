const { app, BrowserWindow } = require('electron');
const { startProxy, stopProxy } = require('./proxy');

let mainWindow = null;

// --- Configuration ---
// autoLaunch: true  -> automatically kills existing Riot Client and relaunches with proxy
// riotClientPath:   -> override path to RiotClientServices.exe (auto-detected if omitted)
// chatProxyPort:    -> port for TLS chat proxy (0 = auto-assign)
const PROXY_CONFIG = {
  autoLaunch: true,
  chatProxyPort: 0,
  // riotClientPath: 'C:\\Riot Games\\Riot Client\\RiotClientServices.exe',
};

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 420,
    height: 320,
    resizable: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  mainWindow.loadURL(`data:text/html,
    <html>
    <body style="font-family:system-ui,sans-serif;padding:24px;background:#0f1923;color:#ece8e1;margin:0;">
      <h2 style="margin:0 0 8px 0;color:#ff4655;">Deceive Proxy</h2>
      <p style="margin:4px 0;">Status: <strong style="color:#15e89f;">Running</strong></p>
      <p style="margin:4px 0;">You appear <strong>offline</strong> in Valorant</p>
      <hr style="border:1px solid #1f2d38;margin:16px 0;">
      <p style="color:#768a96;font-size:13px;margin:4px 0;">How it works:</p>
      <ol style="color:#768a96;font-size:12px;padding-left:18px;margin:8px 0;">
        <li>Config proxy intercepts Riot's config request</li>
        <li>Redirects chat connection to localhost</li>
        <li>Chat TLS proxy filters presence stanzas</li>
        <li>All other traffic (chat, game) passes through</li>
      </ol>
      <p style="color:#768a96;font-size:11px;margin-top:16px;">Close this window to stop the proxy and quit.</p>
    </body>
    </html>
  `);

  mainWindow.on('closed', () => { mainWindow = null; });
}

app.on('ready', () => {
  startProxy(PROXY_CONFIG);
  createWindow();
});

app.on('window-all-closed', () => {
  stopProxy();
  app.quit();
});

app.on('before-quit', () => {
  stopProxy();
});
