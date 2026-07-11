// Runtime capabilities describing which surface the shared renderer is running
// on (Electron desktop vs browser Web UI) and what it may do. The web bootstrap
// injects `window.__SHOWTRAK_CAPS__` before the shared modules load; on the
// desktop nothing is injected and we fall back to the full-capability profile.
//
// `window.__SHOWTRAK_CAPS__` is deliberately NOT folded into a state setter: it
// is an external injection contract set by the WebUI HTML shell before any
// module evaluates, so it must remain a window global read at import time.
export interface CapabilityProfile {
  isWeb: boolean;
  showNavbar: boolean;
  showCogs: boolean;
  showModeToggle: boolean;
  canToggleAlertActions: boolean;
  requiresPasscode: boolean;
  allowRemoteScripts: boolean;
  wolEnabled: boolean;
}

const DESKTOP_CAPABILITIES: CapabilityProfile = {
  isWeb: false,
  showNavbar: true,
  showCogs: true,
  showModeToggle: true,
  canToggleAlertActions: true,
  requiresPasscode: false,
  allowRemoteScripts: true,
  wolEnabled: true,
};

export const Capabilities: CapabilityProfile = (() => {
  try {
    const injected = window.__SHOWTRAK_CAPS__;
    if (injected && typeof injected === 'object') {
      return { ...DESKTOP_CAPABILITIES, ...injected, isWeb: true };
    }
  } catch {
    // Fall through to desktop defaults.
  }
  return DESKTOP_CAPABILITIES;
})();
