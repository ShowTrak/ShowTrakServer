import { closeModal, openModal } from './lib/modal';
import { buildModalHeader } from './lib/modal-header';
import type {
  MonitoringSettingField,
  MonitoringCheckDebug,
  MonitoringTargetView,
  NetworkScanEvent,
  NetworkScanResult,
} from '@showtrak/protocol';
import type { MonitoringEditorCheck } from './01-state';
import {
  MonitoringEditorState,
  MonitoringMethodsCache,
  MonitoringTargets,
  NetworkDiscoveryProgress,
  NetworkDiscoveryResults,
  NetworkDiscoveryScanID,
  NetworkDiscoveryScanning,
  setMonitoringEditorState,
  setMonitoringEditorTargetID,
  setMonitoringMethodsCache,
  setNetworkDiscoveryProgress,
  setNetworkDiscoveryResults,
  setNetworkDiscoveryScanID,
  setNetworkDiscoveryScanning,
} from './01-state';
import { ErrorMessage, HandleNonFatalError, Safe } from './04-utils';
import { FormatInterval } from './07-monitoring';
import { CloseAllModals } from './11-modals';
import { ConfirmationDialog, Notify } from './14-selection-init';
// --- Monitoring Target Editor ---

/** A network-discovered device as merged/stored in the discovery results map. */
interface DiscoveredDevice {
  ID?: string;
  Name?: string;
  Address?: string;
  Hostname?: string | null;
  Source?: string;
  ServiceType?: string;
  Port?: number | null;
  MethodHint?: string;
  Services?: Array<{ type: string; port: number | null }>;
}

export async function EnsureMonitoringMethodsLoaded() {
  if (Array.isArray(MonitoringMethodsCache) && MonitoringMethodsCache.length) return;
  try {
    setMonitoringMethodsCache((await window.API.GetMonitoringMethods()) || []);
  } catch {
    setMonitoringMethodsCache([]);
  }
}

// Preferred display order for the method-picker <optgroup>s. Groups the server
// reports that aren't listed here are appended in first-seen order, so a new
// group still shows up without a client change.
// Keep in sync with GroupOrder in src/Modules/MonitoringMethods/groups.ts. Groups
// the server reports that aren't listed here are appended in first-seen order.
const METHOD_GROUP_ORDER = [
  'Show Control',
  'Lighting',
  'Sound',
  'Video',
  'Power',
  'Web Services',
  'Other',
];

// Populate the method <select> with methods grouped into <optgroup>s by their
// server-declared Group, ordered by METHOD_GROUP_ORDER. Methods keep their
// registration order within each group.
export function RenderMonitoringMethodOptions($select: JQuery) {
  const Grouped = new Map<string, typeof MonitoringMethodsCache>();
  for (const M of MonitoringMethodsCache) {
    const Group = (M as { Group?: string }).Group || 'Other';
    if (!Grouped.has(Group)) Grouped.set(Group, []);
    Grouped.get(Group)!.push(M);
  }
  const Ordered = [
    ...METHOD_GROUP_ORDER.filter((g) => Grouped.has(g)),
    ...Array.from(Grouped.keys()).filter((g) => !METHOD_GROUP_ORDER.includes(g)),
  ];
  for (const Group of Ordered) {
    const Methods = Grouped.get(Group) || [];
    const Options = Methods.map(
      (M) => `<option value="${Safe(M.ID)}">${Safe(M.Name)}</option>`
    ).join('');
    // A single ungrouped bucket ("Other") renders flat, without an optgroup.
    if (Group === 'Other' && Ordered.length === 1) {
      $select.append(Options);
    } else {
      $select.append(`<optgroup label="${Safe(Group)}">${Options}</optgroup>`);
    }
  }
}

// A small info icon carrying the field's Note. Hovering (or focusing) it reveals
// a Bootstrap popover with the hint text. Escaped before display — the Note is
// plain text, never markup. ExtraClass positions it (overlay / select variant).
function BuildMonitoringNoteIconHtml(Field: MonitoringSettingField, ExtraClass = '') {
  const Note = typeof Field.Note === 'string' ? Field.Note.trim() : '';
  if (!Note) return '';
  return `<span class="monitoring-note ${ExtraClass}" tabindex="0" role="button" aria-label="More information"
    data-bs-toggle="popover" data-bs-trigger="hover focus" data-bs-placement="left"
    data-bs-content="${Safe(Note)}"><i class="bi bi-info-circle"></i></span>`;
}

// The escaped field label, with a trailing red asterisk appended when the field
// is Required. Used inside <label> elements only (never placeholders).
function BuildMonitoringLabelHtml(Field: MonitoringSettingField) {
  const Label = Safe(Field.Label || Field.Key);
  if (!Field.Required) return Label;
  return `${Label}<span class="monitoring-required" title="Required" aria-label="required">*</span>`;
}

// Opening tag for a field wrapper. Carries the field key and, when the field is
// conditional, the sibling key/value it depends on so ApplyMonitoringConditional-
// Visibility() can show or hide it as that sibling changes.
function BuildMonitoringFieldWrapOpen(Field: MonitoringSettingField, ExtraClass: string) {
  const VW = Field.VisibleWhen;
  const VWAttrs =
    VW && VW.Key != null
      ? ` data-visible-when-key="${Safe(String(VW.Key))}" data-visible-when-value="${Safe(
          String(VW.Equals)
        )}"`
      : '';
  return `<div class="monitoring-field-wrap ${ExtraClass}" data-field-key="${Safe(
    Field.Key
  )}"${VWAttrs}>`;
}

// A single removable chip for a 'list' field. The value is retained on a data
// attribute (escaped) so CollectMonitoringCheckDynamicSettings() can read it back.
function BuildMonitoringListChipHtml(Value: string) {
  const V = String(Value == null ? '' : Value);
  return (
    `<span class="monitoring-list-chip badge bg-ghost-light text-light d-inline-flex align-items-center gap-1" data-chip-value="${Safe(
      V
    )}">` +
    `<span class="text-break">${Safe(V)}</span>` +
    '<i class="bi bi-x monitoring-list-chip-remove" role="button" aria-label="Remove"></i>' +
    '</span>'
  );
}

// Append the current text-input value to a 'list' field as a chip: validate
// against the field's item type, dedupe, then re-run conditional visibility +
// commit so the change auto-saves. Called from the Add button / Enter handlers.
function AddMonitoringListChip($list: JQuery) {
  const $input = $list.find('.monitoring-list-input');
  let value = String($input.val() ?? '').trim();
  if (!value) return;
  if ($list.attr('data-item-type') === 'number') {
    const n = Number(value);
    if (!Number.isFinite(n)) return;
    value = String(n);
  }
  const exists = $list
    .find('[data-chip-value]')
    .map((_, e) => $(e).attr('data-chip-value') || '')
    .get()
    .includes(value);
  if (!exists) $list.find('.monitoring-list-chips').append(BuildMonitoringListChipHtml(value));
  $input.val('');
  ApplyMonitoringConditionalVisibility();
  ValidateMonitoringRequiredFields();
  CommitMonitoringCheckView();
}

