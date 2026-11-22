// IP address parsing, shared by the main process (judging a critical network
// interface, validating a request) and the renderer (the network section of the
// client info modal), so the two can never disagree on what an address is.
//
// Compiled into both programs: no Node and no DOM here.

export interface ParsedIP {
  Family: 4 | 6;
  Value: bigint;
}

function ParseIPv4(Text: string): bigint | null {
  const Match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(Text);
  if (!Match) return null;
  let Value = 0n;
  for (let Index = 1; Index <= 4; Index += 1) {
    const Octet = Number(Match[Index]);
    if (Octet > 255) return null;
    Value = (Value << 8n) | BigInt(Octet);
  }
  return Value;
}

function ParseIPv6(Text: string): bigint | null {
  let Body = Text;
  // A dotted IPv4 tail ("::ffff:10.0.0.1") stands for the last two groups.
  let Tail: number[] = [];
  const LastColon = Body.lastIndexOf(':');
  if (LastColon !== -1 && Body.slice(LastColon + 1).includes('.')) {
    const V4 = ParseIPv4(Body.slice(LastColon + 1));
    if (V4 === null) return null;
    Tail = [Number((V4 >> 16n) & 0xffffn), Number(V4 & 0xffffn)];
    Body = Body.slice(0, LastColon + 1);
    if (Body.endsWith(':') && !Body.endsWith('::')) Body = Body.slice(0, -1);
  }
  const Halves = Body.split('::');
  if (Halves.length > 2) return null;
  const Groups = (Part: string) => (Part === '' ? [] : Part.split(':'));
  const Head = Groups(Halves[0] ?? '');
  const Rest = Halves.length === 2 ? Groups(Halves[1] ?? '') : [];
  const Explicit = Head.length + Rest.length + Tail.length;
  if (Halves.length === 1 ? Explicit !== 8 : Explicit > 7) return null;
  const Words: number[] = [];
  for (const Group of [...Head, ...new Array<string>(8 - Explicit).fill('0'), ...Rest]) {
    if (!/^[0-9a-f]{1,4}$/i.test(Group)) return null;
    Words.push(parseInt(Group, 16));
  }
  Words.push(...Tail);
  if (Words.length !== 8) return null;
  return Words.reduce((Value, Word) => (Value << 16n) | BigInt(Word), 0n);
}

/** Parse an IPv4 or IPv6 address (an IPv6 zone suffix is ignored); null when it is not one. */
export function ParseIP(Value: unknown): ParsedIP | null {
  if (typeof Value !== 'string') return null;
  const Text = Value.trim().replace(/%.*$/, '');
  if (!Text || Text.length > 64) return null;
  if (Text.includes(':')) {
    const V6 = ParseIPv6(Text);
    return V6 === null ? null : { Family: 6, Value: V6 };
  }
  const V4 = ParseIPv4(Text);
  return V4 === null ? null : { Family: 4, Value: V4 };
}

/** Whether an address is an IPv6 link-local one (fe80::/10). */
export function IsLinkLocalV6(Address: unknown): boolean {
  const Parsed = ParseIP(Address);
  return !!Parsed && Parsed.Family === 6 && Parsed.Value >> 118n === 0x3fan;
}

/** Dotted-quad text of an IPv4 address's value. */
export function FormatIPv4(Value: bigint): string {
  return [24n, 16n, 8n, 0n].map((Shift) => String((Value >> Shift) & 0xffn)).join('.');
}
