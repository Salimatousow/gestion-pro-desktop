const { app, BrowserWindow, Menu, shell, protocol, net } = require('electron');
const path = require('path');
const fs = require('fs');

// Serveur en ligne (Railway)
const REMOTE = 'https://gestion-pro-production-d124.up.railway.app';
const APP_URL = 'app://gestion/app';

// Le logiciel utilise sa propre adresse interne (app://gestion) : ses données
// (connexion, stock, ventes...) restent enregistrées sur le PC, même sans Internet.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }
]);

if (!app.requestSingleInstanceLock()) app.quit();

let win;

const html = (t) => new Response(t, {
  status: 200,
  headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }
});

// Page de l'application : version la plus récente si Internet, sinon copie gardée sur le PC
async function page() {
  const cache = path.join(app.getPath('userData'), 'page-cache.html');
  try {
    const r = await net.fetch(REMOTE + '/app', { signal: AbortSignal.timeout(6000) });
    if (r.ok) {
      const t = await r.text();
      if (t.includes('Gestion pro')) {
        try { fs.writeFileSync(cache, t); } catch (e) {}
        return html(t);
      }
    }
  } catch (e) {}
  if (fs.existsSync(cache)) return html(fs.readFileSync(cache, 'utf8'));
  return html(fs.readFileSync(path.join(__dirname, 'offline.html'), 'utf8'));
}

// Les demandes /api/... sont envoyées au serveur ; sans Internet elles échouent
// et l'application affiche « Hors ligne » puis synchronise plus tard.
async function proxy(request, u) {
  const headers = Object.fromEntries(request.headers);
  delete headers.origin; delete headers.referer; delete headers.host;
  const body = ['GET', 'HEAD'].includes(request.method) ? undefined : Buffer.from(await request.arrayBuffer());
  return net.fetch(REMOTE + u.pathname + u.search, {
    method: request.method, headers, body, signal: AbortSignal.timeout(20000)
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 800, minWidth: 900, minHeight: 600,
    title: 'Gestion pro',
    icon: path.join(__dirname, 'build', 'icon.ico'),
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  });
  Menu.setApplicationMenu(null);
  win.maximize();
  win.loadURL(APP_URL);

  // Dès le retour d'Internet (ou toutes les 30 s), envoyer les données saisies hors ligne
  win.webContents.on('did-finish-load', () => {
    win.webContents.executeJavaScript(`
      if (!window.__syncAuto) {
        window.__syncAuto = 1;
        const go = () => { try { if (TOKEN && DIRTY && navigator.onLine) push(); } catch (e) {} };
        addEventListener('online', go);
        setInterval(go, 30000);
      }`).catch(() => {});
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('app://')) return { action: 'allow' };
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.on('closed', () => { win = null; });
}

app.on('second-instance', () => {
  if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
});

app.whenReady().then(() => {
  protocol.handle('app', async (request) => {
    const u = new URL(request.url);
    if (u.pathname.startsWith('/api/')) return proxy(request, u);
    if (u.pathname === '/' || u.pathname === '/app') return page();
    return new Response('Introuvable', { status: 404 });
  });
  createWindow();
});
app.on('window-all-closed', () => app.quit());
