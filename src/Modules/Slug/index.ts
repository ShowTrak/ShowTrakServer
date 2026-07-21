// Slug service.
//
// A "slug" is a stable, human-friendly, URL/OSC-safe identifier used to address
// entities over the API instead of an opaque UUID or autoincrement id. Slugs are
// `^[A-Za-z0-9_-]{1,64}$` (letters, digits, `_` and `-`; mixed case allowed) and
// must be unique within their namespace. Uniqueness is compared case-insensitively
// so `Foo` and `foo` can never both exist — otherwise OSC addressing would be
// ambiguous.
//
// There are two namespaces:
//   * clients  — shared across ALL client-like entities (real Clients,
//                MonitoringTargets and DummyClients). A dummy's slug IS its
//                existing DummyID column; real clients and monitors use a Slug
//                column. Because the namespace spans three tables it cannot be a
//                DB UNIQUE constraint, so uniqueness is enforced here in the app.
//   * groups   — the Groups table's Slug column.
//   * tags     — the Tags table's Slug column (its own independent namespace;
//                the tag slug doubles as the tag's display label).
//
// Scripts have their own slug (the on-disk folder name) owned by ScriptManager
// and are intentionally not modelled here.
import { Manager as DB } from '../DB';
import { CreateLogger } from '../Logger';

const Logger = CreateLogger('Slug');

const MAX_SLUG_LENGTH = 64;
const SLUG_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

// Owner tags disambiguate which row a slug belongs to inside the shared client
// namespace (a Clients UUID and a MonitoringTargets id could otherwise look the
// same). Callers editing an existing entity pass their own tag to exclude it
// from the "is this taken by someone else?" check.
export function ClientOwner(UUID: string): string {
  return `client:${UUID}`;
}
export function MonitorOwner(TargetID: number | string): string {
  return `monitor:${TargetID}`;
}
export function DummyOwner(UUID: string): string {
  return `dummy:${UUID}`;
}
export function TagOwner(TagID: number | string): string {
  return `tag:${TagID}`;
}

// Turn an arbitrary label into a valid slug. Case is preserved (mixed case is
// allowed); spaces and unsupported characters collapse to a single `-`. Returns
// '' when nothing usable remains (caller decides on a fallback base).
export function Slugify(input: unknown): string {
  let s = typeof input === 'string' ? input : input == null ? '' : String(input);
  s = s.trim();
  s = s.replace(/[^A-Za-z0-9_-]+/g, '-'); // spaces + unsupported chars -> dash
  s = s.replace(/-{2,}/g, '-'); // collapse runs of dashes
  s = s.replace(/^[-_]+|[-_]+$/g, ''); // trim leading/trailing separators
  if (s.length > MAX_SLUG_LENGTH) {
    s = s.slice(0, MAX_SLUG_LENGTH).replace(/[-_]+$/g, '');
  }
  return s;
}

export function IsValidSlug(value: unknown): boolean {
  return typeof value === 'string' && SLUG_PATTERN.test(value);
}

// Append `-2`, `-3`, … to Base until the (case-insensitive) result is free.
function Dedupe(Base: string, TakenLower: Set<string>): string {
  const Root = Base || 'item';
  if (!TakenLower.has(Root.toLowerCase())) return Root;
  for (let i = 2; i < 100000; i++) {
    const Candidate = `${Root}-${i}`;
    if (!TakenLower.has(Candidate.toLowerCase())) return Candidate;
  }
  // Practically unreachable; append entropy as a last resort.
  return `${Root}-${Date.now()}`;
}

interface SlugEntry {
  slug: string; // lowercased
  owner: string;
}

// Every slug currently occupying the shared client namespace, lowercased, with
// its owner tag. Rows with a null/empty slug are skipped (they are pending
// back-fill and cannot collide).
async function CollectClientSlugs(): Promise<SlugEntry[]> {
  const Entries: SlugEntry[] = [];

  const [ClientErr, ClientRows] = await DB.All<{ UUID: string; Slug: string | null }>(
    'SELECT UUID, Slug FROM Clients'
  );
  if (ClientErr) Logger.error('Failed to read client slugs', ClientErr);
  for (const Row of ClientRows || []) {
    if (Row && Row.Slug)
      Entries.push({ slug: String(Row.Slug).toLowerCase(), owner: ClientOwner(Row.UUID) });
  }

  const [MonErr, MonRows] = await DB.All<{ TargetID: number; Slug: string | null }>(
    'SELECT TargetID, Slug FROM MonitoringTargets'
  );
  if (MonErr) Logger.error('Failed to read monitoring target slugs', MonErr);
  for (const Row of MonRows || []) {
    if (Row && Row.Slug)
      Entries.push({ slug: String(Row.Slug).toLowerCase(), owner: MonitorOwner(Row.TargetID) });
  }

  const [DummyErr, DummyRows] = await DB.All<{ UUID: string; DummyID: string | null }>(
    'SELECT UUID, DummyID FROM DummyClients'
  );
  if (DummyErr) Logger.error('Failed to read dummy client slugs', DummyErr);
  for (const Row of DummyRows || []) {
    if (Row && Row.DummyID)
      Entries.push({ slug: String(Row.DummyID).toLowerCase(), owner: DummyOwner(Row.UUID) });
  }

  return Entries;
}

