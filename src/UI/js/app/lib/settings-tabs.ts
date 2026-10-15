// The Preferences modal's left-hand tabs. Unlike the Client Info tabs the set
// is not fixed: there is one per settings group, plus Remote Access and Paired
// Devices only while they have something to list. A tab that disappears while
// selected (the last paired device revoked, say) falls back to the first tab
// rather than leaving an empty pane.
export function ResolveSettingsTab(
  Requested: string | null | undefined,
  Available: readonly string[]
): string {
  return Available.includes(String(Requested)) ? (Requested as string) : (Available[0] ?? '');
}

// A numeric setting's value with its unit, as shown beside sliders and number
// inputs and in the saved toast. '%' sits against the number ("80%"); every
// other unit is spaced ("500 ms", "5 minutes"), and a spelled-out plural unit
// reads singular for exactly 1 ("1 minute"). No unit leaves the bare number.
export function FormatSettingValue(Value: unknown, Unit: string | null | undefined): string {
  const Text = String(Value ?? '');
  const Label = String(Unit ?? '').trim();
  if (!Label) return Text;
  if (Label === '%') return `${Text}%`;
  const Singular =
    Number(Value) === 1 && Label.length > 2 && Label.endsWith('s') ? Label.slice(0, -1) : Label;
  return `${Text} ${Singular}`;
}
