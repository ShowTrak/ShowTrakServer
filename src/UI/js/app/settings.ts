import {
  AlertActionsEnabled,
  Capabilities,
  CompactMode,
  SettingDebounceTimers,
  Settings,
  SettingsGroups,
  setSettings,
  setSettingsGroups,
} from './state';
import {
  InitMobileView,
  LoadCompactModePreference,
  RenderAlertActionsToggle,
  RenderMode,
  SetAlertActionsEnabled,
  SetCompactMode,
} from './mode';
import { GetAlertVolume, HandleNonFatalError, Safe, ShowQRModal } from './utils';
import { Notify } from './selection-init';
import type { SettingGroupView, SettingView } from '@showtrak/protocol';
// Wires the mode/compact/alert-action buttons and fetches initial settings +
// mode state. Formerly a DOMContentLoaded handler; InitSettings() calls it
// directly (fire-and-forget) once the bootstrap orchestrator runs — the DOM is
// already parsed at that point on both surfaces.
async function WireSettingsControls() {
  // Wire new button group
  const btnShow = document.getElementById('MODE_BTN_SHOW');
  const btnEdit = document.getElementById('MODE_BTN_EDIT');
  const btnAlertActions = document.getElementById('ALERT_ACTIONS_TOGGLE_BTN');
  const btnCompact = document.getElementById('COMPACT_MODE_BTN');

  SetCompactMode(LoadCompactModePreference(), { persist: false });
  // Lock to the compact mobile layout when the viewport is narrow, and keep it
  // in sync as the viewport / orientation changes.
  InitMobileView();

  try {
    const initialSettings = await window.API.GetSettings();
    if (Array.isArray(initialSettings)) {
      setSettings(initialSettings);
    }
  } catch (err) {
    HandleNonFatalError('Settings:InitSettings', err);
  }

  if (btnShow && !btnShow.dataset.bound) {
    btnShow.addEventListener('click', async () => {
      if (!Capabilities.showModeToggle) return;
      await window.API.SetMode('SHOW');
    });
    btnShow.dataset.bound = '1';
  }
  if (btnEdit && !btnEdit.dataset.bound) {
    btnEdit.addEventListener('click', async () => {
      if (!Capabilities.showModeToggle) return;
      await window.API.SetMode('EDIT');
    });
    btnEdit.dataset.bound = '1';
  }
  if (btnAlertActions && !btnAlertActions.dataset.bound) {
    btnAlertActions.addEventListener('click', async () => {
      if (!Capabilities.canToggleAlertActions) return;
      await SetAlertActionsEnabled(!AlertActionsEnabled);
    });
    btnAlertActions.dataset.bound = '1';
  }
  if (btnCompact && !btnCompact.dataset.bound) {
    btnCompact.addEventListener('click', () => {
      SetCompactMode(!CompactMode);
    });
    btnCompact.dataset.bound = '1';
  }
  // Initialize with backend mode
  try {
    const mode = await window.API.GetMode();
    RenderMode(mode);
  } catch (err) {
    HandleNonFatalError('Settings:InitMode', err);
  }
  try {
    const isEnabled = await window.API.GetAlertActionsEnabled();
    RenderAlertActionsToggle(isEnabled);
  } catch (err) {
    HandleNonFatalError('Settings:InitAlertActionsEnabled', err);
    RenderAlertActionsToggle(true);
  }
}

export async function GetSettingValue(Key: string) {
  // Refetch when empty, and tolerate a shim/RPC that returns null or a
  // malformed payload (which previously threw and, since the context menu opens
  // via `await GetSettingValue(...)`, silently aborted the menu).
  if (!Array.isArray(Settings) || Settings.length == 0) {
    const Fetched = await window.API.GetSettings();
    setSettings(Array.isArray(Fetched) ? Fetched : []);
  }
  if (!Array.isArray(Settings)) return null;
  const Setting = Settings.find((s) => s && s.Key === Key);
  if (!Setting) return null;
  return Setting.Value;
}

export const Sounds: Record<string, Howl> = {
  Notification: new Howl({
    src: ['audio/alert_1.wav'],
    volume: 0.5,
  }),
  Alert: new Howl({
    src: ['audio/alert_2.wav'],
    volume: 0.5,
  }),
  Warning: new Howl({
    src: ['audio/alert_3.wav'],
    volume: 0.5,
  }),
};

