// Storage tab of the client info modal: one card per mounted volume, styled
// like the network interface cards: the volume's label as the title, a usage
// bar, the Monitor toggle and, once monitored, an auto-saving conditions table
// (mounted, minimum free space as a share and as an amount, writable, healthy).
// The decisions live in lib/storage-volumes.
import { CreateConditionSaveQueue } from './lib/condition-save-queue';
import type { ClientView, StorageVolumeView } from '@showtrak/protocol';
import { HandleNonFatalError, Safe } from './utils';
import {
  GetStorageSectionState,
  ParseStorageRuleFields,
  StorageConditionRows,
  StorageRenderKey,
  StorageSectionMessage,
  StorageUsage,
  StorageVolumeBadge,
  StorageVolumeSummary,
  StorageVolumeTitle,
  StorageVolumesOf,
  type StorageConditionRow,
  type StorageRuleFields,
  type StorageSectionState,
} from './lib/storage-volumes';

const LIST = '#SHOWTRAK_CLIENT_INFO_STORAGE';

// Saves of each volume's conditions, chained so two quick edits reach the
// server in the order they were made.
const Saves = CreateConditionSaveQueue();

// The last client rendered, so a rebuild held back while a limit was being
// typed into can be applied once the field loses focus.
let Pending: ClientView | null = null;

const Token = (MountPoint: string) => encodeURIComponent(MountPoint);

function MessageCard(Title: string, Body: string): string {
  return `
    <div class="rounded-3 p-2 bg-ghost">
      <h6 class="mb-0">${Safe(Title)}</h6>
      <p class="text-sm mb-0">${Safe(Body)}</p>
    </div>`;
}

function ConditionCell(Row: StorageConditionRow): string {
  if (!Row.Supported) return `<span class="SHOWTRAK_AUDIO_COND_VALUE">Unsupported</span>`;
  const Input = Row.Input;
  if (!Input) return `<span class="SHOWTRAK_AUDIO_COND_VALUE">${Safe(Row.Value)}</span>`;
  return `
    <span class="SHOWTRAK_AUDIO_COND_BOUND">
      <input type="number" min="${Input.Min}" max="${Input.Max}" step="1" data-rule="${Row.Field}"
        value="${Safe(Input.Value)}" placeholder="${Safe(Input.Default)}"
        data-default="${Safe(Input.Default)}" aria-label="${Safe(`${Row.Label} (${Input.Unit})`)}" />
      <span>${Safe(Input.Unit)}</span>
    </span>`;
}

/** A monitored volume's conditions: key, value, and a tick to monitor it. Saves as it changes. */
function ConditionsTable(Volume: StorageVolumeView): string {
  const Rows = StorageConditionRows(Volume);
  if (!Rows.length) return '';
  return `
    <table class="SHOWTRAK_AUDIO_CONDITIONS SHOWTRAK_STORAGE_CONDITIONS" data-mount="${Token(Volume.MountPoint)}">
      <tbody>
        ${Rows.map(
          (Row) => `
          <tr data-cond="${Row.Field}" class="${Row.Supported ? '' : 'is-unsupported'} ${Row.Failing ? 'is-failing' : ''}"
            ${Row.Failing ? `title="${Safe(Row.Failing)}"` : ''}>
            <th scope="row">${Safe(Row.Label)}</th>
            <td>${ConditionCell(Row)}</td>
            <td class="SHOWTRAK_AUDIO_COND_CHECK">${
              Row.Supported
                ? `<input type="checkbox" class="form-check-input" data-rule="${Row.Field}"
                    ${Row.Checked ? 'checked' : ''} ${Row.Locked ? 'disabled' : ''} aria-label="Monitor ${Safe(Row.Label.toLowerCase())}${Row.Input ? ` (${Safe(Row.Input.Unit)})` : ''}" />`
                : ''
            }</td>
          </tr>`
        ).join('')}
      </tbody>
    </table>`;
}

function UsageBar(Volume: StorageVolumeView): string {
  const Usage = StorageUsage(Volume);
  if (!Usage) return '';
  const Used = Usage.UsedPercent.toFixed(1);
  return `
    <div class="SHOWTRAK_STORAGE_USAGE ${Usage.Low ? 'is-low' : ''}">
      <div class="SHOWTRAK_STORAGE_BAR" role="meter" aria-valuemin="0" aria-valuemax="100"
        aria-valuenow="${Used}" aria-label="${Safe(StorageVolumeTitle(Volume))} used">
        <span style="width: ${Used}%"></span>
      </div>
      <small class="SHOWTRAK_STORAGE_USAGE_TEXT">${Safe(Usage.Text)}</small>
    </div>`;
}

