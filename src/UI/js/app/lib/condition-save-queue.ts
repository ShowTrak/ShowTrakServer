// Conditions on a monitored item (an application, display, USB device, audio
// endpoint or network interface) save as they are ticked. The editors for every
// kind share the same rules for that, kept here once:
//
//  - Saves for the same item run one after another, so a quick second tick can
//    never land before the first.
//  - Only the last queued save refreshes the view. An earlier one would flash
//    the in-between state for a moment.
//  - A failed save (or a value that would not parse) is reported, and the view
//    is redrawn from what is really stored.
import { HandleNonFatalError } from '../utils';

export interface ConditionSave {
  /** Perform the save. Resolves to an error message, or a falsy value on success. */
  Save(): Promise<unknown>;
  /** Re-fetch and re-render the client. */
  Refresh(): Promise<void>;
  Notify(Message: string, Type?: string, Duration?: number): unknown;
  /** Clear the render cache of the list holding the item, so a refresh redraws it. */
  ResetRender(): void;
  /** Label for an unexpected failure in the error log. */
  ErrorContext: string;
}

export interface ConditionSaveQueue {
  /** The pending save per item key; empty once every save has settled. */
  readonly Chains: Map<string, Promise<void>>;
  Enqueue(Key: string, Job: ConditionSave): Promise<void>;
}

export function CreateConditionSaveQueue(): ConditionSaveQueue {
  const Chains = new Map<string, Promise<void>>();

  function Enqueue(Key: string, Job: ConditionSave): Promise<void> {
    const Previous = Chains.get(Key) || Promise.resolve();
    const Next: Promise<void> = Previous.then(async () => {
      try {
        const Err = await Job.Save();
        // A later save is already queued: its refresh shows the final state.
        if (!Err) return void (Chains.get(Key) === Next && (await Job.Refresh()));
        Job.Notify(String(Err), 'error');
        Job.ResetRender();
        await Job.Refresh();
      } catch (err) {
        HandleNonFatalError(Job.ErrorContext, err);
      }
    });
    Chains.set(Key, Next);
    void Next.finally(() => {
      if (Chains.get(Key) === Next) Chains.delete(Key);
    });
    return Next;
  }

  return { Chains, Enqueue };
}
