// Right-click / mobile context-menu wiring. It owns the `#SHOWTRAK_CONTEXT_MENU`
// element and its mechanics: rendering, positioning, keyboard/type-ahead
// navigation, the mobile tap-to-confirm arming, and the outside-click / Escape
// close paths. What the menu offers for a selection is built in
// ./context-menu-options; the placement and type-ahead rules are pure functions
// in ./lib/menu-placement and ./lib/menu-typeahead. init.ts calls
// wireContextMenu() from WireGlobalUI.
import { Selected } from './state';
import { GetSettingValue } from './settings';
import { HandleNonFatalError, Safe } from './utils';
import { ClearSelection, Select } from './selection';
import { BuildContextMenuOptions, type ContextMenuOption } from './context-menu-options';
import { LongPressTracker } from './lib/long-press';
import { RequiresTapConfirm, ResolveClickPointerType } from './lib/touch-input';
import { PlaceMenu, ResolveMenuAnchor } from './lib/menu-placement';
import { FindTypeaheadMatch, NextTypeaheadBuffer } from './lib/menu-typeahead';

// True when the UI is in the compact mobile layout (see InitMobileView in
// mode.ts, which toggles `body.mobile-view`). Used to switch the context
// menu into its full-width sheet, where every activation needs a confirm tap
// (finger/pen taps need one in any layout; see RequiresTapConfirm).
function IsMobileContextMenu(): boolean {
  return document.body.classList.contains('mobile-view');
}

// Put a context-menu row into its "Tap to confirm" armed state, reverting any
// other row that was previously armed. A second tap on the armed row runs the
// action (handled by the row's own click binding).
function ArmContextMenuRow($menu: JQuery, $row: JQuery) {
  $menu.find('a.context-confirm-pending').each(function (this: HTMLElement) {
    const $other = $(this);
    if ($other.is($row)) return;
    $other.removeClass('context-confirm-pending');
    const orig = $other.data('optionTitle');
    if (typeof orig === 'string') $other.find('.context-title').text(orig);
  });
  $row.addClass('context-confirm-pending');
  $row.find('.context-title').text('Tap to confirm');
}

// Run a row's action, then clear the selection when UI_CLEAR_SELECTION_AFTER_ACTION
// is on. The setting is global, but only the surface whose menu ran the action
// clears, and only its own selection: selection never leaves the renderer, and
// OSC/SDK-triggered runs don't come through here. A confirmation the user backed
// out of resolves to false and keeps the selection.
async function RunContextMenuOption(option: ContextMenuOption) {
  const Result = await option.Action!();
  if (!option.ActsOnSelection || Result === false) return;
  if (await GetSettingValue('UI_CLEAR_SELECTION_AFTER_ACTION')) ClearSelection();
}

