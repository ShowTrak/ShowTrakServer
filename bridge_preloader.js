const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("API", {
	GetConfig: async () => ipcRenderer.invoke("Config:Get"),
});
