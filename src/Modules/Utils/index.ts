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