// Arrow keys, Home/End, Enter/Space and Escape within the open menu, plus
// type-to-search by title (./lib/menu-typeahead) and hover-to-focus.
function BindContextMenuKeyboard($menu: JQuery) {
  // Keyboard navigation within context menu
  $menu.off('keydown').on('keydown', function (ev) {
    const key = ev.key;
    const $items = $menu.find(
      'a.SHOWTRAK_CONTEXTMENU_BUTTON[role="menuitem"]:not([aria-disabled="true"])'
    );
    if ($items.length === 0) return;
    const activeEl = document.activeElement;
    let idx = $items.index(activeEl as Element);

    // Type-to-search (typeahead) for menu items by visible title
    const isChar =
      key && key.length === 1 && !ev.ctrlKey && !ev.metaKey && !ev.altKey && key !== ' ';
    if (isChar) {
      ev.preventDefault();
      const now = Date.now();
      const buf = NextTypeaheadBuffer(
        ($menu.data('typeaheadBuffer') || '').toString(),
        $menu.data('typeaheadTime') || 0,
        key,
        now
      );
      $menu.data('typeaheadBuffer', buf);
      $menu.data('typeaheadTime', now);
      const prevTimer = $menu.data('typeaheadTimer');
      if (prevTimer) {
        try {
          clearTimeout(prevTimer);
        } catch (err) {
          HandleNonFatalError('SelectionInit:NonFatal', err);
        }
      }
      $menu.data(
        'typeaheadTimer',
        setTimeout(() => {
          $menu.removeData('typeaheadBuffer');
          $menu.removeData('typeaheadTimer');
          $menu.removeData('typeaheadTime');
        }, 900)
      );

      const titles = $items
        .map((i, el) => $(el).find('.context-title').text().trim().toLowerCase())
        .get();
      const found = FindTypeaheadMatch(titles, buf, idx);
      if (found !== -1) {
        const $t = $items.eq(found);
        // found is a valid index into $items
        $t.trigger('focus')[0]!.scrollIntoView({ block: 'nearest' });
      }
      return;
    }
    if (key === 'ArrowDown') {
      ev.preventDefault();
      idx = (idx + 1 + $items.length) % $items.length;
      // idx wrapped into $items range above
      $items.eq(idx).trigger('focus')[0]!.scrollIntoView({ block: 'nearest' });
      return;
    }
    if (key === 'ArrowUp') {
      ev.preventDefault();
      idx = (idx - 1 + $items.length) % $items.length;
      $items.eq(idx).trigger('focus')[0]!.scrollIntoView({ block: 'nearest' });
      return;
    }
    if (key === 'Home') {
      ev.preventDefault();
      // $items.length !== 0 guarded above
      $items.first().trigger('focus')[0]!.scrollIntoView({ block: 'nearest' });
      return;
    }
    if (key === 'End') {
      ev.preventDefault();
      $items.last().trigger('focus')[0]!.scrollIntoView({ block: 'nearest' });
      return;
    }
    if (key === 'Enter' || key === ' ') {
      ev.preventDefault();
      // Prevent bubbling to document-level handlers (e.g., confirmation toast)
      try {
        ev.stopImmediatePropagation();
      } catch (err) {
        HandleNonFatalError('SelectionInit:NonFatal', err);
      }
      try {
        ev.stopPropagation();
      } catch (err) {
        HandleNonFatalError('SelectionInit:NonFatal', err);
      }
      if (idx >= 0) {
        const $target = $items.eq(idx);
        // Defer the click so it occurs after keydown completes
        setTimeout(() => {
          try {
            $target.trigger('click');
          } catch (err) {
            HandleNonFatalError('SelectionInit:NonFatal', err);
          }
        }, 0);
      }
      return;
    }
    if (key === 'Escape') {
      ev.preventDefault();
      $menu.hide();
      return;
    }
  });

  // Hover-to-focus: hovering should take over keyboard control
  $menu
    .off('mouseenter', 'a.SHOWTRAK_CONTEXTMENU_BUTTON')
    .on('mouseenter', 'a.SHOWTRAK_CONTEXTMENU_BUTTON', function () {
      const $a = $(this);
      if ($a.attr('aria-disabled') === 'true') return;
      const prevTimer = $menu.data('typeaheadTimer');
      if (prevTimer) {
        try {
          clearTimeout(prevTimer);
        } catch (err) {
          HandleNonFatalError('SelectionInit:NonFatal', err);
        }
      }
      $menu.removeData('typeaheadBuffer');
      $menu.removeData('typeaheadTimer');
      $menu.removeData('typeaheadTime');
      $a.trigger('focus');
    });
}

// The popover listing the clients an action won't run on. It lives on <body>
// rather than in the menu, whose overflow would clip it, so it is positioned
// against the icon and hidden whenever the menu could have closed.
const UNSUPPORTED_POPOVER_ID = 'SHOWTRAK_CONTEXT_UNSUPPORTED_POPOVER';

