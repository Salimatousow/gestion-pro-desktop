const { app, BrowserWindow, Menu, shell, protocol, net, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

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
let lastHash = '';        // version de la page actuellement affichée
let pendingUpdate = false; // une nouvelle version attend d'être affichée
let lastCheck = 0;

const sha = (t) => crypto.createHash('sha1').update(t).digest('hex');
const cachePath = () => path.join(app.getPath('userData'), 'page-cache.html');
const html = (t) => new Response(t, {
  status: 200,
  headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }
});

// Télécharge la dernière version de l'application, en ignorant toute copie en mémoire
async function fetchPage() {
  const r = await net.fetch(REMOTE + '/app', { cache: 'no-store', signal: AbortSignal.timeout(6000) });
  if (!r.ok) return null;
  const t = await r.text();
  return t.includes('Gestion pro') ? t : null;
}

// Page de l'application : version la plus récente si Internet, sinon copie gardée sur le PC
async function page() {
  try {
    const t = await fetchPage();
    if (t) {
      lastHash = sha(t);
      try { fs.writeFileSync(cachePath(), t); } catch (e) {}
      return html(t);
    }
  } catch (e) {}
  if (fs.existsSync(cachePath())) {
    const t = fs.readFileSync(cachePath(), 'utf8');
    lastHash = sha(t);
    return html(t);
  }
  return html(fs.readFileSync(path.join(__dirname, 'offline.html'), 'utf8'));
}

// Les demandes /api/... sont envoyées au serveur ; sans Internet elles échouent
// et l'application affiche « Hors ligne » puis synchronise plus tard.
async function proxy(request, u) {
  const headers = Object.fromEntries(request.headers);
  delete headers.origin; delete headers.referer; delete headers.host;
  const body = ['GET', 'HEAD'].includes(request.method) ? undefined : Buffer.from(await request.arrayBuffer());
  return net.fetch(REMOTE + u.pathname + u.search, {
    method: request.method, headers, body, cache: 'no-store', signal: AbortSignal.timeout(20000)
  });
}

// Mise à jour automatique : toutes les 5 minutes et au retour sur la fenêtre,
// on regarde s'il existe une nouvelle version ; elle s'affiche dès qu'aucune saisie n'est en cours.
async function checkUpdate(force) {
  if (!win) return;
  const now = Date.now();
  if (!force && now - lastCheck < 60000) return;
  lastCheck = now;
  try {
    const t = await fetchPage();
    if (t && lastHash && sha(t) !== lastHash) {
      pendingUpdate = true;
      try { fs.writeFileSync(cachePath(), t); } catch (e) {}
    }
  } catch (e) { return; }
  tryReload();
}

async function tryReload() {
  if (!win || !pendingUpdate) return;
  try {
    const idle = await win.webContents.executeJavaScript(`(() => { try {
      if (typeof DIRTY !== 'undefined' && DIRTY) return false;
      const ov = document.getElementById('ov'); if (ov && ov.innerHTML.trim()) return false;
      const a = document.activeElement; if (a && /INPUT|TEXTAREA|SELECT/.test(a.tagName)) return false;
      if (typeof D !== 'undefined' && D && D.l && D.l.length) return false;
      return true; } catch (e) { return true; } })()`);
    if (idle) { pendingUpdate = false; win.webContents.reload(); }
  } catch (e) {}
}


// Mise à jour automatique du logiciel lui-même (depuis les « Releases » GitHub) :
// téléchargement en arrière-plan, puis proposition de redémarrer ; sinon installation à la fermeture.
function setupUpdater() {
  if (!app.isPackaged) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('error', () => {});
  autoUpdater.on('update-downloaded', async () => {
    try {
      const r = await dialog.showMessageBox(win || undefined, {
        type: 'info', buttons: ['Redémarrer maintenant', 'Plus tard'], defaultId: 0, cancelId: 1,
        title: 'Gestion pro', message: 'Une nouvelle version de Gestion pro est prête.',
        detail: 'Redémarrez pour l’installer. Sinon, elle s’installera à la fermeture du logiciel.'
      });
      if (r.response === 0) autoUpdater.quitAndInstall(true, true);
    } catch (e) {}
  });
  const check = () => { try { autoUpdater.checkForUpdates().catch(() => {}); } catch (e) {} };
  setTimeout(check, 15000);
  setInterval(check, 4 * 60 * 60 * 1000);
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

  win.on('focus', () => checkUpdate(false));
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
  setupUpdater();
  setInterval(() => checkUpdate(true), 5 * 60 * 1000);
  setInterval(tryReload, 60 * 1000);
});
app.on('window-all-closed', () => app.quit());
