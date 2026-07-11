// App update wiring (renderer). Extracted verbatim from init.ts WireGlobalUI.
//
// Binds the About-modal "Check for Updates" / Install / Later buttons and the
// live OnAppUpdateStatus listener that drives the update section (status text,
// buttons, and rendered release notes). GitHub release notes arrive as either
// HTML (injected as-is) or Markdown (rendered via the shared markdown util).
import type { AppUpdateStatus } from "@showtrak/protocol";
import { HandleNonFatalError } from "./04-utils";
import { OpenAboutModal } from "./11-modals";
import { renderMarkdownSafe, sanitizeUpdateNotesHtml } from "./lib/markdown";

export function wireAppUpdates() {
  // --- App Updates (manual check) ---
  try {
    // Bind Check for Updates button in core modal
    $('#SHOWTRAK_MODEL_CORE_CHECKUPDATES')
      .off('click')
      .on('click', async () => {
        await OpenAboutModal();
        // Ensure section visible while checking
        $('#UPDATE_SECTION').removeClass('d-none');
        $('#UPDATE_STATUS').text('Checking for updates...');
        $('#UPDATE_INSTALL_BTN').addClass('d-none');
        $('#UPDATE_LATER_BTN').addClass('d-none');
        try {
          await window.API.CheckForAppUpdates();
        } catch (err) {
          HandleNonFatalError('SelectionInit:NonFatal', err);
        }
      });
    // Bind Install and Later buttons
    $('#UPDATE_INSTALL_BTN')
      .off('click')
      .on('click', async () => {
        try {
          await window.API.InstallAppUpdate();
        } catch (err) {
          HandleNonFatalError('SelectionInit:NonFatal', err);
        }
      });
    $('#UPDATE_LATER_BTN')
      .off('click')
      .on('click', async () => {
        // Hide the section but keep state if needed later
        $('#UPDATE_SECTION').addClass('d-none');
      });

    // Listen for updater status from main
    window.API.OnAppUpdateStatus((payload) => {
      try {
        $('#UPDATE_SECTION').removeClass('d-none');
        const st = (payload && payload.state) || 'none';
        const $status = $('#UPDATE_STATUS');
        const $install = $('#UPDATE_INSTALL_BTN');
        const $later = $('#UPDATE_LATER_BTN');
        const $notesWrap = $('#UPDATE_NOTES_WRAPPER');
        const $notes = $('#UPDATE_CHANGELOG');
        $install.addClass('d-none');
        $later.addClass('d-none');
        $notesWrap.addClass('d-none');
        $notes.empty();
        const extractNotes = (info: AppUpdateStatus['info']) => {
          if (!info) return '';
          // electron-updater passes release notes in different shapes across platforms
          // Prefer html: info.releaseNotes or markdown: info.notes
          const raw = info.releaseNotes || info.notes || info.body || '';
          if (Array.isArray(raw)) {
            // mac: array of releases, take the first entry's notes
            const first = raw.find(Boolean);
            return (first && (first.releaseNotes || first.notes || first.body)) || '';
          }
          return raw || '';
        };
        const showNotes = (info: AppUpdateStatus['info']) => {
          const notes = extractNotes(info);
          if (notes && typeof notes === 'string') {
            // GitHub ships pre-rendered HTML; other providers ship Markdown.
            // Either way the content never reaches the DOM un-sanitized: HTML
            // goes through the allowlist sanitizer, Markdown through the safe
            // renderer (which escapes before emitting any markup).
            const looksHtml = /<\w+[^>]*>/.test(notes);
            if (looksHtml) {
              $notes.html(sanitizeUpdateNotesHtml(notes));
            } else {
              $notes.html(renderMarkdownSafe(notes));
            }
            $notesWrap.removeClass('d-none');
          }
        };
        if (st === 'checking') {
          $status.text('Checking for updates...');
        } else if (st === 'available') {
          const v =
            payload.info && (payload.info.version || payload.info.tag || 'Update available');
          $status.text(`Update available: ${v}. Downloading...`);
          showNotes(payload.info);
        } else if (st === 'downloading') {
          const pct = payload.percent ? Math.floor(payload.percent) : 0;
          $status.text(`Downloading update... ${pct}%`);
        } else if (st === 'downloaded') {
          const v = payload.info && (payload.info.version || 'pending');
          $status.text(`Update ready to install: ${v}`);
          showNotes(payload.info);
          $install.removeClass('d-none');
          $later.removeClass('d-none');
        } else if (st === 'installing') {
          $status.text('Installing update...');
        } else if (st === 'installed') {
          if (payload.simulated) {
            $status.text('Update installed (simulated). Restart the app to finish.');
          } else {
            $status.text('Update installed. Restart the app to finish.');
          }
          $later.removeClass('d-none');
        } else if (st === 'none') {
          $status.text('No updates available');
        } else if (st === 'error') {
          $status.text(`Update error: ${payload.error || 'Unknown error'}`);
          $later.removeClass('d-none');
        }
      } catch (err) {
        HandleNonFatalError('SelectionInit:NonFatal', err);
      }
    });
  } catch (err) {
    HandleNonFatalError('SelectionInit:NonFatal', err);
  }
}
