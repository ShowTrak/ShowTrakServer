// Generic in-memory cache with TTL + in-flight request deduplication.
//
// Designed for shared use by multiple modules that need to collapse repeated
// work in short windows (for example, concurrent network checks against the
// same host/settings).
const { CreateLogger } = require('../Logger');
const Logger = CreateLogger('CacheManager');

class CacheBucket {
  constructor(Name, Options = {}) {
    this.Name = String(Name || 'default');
    this.DefaultTtlMs = clampTtl(Options.defaultTtlMs, 1000);
    this.MaxEntries = clampCount(Options.maxEntries, 1000);
    this.Map = new Map();
  }

  Get(Key) {
    const Entry = this.Map.get(Key);
    if (!Entry) return null;
    if (isExpired(Entry)) {
      this.Map.delete(Key);
      return null;
    }
    Entry.LastTouchedAt = Date.now();
    return Entry.Value;
  }

  Set(Key, Value, TtlMs) {
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

  Delete(Key) {
    this.Map.delete(Key);
  }

  Clear() {
    this.Map.clear();
  }

  async GetOrCreate(Key, Factory, Options = {}) {
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

    const Entry = {
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

  _enforceSize() {
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

function clampTtl(Value, Fallback) {
  if (!Number.isFinite(Value)) return Math.max(0, Fallback | 0);
  return Math.max(0, Value | 0);
}

function clampCount(Value, Fallback) {
  if (!Number.isFinite(Value)) return Math.max(1, Fallback | 0);
  return Math.max(1, Value | 0);
}

function isExpired(Entry) {
  return !!Entry && Entry.ExpiresAt > 0 && Date.now() > Entry.ExpiresAt;
}

const Buckets = new Map();

const Manager = {};

Manager.GetBucket = (Name, Options = {}) => {
  const BucketName = String(Name || 'default');
  if (Buckets.has(BucketName)) return Buckets.get(BucketName);
  const Bucket = new CacheBucket(BucketName, Options);
  Buckets.set(BucketName, Bucket);
  return Bucket;
};

Manager.ClearBucket = (Name) => {
  const BucketName = String(Name || 'default');
  const Bucket = Buckets.get(BucketName);
  if (!Bucket) return;
  Bucket.Clear();
};

Manager.ClearAll = () => {
  for (const Bucket of Buckets.values()) {
    try {
      Bucket.Clear();
    } catch (Err) {
      Logger.warn('Failed clearing cache bucket', Err);
    }
  }
};

module.exports = { Manager };
