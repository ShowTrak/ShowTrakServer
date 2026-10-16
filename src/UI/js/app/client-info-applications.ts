// The Applications section of the client info modal: one card per application,
// styled like the audio, display and network cards — a summary line, the
// Monitor toggle, the issues it raises and, once monitored, an auto-saving
// conditions table (running, responding, in the foreground). The decisions
// live in lib/applications.
import { CreateConditionSaveQueue } from './lib/condition-save-queue';
import type {
  ClientView,
  RunningApplicationViewItem,
  RunningApplicationsStatus,
} from '@showtrak/protocol';
import { HandleNonFatalError, Safe } from './utils';
import {
  ApplicationBadge,
  ApplicationConditionRows,
  ApplicationConditionsPayload,
  ApplicationIssues,
  ApplicationSummary,
  type ApplicationConditionField,
} from './lib/applications';

const LIST = '#SHOWTRAK_CLIENT_INFO_RUNNING_APPLICATIONS';

// Saves of each application's conditions, chained so two quick ticks reach the
// server in the order they were made.
const Saves = CreateConditionSaveQueue();

function MessageCard(Title: string, Body: string, Tone: 'ghost' | 'danger' = 'ghost'): string {
  const Classes =
    Tone === 'danger'
      ? 'rounded-3 p-2 bg-danger bg-opacity-25 border border-danger-subtle'
      : 'rounded-3 p-2 bg-ghost';
  return `
    <div class="${Classes}">
      <h6 class="mb-0">${Safe(Title)}</h6>
      <p class="text-sm mb-0">${Safe(Body)}</p>
    </div>`;
}

function ConditionsTable(
  App: RunningApplicationViewItem,
  Client: ClientView,
  Token: string
): string {
  const Rows = ApplicationConditionRows(App, Client);
  if (!Rows.length) return '';
  return `
    <table class="SHOWTRAK_AUDIO_CONDITIONS SHOWTRAK_APP_CONDITIONS" data-name="${Token}">
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

function ApplicationCard(App: RunningApplicationViewItem, Client: ClientView): string {
  const Name = App.Name ? String(App.Name) : 'Unknown Application';
  const Token = encodeURIComponent(Name);
  const Badge = ApplicationBadge(App, Client);
  const Classes = [
    'SHOWTRAK_TOGGLE_CRITICAL_USB',
    'SHOWTRAK_TOGGLE_CRITICAL_AUDIO',
    'SHOWTRAK_TOGGLE_CRITICAL_APP',
    App.IsCritical ? 'is-critical' : '',
    Badge.State === 'missing' ? 'is-disconnected-critical' : '',
    Badge.State === 'issue' ? 'is-mismatch-critical' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return `
    <div class="rounded-3 p-2 bg-ghost SHOWTRAK_AUDIO_CARD SHOWTRAK_APP_CARD" data-name="${Token}">
      <div class="SHOWTRAK_AUDIO_CARD_HEADER">
        <div class="SHOWTRAK_AUDIO_TITLE text-start">
          <h6 class="mb-0">${Safe(Name)}</h6>
          <small class="text-light d-block mb-0 text-start">${Safe(ApplicationSummary(App))}</small>
        </div>
        <button type="button" class="${Classes}" data-name="${Token}" data-critical="${App.IsCritical ? '1' : '0'}"
          title="${Safe(Badge.Title)}" aria-label="${Safe(Badge.Title)}">
          <i class="bi ${Badge.Icon}"></i>
          <span>${Safe(Badge.Label)}</span>
        </button>
      </div>
      ${ApplicationIssues(App, Client)
        .map(
          (Issue) =>
            `<small class="d-block mt-1 text-start st-condition-failing"><i class="bi bi-exclamation-triangle-fill me-1"></i>${Safe(Issue)}</small>`
        )
        .join('')}
      ${ConditionsTable(App, Client, Token)}
    </div>`;
}

/** The whole section's markup. Pure: a function of the client alone. */
export function BuildApplicationsHtml(Client: ClientView): string {
  const Apps = Array.isArray(Client?.RunningApplications?.Items)
    ? Client.RunningApplications.Items
    : [];
  const Status: Partial<RunningApplicationsStatus> = Client?.RunningApplications?.Status || {};
  const State = typeof Status.State === 'string' ? Status.State.trim().toLowerCase() : 'unknown';
  const Message =
    typeof Status.Message === 'string' && Status.Message.trim() ? Status.Message.trim() : null;
  const Html: string[] = [];
  if (State === 'permission_denied' || State === 'error') {
    Html.push(
      MessageCard(
        'Application Monitoring Warning',
        Message ||
          'The client cannot collect running applications because system permission was denied.',
        'danger'
      )
    );
  }
  if (!Apps.length) {
    Html.push(
      MessageCard(
        'No applications reported',
        'The client has not sent an application snapshot yet.'
      )
    );
  }
  for (const App of Apps) Html.push(ApplicationCard(App, Client));
  return Html.join('');
}

/** Rebuild the section when what it shows has changed. */
export function RenderClientInfoApplications(Client: ClientView): void {
  const $List = $(LIST);
  const Html = BuildApplicationsHtml(Client);
  if ($List.attr('data-render-key') === Html) return;
  $List.attr('data-render-key', Html).html(Html);
}

export function ClearClientInfoApplications(): void {
  $(LIST).attr('data-render-key', '').html('');
}

/** Wire the section's controls. `Refresh` re-fetches and re-renders the client. */
export function BindClientInfoApplicationHandlers(
  GetUUID: () => string | null,
  Refresh: () => Promise<void>,
  Notify: (Message: string, Type?: string, Duration?: number) => unknown
): void {
  $(LIST)
    .off('.client-apps')
    .on('click.client-apps', '.SHOWTRAK_TOGGLE_CRITICAL_APP', async function () {
      try {
        const UUID = GetUUID();
        const Name = decodeURIComponent(String($(this).attr('data-name') || ''));
        if (!UUID || !Name) return;
        const IsCritical = String($(this).attr('data-critical') || '0') === '1';
        const [Err] = IsCritical
          ? await window.API.RemoveClientApplicationCritical(UUID, Name)
          : await window.API.MarkClientApplicationCritical(UUID, { Name });
        if (Err) return void Notify(String(Err), 'error');
        await Notify(
          IsCritical ? 'Application no longer monitored.' : 'Application is now monitored.',
          'success',
          1400
        );
        await Refresh();
      } catch (err) {
        HandleNonFatalError('ClientInfo:ToggleApplication', err);
      }
    })
    // Conditions save as they are ticked.
    .on('change.client-apps', '.SHOWTRAK_APP_CONDITIONS input[type="checkbox"]', function () {
      const UUID = GetUUID();
      const $Table = $(this).closest('.SHOWTRAK_APP_CONDITIONS');
      const Name = decodeURIComponent(String($Table.attr('data-name') || ''));
      if (!UUID || !Name) return;
      const Ticks: Partial<Record<ApplicationConditionField, boolean>> = {};
      $Table.find('input[type="checkbox"][data-rule]').each(function () {
        Ticks[String($(this).attr('data-rule')) as ApplicationConditionField] =
          $(this).is(':checked');
      });
      const Payload = ApplicationConditionsPayload(Name, Ticks);
      return Saves.Enqueue(Name, {
        Save: async () => (await window.API.MarkClientApplicationCritical(UUID, Payload))[0],
        Refresh,
        Notify,
        ResetRender: () => $(LIST).attr('data-render-key', ''),
        ErrorContext: 'ClientInfo:SaveApplicationConditions',
      });
    });
}

export const _internal = { SaveChains: Saves.Chains };