// Called by the bootstrap orchestrator in main.ts — never at import time.
export function InitSettings() {
  void WireSettingsControls();
  window.API.PlaySound(async (SoundName) => {
    const sound = Sounds[SoundName] || Sounds.Notification!; // Notification always present in Sounds
    sound.volume(GetAlertVolume());
    sound.play();
  });
  InitSettingsPush();
  // Keep the Remote Access address list current when the host gains or loses a
  // network interface (VLAN NIC up/down, adapter plugged in, VPN, …).
  window.API.OnNetworkInterfacesChanged(() => {
    void RenderRemoteAccessSection();
  });
}

export function PreviewSound(SoundName: string) {
  const sound = Sounds[SoundName] || Sounds.Notification!; // Notification always present in Sounds
  sound.volume(GetAlertVolume());
  sound.play();
}
// Registers the settings push handler (settings modal + remote-access section
// re-render). Kept as a separate registrar so InitSettings can live above
// PreviewSound; body unchanged from the former import-time subscription.
function InitSettingsPush() {
  window.API.UpdateSettings(async (NewSettings, NewSettingsGroups) => {
    const Incoming = Array.isArray(NewSettings) ? NewSettings : [];
    const IncomingGroups = Array.isArray(NewSettingsGroups) ? NewSettingsGroups : [];
    // Every SetSetting round-trips back here as a push. Rebuilding the panel on
    // each one would collapse #SETTINGS_CONTENT to zero height, resetting its
    // scroll to the top and dropping keyboard focus mid-edit — so when only
    // values changed, keep the existing controls and just sync them.
    const Structure = ComputeSettingsStructure(Incoming, IncomingGroups);
    const CanReuse = Structure === RenderedStructure && $('#SETTINGS').children().length > 0;
    const RestoreViewState = CaptureSettingsViewState();

    setSettings(NewSettings);
    setSettingsGroups(NewSettingsGroups);

    if (CanReuse) SyncRenderedSettingValues(Incoming);
    else RenderSettingsSections(Structure);

    // Re-render after settings arrive so layout-dependent controls like the group
    // column count pick up UI_GROUP_COLUMN_COUNT on the browser surface.
    try {
      const { RenderFullClientAndMonitorList } = await import('./client-list');
      RenderFullClientAndMonitorList();
    } catch (err) {
      HandleNonFatalError('Settings:RefreshAfterUpdate', err);
    }

    // Keep the gated + menu entry in step with its setting. Imported lazily
    // because that module reads back through GetSettingValue below, and a static
    // import either way would make the two modules circular.
    try {
      const { RefreshUnassignedClientMenuVisibility } = await import('./unassigned-clients');
      await RefreshUnassignedClientMenuVisibility();
    } catch (err) {
      HandleNonFatalError('Settings:RefreshUnassignedClientMenu', err);
    }

    // Remote Access section: enumerate Web UI addresses and render list with QR.
    await RenderRemoteAccessSection();

    RestoreViewState();
  });
}

// Signature of everything about the settings list that affects the markup —
// i.e. everything except the values. Two pushes with the same signature can
// share one rendered DOM.
function ComputeSettingsStructure(
  SettingsList: SettingView[],
  GroupsList: SettingGroupView[]
): string {
  return JSON.stringify([
    GroupsList.map((g) => [g?.Name, g?.Title]),
    SettingsList.map((s) => [
      s?.Group,
      s?.Key,
      s?.Title,
      s?.Description,
      s?.Type,
      s?.Min,
      s?.Max,
      s?.Unit,
      s?.Options,
    ]),
  ]);
}

// Structure signature of the controls currently in #SETTINGS, and the setting
// objects their change handlers closed over (keyed by Key). The handlers compare
// against `Setting.Value` as their last-known baseline, so a value-only sync has
// to update these objects as well as the DOM.
let RenderedStructure: string | null = null;
const RenderedSettings = new Map<string, SettingView>();