export function BuildMonitoringCheckFieldHtml(Field: MonitoringSettingField, Val: unknown) {
  const HasNote = typeof Field.Note === 'string' && Field.Note.trim().length > 0;
  if (Field.Type === 'boolean') {
    // The switch already sits at the row's right edge, so the note icon goes just
    // left of it rather than overlaying anything.
    const Note = BuildMonitoringNoteIconHtml(Field);
    return (
      BuildMonitoringFieldWrapOpen(
        Field,
        'form-check form-switch ps-0 d-flex align-items-center justify-content-between bg-ghost rounded p-2'
      ) +
      `<label class="form-check-label mb-0 ms-2" for="MON_DYN_${Safe(
        Field.Key
      )}">${BuildMonitoringLabelHtml(Field)}</label>
        <div class="d-flex align-items-center gap-2 me-2">
          ${Note}
          <input class="form-check-input ms-2" type="checkbox" role="switch" id="MON_DYN_${Safe(
            Field.Key
          )}" data-key="${Safe(Field.Key)}" data-type="boolean" ${Val ? 'checked' : ''} />
        </div>
      </div>`
    );
  }
  if (Field.Type === 'list') {
    // A multi-value chip/tag input. The container carries data-key/data-type so
    // CollectMonitoringCheckDynamicSettings() can read the chips as a string[].
    const Items: string[] = Array.isArray(Val)
      ? (Val as unknown[]).map((V) => String(V == null ? '' : V))
      : Val == null || Val === ''
        ? []
        : [String(Val)];
    const ItemType = Field.ItemType === 'number' ? 'number' : 'string';
    const Chips = Items.map((Item) => BuildMonitoringListChipHtml(Item)).join('');
    const NoteIcon = BuildMonitoringNoteIconHtml(Field);
    return (
      BuildMonitoringFieldWrapOpen(Field, 'monitoring-list-field') +
      `<div class="monitoring-list" data-key="${Safe(Field.Key)}" data-type="list" data-item-type="${Safe(
        ItemType
      )}">
        <div class="d-flex align-items-center justify-content-between mb-1">
          <label class="form-label mb-0 small text-muted">${BuildMonitoringLabelHtml(Field)}</label>
          ${NoteIcon}
        </div>
        <div class="monitoring-list-chips d-flex flex-wrap gap-1 mb-1">${Chips}</div>
        <div class="input-group input-group-sm monitoring-list-add">
          <input type="${ItemType === 'number' ? 'number' : 'text'}" class="form-control monitoring-list-input"
            placeholder="Add ${Safe(Field.Label || Field.Key)}…" aria-label="Add ${Safe(
              Field.Label || Field.Key
            )}" />
          <button type="button" class="btn btn-ghost text-light monitoring-list-add-btn">Add</button>
        </div>
      </div></div>`
    );
  }
  // For text/number/select the icon overlays the input's right edge (centered),
  // so it never shortens the field. On selects it sits left of the caret.
  const IsSelect = Field.Type === 'select';
  const Note = BuildMonitoringNoteIconHtml(
    Field,
    `monitoring-note--overlay${IsSelect ? ' monitoring-note--select' : ''}`
  );
  let Control: string;
  if (Field.Type === 'number') {
    Control = `
      <div class="form-floating">
        <input type="number" class="form-control" id="MON_DYN_${Safe(Field.Key)}"
          data-key="${Safe(Field.Key)}" data-type="number"${Field.Required ? ' data-required="true"' : ''}
          ${typeof Field.Min === 'number' ? `min="${Field.Min}"` : ''}
          ${typeof Field.Max === 'number' ? `max="${Field.Max}"` : ''}
          value="${Safe(String(Val))}" placeholder="${Safe(Field.Label || Field.Key)}" />
        <label for="MON_DYN_${Safe(Field.Key)}">${BuildMonitoringLabelHtml(Field)}</label>
      </div>`;
  } else if (IsSelect) {
    const Options = Array.isArray(Field.Options) ? Field.Options : [];
    const OptionsHtml = Options.map((Opt) => {
      const OptLabel = typeof Opt === 'object' ? Opt.label : String(Opt);
      const OptValue = typeof Opt === 'object' ? Opt.value : String(Opt);
      const Selected = String(OptValue) === String(Val) ? 'selected' : '';
      return `<option value="${Safe(String(OptValue))}" ${Selected}>${Safe(OptLabel)}</option>`;
    }).join('');
    Control = `
      <div class="form-floating">
        <select class="form-select" id="MON_DYN_${Safe(Field.Key)}"
          data-key="${Safe(Field.Key)}" data-type="string">
          ${OptionsHtml}
        </select>
        <label for="MON_DYN_${Safe(Field.Key)}">${BuildMonitoringLabelHtml(Field)}</label>
      </div>`;
  } else {
    Control = `
      <div class="form-floating">
        <input type="text" class="form-control" id="MON_DYN_${Safe(Field.Key)}"
          data-key="${Safe(Field.Key)}" data-type="string"${Field.Required ? ' data-required="true"' : ''}
          value="${Safe(String(Val == null ? '' : Val))}" placeholder="${Safe(
            Field.Label || Field.Key
          )}" />
        <label for="MON_DYN_${Safe(Field.Key)}">${BuildMonitoringLabelHtml(Field)}</label>
      </div>`;
  }
  return BuildMonitoringFieldWrapOpen(Field, HasNote ? 'has-note' : '') + Control + Note + '</div>';
}

// Attach a Bootstrap popover to every note icon in the settings area. Idempotent
// (getOrCreateInstance) so it is safe to call after each re-render.
export function InitMonitoringNotePopovers() {
  if (typeof bootstrap === 'undefined' || !bootstrap.Popover) return;
  $('#MONITORING_CHECK_DYNAMIC_SETTINGS, #MONITORING_CHECK_ADVANCED_SETTINGS')
    .find('.monitoring-note')
    .each(function () {
      bootstrap.Popover.getOrCreateInstance(this, {
        container: 'body',
        html: false,
        customClass: 'SHOWTRAK_MON_POPOVER',
      });
    });
}

// Read a settings field's current value from the DOM as a comparable string.
// Booleans normalise to 'true' / 'false' to match how VisibleWhen values are
// serialised into the wrapper's data attribute.
function ReadMonitoringFieldValue(Key: string): string | null {
  const $el = $(`#MON_DYN_${Key.replace(/"/g, '\\"')}`);
  if (!$el.length) {
    // 'list' fields aren't keyed by MON_DYN_ id; locate the container by data-key.
    const $list = $(`.monitoring-list[data-key="${Key.replace(/"/g, '\\"')}"]`);
    if ($list.length) {
      return $list
        .find('[data-chip-value]')
        .map((_, e) => $(e).attr('data-chip-value') || '')
        .get()
        .join(',');
    }
    return null;
  }
  if ($el.attr('data-type') === 'boolean') return $el.is(':checked') ? 'true' : 'false';
  return String($el.val());
}

// Validate a single required field: flag it invalid (red outline) only once the
// user has touched it (standard practice — never outline a pristine field) and it
// is empty. Non-required fields, and hidden conditional fields, are left alone.
export function ValidateMonitoringField(El: HTMLElement) {
  const $el = $(El);
  if ($el.attr('data-required') == null) return;
  // A conditionally-hidden field is not currently in play, so never flag it.
  if ($el.closest('.monitoring-field-wrap').hasClass('d-none')) {
    $el.removeClass('is-invalid');
    return;
  }
  const Touched = $el.hasClass('mon-touched');
  const Empty = String($el.val() ?? '').trim() === '';
  $el.toggleClass('is-invalid', Touched && Empty);
}

// Re-validate every required field currently rendered (used after a change so a
// field that gates another's visibility can settle first).
export function ValidateMonitoringRequiredFields() {
  $('#MONITORING_CHECK_DYNAMIC_SETTINGS, #MONITORING_CHECK_ADVANCED_SETTINGS')
    .find('[data-required]')
    .each(function () {
      ValidateMonitoringField(this);
    });
}

// Show/hide conditional fields based on the current value of the field each one
// depends on. Called after render and on every settings change so gated inputs
// (e.g. a threshold behind an "enable" toggle) appear and disappear live.
export function ApplyMonitoringConditionalVisibility() {
  $('#MONITORING_CHECK_DYNAMIC_SETTINGS, #MONITORING_CHECK_ADVANCED_SETTINGS')
    .find('.monitoring-field-wrap[data-visible-when-key]')
    .each(function () {
      const $wrap = $(this);
      const Key = $wrap.attr('data-visible-when-key') || '';
      const Expected = $wrap.attr('data-visible-when-value');
      const Actual = ReadMonitoringFieldValue(Key);
      $wrap.toggleClass('d-none', String(Expected) !== String(Actual));
    });
}

export function RenderMonitoringCheckDynamicSettings(
  MethodID: unknown,
  CurrentSettings: Record<string, unknown>
) {
  const Method = MonitoringMethodsCache.find((m) => m.ID === MethodID);
  const $host = $('#MONITORING_CHECK_DYNAMIC_SETTINGS');
  const $advHost = $('#MONITORING_CHECK_ADVANCED_SETTINGS');
  $host.empty();
  $advHost.empty();
  if (!Method || !Array.isArray(Method.Settings) || !Method.Settings.length) return;
  const Cur: Record<string, unknown> = CurrentSettings || {};
  for (const Field of Method.Settings) {
    const Val = Cur[Field.Key] !== undefined ? Cur[Field.Key] : Field.Default;
    const Html = BuildMonitoringCheckFieldHtml(Field, Val);
    // Fields flagged Advanced live in the collapsed "Advanced" section; the rest
    // render inline under the address.
    if (Field.Advanced) {
      $advHost.append(Html);
    } else {
      $host.append(Html);
    }
  }
  InitMonitoringNotePopovers();
  ApplyMonitoringConditionalVisibility();
}

