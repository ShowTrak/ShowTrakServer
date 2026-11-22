// Central renderer push bus: @showtrak/protocol/electron-main's, shared with
// ShowTrak Timers.
//
// Every main-process push to "the renderer" goes through PushToRenderers, which
// fans it out to every registered sink: the Electron desktop window (main.ts)
// and each authed Web UI and /sdk socket (Modules/Server). Routing every push
// through one bus keeps the desktop and web surfaces receiving identical events.
// A throwing sink is isolated from the others.
import { CreateRendererBus } from '@showtrak/protocol/electron-main';

export const { RegisterRendererSink, PushToRenderers } = CreateRendererBus();