// Push new values into the already-rendered controls. Anything the user is
// currently editing is left alone: the focused control, and any control with a
// debounced save still pending (its value is already optimistically applied).
function SyncRenderedSettingValues(SettingsList: SettingView[]) {
  const activeId = document.activeElement ? document.activeElement.id : '';
  for (const Incoming of SettingsList) {
    if (!Incoming || typeof Incoming.Key !== 'string') continue;
    const Rendered = RenderedSettings.get(Incoming.Key);
    if (!Rendered) continue;
    const Previous = Rendered.Value;
    Rendered.Value = Incoming.Value;
    if (Previous === Incoming.Value) continue;
    const elementId = `SETTING_${Incoming.Key}`;
    if (activeId === elementId) continue;
    if (SettingDebounceTimers.has(Incoming.Key)) continue;
    const $el = $(`#${elementId}`);
    if (!$el.length) continue;
    if (Incoming.Type === 'BOOLEAN') {
      $el.prop('checked', !!Incoming.Value);
    } else {
      $el.val(String(Incoming.Value ?? ''));
      if (Incoming.Type === 'SLIDER') {
        const unit = Incoming.Unit ? Safe(Incoming.Unit) : '';
        $(`#${elementId}_VALUE`).text(`${Incoming.Value}${unit}`);
      }
    }
  }
}

// Capture scroll position and keyboard focus/caret inside the settings modal,
// returning a restore function to call once the DOM work is done. Emptying a
// scroll container clamps its scrollTop to 0, so even a full rebuild keeps the
// user where they were.
function CaptureSettingsViewState(): () => void {
  const contentEl = document.getElementById('SETTINGS_CONTENT');
  if (!contentEl) return () => {};
  const scrollTop = contentEl.scrollTop;
  const active = document.activeElement;
  const focusedId =
    active instanceof HTMLElement && active.id && contentEl.contains(active) ? active.id : '';
  let selectionStart: number | null = null;
  let selectionEnd: number | null = null;
  if (active instanceof HTMLInputElement) {
    // Throws on input types that have no text selection (number, range, …).
    try {
      selectionStart = active.selectionStart;
      selectionEnd = active.selectionEnd;
    } catch {
      /* not a text-selectable input */
    }
  }

  return () => {
    if (contentEl.scrollTop !== scrollTop) {
      contentEl.scrollTop = scrollTop;
      // The nav rebuild in BuildSettingsNav measured the clamped position.
      UpdateActiveNavFromScroll();
    }
    if (!focusedId) return;
    const el = document.getElementById(focusedId);
    if (!el || document.activeElement === el) return;
    el.focus();
    if (el instanceof HTMLInputElement && selectionStart !== null && selectionEnd !== null) {
      try {
        el.setSelectionRange(selectionStart, selectionEnd);
      } catch {
        /* not a text-selectable input */
      }
    }
  };
}