function ShowUnsupportedPopover(
  Anchor: HTMLElement,
  SkippedOn: NonNullable<ContextMenuOption['SkippedOn']>
) {
  let Popover = document.getElementById(UNSUPPORTED_POPOVER_ID);
  if (!Popover) {
    Popover = document.createElement('div');
    Popover.id = UNSUPPORTED_POPOVER_ID;
    Popover.setAttribute('role', 'tooltip');
    document.body.appendChild(Popover);
  }
  Popover.innerHTML =
    `<div class="context-unsupported-heading">Won't run on:</div>` +
    SkippedOn.map(
      ({ Name, Reason }) =>
        `<div class="context-unsupported-row">` +
        `<span class="context-unsupported-name">${Safe(Name)}</span>` +
        `<span class="context-unsupported-reason">${Safe(Reason)}</span>` +
        `</div>`
    ).join('');
  Popover.style.display = 'block';
  const Gap = 8;
  const Rect = Anchor.getBoundingClientRect();
  const Width = Popover.offsetWidth;
  const Height = Popover.offsetHeight;
  // To the right of the icon, or the left when that would leave the window.
  let Left = Rect.right + Gap;
  if (Left + Width > window.innerWidth - Gap) Left = Math.max(Gap, Rect.left - Gap - Width);
  const Top = Math.max(
    Gap,
    Math.min(Rect.top + Rect.height / 2 - Height / 2, window.innerHeight - Gap - Height)
  );
  Popover.style.left = `${Left}px`;
  Popover.style.top = `${Top}px`;
}

function HideUnsupportedPopover() {
  const Popover = document.getElementById(UNSUPPORTED_POPOVER_ID);
  if (Popover) Popover.style.display = 'none';
}

// Draw the rows. An action row runs on a click, or on a confirming second tap
// for touch input and the mobile layout (see RequiresTapConfirm).
function RenderContextMenuOptions(
  $menu: JQuery,
  Options: ContextMenuOption[],
  LastPointerType: () => string | null
) {
  HideUnsupportedPopover();
  $menu.html('');
  $menu.append(
    `<div class="context-menu-header">` +
      `<span class="context-menu-close" role="button" aria-label="Dismiss menu" tabindex="-1">Dismiss</span>` +
      `</div>`
  );
  $menu.append(`<div class="context-menu-options"></div>`);
  const $options = $menu.find('.context-menu-options');

  Options.forEach((option) => {
    if (option.Type === 'Divider') {
      $options.append(`<hr>`);
    }
    if (option.Type === 'Header') {
      $options.append(
        `<div class="context-section-header" role="presentation">${Safe(option.Title)}</div>`
      );
    }
    if (option.Type === 'Info') {
      $options.append(
        `<a class="SHOWTRAK_CONTEXTMENU_BUTTON dropdown-item ${Safe(
          option.Class
        )}" role="menuitem" aria-disabled="true" tabindex="-1">` +
          `<span class="context-title">${Safe(option.Title)}</span>` +
          `<span class="context-shortcut">${Safe(option.Shortcut || '')}</span>` +
          `</a>`
      );
    }
    if (option.Type === 'Action') {
      // Every action renders a fixed-width icon slot so titles line up in a
      // single column regardless of glyph width. The icon colour is applied
      // inline; when absent the slot inherits the row's text colour.
      const iconClass = option.Icon || 'bi-dot';
      const iconStyle = option.IconColour ? ` style="color:${option.IconColour}"` : '';
      const iconHtml = `<span class="context-icon"><i class="bi ${Safe(
        iconClass
      )}"${iconStyle}></i></span>`;
      // An action that will skip some of the selection carries an info icon;
      // hovering it lists the clients it won't run on.
      const unsupportedHtml = option.SkippedOn?.length
        ? `<span class="context-unsupported" aria-label="Won't run on every selected client">` +
          `<i class="bi bi-info-circle"></i></span>`
        : '';
      $options.append(
        `<a class="SHOWTRAK_CONTEXTMENU_BUTTON dropdown-item ${Safe(
          option.Class
        )}" role="menuitem" tabindex="-1">` +
          iconHtml +
          `<span class="context-title">${Safe(option.Title)}</span>` +
          `<span class="context-shortcut">${Safe(option.Shortcut || '')}</span>` +
          unsupportedHtml +
          `</a>`
      );
      const $option = $options.find('a:last');
      if (option.SkippedOn?.length) {
        const SkippedOn = option.SkippedOn;
        $option
          .find('.context-unsupported')
          .on('mouseenter', function () {
            ShowUnsupportedPopover(this, SkippedOn);
          })
          .on('mouseleave', HideUnsupportedPopover);
      }
      // Stash the original title so a pending row can be restored (e.g. when
      // another row is tapped and this one reverts out of its confirm state).
      $option.data('optionTitle', String(option.Title || ''));
      $option.on('click', function (ev) {
        // A finger/pen tap (any device, any layout) or anything in the
        // mobile layout: the first tap arms the row ("Tap to confirm"); only
        // the second tap on the same, already-armed row runs the action.
        // Mouse/trackpad clicks and keyboard Enter keep single activation.
        const native = ev.originalEvent as (MouseEvent & { pointerType?: string }) | undefined;
        const pointerType = ResolveClickPointerType(
          !!native,
          native?.pointerType,
          LastPointerType()
        );
        if (RequiresTapConfirm(IsMobileContextMenu(), pointerType)) {
          const $this = $(this);
          if (!$this.hasClass('context-confirm-pending')) {
            ev.preventDefault();
            ev.stopPropagation();
            ArmContextMenuRow($menu, $this);
            return;
          }
        }
        void RunContextMenuOption(option);
      });
    }
  });
}

