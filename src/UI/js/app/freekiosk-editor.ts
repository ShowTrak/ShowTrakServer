// The FreeKiosk terminal editor.
//
// A flat form plus an alarm section, modelled on the dummy-client editor rather
// than the monitoring editor's list/detail autosave — a terminal is one entity,
// not a parent with checks.
//
// The alarm section is where the reuse pays off. The server generates a settings
// schema from its metric registry (one enable toggle, an operator picker and one
// or two value inputs per metric, with the gates already declared), delivers it
// over IPC, and this feeds it straight through the SAME field renderer the
// monitoring editor uses. The "toggle reveals a threshold" behaviour is
// inherited, not rebuilt, and adding a metric server-side needs no change here.
import type { MonitoringSettingField } from '@showtrak/protocol';
import { openModal } from './lib/modal';
import { CloseAllModals } from './modals';
import { ConfirmationDialog, Notify } from './selection-init';
import { ErrorMessage, Safe } from './utils';
import { FormatInterval } from './monitoring';
import { RenderTagPicker } from './tag-picker';
import type { TagPickerMount } from './tag-picker';
import { FreeKioskMetricCatalogCache } from './state';
import { FreeKioskGroupFieldKey, LoadFreeKioskCatalogues } from './freekiosk';
import {
  ApplyMonitoringConditionalVisibility,
  BuildMonitoringCheckFieldHtml,
  CollectMonitoringCheckDynamicSettings,
  InitMonitoringNotePopovers,
} from './monitoring-editor/method-fields';

const FREEKIOSK_EDITOR_TAG_PICKER: TagPickerMount = {
  WrapperSelector: '#FREEKIOSK_TAGS_WRAPPER',
  ListSelector: '#FREEKIOSK_TAGS',
  Namespace: 'freeKioskEditorTags',
};

/**
 * Every host the schema draws into, for the shared field helpers.
 *
 * The setup host MUST be in here. CollectMonitoringCheckDynamicSettings scopes
 * itself to this selector, so leaving it out would silently drop the display
 * mode on every save — the field would render, accept input, and lose it.
 * Conditional visibility resolves keys globally, so the WebView alarms in the
 * alarm host still gate correctly on the mode over here.
 */
const ALARM_HOSTS =
  '#FREEKIOSK_SETUP_SETTINGS, #FREEKIOSK_ALARM_SETTINGS, #FREEKIOSK_ALARM_ADVANCED';

/** The bucket that is configuration rather than monitoring. Mirrors SETUP_SECTION_KEY. */
const SETUP_SECTION = 'Setup';

let EditorUUID: string | null = null;

async function PopulateGroupSelect(SelectedGroupID: number | null): Promise<void> {
  let Groups = await window.API.GetAllGroups();
  if (!Groups) Groups = [];
  const $select = $('#FREEKIOSK_GROUPID');
  $select.empty();
  $select.append('<option value="null">No Group</option>');
  for (const Group of Groups) {
    $select.append(`<option value="${Group.GroupID}">${Safe(Group.Title)}</option>`);
  }
  $select.val(SelectedGroupID == null ? 'null' : String(SelectedGroupID));
}

/**
 * Draw the alarm fields, grouped by the registry's own sections so an operator
 * looking for "battery" finds every battery alarm in one place.
 */
function RenderAlarmFields(Settings: Record<string, unknown>): void {
  const $host = $('#FREEKIOSK_ALARM_SETTINGS');
  const $advanced = $('#FREEKIOSK_ALARM_ADVANCED');
  const $setup = $('#FREEKIOSK_SETUP_SETTINGS');
  $host.empty();
  $advanced.empty();
  $setup.empty();

  const Catalogue = FreeKioskMetricCatalogCache;
  if (!Catalogue || !Catalogue.AlarmFields.length) {
    $host.html('<em class="text-muted">Could not load the metric list.</em>');
    return;
  }

  // Fields carry their metric's section, so grouping needs no second lookup.
  const BySection = new Map<string, MonitoringSettingField[]>();
  const Advanced: MonitoringSettingField[] = [];
  for (const Field of Catalogue.AlarmFields) {
    if (Field.Advanced) {
      Advanced.push(Field);
      continue;
    }
    const Section = String((Field as { MetricSection?: string }).MetricSection || 'Other');
    const List = BySection.get(Section) || [];
    List.push(Field);
    BySection.set(Section, List);
  }

  const RenderGroup = (Fields: MonitoringSettingField[]): string =>
    Fields.map((Field) =>
      BuildMonitoringCheckFieldHtml(
        Field,
        Object.prototype.hasOwnProperty.call(Settings, Field.Key)
          ? Settings[Field.Key]
          : Field.Default
      )
    ).join('');

  let Html = '';
  for (const Section of Catalogue.Sections) {
    const Fields = BySection.get(Section);
    if (!Fields || !Fields.length) continue;
    // The section's master switch is pulled out of the list and rendered beside
    // the heading, so it reads as governing the section rather than as the first
    // of its checks. Everything below it is gated on it by VisibleWhen, which
    // the change handler re-runs, so it collapses the section as you click it.
    const GroupKey = FreeKioskGroupFieldKey(Section);
    const Master = Fields.filter((Field) => Field.Key === GroupKey);
    const Checks = Fields.filter((Field) => Field.Key !== GroupKey);
    Html +=
      `<div class="freekiosk-alarm-section" data-section="${Safe(Section)}">` +
      `<span class="freekiosk-alarm-section-title">${Safe(Section)}</span>` +
      (Master.length ? `<div class="freekiosk-alarm-master">${RenderGroup(Master)}</div>` : '') +
      RenderGroup(Checks) +
      `</div>`;
  }
  $host.html(Html);
  if (Advanced.length) $advanced.html(RenderGroup(Advanced));

  // Configuration, not monitoring. Its bucket is not in Catalogue.Sections, so
  // the loop above skipped it and it lands in its own panel above the alarms —
  // where "what does this terminal display" is not read as another check.
  const Setup = BySection.get(SETUP_SECTION);
  if (Setup && Setup.length) $setup.html(RenderGroup(Setup));

  InitMonitoringNotePopovers(ALARM_HOSTS);
  ApplyMonitoringConditionalVisibility(ALARM_HOSTS);
}