// Build every settings section from scratch and bind its controls.
function RenderSettingsSections(Structure: string) {
  $('#SETTINGS').html('');
  RenderedSettings.clear();
  RenderedStructure = Structure;

  for (const Group of SettingsGroups) {
    const GroupSettings = Settings.filter((s) => s.Group == Group.Name);
    if (!GroupSettings.length) continue;
    const $target = $(
      `<div class="settings-section d-grid gap-2" id="SETTINGS_SECTION_${Group.Name}" data-nav-key="${Group.Name}" data-nav-title="${Safe(
        Group.Title
      )}"></div>`
    );
    $target.append(`<div class="bg-ghost-light p-2 rounded">
			<strong class="text-start">
				${Group.Title}
			</strong>
		</div>`);
    $(`#SETTINGS`).append($target);
    for (const Setting of GroupSettings) {
      // The control handlers below close over this object; SyncRenderedSettingValues
      // keeps it current so their "did the value actually change" guards hold.
      RenderedSettings.set(Setting.Key, Setting);
      if (Setting.Type === 'BOOLEAN') {
        $target.append(`<div class="bg-ghost p-2 rounded d-flex justify-content-between text-start">
					<div class="d-grid">
						<span>${Setting.Title}</span>
						<span class="text-sm mb-0">${Setting.Description}</span>
					</div>
					<div class="form-check form-switch">
						<input class="form-check-input" style="margin-top: 0.6em !important;" type="checkbox" id="SETTING_${Setting.Key}" ${
              Setting.Value ? 'checked' : ''
            }>
					</div>
				</div>`);
        $(`#SETTING_${Setting.Key}`)
          .off('change')
          .on('change', async function () {
            const NewValue = $(this).is(':checked');
            if (NewValue === Setting.Value) return;
            const Set = Settings.find((s) => s.Key === Setting.Key);
            if (Set) Set.Value = NewValue;
            Setting.Value = NewValue;
            await window.API.SetSetting(Setting.Key, NewValue);
            Notify(
              `[${Setting.Title}] ${NewValue ? 'Enabled' : 'Disabled'}`,
              NewValue ? 'success' : 'error'
            );
          });
      } else if (Setting.Type === 'STRING' || Setting.Type === 'PASSWORD') {
        const isWebUiPassword = Setting.Key === 'WEBUI_PASSWORD';
        // PASSWORD only changes how the field is rendered — it is a plain string
        // everywhere else, so it shares the whole STRING code path below.
        const isMasked = Setting.Type === 'PASSWORD';
        const inputType = isMasked ? 'password' : 'text';
        const inputMode = isWebUiPassword ? 'numeric' : 'text';
        const inputPattern = isWebUiPassword
          ? 'pattern="[0-9]{4}" maxlength="4"'
          : isMasked
            ? 'autocomplete="off" spellcheck="false"'
            : '';
        const inputPlaceholder = isWebUiPassword
          ? '4 digit code'
          : isMasked
            ? 'Paste token...'
            : 'Enter text...';
        const initialValue = isWebUiPassword
          ? String(Setting.Value == null ? '' : Setting.Value)
              .replace(/\D/g, '')
              .slice(0, 4)
          : Safe(Setting.Value);

        $target.append(`<div class="bg-ghost p-2 rounded d-grid gap-1 text-start">
					<div class="d-grid">
						<span>${Setting.Title}</span>
						<span class="text-sm mb-0">${Setting.Description}</span>
					</div>
					<input type="${inputType}" inputmode="${inputMode}" class="form-control form-control-sm bg-ghost-light text-light border-0" id="SETTING_${
            Setting.Key
          }" value="${initialValue}" placeholder="${inputPlaceholder}" ${inputPattern} />
					<div class="invalid-feedback" id="SETTING_${Setting.Key}_ERROR">Must be exactly 4 digits (0-9).</div>
				</div>`);

        const inputEl = $(`#SETTING_${Setting.Key}`);
        const errorEl = $(`#SETTING_${Setting.Key}_ERROR`);

        const applyWebUiPasswordValidation = (value: string | number | string[] | undefined) => {
          if (!isWebUiPassword) return { normalized: value, valid: true, saveable: true };
          const normalized = String(value == null ? '' : value)
            .replace(/\D/g, '')
            .slice(0, 4);
          const isEmpty = normalized.length === 0;
          const isValid = isEmpty || /^\d{4}$/.test(normalized);
          return { normalized, valid: isValid, saveable: isEmpty || normalized.length === 4 };
        };

        const initialValidation = applyWebUiPasswordValidation(inputEl.val());
        if (isWebUiPassword) {
          inputEl.val(initialValidation.normalized ?? '');
          inputEl.toggleClass('is-invalid', !initialValidation.valid);
          errorEl.toggle(!initialValidation.valid);
        } else {
          errorEl.hide();
        }

        inputEl.off('input').on('input', function () {
          const el = $(this);
          let NewValue = el.val();
          const validation = applyWebUiPasswordValidation(NewValue);

          if (isWebUiPassword) {
            if (validation.normalized !== NewValue) {
              el.val(validation.normalized ?? '');
            }
            NewValue = validation.normalized;
            el.toggleClass('is-invalid', !validation.valid);
            errorEl.toggle(!validation.valid);
          }

          if (SettingDebounceTimers.has(Setting.Key))
            clearTimeout(SettingDebounceTimers.get(Setting.Key));
          SettingDebounceTimers.set(
            Setting.Key,
            setTimeout(async () => {
              // Clear the pending marker first: SyncRenderedSettingValues treats
              // a live timer as "the user is mid-edit, leave this field alone".
              SettingDebounceTimers.delete(Setting.Key);
              if (isWebUiPassword && !validation.saveable) return;
              if (NewValue === Setting.Value) return;
              const Set = Settings.find((s) => s.Key === Setting.Key);
              const SettingValue = String(NewValue ?? '');
              if (Set) Set.Value = SettingValue;
              Setting.Value = SettingValue;
              const [Err] = await window.API.SetSetting(Setting.Key, NewValue);
              if (Err) {
                if (isWebUiPassword) {
                  el.addClass('is-invalid');
                  errorEl.text('Must be exactly 4 digits (0-9).').show();
                }
                Notify(`[${Setting.Title}] ${Err}`, 'error', 2200);
                return;
              }
              Notify(`[${Setting.Title}] Saved`, 'success', 1200);
            }, 600)
          );
        });
      } else if (Setting.Type === 'INTEGER') {
        const hasMin = typeof Setting.Min === 'number';
        const hasMax = typeof Setting.Max === 'number';
        const minAttr = hasMin ? `min="${Setting.Min}"` : '';
        const maxAttr = hasMax ? `max="${Setting.Max}"` : '';
        const rangeHint =
          hasMin && hasMax
            ? ` <span class="text-sm text-muted">(${Setting.Min}–${Setting.Max})</span>`
            : '';
        $target.append(`<div class="bg-ghost p-2 rounded d-grid gap-1 text-start">
					<div class="d-grid">
						<span>${Setting.Title}${rangeHint}</span>
						<span class="text-sm mb-0">${Setting.Description}</span>
					</div>
					<input type="number" class="form-control form-control-sm bg-ghost-light text-light border-0" id="SETTING_${
            Setting.Key
          }" value="${Safe(Setting.Value)}" step="1" ${minAttr} ${maxAttr} />
				</div>`);
        $(`#SETTING_${Setting.Key}`)
          .off('input')
          .on('input', function () {
            const el = $(this);
            const Raw = el.val();
            if (SettingDebounceTimers.has(Setting.Key))
              clearTimeout(SettingDebounceTimers.get(Setting.Key));
            SettingDebounceTimers.set(
              Setting.Key,
              setTimeout(async () => {
                SettingDebounceTimers.delete(Setting.Key);
                let NewValue = parseInt(String(Raw), 10);
                if (isNaN(NewValue)) NewValue = Number(Setting.Value); // keep previous until valid
                if (hasMin && NewValue < Setting.Min!) NewValue = Setting.Min!;
                if (hasMax && NewValue > Setting.Max!) NewValue = Setting.Max!;
                if (NewValue === Setting.Value) return;
                const Set = Settings.find((s) => s.Key === Setting.Key);
                if (Set) Set.Value = NewValue;
                Setting.Value = NewValue;
                await window.API.SetSetting(Setting.Key, NewValue);
                Notify(`[${Setting.Title}] Saved (${NewValue})`, 'success', 1200);
              }, 600)
            );
          });
      } else if (Setting.Type === 'SLIDER') {
        const min = typeof Setting.Min === 'number' ? Setting.Min : 0;
        const max = typeof Setting.Max === 'number' ? Setting.Max : 100;
        const unit = Setting.Unit ? Safe(Setting.Unit) : '';
        $target.append(`<div class="bg-ghost p-2 rounded d-grid gap-1 text-start">
					<div class="d-flex justify-content-between align-items-center">
						<span>${Setting.Title}</span>
						<span class="text-sm text-muted" id="SETTING_${Setting.Key}_VALUE">${Safe(Setting.Value)}${unit}</span>
					</div>
					<span class="text-sm mb-0">${Setting.Description}</span>
					<input type="range" class="form-range" id="SETTING_${
            Setting.Key
          }" min="${min}" max="${max}" step="1" value="${Safe(Setting.Value)}" />
				</div>`);
        $(`#SETTING_${Setting.Key}`)
          .off('input')
          .on('input', function () {
            const el = $(this);
            let NewValue = parseInt(String(el.val()), 10);
            if (isNaN(NewValue)) NewValue = Number(Setting.Value);
            if (NewValue < min) NewValue = min;
            if (NewValue > max) NewValue = max;
            // Update the readout immediately; persistence is debounced so we
            // don't hammer the DB while the user drags the handle.
            $(`#SETTING_${Setting.Key}_VALUE`).text(`${NewValue}${unit}`);
            if (SettingDebounceTimers.has(Setting.Key))
              clearTimeout(SettingDebounceTimers.get(Setting.Key));
            SettingDebounceTimers.set(
              Setting.Key,
              setTimeout(async () => {
                SettingDebounceTimers.delete(Setting.Key);
                if (NewValue === Setting.Value) return;
                const Set = Settings.find((s) => s.Key === Setting.Key);
                if (Set) Set.Value = NewValue;
                Setting.Value = NewValue;
                await window.API.SetSetting(Setting.Key, NewValue);
                Notify(`[${Setting.Title}] Saved (${NewValue}${unit})`, 'success', 1200);
              }, 400)
            );
          });
      } else if (Setting.Type === 'OPTION') {
        let optionsHtml = '';
        if (Array.isArray(Setting.Options)) {
          for (const opt of Setting.Options) {
            optionsHtml += `<option value="${Safe(opt)}" ${Setting.Value === opt ? 'selected' : ''}>${Safe(
              opt
            )}</option>`;
          }
        }
        $target.append(`<div class="bg-ghost p-2 rounded d-grid gap-1 text-start">
					<div class="d-grid">
						<span>${Setting.Title}</span>
						<span class="text-sm mb-0">${Setting.Description}</span>
					</div>
					<select class="form-select form-select-sm bg-ghost-light text-light border-0" id="SETTING_${Setting.Key}">${optionsHtml}</select>
				</div>`);
        $(`#SETTING_${Setting.Key}`)
          .off('change')
          .on('change', async function () {
            const NewValue = $(this).val();
            if (NewValue === Setting.Value) return;
            const Set = Settings.find((s) => s.Key === Setting.Key);
            const SettingValue = String(NewValue ?? '');
            if (Set) Set.Value = SettingValue;
            Setting.Value = SettingValue;
            await window.API.SetSetting(Setting.Key, NewValue);
            Notify(`[${Setting.Title}] ${NewValue}`, 'success', 1200);
          });
      }
    }
  }
}

