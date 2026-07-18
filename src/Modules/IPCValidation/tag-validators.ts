// Tag IPC validators. Normalizes the identifiers/payloads used by the Tag
// Manager handlers (Tags:*). Slug validation is shared with groups/clients
// (Manager.Slug); colour is a palette index; scope mirrors the alert/whitelist
// scope shape but — because tags apply to every client kind — its Clients are
// scoped-ID strings (plain UUID, or monitor:/check:… prefixes), not bare UUIDs.
import { fail, isPlainObject } from './primitives';
import type { IPCValidationManager } from './index';

// A scoped client identifier as produced by the scope-dropdown: a UUID, or a
// prefixed form like "monitor:12" / "check:3". Kept permissive (the same
// character set as a slug plus ':') so future entity kinds need no change here.
const SCOPED_ID_PATTERN = /^[A-Za-z0-9_:-]{1,128}$/;

export = function registerTagValidators(Manager: IPCValidationManager): void {
  Manager.TagID = (value: unknown, fieldName = 'TagID') => {
    if (typeof value === 'number') {
      if (!Number.isInteger(value) || value <= 0) fail(`${fieldName} must be a positive integer`);
      return value;
    }
    if (typeof value === 'string') {
      const normalized = value.trim();
      if (!/^\d+$/.test(normalized)) fail(`${fieldName} must be numeric`);
      return parseInt(normalized, 10);
    }
    fail(`${fieldName} is invalid`);
    // unreachable — fail throws
    return 0;
  };

  Manager.TagColour = (value: unknown, fieldName = 'Colour') => {
    const N = typeof value === 'string' ? Number(value.trim()) : value;
    if (typeof N !== 'number' || !Number.isInteger(N) || N < 0) {
      fail(`${fieldName} must be a non-negative integer`);
    }
    return N as number;
  };

  Manager.TagScope = (value: unknown) => {
    if (!isPlainObject(value)) fail('Tag scope must be an object');
    const Groups: number[] = [];
    if (Array.isArray(value.Groups)) {
      for (const g of value.Groups) {
        const id = Manager.GroupID(g, 'Tag scope group ID');
        if (id != null) Groups.push(id);
      }
    }
    const Clients: string[] = [];
    if (Array.isArray(value.Clients)) {
      for (const c of value.Clients) {
        if (typeof c !== 'string') fail('Tag scope client entries must be strings');
        const normalized = c.trim();
        if (!normalized) continue;
        if (!SCOPED_ID_PATTERN.test(normalized)) fail('Tag scope client entry is invalid');
        Clients.push(normalized);
      }
    }
    return {
      Workspace: !!value.Workspace,
      Groups: Array.from(new Set(Groups)),
      Clients: Array.from(new Set(Clients)),
    };
  };
};
