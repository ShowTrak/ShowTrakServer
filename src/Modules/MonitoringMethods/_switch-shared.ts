// Shared pieces for the managed-switch checks (Luminex GigaCore, Netgear AV
// Line): the "Monitored ports" list parser, a JSON-over-HTTP(S) request with a
// hard deadline (GET, POST and PUT, since GigaCore writes are PUTs; the
// transport is ./_videoproc-http-shared's), and the small debug-panel helpers
// both methods render port rows with.
//
// Nothing here logs. Error strings are built from the socket error only, never
// from the URL or headers, so a credential can never end up in a message.
import { URL } from 'url';
import { Card, Esc, Pill } from './debug';
import {
  RequestJson,
  WithPath,
  IsObject,
  StrOrNull,
  NumOrNull,
  type JsonRequest,
  type JsonResponse,
} from './_videoproc-http-shared';

export { WithPath, IsObject, StrOrNull, NumOrNull };

// A port list cannot name more ports than this, so a typo such as 1-99999
// is reported instead of expanding into a huge list.
export const MAX_MONITORED_PORTS = 512;
export const MAX_PORT_NUMBER = 9999;

// --- Monitored ports ------------------------------------------------------------

export interface PortList {
  Ports: number[];
  // Entries that are not a port number or range, as written.
  Invalid: string[];
}

// Parse a 'list' setting of port numbers. Each entry may hold one port (7), a
// range (2-7) or several of either separated by commas or spaces (1-4, 9).
// Ports are returned sorted and de-duplicated; anything unreadable is kept in
// Invalid so the check can report it rather than silently skipping it.
export function ParsePortList(Value: unknown): PortList {
  const Raw = Array.isArray(Value)
    ? Value
    : typeof Value === 'string' || typeof Value === 'number'
      ? [Value]
      : [];
  const Ports = new Set<number>();
  const Invalid: string[] = [];
  for (const Entry of Raw) {
    const Text = String(Entry == null ? '' : Entry).trim();
    if (!Text) continue;
    // "2 - 7" is one range, so close up the spaces around a dash before
    // splitting on commas and whitespace.
    for (const Part of Text.replace(/\s*-\s*/g, '-').split(/[,\s]+/)) {
      if (!Part) continue;
      const Range = /^(\d{1,4})-(\d{1,4})$/.exec(Part);
      const Single = /^\d{1,4}$/.test(Part) ? Number(Part) : NaN;
      if (Range) {
        const From = Number(Range[1]);
        const To = Number(Range[2]);
        if (From < 1 || To < From || To > MAX_PORT_NUMBER || To - From >= MAX_MONITORED_PORTS) {
          Invalid.push(Part);
          continue;
        }
        for (let Port = From; Port <= To; Port++) Ports.add(Port);
      } else if (Single >= 1 && Single <= MAX_PORT_NUMBER) {
        Ports.add(Single);
      } else {
        Invalid.push(Part);
      }
    }
  }
  const Sorted = [...Ports].sort((A, B) => A - B);
  if (Sorted.length > MAX_MONITORED_PORTS) {
    Invalid.push(`more than ${MAX_MONITORED_PORTS} ports`);
    Sorted.length = MAX_MONITORED_PORTS;
  }
  return { Ports: Sorted, Invalid };
}

// Collapse a port list back into ranges for messages: 1-8, 12, 20-21.
export function DescribePorts(Ports: number[]): string {
  const Sorted = [...Ports].sort((A, B) => A - B);
  const Parts: string[] = [];
  for (let I = 0; I < Sorted.length;) {
    let End = I;
    while (End + 1 < Sorted.length && Sorted[End + 1] === (Sorted[End] as number) + 1) End++;
    Parts.push(End > I ? `${Sorted[I]}-${Sorted[End]}` : `${Sorted[I]}`);
    I = End + 1;
  }
  return Parts.join(', ');
}