// Address list currently rendered into #REMOTE_ACCESS_SECTION.
let RenderedRemoteAccess: string | null = null;

// Render (or re-render) the Remote Access address list. Extracted so it can be
// refreshed on its own when the host's network interfaces change, without
// re-running the whole settings render.
async function RenderRemoteAccessSection() {
  try {
    const info = await window.API.GetWebUIAddresses();
    const urls = (info && info.urls) || [];
    const $container = $('#REMOTE_ACCESS_SECTION');
    // This runs after every settings push; leave the DOM alone when the address
    // list is unchanged so a setting edit doesn't churn the section (and the nav
    // that is rebuilt from it) underneath the user.
    const Signature = JSON.stringify(urls.map((u) => [u?.url, u?.host]));
    if (Signature === RenderedRemoteAccess) {
      BuildSettingsNav();
      return;
    }
    RenderedRemoteAccess = Signature;
    $container.html('');
    if (urls.length) {
      // Expose this block as a jump target so it appears in the category nav.
      $container
        .addClass('settings-section')
        .attr('data-nav-key', '__REMOTE_ACCESS__')
        .attr('data-nav-title', 'Remote Access');
      $container.append(`
        <div class="bg-ghost-light p-2 rounded text-start">
          <strong>Remote Access</strong>
          <div class="text-sm text-muted">Connect from your phone on the same network.</div>
        </div>
      `);
      const rows = urls
        .map((u) => {
          const safe = Safe(u.url);
          return `
            <div class="bg-ghost p-2 rounded d-flex justify-content-between align-items-center text-start">
              <div class="d-grid">
                <span>${safe}</span>
                <span class="text-sm text-muted">${Safe(u.host)}</span>
              </div>
              <button type="button" class="btn btn-sm bg-ghost-light text-white flex-shrink-0 ms-2" data-qr-url="${safe}" title="Show QR code" aria-label="Show QR code for ${safe}">
                <i class="bi bi-qr-code"></i>
              </button>
            </div>`;
        })
        .join('');
      $container.append(rows);
      // Bind QR buttons
      $container
        .find('[data-qr-url]')
        .off('click')
        .on('click', function () {
          const url = $(this).attr('data-qr-url');
          ShowQRModal(url);
        });
    } else {
      // No addresses to show — drop the nav metadata so it is left out of the
      // category list on rebuild.
      $container
        .removeClass('settings-section')
        .removeAttr('data-nav-key')
        .removeAttr('data-nav-title');
    }
  } catch (err) {
    HandleNonFatalError('Settings:RenderRemoteAccessSection', err);
  }
  // Rebuild the left-hand category nav now that the section set is final. Runs
  // for both the full settings render and standalone network-interface refreshes.
  BuildSettingsNav();
}

