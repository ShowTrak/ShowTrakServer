// Drag-to-reorder for the manager lists (scripts, tags, groups). Each list marks
// the item being dragged with the `dragging` class (on dragstart, cleared on
// dragend, where it also persists the new order); this moves that item through
// the list as it is dragged over it.

/** The item the dragged one should be dropped before, from the pointer's Y; null to append. */
export function DragAfterElement(
  Container: HTMLElement,
  ItemSelector: string,
  Y: number
): Element | null {
  const Items = [...Container.querySelectorAll(`${ItemSelector}:not(.dragging)`)];
  let Closest: { offset: number; element: Element | null } = {
    offset: Number.NEGATIVE_INFINITY,
    element: null,
  };
  for (const Child of Items) {
    const Box = Child.getBoundingClientRect();
    const Offset = Y - Box.top - Box.height / 2;
    if (Offset < 0 && Offset > Closest.offset) {
      Closest = { offset: Offset, element: Child };
    }
  }
  return Closest.element;
}

/** Let the `ItemSelector` items of `Container` be reordered by dragging. Wire once per container. */
export function EnableDragReorder(Container: HTMLElement, ItemSelector: string): void {
  Container.addEventListener('dragover', (Event) => {
    Event.preventDefault();
    const Dragging = Container.querySelector(`${ItemSelector}.dragging`);
    if (!Dragging) return;
    const After = DragAfterElement(Container, ItemSelector, Event.clientY);
    if (After == null) Container.appendChild(Dragging);
    else Container.insertBefore(Dragging, After);
  });
  Container.addEventListener('drop', (Event) => Event.preventDefault());
}
