// Condition evaluation for workflow If steps.
//
// Pure and I/O-free.
//
// Two invariants are inherited deliberately from the FreeKiosk metric alarms
// (FreeKiosk/alarms.ts), because they were learned the hard way there:
//
//  - An operator states the condition being TESTED, not the healthy state.
//  - A value with no reading NEVER matches. Absence of evidence is not evidence,
//    and a workflow that fires its recovery branch because a check has not
//    reported yet is worse than one that does nothing.
//
// A fresh implementation rather than a reuse of EvaluateMetricAlarm: that one is
// typed against a FreeKioskMetric and is stable, and bending it to serve a
// second caller would put both at risk. The operator NAMES are identical on
// purpose so the two editors read the same.
import type { WorkflowCondition, WorkflowOperator } from './steps';

export interface ConditionResult {
  Matched: boolean;
  // Why, for the run log and the step debugger — e.g.
  // "check.Online (false) is false".
  Reason: string;
}

// Resolve a dotted path against the run context. Returns undefined for anything
// missing, which every operator then treats as "no reading".
export function ResolvePath(Context: unknown, Path: string): unknown {
  const Trimmed = String(Path || '').trim();
  if (!Trimmed) return undefined;
  let Current: unknown = Context;
  for (const Part of Trimmed.split('.')) {
    if (Current == null || typeof Current !== 'object') return undefined;
    Current = (Current as Record<string, unknown>)[Part];
  }
  return Current;
}

function AsNumber(Value: unknown): number | null {
  if (typeof Value === 'boolean') return Value ? 1 : 0;
  if (Value === null || Value === undefined || Value === '') return null;
  const N = Number(Value);
  return Number.isFinite(N) ? N : null;
}

function AsBoolean(Value: unknown): boolean | null {
  if (typeof Value === 'boolean') return Value;
  if (Value === 'true' || Value === 1 || Value === '1') return true;
  if (Value === 'false' || Value === 0 || Value === '0') return false;
  return null;
}

function Display(Value: unknown): string {
  if (Value === null || Value === undefined) return 'nothing';
  if (typeof Value === 'string') return `"${Value}"`;
  return String(Value);
}

export function EvaluateCondition(Condition: WorkflowCondition, Context: unknown): ConditionResult {
  const Left = ResolvePath(Context, Condition.Left);
  const Path = String(Condition.Left || '').trim();

  // No reading, no match — for every operator, without exception.
  if (Left === undefined || Left === null || Left === '') {
    return { Matched: false, Reason: `${Path || 'value'} has no reading` };
  }

  const Operator: WorkflowOperator = Condition.Operator;
  const Describe = (Verb: string, Rhs: unknown = Condition.Right) =>
    `${Path} (${Display(Left)}) ${Verb} ${Display(Rhs)}`;

  // Numeric comparisons where both sides read as numbers. Booleans count as
  // 0/1 so "check.Online is true" and "above 0" both behave sanely.
  if (Operator === 'above' || Operator === 'below') {
    const L = AsNumber(Left);
    const R = AsNumber(Condition.Right);
    if (L === null || R === null) {
      return { Matched: false, Reason: `${Path} is not a number` };
    }
    const Matched = Operator === 'above' ? L > R : L < R;
    return { Matched, Reason: Describe(Operator === 'above' ? 'is above' : 'is below') };
  }

  if (Operator === 'inside' || Operator === 'outside') {
    const L = AsNumber(Left);
    const A = AsNumber(Condition.Right);
    const B = AsNumber(Condition.Right2);
    if (L === null || A === null || B === null) {
      return { Matched: false, Reason: `${Path} needs two numeric bounds` };
    }
    // Tolerate the bounds entered the wrong way round rather than silently
    // never matching.
    const Low = Math.min(A, B);
    const High = Math.max(A, B);
    const Within = L >= Low && L <= High;
    return {
      Matched: Operator === 'inside' ? Within : !Within,
      Reason: `${Path} (${Display(Left)}) is ${Operator} ${Low}–${High}`,
    };
  }

  if (Operator === 'contains' || Operator === 'notContains') {
    const L = String(Left).toLowerCase();
    const R = String(Condition.Right ?? '')
      .trim()
      .toLowerCase();
    if (!R) return { Matched: false, Reason: `${Path} has nothing to compare against` };
    const Has = L.includes(R);
    return {
      Matched: Operator === 'contains' ? Has : !Has,
      Reason: Describe(Operator === 'contains' ? 'contains' : 'does not contain'),
    };
  }

  // is / isNot. Compare as booleans when both sides look boolean, as numbers
  // when both look numeric, and case-insensitively as text otherwise — so
  // "true" from a select field matches a real boolean reading.
  const LeftBool = AsBoolean(Left);
  const RightBool = AsBoolean(Condition.Right);
  let Equal: boolean;
  if (LeftBool !== null && RightBool !== null) {
    Equal = LeftBool === RightBool;
  } else {
    const L = AsNumber(Left);
    const R = AsNumber(Condition.Right);
    Equal =
      L !== null && R !== null
        ? L === R
        : String(Left).trim().toLowerCase() ===
          String(Condition.Right ?? '')
            .trim()
            .toLowerCase();
  }

  return {
    Matched: Operator === 'is' ? Equal : !Equal,
    Reason: Describe(Operator === 'is' ? 'is' : 'is not'),
  };
}

// Human-readable summary for the editor's step list, built without a context.
export function DescribeCondition(Condition: WorkflowCondition): string {
  const Path = String(Condition.Left || '').trim() || 'value';
  const Right = Display(Condition.Right);
  switch (Condition.Operator) {
    case 'above':
      return `${Path} is above ${Right}`;
    case 'below':
      return `${Path} is below ${Right}`;
    case 'inside':
      return `${Path} is between ${Display(Condition.Right)} and ${Display(Condition.Right2)}`;
    case 'outside':
      return `${Path} is outside ${Display(Condition.Right)}–${Display(Condition.Right2)}`;
    case 'contains':
      return `${Path} contains ${Right}`;
    case 'notContains':
      return `${Path} does not contain ${Right}`;
    case 'isNot':
      return `${Path} is not ${Right}`;
    default:
      return `${Path} is ${Right}`;
  }
}
