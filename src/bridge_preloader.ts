// Preload script of the splash (preloader) window. Its page script,
// src/UI/preloader.ts, only ever asks for the app's name and version, so this
// exposes that one call. Like bridge_main.ts it runs sandboxed, so its `require`
// resolves Electron built-ins only.
import { contextBridge, ipcRenderer } from 'electron';
import type { AppConfig } from '@showtrak/protocol';
import type { PreloaderAPI } from './types/preloader-api';

const API: PreloaderAPI = {
  // Answered by the main process's own 'Config:Get' handler (main/registrars/system.ts).
  GetConfig: async () => ipcRenderer.invoke('Config:Get') as Promise<AppConfig>,
};

contextBridge.exposeInMainWorld('API', API);
