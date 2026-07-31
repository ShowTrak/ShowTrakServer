// Row <-> view conversion for workflows. Pure; mirrors
// AlertsManager/serialization.ts.
import { NormalizeSteps, type WorkflowStep } from './steps';
import { NormalizeTriggers, type WorkflowTriggers } from './triggers';

// The Return section: the single value a workflow hands back to its caller.
//
// This is what lets one workflow call another and lets shared logic be pulled
// out into its own workflow. Declaring a Name and Type means the caller's editor
// can say what it is getting rather than presenting an opaque value.
export interface WorkflowReturn {
  Name: string;
  Type: 'string' | 'number' | 'boolean';
  // Context path resolved when the run settles, e.g. vars.answer.
  From: string;
  // Used when the run aborts, hits a stop step, or From resolves to nothing —
  // so a caller never has to handle "no value".
  Fallback: unknown;
}

export interface WorkflowView {
  WorkflowID: number;
  Slug: string | null;
  Name: string;
  Description: string;
  Icon: string;
  Colour: number;
  Triggers: WorkflowTriggers;
  Steps: WorkflowStep[];
  Return: WorkflowReturn;
  Enabled: boolean;
  Weight: number;
  Timestamp: number;
  UpdatedAt: number;
}

export interface WorkflowRowInput {
  WorkflowID: number;
  Slug?: string | null;
  Name?: string;
  Description?: string;
  Icon?: string;
  Colour?: number;
  Triggers?: unknown;
  Steps?: unknown;
  Return?: unknown;
  Enabled?: number | boolean;
  Weight?: number;
  Timestamp?: number;
  UpdatedAt?: number;
}

// Parse a JSON column. Objects pass straight through so a value that has already
// been parsed (or came from a test fixture) is handled identically.
export function parseJson<T>(Value: unknown, Fallback: T): T {
  if (Value == null) return Fallback;
  if (typeof Value === 'object') return Value as T;
  try {
    const Parsed = JSON.parse(String(Value));
    return Parsed == null ? Fallback : (Parsed as T);
  } catch {
    return Fallback;
  }
}

export function NormalizeReturn(Input: unknown): WorkflowReturn {
  const Raw = Input && typeof Input === 'object' ? (Input as Record<string, unknown>) : {};
  const Type = (['string', 'number', 'boolean'] as const).includes(
    Raw.Type as WorkflowReturn['Type']
  )
    ? (Raw.Type as WorkflowReturn['Type'])
    : 'boolean';

  return {
    Name: String(Raw.Name == null ? '' : Raw.Name).trim() || 'Result',
    Type,
    From: String(Raw.From == null ? '' : Raw.From).trim(),
    Fallback: Raw.Fallback === undefined ? CoerceReturnValue(null, Type) : Raw.Fallback,
  };
}

// Coerce a resolved value to the declared Return type. A caller that asked for a
// boolean must get a boolean, whatever the step actually stored.
export function CoerceReturnValue(Value: unknown, Type: WorkflowReturn['Type']): unknown {
  if (Type === 'boolean') {
    if (typeof Value === 'boolean') return Value;
    if (Value === 'true' || Value === 1 || Value === '1' || Value === 'yes') return true;
    if (Value === 'false' || Value === 0 || Value === '0' || Value === 'no') return false;
    return !!Value;
  }
  if (Type === 'number') {
    const N = Number(Value);
    return Number.isFinite(N) ? N : 0;
  }
  return Value == null ? '' : String(Value);
}

export function normalizeWorkflowRow(Row: WorkflowRowInput): WorkflowView {
  return {
    WorkflowID: Number(Row.WorkflowID),
    Slug: Row.Slug == null ? null : String(Row.Slug),
    Name: String(Row.Name == null ? '' : Row.Name),
    Description: String(Row.Description == null ? '' : Row.Description),
    Icon: String(Row.Icon == null || Row.Icon === '' ? 'diagram-3' : Row.Icon),
    Colour: Number.isFinite(Number(Row.Colour)) ? Number(Row.Colour) : 6,
    Triggers: NormalizeTriggers(parseJson<unknown>(Row.Triggers, {})),
    Steps: NormalizeSteps(parseJson<unknown>(Row.Steps, [])).Steps,
    Return: NormalizeReturn(parseJson<unknown>(Row.Return, {})),
    Enabled: !!Row.Enabled,
    Weight: Number.isFinite(Number(Row.Weight)) ? Number(Row.Weight) : 100,
    Timestamp: Number(Row.Timestamp) || 0,
    UpdatedAt: Number(Row.UpdatedAt) || 0,
  };
}
