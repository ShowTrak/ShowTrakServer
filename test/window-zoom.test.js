const test = require('node:test');
const assert = require('node:assert/strict');

// window-zoom.ts binds Ctrl +/-/0 on platforms that run without an application
// menu (everything except macOS, which gets the accelerators from the viewMenu
// role). It touches no Electron module at require time, so these tests drive it
// with a fake BrowserWindow that records the before-input-event handler.

const {
  applyWindowZoomShortcuts,
  ZOOM_LEVEL_MIN,
  ZOOM_LEVEL_MAX,
} = require('../dist/main/window-zoom');

// Fake window exposing just the surface window-zoom touches. `press` replays a
// keyboard input through the registered handler and reports whether the key was
// swallowed (preventDefault) plus the resulting zoom level.
function createFakeWindow({ destroyed = false } = {}) {
  let zoomLevel = 0;
  let handler = null;
  const windowInstance = {
    isDestroyed: () => destroyed,
    webContents: {
      on: (eventName, fn) => {
        if (eventName === 'before-input-event') handler = fn;
      },
      getZoomLevel: () => zoomLevel,
      setZoomLevel: (level) => {
        zoomLevel = level;
      },
    },
  };
  return {
    windowInstance,
    hasHandler: () => handler !== null,
    press: (input) => {
      let prevented = false;
      handler(
        { preventDefault: () => (prevented = true) },
        {
          type: 'keyDown',
          key: '',
          code: '',
          control: false,
          meta: false,
          alt: false,
          ...input,
        }
      );
      return { prevented, zoomLevel };
    },
  };
}

// Run `fn` with process.platform forced to `platform`, then restore it.
function withPlatform(platform, fn) {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  try {
    fn();
  } finally {
    Object.defineProperty(process, 'platform', original);
  }
}

test('Ctrl+Plus / Ctrl+Minus step the zoom level and swallow the key', () => {
  withPlatform('win32', () => {
    const fake = createFakeWindow();
    applyWindowZoomShortcuts(fake.windowInstance);

    // Main row: '=' unshifted and '+' shifted both zoom in.
    assert.deepEqual(fake.press({ key: '=', control: true }), { prevented: true, zoomLevel: 0.5 });
    assert.deepEqual(fake.press({ key: '+', control: true }), { prevented: true, zoomLevel: 1 });
    assert.deepEqual(fake.press({ key: '-', control: true }), { prevented: true, zoomLevel: 0.5 });

    // Numpad reports key '+'/'-' too, but assert the code path explicitly.
    assert.equal(fake.press({ code: 'NumpadAdd', control: true }).zoomLevel, 1);
    assert.equal(fake.press({ code: 'NumpadSubtract', control: true }).zoomLevel, 0.5);
  });
});

test('Ctrl+0 resets zoom to the default level', () => {
  withPlatform('win32', () => {
    const fake = createFakeWindow();
    applyWindowZoomShortcuts(fake.windowInstance);

    fake.press({ key: '+', control: true });
    fake.press({ key: '+', control: true });
    assert.deepEqual(fake.press({ key: '0', control: true }), { prevented: true, zoomLevel: 0 });
  });
});

test('zoom level is clamped to the usable range', () => {
  withPlatform('win32', () => {
    const fake = createFakeWindow();
    applyWindowZoomShortcuts(fake.windowInstance);

    for (let i = 0; i < 40; i++) fake.press({ key: '+', control: true });
    assert.equal(fake.press({ key: '+', control: true }).zoomLevel, ZOOM_LEVEL_MAX);

    for (let i = 0; i < 40; i++) fake.press({ key: '-', control: true });
    assert.equal(fake.press({ key: '-', control: true }).zoomLevel, ZOOM_LEVEL_MIN);
  });
});

test('non-zoom keys and modifier combos pass through to the renderer', () => {
  withPlatform('win32', () => {
    const fake = createFakeWindow();
    applyWindowZoomShortcuts(fake.windowInstance);

    // No Ctrl: typing '-' in an input must not zoom.
    assert.deepEqual(fake.press({ key: '-' }), { prevented: false, zoomLevel: 0 });
    // Ctrl+Alt is AltGr on many non-US layouts and types real characters.
    assert.deepEqual(fake.press({ key: '-', control: true, alt: true }), {
      prevented: false,
      zoomLevel: 0,
    });
    // Unrelated Ctrl shortcut (Ctrl+S) is left alone.
    assert.deepEqual(fake.press({ key: 's', control: true }), { prevented: false, zoomLevel: 0 });
    // keyUp must not double-apply the step.
    assert.deepEqual(fake.press({ key: '+', control: true, type: 'keyUp' }), {
      prevented: false,
      zoomLevel: 0,
    });
  });
});

test('macOS is skipped so the viewMenu accelerators are not double-applied', () => {
  withPlatform('darwin', () => {
    const fake = createFakeWindow();
    applyWindowZoomShortcuts(fake.windowInstance);
    assert.equal(fake.hasHandler(), false);
  });
});

test('a destroyed window registers nothing', () => {
  withPlatform('win32', () => {
    const fake = createFakeWindow({ destroyed: true });
    applyWindowZoomShortcuts(fake.windowInstance);
    assert.equal(fake.hasHandler(), false);
  });
});
