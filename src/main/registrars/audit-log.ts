// IPC registrar: the audit log (read-only). Entries are written by the
// managers and the status recorder; new ones are pushed as AuditLogAppended.

import type { AuditCategory, AuditEntityType, AuditLogQuery } from '@showtrak/protocol';
import { RPC } from '../rpc';
import { Manager as AuditLog } from '../../Modules/AuditLog';

const ENTITY_TYPES = new Set<AuditEntityType>([
  'client',
  'freekiosk',
  'dummy',
  'monitor',
  'group',
  'tag',
  'script',
  'alert-rule',
  'variable',
  'system',
]);
const CATEGORIES = new Set<AuditCategory>(['status', 'edit', 'action']);

// Keep only the fields a query understands, each in its expected shape. Anything
// else is dropped rather than refused: a bad filter reads as no filter.
export function ToAuditLogQuery(Raw: unknown): AuditLogQuery {
  const Input = Raw && typeof Raw === 'object' ? (Raw as Record<string, unknown>) : {};
  const Query: AuditLogQuery = {};
  if (ENTITY_TYPES.has(Input.EntityType as AuditEntityType)) {
    Query.EntityType = Input.EntityType as AuditEntityType;
  }
  if (typeof Input.EntityID === 'string' || typeof Input.EntityID === 'number') {
    const ID = String(Input.EntityID).trim();
    if (ID && ID.length <= 128) Query.EntityID = ID;
  }
  if (CATEGORIES.has(Input.Category as AuditCategory)) {
    Query.Category = Input.Category as AuditCategory;
  }
  if (typeof Input.Search === 'string' && Input.Search.trim()) {
    Query.Search = Input.Search.trim().slice(0, 200);
  }
  const BeforeID = Number(Input.BeforeID);
  if (Input.BeforeID !== null && Input.BeforeID !== undefined && Number.isInteger(BeforeID)) {
    Query.BeforeID = BeforeID;
  }
  const Limit = Number(Input.Limit);
  if (Input.Limit !== null && Input.Limit !== undefined && Number.isFinite(Limit)) {
    Query.Limit = Limit;
  }
  return Query;
}

function register(): void {
  // Reader: one page of entries, newest first. Never fails; an unreadable log
  // is an empty page.
  RPC.handle('AuditLog:Get', async (_Event: unknown, Query: unknown) => {
    return AuditLog.Query(ToAuditLogQuery(Query));
  });
}

export { register };