// Show or hide the static Address and Degraded Threshold fields based on the
// selected method's declared capabilities (server-defined on each method module).
// Methods that ignore the target Address (e.g. network-wide NDI discovery) hide
// the Address input; passive presence checks with no round-trip latency hide the
// latency-based Degraded Threshold. Both default to shown for unknown methods.
export function ApplyMonitoringMethodCapabilities(MethodID: unknown) {
  const Method = MonitoringMethodsCache.find((m) => m.ID === MethodID);
  const UsesAddress = !Method || Method.UsesAddress !== false;
  const SupportsLatency = !Method || Method.SupportsLatencyThreshold !== false;
  $('#MONITORING_CHECK_ADDRESS_FIELD').toggleClass('d-none', !UsesAddress);
  $('#MONITORING_CHECK_DEGRADED_THRESHOLD_FIELD').toggleClass('d-none', !SupportsLatency);
}

// Render the "how to set this up" panel below the method picker for the selected
// check type. Content comes from the method's public Info shape (server-defined);
// every value is escaped before display. Hidden when the method has no Info.
export function RenderMonitoringCheckInfo(MethodID: unknown) {
  const $host = $('#MONITORING_CHECK_INFO');
  if (!$host.length) return;
  const Method = MonitoringMethodsCache.find((m) => m.ID === MethodID);
  const Info = Method && Method.Info;
  if (!Info || !Info.Summary) {
    $host.addClass('d-none').empty();
    return;
  }

  const Title = (Method && Method.Name) || 'About this check';
  let html =
    `<div class="monitoring-check-info-title">${Safe(Title)}</div>` +
    `<div class="text-light small mt-1">${Safe(Info.Summary)}</div>`;

  if (Array.isArray(Info.Setup) && Info.Setup.length) {
    html +=
      '<ul class="text-muted small mb-0 mt-2 ps-3 d-grid gap-1">' +
      Info.Setup.map((step) => `<li>${Safe(step)}</li>`).join('') +
      '</ul>';
  }

  // Documentation / reference links render as buttons that open in the default
  // browser (via the OpenExternalUrl IPC handler, which enforces http/https).
  if (Array.isArray(Info.Links) && Info.Links.length) {
    html +=
      '<div class="monitoring-check-info-links d-flex flex-wrap gap-2 mt-3">' +
      Info.Links.map(
        (link) =>
          `<button type="button" class="btn btn-sm btn-ghost text-light MONITORING_INFO_LINK" data-url="${Safe(
            link.Url
          )}"><i class="bi bi-box-arrow-up-right me-1"></i>${Safe(link.Label)}</button>`
      ).join('') +
      '</div>';
  }

  $host.html(html).removeClass('d-none');
}

export function CollectMonitoringCheckDynamicSettings(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  $('#MONITORING_CHECK_DYNAMIC_SETTINGS, #MONITORING_CHECK_ADVANCED_SETTINGS')
    .find('[data-key]')
    .each(function () {
      const $el = $(this);
      const key = $el.attr('data-key') || '';
      const type = $el.attr('data-type');
      if (type === 'boolean') {
        out[key] = $el.is(':checked');
      } else if (type === 'number') {
        const n = Number($el.val());
        out[key] = Number.isFinite(n) ? n : null;
      } else if (type === 'list') {
        out[key] = $el
          .find('[data-chip-value]')
          .map((_, e) => $(e).attr('data-chip-value') || '')
          .get()
          .filter((v) => v !== '');
      } else {
        out[key] = $el.val();
      }
    });
  return out;
}

export function ResolveMonitoringMethodHint(Hint: unknown) {
  const normalized = String(Hint || '')
    .trim()
    .toLowerCase();
  if (!normalized) return null;
  const preferred = [normalized];
  if (normalized === 'web') preferred.push('http', 'https');
  if (normalized === 'http' || normalized === 'https') preferred.push('http-json', 'http', 'https');
  if (normalized === 'tcp') preferred.push('tcp-port');
  for (const candidate of preferred) {
    const match = MonitoringMethodsCache.find((m) => String(m.ID).toLowerCase() === candidate);
    if (match) return match.ID;
  }
  return null;
}

export function SetNetworkDiscoveryStatus(label: string) {
  $('#NETWORK_DISCOVERY_STATUS').text(label || 'Idle');
}

export function ParseIPv4ToNumber(address: unknown) {
  const parts = String(address || '')
    .trim()
    .split('.')
    .map((part) => Number(part));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return null;
  }
  return (((parts[0]! * 256 + parts[1]!) * 256 + parts[2]!) * 256 + parts[3]!) >>> 0; // length === 4 checked above
}

export function RenderNetworkDiscoveryScanButton() {
  const $btn = $('#NETWORK_DISCOVERY_TOGGLE_SCAN');
  if (!$btn.length) return;
  $btn.prop('disabled', false);
  if (NetworkDiscoveryScanning) {
    $btn.addClass('is-scanning').text('Cancel Scan');
  } else {
    $btn.removeClass('is-scanning').text('Start Scan');
  }
}

export function SetNetworkDiscoveryProgress(percent: number, current = 0, total = 0) {
  const p = Math.max(0, Math.min(100, Number.isFinite(Number(percent)) ? Number(percent) : 0));
  const cur = Number.isFinite(Number(current)) ? Number(current) : 0;
  const tot = Number.isFinite(Number(total)) ? Number(total) : 0;
  setNetworkDiscoveryProgress({
    percent: p,
    current: cur,
    total: tot,
  });
  const $btn = $('#NETWORK_DISCOVERY_TOGGLE_SCAN');
  if ($btn.length) {
    $btn.css('--scan-progress', `${p}%`);
  }
}

export function RenderNetworkDiscoveryResults() {
  const $host = $('#NETWORK_DISCOVERY_RESULTS_BODY');
  if (!$host.length) return;
  const list = Array.from<DiscoveredDevice>(NetworkDiscoveryResults.values()).sort((a, b) => {
    const aIp = ParseIPv4ToNumber(a.Address);
    const bIp = ParseIPv4ToNumber(b.Address);
    if (aIp != null && bIp != null) return aIp - bIp;
    if (aIp != null) return -1;
    if (bIp != null) return 1;
    return String(a.Address || '').localeCompare(String(b.Address || ''));
  });

  if (!list.length) {
    $host.html(`
      <tr>
        <td colspan="5" class="text-muted text-center py-3">
          No devices discovered yet. Start a scan to search your local network.
        </td>
      </tr>
    `);
    return;
  }

  let html = '';
  for (const item of list) {
    const id = Safe(item.ID);
    const sourceKey = String(item.Source || 'unknown').toLowerCase();
    const sourceLabel =
      sourceKey === 'bonjour' ? 'mDNS' : sourceKey === 'pjlink' ? 'PJLink' : 'Scan';
    const serviceList = Array.isArray(item.Services) ? item.Services.slice(0, 5) : [];
    const details: string[] = [];
    if (item.Hostname) details.push(`host: ${Safe(item.Hostname)}`);
    if (serviceList.length) {
      details.push(`services: ${Safe(serviceList.map((s) => s.type).join(', '))}`);
    } else if (item.ServiceType) {
      details.push(`service: ${Safe(item.ServiceType)}`);
    }
    if (item.Port) details.push(`port: ${Safe(String(item.Port))}`);
    const detailsText = details.length ? details.join(' · ') : '-';
    html += `
      <tr>
        <td>
          <div class="nd-name">${Safe(item.Name || item.Address || 'Unnamed Device')}</div>
        </td>
        <td>
          <div class="nd-address">${Safe(item.Address || '')}</div>
        </td>
        <td>
          <span class="badge bg-ghost-light text-light">${Safe(sourceLabel)}</span>
        </td>
        <td>
          <div class="nd-details">${Safe(detailsText)}</div>
        </td>
        <td class="text-end">
          <button type="button" class="btn btn-light btn-sm NETWORK_DISCOVERY_ADD" data-id="${id}">
            Add
          </button>
        </td>
      </tr>`;
  }
  $host.html(html);
}