async function CollectGroupSlugs(): Promise<SlugEntry[]> {
  const [Err, Rows] = await DB.All<{ GroupID: number; Slug: string | null }>(
    'SELECT GroupID, Slug FROM Groups'
  );
  if (Err) Logger.error('Failed to read group slugs', Err);
  const Entries: SlugEntry[] = [];
  for (const Row of Rows || []) {
    if (Row && Row.Slug)
      Entries.push({ slug: String(Row.Slug).toLowerCase(), owner: `group:${Row.GroupID}` });
  }
  return Entries;
}

async function CollectTagSlugs(): Promise<SlugEntry[]> {
  const [Err, Rows] = await DB.All<{ TagID: number; Slug: string | null }>(
    'SELECT TagID, Slug FROM Tags'
  );
  if (Err) Logger.error('Failed to read tag slugs', Err);
  const Entries: SlugEntry[] = [];
  for (const Row of Rows || []) {
    if (Row && Row.Slug)
      Entries.push({ slug: String(Row.Slug).toLowerCase(), owner: TagOwner(Row.TagID) });
  }
  return Entries;
}

// True when Candidate is already used in the client namespace by an owner other
// than ExceptOwner (pass the editing entity's own owner tag on updates).
export async function IsClientSlugTaken(Candidate: string, ExceptOwner?: string): Promise<boolean> {
  const Lower = String(Candidate).toLowerCase();
  const All = await CollectClientSlugs();
  return All.some((e) => e.slug === Lower && e.owner !== ExceptOwner);
}

export async function IsGroupSlugTaken(Candidate: string, ExceptOwner?: string): Promise<boolean> {
  const Lower = String(Candidate).toLowerCase();
  const All = await CollectGroupSlugs();
  return All.some((e) => e.slug === Lower && e.owner !== ExceptOwner);
}

export async function IsTagSlugTaken(Candidate: string, ExceptOwner?: string): Promise<boolean> {
  const Lower = String(Candidate).toLowerCase();
  const All = await CollectTagSlugs();
  return All.some((e) => e.slug === Lower && e.owner !== ExceptOwner);
}

// Derive a unique client-namespace slug from an arbitrary label. ExceptOwner is
// excluded from the taken set so re-generating for the same row is stable.
export async function GenerateUniqueClientSlug(
  Base: unknown,
  ExceptOwner?: string,
  Fallback = 'client'
): Promise<string> {
  const All = await CollectClientSlugs();
  const Taken = new Set(All.filter((e) => e.owner !== ExceptOwner).map((e) => e.slug));
  return Dedupe(Slugify(Base) || Fallback, Taken);
}

export async function GenerateUniqueGroupSlug(
  Base: unknown,
  ExceptOwner?: string,
  Fallback = 'group'
): Promise<string> {
  const All = await CollectGroupSlugs();
  const Taken = new Set(All.filter((e) => e.owner !== ExceptOwner).map((e) => e.slug));
  return Dedupe(Slugify(Base) || Fallback, Taken);
}

export async function GenerateUniqueTagSlug(
  Base: unknown,
  ExceptOwner?: string,
  Fallback = 'tag'
): Promise<string> {
  const All = await CollectTagSlugs();
  const Taken = new Set(All.filter((e) => e.owner !== ExceptOwner).map((e) => e.slug));
  return Dedupe(Slugify(Base) || Fallback, Taken);
}

// Validate + de-collide a user-supplied slug for the client namespace. Sanitizes
// friendly input (e.g. "Front of House" -> "Front-of-House"); returns an error
// string if nothing usable remains. Does NOT auto-suffix on collision — a manual
// edit that collides is rejected so the operator picks another.
export async function ResolveClientSlugEdit(
  Raw: unknown,
  ExceptOwner: string
): Promise<[string, null] | [null, string]> {
  const Slug = Slugify(Raw);
  if (!Slug) return ['Slug must contain at least one letter, number, - or _', null];
  if (await IsClientSlugTaken(Slug, ExceptOwner)) return [`Slug "${Slug}" is already in use`, null];
  return [null, Slug];
}

export async function ResolveGroupSlugEdit(
  Raw: unknown,
  ExceptOwner: string
): Promise<[string, null] | [null, string]> {
  const Slug = Slugify(Raw);
  if (!Slug) return ['Slug must contain at least one letter, number, - or _', null];
  if (await IsGroupSlugTaken(Slug, ExceptOwner)) return [`Slug "${Slug}" is already in use`, null];
  return [null, Slug];
}

export async function ResolveTagSlugEdit(
  Raw: unknown,
  ExceptOwner: string
): Promise<[string, null] | [null, string]> {
  const Slug = Slugify(Raw);
  if (!Slug) return ['Slug must contain at least one letter, number, - or _', null];
  if (await IsTagSlugTaken(Slug, ExceptOwner)) return [`Slug "${Slug}" is already in use`, null];
  return [null, Slug];
}
