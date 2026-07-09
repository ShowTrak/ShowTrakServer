// Generic in-memory cache with TTL + in-flight request deduplication.
//
// Designed for shared use by multiple modules that need to collapse repeated
// work in short windows (for example, concurrent network checks against the
// same host/settings).
import { CreateLogger } from '../Logger';

const Logger = CreateLogger('CacheManager');

interface CacheEntry {
  Value: unknown;
  ExpiresAt: number;
  InFlight: Promise<unknown> | null;
  CreatedAt: number;
  LastTouchedAt: number;
}

interface CacheBucketOptions {
  defaultTtlMs?: number;
  maxEntries?: number;
}

interface GetOrCreateOptions {
  ttlMs?: number;
  cacheErrors?: boolean;
}

class CacheBucket {
  Name: string;
  DefaultTtlMs: number;
  MaxEntries: number;
  Map: Map<string, CacheEntry>;

  constructor(Name: string, Options: CacheBucketOptions = {}) {
    this.Name = String(Name || 'default');
    this.DefaultTtlMs = clampTtl(Options.defaultTtlMs, 1000);
    this.MaxEntries = clampCount(Options.maxEntries, 1000);
    this.Map = new Map();
  }

  Get(Key: string): unknown {
    const Entry = this.Map.get(Key);
    if (!Entry) return null;
    if (isExpired(Entry)) {
      this.Map.delete(Key);
      return null;
    }
    Entry.LastTouchedAt = Date.now();
    return Entry.Value;
  }

  Set(Key: string, Value: unknown, TtlMs?: number): unknown {
    const Now = Date.now();
    const ttl = clampTtl(TtlMs, this.DefaultTtlMs);
    this.Map.set(Key, {
      Value,
      ExpiresAt: ttl > 0 ? Now + ttl : 0,
      InFlight: null,
      CreatedAt: Now,
      LastTouchedAt: Now,
    });
    this._enforceSize();
    return Value;
  }

  Delete(Key: string): void {
    this.Map.delete(Key);
  }

  Clear(): void {
    this.Map.clear();
  }

  async GetOrCreate(
    Key: string,
    Factory: () => unknown | Promise<unknown>,
    Options: GetOrCreateOptions = {}
  ): Promise<unknown> {
    const Now = Date.now();
    const Existing = this.Map.get(Key);
    if (Existing) {
      if (!isExpired(Existing) && Existing.Value !== undefined) {
        Existing.LastTouchedAt = Now;
        return Existing.Value;
      }
      if (Existing.InFlight) return Existing.InFlight;
      if (isExpired(Existing)) this.Map.delete(Key);
    }

    const ttl = clampTtl(Options.ttlMs, this.DefaultTtlMs);
    const keepErrors = !!Options.cacheErrors;

    const Entry: CacheEntry = {
      Value: undefined,
      ExpiresAt: 0,
      InFlight: null,
      CreatedAt: Now,
      LastTouchedAt: Now,
    };

    const PromiseInFlight = Promise.resolve()
      .then(Factory)
      .then((Value) => {
        Entry.Value = Value;
        Entry.ExpiresAt = ttl > 0 ? Date.now() + ttl : 0;
        Entry.InFlight = null;
        Entry.LastTouchedAt = Date.now();
        if (ttl <= 0) {
          this.Map.delete(Key);
        } else {
          this.Map.set(Key, Entry);
          this._enforceSize();
        }
        return Value;
      })
      .catch((Err) => {
        Entry.InFlight = null;
        if (keepErrors && ttl > 0) {
          Entry.Value = Err;
          Entry.ExpiresAt = Date.now() + ttl;
          this.Map.set(Key, Entry);
          this._enforceSize();
        } else {
          this.Map.delete(Key);
        }
        throw Err;
      });

    Entry.InFlight = PromiseInFlight;
    this.Map.set(Key, Entry);
    this._enforceSize();
    return PromiseInFlight;
  }

  _enforceSize(): void {
    if (this.Map.size <= this.MaxEntries) return;

    // First pass: evict expired entries.
    for (const [Key, Entry] of this.Map) {
      if (isExpired(Entry)) this.Map.delete(Key);
      if (this.Map.size <= this.MaxEntries) return;
    }

    // Second pass: evict least-recently-touched entries.
    const Entries = Array.from(this.Map.entries()).sort(
      (a, b) => Number(a[1].LastTouchedAt || 0) - Number(b[1].LastTouchedAt || 0)
    );
    const ToRemove = Math.max(0, this.Map.size - this.MaxEntries);
    for (let i = 0; i < ToRemove; i++) {
      this.Map.delete(Entries[i][0]);
    }
  }
}

function clampTtl(Value: number | undefined, Fallback: number): number {
  if (!Number.isFinite(Value)) return Math.max(0, Fallback | 0);
  return Math.max(0, Number(Value) | 0);
}

function clampCount(Value: number | undefined, Fallback: number): number {
  if (!Number.isFinite(Value)) return Math.max(1, Fallback | 0);
  return Math.max(1, Number(Value) | 0);
}

function isExpired(Entry: CacheEntry | undefined): boolean {
  return !!Entry && Entry.ExpiresAt > 0 && Date.now() > Entry.ExpiresAt;
}

const Buckets = new Map<string, CacheBucket>();

export const Manager = {
  GetBucket(Name: string, Options: CacheBucketOptions = {}): CacheBucket {
    const BucketName = String(Name || 'default');
    const Existing = Buckets.get(BucketName);
    if (Existing) return Existing;
    const Bucket = new CacheBucket(BucketName, Options);
    Buckets.set(BucketName, Bucket);
    return Bucket;
  },

  ClearBucket(Name: string): void {
    const BucketName = String(Name || 'default');
    const Bucket = Buckets.get(BucketName);
    if (!Bucket) return;
    Bucket.Clear();
  },

  ClearAll(): void {
    for (const Bucket of Buckets.values()) {
      try {
        Bucket.Clear();
      } catch (Err) {
        Logger.warn('Failed clearing cache bucket', Err);
      }
    }
  },
};
