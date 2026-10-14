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
