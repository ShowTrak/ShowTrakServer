// Small shared utilities: an async wait helper plus the `[Err, Data]`
// result-tuple constructors (`Ok`/`Fail`) used by every ShowTrak manager.
// See src/types/result.ts for the Result<T> contract.
//
// Exported as named functions; the CommonJS shape stays `{ Wait, Ok, Fail }`
// so `const { Wait } = require('../Utils')` continues to work unchanged.
import type { Result } from '../../types/result';

export function Wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function Ok<T = null>(value: T = null as T): Result<T> {
  return [null, value];
}

export function Fail<T = null>(error: string, value: T = null as T): Result<T> {
  return [error || 'Unknown Error', value] as Result<T>;
}

// Order two dotted version strings ("3.29.3") numerically, part by part:
// negative when a is older than b, positive when newer, 0 when equal. A
// pre-release suffix is compared as further numeric parts.
export function CompareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  const pb = b.split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
