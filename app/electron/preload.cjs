// Minimal preload. The renderer talks to the Python bridge directly over a
// websocket (ws://127.0.0.1:8765), so we only expose small static info here,
// plus the project-folder picker (needs native dialog.showOpenDialog, which
// only the main process can call).
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("anvil", {
  bridgeUrl: "ws://127.0.0.1:8765/ws",
  apiUrl: "http://127.0.0.1:8765",
  getProjectDir: () => ipcRenderer.invoke("project:get"),
  pickProjectDir: () => ipcRenderer.invoke("project:pick"),
  getProjectBasename: () => ipcRenderer.invoke("project:basename"),
  listProjectFiles: () => ipcRenderer.invoke("project:listFiles"),
  listProjectDir: (relPath) => ipcRenderer.invoke("project:listDir", relPath ?? ""),
  readProjectFile: (relPath) => ipcRenderer.invoke("project:readFile", relPath),
  readProjectFileBinary: (relPath) => ipcRenderer.invoke("project:readFileBinary", relPath),
  writeProjectFile: (relPath, content) => ipcRenderer.invoke("project:writeFile", relPath, content),
  waitForBridge: () => ipcRenderer.invoke("bridge:ready"),
  getServiceStatus: () => ipcRenderer.invoke("services:status"),
  openServiceLogs: () => ipcRenderer.invoke("services:openLogs"),
  getLatestLogPath: () => ipcRenderer.invoke("services:latestLog"),
  openPath: (targetPath) => ipcRenderer.invoke("shell:openPath", targetPath),
  openExternal: (url) => ipcRenderer.invoke("shell:openExternal", url),
  onBridgeStatus: (cb) => {
    const handler = (_ev, status) => cb(status);
    ipcRenderer.on("bridge:status", handler);
    ipcRenderer.on("services:status", handler);
    return () => {
      ipcRenderer.removeListener("bridge:status", handler);
      ipcRenderer.removeListener("services:status", handler);
    };
  },
});
