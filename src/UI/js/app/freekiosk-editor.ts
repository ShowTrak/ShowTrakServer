// The FreeKiosk terminal form: the Add FreeKiosk Terminal modal, and the
// helpers an existing terminal's Settings tab (freekiosk-info-edit.ts) drives
// the same form with.
//
// A flat form, modelled on the dummy-client editor: connection, group, tags,
// polling and the declared display mode. What the terminal MONITORS is not
// here; it is switched on and tuned on the section tabs of the terminal's view
// modal (freekiosk-monitoring.ts), next to the readings it judges. A new
// terminal starts from the server's defaults for that.
//
// The display mode is drawn by the SAME field renderer the monitoring editor
// uses, from the schema the server generates out of its metric registry.
import { openModal } from './lib/modal';
import { ApiKeyPayload } from './lib/freekiosk-api-key';
import { CloseAllModals } from './modals';
import { Notify } from './selection-init';
import { ErrorMessage, Safe } from './utils';
import { FormatInterval, OpenFreeKioskTerminalHistory } from './monitoring';
import type { TagPickerMount } from './tag-picker';
import { FreeKioskMetricCatalogCache } from './state';
import { LoadFreeKioskCatalogues } from './freekiosk';
import {
  BuildMonitoringCheckFieldHtml,
  CollectMonitoringCheckDynamicSettings,
  InitMonitoringNotePopovers,
} from './monitoring-editor/method-fields';

export const FREEKIOSK_EDITOR_TAG_PICKER: TagPickerMount = {
  WrapperSelector: '#FREEKIOSK_TAGS_WRAPPER',
  ListSelector: '#FREEKIOSK_TAGS',
  Namespace: 'freeKioskEditorTags',
};

/** Where the schema's setup fields (the display mode) are drawn. */
const SETUP_HOST = '#FREEKIOSK_SETUP_SETTINGS';

/** The bucket that is configuration rather than monitoring. Mirrors SETUP_SECTION_KEY. */
const SETUP_SECTION = 'Setup';

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
 * Draw the setup fields: configuration rather than monitoring (what the
 * terminal displays), which the schema files under its own bucket.
 */
function RenderSetupFields(Settings: Record<string, unknown>): void {
  const $setup = $(SETUP_HOST);
  $setup.empty();
  const Catalogue = FreeKioskMetricCatalogCache;
  if (!Catalogue || !Catalogue.AlarmFields.length) {
    $setup.html('<em class="text-muted">Failed to load the terminal settings.</em>');
    return;
  }
  const Setup = Catalogue.AlarmFields.filter(
    (Field) => (Field as { MetricSection?: string }).MetricSection === SETUP_SECTION
  );
  $setup.html(
    Setup.map((Field) =>
      BuildMonitoringCheckFieldHtml(
        Field,
        Object.prototype.hasOwnProperty.call(Settings, Field.Key)
          ? Settings[Field.Key]
          : Field.Default
      )
    ).join('')
  );
  InitMonitoringNotePopovers(SETUP_HOST);
}

/**
 * The setup settings on screen. Only these: a save merges them over the
 * terminal's stored settings, so the monitoring set on its tabs is untouched.
 */
export function CollectFreeKioskSetupSettings(): Record<string, unknown> {
  return CollectMonitoringCheckDynamicSettings(SETUP_HOST);
}

/** Where the single terminal form lives while no terminal's Settings tab has it. */
const ADD_FORM_SLOT = '#FREEKIOSK_ADD_FORM_SLOT';

/**
 * Move the terminal form into a host (or back to the Add modal). There is one
 * form, not one per surface: its setup fields come from the shared schema
 * renderer, which finds a field by a document-wide id, so a second copy would
 * have it reading the wrong one.
 */
export function MoveFreeKioskForm(HostSelector: string = ADD_FORM_SLOT): void {
  const Form = document.getElementById('FREEKIOSK_FORM');
  const Host = document.querySelector(HostSelector);
  if (Form && Host && Form.parentElement !== Host) Host.appendChild(Form);
}

