// A caching `lookup` for the probes' sockets and HTTP requests.
//
// A check addressed by name resolves it on every probe, and Node resolves with
// getaddrinfo on libuv's small thread pool (4 threads by default), which file
// I/O and crypto share. A name that does not resolve is worse: a failing .local
// (mDNS) or LLMNR lookup can hold a pool thread for seconds, so a few dead
// hostnames polled every few seconds could keep the pool busy. Answers are
// reused for POSITIVE_TTL_MS, failures for NEGATIVE_TTL_MS, and concurrent
// lookups of one name share a single query.
//
// Drop-in for the `lookup` option of net.connect, http(s).request and
// dgram.createSocket. IP literals never reach the resolver.
import dns from 'dns';
import net from 'net';

const POSITIVE_TTL_MS = 60_000;
const NEGATIVE_TTL_MS = 10_000;
const MAX_ENTRIES = 1000;

type LookupCallback = (
  Err: NodeJS.ErrnoException | null,
  Address: string | dns.LookupAddress[],
  Family?: number
) => void;

interface CacheEntry {
  Expires: number;
  Error: NodeJS.ErrnoException | null;
  Addresses: dns.LookupAddress[];
}

const Cache = new Map<string, CacheEntry>();
const InFlight = new Map<string, Array<(Entry: CacheEntry) => void>>();

function Answer(Entry: CacheEntry, All: boolean, Family: number, Callback: LookupCallback): void {
  if (Entry.Error) {
    Callback(Entry.Error, All ? [] : '', Family || undefined);
    return;
  }
  if (All) {
    Callback(
      null,
      Entry.Addresses.map((A) => ({ ...A }))
    );
    return;
  }
  const First = Entry.Addresses[0]!;
  Callback(null, First.address, First.family);
}

function Remember(Key: string, Entry: CacheEntry): void {
  if (Cache.size >= MAX_ENTRIES) {
    const Now = Date.now();
    for (const [K, E] of Cache) if (E.Expires <= Now) Cache.delete(K);
    // Still full of live names: drop the oldest.
    while (Cache.size >= MAX_ENTRIES) Cache.delete(Cache.keys().next().value!);
  }
  Cache.set(Key, Entry);
}

// lookup(hostname, [options | family], callback), as net, http and dgram call it.
export function CachedLookup(
  Hostname: string,
  OptionsOrCallback: dns.LookupOptions | number | LookupCallback | undefined,
  MaybeCallback?: LookupCallback
): void {
  const Callback = (
    typeof OptionsOrCallback === 'function' ? OptionsOrCallback : MaybeCallback
  ) as LookupCallback;
  const Options: dns.LookupOptions =
    typeof OptionsOrCallback === 'number'
      ? { family: OptionsOrCallback }
      : typeof OptionsOrCallback === 'object' && OptionsOrCallback
        ? OptionsOrCallback
        : {};
  const Family = Number(Options.family) || 0;
  const All = Options.all === true;
  const Name = String(Hostname || '');

  // Nothing to resolve (an IP literal), or nothing sensible to cache: straight
  // to the resolver with the caller's own options.
  if (!Name || net.isIP(Name)) {
    dns.lookup(Name, Options as dns.LookupAllOptions, Callback as never);
    return;
  }

  const Key = `${Family}|${Options.hints || 0}|${Name.toLowerCase()}`;
  const Hit = Cache.get(Key);
  if (Hit && Hit.Expires > Date.now()) {
    process.nextTick(() => Answer(Hit, All, Family, Callback));
    return;
  }

  const Waiting = InFlight.get(Key);
  const Waiter = (Entry: CacheEntry) => Answer(Entry, All, Family, Callback);
  if (Waiting) {
    Waiting.push(Waiter);
    return;
  }
  InFlight.set(Key, [Waiter]);
  dns.lookup(
    Name,
    { family: Family, hints: Options.hints, all: true },
    (Err: NodeJS.ErrnoException | null, Addresses: dns.LookupAddress[]) => {
      const Ok = !Err && Array.isArray(Addresses) && Addresses.length > 0;
      const Entry: CacheEntry = Ok
        ? { Expires: Date.now() + POSITIVE_TTL_MS, Error: null, Addresses }
        : {
            Expires: Date.now() + NEGATIVE_TTL_MS,
            Error:
              Err ||
              Object.assign(new Error(`getaddrinfo ENOTFOUND ${Name}`), {
                code: 'ENOTFOUND',
                hostname: Name,
              }),
            Addresses: [],
          };
      Remember(Key, Entry);
      const Callbacks = InFlight.get(Key) || [];
      InFlight.delete(Key);
      for (const Each of Callbacks) Each(Entry);
    }
  );
}

// The host to give http.request() for a URL. URL.hostname keeps the brackets
// around an IPv6 literal ("[fd00::5]"), which Node would then try to resolve as
// a name and fail with ENOTFOUND; Node's own http.get(url) strips them too.
export function RequestHostname(Url: URL): string {
  return Url.hostname.replace(/^\[|\]$/g, '');
}

// Forget every cached answer (tests; or after the network changed under us).
export function ClearLookupCache(): void {
  Cache.clear();
}