export function ResetNetworkDiscoveryState() {
  setNetworkDiscoveryScanID(null);
  setNetworkDiscoveryScanning(false);
  setNetworkDiscoveryResults(new Map());
  RenderNetworkDiscoveryScanButton();
  SetNetworkDiscoveryStatus('Idle');
  SetNetworkDiscoveryProgress(0, 0, 0);
  RenderNetworkDiscoveryResults();
}

export function MergeNetworkDiscoveryResult(result: NetworkScanResult) {
  if (!result || !result.Address) return;
  const addressKey = String(result.Address).trim().toLowerCase();
  if (!addressKey) return;
  const existing = (NetworkDiscoveryResults.get(addressKey) || {}) as DiscoveredDevice;
  const existingServices = Array.isArray(existing.Services) ? existing.Services : [];
  const nextServices = existingServices.slice();
  if (result.Source === 'bonjour') {
    const serviceType = String(result.ServiceType || '').trim();
    const servicePort = result.Port == null ? null : Number(result.Port);
    const dedupeKey = `${serviceType.toLowerCase()}:${Number.isFinite(servicePort) ? servicePort : 0}`;
    if (
      serviceType &&
      !nextServices.some(
        (s) => `${String(s.type || '').toLowerCase()}:${Number(s.port) || 0}` === dedupeKey
      )
    ) {
      nextServices.push({
        type: serviceType,
        port: Number.isFinite(servicePort) ? servicePort : null,
      });
    }
  }

  // A PJLink hint is the most specific we can offer for a projector, so never
  // let a later plain-probe/mDNS result for the same address downgrade it.
  const methodHint =
    existing.MethodHint === 'pjlink' ? 'pjlink' : result.MethodHint || existing.MethodHint;
  // Likewise keep the richer PJLink source badge once we've seen it.
  const source = existing.Source === 'pjlink' ? 'pjlink' : result.Source || existing.Source;

  NetworkDiscoveryResults.set(addressKey, {
    ...existing,
    ...result,
    Source: source,
    MethodHint: methodHint,
    Hostname: result.Hostname || existing.Hostname || null,
    Services: nextServices,
    ID: addressKey,
  });
  RenderNetworkDiscoveryResults();
}

export function HandleNetworkDiscoveryEvent(event: NetworkScanEvent) {
  if (!event || !event.ScanID) return;
  if (!NetworkDiscoveryScanID || event.ScanID !== NetworkDiscoveryScanID) return;
  if (event.Type === 'status') {
    SetNetworkDiscoveryStatus(event.Status || 'Scanning');
    if (event.Progress) {
      SetNetworkDiscoveryProgress(
        event.Progress.Percent,
        event.Progress.Current,
        event.Progress.Total
      );
    }
    return;
  }
  if (event.Type === 'result' && event.Result) {
    MergeNetworkDiscoveryResult(event.Result);
    return;
  }
  if (event.Type === 'done') {
    setNetworkDiscoveryScanning(false);
    RenderNetworkDiscoveryScanButton();
    SetNetworkDiscoveryStatus(event.Status || 'Completed');
    SetNetworkDiscoveryProgress(
      100,
      NetworkDiscoveryProgress.total,
      NetworkDiscoveryProgress.total
    );
  }
}

export async function StopNetworkDiscoveryScan() {
  if (!NetworkDiscoveryScanID) {
    setNetworkDiscoveryScanning(false);
    RenderNetworkDiscoveryScanButton();
    return;
  }
  const scanID = NetworkDiscoveryScanID;
  setNetworkDiscoveryScanID(null);
  setNetworkDiscoveryScanning(false);
  RenderNetworkDiscoveryScanButton();
  try {
    await window.API.StopNetworkDeviceScan(scanID);
  } catch (err) {
    HandleNonFatalError('MonitoringEditor:StopNetworkDiscoveryScan', err);
  }
}

export async function StartNetworkDiscoveryScan() {
  if (NetworkDiscoveryScanning) return;
  await EnsureMonitoringMethodsLoaded();
  setNetworkDiscoveryResults(new Map());
  SetNetworkDiscoveryProgress(0, 0, 0);
  RenderNetworkDiscoveryResults();
  setNetworkDiscoveryScanning(true);
  RenderNetworkDiscoveryScanButton();
  SetNetworkDiscoveryStatus('Starting...');

  try {
    const [Err, Result] = await window.API.StartNetworkDeviceScan({
      EnableBonjour: true,
      EnableProbe: true,
      EnablePJLink: true,
      TimeoutMs: 12000,
      MaxHostsPerSubnet: 512,
      ProbePorts: [80, 443, 22, 445, 3389, 8080, 4352],
    });
    if (Err) {
      setNetworkDiscoveryScanning(false);
      RenderNetworkDiscoveryScanButton();
      SetNetworkDiscoveryStatus('Failed');
      return Notify(Err, 'error');
    }
    setNetworkDiscoveryScanID(Result && Result.ScanID ? Result.ScanID : null);
    SetNetworkDiscoveryStatus('Scanning...');
  } catch (e) {
    setNetworkDiscoveryScanning(false);
    RenderNetworkDiscoveryScanButton();
    SetNetworkDiscoveryStatus('Failed');
    Notify(ErrorMessage(e, 'Failed to start scan'), 'error');
  }
}

export async function OpenNetworkDiscoveryModal() {
  await CloseAllModals();
  ResetNetworkDiscoveryState();
  $('#NETWORK_DISCOVERY_HEADER')
    .empty()
    .append(
      buildModalHeader({
        title: 'LAN Discovery',
        onClose: () => closeModal('SHOWTRAK_MODAL_NETWORK_DISCOVERY'),
      }).$el
    );
  openModal('SHOWTRAK_MODAL_NETWORK_DISCOVERY');
  await StartNetworkDiscoveryScan();
}

// --- Multi-check monitoring target editor ---------------------------------

// Locate the persisted target (if any) in the live cache so we can surface each
// check's current runtime status in the list view.
export function GetLiveMonitoringTarget() {
  const State = MonitoringEditorState;
  if (!State || State.TargetID == null) return null;
  return MonitoringTargets.find((t) => Number(t.TargetID) === Number(State.TargetID)) || null;
}

export function FindLiveMonitoringCheck(check: MonitoringEditorCheck) {
  const target = GetLiveMonitoringTarget();
  if (!target || !Array.isArray(target.Checks) || check.CheckID == null) return null;
  return target.Checks.find((c) => Number(c.CheckID) === Number(check.CheckID)) || null;
}

export function SetMonitoringSaveHint(text: string, cls: string | null) {
  const $h = $('#MONITORING_TARGET_SAVE_HINT');
  const value = String(text || '').trim();
  $h.text('');
  $h.removeClass('text-muted text-danger text-success');
  $h.addClass('d-none');

  // Monitoring editor feedback should use the global notification system, not
  // inline hints in the modal footer.
  const HintState = SetMonitoringSaveHint as unknown as { LastNotified?: string };
  if (!value) {
    HintState.LastNotified = '';
    return;
  }

  const type = cls === 'text-danger' ? 'error' : cls === 'text-success' ? 'success' : 'info';
  const signature = `${type}:${value}`;
  if (HintState.LastNotified === signature) return;
  HintState.LastNotified = signature;
  Notify(value, type);
}

