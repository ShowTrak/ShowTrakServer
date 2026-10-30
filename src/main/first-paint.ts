// "The desktop renderer has its data" signal, used to decide when to reveal the
// main window at startup.
//
// The window used to be shown a fixed 800 ms after its page loaded, which on a
// fast machine was most of the startup time and on a slow one could still show
// the UI before it had hydrated. The renderer finishes initialising by calling
// 'Loaded', and the main process answers by pushing the full initial state; once
// that push is done the UI has everything it needs to draw.

let Delivered = false;
const Waiters: Array<() => void> = [];

// Called once the initial state push for a renderer load has finished (or
// failed: the window must still be shown).
function markInitialStateDelivered(): void {
  if (Delivered) return;
  Delivered = true;
  for (const Resolve of Waiters.splice(0)) Resolve();
}

// Resolves on the first delivery, or after `TimeoutMs` regardless, so a
// renderer that fails to initialise can never leave the window hidden.
function whenInitialStateDelivered(TimeoutMs: number): Promise<void> {
  if (Delivered) return Promise.resolve();
  return new Promise((resolve) => {
    const Timer = setTimeout(resolve, TimeoutMs);
    Waiters.push(() => {
      clearTimeout(Timer);
      resolve();
    });
  });
}

export { markInitialStateDelivered, whenInitialStateDelivered };