// (Re)build the left-hand category rail from the sections currently in the
// content column, then wire up the scroll-spy that highlights the section the
// user is scrolled to. Each section carries `data-nav-key` / `data-nav-title`.
function BuildSettingsNav() {
  const $content = $('#SETTINGS_CONTENT');
  const $nav = $('#SETTINGS_NAV');
  if (!$nav.length || !$content.length) return;

  const sections = $content.find('.settings-section[data-nav-title]').toArray();
  $nav.empty();

  // A single (or no) category needs no navigation — reclaim the space.
  if (sections.length <= 1) {
    $nav.hide();
    return;
  }
  $nav.show();

  for (const section of sections) {
    const key = section.getAttribute('data-nav-key') || '';
    const title = section.getAttribute('data-nav-title') || '';
    const $btn = $(
      `<button type="button" class="settings-nav-item" data-nav-target="${Safe(key)}">${Safe(title)}</button>`
    );
    $btn.on('click', () => {
      section.scrollIntoView({ block: 'start', behavior: 'smooth' });
      SetActiveNav(key);
    });
    $nav.append($btn);
  }

  // Default the first category active until a real scroll position is known.
  SetActiveNav(sections[0]!.getAttribute('data-nav-key') || ''); // length > 1 guaranteed above

  // Namespaced so repeated rebuilds replace rather than stack the handlers. The
  // shown-handler recomputes once the modal is visible: while it is hidden the
  // content has no height and scroll positions cannot be measured.
  $content.off('scroll.settingsspy').on('scroll.settingsspy', UpdateActiveNavFromScroll);
  $('#SHOWTRAK_MODAL_SETTINGS')
    .off('shown.bs.modal.settingsspy')
    .on('shown.bs.modal.settingsspy', UpdateActiveNavFromScroll);
  UpdateActiveNavFromScroll();
}