export function RenderMonitoringCheckList() {
  const $host = $('#MONITORING_TARGET_CHECK_LIST');
  $host.empty();
  const checks = (MonitoringEditorState && MonitoringEditorState.Checks) || [];
  if (!checks.length) {
    $host.append(
      '<div class="bg-ghost rounded p-3 text-muted text-center" data-type="NO_CHECKS_PLACEHOLDER">No checks yet</div>'
    );
    return;
  }
  checks.forEach((check, index) => {
    const live = FindLiveMonitoringCheck(check);
    const method = String(check.Method || '').toUpperCase();
    // Fall back to the method's friendly name when no label has been set.
    const methodMeta = MonitoringMethodsCache.find((m) => m.ID === check.Method);
    const methodName = (methodMeta && methodMeta.Name) || method || 'Unnamed check';
    const name = check.Name || methodName;
    const ip = check.Address || '';
    // Badge colour conveys the live status (online / degraded / offline); checks
    // that haven't run yet keep the neutral badge.
    let badgeClass = 'bg-ghost-light text-light';
    let badgeTitle = 'Not checked yet';
    if (live) {
      if (!live.Online) {
        badgeClass = 'bg-danger text-light';
        badgeTitle = 'Offline';
      } else if (live.Degraded) {
        badgeClass = 'bg-warning text-dark';
        badgeTitle = 'Degraded';
      } else {
        badgeClass = 'bg-success text-light';
        badgeTitle = 'Online';
      }
    }
    $host.append(`
      <div class="d-flex align-items-center gap-2 bg-ghost rounded p-2 monitoring-check-row" data-index="${index}" role="button">
        <div class="flex-grow-1 text-start">
          <div class="text-light" data-type="CHECK_NAME">${Safe(name)}</div>
          ${ip ? `<small class="text-muted" data-type="CHECK_IP">${Safe(ip)}</small>` : ''}
        </div>
        <div class="d-flex align-items-center">
          <span class="badge ${badgeClass}" data-type="CHECK_METHOD" title="${Safe(badgeTitle)}">${Safe(method)}</span>
        </div>
        <i class="bi bi-chevron-right text-light MONITORING_CHECK_EDIT" data-index="${index}" role="button" aria-label="Edit Check" style="cursor: pointer;"></i>
      </div>`);
  });
}

export function ShowMonitoringListView() {
  if (!MonitoringEditorState) return;
  MonitoringEditorState.View = 'list';
  MonitoringEditorState.EditingIndex = null;
  $('#MONITORING_TARGET_CHECK_VIEW').addClass('d-none');
  $('#MONITORING_TARGET_LIST_VIEW').removeClass('d-none');
  RenderMonitoringCheckList();
}

export function CloseMonitoringCheckCollapses() {
  const IDs = ['MONITORING_CHECK_ADVANCED', 'MONITORING_CHECK_DEBUG_COLLAPSE'];
  IDs.forEach((ID) => {
    const El = document.getElementById(ID);
    if (!El) return;
    if (typeof bootstrap !== 'undefined' && bootstrap.Collapse) {
      bootstrap.Collapse.getOrCreateInstance(El, { toggle: false }).hide();
      return;
    }
    El.classList.remove('show');
  });
}

export function OpenMonitoringCheckView(index: number) {
  if (!MonitoringEditorState) return;
  const check = MonitoringEditorState.Checks[index];
  if (!check) return;
  MonitoringEditorState.EditingIndex = index;
  MonitoringEditorState.View = 'check';

  $('#MONITORING_CHECK_VIEW_TITLE').text(check.CheckID != null ? 'Edit Check' : 'New Check');
  $('#MONITORING_CHECK_NAME').val(check.Name || '');
  $('#MONITORING_CHECK_ADDRESS').val(check.Address || '');

  const $method = $('#MONITORING_CHECK_METHOD');
  $method.empty();
  RenderMonitoringMethodOptions($method);
  $method.val(check.Method || (MonitoringMethodsCache[0] && MonitoringMethodsCache[0].ID) || '');

  $('#MONITORING_CHECK_DEGRADED_THRESHOLD').val(
    Number.isFinite(Number(check.DegradedThresholdMs)) ? Number(check.DegradedThresholdMs) : 0
  );

  RenderMonitoringCheckInfo($method.val());
  ApplyMonitoringMethodCapabilities($method.val());
  RenderMonitoringCheckDynamicSettings($method.val(), check.Settings || {});

  $('#MONITORING_TARGET_LIST_VIEW').addClass('d-none');
  $('#MONITORING_TARGET_CHECK_VIEW').removeClass('d-none');
  CloseMonitoringCheckCollapses();

  // Reset then (re)load the live "last response" debug panel for this check.
  $('#MONITORING_CHECK_DEBUG_META').text('');
  $('#MONITORING_CHECK_DEBUG_BODY').html(
    '<div class="text-muted small fst-italic">Loading latest response…</div>'
  );
  LoadMonitoringCheckDebug();
  // Populate the live status card with the current known status (no re-probe).
  $('#MONITORING_CHECK_STATUS').addClass('d-none').empty();
  RefreshMonitoringCheckStatus({ run: false });
}

// Render the memory-only per-check debug payload returned by the server. The
// Html comes from the method module (which escapes any untrusted values), so it
// is safe to inject directly.
export function RenderMonitoringCheckDebug(payload: MonitoringCheckDebug | null) {
  const $body = $('#MONITORING_CHECK_DEBUG_BODY');
  const $meta = $('#MONITORING_CHECK_DEBUG_META');
  if (!$body.length) return;

  if (!payload || (payload.LastChecked == null && !payload.Html)) {
    $meta.text('');
    $body.html(
      '<div class="text-muted small fst-italic">Waiting for the first check to run…</div>'
    );
    return;
  }

  let statusText = 'Online';
  if (!payload.Online) statusText = 'Offline';
  else if (payload.Degraded) statusText = 'Degraded';

  let when = '';
  if (payload.LastChecked) {
    try {
      when = new Date(Number(payload.LastChecked)).toLocaleTimeString();
    } catch {
      when = '';
    }
  }
  $meta.text(when ? `${statusText} · ${when}` : statusText);

  if (payload.Html) {
    $body.html(payload.Html);
  } else {
    $body.html('<div class="text-muted small fst-italic">No response details available yet.</div>');
  }
}

// Fetch the latest debug snapshot for the check currently open in the editor.
export async function LoadMonitoringCheckDebug() {
  const $body = $('#MONITORING_CHECK_DEBUG_BODY');
  if (!$body.length) return;
  if (!MonitoringEditorState || MonitoringEditorState.View !== 'check') return;
  const index = MonitoringEditorState.EditingIndex;
  const check = index == null ? null : MonitoringEditorState.Checks[index];
  if (!check) return;

  if (check.CheckID == null) {
    $('#MONITORING_CHECK_DEBUG_META').text('');
    $body.html(
      '<div class="text-muted small fst-italic">Save this check to see its latest response.</div>'
    );
    return;
  }

  const requestedCheckID = check.CheckID;
  let payload = null;
  try {
    payload = await window.API.GetMonitoringCheckDebug(requestedCheckID);
  } catch (err) {
    HandleNonFatalError('MonitoringEditor:LoadMonitoringCheckDebug', err);
    return;
  }

  // The user may have navigated away or switched checks while we awaited.
  if (!MonitoringEditorState || MonitoringEditorState.View !== 'check') return;
  const curIndex = MonitoringEditorState.EditingIndex;
  const curCheck = curIndex == null ? null : MonitoringEditorState.Checks[curIndex];
  if (!curCheck || Number(curCheck.CheckID) !== Number(requestedCheckID)) return;

  RenderMonitoringCheckDebug(payload);
}

// Called from the live MonitoringTargetUpdated feed so the open check editor's
// debug panel refreshes as new probe results arrive.
export function RefreshMonitoringCheckDebugIfOpen(TargetID: number) {
  if (!MonitoringEditorState || MonitoringEditorState.View !== 'check') return;
  if (MonitoringEditorState.TargetID == null) return;
  if (Number(MonitoringEditorState.TargetID) !== Number(TargetID)) return;
  LoadMonitoringCheckDebug();
  // Reflect the fresh live status in the status card too (without re-probing).
  RefreshMonitoringCheckStatus({ run: false });
}

// --- Live status card (below the info panel) --------------------------------
// A compact card that shows the open check's current status. It re-runs the check
// on a 500ms debounce after each edit (see CommitMonitoringCheckView) IF the
// settings are valid; when they're invalid it lists which fields need fixing
// instead of running.

let MonitoringStatusRunTimer: ReturnType<typeof setTimeout> | null = null;

// Status kinds map to the client-status background tints (see 05-monitoring.css).
const MON_STATUS_KINDS = ['online', 'degraded', 'offline', 'idle'] as const;

// Schedule a debounced (500ms) live re-run of the open check's status card.
export function ScheduleMonitoringCheckStatusRun() {
  if (MonitoringStatusRunTimer) clearTimeout(MonitoringStatusRunTimer);
  MonitoringStatusRunTimer = setTimeout(() => {
    MonitoringStatusRunTimer = null;
    RefreshMonitoringCheckStatus({ run: true });
  }, 500);
}

