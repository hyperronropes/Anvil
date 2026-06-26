import { app, BrowserWindow, ipcMain, dialog, nativeImage, shell } from "electron";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = !!process.env.ELECTRON_DEV;

function anvilDataDir() {
  return path.join(os.homedir(), ".Anvil");
}

app.setName("Anvil");
if (process.platform === "win32") {
  // Must match package.json build.appId — controls taskbar grouping / jump list title.
  app.setAppUserModelId("com.anvil.app");
}
// ~/.Anvil — prefs + logs (must not call app.getPath before ready; homedir is safe).
app.setPath("userData", anvilDataDir());

function appIconPath() {
  const candidates = [
    path.join(__dirname, "..", "assets", "icon.ico"),
    path.join(process.resourcesPath, "app.asar", "assets", "icon.ico"),
    path.join(process.resourcesPath, "assets", "icon.ico"),
  ];
  return candidates.find((p) => fs.existsSync(p)) ?? candidates[0];
}

function appIcon() {
  const img = nativeImage.createFromPath(appIconPath());
  if (img.isEmpty()) return undefined;
  const { width } = img.getSize();
  if (width > 0 && width < 256) {
    return img.resize({ width: 256, height: 256, quality: "best" });
  }
  return img;
}

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const BRIDGE_PORT = 8765;
const PROXY_PORT = 8000;
const MIN_SPLASH_MS = 3200;
const BUNDLED_PROXY_URL = `http://127.0.0.1:${PROXY_PORT}`;

let PREFS_FILE = null;

function anvilConfigPath() {
  return path.join(anvilDataDir(), "config.json");
}

/** Zero-config: bundled proxy URL in ~/.Anvil/config.json for friends. */
function ensureBundledConfig() {
  if (!app.isPackaged && !leechRoot()) return;
  const dir = path.dirname(anvilConfigPath());
  fs.mkdirSync(dir, { recursive: true });
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(anvilConfigPath(), "utf-8"));
  } catch {
    // fresh install
  }
  cfg.base_url = BUNDLED_PROXY_URL;
  cfg.models_path = "/models";
  cfg.anvil_bundled = true;
  fs.writeFileSync(anvilConfigPath(), JSON.stringify(cfg, null, 2), "utf-8");
}

function bundledEnv() {
  return {
    ...process.env,
    PYTHONIOENCODING: "utf-8",
    ANVIL_PROJECT_DIR: projectDir,
    ANVIL_BASE_URL: BUNDLED_PROXY_URL,
    ANVIL_MODELS_PATH: "/models",
    ANVIL_BUNDLED: "1",
    ANVIL_PROXY_PORT: String(PROXY_PORT),
  };
}

function leechRoot() {
  const candidate = process.env.LEECH_ROOT || path.resolve(REPO_ROOT, "..", "leech");
  return fs.existsSync(path.join(candidate, "backend", "main.py")) ? candidate : null;
}

function loadProjectDir() {
  try {
    const prefs = JSON.parse(fs.readFileSync(PREFS_FILE, "utf-8"));
    if (prefs.projectDir && fs.existsSync(prefs.projectDir)) return prefs.projectDir;
  } catch {
    // no prefs yet
  }
  return app.getPath("documents");
}

function saveProjectDir(dir) {
  fs.writeFileSync(PREFS_FILE, JSON.stringify({ projectDir: dir }), "utf-8");
}

let projectDir = null;
let bridge = null;
let proxy = null;
let win = null;
let splash = null;
let shuttingDown = false;
let bridgeReady = false;
let proxyReady = false;
let bridgeRestarts = 0;
let proxyRestarts = 0;
const MAX_SERVICE_RESTARTS = 8;