/** Enable or disable every input in the form (copy buttons stay usable). */
export function SetFreeKioskFormEditable(Editable: boolean): void {
  $('#FREEKIOSK_FORM')
    .find('input, select, textarea, .monitoring-list-add-btn, .monitoring-list-chip-remove')
    .prop('disabled', !Editable);
  $('#FREEKIOSK_FORM .form-control').toggleClass('disabled', !Editable);
}

export interface FreeKioskFormSource {
  Nickname?: string | null;
  Address?: string | null;
  Port?: number | null;
  Interval?: number | null;
  TimeoutMs?: number | null;
  GroupID?: number | null;
  Slug?: string | null;
  ApiKey?: string | null;
  HasApiKey?: boolean;
  Settings?: Record<string, unknown> | null;
}

// Whether the form was filled without the stored key, and whether the operator
// has since asked to remove it. Reset on every fill.
let ApiKeyWithheld = false;
let ApiKeyClearRequested = false;

function RenderApiKeyField(): void {
  const Typed = !!String($('#FREEKIOSK_API_KEY').val() || '').trim();
  const Kept = ApiKeyWithheld && !ApiKeyClearRequested;
  $('#FREEKIOSK_API_KEY_CLEAR').toggleClass('d-none', !Kept || Typed);
  // Nothing to copy from a field that never holds the stored key.
  $('#FREEKIOSK_API_KEY_COPY').toggleClass('d-none', ApiKeyWithheld && !Typed);
  $('#FREEKIOSK_API_KEY').attr('placeholder', Kept ? 'Key set' : 'API key');
  $('#FREEKIOSK_API_KEY_HINT').text(
    Kept
      ? 'A key is set. Leave blank to keep it, type a new one to replace it, or remove it.'
      : ApiKeyWithheld
        ? 'The key will be removed when you save. Type one to set a new key instead.'
        : 'Leave blank if the device has no key set. Stored and exported in plain text.'
  );
}

/** Fill the form from a terminal (or the Add defaults). */
export async function FillFreeKioskForm(K: FreeKioskFormSource): Promise<void> {
  $('#FREEKIOSK_TEST_RESULT').addClass('d-none').text('');
  $('#FREEKIOSK_TITLE').val(K.Nickname || '');
  $('#FREEKIOSK_ADDRESS').val(K.Address || '');
  $('#FREEKIOSK_PORT').val(Number(K.Port) || 8080);
  $('#FREEKIOSK_SLUG').val(K.Slug || '');

  // Given the stored key (the desktop), the field carries it and is the whole
  // truth: emptying it clears the key, so no separate clear button. Not given it
  // (the Web UI), the field starts blank, a blank save keeps the key, and the
  // clear button is the way to remove it. See lib/freekiosk-api-key.
  ApiKeyWithheld = !!K.HasApiKey && K.ApiKey === undefined;
  ApiKeyClearRequested = false;
  $('#FREEKIOSK_API_KEY').val(K.ApiKey || '');
  $('#FREEKIOSK_API_KEY_VIEW').val(K.HasApiKey || K.ApiKey ? 'Set' : 'Not set');
  RenderApiKeyField();

  const Interval = Number(K.Interval) || 30000;
  $('#FREEKIOSK_INTERVAL').val(Interval);
  $('#FREEKIOSK_INTERVAL_LABEL').text(FormatInterval(Interval));
  const Timeout = Number(K.TimeoutMs) || 5000;
  $('#FREEKIOSK_TIMEOUT').val(Timeout);
  $('#FREEKIOSK_TIMEOUT_LABEL').text(FormatInterval(Timeout));

  await PopulateGroupSelect(K.GroupID ?? null);
  RenderSetupFields(K.Settings || {});
}

/**
 * The Create/UpdateFreeKioskTerminal payload for what is on screen, or the
 * reason it cannot be saved. `Existing` adds the slug, which a terminal being
 * created does not have yet. Its Settings are the setup fields alone; the
 * caller merges them over the stored (or default) settings before sending.
 */