// Paint the status card: the card's background carries the status colour
// (online / degraded / offline / idle) and the text is centred.
function SetMonitoringCheckStatusCard(TitleText: string, Kind: string, DetailHtml: string) {
  const $host = $('#MONITORING_CHECK_STATUS');
  if (!$host.length) return;
  for (const K of MON_STATUS_KINDS) $host.removeClass(`monitoring-check-status--${K}`);
  $host
    .removeClass('d-none')
    .addClass(`monitoring-check-status--${Kind}`)
    .html(
      `<div class="text-light fw-semibold">${Safe(TitleText)}</div>` +
        (DetailHtml ? `<div class="text-light small mt-1">${DetailHtml}</div>` : '')
    );
}

// Collect human-readable reasons the open check's settings are invalid (so it
// cannot be run). Empty array => settings are valid. Mirrors the server-side
// requirements: an address (for methods that use one) and every visible required
// setting must be filled.
function CollectMonitoringCheckValidationErrors(): string[] {
  const errors: string[] = [];
  const methodID = String($('#MONITORING_CHECK_METHOD').val() || '');
  const method = MonitoringMethodsCache.find((m) => m.ID === methodID);
  if (!method) {
    errors.push('Select a monitoring method.');
    return errors;
  }
  const usesAddress = method.UsesAddress !== false;
  if (usesAddress && String($('#MONITORING_CHECK_ADDRESS').val() || '').trim() === '') {
    errors.push('Address is required.');
  }
  const labelByKey = new Map<string, string>();
  for (const f of method.Settings || []) labelByKey.set(f.Key, f.Label || f.Key);
  $('#MONITORING_CHECK_DYNAMIC_SETTINGS, #MONITORING_CHECK_ADVANCED_SETTINGS')
    .find('[data-required]')
    .each(function () {
      const $el = $(this);
      // A conditionally-hidden field is not in play, so it can't be "missing".
      if ($el.closest('.monitoring-field-wrap').hasClass('d-none')) return;
      if (String($el.val() ?? '').trim() !== '') return;
      const key = $el.attr('data-key') || '';
      errors.push(`${labelByKey.get(key) || key} is required.`);
    });
  return errors;
}

function RenderMonitoringCheckStatusFromPayload(payload: MonitoringCheckDebug | null) {
  if (!payload || (payload.LastChecked == null && !payload.Html)) {
    SetMonitoringCheckStatusCard('Pending', 'idle', 'Waiting for the first check to run…');
    return;
  }
  let title = 'Online';
  let kind = 'online';
  if (!payload.Online) {
    title = 'Offline';
    kind = 'offline';
  } else if (payload.Degraded) {
    title = 'Degraded';
    kind = 'degraded';
  }
  const parts: string[] = [];
  if (payload.LastError) {
    parts.push(`<div class="text-break">${Safe(payload.LastError)}</div>`);
  } else if (payload.Online && !payload.Degraded) {
    parts.push('<div>All checks healthy.</div>');
  }
  const latency = Number(payload.LastLatencyMs);
  if (payload.LastLatencyMs != null && Number.isFinite(latency)) {
    parts.push(`<div>Latency ${Math.round(latency)} ms</div>`);
  }
  SetMonitoringCheckStatusCard(title, kind, parts.join(''));
}

// Persist the working state and wait for the save (and any chained pending save)
// to fully settle, so a subsequent run probes the just-saved configuration.
async function FlushMonitoringCheckSave() {
  if (!MonitoringEditorState) return;
  if (MonitoringEditorState.saveTimer) {
    clearTimeout(MonitoringEditorState.saveTimer);
    MonitoringEditorState.saveTimer = null;
  }
  let guard = 0;
  while (MonitoringEditorState.saving && guard++ < 100) {
    await new Promise((r) => setTimeout(r, 50));
  }
  await PerformMonitoringAutoSave();
  guard = 0;
  while ((MonitoringEditorState.saving || MonitoringEditorState.pendingSave) && guard++ < 100) {
    await new Promise((r) => setTimeout(r, 50));
  }
}

// Render the status card for the open check. With { run: true } the check is
// (re-)probed after flushing a save; otherwise the latest known response is shown.
// Invalid settings short-circuit to an "Invalid Settings" card listing the fixes.
export async function RefreshMonitoringCheckStatus(opts: { run?: boolean } = {}) {
  const $host = $('#MONITORING_CHECK_STATUS');
  if (!$host.length) return;
  if (!MonitoringEditorState || MonitoringEditorState.View !== 'check') return;
  const index = MonitoringEditorState.EditingIndex;
  const check = index == null ? null : MonitoringEditorState.Checks[index];
  if (!check) {
    $host.addClass('d-none').empty();
    return;
  }

  const errors = CollectMonitoringCheckValidationErrors();
  if (errors.length) {
    const list = errors.map((e) => `<li>${Safe(e)}</li>`).join('');
    SetMonitoringCheckStatusCard(
      'Invalid Settings',
      'offline',
      `<ul class="list-unstyled mb-0 d-grid gap-1">${list}</ul>`
    );
    return;
  }

  if (opts.run) {
    SetMonitoringCheckStatusCard('Checking…', 'idle', '');
    await FlushMonitoringCheckSave();
    if (!MonitoringEditorState || MonitoringEditorState.View !== 'check') return;
  }

  const curIndex = MonitoringEditorState.EditingIndex;
  const cur = curIndex == null ? null : MonitoringEditorState.Checks[curIndex];
  if (!cur) return;
  if (cur.CheckID == null) {
    SetMonitoringCheckStatusCard(
      'Not saved',
      'idle',
      'Give the target a name to save and run this check.'
    );
    return;
  }

  const requestedCheckID = cur.CheckID;
  let payload: MonitoringCheckDebug | null = null;
  try {
    payload = opts.run
      ? await window.API.RunMonitoringCheckNow(requestedCheckID)
      : await window.API.GetMonitoringCheckDebug(requestedCheckID);
  } catch (err) {
    HandleNonFatalError('MonitoringEditor:RefreshMonitoringCheckStatus', err);
    SetMonitoringCheckStatusCard('Error', 'offline', '');
    return;
  }

  // The user may have navigated away or switched checks while we awaited.
  if (!MonitoringEditorState || MonitoringEditorState.View !== 'check') return;
  const stillIndex = MonitoringEditorState.EditingIndex;
  const still = stillIndex == null ? null : MonitoringEditorState.Checks[stillIndex];
  if (!still || Number(still.CheckID) !== Number(requestedCheckID)) return;

  RenderMonitoringCheckStatusFromPayload(payload);
  // Keep the collapsible "Last Response" panel in sync on a fresh probe.
  if (opts.run) RenderMonitoringCheckDebug(payload);
}

// Manually run the check currently open in the editor and refresh its debug
// panel with the fresh response. Flushes any pending auto-save first so the
// server probes the check's current configuration.
export async function RunMonitoringCheckNow() {
  if (!MonitoringEditorState || MonitoringEditorState.View !== 'check') return;
  const index = MonitoringEditorState.EditingIndex;
  const check = index == null ? null : MonitoringEditorState.Checks[index];
  if (!check) return;

  // Commit + flush the debounced save so the persisted check reflects the UI.
  CommitMonitoringCheckView();
  if (MonitoringEditorState.saveTimer) {
    clearTimeout(MonitoringEditorState.saveTimer);
    MonitoringEditorState.saveTimer = null;
  }
  await PerformMonitoringAutoSave();

  const curIndex = MonitoringEditorState.EditingIndex;
  const curCheck = curIndex == null ? null : MonitoringEditorState.Checks[curIndex];
  if (!curCheck || curCheck.CheckID == null) {
    $('#MONITORING_CHECK_DEBUG_META').text('');
    $('#MONITORING_CHECK_DEBUG_BODY').html(
      '<div class="text-muted small fst-italic">Give this check a valid address to run it.</div>'
    );
    return;
  }

  const requestedCheckID = curCheck.CheckID;
  const $btn = $('#MONITORING_CHECK_RUN_NOW');
  const $icon = $btn.find('.bi');
  $btn.prop('disabled', true);
  $icon.addClass('monitoring-spin');
  $('#MONITORING_CHECK_DEBUG_BODY').html(
    '<div class="text-muted small fst-italic">Running check…</div>'
  );

  let payload = null;
  try {
    payload = await window.API.RunMonitoringCheckNow(requestedCheckID);
  } catch (err) {
    HandleNonFatalError('MonitoringEditor:RunMonitoringCheckNow', err);
  } finally {
    $btn.prop('disabled', false);
    $icon.removeClass('monitoring-spin');
  }

  // Only paint if the user is still on the same check.
  if (!MonitoringEditorState || MonitoringEditorState.View !== 'check') return;
  const stillIndex = MonitoringEditorState.EditingIndex;
  const stillCheck = stillIndex == null ? null : MonitoringEditorState.Checks[stillIndex];
  if (!stillCheck || Number(stillCheck.CheckID) !== Number(requestedCheckID)) return;
  RenderMonitoringCheckDebug(payload);
  RenderMonitoringCheckStatusFromPayload(payload);
}