function SetActiveNav(key: string) {
  $('#SETTINGS_NAV .settings-nav-item').each(function () {
    $(this).toggleClass('active', this.getAttribute('data-nav-target') === key);
  });
}

// Highlight the nav item for the last section whose heading has scrolled to (or
// past) the top of the content viewport. Positions are measured relative to the
// scroll container so it works regardless of the section's offset parent.
function UpdateActiveNavFromScroll() {
  const contentEl = document.getElementById('SETTINGS_CONTENT');
  if (!contentEl || !contentEl.clientHeight) return; // hidden: nothing measurable yet
  const sections = Array.from(
    contentEl.querySelectorAll<HTMLElement>('.settings-section[data-nav-title]')
  );
  if (!sections.length) return;

  const contentTop = contentEl.getBoundingClientRect().top;
  const threshold = 24; // px past the top edge before a section becomes active
  let activeKey = sections[0]!.getAttribute('data-nav-key') || ''; // sections.length checked above
  for (const section of sections) {
    const relativeTop = section.getBoundingClientRect().top - contentTop;
    if (relativeTop <= threshold) {
      activeKey = section.getAttribute('data-nav-key') || '';
    } else {
      break;
    }
  }

  // At the very bottom, force the last section active — a short final section
  // may never reach the threshold on its own.
  if (contentEl.scrollTop + contentEl.clientHeight >= contentEl.scrollHeight - 2) {
    activeKey = sections[sections.length - 1]!.getAttribute('data-nav-key') || ''; // non-empty checked above
  }

  SetActiveNav(activeKey);
}