// Open the menu at the event's point, kept inside the application's bounds and
// clear of the title bar (and, on mobile, of the bottom bar). See ./lib/menu-placement.
function PositionContextMenu($menu: JQuery, e: JQuery.TriggeredEvent) {
  // Calculate menu position to prevent overflow and keep it within viewport bounds
  const viewportWidth = window.innerWidth || $(window).width() || 0;
  const viewportHeight = window.innerHeight || $(window).height() || 0;
  const edgePadding = 8;
  const boundsEl =
    document.getElementById('APPLICATION_CONTAINER') ||
    document.getElementById('APPLICATION') ||
    document.documentElement;
  const boundsRect = boundsEl.getBoundingClientRect();
  const navbarEl = document.querySelector('.dragbar');
  const navbarRect = navbarEl ? navbarEl.getBoundingClientRect() : null;
  const minX = Math.max(edgePadding, Math.floor(boundsRect.left) + edgePadding);
  const containerMinY = Math.max(edgePadding, Math.floor(boundsRect.top) + edgePadding);
  const navbarMinY = navbarRect
    ? Math.min(viewportHeight - edgePadding, Math.floor(navbarRect.bottom) + edgePadding)
    : edgePadding;
  const minY = Math.max(containerMinY, navbarMinY);
  const maxX = Math.min(viewportWidth - edgePadding, Math.floor(boundsRect.right) - edgePadding);
  const isMobileMenu = IsMobileContextMenu();
  // On mobile the sheet must float above the fixed bottom bar, not overlap
  // it, so pull the usable bottom edge up by the bar's height plus a gap.
  const mobileBottomInset = isMobileMenu
    ? (() => {
        const barEl = document.getElementById('APP_BOTTOM_BAR');
        const barHeight = barEl ? barEl.getBoundingClientRect().height : 0;
        return barHeight + edgePadding;
      })()
    : 0;
  const maxY = Math.min(
    viewportHeight - edgePadding - mobileBottomInset,
    Math.floor(boundsRect.bottom) - edgePadding - mobileBottomInset
  );
  const availableHeight = Math.max(120, maxY - minY);
  // Allow the menu to use most of the available UI height while still
  // staying inside the viewport-clamped UI bounds.
  const maxMenuHeight = Math.max(220, Math.floor(availableHeight - edgePadding));

  // Measure with intended max height before final placement. Mobile uses
  // `display: flex` so the header stays pinned while .context-menu-options
  // scrolls internally; desktop uses `block`. We set this inline (rather than
  // leaning on a CSS rule) so the menu's default `display: none` holds until
  // it is actually opened; otherwise an empty menu floats on load.
  $menu.css({
    display: isMobileMenu ? 'flex' : 'block',
    visibility: 'hidden',
    left: 0,
    top: 0,
    'max-height': `${maxMenuHeight}px`,
  });

  const menuWidth = $menu.outerWidth() || 0;
  const menuHeight = Math.min($menu.outerHeight() || 0, maxMenuHeight);

  // Synthetic triggers (keyboard shortcuts in keyboard.ts, long-press on
  // touch) may carry only page coordinates; see ResolveMenuAnchor.
  const Anchor = ResolveMenuAnchor(
    e,
    {
      X: window.scrollX || window.pageXOffset || 0,
      Y: window.scrollY || window.pageYOffset || 0,
    },
    { Width: viewportWidth, Height: viewportHeight }
  );
  const { Left: left, Top: top } = PlaceMenu(
    Anchor,
    { Width: menuWidth, Height: menuHeight },
    { MinX: minX, MaxX: maxX, MinY: minY, MaxY: maxY }
  );

  if (isMobileMenu) {
    // Mobile: the menu is inset from the side edges (forced in CSS) and
    // anchored above the bottom bar so it reads as a floating sheet. Only
    // `top` needs setting here; left/right/width come from CSS. Keep the
    // inline `display: flex` set in the measurement pass so the flex layout
    // holds (and the menu's default `display: none` still governs load).
    const mobileTop = Math.max(minY, maxY - menuHeight);
    $menu.css({
      display: 'flex',
      visibility: 'visible',
      top: `${mobileTop}px`,
    });
  } else {
    $menu.css({
      display: 'block',
      visibility: 'visible',
      left: `${left}px`,
      top: `${top}px`,
    });
  }

  // A11y roles and initial focus
  $menu.attr('role', 'menu');
  const $focusable = $menu.find(
    'a.SHOWTRAK_CONTEXTMENU_BUTTON[role="menuitem"]:not([aria-disabled="true"])'
  );
  if ($focusable.length > 0) {
    setTimeout(() => {
      try {
        // $focusable.length > 0 guarded above, so first() has an element
        $focusable.first().trigger('focus')[0]!.scrollIntoView({ block: 'nearest' });
      } catch (err) {
        HandleNonFatalError('SelectionInit:NonFatal', err);
      }
    }, 0);
  }
}

