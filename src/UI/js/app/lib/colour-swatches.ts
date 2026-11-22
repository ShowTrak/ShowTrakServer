// The colour swatch picker of the script and tag editors: one button per
// palette colour, the chosen one marked `selected`.
import { SCRIPT_COLOURS } from './script-colours';

/** The palette index a new script or tag gets, and the fallback for a missing one. */
const DEFAULT_COLOUR = 6;

/** Fill `Container` with a swatch per palette colour, selecting `Current`. */
export function RenderColourSwatches(Container: HTMLElement, Current: unknown): void {
  const Selected = typeof Current === 'number' ? Current : DEFAULT_COLOUR;
  Container.innerHTML = '';
  SCRIPT_COLOURS.forEach((c, idx) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'script-manager-swatch' + (idx === Selected ? ' selected' : '');
    btn.title = c.label;
    btn.style.background = c.hex;
    btn.setAttribute('data-colour-index', String(idx));
    btn.addEventListener('click', () => {
      Container.querySelectorAll('.script-manager-swatch').forEach((s) =>
        s.classList.remove('selected')
      );
      btn.classList.add('selected');
    });
    Container.appendChild(btn);
  });
}

/** The palette index of the selected swatch in `Container`; the default when there is none. */
export function SelectedColourIndex(Container: HTMLElement | null): number {
  const Selected = Container ? Container.querySelector('.script-manager-swatch.selected') : null;
  const Index = Selected ? parseInt(Selected.getAttribute('data-colour-index') || '', 10) : NaN;
  return Number.isInteger(Index) ? Index : DEFAULT_COLOUR;
}
