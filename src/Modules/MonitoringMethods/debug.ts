// Shared helpers for building the small "last response" debug panels that each
// monitoring method renders inside the check editor. Every value that could
// originate from an external system (DNS records, QLab workspace names, HTTP
// bodies, error text, ...) MUST be passed through Esc() before being placed in
// the markup — the resulting HTML is injected into the renderer via innerHTML.
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

export function FormatLatency(Ms: unknown): string {
  const N = Number(Ms);
  if (!Number.isFinite(N)) return '—';
  if (N < 1) return '<1 ms';
  return `${Math.round(N)} ms`;
}

// Format a JSON string for safe display: parse if valid, beautify, escape, wrap in <pre>.
// Returns HTML string. If the input is not valid JSON or can't be beautified, returns
// a note instead.
export function JsonCodeBlock(JsonString: unknown): string {
  if (!JsonString) return Note('No JSON response');
  try {
    const Parsed = JSON.parse(String(JsonString));
    const Beautified = JSON.stringify(Parsed, null, 2);
    return (
      '<pre class="bg-ghost rounded p-2 text-light font-monospace" ' +
      'style="font-size: 0.8rem; overflow-x: auto; max-height: 300px; margin: 0;">' +
      Esc(Beautified) +
      '</pre>'
    );
  } catch (Err) {
    return Note(`Invalid JSON: ${Err instanceof Error ? Err.message : String(Err)}`);
  }
}

// Format JSON with a highlighted path. Attempts to parse and beautify the JSON,
// then marks lines containing the resolved value with a highlight color.
// JsonPath should be a dotted path (e.g. "data.status").
export function JsonCodeBlockWithPath(JsonString: unknown, JsonPath: unknown): string {
  if (!JsonString || !JsonPath) return JsonCodeBlock(JsonString);

  try {
    const Parsed = JSON.parse(String(JsonString));
    const Beautified = JSON.stringify(Parsed, null, 2);
    const Escaped = Esc(Beautified);

    // Try to resolve the path to get the value
    const Parts = String(JsonPath).split('.').filter(Boolean);
    let Cur = Parsed;
    for (const Part of Parts) {
      if (Cur == null) break;
      Cur = Cur[Part];
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
    return Note(`Invalid JSON: ${Err instanceof Error ? Err.message : String(Err)}`);
  }
}