function VolumeCard(Volume: StorageVolumeView): string {
  const Badge = StorageVolumeBadge(Volume);
  const Toggle = `<button type="button" class="${[
    'SHOWTRAK_TOGGLE_CRITICAL_USB',
    'SHOWTRAK_TOGGLE_CRITICAL_AUDIO',
    'SHOWTRAK_TOGGLE_CRITICAL_STORAGE',
    Volume.IsCritical ? 'is-critical' : '',
    Badge.State === 'missing' ? 'is-disconnected-critical' : '',
    Badge.State === 'issue' ? 'is-mismatch-critical' : '',
  ]
    .filter(Boolean)
    .join(' ')}" data-mount="${Token(Volume.MountPoint)}"
    data-critical="${Volume.IsCritical ? '1' : '0'}" title="${Badge.Title}" aria-label="${Badge.Title}">
    <i class="bi ${Badge.Icon}"></i>
    <span>${Badge.Label}</span>
  </button>`;
  return `
    <div class="rounded-3 p-2 bg-ghost SHOWTRAK_AUDIO_CARD SHOWTRAK_STORAGE_CARD" data-mount="${Token(Volume.MountPoint)}">
      <div class="SHOWTRAK_AUDIO_CARD_HEADER">
        <div class="SHOWTRAK_AUDIO_TITLE text-start">
          <h6 class="mb-0">${Safe(StorageVolumeTitle(Volume))}</h6>
          <small class="text-light d-block mb-0 text-start">${Safe(StorageVolumeSummary(Volume))}</small>
        </div>
        ${Toggle}
      </div>
      ${UsageBar(Volume)}
      ${Volume.Issues.map(
        (Issue) =>
          `<small class="d-block mt-1 text-start st-condition-failing"><i class="bi bi-exclamation-triangle me-1"></i>${Safe(Issue.Message)}</small>`
      ).join('')}
      ${ConditionsTable(Volume)}
    </div>`;
}

/** The section's markup for a client. Pure: a function of the client alone. */
export function BuildStorageSectionHtml(Client: ClientView, State: StorageSectionState): string {
  const Html: string[] = [];
  if (State !== 'ok') {
    const Message = StorageSectionMessage(State, Client);
    Html.push(MessageCard(Message.Title, Message.Body));
  }
  // An old client has nothing to list and nothing can be monitored on it.
  if (State === 'outdated') return Html.join('');
  const Volumes = StorageVolumesOf(Client);
  if (State === 'ok' && !Volumes.length) {
    Html.push(MessageCard('No Volumes', 'This client reports no mounted volumes.'));
  }
  for (const Volume of Volumes) Html.push(VolumeCard(Volume));
  return Html.join('');
}

/** Render the section, rebuilt only when what it shows changes. */
export function RenderClientInfoStorage(Client: ClientView): void {
  // Never rebuild under the operator's typing; catch up when they leave the field.
  if ($(LIST).find('input[type="number"]:focus').length) {
    Pending = Client;
    return;
  }
  Pending = null;
  const State = GetStorageSectionState(Client);
  const $List = $(LIST);
  const Key = StorageRenderKey(Client, State);
  if (($List.attr('data-render-key') || '') === Key) return;
  $List.html(BuildStorageSectionHtml(Client, State));
  $List.attr('data-render-key', Key);
}

/** Empty the section (an SDK client has no volumes to show). */
export function ClearClientInfoStorage(): void {
  Pending = null;
  $(LIST).attr('data-render-key', '').html('');
}

