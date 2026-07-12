const { app, BrowserWindow, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

const PORT = 5893;

// 数据目录：portable exe 放在 exe 旁边的 Atelier452Data；安装版/开发用 userData
function resolveDataDir() {
  if (process.env.PORTABLE_EXECUTABLE_DIR) {
    return path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'Atelier452Data');
  }
  if (!app.isPackaged) return path.join(__dirname, '..'); // 开发模式沿用项目目录
  return app.getPath('userData');
}

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 920,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#0b1017',
    title: 'Atelier452 Magic',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  // 页内下载（mp4/zip 导出）弹系统保存框，默认可用
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.loadURL(`http://localhost:${PORT}`);
  mainWindow.on('closed', () => { mainWindow = null; });
}

// 等服务器就绪再开窗口，避免白屏
async function waitForServer(timeoutMs = 15000) {
  const t0 = Date.now();
  for (;;) {
    try {
      const res = await fetch(`http://localhost:${PORT}/api/config`);
      if (res.ok) return true;
    } catch {}
    if (Date.now() - t0 > timeoutMs) return false;
    await new Promise((r) => setTimeout(r, 300));
  }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    const dataDir = resolveDataDir();
    fs.mkdirSync(dataDir, { recursive: true });
    process.env.ATELIER_DATA_DIR = dataDir;

    // 内嵌启动服务器（若 5893 已有实例在跑，则直接复用它）
    try {
      require(path.join(__dirname, '..', 'server.js'));
    } catch (e) {
      dialog.showErrorBox('服务器启动失败', String(e && e.stack || e));
      app.quit();
      return;
    }

    const ok = await waitForServer();
    if (!ok) {
      dialog.showErrorBox('启动超时', '本地服务器 15 秒内未就绪（端口 5893）。');
      app.quit();
      return;
    }
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    app.quit(); // Windows 桌面应用习惯：关窗即退（服务器随进程结束）
  });
}