// Pull the check-edit view fields back into the working state + schedule a save.
export function CommitMonitoringCheckView() {
  if (!MonitoringEditorState) return;
  const index = MonitoringEditorState.EditingIndex;
  if (index == null) return;
  const check = MonitoringEditorState.Checks[index];
  if (!check) return;
  check.Name = String($('#MONITORING_CHECK_NAME').val() || '').trim();
  check.Address = String($('#MONITORING_CHECK_ADDRESS').val() || '').trim();
  check.Method = String($('#MONITORING_CHECK_METHOD').val() || '');
  check.DegradedThresholdMs = Math.max(
    0,
    parseInt(String($('#MONITORING_CHECK_DEGRADED_THRESHOLD').val() || ''), 10) || 0
  );
  check.Settings = CollectMonitoringCheckDynamicSettings();
  ScheduleMonitoringAutoSave();
  // Every edit also debounce-refreshes the live status card (re-runs the check
  // when valid, or shows which settings are invalid).
  ScheduleMonitoringCheckStatusRun();
}

export function BuildMonitoringPayload() {
  const s = MonitoringEditorState!;
  const payload: {
    Nickname: string;
    Interval: number;
    GroupID: number | null;
    Slug?: string;
    Checks: Array<{
      Name: string;
      Address: string;
      Method: string;
      Settings: Record<string, unknown>;
      DegradedThresholdMs: number;
      CheckID?: number | null;
    }>;
  } = {
    Nickname: (s.Nickname || '').trim(),
    Interval: s.Interval,
    GroupID: s.GroupID == null ? null : s.GroupID,
    Checks: s.Checks.map((c) => {
      const out: {
        Name: string;
        Address: string;
        Method: string;
        Settings: Record<string, unknown>;
        DegradedThresholdMs: number;
        CheckID?: number | null;
      } = {
        Name: c.Name || '',
        Address: (c.Address || '').trim(),
        Method: c.Method,
        Settings: c.Settings || {},
        DegradedThresholdMs: Math.max(0, Number(c.DegradedThresholdMs) || 0),
      };
      if (c.CheckID != null) out.CheckID = c.CheckID;
      return out;
    }),
  };
  // Only send Slug when it was actually changed from the loaded value (a slug
  // never auto-changes) and is non-empty.
  const NextSlug = (s.Slug || '').trim();
  if (NextSlug && NextSlug !== (s.OriginalSlug || '')) {
    payload.Slug = NextSlug;
  }
  return payload;
}

export function MonitoringPayloadIsValid(payload: ReturnType<typeof BuildMonitoringPayload>) {
  if (!payload.Nickname) return false;
  // A target may legitimately have zero checks (it renders as degraded). Any
  // checks that do exist must be fully configured before we save. Methods that
  // don't use the Address field (e.g. network-wide NDI discovery) are exempt from
  // the address requirement.
  for (const c of payload.Checks) {
    if (!c.Method) return false;
    const method = MonitoringMethodsCache.find((m) => m.ID === c.Method);
    const usesAddress = !method || method.UsesAddress !== false;
    if (usesAddress && !c.Address) return false;
  }
  return true;
}

export function SyncAddCheckButtonState() {
  const enabled = !!(MonitoringEditorState && MonitoringEditorState.TargetID != null);
  $('#MONITORING_TARGET_ADD_CHECK').prop('disabled', !enabled);
}

export function ScheduleMonitoringAutoSave() {
  if (!MonitoringEditorState) return;
  if (MonitoringEditorState.saveTimer) clearTimeout(MonitoringEditorState.saveTimer);
  MonitoringEditorState.saveTimer = setTimeout(() => {
    PerformMonitoringAutoSave();
  }, 500);
}

export async function PerformMonitoringAutoSave() {
  if (!MonitoringEditorState) return;
  const payload = BuildMonitoringPayload();
  if (!MonitoringPayloadIsValid(payload)) {
    SetMonitoringSaveHint('Enter a name and give every check an address to save.', 'text-muted');
    return;
  }
  if (MonitoringEditorState.saving) {
    MonitoringEditorState.pendingSave = true;
    return;
  }
  MonitoringEditorState.saving = true;
  SetMonitoringSaveHint('', null);
  try {
    if (MonitoringEditorState.TargetID == null) {
      const [Err, Created] = await window.API.CreateMonitoringTarget(payload);
      if (Err || !Created) return SetMonitoringSaveHint(Err || 'Failed to save', 'text-danger');
      MonitoringEditorState.TargetID = Created.TargetID;
      setMonitoringEditorTargetID(Created.TargetID);
      if (Array.isArray(Created.Checks)) {
        Created.Checks.forEach((cr, i) => {
          if (MonitoringEditorState!.Checks[i])
            MonitoringEditorState!.Checks[i].CheckID = cr.CheckID;
        });
      }
      $('#MONITORING_TARGET_MODAL_TITLE').text('Edit Monitoring Target');
      $('#MONITORING_TARGET_DANGER_ZONE').removeClass('d-none');
      SyncAddCheckButtonState();
    } else {
      const [Err, Updated] = await window.API.UpdateMonitoringTarget(
        MonitoringEditorState.TargetID,
        payload
      );
      if (Err) return SetMonitoringSaveHint(Err, 'text-danger');
      // Reconciliation returns checks in the same order we sent them, so we can
      // map freshly-inserted CheckIDs back onto the working state by index.
      if (Updated && Array.isArray(Updated.Checks)) {
        Updated.Checks.forEach((cr, i) => {
          if (MonitoringEditorState!.Checks[i])
            MonitoringEditorState!.Checks[i].CheckID = cr.CheckID;
        });
      }
    }
    SetMonitoringSaveHint('', null);
  } catch (e) {
    SetMonitoringSaveHint(ErrorMessage(e, 'Failed to save'), 'text-danger');
  } finally {
    MonitoringEditorState.saving = false;
    if (MonitoringEditorState.pendingSave) {
      MonitoringEditorState.pendingSave = false;
      ScheduleMonitoringAutoSave();
    }
    if (MonitoringEditorState.View === 'list') RenderMonitoringCheckList();
  }
}

// Called from the live MonitoringTargetUpdated feed so the open editor's check
// list reflects fresh status without a manual refresh.
export function RefreshMonitoringEditorIfOpen(TargetID: number) {
  if (!MonitoringEditorState || MonitoringEditorState.View !== 'list') return;
  if (MonitoringEditorState.TargetID == null) return;
  if (Number(MonitoringEditorState.TargetID) !== Number(TargetID)) return;
  RenderMonitoringCheckList();
}

