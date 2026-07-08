// Lightweight FLIP (First, Last, Invert, Play) animation helper.
//
// ShowTrak re-renders whole list containers by replacing innerHTML, which
// destroys and recreates DOM nodes. To make structural changes (a client
// moving between groups, groups being reordered) feel smooth, we measure the
// on-screen position of every animatable element before the re-render, then
// after the new DOM is in place we invert the position difference with a
// transform and animate it away. Elements are matched across renders by a
// stable `data-flip-key` attribute.
//
// All assets are local; this helper has no external dependencies.

(function () {
  'use strict';

  const ReducedMotion =
    typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)')
      : { matches: false };

  const FLIP_SELECTOR = '[data-flip-key]';
  const FLIP_KEY_ATTR = 'data-flip-key';
  const MOVE_DURATION = 280; // ms
  const ENTER_DURATION = 220; // ms
  const MOVE_EASING = 'cubic-bezier(0.22, 0.61, 0.36, 1)';
  const EPSILON = 0.5; // px; ignore sub-pixel jitter

  function AnimationsEnabled() {
    return !ReducedMotion.matches;
  }

  // Record the viewport rect of every keyed element inside `root`.
  function CaptureFlipState(root) {
    const state = new Map();
    if (!root || !AnimationsEnabled()) return state;
    const nodes = root.querySelectorAll(FLIP_SELECTOR);
    for (const node of nodes) {
      const key = node.getAttribute(FLIP_KEY_ATTR);
      if (!key) continue;
      state.set(key, node.getBoundingClientRect());
    }
    return state;
  }

  // Find the nearest ancestor of `node` that is itself a keyed flip element.
  function FindFlipAncestorRecord(node, recordByNode) {
    let parent = node.parentElement;
    while (parent) {
      if (recordByNode.has(parent)) return recordByNode.get(parent);
      parent = parent.parentElement;
    }
    return null;
  }

  // After the DOM has been rebuilt, slide matched elements from their previous
  // position to their new one and gently fade in brand-new elements.
  function PlayFlipState(root, previous) {
    if (!root || !AnimationsEnabled() || !previous || previous.size === 0) return;

    const nodes = Array.from(root.querySelectorAll(FLIP_SELECTOR));
    const records = [];
    const recordByNode = new Map();

    for (const node of nodes) {
      const key = node.getAttribute(FLIP_KEY_ATTR);
      if (!key) continue;
      const before = previous.get(key);
      const after = node.getBoundingClientRect();
      const record = {
        node,
        before,
        dx: before ? before.left - after.left : 0,
        dy: before ? before.top - after.top : 0,
        isNew: !before,
      };
      records.push(record);
      recordByNode.set(node, record);
    }

    for (const record of records) {
      const ancestor = FindFlipAncestorRecord(record.node, recordByNode);

      if (record.isNew) {
        // Skip the enter animation if an ancestor is also new; it already
        // fades the whole subtree in as one unit.
        if (ancestor && ancestor.isNew) continue;
        AnimateEnter(record.node);
        continue;
      }

      // A moving element inherits its animated ancestor's displacement, so only
      // animate the residual (own movement relative to that ancestor). This
      // keeps a reordering group and the tiles inside it perfectly in sync.
      let dx = record.dx;
      let dy = record.dy;
      if (ancestor && !ancestor.isNew) {
        dx -= ancestor.dx;
        dy -= ancestor.dy;
      }
      if (Math.abs(dx) < EPSILON && Math.abs(dy) < EPSILON) continue;
      AnimateMove(record.node, dx, dy);
    }
  }

  function AnimateMove(node, dx, dy) {
    node.style.transition = 'none';
    node.style.transform = `translate(${dx}px, ${dy}px)`;
    node.style.willChange = 'transform';
    // Force a reflow so the inverted start position is committed.
    void node.offsetWidth;
    requestAnimationFrame(() => {
      node.style.transition = `transform ${MOVE_DURATION}ms ${MOVE_EASING}`;
      node.style.transform = '';
      const cleanup = (event) => {
        if (event && event.target !== node) return;
        node.style.transition = '';
        node.style.transform = '';
        node.style.willChange = '';
        node.removeEventListener('transitionend', cleanup);
      };
      node.addEventListener('transitionend', cleanup);
    });
  }

  function AnimateEnter(node) {
    node.style.transition = 'none';
    node.style.opacity = '0';
    node.style.transform = 'scale(0.96)';
    node.style.willChange = 'opacity, transform';
    void node.offsetWidth;
    requestAnimationFrame(() => {
      node.style.transition = `opacity ${ENTER_DURATION}ms ease, transform ${ENTER_DURATION}ms ${MOVE_EASING}`;
      node.style.opacity = '';
      node.style.transform = '';
      const cleanup = (event) => {
        if (event && event.target !== node) return;
        node.style.transition = '';
        node.style.opacity = '';
        node.style.transform = '';
        node.style.willChange = '';
        node.removeEventListener('transitionend', cleanup);
      };
      node.addEventListener('transitionend', cleanup);
    });
  }

  // Capture the current layout, run the (synchronous) render callback, then
  // animate the difference. Callers that build markup imperatively can use this
  // wrapper instead of calling Capture/Play by hand.
  function AnimateReflow(root, renderFn) {
    if (typeof renderFn !== 'function') return;
    if (!root || !AnimationsEnabled()) {
      renderFn();
      return;
    }
    const previous = CaptureFlipState(root);
    renderFn();
    PlayFlipState(root, previous);
  }

  window.ShowTrakFlip = {
    Enabled: AnimationsEnabled,
    Capture: CaptureFlipState,
    Play: PlayFlipState,
    AnimateReflow,
  };
})();
