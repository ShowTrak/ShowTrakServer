// Number inputs: the browser's spin buttons are hidden app-wide (02-controls.css)
// and replaced with a plain up/down chevron pair on the input's right edge.
//
// Every number input is picked up as it lands in the DOM (a MutationObserver
// covers the ones rendered from templates), so no markup has to opt in. The
// chevrons follow the input as its next sibling: inside a .form-floating they
// go straight in (it is already positioned, and the label's `~` rules still
// match); anywhere else the input is wrapped in a positioned .st-number.
//
// A step writes the value and fires `input` then `change`, exactly as typing
// and blurring would, so every existing handler (debounced saves, condition
// queues) runs unchanged. Holding a chevron repeats.

// Fields whose right edge is already taken (an input-group button, a note
// icon) keep plain keyboard/scroll stepping; their spinners were hidden before.
const SKIP = '.input-group, .monitoring-field-wrap.has-note';
const REPEAT_DELAY_MS = 400;
const REPEAT_EVERY_MS = 60;

let RepeatTimer: ReturnType<typeof setTimeout> | null = null;

function DecimalPlaces(Value: number): number {
  const Text = String(Value);
  const Dot = Text.indexOf('.');
  return Dot === -1 ? 0 : Text.length - Dot - 1;
}

// stepUp()/stepDown() throw on step="any" and refuse values off the step grid,
// so the arithmetic is done here: one step (1 for "any"), clamped to min/max.
function Step(Input: HTMLInputElement, Direction: 1 | -1): void {
  if (Input.disabled || Input.readOnly) return;
  const StepSize = parseFloat(Input.step) > 0 ? parseFloat(Input.step) : 1;
  const Min = parseFloat(Input.min);
  const Max = parseFloat(Input.max);
  let Current = parseFloat(Input.value);
  if (!Number.isFinite(Current)) {
    const Placeholder = parseFloat(Input.placeholder);
    Current = Number.isFinite(Placeholder) ? Placeholder : Number.isFinite(Min) ? Min : 0;
  }
  let Next = Current + Direction * StepSize;
  if (Number.isFinite(Min) && Next < Min) Next = Min;
  if (Number.isFinite(Max) && Next > Max) Next = Max;
  Next = Number(Next.toFixed(Math.max(DecimalPlaces(StepSize), DecimalPlaces(Current))));
  if (String(Next) === Input.value) return;
  Input.value = String(Next);
  Input.dispatchEvent(new Event('input', { bubbles: true }));
  Input.dispatchEvent(new Event('change', { bubbles: true }));
}

function Enhance(Input: HTMLInputElement): void {
  if (Input.dataset.stStepper || Input.closest(SKIP)) return;
  Input.dataset.stStepper = '1';
  Input.classList.add('st-number-input');

  const Steps = document.createElement('span');
  Steps.className = 'st-number-steps';
  Steps.setAttribute('aria-hidden', 'true');
  Steps.innerHTML =
    '<span class="st-number-step" data-step="1"><i class="bi bi-chevron-up"></i></span>' +
    '<span class="st-number-step" data-step="-1"><i class="bi bi-chevron-down"></i></span>';

  if (Input.parentElement?.classList.contains('form-floating')) {
    Input.after(Steps);
  } else {
    const Wrap = document.createElement('span');
    Wrap.className = 'st-number';
    Input.before(Wrap);
    Wrap.append(Input, Steps);
  }
}

function EnhanceWithin(Root: ParentNode): void {
  if (Root instanceof HTMLInputElement) {
    if (Root.type === 'number') Enhance(Root);
    return;
  }
  Root.querySelectorAll<HTMLInputElement>('input[type="number"]').forEach(Enhance);
}

function StopRepeat(): void {
  if (RepeatTimer) clearTimeout(RepeatTimer);
  RepeatTimer = null;
}

export function InitNumberSteppers(): void {
  EnhanceWithin(document);
  new MutationObserver((Records) => {
    for (const Record of Records) {
      Record.addedNodes.forEach((Node) => {
        if (Node instanceof Element) EnhanceWithin(Node);
      });
    }
  }).observe(document.body, { childList: true, subtree: true });

  // pointerdown, not click: preventDefault keeps focus where it was, and the
  // press can start the hold-to-repeat. Propagation stops here so a row that
  // reacts to clicks never sees a press on its chevrons.
  document.addEventListener(
    'pointerdown',
    (Event) => {
      const Button = (Event.target as Element | null)?.closest?.('.st-number-step');
      if (!(Button instanceof HTMLElement)) return;
      const Input = Button.parentElement?.previousElementSibling;
      if (!(Input instanceof HTMLInputElement)) return;
      Event.preventDefault();
      Event.stopPropagation();
      const Direction = Button.dataset.step === '-1' ? -1 : 1;
      StopRepeat();
      Step(Input, Direction);
      const Repeat = () => {
        Step(Input, Direction);
        RepeatTimer = setTimeout(Repeat, REPEAT_EVERY_MS);
      };
      RepeatTimer = setTimeout(Repeat, REPEAT_DELAY_MS);
    },
    true
  );
  document.addEventListener(
    'click',
    (Event) => {
      if ((Event.target as Element | null)?.closest?.('.st-number-step')) Event.stopPropagation();
    },
    true
  );
  for (const Name of ['pointerup', 'pointercancel', 'blur'] as const) {
    window.addEventListener(Name, StopRepeat, true);
  }
}