export function wireContextMenu() {
  const $menu = $('#SHOWTRAK_CONTEXT_MENU');
  // Input type of the latest press, for tap-to-confirm on browsers whose
  // click events carry no pointerType. Capture phase so nothing can hide it.
  let lastPointerDownType: string | null = null;
  document.addEventListener(
    'pointerdown',
    (ev) => {
      lastPointerDownType = ev.pointerType;
    },
    { capture: true, passive: true }
  );
  const longPress = wireTouchLongPress();
  $(document).on('contextmenu', 'html', async function (e) {
    e.preventDefault();
    // A platform-fired contextmenu (originalEvent present; our synthetic
    // triggers have none) that duplicates a touch long-press we already
    // opened the menu for is dropped.
    if (e.originalEvent && longPress.OnNativeContextMenu()) return;

    const $tile = $(e.target).closest('.SHOWTRAK_PC');
    if ($tile.length) {
      const TileUUID = $tile.attr('data-uuid');
      // Client, monitoring and dummy tiles are all selectable targets; groups
      // are not. Right-clicking a not-yet-selected tile narrows the selection
      // to just that tile before the menu is built.
      // A check row held by its selected target counts as selected: the menu
      // opens on the current selection rather than narrowing it to the check.
      const IsSelectableTile = TileUUID && !$tile.hasClass('GROUP');
      const IsHeldByParent = $tile.hasClass('PARENT_SELECTED');
      if (IsSelectableTile && !IsHeldByParent && !Selected.includes(TileUUID)) {
        ClearSelection();
        Select(TileUUID);
      }
    }

    const Options = await BuildContextMenuOptions();

    RenderContextMenuOptions($menu, Options, () => lastPointerDownType);
    PositionContextMenu($menu, e);

    BindContextMenuKeyboard($menu);

    $menu.data('target', this);
    return;
  });
  $(document).on('click', function () {
    $menu.hide();
    return;
  });
  // The menu closes from several places (clicks, Escape, running an action);
  // none of them fire mouseleave on the info icon, so the popover follows here.
  document.addEventListener('pointerdown', HideUnsupportedPopover, { capture: true });
  document.addEventListener('keydown', HideUnsupportedPopover, { capture: true });
  $menu.on('scroll', HideUnsupportedPopover);
  $menu.on('click', 'a', function (e) {
    e.stopPropagation();
    $menu.hide();
    return;
  });
  $menu.on('click', '.context-menu-close', function (e) {
    e.stopPropagation();
    $menu.hide();
    return;
  });

  // Mobile "Actions" button (bottom bar): open the context menu centred in the
  // UI. It reuses the exact same handler as a right-click by triggering a
  // synthetic `contextmenu` event with client coords at the viewport centre.
  $(document).on('click', '#MOBILE_ACTIONS_BTN', function (e) {
    e.preventDefault();
    e.stopPropagation();
    const centerX = Math.floor((window.innerWidth || $(window).width() || 0) / 2);
    const centerY = Math.floor((window.innerHeight || $(window).height() || 0) / 2);
    const evt = $.Event('contextmenu');
    evt.pageX = centerX + (window.scrollX || window.pageXOffset || 0);
    evt.pageY = centerY + (window.scrollY || window.pageYOffset || 0);
    evt.clientX = centerX;
    evt.clientY = centerY;
    $('html').trigger(evt);
  });
}

