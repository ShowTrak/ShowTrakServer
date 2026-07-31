// Monitoring method schema → form fields.
//
// Everything about turning a monitoring method's server-declared setting schema
// into DOM: the method picker, one input per setting field (including the chip
// list and conditional-visibility rules), per-field validation, and the "how to
// set this up" info panel.
//
// Extracted from the 1581-line monitoring-editor.ts. This module is a LEAF: it
// knows about the method catalogue and the DOM, and nothing about the editor's
// working state or its save cycle. The one place that needed to reach back — a
// chip input has to push its edit into the editor's working state — is inverted
// through setFieldEditedHandler below rather than imported, so there is no
// import cycle with ../monitoring-editor.
import type { MonitoringSettingField } from '@showtrak/protocol';
import { MonitoringMethodsCache, setMonitoringMethodsCache } from '../state';
import { Safe } from '../utils';

// Called after an edit that this module makes on the user's behalf (adding or
// removing a list chip), so the editor can pull the value into its working
// state and schedule a save. The editor registers its own committer at load;
// until then this is a no-op, which keeps the module usable in isolation.
let onFieldEdited: () => void = () => {};

/** Register the editor's commit function. See the note above. */
// The monitoring editor's two field hosts. Exposed as the default for the
// helpers below so another editor can reuse this renderer by passing its own
// hosts — the emitted HTML and every existing call site are unchanged.
export const MONITORING_FIELD_HOSTS =
  '#MONITORING_CHECK_DYNAMIC_SETTINGS, #MONITORING_CHECK_ADVANCED_SETTINGS';

export function setFieldEditedHandler(handler: () => void): void {
  onFieldEdited = handler;
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
//
// A single Equals condition still emits the original two attributes, unchanged.
// Anything richer — several conditions ANDed, or a set-membership test — is
// serialised as JSON into one attribute instead. Keeping the simple case
// byte-identical means every existing monitoring method renders exactly as
// before; the JSON form only appears where a method actually needs it.
function BuildMonitoringFieldWrapOpen(Field: MonitoringSettingField, ExtraClass: string) {
  const VW = Field.VisibleWhen;
  const Conditions = Array.isArray(VW) ? VW : VW ? [VW] : [];
  const Simple =
    Conditions.length === 1 && Conditions[0]!.Key != null && !Array.isArray(Conditions[0]!.In);

  let VWAttrs = '';
  if (Simple) {
    const One = Conditions[0]!;
    VWAttrs = ` data-visible-when-key="${Safe(String(One.Key))}" data-visible-when-value="${Safe(
      String(One.Equals)
    )}"`;
  } else if (Conditions.length) {
    VWAttrs = ` data-visible-when="${Safe(JSON.stringify(Conditions))}"`;
  }

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
export function AddMonitoringListChip($list: JQuery) {
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
  onFieldEdited();
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
export function InitMonitoringNotePopovers(HostSelector = MONITORING_FIELD_HOSTS) {
  if (typeof bootstrap === 'undefined' || !bootstrap.Popover) return;
  $(HostSelector)
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
export function ValidateMonitoringRequiredFields(HostSelector = MONITORING_FIELD_HOSTS) {
  $(HostSelector)
    .find('[data-required]')
    .each(function () {
      ValidateMonitoringField(this);
    });
}

// Show/hide conditional fields based on the current value of the field each one
// depends on. Called after render and on every settings change so gated inputs
// (e.g. a threshold behind an "enable" toggle) appear and disappear live.
export function ApplyMonitoringConditionalVisibility(HostSelector = MONITORING_FIELD_HOSTS) {
  const $hosts = $(HostSelector);

  $hosts.find('.monitoring-field-wrap[data-visible-when-key]').each(function () {
    const $wrap = $(this);
    const Key = $wrap.attr('data-visible-when-key') || '';
    const Expected = $wrap.attr('data-visible-when-value');
    const Actual = ReadMonitoringFieldValue(Key);
    $wrap.toggleClass('d-none', String(Expected) !== String(Actual));
  });

  // The multi-condition form: every condition must hold for the field to show.
  $hosts.find('.monitoring-field-wrap[data-visible-when]').each(function () {
    const $wrap = $(this);
    let Conditions: Array<{ Key?: string; Equals?: unknown; In?: unknown[] }> = [];
    try {
      const Parsed = JSON.parse($wrap.attr('data-visible-when') || '[]');
      if (Array.isArray(Parsed)) Conditions = Parsed;
    } catch {
      // A malformed attribute should leave the field visible rather than hide a
      // control the operator needs with no way to get it back.
      return;
    }
    const Visible = Conditions.every((Condition) => {
      if (!Condition || !Condition.Key) return true;
      const Actual = String(ReadMonitoringFieldValue(Condition.Key));
      if (Array.isArray(Condition.In)) {
        return Condition.In.some((Candidate) => String(Candidate) === Actual);
      }
      return String(Condition.Equals) === Actual;
    });
    $wrap.toggleClass('d-none', !Visible);
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

export function CollectMonitoringCheckDynamicSettings(
  HostSelector = MONITORING_FIELD_HOSTS
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  $(HostSelector)
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
