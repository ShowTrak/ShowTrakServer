// The monitored system checks in the client info modal: CPU, Memory and Uptime
// cards on the Info tab (CPU and memory with their usage charts), Power and
// Thermal on the Power & Thermal tab. Each card is styled like a monitored
// display or network interface — a Monitor toggle, the issues it raises, and
// an auto-saving conditions table. The decisions live in lib/system-health.
import type { ClientSystemCheckKey, ClientView, FreeKioskMetricSample } from '@showtrak/protocol';
import { HandleNonFatalError, Safe } from './utils';
import { BuildMetricChartModel, RenderMetricChartSvg } from './lib/metric-chart';
import {
  ParseSystemCheckFields,
  PowerDetailRows,
  SYSTEM_CHECK_FIELDS,
  SystemCheckCardFor,
  TemperatureRows,
  type HealthRow,
  type SystemCheckCard,
  type SystemConditionField,
  type SystemConditionRow,
} from './lib/system-health';

/** Which list each card is drawn into. */
const LISTS: Array<{ Selector: string; Keys: ClientSystemCheckKey[] }> = [
  { Selector: '#SHOWTRAK_CLIENT_INFO_SYSTEM', Keys: ['cpu', 'ram', 'uptime'] },
  { Selector: '#SHOWTRAK_CLIENT_INFO_POWER', Keys: ['power'] },
  { Selector: '#SHOWTRAK_CLIENT_INFO_TEMPERATURES', Keys: ['thermal'] },
];
const ALL_LISTS = LISTS.map((List) => List.Selector).join(', ');
const EDITABLE = 'input[type="number"], select';

// CPU/memory history per client, refetched at most this often while the modal
// is open (the server averages readings into ten-second points anyway).
const VITALS_REFRESH_MS = 5000;
const VitalsCache = new Map<
  string,
  { At: number; Cpu: FreeKioskMetricSample[]; Ram: FreeKioskMetricSample[] }
>();
const VitalsInFlight = new Set<string>();

// Saves of each check's conditions, chained so two quick edits reach the server
// in the order they were made.
const SaveChains = new Map<string, Promise<void>>();

// The last client rendered: a rebuild held back while a limit was being typed
// is applied once the field loses focus, and a history fetch re-renders it.
let Last: ClientView | null = null;
let Pending = false;

function HealthTable(Rows: HealthRow[]): string {
  if (!Rows.length) return '';
  return `
    <table class="SHOWTRAK_HEALTH_TABLE mt-1">
      <tbody>
        ${Rows.map(
          (Row) => `
          <tr class="${Row.Tone === 'bad' ? 'is-failing' : Row.Tone === 'good' ? 'is-healthy' : ''}">
            <th scope="row">${Safe(Row.Label)}</th>
            <td>${Safe(Row.Value)}</td>
          </tr>`
        ).join('')}
      </tbody>
    </table>`;
}

function ConditionCell(Row: SystemConditionRow): string {
  if (!Row.Supported) return `<span class="SHOWTRAK_AUDIO_COND_VALUE">Unsupported</span>`;
  const Input = Row.Input;
  if (!Input) return `<span class="SHOWTRAK_AUDIO_COND_VALUE">${Safe(Row.Value)}</span>`;
  if (Input.Kind === 'select') {
    return `
      <span class="SHOWTRAK_AUDIO_COND_BOUND SHOWTRAK_SYSTEM_COND_SELECT">
        <select data-rule="${Row.Field}" data-default="${Safe(Input.Default)}" aria-label="${Safe(Row.Label)}">
          <option value="" ${Input.Value ? '' : 'selected'}>—</option>
          ${(Input.Options || [])
            .map(
              (Option) =>
                `<option value="${Safe(Option.Value)}" ${Option.Value === Input.Value ? 'selected' : ''}>${Safe(Option.Label)}</option>`
            )
            .join('')}
        </select>
      </span>`;
  }
  return `
    <span class="SHOWTRAK_AUDIO_COND_BOUND">
      <input type="number" min="${Input.Min ?? ''}" max="${Input.Max ?? ''}" step="1" data-rule="${Row.Field}"
        value="${Safe(Input.Value)}" placeholder="${Safe(Input.Default)}"
        data-default="${Safe(Input.Default)}" aria-label="${Safe(Row.Label)}" />
      <span>${Safe(Input.Unit)}</span>
    </span>`;
}

