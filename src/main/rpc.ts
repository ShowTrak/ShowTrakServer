// RPC wrapper around Electron's ipcMain.
//
// Every handler registration is mirrored into the shared handler registry so the
// Web UI `/ui` namespace can dispatch to the same handler function (after its own
// allowlist + capability gating). This keeps the desktop and web surfaces backed
// by a single implementation. Previously this lived inline in main.ts; extracting
// it lets the per-domain registrar modules register handlers directly.

const { ipcMain } = require('electron/main');
import { RegisterHandler } from './handler-registry';
import type { InvokeChannel } from '../Modules/IPCRegistry/channels';
import type { IpcHandler } from './handler-registry';

const RPC = {
  handle(channel: InvokeChannel, fn: IpcHandler) {
    RegisterHandler(channel, fn);
    return ipcMain.handle(channel, fn);
  },
};

export { RPC };