function CollectAlarmSettings(): Record<string, unknown> {
  return CollectMonitoringCheckDynamicSettings(ALARM_HOSTS);
}

/** Persist whatever is on screen, creating the terminal if this is a new one. */
async function SaveTerminal({ Quiet = false } = {}): Promise<[string | null]> {
  const Address = String($('#FREEKIOSK_ADDRESS').val() || '').trim();
  if (!Address) {
    const Message = 'Enter an IP address or hostname';
    if (!Quiet) Notify(Message, 'error');
    return [Message];
  }

  const GroupIDRaw = $('#FREEKIOSK_GROUPID').val();
  const GroupID =
    GroupIDRaw == null || GroupIDRaw === 'null' ? null : parseInt(String(GroupIDRaw), 10);

  const Payload: Record<string, unknown> = {
    Nickname: String($('#FREEKIOSK_TITLE').val() || '').trim() || Address,
    Address,
    Port: parseInt(String($('#FREEKIOSK_PORT').val() || '8080'), 10),
    Interval: parseInt(String($('#FREEKIOSK_INTERVAL').val() || '30000'), 10),
    TimeoutMs: parseInt(String($('#FREEKIOSK_TIMEOUT').val() || '5000'), 10),
    GroupID,
    Settings: CollectAlarmSettings(),
  };

  // The field shows the stored key, so it is authoritative: an emptied field
  // is a request to remove the key, not a request to leave it alone. The
  // manager still needs the explicit flag to do it.
  const ApiKey = String($('#FREEKIOSK_API_KEY').val() || '').trim();
  if (ApiKey) Payload.ApiKey = ApiKey;
  else Payload.ClearApiKey = true;

  if (EditorUUID) {
    const Slug = String($('#FREEKIOSK_SLUG').val() || '').trim();
    if (Slug) Payload.Slug = Slug;
  }

  try {
    if (EditorUUID) {
      const [Err] = await window.API.UpdateFreeKioskTerminal(EditorUUID, Payload);
      if (Err) {
        if (!Quiet) Notify(Err, 'error');
        return [Err];
      }
      if (!Quiet) await Notify('FreeKiosk terminal updated', 'success');
    } else {
      const [Err, Created] = await window.API.CreateFreeKioskTerminal(Payload);
      if (Err) {
        if (!Quiet) Notify(Err, 'error');
        return [Err];
      }
      if (Created && Created.UUID) EditorUUID = String(Created.UUID);
      if (!Quiet) await Notify('FreeKiosk terminal created', 'success');
    }
    return [null];
  } catch (e) {
    const Message = ErrorMessage(e, 'Failed to save FreeKiosk terminal');
    if (!Quiet) Notify(Message, 'error');
    return [Message];
  }
}

function ShowTestResult(Message: string, Kind: 'ok' | 'error'): void {
  $('#FREEKIOSK_TEST_RESULT')
    .removeClass('d-none is-ok is-error')
    .addClass(Kind === 'ok' ? 'is-ok' : 'is-error')
    .text(Message);
}

