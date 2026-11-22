// The conditions table of a monitored item in the client info modal (an audio
// device, a display, a USB device, a network interface, a volume, an
// application, a system check): one row per condition with its label, its
// value and the tick that monitors it. Every section renders the same markup,
// which the sections' change handlers and the stylesheet key on, so it is built
// here once.
import { Safe } from './utils';

/** What every section's condition rows carry. */
export interface ConditionTableRow {
  Field: string;
  Label: string;
  /** Unsupported rows are dimmed and get no tick. */
  Supported: boolean;
  Checked: boolean;
  /** Always on (the presence row): the tick is shown but cannot be cleared. */
  Locked?: boolean;
  /** The issue this condition currently raises, when it is not met. */
  Failing: string | null;
}

export interface ConditionsTableOptions<R extends ConditionTableRow> {
  /** The section's class, after the SHOWTRAK_AUDIO_CONDITIONS every table carries. */
  Class?: string;
  /** The table's data attributes, naming the item its rows belong to. */
  Attributes: string;
  /** The value cell's content. */
  Value: (Row: R) => string;
  /** Whether a row gets a tick; every supported row when absent. */
  Tickable?: (Row: R) => boolean;
  /** Appended to the tick's accessible name ("Monitor free space (GB)"). */
  LabelSuffix?: (Row: R) => string;
}

export function ConditionsTableHtml<R extends ConditionTableRow>(
  Rows: readonly R[],
  Options: ConditionsTableOptions<R>
): string {
  if (!Rows.length) return '';
  const Class = Options.Class
    ? `SHOWTRAK_AUDIO_CONDITIONS ${Options.Class}`
    : 'SHOWTRAK_AUDIO_CONDITIONS';
  return `
    <table class="${Class}" ${Options.Attributes}>
      <tbody>
        ${Rows.map(
          (Row) => `
          <tr data-cond="${Row.Field}" class="${Row.Supported ? '' : 'is-unsupported'} ${Row.Failing ? 'is-failing' : ''}"
            ${Row.Failing ? `title="${Safe(Row.Failing)}"` : ''}>
            <th scope="row">${Safe(Row.Label)}</th>
            <td>${Options.Value(Row)}</td>
            <td class="SHOWTRAK_AUDIO_COND_CHECK">${
              (Options.Tickable ? Options.Tickable(Row) : Row.Supported)
                ? `<input type="checkbox" class="form-check-input" data-rule="${Row.Field}"
                    ${Row.Checked ? 'checked' : ''} ${Row.Locked ? 'disabled' : ''} aria-label="Monitor ${Safe(Row.Label.toLowerCase())}${Options.LabelSuffix ? Options.LabelSuffix(Row) : ''}" />`
                : ''
            }</td>
          </tr>`
        ).join('')}
      </tbody>
    </table>`;
}

/** The plain value cell: the reading as text. */
export function ConditionValueHtml(Row: { Value: string }): string {
  return `<span class="SHOWTRAK_AUDIO_COND_VALUE">${Safe(Row.Value)}</span>`;
}