function logsDir() {
  const dir = path.join(app.getPath("userData"), "logs");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function serviceLogPath(name) {
  return path.join(logsDir(), `${name}.log`);
}

function latestLogPath() {
  return path.join(logsDir(), "latest.log");
}

function initLatestLog() {
  const header = [
    `=== Anvil session ${new Date().toISOString()} ===`,
    `version: ${app.getVersion()}`,
    `packaged: ${app.isPackaged}`,
    `userData: ${app.getPath("userData")}`,
    `latest.log: ${latestLogPath()}`,
    `exe: ${process.execPath}`,
    `resources: ${process.resourcesPath}`,
    "",
  ].join("\n") + "\n";
  try {
    fs.writeFileSync(latestLogPath(), header, "utf8");
  } catch {
    /* ignore */
  }
}

function appendLatestLog(source, text) {
  try {
    const chunk = text.endsWith("\n") ? text : `${text}\n`;
    fs.appendFileSync(latestLogPath(), `[${source}] ${chunk}`);
  } catch {
    /* ignore */
  }
}

function appendServiceLog(name, text) {
  try {
    fs.appendFileSync(serviceLogPath(name), text);
    appendLatestLog(name, text);
  } catch {
    /* ignore */
  }
}

function currentServiceStatus() {
  return {
    bridge: bridgeReady,
    proxy: proxyReady,
    logsDir: logsDir(),
    latestLog: latestLogPath(),
  };
}

function emitServiceStatus() {
  if (shuttingDown || !win || win.isDestroyed()) return;
  try {
    const status = currentServiceStatus();
    win.webContents.send("bridge:status", status);
    win.webContents.send("services:status", status);
  } catch {
    // Window can be torn down mid-shutdown on Windows portable builds.
  }
}

function stopChild(proc) {
  if (!proc) return;
  proc.removeAllListeners("exit");
  proc.removeAllListeners("error");
  if (!proc.killed) proc.kill();
}

function stopBridge() {
  stopChild(bridge);
  bridge = null;
}

function stopProxy() {
  stopChild(proxy);
  proxy = null;
}

function httpOk(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      resolve(res.statusCode === 200);
      res.resume();
    });
    req.on("error", () => resolve(false));
    req.setTimeout(400, () => {
      req.destroy();
      resolve(false);
    });
  });
}

function bridgeHealthCheck() {
  return httpOk(`http://127.0.0.1:${BRIDGE_PORT}/api/health`);
}

function proxyHealthCheck() {
  return httpOk(`http://127.0.0.1:${PROXY_PORT}/health`);
}

async function waitFor(check, maxMs = 120_000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 80));
  }
  return false;
}

