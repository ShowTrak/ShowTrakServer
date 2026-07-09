// Central registry of IPC invoke handlers.
//
// The desktop renderer talks to the main process over Electron IPC
// (`ipcMain.handle`). The Web UI talks over the `/ui` Socket.IO namespace. To
// avoid maintaining two divergent implementations of the same actions, every
// `RPC.handle(channel, fn)` registration in the main process also records its
// handler function here. Non-Electron surfaces (the web `/ui` namespace) can
// then dispatch to the SAME handler after applying their own allowlist +
// capability gating.
//
// Handlers are written to be surface-agnostic: the first `event` argument is
// unused by the tuple-style handlers, so the web bridge passes `null` for it.

import type { InvokeChannel } from '../Modules/IPCRegistry/channels';

type IpcHandler = (event: unknown, ...args: unknown[]) => unknown;

const Handlers = new Map<string, IpcHandler>();

// Record a handler for a channel (called by the RPC wrapper in main.ts).
// The channel must exist in the IPC registry — registering an unlisted
// channel is a compile error.
function RegisterHandler(channel: InvokeChannel, fn: IpcHandler): void {
  Handlers.set(channel, fn);
}

// Look up a previously registered handler.
function GetHandler(channel: string): IpcHandler | undefined {
  return Handlers.get(channel);
}

// Whether a handler exists for the given channel.
function HasHandler(channel: string): boolean {
  return Handlers.has(channel);
}

export { RegisterHandler, GetHandler, HasHandler };
export type { IpcHandler };
