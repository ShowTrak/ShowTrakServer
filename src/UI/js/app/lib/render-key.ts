// What a section was last drawn from, so an unchanged redraw can be skipped.
//
// Kept beside the element rather than in a data- attribute: the key is often
// the section's whole markup, and writing kilobytes of HTML into an attribute
// on every change cost a serialisation, a mutation and a style check of its
// own, all to compare against next time.
const Keys = new WeakMap<Element, string>();

/** Whether `El` was last drawn from `Key`. */
export function RenderKeyIs(El: Element | null | undefined, Key: string): boolean {
  return !!El && Keys.get(El) === Key;
}

/** Record that `El` has been drawn from `Key`. */
export function SetRenderKey(El: Element | null | undefined, Key: string): void {
  if (El) Keys.set(El, Key);
}

/** Forget what each element was drawn from, so the next draw happens. */
export function ClearRenderKeys(Els: ArrayLike<Element> | null | undefined): void {
  if (!Els) return;
  for (let Index = 0; Index < Els.length; Index++) {
    const El = Els[Index];
    if (El) Keys.delete(El);
  }
}
