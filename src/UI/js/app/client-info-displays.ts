// Displays section of the client info modal: one card per display, styled like
// the audio cards, with a critical toggle and — once critical — an auto-saving
// conditions table (connected, resolution, refresh rate, scaling, rotation,
// primary, position). The decisions live in lib/displays.
import { CreateConditionSaveQueue } from './lib/condition-save-queue';
import type { ClientDisplayView, ClientView } from '@showtrak/protocol';
import { HandleNonFatalError, Safe } from './utils';
import {
  DisplayBadge,
  DisplayConditionRows,
  DisplayKey,
  DisplayRenderKey,
  DisplaySummary,
  DisplayTitle,
  GetDisplaySectionState,
  ParseDisplayRuleFields,
  VisibleDisplays,
  type DisplayConditionField,
  type DisplaySectionState,
} from './lib/displays';

export const DISPLAY_LIST = '#SHOWTRAK_CLIENT_INFO_DISPLAYS';

const CONDITION_FIELDS: DisplayConditionField[] = [
  'RequirePresent',
  'CheckResolution',
  'CheckRefreshRate',
  'CheckScale',
  'CheckRotation',
  'RequirePrimary',
  'CheckPosition',
];

// Saves of each display's conditions, chained so two quick ticks reach the
// server in the order they were made.
const Saves = CreateConditionSaveQueue();

const Token = (DisplayID: string) => encodeURIComponent(DisplayID);

function MessageCard(Title: string, Body: string): string {
  return `
    <div class="rounded-3 p-2 bg-ghost">
      <h6 class="mb-0">${Safe(Title)}</h6>
      <p class="text-sm mb-0">${Safe(Body)}</p>
    </div>`;
}

/** A critical display's conditions: key, value, and a tick to monitor it. Saves as it changes. */
function ConditionsTable(Display: ClientDisplayView): string {
  const Rows = DisplayConditionRows(Display);
  if (!Rows.length) return '';
  return `
    <table class="SHOWTRAK_AUDIO_CONDITIONS SHOWTRAK_DISPLAY_CONDITIONS" data-display="${Token(DisplayKey(Display))}">
      <tbody>
        ${Rows.map(
          (Row) => `
          <tr data-cond="${Row.Field}" class="${Row.Supported ? '' : 'is-unsupported'} ${Row.Failing ? 'is-failing' : ''}"
            ${Row.Failing ? `title="${Safe(Row.Failing)}"` : ''}>
            <th scope="row">${Safe(Row.Label)}</th>
            <td><span class="SHOWTRAK_AUDIO_COND_VALUE">${Safe(Row.Value)}</span></td>
            <td class="SHOWTRAK_AUDIO_COND_CHECK">${
              Row.Supported
                ? `<input type="checkbox" class="form-check-input" data-rule="${Row.Field}"
                    ${Row.Checked ? 'checked' : ''} ${Row.Locked ? 'disabled' : ''} aria-label="Monitor ${Safe(Row.Label.toLowerCase())}" />`
                : ''
            }</td>
          </tr>`
        ).join('')}
      </tbody>
    </table>`;
}

function DisplayCard(Display: ClientDisplayView): string {
  const Key = DisplayKey(Display);
  const Badge = DisplayBadge(Display);
  const Connected = Display.IsConnected !== false;
  const ScreenNumber = Number(Display.ScreenNumber);
  const NumberBadge =
    Connected && Number.isFinite(ScreenNumber) && ScreenNumber > 0
      ? `<span class="SHOWTRAK_DISPLAY_NUMBER" title="Identify screen number">${Math.trunc(ScreenNumber)}</span>`
      : '';
  const Toggle = Key
    ? `<button type="button" class="${[
        'SHOWTRAK_TOGGLE_CRITICAL_USB',
        'SHOWTRAK_TOGGLE_CRITICAL_AUDIO',
        'SHOWTRAK_TOGGLE_CRITICAL_DISPLAY',
        Display.IsCritical ? 'is-critical' : '',
        Badge.State === 'missing' ? 'is-disconnected-critical' : '',
        Badge.State === 'issue' ? 'is-mismatch-critical' : '',
      ]
        .filter(Boolean)
        .join(' ')}" data-display="${Token(Key)}"
        data-critical="${Display.IsCritical ? '1' : '0'}" title="${Badge.Title}" aria-label="${Badge.Title}">
        <i class="bi ${Badge.Icon}"></i>
        <span>${Badge.Label}</span>
      </button>`
    : '';
  return `
    <div class="rounded-3 p-2 bg-ghost SHOWTRAK_AUDIO_CARD SHOWTRAK_DISPLAY_CARD" data-display="${Token(Key)}">
      <div class="SHOWTRAK_AUDIO_CARD_HEADER">
        ${NumberBadge}
        <div class="SHOWTRAK_AUDIO_TITLE text-start">
          <h6 class="mb-0">${Safe(DisplayTitle(Display))}${
            Connected && Display.Primary
              ? ' <span class="SHOWTRAK_AUDIO_DEFAULT_BADGE">Primary</span>'
              : ''
          }</h6>
          <small class="text-light d-block mb-0 text-start">${Safe(DisplaySummary(Display))}</small>
        </div>
        ${Toggle}
      </div>
      ${(Display.Issues || [])
        .map(
          (Issue) =>
            `<small class="d-block mt-1 text-start st-condition-failing"><i class="bi bi-exclamation-triangle-fill me-1"></i>${Safe(Issue.Message)}</small>`
        )
        .join('')}
      ${ConditionsTable(Display)}
    </div>`;
}