// Elements where a long-press must keep its native meaning: text fields need
// the selection/paste callout, the menu itself is already open, and draggable
// tiles (edit mode) use long-press to start the drag.
const LONG_PRESS_EXCLUDED =
  'input, textarea, select, [contenteditable="true"], #SHOWTRAK_CONTEXT_MENU, [draggable="true"]';

// Touch/pen long-press opens the context menu, for iPadOS where WebKit never
// fires `contextmenu` from a touch (see lib/long-press.ts). The menu is opened
// by triggering the same synthetic `contextmenu` the Actions button and
// keyboard shortcuts use, dispatched on whatever is under the finger NOW;
// tiles re-render on live status updates, so the pointerdown target may have
// been replaced during the hold.
function wireTouchLongPress(): LongPressTracker {
  const tracker = new LongPressTracker(
    (clientX, clientY) => {
      const target = document.elementFromPoint(clientX, clientY) || document.documentElement;
      const evt = $.Event('contextmenu');
      evt.clientX = clientX;
      evt.clientY = clientY;
      evt.pageX = clientX + (window.scrollX || window.pageXOffset || 0);
      evt.pageY = clientY + (window.scrollY || window.pageYOffset || 0);
      $(target).trigger(evt);
    },
    {
      now: () => Date.now(),
      setTimeout: (fn, ms) => window.setTimeout(fn, ms),
      clearTimeout: (handle) => window.clearTimeout(handle as number),
    }
  );

  document.addEventListener(
    'pointerdown',
    (ev) => {
      const target = ev.target instanceof Element ? ev.target : null;
      if (target && target.closest(LONG_PRESS_EXCLUDED)) return;
      tracker.PointerDown(ev);
    },
    { passive: true }
  );
  document.addEventListener('pointermove', (ev) => tracker.PointerMove(ev), { passive: true });
  document.addEventListener('pointerup', (ev) => tracker.PointerUp(ev), { passive: true });
  document.addEventListener('pointercancel', () => tracker.Cancel(), { passive: true });
  document.addEventListener('dragstart', () => tracker.Cancel(), true);
  window.addEventListener('blur', () => tracker.Cancel());
  // Capture phase on window so the lift-click is stopped before the tile
  // selection toggle and the document-level "click anywhere closes the menu"
  // handler can see it.
  window.addEventListener(
    'click',
    (ev) => {
      if (!tracker.ShouldSwallowClick()) return;
      ev.preventDefault();
      ev.stopPropagation();
    },
    true
  );
  return tracker;
}
