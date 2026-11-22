// The preload API of the splash (preloader) window: what src/bridge_preloader.ts
// exposes on `window.API`, and all that its page script, src/UI/preloader.ts,
// may call.
//
// It lives here, apart from both, because the two are compiled by different
// programs: the bridge with Electron's and Node's types (tsconfig.json), the
// page script with the DOM's and nothing else (tsconfig.preloader.json). A
// type-only module that imports nothing but the protocol types fits in both.
import type { ShowTrakAPI } from '@showtrak/protocol';

/** The splash window's `window.API`: the main window's GetConfig, on the same channel. */
export type PreloaderAPI = Pick<ShowTrakAPI, 'GetConfig'>;
