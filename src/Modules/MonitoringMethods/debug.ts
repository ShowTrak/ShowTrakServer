// Shared helpers for building the small "last response" debug panels that each
// monitoring method renders inside the check editor. Every value that could
// originate from an external system (DNS records, QLab workspace names, HTTP
// bodies, error text, ...) MUST be passed through Esc() before being placed in
// the markup; the resulting HTML is injected into the renderer via innerHTML.
export function Esc(Value: unknown): string {
  return String(Value == null ? '' : Value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const PILL_CLASSES: Record<string, string> = {
  success: 'bg-success text-light',
  warning: 'bg-warning text-dark',
  danger: 'bg-danger text-light',
  muted: 'bg-ghost-light text-light',
};

// A small status badge. `Text` is escaped.
export function Pill(Kind: string, Text: unknown): string {
  const Cls = PILL_CLASSES[Kind] || PILL_CLASSES.muted;
  return `<span class="badge ${Cls}">${Esc(Text)}</span>`;
}

// A single label/value row. `ValueHtml` is treated as pre-built (already-safe)
// HTML so callers can embed pills; plain string values must be escaped by the
// caller before being passed in.
export function Row(Label: unknown, ValueHtml: string): string {
  return (
    '<div class="d-flex justify-content-between align-items-center gap-3 py-1 monitoring-debug-row">' +
    `<span class="text-muted small">${Esc(Label)}</span>` +
    `<span class="text-light small text-end text-break">${ValueHtml}</span>` +
    '</div>'
  );
}

// A row whose value is a plain (untrusted) string; escaped for you.
export function TextRow(Label: unknown, Value: unknown): string {
  return Row(Label, Esc(Value));
}

export function Rows(List?: Array<string | false | null | undefined> | null): string {
  return `<div class="d-grid gap-0">${(List || []).filter(Boolean).join('')}</div>`;
}

export function Note(Text: unknown): string {
  return `<div class="text-muted small fst-italic">${Esc(Text)}</div>`;
}

export interface CardOptions {
  // The card's left-hand title. Escaped for you.
  Title: unknown;
  // Extra class(es) appended to the title span (e.g. 'font-monospace').
  TitleClass?: string;
  // Pre-built badge/pill HTML shown at the card's right edge (already safe).
  Badge?: string | null;
  // Pre-built HTML placed beneath the header row (already safe; escape your own
  // untrusted values before passing them in).
  BodyHtml?: string;
  // Marks the matched/primary item with a subtle success-tinted background. Status
  // is otherwise conveyed by the badge, never a border or a fully-coloured card.
  Highlight?: boolean;
}

// A single card in the "last response" debug panels: a borderless, background-shaded
// row with a title on the left, an optional status badge on the right, and optional
// body content beneath. Fail/error states are conveyed by the badge colour, not by
// tinting the whole card; only a positive match gets the subtle Highlight tint. This
// keeps every method's debug panel consistent with the app's borderless, background-
// shade theme (see .monitoring-debug-card in monitoring.css).
export function Card(Options: CardOptions): string {
  const Cls = 'monitoring-debug-card' + (Options.Highlight ? ' monitoring-debug-card--match' : '');
  const TitleCls =
    'text-light small text-break' + (Options.TitleClass ? ` ${Options.TitleClass}` : '');
  return (
    `<div class="${Cls}">` +
    '<div class="d-flex justify-content-between align-items-center gap-2">' +
    `<span class="${TitleCls}">${Esc(Options.Title)}</span>` +
    (Options.Badge || '') +
    '</div>' +
    (Options.BodyHtml || '') +
    '</div>'
  );
}

export function FormatLatency(Ms: unknown): string {
  const N = Number(Ms);
  if (!Number.isFinite(N)) return '-';
  if (N < 1) return '<1 ms';
  return `${Math.round(N)} ms`;
}

// Longest response body a probe result keeps for its debug panel. A result is
// held for as long as the check runs (and shared through the run cache), and a
// body is read whole (up to 1 MiB) only to judge the probe; the panel needs a
// screenful of it, not the lot.
export const DEBUG_BODY_MAX_CHARS = 64 * 1024;

// A response body as a probe result keeps it for the debug panel: the first
// DEBUG_BODY_MAX_CHARS of it. A longer body is copied rather than sliced, since
// a V8 slice keeps the whole original string alive.
export function DebugBody(Body: unknown): string {
  const Text = typeof Body === 'string' ? Body : Body == null ? '' : String(Body);
  if (Text.length <= DEBUG_BODY_MAX_CHARS) return Text;
  return Buffer.from(Text.slice(0, DEBUG_BODY_MAX_CHARS), 'utf8').toString('utf8');
}

const PRE_OPEN =
  '<pre class="bg-ghost rounded p-2 text-light font-monospace" ' +
  'style="font-size: 0.8rem; overflow-x: auto; max-height: 300px; margin: 0;">';

// A body cut short by DebugBody cannot be parsed, so it is shown as received.
function TruncatedBodyBlock(Text: string): string {
  return (
    Note(`Showing the first ${Math.round(DEBUG_BODY_MAX_CHARS / 1024)} KB of the response.`) +
    PRE_OPEN +
    Esc(Text) +
    '</pre>'
  );
}

// Format a JSON string for safe display: parse if valid, beautify, escape, wrap in <pre>.
// Returns HTML string. If the input is not valid JSON or can't be beautified, returns
// a note instead (or, for a body cut short by DebugBody, the text as received).
export function JsonCodeBlock(JsonString: unknown): string {
  if (!JsonString) return Note('No JSON response');
  try {
    const Parsed: unknown = JSON.parse(String(JsonString));
    const Beautified = JSON.stringify(Parsed, null, 2);
    return (
      '<pre class="bg-ghost rounded p-2 text-light font-monospace" ' +
      'style="font-size: 0.8rem; overflow-x: auto; max-height: 300px; margin: 0;">' +
      Esc(Beautified) +
      '</pre>'
    );
  } catch (Err) {
    return InvalidJsonBlock(JsonString, Err);
  }
}

function InvalidJsonBlock(JsonString: unknown, Err: unknown): string {
  const Text = String(JsonString);
  if (Text.length >= DEBUG_BODY_MAX_CHARS) return TruncatedBodyBlock(Text);
  return Note(`Invalid JSON: ${Err instanceof Error ? Err.message : String(Err)}`);
}

// Format JSON with a highlighted path. Attempts to parse and beautify the JSON,
// then marks lines containing the resolved value with a highlight color.
// JsonPath should be a dotted path (e.g. "data.status").
export function JsonCodeBlockWithPath(JsonString: unknown, JsonPath: unknown): string {
  if (!JsonString || !JsonPath) return JsonCodeBlock(JsonString);

  try {
    const Parsed: unknown = JSON.parse(String(JsonString));
    const Beautified = JSON.stringify(Parsed, null, 2);
    const Escaped = Esc(Beautified);

    // Try to resolve the path to get the value
    const Parts = String(JsonPath).split('.').filter(Boolean);
    let Cur = Parsed;
    for (const Part of Parts) {
      if (Cur == null) break;
      // Any value but null and undefined can be indexed, primitives included (a
      // string's length, say), so this reads exactly what Cur[Part] always did.
      Cur = (Cur as Record<string, unknown>)[Part];
    }

    // If we found a value, try to find and highlight it in the beautified JSON
    if (Cur !== undefined && Cur !== null) {
      const ValueStr = String(Cur);
      // Try to find the value in the escaped output (handles strings, numbers, booleans)
      // For strings, it will be quoted in the JSON
      const QuotedValue = JSON.stringify(Cur);
      const QuotedEscaped = Esc(QuotedValue);

      // Split by lines and highlight lines containing the value
      const Lines = Escaped.split('\n');
      const HighlightedLines = Lines.map((Line) => {
        if (Line.includes(QuotedEscaped) || Line.includes(ValueStr)) {
          return `<span class="bg-success bg-opacity-25">${Line}</span>`;
        }
        return Line;
      });

      return (
        '<pre class="bg-ghost rounded p-2 text-light font-monospace" ' +
        'style="font-size: 0.8rem; overflow-x: auto; max-height: 300px; margin: 0;">' +
        HighlightedLines.join('\n') +
        '</pre>'
      );
    }

    // If we couldn't resolve the path, just show the beautified JSON
    return (
      '<pre class="bg-ghost rounded p-2 text-light font-monospace" ' +
      'style="font-size: 0.8rem; overflow-x: auto; max-height: 300px; margin: 0;">' +
      Escaped +
      '</pre>'
    );
  } catch (Err) {
    return InvalidJsonBlock(JsonString, Err);
  }
}