/** The section markup for a client. Pure: a function of the client and its support. */
export function BuildDisplaySectionHtml(Client: ClientView, State: DisplaySectionState): string {
  if (State === 'outdated') {
    return MessageCard(
      'Display Monitoring Unavailable',
      'Display monitoring is only available in ShowTrak Client 3.8.0 and above.'
    );
  }
  const Html: string[] = [];
  const Displays = VisibleDisplays(Client, State);
  if (State === 'offline') {
    Html.push(
      MessageCard('Client Offline', 'Displays are reported while the client is connected.')
    );
  } else if (!Displays.length) {
    Html.push(
      MessageCard('No Displays Detected', 'This client has not reported any connected displays.')
    );
  }
  for (const Display of Displays) Html.push(DisplayCard(Display));
  return Html.join('');
}

/** Render the section, rebuilt only when what it shows changes. */
export function RenderClientInfoDisplays(Client: ClientView, Supported: boolean): void {
  const $List = $(DISPLAY_LIST);
  const State = GetDisplaySectionState(Client, Supported);
  const Key = DisplayRenderKey(Client, State);
  if (($List.attr('data-render-key') || '') === Key) return;
  $List.html(BuildDisplaySectionHtml(Client, State));
  $List.attr('data-render-key', Key);
}

/** Empty the section (an SDK client has no displays to show). */
export function ClearClientInfoDisplays(): void {
  $(DISPLAY_LIST).attr('data-render-key', '').html('');
}

/** Wire the section's controls. `Refresh` re-fetches and re-renders the client. */
export function BindClientInfoDisplayHandlers(
  GetUUID: () => string | null,
  Refresh: () => Promise<void>,
  Notify: (Message: string, Type?: string, Duration?: number) => unknown
): void {
  $(DISPLAY_LIST)
    .off('.client-display')
    .on('click.client-display', '.SHOWTRAK_TOGGLE_CRITICAL_DISPLAY', async function () {
      try {
        const UUID = GetUUID();
        const DisplayID = decodeURIComponent(String($(this).attr('data-display') || ''));
        if (!UUID || !DisplayID) return;
        const IsCritical = String($(this).attr('data-critical') || '0') === '1';
        const [Err] = IsCritical
          ? await window.API.RemoveClientDisplayCritical(UUID, DisplayID)
          : await window.API.MarkClientDisplayCritical(UUID, { DisplayID });
        if (Err) return void Notify(String(Err), 'error');
        await Notify(
          IsCritical ? 'Display no longer monitored.' : 'Display is now monitored.',
          'success',
          1400
        );
        await Refresh();
      } catch (err) {
        HandleNonFatalError('ClientInfo:ToggleCriticalDisplay', err);
      }
    })
    // Conditions save as they are ticked.
    .on('change.client-display', '.SHOWTRAK_DISPLAY_CONDITIONS input', function () {
      const UUID = GetUUID();
      const $Table = $(this).closest('.SHOWTRAK_DISPLAY_CONDITIONS');
      const DisplayID = decodeURIComponent(String($Table.attr('data-display') || ''));
      if (!UUID || !DisplayID) return;
      const Checked = (Field: DisplayConditionField) =>
        $Table.find(`input[type="checkbox"][data-rule="${Field}"]`).is(':checked');
      const Fields = Object.fromEntries(
        CONDITION_FIELDS.map((Field) => [Field, Checked(Field)])
      ) as Record<DisplayConditionField, boolean>;
      const Payload = ParseDisplayRuleFields(DisplayID, Fields);
      return Saves.Enqueue(DisplayID, {
        Save: async () => (await window.API.MarkClientDisplayCritical(UUID, Payload))[0],
        Refresh,
        Notify,
        ResetRender: () => $(DISPLAY_LIST).attr('data-render-key', ''),
        ErrorContext: 'ClientInfo:SaveDisplayConditions',
      });
    });
}

export const _internal = { SaveChains: Saves.Chains };
