// The pure half of a monitoring target's Actions tab: which of its check types
// offer actions, and what an action parameter can be set to when one press is
// sent to every check of that type. The DOM side is in monitoring-actions.ts.
import type {
  MonitoringActionDef,
  MonitoringCheckView,
  MonitoringMethodView,
} from '@showtrak/protocol';

export interface TargetActionMethod {
  Method: string;
  /** The method's display name, e.g. "PJLink". */
  Name: string;
  /** Every check of this type on the target; an action is sent to all of them. */
  Checks: MonitoringCheckView[];
  Actions: MonitoringActionDef[];
}

/**
 * The target's check types that declare actions, in the order their first check
 * appears on the target, each with every check of that type. A read-only check
 * type (a ping, a DNS probe) has nothing to offer and is left out.
 */
export function GroupTargetActionMethods(
  Checks: readonly MonitoringCheckView[] | null | undefined,
  Methods: readonly Pick<MonitoringMethodView, 'ID' | 'Name' | 'Actions'>[]
): TargetActionMethod[] {
  const Out = new Map<string, TargetActionMethod>();
  for (const Check of Array.isArray(Checks) ? Checks : []) {
    if (!Check || !Check.Method) continue;
    const Existing = Out.get(Check.Method);
    if (Existing) {
      Existing.Checks.push(Check);
      continue;
    }
    const Meta = Methods.find((Entry) => Entry.ID === Check.Method);
    const Actions = Meta && Array.isArray(Meta.Actions) ? Meta.Actions : [];
    if (!Actions.length) continue;
    Out.set(Check.Method, {
      Method: Check.Method,
      Name: (Meta && Meta.Name) || Check.Method.toUpperCase(),
      Checks: [Check],
      Actions,
    });
  }
  return [...Out.values()];
}

/** The names of every check type that offers actions, for the empty-tab message. */
export function MethodsWithActions(
  Methods: readonly Pick<MonitoringMethodView, 'Name' | 'Actions'>[]
): string[] {
  return Methods.filter((Entry) => Array.isArray(Entry.Actions) && Entry.Actions.length).map(
    (Entry) => Entry.Name
  );
}

/**
 * A check whose last probe could not reach its device. A check that has not
 * been probed yet is unknown rather than offline, so it does not count.
 */
export function IsCheckOffline(Check: Pick<MonitoringCheckView, 'LastChecked' | 'Online'>) {
  return Check.LastChecked != null && !Check.Online;
}

type ParamField = { Key: string; Options?: Array<string | { value: string; label?: string }> };

/**
 * The choices for an action parameter when one press goes to several checks.
 *
 * Each check may report its own (the inputs THAT projector has), so the list is
 * every check's choices together, first-seen order, each value once. A value
 * only some of the devices have is still offered: those that lack it refuse,
 * and the result toast reports exactly which part of the batch that was. With
 * nothing reported by any check, the field's static options apply; with none of
 * those either, the field is free text.
 */
export function MergeActionParamOptions(
  Checks: readonly Pick<MonitoringCheckView, 'ActionOptions'>[],
  Field: ParamField
): Array<{ value: string; label: string }> {
  const Seen = new Map<string, { value: string; label: string }>();
  for (const Check of Checks) {
    const Reported = Check.ActionOptions && Check.ActionOptions[Field.Key];
    if (!Array.isArray(Reported)) continue;
    for (const Option of Reported) {
      if (!Option || Seen.has(String(Option.value))) continue;
      Seen.set(String(Option.value), {
        value: String(Option.value),
        label: String(Option.label ?? Option.value),
      });
    }
  }
  if (Seen.size) return [...Seen.values()];
  return (Array.isArray(Field.Options) ? Field.Options : []).map((Option) =>
    typeof Option === 'object'
      ? { value: String(Option.value), label: String(Option.label ?? Option.value) }
      : { value: String(Option), label: String(Option) }
  );
}
