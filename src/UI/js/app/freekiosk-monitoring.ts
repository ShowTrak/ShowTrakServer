// A FreeKiosk terminal's monitoring, edited where its readings are shown: one
// card per registry section on the Content, Screen, Battery, Network and Misc
// tabs, styled like a ShowTrak client's monitored items — a Monitor toggle in
// the header over a table of every reading's current value, which, once the
// section is monitored, gains the condition each alerts on and a tick. The
// model is built in lib/freekiosk-monitoring.
//
// The save model is the client cards' too: every toggle, tick and threshold
// saves as it changes. Only the terminal's Settings are sent, merged over what
// is stored, so nothing else about the terminal is touched — and a save still in
// flight is merged into the next one, and into what is drawn meanwhile, so quick
// edits neither undo each other nor flicker back while the push catches up.
import type { FreeKioskMetricView, FreeKioskTerminalView } from '@showtrak/protocol';
import { FreeKioskMetricCatalogCache, FreeKioskTerminals } from './state';
import { HandleNonFatalError, Safe } from './utils';
import { Notify } from './selection-init';
import {
  BuildGroupSettings,
  BuildRowSettings,
  type FreeKioskConditionInput,
  type FreeKioskConditionRow,
  type FreeKioskMonitorCard,
} from './lib/freekiosk-monitoring';

const HOST = '#MONITOR_HISTORY_TIMELINES';
const TYPED = 'input[type="number"], input[type="text"]';
const EDGE_OPERATORS = ['changes', 'decreases'];
const RANGE_OPERATORS = ['outside', 'inside'];

// Settings saved (or being saved) but not yet in the cached terminal, per UUID.
const Overlay = new Map<string, Record<string, unknown>>();
const SaveChains = new Map<string, Promise<void>>();

let Pending = false;
let Rerender: (() => void) | null = null;

/** The terminal's settings as they will be once every save in flight lands. */
export function EffectiveFreeKioskSettings(
  UUID: string,
  Stored: Record<string, unknown> | null | undefined
): Record<string, unknown> {
  return { ...(Stored || {}), ...(Overlay.get(String(UUID)) || {}) };
}

/**
 * True while the operator is typing into a threshold. The view modal rebuilds
 * on every push, which would throw the half-typed value away, so it holds off
 * and redraws once the field loses focus.
 */
export function HoldFreeKioskModalRender(): boolean {
  if (!$(HOST).find(`.FREEKIOSK_CONDITIONS ${TYPED}`).filter(':focus').length) {
    Pending = false;
    return false;
  }
  Pending = true;
  return true;
}

// ---- Markup -------------------------------------------------------------------

function NoteIcon(Note: string | undefined, Placement = 'left'): string {
  if (!Note) return '';
  return `<span class="monitoring-note freekiosk-metric-note" tabindex="0" role="button" aria-label="More information"
    data-bs-toggle="popover" data-bs-trigger="hover focus" data-bs-placement="${Placement}"
    data-bs-content="${Safe(Note)}"><i class="bi bi-info-circle"></i></span>`;
}