function spawnService(name, cmd, args, cwd) {
  appendServiceLog(name, `\n--- ${name} start ${new Date().toISOString()} ---\n`);
  appendServiceLog(name, `cmd: ${cmd} ${args.join(" ")}\ncwd: ${cwd}\n`);
  if (!fs.existsSync(cmd)) {
    const msg = `[${name}] missing executable: ${cmd}\n`;
    appendServiceLog(name, msg);
    console.error(msg.trim());
    return null;
  }

  const child = spawn(cmd, args, {
    cwd,
    env: bundledEnv(),
    stdio: isDev ? "inherit" : ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  if (!isDev) {
    child.stdout?.on("data", (chunk) => appendServiceLog(name, chunk.toString()));
    child.stderr?.on("data", (chunk) => appendServiceLog(name, chunk.toString()));
  }
  child.on("error", (e) => {
    if (shuttingDown) return;
    const msg = `[${name}] failed to start: ${e}\n`;
    appendServiceLog(name, msg);
    console.error(msg.trim());
  });
  child.on("exit", (code) => {
    appendServiceLog(name, `--- ${name} exit ${code} ${new Date().toISOString()} ---\n`);
    if (shuttingDown) return;
    console.log(`[${name}] exited`, code);
    if (name === "bridge") {
      bridgeReady = false;
      emitServiceStatus();
      if (bridgeRestarts < MAX_SERVICE_RESTARTS) {
        bridgeRestarts += 1;
        setTimeout(startBridge, 1200);
      }
    } else if (name === "proxy") {
      proxyReady = false;
      emitServiceStatus();
      if (proxyRestarts < MAX_SERVICE_RESTARTS) {
        proxyRestarts += 1;
        setTimeout(startProxy, 1500);
      }
    }
  });
  return child;
}

function startProxy() {
  let cmd;
  let args = [];
  let cwd;

  if (app.isPackaged) {
    const exe = process.platform === "win32" ? "proxy.exe" : "proxy";
    cmd = path.join(process.resourcesPath, "proxy", exe);
    cwd = path.dirname(cmd);
  } else {
    const root = leechRoot();
    if (!root) {
      console.warn("[proxy] leech repo not found — run leech on :8000 yourself or set LEECH_ROOT");
      return;
    }
    cmd = process.platform === "win32" ? "python" : "python3";
    args = [
      "-m", "uvicorn", "backend.main:app",
      "--host", "127.0.0.1",
      "--port", String(PROXY_PORT),
    ];
    cwd = root;
  }

  stopChild(proxy);
  proxy = spawnService("proxy", cmd, args, cwd);
}

function startBridge() {
  let cmd;
  let args = [];
  let cwd;

  if (app.isPackaged) {
    const exe = process.platform === "win32" ? "bridge.exe" : "bridge";
    cmd = path.join(process.resourcesPath, "bridge", exe);
    cwd = path.dirname(cmd);
  } else {
    cmd = process.platform === "win32" ? "python" : "python3";
    args = ["-m", "server"];
    cwd = REPO_ROOT;
  }

  stopChild(bridge);
  bridge = spawnService("bridge", cmd, args, cwd);
}

async function watchServices() {
  let lastBridge = bridgeReady;
  let lastProxy = proxyReady;
  while (!shuttingDown) {
    const nextBridge = await bridgeHealthCheck();
    const nextProxy = await proxyHealthCheck();
    if (nextBridge !== bridgeReady || nextProxy !== proxyReady) {
      bridgeReady = nextBridge;
      proxyReady = nextProxy;
      if (nextBridge !== lastBridge) {
        appendLatestLog("main", `bridge ${nextBridge ? "ready" : "offline"}\n`);
        lastBridge = nextBridge;
      }
      if (nextProxy !== lastProxy) {
        appendLatestLog("main", `proxy ${nextProxy ? "ready" : "offline"}\n`);
        lastProxy = nextProxy;
      }
      emitServiceStatus();
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

function restartBridge() {
  stopBridge();
  startBridge();
}

function createSplash() {
  splash = new BrowserWindow({
    width: 440,
    height: 560,
    frame: false,
    resizable: false,
    center: true,
    show: false,
    backgroundColor: "#1a1a1a",
    icon: appIcon(),
  });
  splash.loadFile(path.join(__dirname, "splash.html"));
  splash.once("ready-to-show", () => {
    if (splash && !splash.isDestroyed()) splash.show();
  });
}

function closeSplash() {
  if (splash && !splash.isDestroyed()) splash.destroy();
  splash = null;
}

ipcMain.handle("project:get", () => projectDir);

ipcMain.handle("project:pick", async () => {
  const result = await dialog.showOpenDialog(win, {
    title: "Choose a project folder",
    defaultPath: projectDir,
    properties: ["openDirectory", "createDirectory"],
  });
  if (result.canceled || !result.filePaths[0]) return projectDir;
  projectDir = result.filePaths[0];
  saveProjectDir(projectDir);
  restartBridge();
  return projectDir;
});

ipcMain.handle("project:basename", () => {
  if (!projectDir) return "Anvil";
  return path.basename(projectDir);
});

const SKIP_DIR_NAMES = new Set([
  ".git",
  "node_modules",
  "__pycache__",
  ".venv",
  "venv",
  "dist",
  "build",
  ".next",
  "target",
]);

function resolveProjectFile(relPath) {
  if (!projectDir || !relPath || typeof relPath !== "string") {
    throw new Error("No project folder open");
  }
  const normalized = relPath.replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (normalized.includes("..") || path.isAbsolute(normalized)) {
    throw new Error("Invalid file path");
  }
  const full = path.resolve(projectDir, normalized);
  const root = path.resolve(projectDir);
  const relative = path.relative(root, full);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Invalid file path");
  }
  return full;
}

function readProjectDir(relPath = "") {
  if (!projectDir) throw new Error("No project folder open");
  if (!relPath) return projectDir;
  const full = resolveProjectFile(relPath);
  if (!fs.existsSync(full)) throw new Error("Folder not found");
  const stat = fs.statSync(full);
  if (!stat.isDirectory()) throw new Error("Not a folder");
  return full;
}

function listDirEntries(relPath = "") {
  const dir = readProjectDir(relPath);
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const nodes = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const rel = relPath ? `${relPath}/${entry.name}` : entry.name;
    const normalized = rel.replace(/\\/g, "/");
    if (entry.isDirectory()) {
      if (SKIP_DIR_NAMES.has(entry.name)) continue;
      nodes.push({ kind: "dir", name: entry.name, path: normalized });
    } else if (entry.isFile()) {
      nodes.push({ kind: "file", name: entry.name, path: normalized });
    }
  }
  return nodes.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
}

/** @deprecated — flat file list; explorer uses project:listDir */
function walkProjectFiles(dir, relBase, out, depth = 0) {
  if (depth > 10 || out.length >= 500) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
    if (entry.isFile()) {
      out.push(rel.replace(/\\/g, "/"));
      if (out.length >= 500) return;
    } else if (entry.isDirectory() && !SKIP_DIR_NAMES.has(entry.name)) {
      walkProjectFiles(path.join(dir, entry.name), rel, out, depth + 1);
    }
  }
}

ipcMain.handle("project:listDir", (_e, relPath = "") => {
  if (!projectDir || !fs.existsSync(projectDir)) return [];
  try {
    return listDirEntries(relPath || "");
  } catch {
    return [];
  }
});

ipcMain.handle("project:listFiles", () => {
  if (!projectDir || !fs.existsSync(projectDir)) return [];
  try {
    const files = [];
    walkProjectFiles(projectDir, "", files);
    return files.sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
});

ipcMain.handle("project:readFile", (_e, relPath) => {
  const full = resolveProjectFile(relPath);
  if (!fs.existsSync(full)) throw new Error("File not found");
  const stat = fs.statSync(full);
  if (!stat.isFile()) throw new Error("Not a file");
  if (stat.size > 2 * 1024 * 1024) throw new Error("File too large to open (>2 MB)");
  return fs.readFileSync(full, "utf8");
});

const IMAGE_MIME = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  bmp: "image/bmp",
  avif: "image/avif",
  apng: "image/apng",
};

ipcMain.handle("project:readFileBinary", (_e, relPath) => {
  const full = resolveProjectFile(relPath);
  if (!fs.existsSync(full)) throw new Error("File not found");
  const stat = fs.statSync(full);
  if (!stat.isFile()) throw new Error("Not a file");
  if (stat.size > 12 * 1024 * 1024) throw new Error("Image too large (>12 MB)");
  const ext = path.extname(full).slice(1).toLowerCase();
  const mime = IMAGE_MIME[ext] ?? "application/octet-stream";
  const buf = fs.readFileSync(full);
  return { mime, dataUrl: `data:${mime};base64,${buf.toString("base64")}` };
});

ipcMain.handle("project:writeFile", (_e, relPath, content) => {
  const full = resolveProjectFile(relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content ?? "", "utf8");
  return true;
});

ipcMain.handle("bridge:ready", () => bridgeHealthCheck());
ipcMain.handle("services:status", () => currentServiceStatus());
ipcMain.handle("services:openLogs", () => {
  const latest = latestLogPath();
  logsDir();
  void shell.openPath(fs.existsSync(latest) ? latest : logsDir());
  return latest;
});
ipcMain.handle("services:latestLog", () => latestLogPath());
ipcMain.handle("shell:openPath", (_e, targetPath) => {
  if (!targetPath || typeof targetPath !== "string") return "";
  return shell.openPath(targetPath);
});

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 860,
    minWidth: 1000,
    minHeight: 640,
    backgroundColor: "#1a1a1a",
    title: "Anvil",
    icon: appIcon(),
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: "#1a1a1a",
      symbolColor: "#cccccc",
      height: 35,
    },
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.on("closed", () => {
    win = null;
  });
  if (isDev) {
    win.loadURL("http://localhost:5173");
    if (process.env.ANVIL_DEVTOOLS) win.webContents.openDevTools({ mode: "detach" });
  } else {
    win.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }
}

