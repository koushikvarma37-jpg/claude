// The only bridge between the UI and the computer. The UI can call these functions and nothing else.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("relay", {
  run: (text, turnId) => ipcRenderer.invoke("relay:run", { text, turnId }),
  transcribe: (base64) => ipcRenderer.invoke("relay:transcribe", base64),
  confirm: (id, ok) => ipcRenderer.send("relay:confirm", { id, ok }),
  undo: () => ipcRenderer.invoke("relay:undo"),
  stop: () => ipcRenderer.send("relay:stop"),
  reset: () => ipcRenderer.send("relay:reset"),
  onEvent: (fn) => ipcRenderer.on("relay:event", (_e, ev) => fn(ev)),
  settings: {
    get: () => ipcRenderer.invoke("settings:get"),
    set: (patch) => ipcRenderer.invoke("settings:set", patch),
    models: () => ipcRenderer.invoke("settings:models"),
  },
  window: {
    minimize: () => ipcRenderer.send("window:minimize"),
    toggleMaximize: () => ipcRenderer.send("window:toggle-maximize"),
    isMaximized: () => ipcRenderer.invoke("window:is-maximized"),
    hide: () => ipcRenderer.send("window:hide"),
    close: () => ipcRenderer.send("window:close"),
    quit: () => ipcRenderer.send("app:quit"),
  },
  openLink: (url) => ipcRenderer.send("open:link", url),
  memory: {
    list: () => ipcRenderer.invoke("memory:list"),
    remove: (id) => ipcRenderer.invoke("memory:remove", id),
  },
  history: {
    list: () => ipcRenderer.invoke("history:list"),
    save: (id, turns) => ipcRenderer.invoke("history:save", { id, turns }),
    open: (id) => ipcRenderer.invoke("history:open", id),
    remove: (id) => ipcRenderer.invoke("history:delete", id),
    clear: () => ipcRenderer.invoke("history:clear"),
  },
});
