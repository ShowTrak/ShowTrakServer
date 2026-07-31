// Wire shapes for the FreeKiosk device REST API.
//
// FreeKiosk wraps every JSON response in a `{ success, data, timestamp }`
// envelope. Reads return their sub-object under `data`; control endpoints
// return a command result under `data` whose real verdict is `executed` — see
// the comment on FreeKioskCommandResult, which is the single most important
// behaviour in this module.

/** The envelope every FreeKiosk JSON endpoint returns. */
export interface FreeKioskEnvelope<T = unknown> {
  success?: unknown;
  data?: T;
  error?: unknown;
  timestamp?: unknown;
}

/**
 * A control endpoint's result.
 *
 * FreeKiosk answers HTTP 200 with `success: true` even when the device refused
 * the command — a reboot without Device Owner, or a lock without admin rights,
 * comes back "successful" with `executed: false` and a human-readable `error`.
 * Anything that treats the HTTP status or `success` flag as the verdict will
 * pass every local test and silently no-op in production.
 */
export interface FreeKioskCommandResult {
  executed?: unknown;
  command?: unknown;
  error?: unknown;
  [key: string]: unknown;
}

/**
 * The `data` of GET /api/status. Every field is optional: the shipped API and
 * its documentation disagree in several places (the docs name `wifi.rssi` and
 * `device.android`, the device sends `wifi.signalStrength` and
 * `device.androidVersion`), older builds omit whole sub-objects, and a device
 * without a sensor reports -1 rather than dropping the key. Nothing here may be
 * assumed present — the metric registry reads it defensively.
 */
export interface FreeKioskStatus {
  battery?: Record<string, unknown>;
  screen?: Record<string, unknown>;
  audio?: Record<string, unknown>;
  webview?: Record<string, unknown>;
  device?: Record<string, unknown>;
  wifi?: Record<string, unknown>;
  rotation?: Record<string, unknown>;
  sensors?: Record<string, unknown>;
  autoBrightness?: Record<string, unknown>;
  storage?: Record<string, unknown>;
  memory?: Record<string, unknown>;
  [key: string]: unknown;
}

/** One camera reported by GET /api/camera/list. */
export interface FreeKioskCamera {
  id: string;
  facing: string;
  maxWidth: number;
  maxHeight: number;
}

/** A decoded screenshot or camera capture, ready to hand to the renderer. */
export interface FreeKioskImage {
  DataUrl: string;
  Bytes: number;
  Mime: string;
  CapturedAt: number;
}

/** Connection details for one terminal, as the protocol client needs them. */
export interface FreeKioskConnection {
  Address: string;
  Port: number;
  ApiKey?: string | null;
  TimeoutMs?: number;
}

/**
 * Why a request failed, beyond its message. `control-disabled` is the device's
 * global remote-control kill switch (HTTP 403) and is recorded against the
 * terminal so the UI can disable its controls and explain why, rather than
 * failing every button press with an unexplained toast.
 */
export type FreeKioskFailureKind =
  | 'transport'
  | 'timeout'
  | 'unauthorized'
  | 'control-disabled'
  | 'not-found'
  | 'bad-response'
  | 'device-error'
  | 'refused'
  | 'unavailable'
  | 'too-large';

export interface FreeKioskFailure {
  Kind: FreeKioskFailureKind;
  Message: string;
}