/** Read a conditions table back into a request and save it. */
function SaveConditions(
  $Table: JQuery,
  UUID: string,
  Refresh: () => Promise<void>,
  Notify: (Message: string, Type?: string, Duration?: number) => unknown
): Promise<void> {
  const MountPoint = decodeURIComponent(String($Table.attr('data-mount') || ''));
  const Fields: StorageRuleFields = {};
  const Row = (Field: string) => $Table.find(`[data-cond="${Field}"]`);
  const Checked = (Field: string) => Row(Field).find('input[type="checkbox"]').is(':checked');
  // Unsupported rows are left out, so the stored value survives.
  const Supported = (Field: string) =>
    Row(Field).length > 0 && !Row(Field).hasClass('is-unsupported');
  for (const Field of ['MinFreePercent', 'MinFreeGB'] as const) {
    if (!Supported(Field)) continue;
    Fields[Field] = Checked(Field)
      ? String(Row(Field).find('input[type="number"]').val() ?? '')
      : '';
  }
  for (const Field of ['RequireWritable', 'RequireHealthy'] as const) {
    if (Supported(Field)) Fields[Field] = Checked(Field);
  }
  const Parsed = ParseStorageRuleFields(MountPoint, Fields);
  return Saves.Enqueue(MountPoint, {
    Save: async () =>
      'Error' in Parsed
        ? Parsed.Error
        : (await window.API.MarkClientStorageVolumeCritical(UUID, Parsed.Payload))[0],
    Refresh,
    Notify,
    ResetRender: () => $(LIST).attr('data-render-key', ''),
    ErrorContext: 'ClientInfo:SaveStorageConditions',
  });
}

/** Wire the section's controls. `Refresh` re-fetches and re-renders the client. */
export function BindClientInfoStorageHandlers(
  GetUUID: () => string | null,
  Refresh: () => Promise<void>,
  Notify: (Message: string, Type?: string, Duration?: number) => unknown
): void {
  $(LIST)
    .off('.client-storage')
    .on('click.client-storage', '.SHOWTRAK_TOGGLE_CRITICAL_STORAGE', async function () {
      try {
        const UUID = GetUUID();
        const MountPoint = decodeURIComponent(String($(this).attr('data-mount') || ''));
        if (!UUID || !MountPoint) return;
        const IsCritical = String($(this).attr('data-critical') || '0') === '1';
        const [Err] = IsCritical
          ? await window.API.RemoveClientStorageVolumeCritical(UUID, MountPoint)
          : await window.API.MarkClientStorageVolumeCritical(UUID, { MountPoint });
        if (Err) return void Notify(String(Err), 'error');
        await Notify(
          IsCritical ? 'Volume no longer monitored.' : 'Volume is now monitored.',
          'success',
          1400
        );
        await Refresh();
      } catch (err) {
        HandleNonFatalError('ClientInfo:ToggleCriticalStorage', err);
      }
    })
    // Conditions save as they change: a tick, or a limit once typed.
    .on('change.client-storage', '.SHOWTRAK_STORAGE_CONDITIONS input', function () {
      const UUID = GetUUID();
      const $Input = $(this);
      const $Table = $Input.closest('.SHOWTRAK_STORAGE_CONDITIONS');
      if (!UUID || !$Table.length) return;
      const $Row = $Input.closest('[data-cond]');
      const $Value = $Row.find('input[type="number"]');
      if ($Value.length) {
        if ($Input.attr('type') === 'checkbox') {
          // Ticking a row with nothing set starts from the usual limit.
          if (!$Input.is(':checked')) $Value.val('');
          else if (!String($Value.val() ?? '').trim()) {
            $Value.val(String($Value.attr('data-default') || ''));
          }
        } else {
          // Setting a limit monitors it; clearing it stops.
          $Row
            .find('input[type="checkbox"]')
            .prop('checked', String($Input.val() ?? '').trim() !== '');
        }
      }
      return SaveConditions($Table, UUID, Refresh, Notify);
    })
    // Enter commits a typed value, as leaving the field does.
    .on(
      'keydown.client-storage',
      '.SHOWTRAK_STORAGE_CONDITIONS input[type="number"]',
      function (Event) {
        if (Event.key === 'Enter') $(this).trigger('blur');
      }
    )
    .on(
      'focusout.client-storage',
      '.SHOWTRAK_STORAGE_CONDITIONS input[type="number"]',
      function () {
        // Apply a rebuild that was held back while this field had focus, after
        // the `change` that fires first has had its chance to save.
        setTimeout(() => {
          if (!Pending || $(LIST).find('input[type="number"]:focus').length) return;
          RenderClientInfoStorage(Pending);
        }, 0);
      }
    );
}

export const _internal = { SaveChains: Saves.Chains };