function Toggle(Card: FreeKioskMonitorCard): string {
  const Classes = [
    'SHOWTRAK_TOGGLE_CRITICAL_USB',
    'SHOWTRAK_TOGGLE_CRITICAL_AUDIO',
    'FREEKIOSK_TOGGLE_SECTION',
    Card.Monitored ? 'is-critical' : '',
    Card.Badge.State === 'issue' ? 'is-mismatch-critical' : '',
    Card.Badge.State === 'locked' ? 'is-locked' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return `
    <button type="button" class="${Classes}" data-section="${Safe(Card.Section)}"
      data-monitored="${Card.Monitored ? '1' : '0'}" title="${Safe(Card.Badge.Title)}"
      aria-label="${Safe(Card.Badge.Title)}" ${Card.Badge.State === 'locked' ? 'disabled' : ''}>
      <i class="bi ${Card.Badge.Icon}"></i>
      <span>${Safe(Card.Badge.Label)}</span>
    </button>`;
}

function InputHtml(
  Row: FreeKioskConditionRow,
  Input: FreeKioskConditionInput,
  Field: 'V' | 'V2'
): string {
  const Label = `${Row.Label} ${Field === 'V2' ? 'upper bound' : 'threshold'}`;
  if (Input.Kind === 'select') {
    return `<select data-field="${Field}" data-default="${Safe(Input.Default)}" aria-label="${Safe(Label)}">
      ${(Input.Options || [])
        .map(
          (Option) =>
            `<option value="${Safe(Option.Value)}" ${Option.Value === Input.Value ? 'selected' : ''}>${Safe(Option.Label)}</option>`
        )
        .join('')}
    </select>`;
  }
  const Type = Input.Kind === 'number' ? 'number' : 'text';
  const Bounds =
    Input.Kind === 'number'
      ? `min="${Input.Min ?? ''}" max="${Input.Max ?? ''}" step="any"`
      : 'spellcheck="false"';
  return `<input type="${Type}" ${Bounds} data-field="${Field}" value="${Safe(Input.Value)}"
    placeholder="${Safe(Input.Default)}" data-default="${Safe(Input.Default)}" aria-label="${Safe(Label)}" />`;
}

function ConditionCell(Row: FreeKioskConditionRow): string {
  if (!Row.Alarmable) return '';
  const Prefix = Row.OperatorText
    ? `<span class="fk-cond-op-text">${Safe(Row.OperatorText)}</span>`
    : '';
  const Operator = Row.Operators.length
    ? `${Prefix}<select data-field="Op" aria-label="${Safe(Row.Label)} expected">
        ${Row.Operators.map(
          (Option) =>
            `<option value="${Safe(Option.Value)}" ${Option.Value === Row.Operator ? 'selected' : ''}>${Safe(Option.Label)}</option>`
        ).join('')}
      </select>`
    : Prefix;
  const Numeric = Row.Input?.Kind === 'number';
  const Unit = Numeric && Row.Unit ? `<span class="fk-cond-unit">${Safe(Row.Unit)}</span>` : '';
  const Value = Row.Input
    ? `<span class="fk-cond-value${Row.ShowInput ? '' : ' d-none'}">${InputHtml(Row, Row.Input, 'V')}${Row.Input2 ? '' : Unit}</span>`
    : '';
  const Value2 = Row.Input2
    ? `<span class="fk-cond-value2${Row.ShowInput2 ? '' : ' d-none'}"><span class="fk-cond-op-text">to</span>${InputHtml(Row, Row.Input2, 'V2')}${Unit}</span>`
    : '';
  return `<span class="SHOWTRAK_AUDIO_COND_BOUND fk-cond-rule">${Operator}${Value}${Value2}</span>`;
}

function RowHtml(
  Row: FreeKioskConditionRow,
  Monitored: boolean,
  Expected: string,
  Chart: string
): string {
  // An unmonitored section's table is its readings alone: label and value.
  if (!Monitored) {
    return `
    <tr data-metric="${Safe(Row.Key)}">
      <th scope="row">${Safe(Row.Label)}${NoteIcon(Row.Note)}</th>
      <td class="fk-cond-reading">${Safe(Row.ValueText)}</td>
    </tr>`;
  }
  const Classes = [Row.Breaching ? 'is-failing' : '', Row.Alarmable && !Row.Checked ? 'is-off' : '']
    .filter(Boolean)
    .join(' ');
  return `
    <tr data-metric="${Safe(Row.Key)}" class="${Classes}" ${Row.Breaching && Expected ? `title="${Safe(Expected)}"` : ''}>
      <th scope="row">${Safe(Row.Label)}${NoteIcon(Row.Note)}</th>
      <td class="fk-cond-reading">${Safe(Row.ValueText)}${
        Row.Breaching && Expected ? `<small class="fk-cond-expected">${Safe(Expected)}</small>` : ''
      }</td>
      <td class="fk-cond-rule-cell">${ConditionCell(Row)}</td>
      <td class="SHOWTRAK_AUDIO_COND_CHECK">${
        Row.Alarmable
          ? `<input type="checkbox" class="form-check-input" data-field="On" ${Row.Checked ? 'checked' : ''}
              aria-label="Monitor ${Safe(Row.Label.toLowerCase())}" />`
          : ''
      }</td>
    </tr>${Chart ? `<tr class="fk-cond-chart" data-chart-for="${Safe(Row.Key)}"><td colspan="4">${Chart}</td></tr>` : ''}`;
}

/**
 * One section's card. `Expected` words what a breaching reading should be and
 * `Chart` draws an armed reading's history; both come from the view modal,
 * which owns the chart rendering.
 */
export function FreeKioskMonitorCardHtml(
  Card: FreeKioskMonitorCard,
  ModeNote: string,
  Expected: (Key: string) => string,
  Chart: (Key: string) => string
): string {
  const Table = Card.Rows.length
    ? `<table class="SHOWTRAK_AUDIO_CONDITIONS FREEKIOSK_CONDITIONS${Card.Monitored ? '' : ' is-readings-only'}" data-section="${Safe(Card.Section)}">
        <tbody>
          ${Card.Rows.map((Row) =>
            RowHtml(
              Row,
              Card.Monitored,
              Row.Breaching ? Expected(Row.Key) : '',
              Row.Checked ? Chart(Row.Key) : ''
            )
          ).join('')}
        </tbody>
      </table>`
    : '';
  return `
    <div class="rounded-3 p-2 bg-ghost SHOWTRAK_AUDIO_CARD freekiosk-mon-card" data-section="${Safe(Card.Section)}">
      <div class="SHOWTRAK_AUDIO_CARD_HEADER">
        <div class="SHOWTRAK_AUDIO_TITLE text-start">
          <h6 class="mb-0">${Safe(Card.Title)}${NoteIcon(Card.Note, 'right')}</h6>
          <small class="text-light d-block mb-0 text-start">${Safe(Card.Summary)}</small>
        </div>
        ${Toggle(Card)}
      </div>
      ${ModeNote}
      ${Table}
    </div>`;
}

// ---- Saving -------------------------------------------------------------------

function OpenTerminal(UUID: string): FreeKioskTerminalView | null {
  return FreeKioskTerminals.find((Entry) => String(Entry.UUID) === UUID) || null;
}

function SaveSettings(UUID: string, Patch: Record<string, unknown>, Done?: string): Promise<void> {
  Overlay.set(UUID, { ...(Overlay.get(UUID) || {}), ...Patch });
  const Previous = SaveChains.get(UUID) || Promise.resolve();
  const Next = Previous.then(async () => {
    try {
      const Terminal = OpenTerminal(UUID);
      if (!Terminal) return;
      const Settings = EffectiveFreeKioskSettings(UUID, Terminal.Settings);
      const [Err, Saved] = await window.API.UpdateFreeKioskTerminal(UUID, { Settings });
      if (Err) {
        // Put back what is really saved.
        Overlay.delete(UUID);
        void Notify(String(Err), 'error');
        return;
      }
      // Fold the result into the cache now, so dropping the overlay below never
      // shows the old settings while the push is still on its way.
      const Snapshot = Saved as { Settings?: Record<string, unknown> } | null;
      const Cached = OpenTerminal(UUID);
      if (Cached && Snapshot && Snapshot.Settings) Cached.Settings = Snapshot.Settings;
      if (Done && SaveChains.get(UUID) === Next) void Notify(Done, 'success', 1400);
    } catch (err) {
      Overlay.delete(UUID);
      HandleNonFatalError('FreeKioskMonitoring:Save', err);
    }
  });
  SaveChains.set(UUID, Next);
  void Next.finally(() => {
    if (SaveChains.get(UUID) !== Next) return;
    SaveChains.delete(UUID);
    Overlay.delete(UUID);
    if (Rerender) Rerender();
  });
  if (Rerender) Rerender();
  return Next;
}

function MetricFor(Key: string): FreeKioskMetricView | null {
  return FreeKioskMetricCatalogCache?.Metrics.find((Metric) => Metric.Key === Key) || null;
}

// Show the value inputs the chosen operator takes, without waiting for a redraw.
function SyncOperatorInputs($Row: JQuery): void {
  const Op = String($Row.find('[data-field="Op"]').val() ?? '');
  if (!Op) return;
  $Row.find('.fk-cond-value').toggleClass('d-none', EDGE_OPERATORS.includes(Op));
  $Row.find('.fk-cond-value2').toggleClass('d-none', !RANGE_OPERATORS.includes(Op));
}

function SaveRow(UUID: string, $Row: JQuery): void {
  const Catalogue = FreeKioskMetricCatalogCache;
  const Metric = MetricFor(String($Row.attr('data-metric') || ''));
  if (!Catalogue || !Metric) return;
  const Read = (Field: string): string | undefined => {
    const $El = $Row.find(`[data-field="${Field}"]`);
    return $El.length ? String($El.val() ?? '') : undefined;
  };
  const On = $Row.find('[data-field="On"]').is(':checked');
  // A ticked row with an empty threshold starts from the usual one.
  if (On) {
    $Row.find(TYPED).each(function () {
      if (!String($(this).val() ?? '').trim())
        $(this).val(String($(this).attr('data-default') || ''));
    });
  }
  $Row.toggleClass('is-off', !On);
  void SaveSettings(
    UUID,
    BuildRowSettings(Catalogue, Metric, { On, Op: Read('Op'), V: Read('V'), V2: Read('V2') })
  );
}

/** Wire the cards. `GetUUID` names the open terminal; `Redraw` redraws the modal. */
export function WireFreeKioskMonitoring(GetUUID: () => string | null, Redraw: () => void): void {
  Rerender = Redraw;
  $(document)
    .off('.freekioskMonitoring')
    .on(
      'click.freekioskMonitoring',
      `${HOST} .FREEKIOSK_TOGGLE_SECTION:not(:disabled)`,
      function () {
        const UUID = GetUUID();
        const Catalogue = FreeKioskMetricCatalogCache;
        const Section = String($(this).attr('data-section') || '');
        if (!UUID || !Catalogue || !Section) return;
        const Monitored = String($(this).attr('data-monitored') || '0') === '1';
        const Title =
          $(this).closest('.freekiosk-mon-card').find('h6').first().text().trim() || Section;
        void SaveSettings(
          UUID,
          BuildGroupSettings(Catalogue, Section, !Monitored),
          Monitored ? `${Title} no longer monitored.` : `${Title} is now monitored.`
        );
      }
    )
    // Conditions save as they change: a tick, a choice, a threshold once typed.
    // Setting a condition monitors it, as setting a limit does on a client.
    .on('change.freekioskMonitoring', `${HOST} .FREEKIOSK_CONDITIONS [data-field]`, function () {
      const UUID = GetUUID();
      const $Row = $(this).closest('tr[data-metric]');
      if (!UUID || !$Row.length) return;
      if ($(this).attr('data-field') !== 'On') {
        $Row.find('[data-field="On"]').prop('checked', true);
        SyncOperatorInputs($Row);
      }
      SaveRow(UUID, $Row);
    })
    // Enter commits a typed value, as leaving the field does.
    .on('keydown.freekioskMonitoring', `${HOST} .FREEKIOSK_CONDITIONS ${TYPED}`, function (Event) {
      if (Event.key === 'Enter') $(this).trigger('blur');
    })
    .on('focusout.freekioskMonitoring', `${HOST} .FREEKIOSK_CONDITIONS ${TYPED}`, () => {
      // Apply a redraw held back while this field had focus — after the
      // `change` that fires first has had its chance to save.
      setTimeout(() => {
        if (!Pending || HoldFreeKioskModalRender()) return;
        if (Rerender) Rerender();
      }, 0);
    });
}

export const _internal = { Overlay, SaveChains };