export async function OpenFreeKioskEditor(UUID: string | null | undefined = null): Promise<void> {
  await CloseAllModals();
  await LoadFreeKioskCatalogues();

  let Existing = null;
  if (UUID) {
    Existing = await window.API.GetFreeKioskTerminal(UUID);
    if (!Existing) return Notify('FreeKiosk terminal not found', 'error');
  }

  let Defaults = {
    Nickname: '',
    Address: '',
    Port: 8080,
    Interval: 30000,
    TimeoutMs: 5000,
    Settings: {} as Record<string, unknown>,
  };
  if (!Existing) {
    try {
      const Generated = await window.API.GenerateFreeKioskTerminalDefaults();
      if (Generated) Defaults = Generated;
    } catch {
      // Non-fatal: fall back to the empty defaults above.
    }
  }

  EditorUUID = Existing ? Existing.UUID : null;
  const K = Existing || Defaults;

  $('#FREEKIOSK_MODAL_TITLE').text(Existing ? 'Edit FreeKiosk Terminal' : 'Add FreeKiosk Terminal');
  $('#FREEKIOSK_DANGER_ZONE').toggleClass('d-none', !Existing);
  $('#FREEKIOSK_SLUG_FIELD').toggleClass('d-none', !Existing);
  $('#FREEKIOSK_TEST_RESULT').addClass('d-none').text('');

  $('#FREEKIOSK_TITLE').val(K.Nickname || '');
  $('#FREEKIOSK_ADDRESS').val(K.Address || '');
  $('#FREEKIOSK_PORT').val(Number(K.Port) || 8080);
  $('#FREEKIOSK_SLUG').val(Existing ? Existing.Slug || '' : '');

  // The field carries the real stored key, so it is the whole truth: whatever is
  // in it on save is what the terminal ends up with, and emptying it clears the
  // key. That is why there is no separate "clear" button — with the value shown,
  // a second gesture for the same thing would only be ambiguous.
  $('#FREEKIOSK_API_KEY').val((Existing && Existing.ApiKey) || '');

  const Interval = Number(K.Interval) || 30000;
  $('#FREEKIOSK_INTERVAL').val(Interval);
  $('#FREEKIOSK_INTERVAL_LABEL').text(FormatInterval(Interval));
  const Timeout = Number(K.TimeoutMs) || 5000;
  $('#FREEKIOSK_TIMEOUT').val(Timeout);
  $('#FREEKIOSK_TIMEOUT_LABEL').text(FormatInterval(Timeout));

  await PopulateGroupSelect(Existing ? Existing.GroupID : null);
  RenderAlarmFields((Existing ? Existing.Settings : Defaults.Settings) || {});

  // Scoped by bare UUID, like every other client-like entity. A terminal being
  // created has none yet, so the picker stays hidden until it exists.
  RenderTagPicker(
    FREEKIOSK_EDITOR_TAG_PICKER,
    Existing ? { ScopedID: String(Existing.UUID), GroupID: Existing.GroupID ?? null } : null
  );

  $('#FREEKIOSK_GROUPID')
    .off('change.freeKioskEditorTags')
    .on('change.freeKioskEditorTags', function () {
      if (!Existing) return;
      const Raw = $(this).val();
      const Next = Raw == null || Raw === 'null' ? null : parseInt(String(Raw), 10);
      RenderTagPicker(FREEKIOSK_EDITOR_TAG_PICKER, {
        ScopedID: String(Existing.UUID),
        GroupID: Number.isFinite(Next as number) ? (Next as number) : null,
      });
    });

  $('#FREEKIOSK_INTERVAL')
    .off('input.freekiosk')
    .on('input.freekiosk', function () {
      $('#FREEKIOSK_INTERVAL_LABEL').text(FormatInterval($(this).val()));
    });
  $('#FREEKIOSK_TIMEOUT')
    .off('input.freekiosk')
    .on('input.freekiosk', function () {
      $('#FREEKIOSK_TIMEOUT_LABEL').text(FormatInterval($(this).val()));
    });

  // Any alarm edit re-runs the gates, so turning a toggle on reveals its
  // threshold immediately.
  $(ALARM_HOSTS)
    .off('change.freekioskAlarms input.freekioskAlarms')
    .on('change.freekioskAlarms input.freekioskAlarms', () => {
      ApplyMonitoringConditionalVisibility(ALARM_HOSTS);
    });

  $('#FREEKIOSK_TEST_CONNECTION')
    .off('click.freekiosk')
    .on('click.freekiosk', async () => {
      if (!EditorUUID) {
        return ShowTestResult('Save the terminal first, then test it.', 'error');
      }
      ShowTestResult('Polling…', 'ok');
      const [Err, Summary] = await window.API.RunFreeKioskTerminalsNow([EditorUUID]);
      if (Err) return ShowTestResult(Err, 'error');
      if (Summary && Summary.Succeeded) return ShowTestResult('Device answered.', 'ok');
      const Reason = Summary?.Results.find((Entry) => !Entry.Success)?.Error;
      ShowTestResult(Reason || 'No response from the device.', 'error');
    });

  $('#FREEKIOSK_SAVE')
    .off('click.freekiosk')
    .on('click.freekiosk', async () => {
      const [Err] = await SaveTerminal();
      if (Err) return;
      await CloseAllModals();
    });

  $('#FREEKIOSK_DELETE')
    .off('click.freekiosk')
    .on('click.freekiosk', async () => {
      if (!EditorUUID) return;
      const Confirmed = await ConfirmationDialog(
        'Delete this FreeKiosk terminal? This cannot be undone.'
      );
      if (!Confirmed) return;
      const [Err] = await window.API.DeleteFreeKioskTerminal(EditorUUID);
      if (Err) return Notify(Err, 'error');
      await Notify('FreeKiosk terminal deleted', 'success');
      await CloseAllModals();
    });

  openModal('SHOWTRAK_MODAL_FREEKIOSK_TERMINAL');
}
