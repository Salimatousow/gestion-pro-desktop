const { app, BrowserWindow, Menu, shell } = require('electron');
const path = require('path');

// Adresse de l'application en ligne (Railway)
const APP_URL = 'https://gestion-pro-production-d124.up.railway.app/app';

// Une seule fenêtre à la fois
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

let win;

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'Gestion pro',
    icon: path.join(__dirname, 'build', 'icon.ico'),
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  });

  Menu.setApplicationMenu(null);
  win.maximize();
  win.loadURL(APP_URL);

  // Pas de connexion : page d'attente avec bouton « Réessayer »
  win.webContents.on('did-fail-load', (_e, code, _d, url, isMainFrame) => {
    if (isMainFrame && code !== -3) {
      win.loadFile(path.join(__dirname, 'offline.html'));
    }
  });

  // Les liens externes s'ouvrent dans le navigateur
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(APP_URL.split('/app')[0])) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  win.on('closed', () => { win = null; });
}

app.on('second-instance', () => {
  if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
});

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