app.whenReady().then(async () => {
  PREFS_FILE = path.join(app.getPath("userData"), "prefs.json");
  projectDir = loadProjectDir();
  initLatestLog();
  appendLatestLog("main", `projectDir: ${projectDir}\n`);
  ensureBundledConfig();
  createSplash();
  createWindow();
  startProxy();
  startBridge();
  const splashStart = Date.now();
  const [proxyUp, bridgeUp] = await Promise.all([
    waitFor(proxyHealthCheck, 180_000),
    waitFor(bridgeHealthCheck, 120_000),
  ]);
  proxyReady = proxyUp;
  bridgeReady = bridgeUp;
  appendLatestLog("main", `startup: bridge=${bridgeUp} proxy=${proxyUp}\n`);
  if (!proxyUp) {
    console.warn("[proxy] not ready — chat will hang until model API starts");
    appendServiceLog("proxy", "[startup] health check timed out — antivirus may be blocking proxy.exe\n");
  }
  if (!bridgeUp) {
    appendServiceLog("bridge", "[startup] health check timed out\n");
  }
  const remain = Math.max(0, MIN_SPLASH_MS - (Date.now() - splashStart));
  if (remain > 0) await new Promise((r) => setTimeout(r, remain));
  if (win && !win.isDestroyed()) win.show();
  closeSplash();
  emitServiceStatus();
  void watchServices();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("before-quit", () => {
  shuttingDown = true;
  closeSplash();
  stopBridge();
  stopProxy();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
