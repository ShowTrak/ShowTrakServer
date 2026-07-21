import { openModal } from './lib/modal';
import { AppMode } from './01-state';
import { HandleNonFatalError, Safe } from './04-utils';
import { DismissAlert, PendingAdoptionAlerts } from './10-alerts-tray';
// Global event delegation for Adopt buttons (works across re-renders).
// Called by the bootstrap orchestrator in main.ts — never at import time.
export function InitDnd() {
  document.addEventListener('click', async (e) => {
    const target = e.target as HTMLButtonElement | null;
    if (!(target && target.classList && target.classList.contains('ADOPT_BTN'))) return;
    // Prevent bubbling to tile click handler (which toggles selection)
    try {
      e.preventDefault();
      e.stopPropagation();
    } catch (err) {
      HandleNonFatalError('DnD:AdoptButtonPreventDefault', err);
    }
    const btn = target;
    const UUID = btn.getAttribute('data-uuid');
    if (!UUID) return;
    try {
      btn.disabled = true;
      btn.textContent = 'Adopting…';
      // Auto-dismiss any existing adoption alert for this UUID immediately
      try {
        const id = PendingAdoptionAlerts.get(UUID);
        if (id) {
          DismissAlert(id);
          PendingAdoptionAlerts.delete(UUID);
        }
      } catch (err) {
        HandleNonFatalError('DnD:DismissPendingAdoptionAlert', err);
      }
      await window.API.AdoptDevice(UUID);
    } catch (err) {
      HandleNonFatalError('DnD:AdoptDevice', err);
      btn.disabled = false;
      btn.textContent = 'Adopt';
    }
  });
}

// Drag & Drop reordering/move (only active in EDIT mode)
interface DnDStateShape {
  dragUUID: string | null | undefined;
  sourceGroupId: number | null;
  dragSize: { width: number; height: number } | null;
  dragGhostClasses: string[] | null;
  ghostEl: HTMLElement | null;
  currentOverGroup: HTMLElement | null;
  rowIndex: number | null;
  sourceSpacer?: HTMLElement | null;
}

export let DnDState: DnDStateShape = {
  dragUUID: null,
  sourceGroupId: null,
  dragSize: null,
  dragGhostClasses: null,
  ghostEl: null,
  currentOverGroup: null,
  rowIndex: null,
};

export function initializeEditInteractions() {
  const isEdit = AppMode === 'EDIT';
  $('.SHOWTRAK_PC').attr('draggable', String(isEdit));
  if (!isEdit) {
    teardownDnD();
    return;
  }
  setupDnD();
}