function ConditionsTable(Card: SystemCheckCard): string {
  if (!Card.Rows.length) return '';
  return `
    <table class="SHOWTRAK_AUDIO_CONDITIONS SHOWTRAK_SYSTEM_CONDITIONS" data-check="${Card.Key}">
      <tbody>
        ${Card.Rows.map(
          (Row) => `
          <tr data-cond="${Row.Field}" class="${Row.Supported ? '' : 'is-unsupported'} ${Row.Failing ? 'is-failing' : ''}"
            ${Row.Failing ? `title="${Safe(Row.Failing)}"` : ''}>
            <th scope="row">${Safe(Row.Label)}</th>
            <td>${ConditionCell(Row)}</td>
            <td class="SHOWTRAK_AUDIO_COND_CHECK">${
              Row.Supported && Row.Tickable
                ? `<input type="checkbox" class="form-check-input" data-rule="${Row.Field}"
                    ${Row.Checked ? 'checked' : ''} aria-label="Monitor ${Safe(Row.Label.toLowerCase())}" />`
                : ''
            }</td>
          </tr>`
        ).join('')}
      </tbody>
    </table>`;
}

function Toggle(Card: SystemCheckCard): string {
  if (!Card.CanMonitor) return '';
  const Classes = [
    'SHOWTRAK_TOGGLE_CRITICAL_USB',
    'SHOWTRAK_TOGGLE_CRITICAL_AUDIO',
    'SHOWTRAK_TOGGLE_SYSTEM_CHECK',
    Card.Monitored ? 'is-critical' : '',
    Card.Badge.State === 'issue' ? 'is-mismatch-critical' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return `
    <button type="button" class="${Classes}" data-check="${Card.Key}" data-monitored="${Card.Monitored ? '1' : '0'}"
      title="${Safe(Card.Badge.Title)}" aria-label="${Safe(Card.Badge.Title)}">
      <i class="bi ${Card.Badge.Icon}"></i>
      <span>${Safe(Card.Badge.Label)}</span>
    </button>`;
}

/** The usage chart under the CPU or memory card's header. */
export function UsageChartHtml(
  Card: SystemCheckCard,
  Client: ClientView,
  Samples: FreeKioskMetricSample[]
): string {
  const Check = Card.Key === 'cpu' ? Client.SystemChecks?.Cpu : Client.SystemChecks?.Ram;
  const Limit = Check && Check.MaxPercent !== null ? Check.MaxPercent : null;
  const Label = Card.Key === 'cpu' ? 'CPU usage' : 'Memory usage';
  const Model = BuildMetricChartModel(Samples, {
    min: 0,
    max: 100,
    decimals: 0,
    threshold: Limit === null ? null : { operator: 'above', value: Limit },
  });
  return `<div class="SHOWTRAK_SYSTEM_CHART">${RenderMetricChartSvg(Model, {
    label: Label,
    unit: '%',
    decimals: 0,
    formatted: (Value) => `${Math.round(Value)}%`,
  })}</div>`;
}

function Extra(Card: SystemCheckCard, Client: ClientView): string {
  if (Card.Key === 'power' && !Card.Note && Client.PowerStatus) {
    return HealthTable(PowerDetailRows(Client.PowerStatus));
  }
  if (Card.Key === 'thermal' && !Card.Note && Client.Temperatures) {
    const Limit = Client.SystemChecks?.Thermal?.MaxCelsius ?? null;
    const Rows = TemperatureRows(Client.Temperatures, Limit);
    if (Rows.length) return HealthTable(Rows);
    // macOS reports only its thermal verdict; say why there are no sensors.
    const Why = Client.Temperatures.Status.Message;
    return Why ? `<small class="d-block mt-1 text-start text-light">${Safe(Why)}</small>` : '';
  }
  return '';
}

/** One card's markup. Pure: a function of the client and the history handed in. */
export function SystemCardHtml(
  Card: SystemCheckCard,
  Client: ClientView,
  History: { Cpu: FreeKioskMetricSample[]; Ram: FreeKioskMetricSample[] } | null
): string {
  const Note = Card.Note
    ? `<small class="d-block mb-0 text-start ${Card.Note.Tone === 'danger' ? 'st-condition-failing' : 'text-light'}">${Safe(
        Card.Note.Title
      )} — ${Safe(Card.Note.Body)}</small>`
    : '';
  const Chart =
    Card.Key === 'cpu' || Card.Key === 'ram'
      ? UsageChartHtml(
          Card,
          Client,
          (History && (Card.Key === 'cpu' ? History.Cpu : History.Ram)) || []
        )
      : '';
  return `
    <div class="rounded-3 p-2 bg-ghost SHOWTRAK_AUDIO_CARD SHOWTRAK_SYSTEM_CARD" data-check="${Card.Key}">
      <div class="SHOWTRAK_AUDIO_CARD_HEADER">
        <div class="SHOWTRAK_AUDIO_TITLE text-start">
          <h6 class="mb-0">${Safe(Card.Title)}</h6>
          ${Card.Summary ? `<small class="text-light d-block mb-0 text-start">${Safe(Card.Summary)}</small>` : ''}
          ${Note}
        </div>
        ${Toggle(Card)}
      </div>
      ${Chart}
      ${Card.Issues.map(
        (Issue) =>
          `<small class="d-block mt-1 text-start st-condition-failing"><i class="bi bi-exclamation-triangle-fill me-1"></i>${Safe(Issue)}</small>`
      ).join('')}
      ${ConditionsTable(Card)}
      ${Extra(Card, Client)}
    </div>`;
}

function HistoryFor(Client: ClientView) {
  const Cached = VitalsCache.get(Client.UUID);
  const Now = Date.now();
  if ((!Cached || Now - Cached.At >= VITALS_REFRESH_MS) && !VitalsInFlight.has(Client.UUID)) {
    const UUID = Client.UUID;
    VitalsInFlight.add(UUID);
    void Promise.resolve(window.API.GetClientVitalsHistory(UUID))
      .then((History) => {
        VitalsCache.set(UUID, {
          At: Date.now(),
          Cpu: Array.isArray(History?.Cpu) ? History.Cpu : [],
          Ram: Array.isArray(History?.Ram) ? History.Ram : [],
        });
        if (Last && Last.UUID === UUID) RenderClientInfoSystem(Last);
      })
      .catch((err) => HandleNonFatalError('ClientInfo:LoadVitalsHistory', err))
      .finally(() => VitalsInFlight.delete(UUID));
  }
  return Cached || null;
}

/** Draw every system-check card, each list rebuilt only when what it shows changed. */
export function RenderClientInfoSystem(Client: ClientView): void {
  Last = Client;
  // Never rebuild under the operator's typing; catch up when they leave the field.
  if ($(ALL_LISTS).find(`${EDITABLE}`).filter(':focus').length) {
    Pending = true;
    return;
  }
  Pending = false;
  const History = HistoryFor(Client);
  for (const List of LISTS) {
    const Html = List.Keys.map((Key) =>
      SystemCardHtml(SystemCheckCardFor(Client, Key), Client, History)
    ).join('');
    const $List = $(List.Selector);
    if ($List.attr('data-render-key') === Html) continue;
    $List.attr('data-render-key', Html).html(Html);
  }
}

/** Empty every list (an SDK client reports nothing to judge). */
export function ClearClientInfoSystem(): void {
  Last = null;
  Pending = false;
  $(ALL_LISTS).attr('data-render-key', '').html('');
}

/** Read a conditions table back into a request and save it. */
function SaveConditions(
  $Table: JQuery,
  UUID: string,
  Refresh: () => Promise<void>,
  Notify: (Message: string, Type?: string, Duration?: number) => unknown
): Promise<void> {
  const Key = String($Table.attr('data-check') || '') as ClientSystemCheckKey;
  const Fields: Partial<Record<SystemConditionField, string | boolean>> = {};
  for (const Field of SYSTEM_CHECK_FIELDS[Key] || []) {
    const $Row = $Table.find(`[data-cond="${Field}"]`);
    if (!$Row.length || $Row.hasClass('is-unsupported')) continue;
    const $Check = $Row.find('input[type="checkbox"]');
    const $Value = $Row.find(EDITABLE);
    if (Field === 'RequireMains') {
      Fields[Field] = $Check.is(':checked');
    } else if (!$Check.length) {
      Fields[Field] = String($Value.val() ?? '');
    } else {
      Fields[Field] = $Check.is(':checked') ? String($Value.val() ?? '') : '';
    }
  }
  const Parsed = ParseSystemCheckFields(Key, Fields);
  const Previous = SaveChains.get(Key) || Promise.resolve();
  const Next = Previous.then(async () => {
    try {
      if ('Error' in Parsed) {
        Notify(Parsed.Error, 'error');
      } else {
        const [Err] = await window.API.MarkClientSystemCheck(
          UUID,
          Parsed.Payload as unknown as Parameters<typeof window.API.MarkClientSystemCheck>[1]
        );
        // A later edit is already queued: its refresh shows the final state.
        if (!Err) return void (SaveChains.get(Key) === Next && (await Refresh()));
        Notify(String(Err), 'error');
      }
      // Put back what is really saved.
      $(ALL_LISTS).attr('data-render-key', '');
      await Refresh();
    } catch (err) {
      HandleNonFatalError('ClientInfo:SaveSystemConditions', err);
    }
  });
  SaveChains.set(Key, Next);
  void Next.finally(() => {
    if (SaveChains.get(Key) === Next) SaveChains.delete(Key);
  });
  return Next;
}

/** Wire the cards' controls. `Refresh` re-fetches and re-renders the client. */
export function BindClientInfoSystemHandlers(
  GetUUID: () => string | null,
  Refresh: () => Promise<void>,
  Notify: (Message: string, Type?: string, Duration?: number) => unknown
): void {
  $(ALL_LISTS)
    .off('.client-system')
    .on('click.client-system', '.SHOWTRAK_TOGGLE_SYSTEM_CHECK', async function () {
      try {
        const UUID = GetUUID();
        const Key = String($(this).attr('data-check') || '') as ClientSystemCheckKey;
        if (!UUID || !Key) return;
        const Monitored = String($(this).attr('data-monitored') || '0') === '1';
        const [Err] = Monitored
          ? await window.API.RemoveClientSystemCheck(UUID, Key)
          : await window.API.MarkClientSystemCheck(UUID, { Key });
        if (Err) return void Notify(String(Err), 'error');
        const Title = $(this).closest('.SHOWTRAK_SYSTEM_CARD').find('h6').first().text() || 'Check';
        await Notify(
          Monitored ? `${Title} no longer monitored.` : `${Title} is now monitored.`,
          'success',
          1400
        );
        await Refresh();
      } catch (err) {
        HandleNonFatalError('ClientInfo:ToggleSystemCheck', err);
      }
    })
    // Conditions save as they change: a tick, a limit once typed, a choice.
    .on(
      'change.client-system',
      '.SHOWTRAK_SYSTEM_CONDITIONS input, .SHOWTRAK_SYSTEM_CONDITIONS select',
      function () {
        const UUID = GetUUID();
        const $Input = $(this);
        const $Table = $Input.closest('.SHOWTRAK_SYSTEM_CONDITIONS');
        if (!UUID || !$Table.length) return;
        const $Row = $Input.closest('[data-cond]');
        const $Check = $Row.find('input[type="checkbox"]');
        const $Value = $Row.find(EDITABLE);
        if ($Value.length && $Check.length) {
          if ($Input.attr('type') === 'checkbox') {
            // Ticking a row with nothing set starts from the usual limit.
            if (!$Input.is(':checked')) $Value.val('');
            else if (!String($Value.val() ?? '').trim()) {
              $Value.val(String($Value.attr('data-default') || ''));
            }
          } else {
            // Setting a limit monitors it; clearing it stops.
            $Check.prop('checked', String($Input.val() ?? '').trim() !== '');
          }
        }
        return SaveConditions($Table, UUID, Refresh, Notify);
      }
    )
    // Enter commits a typed value, as leaving the field does.
    .on(
      'keydown.client-system',
      '.SHOWTRAK_SYSTEM_CONDITIONS input[type="number"]',
      function (Event) {
        if (Event.key === 'Enter') $(this).trigger('blur');
      }
    )
    .on('focusout.client-system', `.SHOWTRAK_SYSTEM_CONDITIONS ${EDITABLE}`, function () {
      // Apply a rebuild held back while this field had focus — after the
      // `change` that fires first has had its chance to save.
      setTimeout(() => {
        if (!Pending || !Last) return;
        if ($(ALL_LISTS).find(EDITABLE).filter(':focus').length) return;
        RenderClientInfoSystem(Last);
      }, 0);
    });
}

export const _internal = { SaveChains, VitalsCache };
