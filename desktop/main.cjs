const {
  app, BrowserWindow, Menu, safeStorage, shell,
} = require('electron');
const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const METEOR_APP = path.join(ROOT, 'app');
const PORT = Number(process.env.METEOR_DESKTOP_PORT || 3210);
const APP_URL = `http://127.0.0.1:${PORT}`;
const STARTUP_TIMEOUT_MS = 120_000;

if (process.env.METEOR_DESKTOP_AUTOMATION === '1') {
  app.commandLine.appendSwitch('remote-debugging-port', '9229');
  app.commandLine.appendSwitch('remote-allow-origins', 'http://127.0.0.1:9229');
}

let mainWindow = null;
let meteorProcess = null;
let ownsMeteorProcess = false;

function loadCredentialKey() {
  const supplied = process.env.CONSTELLATION_CONFIG_KEY;
  if (supplied && Buffer.from(supplied, 'base64').length === 32) return supplied;
  if (!safeStorage.isEncryptionAvailable()) {
    console.warn('[constellation] OS credential encryption is unavailable; channel credentials are locked');
    return '';
  }
  const directory = app.getPath('userData');
  const keyPath = path.join(directory, 'credential-key.bin');
  try {
    if (fs.existsSync(keyPath)) {
      const key = safeStorage.decryptString(fs.readFileSync(keyPath));
      if (Buffer.from(key, 'base64').length !== 32) throw new Error('stored credential key is invalid');
      return key;
    }
    const key = randomBytes(32).toString('base64');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(keyPath, safeStorage.encryptString(key), { mode: 0o600, flag: 'wx' });
    return key;
  } catch (error) {
    console.error('[constellation] credential key could not be loaded:', error.message);
    return '';
  }
}

function isLocalAppUrl(value) {
  try {
    const url = new URL(value);
    return url.hostname === '127.0.0.1' && Number(url.port) === PORT;
  } catch {
    return false;
  }
}

function isAllowedExternalUrl(value) {
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'mailto:')
      && !url.username
      && !url.password;
  } catch {
    return false;
  }
}

function probeServer() {
  return new Promise((resolve) => {
    const req = http.get(APP_URL, { timeout: 800 }, (response) => {
      response.resume();
      resolve(response.statusCode >= 200 && response.statusCode < 500);
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
  });
}

async function waitForServer() {
  const startedAt = Date.now();
  while (Date.now() - startedAt < STARTUP_TIMEOUT_MS) {
    if (await probeServer()) return;
    if (meteorProcess?.exitCode !== null && meteorProcess?.exitCode !== undefined) {
      throw new Error(`Meteor stopped during startup (exit ${meteorProcess.exitCode})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 450));
  }
  throw new Error(`Meteor did not become ready within ${STARTUP_TIMEOUT_MS / 1000}s`);
}

async function ensureMeteor() {
  if (await probeServer()) return;

  ownsMeteorProcess = true;
  const credentialKey = loadCredentialKey();
  const env = {
    ...process.env,
    ROOT_URL: APP_URL,
    PORT: String(PORT),
    ...(credentialKey ? { CONSTELLATION_CONFIG_KEY: credentialKey } : {}),
  };
  meteorProcess = spawn('meteor', ['run', '--port', String(PORT)], {
    cwd: METEOR_APP,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  meteorProcess.stdout.on('data', (chunk) => process.stdout.write(`[meteor] ${chunk}`));
  meteorProcess.stderr.on('data', (chunk) => process.stderr.write(`[meteor] ${chunk}`));
  meteorProcess.on('error', (error) => {
    console.error('[constellation] could not start Meteor:', error.message);
  });

  await waitForServer();
}

function buildMenu() {
  const template = [
    ...(process.platform === 'darwin' ? [{
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    }] : []),
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        ...(process.env.METEOR_DESKTOP_DEVTOOLS ? [{ role: 'toggleDevTools' }] : []),
        { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' }, { role: 'togglefullscreen' },
      ],
    },
    { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'zoom' }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1510,
    height: 960,
    minWidth: 1080,
    minHeight: 720,
    show: false,
    backgroundColor: '#101211',
    title: 'Constellation',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    trafficLightPosition: { x: 17, y: 16 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isLocalAppUrl(url)) event.preventDefault();
  });
  mainWindow.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false);
  });
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => { mainWindow = null; });

  await mainWindow.loadURL(APP_URL);
  if (!mainWindow.isDestroyed()) {
    mainWindow.center();
    mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    mainWindow.show();
    mainWindow.focus();
    app.focus({ steal: true });
    setTimeout(() => {
      if (!mainWindow?.isDestroyed()) mainWindow.setVisibleOnAllWorkspaces(false);
    }, 1000);
    console.log(`[constellation] window ready (visible=${mainWindow.isVisible()})`);
  }
}

app.whenReady().then(async () => {
  app.setName('Constellation');
  buildMenu();
  try {
    await ensureMeteor();
    await createWindow();
  } catch (error) {
    console.error('[constellation] startup failed:', error);
    app.quit();
  }

  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) await createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (!ownsMeteorProcess || !meteorProcess || meteorProcess.killed) return;
  meteorProcess.kill('SIGTERM');
});