// Join degraded reasons, keeping the line short when many ports fail at once.
export function JoinReasons(Reasons: string[], Max = 4): string {
  if (Reasons.length <= Max) return Reasons.join('; ');
  return `${Reasons.slice(0, Max).join('; ')}; and ${Reasons.length - Max} more`;
}

// A single port number typed into an action's parameter, or null.
export function ParseActionPort(Value: unknown): number | null {
  const Text = String(Value == null ? '' : Value).trim();
  if (!/^\d{1,4}$/.test(Text)) return null;
  const Port = Number(Text);
  return Port >= 1 && Port <= MAX_PORT_NUMBER ? Port : null;
}

// --- HTTP ---------------------------------------------------------------------------

// The JSON-over-HTTP(S) transport is the one the video processors use; a switch
// request differs only in how a timeout reads.
export type SwitchRequest = Omit<JsonRequest, 'TimeoutError'>;
export type SwitchResponse = JsonResponse;

// Base URL for a switch. Accepts a bare host/IP or a pasted URL (whose scheme
// wins); any path or query on the address is discarded since the API paths are
// fixed. Port 0 keeps the scheme's default.
export function BuildSwitchUrl(
  Address: unknown,
  Scheme: 'http' | 'https',
  Port: number
): URL | null {
  const Trimmed = String(Address == null ? '' : Address).trim();
  if (!Trimmed) return null;
  const HasScheme = /^https?:\/\//i.test(Trimmed);
  let Parsed: URL;
  try {
    Parsed = new URL(HasScheme ? Trimmed : `${Scheme}://${Trimmed}`);
  } catch {
    return null;
  }
  if (Parsed.protocol !== 'http:' && Parsed.protocol !== 'https:') return null;
  if (!Parsed.hostname) return null;
  Parsed.pathname = '/';
  Parsed.search = '';
  Parsed.hash = '';
  Parsed.username = '';
  Parsed.password = '';
  if (Port > 0 && Port <= 65535) Parsed.port = String(Port);
  return Parsed;
}

// Whether the address itself names a scheme (http:// or https://).
export function AddressHasScheme(Address: unknown): boolean {
  return /^https?:\/\//i.test(String(Address == null ? '' : Address).trim());
}

// One request against its deadline. Resolves (never rejects) with the status
// and parsed JSON so the caller decides what each status means.
export function RequestSwitchJson(Url: URL, Request: SwitchRequest): Promise<SwitchResponse> {
  return RequestJson(Url, {
    ...Request,
    TimeoutError: (BudgetMs) => `No reply within ${BudgetMs}ms`,
  });
}

export function Sleep(Ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Ms)));
}

// --- Small value readers (the rest are re-exported above) ---------------------------

export function TimeoutOf(Cfg: Record<string, unknown>, Default: number): number {
  const N = Number(Cfg.Timeout);
  return Number.isFinite(N) && N > 0 ? Math.max(500, Math.min(120000, N | 0)) : Default;
}

// --- Debug helpers ----------------------------------------------------------------

export type PortVerdict = 'ok' | 'warning' | 'danger';

// One monitored port's card: title, a status badge and an optional detail line.
// Every argument may be network-derived; all of it is escaped here.
export function PortCard(
  Title: string,
  Verdict: PortVerdict,
  Badge: string,
  Detail?: string | null
): string {
  return Card({
    Title,
    Badge: Pill(Verdict === 'ok' ? 'success' : Verdict, Badge),
    Highlight: Verdict === 'ok',
    BodyHtml: Detail ? `<div class="text-muted small text-break">${Esc(Detail)}</div>` : '',
  });
}

export function CardList(Title: string, CardsHtml: string[]): string {
  if (!CardsHtml.length) return '';
  return (
    `<div class="mt-2"><span class="text-muted small">${Esc(Title)}</span></div>` +
    `<div class="mt-1 d-grid gap-1">${CardsHtml.join('')}</div>`
  );
}