// Build and show the Keyboard Shortcuts modal
export function ShowShortcutsModal() {
  try {
    $('#KEYBOARD_SHORTCUTS_LIST').html('');
  } catch (err) {
    HandleNonFatalError('DnD:ShowShortcutsModal:ClearList', err);
  }
  const items: Array<{ title: string; shortcut: string }> = [];
  // Core selection/navigation (Ctrl or Cmd)
  items.push({ title: 'Select All', shortcut: 'Ctrl/Cmd+A' });
  items.push({ title: 'Clear Selection', shortcut: 'Ctrl/Cmd+D' });
  // Core menu actions
  items.push({ title: 'New Show', shortcut: 'Ctrl/Cmd+N' });
  items.push({ title: 'Open Show', shortcut: 'Ctrl/Cmd+O' });
  items.push({ title: 'Save Show', shortcut: 'Ctrl/Cmd+S' });
  items.push({ title: 'Save Show As', shortcut: 'Ctrl/Cmd+Shift+S' });
  items.push({ title: 'Switch to Show Mode', shortcut: 'Ctrl/Cmd+1' });
  items.push({ title: 'Switch to Edit Mode', shortcut: 'Ctrl/Cmd+2' });
  items.push({ title: 'ShowTrak Preferences', shortcut: 'Ctrl/Cmd+,' });
  items.push({ title: 'LAN Discovery Wizard', shortcut: 'Ctrl/Cmd+L' });
  items.push({ title: 'Toggle Compact/Expanded Mode', shortcut: 'Ctrl/Cmd+E' });
  // Alerts
  items.push({ title: 'Toggle Alert Actions Enabled/Disabled', shortcut: 'Ctrl/Cmd+T' });
  items.push({ title: 'Toggle Alerts Panel', shortcut: 'Ctrl/Cmd+Y' });
  items.push({ title: 'Dismiss All Alerts', shortcut: 'Ctrl/Cmd+U' });
  // Modals/UI
  items.push({ title: 'Open Keyboard Shortcuts', shortcut: 'Ctrl/Cmd+K' });
  // Context menu
  items.push({ title: 'Open Context Menu (global)', shortcut: 'Ctrl/Cmd+Shift+M' });
  items.push({ title: 'Open Context Menu', shortcut: 'Menu key/Shift+F10' });

  const $list = $('#KEYBOARD_SHORTCUTS_LIST');
  const formatShortcut = (text: string) => {
    const parts = String(text)
      .split('+')
      .map((p) => p.trim());
    const html = parts
      .map((part) => {
        if (part.includes('/')) {
          return part
            .split('/')
            .map((p) => `<kbd>${Safe(p.trim())}</kbd>`)
            .join('<span class="key-sep">/</span>');
        }
        return `<kbd>${Safe(part)}</kbd>`;
      })
      .join('<span class="key-plus"> + </span>');
    return html;
  };
  if ($list && $list.length) {
    for (const it of items) {
      $list.append(`
				<div class="bg-ghost rounded p-2 d-flex justify-content-between align-items-center">
					<div>${Safe(it.title)}</div>
					<div class="text-sm text-light">${formatShortcut(it.shortcut)}</div>
				</div>
			`);
    }
  }
  openModal('SHOWTRAK_MODAL_SHORTCUTS');
}

export function teardownDnD() {
  if (DnDState.ghostEl && DnDState.ghostEl.remove) {
    try {
      DnDState.ghostEl.remove();
    } catch (err) {
      HandleNonFatalError('DnD:TeardownGhostRemove', err);
    }
  }
  if (DnDState.sourceSpacer) {
    try {
      DnDState.sourceSpacer.remove();
    } catch (err) {
      /* ignore */
    }
  }
  DnDState = {
    dragUUID: null,
    sourceGroupId: null,
    dragSize: null,
    dragGhostClasses: null,
    ghostEl: null,
    currentOverGroup: null,
    rowIndex: null,
    sourceSpacer: null,
  };
  $(document).off('dragstart.dnd dragend.dnd dragover.dnd dragenter.dnd dragleave.dnd drop.dnd');
}

