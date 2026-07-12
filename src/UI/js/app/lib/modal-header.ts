// Shared "titlebar" for modal panels: an optional back button on the left, a
// centred title, and an optional close button on the right. Every panel that
// used the ad-hoc `Back button + bg-ghost title` markup should be built through
// here so the layout, sizing and behaviour stay identical app-wide.
//
// The back and close buttons stretch to the title's height (see `.st-modal-header`
// in the stylesheet), so callers never size them by hand. Both buttons are
// optional and each takes its own callback — panels that need to run logic before
// leaving (autosave, commit-in-progress edits) pass those callbacks here rather
// than wiring their own click handlers.
import { Safe } from '../04-utils';

export interface ModalHeaderConfig {
  /** Visible title text. Escaped before insertion. */
  title: string;
  /**
   * Optional id applied to the title element so callers can update it later with
   * `$('#id').text(...)` without holding onto the returned handle.
   */
  titleId?: string;
  /** Accessible label for the back button (default "Back"). Shown as an arrow only. */
  backLabel?: string;
  /** Accessible label for the close button (default "Close"). */
  closeLabel?: string;
  /** Provide to show the back button. Runs when it is clicked. */
  onBack?: () => unknown;
  /** Provide to show the close button. Runs when it is clicked. */
  onClose?: () => unknown;
}

/** Handle returned by {@link buildModalHeader} for post-build tweaks. */
export interface ModalHeaderHandle {
  /** The header row element, ready to append into a panel. */
  $el: JQuery<HTMLElement>;
  /** Update the title text after the fact. */
  setTitle(title: string): void;
}

function buildButton(role: 'back' | 'close', inner: string, ariaLabel?: string): string {
  const Aria = ariaLabel ? ` aria-label="${Safe(ariaLabel)}"` : '';
  return `<button type="button" class="btn btn-light st-modal-header-btn d-flex align-items-center justify-content-center" data-modal-header-role="${role}"${Aria}>${inner}</button>`;
}

/**
 * Build a modal titlebar as a jQuery element with the back/close callbacks bound.
 * Append the returned `$el` into the panel that should carry the header.
 */
export function buildModalHeader(config: ModalHeaderConfig): ModalHeaderHandle {
  const BackLabel = config.backLabel ?? 'Back';
  const CloseLabel = config.closeLabel ?? 'Close';
  const TitleIdAttr = config.titleId ? ` id="${Safe(config.titleId)}"` : '';

  const BackButton = config.onBack
    ? buildButton('back', '<i class="bi bi-chevron-left" aria-hidden="true"></i>', BackLabel)
    : '';

  const CloseButton = config.onClose
    ? buildButton('close', '<i class="bi bi-x-lg" aria-hidden="true"></i>', CloseLabel)
    : '';

  const Html = `
    <div class="st-modal-header d-flex align-items-stretch gap-2">
      ${BackButton}
      <div class="st-modal-header-title rounded-3 p-2 bg-ghost-light flex-grow-1 d-flex align-items-center justify-content-center">
        <h6${TitleIdAttr} class="mb-0 text-center">${Safe(config.title)}</h6>
      </div>
      ${CloseButton}
    </div>
  `;

  const $el = $(Html.trim());

  if (config.onBack) {
    $el.find('[data-modal-header-role="back"]').on('click', () => {
      config.onBack!();
    });
  }
  if (config.onClose) {
    $el.find('[data-modal-header-role="close"]').on('click', () => {
      config.onClose!();
    });
  }

  return {
    $el,
    setTitle(title: string) {
      $el.find('.st-modal-header-title h6').text(title);
    },
  };
}