export async function OpenMonitoringTargetEditor(
  TargetID: number | null,
  Prefill: { Nickname?: string; Address?: string; Method?: string | null } | null = null
) {
  await CloseAllModals();
  await EnsureMonitoringMethodsLoaded();

  const DefaultMethod = MonitoringMethodsCache[0] && MonitoringMethodsCache[0].ID;

  let Existing: MonitoringTargetView | null = null;
  if (TargetID) Existing = await window.API.GetMonitoringTarget(String(TargetID));

  if (Existing) {
    setMonitoringEditorState({
      TargetID: Existing.TargetID,
      Nickname: Existing.Nickname || '',
      Interval: Number(Existing.Interval) || 30000,
      GroupID: Existing.GroupID == null ? null : Existing.GroupID,
      Slug: Existing.Slug || '',
      OriginalSlug: Existing.Slug || '',
      Checks: (Existing.Checks || []).map((c) => ({
        CheckID: c.CheckID,
        Name: c.Name || '',
        Address: c.Address || '',
        Method: c.Method || DefaultMethod || '',
        Settings: c.Settings || {},
        DegradedThresholdMs: Number(c.DegradedThresholdMs) || 0,
      })),
      View: 'list',
      EditingIndex: null,
      saveTimer: null,
      saving: false,
      pendingSave: false,
    });
  } else {
    setMonitoringEditorState({
      TargetID: null,
      Nickname: (Prefill && Prefill.Nickname) || '',
      Interval: 30000,
      GroupID: null,
      Slug: '',
      OriginalSlug: '',
      Checks: [],
      View: 'list',
      EditingIndex: null,
      saveTimer: null,
      saving: false,
      pendingSave: false,
    });
  }
  setMonitoringEditorTargetID(MonitoringEditorState!.TargetID);

  // The list view is the modal's top level (title + close). The per-check view
  // adds a Back that commits the check and returns to the list. Title elements
  // keep their ids so the text is still updated below and on autosave.
  $('#MONITORING_TARGET_HEADER')
    .empty()
    .append(
      buildModalHeader({
        title: 'Add Monitoring Target',
        titleId: 'MONITORING_TARGET_MODAL_TITLE',
        onClose: () => closeModal('SHOWTRAK_MODAL_MONITORING_TARGET'),
      }).$el
    );
  $('#MONITORING_CHECK_HEADER')
    .empty()
    .append(
      buildModalHeader({
        title: 'Edit Check',
        titleId: 'MONITORING_CHECK_VIEW_TITLE',
        onBack: () => {
          CommitMonitoringCheckView();
          ShowMonitoringListView();
        },
        onClose: () => closeModal('SHOWTRAK_MODAL_MONITORING_TARGET'),
      }).$el
    );

  $('#MONITORING_TARGET_MODAL_TITLE').text(
    Existing ? 'Edit Monitoring Target' : 'Add Monitoring Target'
  );
  $('#MONITORING_TARGET_DANGER_ZONE').toggleClass('d-none', !Existing);
  // Slug is only shown for an existing target — a new target's slug is generated
  // server-side on create, then editable on the next open.
  $('#MONITORING_TARGET_SLUG_WRAPPER').toggleClass('d-none', !Existing);
  $('#MONITORING_TARGET_SLUG').val(MonitoringEditorState!.Slug);
  $('#MONITORING_TARGET_NICKNAME').val(MonitoringEditorState!.Nickname);
  $('#MONITORING_TARGET_INTERVAL').val(MonitoringEditorState!.Interval);
  $('#MONITORING_TARGET_INTERVAL_LABEL').text(FormatInterval(MonitoringEditorState!.Interval));
  SetMonitoringSaveHint('', null);

  // Global (target-level) inputs
  $('#MONITORING_TARGET_NICKNAME')
    .off('input.mon')
    .on('input.mon', function () {
      MonitoringEditorState!.Nickname = String($(this).val() || '');
      ScheduleMonitoringAutoSave();
    });
  $('#MONITORING_TARGET_SLUG')
    .off('input.mon')
    .on('input.mon', function () {
      MonitoringEditorState!.Slug = String($(this).val() || '');
      ScheduleMonitoringAutoSave();
    });
  $('#MONITORING_TARGET_INTERVAL')
    .off('input.mon')
    .on('input.mon', function () {
      MonitoringEditorState!.Interval = parseInt(String($(this).val() || ''), 10) || 30000;
      $('#MONITORING_TARGET_INTERVAL_LABEL').text(FormatInterval(MonitoringEditorState!.Interval));
      ScheduleMonitoringAutoSave();
    });

  SyncAddCheckButtonState();

  // Add a new (blank) check and drop straight into its edit view.
  $('#MONITORING_TARGET_ADD_CHECK')
    .off('click.mon')
    .on('click.mon', function () {
      if (!MonitoringEditorState || MonitoringEditorState.TargetID == null) return;
      MonitoringEditorState.Checks.push({
        Name: '',
        Address: '',
        Method: DefaultMethod || '',
        Settings: {},
        DegradedThresholdMs: 0,
      });
      OpenMonitoringCheckView(MonitoringEditorState.Checks.length - 1);
    });

  // Check rows open the per-check edit view.
  $('#MONITORING_TARGET_CHECK_LIST')
    .off('click.mon')
    .on('click.mon', '.monitoring-check-row, .MONITORING_CHECK_EDIT', function (e) {
      e.preventDefault();
      e.stopPropagation();
      const index = parseInt($(this).attr('data-index') || '', 10);
      if (Number.isFinite(index)) OpenMonitoringCheckView(index);
    });

  // Check edit view field bindings (auto-save on change).
  $('#MONITORING_CHECK_NAME, #MONITORING_CHECK_ADDRESS, #MONITORING_CHECK_DEGRADED_THRESHOLD')
    .off('input.moncheck')
    .on('input.moncheck', function () {
      CommitMonitoringCheckView();
    });
  $('#MONITORING_CHECK_METHOD')
    .off('change.moncheck')
    .on('change.moncheck', function () {
      CloseMonitoringCheckCollapses();
      RenderMonitoringCheckInfo($(this).val());
      ApplyMonitoringMethodCapabilities($(this).val());
      RenderMonitoringCheckDynamicSettings($(this).val(), CollectMonitoringCheckDynamicSettings());
      CommitMonitoringCheckView();
    });
  $('#MONITORING_CHECK_DYNAMIC_SETTINGS, #MONITORING_CHECK_ADVANCED_SETTINGS')
    .off('input.moncheck change.moncheck focusout.moncheck')
    .on('input.moncheck change.moncheck', '[data-key]', function () {
      // Editing a field counts as touching it, so required validation can engage.
      if ($(this).attr('data-required') != null) $(this).addClass('mon-touched');
      // Re-evaluate conditional fields first so a toggle change reveals/hides its
      // dependent inputs before we snapshot the settings.
      ApplyMonitoringConditionalVisibility();
      ValidateMonitoringRequiredFields();
      CommitMonitoringCheckView();
    })
    // Leaving a required field marks it touched so tabbing past an empty required
    // input reveals the red outline, matching common form behaviour.
    .on('focusout.moncheck', '[data-required]', function () {
      $(this).addClass('mon-touched');
      ValidateMonitoringField(this);
    })
    // 'list' field chip interactions: Add button, Enter to add, click × to remove.
    .on('click.moncheck', '.monitoring-list-add-btn', function () {
      AddMonitoringListChip($(this).closest('.monitoring-list'));
    })
    .on('keydown.moncheck', '.monitoring-list-input', function (e) {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      AddMonitoringListChip($(this).closest('.monitoring-list'));
    })
    .on('click.moncheck', '.monitoring-list-chip-remove', function () {
      $(this).closest('.monitoring-list-chip').remove();
      ApplyMonitoringConditionalVisibility();
      ValidateMonitoringRequiredFields();
      CommitMonitoringCheckView();
    });

  // Info-panel documentation links open in the default browser.
  $('#MONITORING_CHECK_INFO')
    .off('click.moninfo')
    .on('click.moninfo', '.MONITORING_INFO_LINK', function () {
      const Url = $(this).attr('data-url');
      if (Url) window.API.OpenExternalUrl(Url);
    });

  $('#MONITORING_CHECK_RUN_NOW')
    .off('click.moncheck')
    .on('click.moncheck', function () {
      RunMonitoringCheckNow();
    });

  $('#MONITORING_CHECK_DELETE')
    .off('click.moncheck')
    .on('click.moncheck', function () {
      const index = MonitoringEditorState!.EditingIndex;
      if (index == null) return;
      MonitoringEditorState!.Checks.splice(index, 1);
      ShowMonitoringListView();
      ScheduleMonitoringAutoSave();
    });

  $('#MONITORING_TARGET_DELETE')
    .off('click.mon')
    .on('click.mon', async () => {
      if (MonitoringEditorState!.TargetID == null) return;
      const Confirmation = await ConfirmationDialog(
        'Delete this monitoring target? This cannot be undone.'
      );
      if (!Confirmation) return;
      const [Err] = await window.API.DeleteMonitoringTarget(MonitoringEditorState!.TargetID);
      if (Err) return Notify(Err, 'error');
      await Notify('Monitoring target deleted', 'success');
      await CloseAllModals();
    });

  ShowMonitoringListView();
  openModal('SHOWTRAK_MODAL_MONITORING_TARGET');

  // Prefilled discovery adds already have a name+address, so try an initial save.
  ScheduleMonitoringAutoSave();
}