export function setupDnD() {
  // Avoid duplicate bindings
  $(document).off('dragstart.dnd dragend.dnd dragover.dnd dragenter.dnd dragleave.dnd drop.dnd');

  $(document).on('dragstart.dnd', '.SHOWTRAK_PC', function (e) {
    if (AppMode !== 'EDIT') return;
    const uuid = $(this).attr('data-uuid');
    DnDState.dragUUID = uuid;
    try {
      const r = this.getBoundingClientRect();
      DnDState.dragSize = {
        width: r.width,
        height: r.height,
      };
      const variantMap = {
        ONLINE: 'dnd-ghost--online',
        IDLE: 'dnd-ghost--idle',
        DEGRADED: 'dnd-ghost--degraded',
        PENDING: 'dnd-ghost--pending',
        MONITOR: 'dnd-ghost--monitor',
        DUMMY: 'dnd-ghost--dummy',
      };
      DnDState.dragGhostClasses = Object.entries(variantMap)
        .filter(([srcClass]) => this.classList.contains(srcClass))
        .map(([, ghostClass]) => ghostClass);
    } catch (err) {
      HandleNonFatalError('DnD:CaptureDragSize', err);
      DnDState.dragSize = null;
      DnDState.dragGhostClasses = null;
    }
    const $group = $(this).closest('.group-drop-zone');
    DnDState.sourceGroupId = normalizeGroupId($group.attr('data-groupid'));
    try {
      const dt = (e.originalEvent as DragEvent).dataTransfer;
      dt!.setData('text/plain', String(uuid));
      dt!.effectAllowed = 'move';
    } catch (err) {
      HandleNonFatalError('DnD:DragStartDataTransfer', err);
    }
    // Defer hiding the source tile so the browser can capture the drag image
    // before display:none is applied (synchronous hide aborts the drag).
    const dragEl = this;
    requestAnimationFrame(() => {
      if (DnDState.dragUUID !== uuid) return;
      dragEl.classList.add('dragging');
      // Insert an invisible same-size spacer so the source group doesn't
      // collapse when this is the only tile in it.
      if (DnDState.dragSize && dragEl.parentNode) {
        const spacer = document.createElement('div');
        spacer.className = 'dnd-source-spacer';
        spacer.setAttribute('aria-hidden', 'true');
        spacer.style.width = `${DnDState.dragSize.width}px`;
        spacer.style.height = `${DnDState.dragSize.height}px`;
        spacer.style.flexShrink = '0';
        spacer.style.pointerEvents = 'none';
        dragEl.parentNode.insertBefore(spacer, dragEl);
        DnDState.sourceSpacer = spacer;
      }
    });
  });

  $(document).on('dragend.dnd', '.SHOWTRAK_PC', function () {
    $(this).removeClass('dragging');
    clearGhost();
    if (DnDState.currentOverGroup) $(DnDState.currentOverGroup).removeClass('dnd-over');
    DnDState.currentOverGroup = null;
    DnDState.rowIndex = null;
    DnDState.dragUUID = null;
    DnDState.dragGhostClasses = null;
    if (DnDState.sourceSpacer) {
      try {
        DnDState.sourceSpacer.remove();
      } catch (err) {
        /* ignore */
      }
      DnDState.sourceSpacer = null;
    }
  });

  $(document).on('dragover.dnd', '.group-drop-zone', function (e) {
    if (AppMode !== 'EDIT') return;
    e.preventDefault();
    const container = this;
    if (DnDState.currentOverGroup !== container) {
      $(DnDState.currentOverGroup as HTMLElement).removeClass('dnd-over');
      $(container).addClass('dnd-over');
      DnDState.currentOverGroup = container;
    }
    const mouseX = (e.originalEvent as DragEvent).clientX;
    const mouseY = (e.originalEvent as DragEvent).clientY;
    positionGhostMarker(container, mouseX, mouseY);
  });

  $(document).on('dragleave.dnd', '.group-drop-zone', function (e) {
    if (AppMode !== 'EDIT') return;
    if (!this.contains((e.originalEvent as DragEvent).relatedTarget as Node | null)) {
      $(this).removeClass('dnd-over');
      clearGhost();
      DnDState.currentOverGroup = null;
    }
  });

  $(document).on('drop.dnd', '.group-drop-zone', async function (e) {
    if (AppMode !== 'EDIT') return;
    e.preventDefault();
    const targetGroupId = normalizeGroupId($(this).attr('data-groupid'));
    const dragUUID = DnDState.dragUUID;
    if (!dragUUID) return;
    const order = computeOrderWithGhost(this, dragUUID);
    clearGhost();
    $(this).removeClass('dnd-over');
    DnDState.currentOverGroup = null;
    try {
      await window.API.SetGroupOrder(targetGroupId as number, order);
    } catch (err) {
      HandleNonFatalError('DnD:DropSetGroupOrder', err);
    }
  });
}

export function normalizeGroupId(val: string | null | undefined) {
  if (val === undefined || val === null || String(val) === 'null' || String(val) === '')
    return null;
  const num = parseInt(val, 10);
  return isNaN(num) ? null : num;
}

export function createGhostEl() {
  const el = document.createElement('div');
  el.className = 'dnd-ghost';
  if (Array.isArray(DnDState.dragGhostClasses) && DnDState.dragGhostClasses.length) {
    el.classList.add(...DnDState.dragGhostClasses);
  }
  el.setAttribute('aria-hidden', 'true');
  el.style.pointerEvents = 'none';
  return el;
}

export function clearGhost() {
  if (DnDState.ghostEl && DnDState.ghostEl.parentNode) {
    const parent = DnDState.ghostEl.parentNode as HTMLElement;
    parent.removeChild(DnDState.ghostEl);
    const placeholder = parent.querySelector<HTMLElement>('.SHOWTRAK_PC_PLACEHOLDER');
    if (placeholder) placeholder.style.display = '';
  }
  DnDState.ghostEl = null;
  // Ghost is no longer in the source group — restore spacer visibility.
  if (DnDState.sourceSpacer) DnDState.sourceSpacer.style.display = '';
}