export function BuildFreeKioskPayload(
  Existing: boolean
): [string | null, Record<string, unknown> | null] {
  const Address = String($('#FREEKIOSK_ADDRESS').val() || '').trim();
  if (!Address) return ['Enter an IP address or hostname', null];

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
    Settings: CollectFreeKioskSetupSettings(),
  };

  Object.assign(
    Payload,
    ApiKeyPayload({
      Typed: String($('#FREEKIOSK_API_KEY').val() || ''),
      Withheld: ApiKeyWithheld,
      ClearRequested: ApiKeyClearRequested,
    })
  );

  if (Existing) {
    const Slug = String($('#FREEKIOSK_SLUG').val() || '').trim();
    if (Slug) Payload.Slug = Slug;
  }
  return [null, Payload];
}

export function ShowFreeKioskTestResult(Message: string, Kind: 'ok' | 'error'): void {
  $('#FREEKIOSK_TEST_RESULT')
    .removeClass('d-none is-ok is-error')
    .addClass(Kind === 'ok' ? 'is-ok' : 'is-error')
    .text(Message);
}

// The live labels, bound once: the form is the same element wherever it
// currently lives.
let FormBound = false;
export function BindFreeKioskForm(): void {
  if (FormBound) return;
  FormBound = true;
  $('#FREEKIOSK_INTERVAL').on('input.freekiosk', function () {
    $('#FREEKIOSK_INTERVAL_LABEL').text(FormatInterval($(this).val()));
  });
  $('#FREEKIOSK_TIMEOUT').on('input.freekiosk', function () {
    $('#FREEKIOSK_TIMEOUT_LABEL').text(FormatInterval($(this).val()));
  });
  $('#FREEKIOSK_API_KEY').on('input.freekiosk', () => RenderApiKeyField());
  $('#FREEKIOSK_API_KEY_CLEAR').on('click.freekiosk', function () {
    ApiKeyClearRequested = true;
    RenderApiKeyField();
    // The view pane's Save tracks changes off input/change events.
    $(this).trigger('change');
  });
}

/**
 * The Add FreeKiosk Terminal modal. An existing terminal's settings live on the
 * Settings tab of its view modal (freekiosk-info-edit.ts), so a UUID opens that.
 */
export async function OpenFreeKioskEditor(UUID: string | null | undefined = null): Promise<void> {
  if (UUID) return OpenFreeKioskTerminalHistory(String(UUID), { Tab: 'settings' });
  await CloseAllModals();
  await LoadFreeKioskCatalogues();

  let Defaults: FreeKioskFormSource = {
    Nickname: '',
    Address: '',
    Port: 8080,
    Interval: 30000,
    TimeoutMs: 5000,
    Settings: {},
  };
  try {
    const Generated = await window.API.GenerateFreeKioskTerminalDefaults();
    if (Generated) Defaults = Generated;
  } catch {
    // Non-fatal: fall back to the empty defaults above.
  }

  MoveFreeKioskForm();
  BindFreeKioskForm();
  await FillFreeKioskForm(Defaults);
  SetFreeKioskFormEditable(true);

  $('#FREEKIOSK_SAVE')
    .off('click.freekiosk')
    .on('click.freekiosk', async () => {
      const [Invalid, Payload] = BuildFreeKioskPayload(false);
      if (!Payload) return Notify(Invalid, 'error');
      // The default monitoring, with the display mode chosen here on top.
      Payload.Settings = { ...(Defaults.Settings || {}), ...(Payload.Settings as object) };
      try {
        const [Err] = await window.API.CreateFreeKioskTerminal(Payload);
        if (Err) return Notify(Err, 'error');
        await Notify('FreeKiosk terminal created.', 'success');
        await CloseAllModals();
      } catch (e) {
        Notify(ErrorMessage(e, 'Failed to save FreeKiosk terminal'), 'error');
      }
    });

  openModal('SHOWTRAK_MODAL_FREEKIOSK_TERMINAL');
}