export function applyGhostSize(ghost: HTMLElement, fallbackRect: DOMRect | null) {
  const width = DnDState.dragSize?.width || fallbackRect?.width || 220;
  const height = DnDState.dragSize?.height || fallbackRect?.height || 110;
  ghost.style.width = `${Math.max(1, Math.round(width))}px`;
  ghost.style.height = `${Math.max(1, Math.round(height))}px`;
}

export function positionGhostMarker(container: HTMLElement, x: number, y: number) {
  // When the ghost enters the source group the spacer's job is done by the
  // ghost itself — hide it so we don't have two slots for one tile.
  const isSourceGroup =
    normalizeGroupId(container.getAttribute('data-groupid')) === DnDState.sourceGroupId;
  if (DnDState.sourceSpacer) {
    DnDState.sourceSpacer.style.display = isSourceGroup ? 'none' : '';
  }

  const tiles = Array.from<Element>(container.querySelectorAll('.SHOWTRAK_PC')).filter(
    (el) =>
      !el.classList.contains('dnd-ghost') && el.getAttribute('data-uuid') !== DnDState.dragUUID
  );
  const HYSTERESIS_X = 6; // horizontal jitter buffer within a row
  const ROW_TOL = 14; // tolerance to group tiles into rows
  const ROW_STICKY = 16; // vertical stickiness to keep current row
  const EDGE_X = 12; // edge stickiness at start/end of rows
  const EDGE_Y = 12; // vertical edge tolerance for group start/end

  if (tiles.length === 0) {
    if (!DnDState.ghostEl) DnDState.ghostEl = createGhostEl();
    applyGhostSize(DnDState.ghostEl!, null);
    const placeholder = container.querySelector<HTMLElement>('.SHOWTRAK_PC_PLACEHOLDER');
    if (placeholder) {
      placeholder.style.display = 'none';
      container.insertBefore(DnDState.ghostEl, placeholder);
    } else {
      container.appendChild(DnDState.ghostEl);
    }
    return;
  }

  // Compute rects and rows (group by top within tolerance)
  const rects = tiles
    .map((t) => ({ el: t, r: t.getBoundingClientRect() }))
    .sort((a, b) => a.r.top - b.r.top || a.r.left - b.r.left);
  interface RowEntry {
    top: number;
    bottom: number;
    tiles: Array<{ el: Element; r: DOMRect }>;
    left: number;
    right: number;
  }
  const rows: RowEntry[] = [];
  for (const o of rects) {
    const last = rows[rows.length - 1];
    if (!last || Math.abs(o.r.top - last.top) > ROW_TOL) {
      rows.push({ top: o.r.top, bottom: o.r.bottom, tiles: [o], left: o.r.left, right: o.r.right });
    } else {
      last.tiles.push(o);
      last.top = Math.min(last.top, o.r.top);
      last.bottom = Math.max(last.bottom, o.r.bottom);
      last.left = Math.min(last.left, o.r.left);
      last.right = Math.max(last.right, o.r.right);
    }
  }
  // Useful group edges
  // tiles.length === 0 returned above, so rows/tiles/rects are non-empty here
  const firstRow = rows[0]!;
  const lastRow = rows[rows.length - 1]!;

  // Start-of-group zone: snap before first
  const firstTile = tiles[0]!;
  const firstRect = rects[0]!.r;
  if (
    (x <= firstRow.left + EDGE_X && y <= firstRow.bottom + EDGE_Y) ||
    y <= firstRect.top - EDGE_Y
  ) {
    if (!DnDState.ghostEl) DnDState.ghostEl = createGhostEl();
    const ghost = DnDState.ghostEl!;
    applyGhostSize(ghost, firstRect);
    firstTile.parentNode!.insertBefore(ghost, firstTile);
    return;
  }

  // End-of-group zone: snap after last
  const lastRect = rects[rects.length - 1]!.r;
  if ((x >= lastRow.right - EDGE_X && y >= lastRow.top - EDGE_Y) || y >= lastRow.bottom - 2) {
    if (!DnDState.ghostEl) DnDState.ghostEl = createGhostEl();
    const ghost = DnDState.ghostEl!;
    applyGhostSize(ghost, lastRect);
    container.appendChild(ghost);
    return;
  }

  // Determine active row with hysteresis
  let rowIdx = -1;
  // Keep previous row if cursor still within its sticky band
  if (DnDState.rowIndex !== null && rows[DnDState.rowIndex]) {
    // guarded by the truthy check above
    const prev = rows[DnDState.rowIndex]!;
    if (y >= prev.top - ROW_STICKY && y <= prev.bottom + ROW_STICKY) {
      rowIdx = DnDState.rowIndex;
    }
  }
  if (rowIdx === -1) {
    // Prefer a row whose band contains the cursor
    for (let i = 0; i < rows.length; i++) {
      // i is within bounds of rows
      const rw = rows[i]!;
      if (y >= rw.top - ROW_STICKY && y <= rw.bottom + ROW_STICKY) {
        rowIdx = i;
        break;
      }
    }
  }
  if (rowIdx === -1) {
    // Fallback: closest by vertical distance to row center
    let bestD = Infinity;
    for (let i = 0; i < rows.length; i++) {
      const rw = rows[i]!;
      const cy = (rw.top + rw.bottom) / 2;
      const d = Math.abs(y - cy);
      if (d < bestD) {
        bestD = d;
        rowIdx = i;
      }
    }
  }
  if (rowIdx < 0) rowIdx = 0;
  DnDState.rowIndex = rowIdx;

  // Place within the selected row
  // rowIdx is clamped to a valid index above
  const row = rows[rowIdx]!;
  // Find nearest tile by x within the row
  let nearest: { tile: Element; rect: DOMRect } | null = null;
  let nearestDist = Infinity;
  for (const { el, r } of row.tiles) {
    const cx = r.left + r.width / 2;
    const d = Math.abs(x - cx);
    if (d < nearestDist) {
      nearestDist = d;
      nearest = { tile: el, rect: r };
    }
  }
  if (!nearest) return;

  // Snap to row ends with edge stickiness
  if (x <= row.left + EDGE_X) {
    if (!DnDState.ghostEl) DnDState.ghostEl = createGhostEl();
    const ghost = DnDState.ghostEl!;
    applyGhostSize(ghost, nearest.rect);
    const firstInRow = row.tiles[0]!.el;
    firstInRow.parentNode!.insertBefore(ghost, firstInRow);
    return;
  }
  if (x >= row.right - EDGE_X) {
    if (!DnDState.ghostEl) DnDState.ghostEl = createGhostEl();
    const ghost = DnDState.ghostEl!;
    applyGhostSize(ghost, nearest.rect);
    const lastInRow = row.tiles[row.tiles.length - 1]!.el;
    lastInRow.parentNode!.insertBefore(ghost, lastInRow.nextSibling);
    return;
  }

  // General within-row placement with horizontal hysteresis
  const centerX = (nearest.rect.left + nearest.rect.right) / 2;
  const before = x < centerX - HYSTERESIS_X;
  if (!DnDState.ghostEl) DnDState.ghostEl = createGhostEl();
  const ghost = DnDState.ghostEl;
  applyGhostSize(ghost, nearest.rect);
  if (before) {
    nearest.tile.parentNode!.insertBefore(ghost, nearest.tile);
  } else {
    nearest.tile.parentNode!.insertBefore(ghost, nearest.tile.nextSibling);
  }
}

export function computeOrderWithGhost(container: HTMLElement, dragUUID: string) {
  const children = Array.from<Element>(container.children);
  const order: string[] = [];
  for (const el of children) {
    if (el.classList && el.classList.contains('dnd-ghost')) {
      order.push(dragUUID);
      continue;
    }
    if (el.classList && el.classList.contains('SHOWTRAK_PC')) {
      const id = el.getAttribute('data-uuid');
      if (id && id !== dragUUID) order.push(id);
    }
  }
  if (!order.includes(dragUUID)) order.push(dragUUID);
  return order;
}
