function SelectByGroup(GroupID) {
  if (!GroupUUIDCache.has(`${GroupID}`)) return;
  let UUIDs = GroupUUIDCache.get(`${GroupID}`);

  if (UUIDs.every((UUID) => IsSelected(UUID))) {
    UUIDs.forEach((UUID) => Deselect(UUID));
  } else {
    UUIDs.forEach((UUID) => Select(UUID));
  }
  return;
}

async function Wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Alert-style Toasts (Top Center) ---
function ensureToastHost() {
  let host = document.getElementById('ALERTS_TOAST_HOST');
  if (!host) {
    host = document.createElement('div');
    host.id = 'ALERTS_TOAST_HOST';
    document.body.appendChild(host);
  }
  return host;
}

function iconForType(type) {
  const t = String(type || 'info').toLowerCase();
  if (t === 'success') return '<i class="bi bi-check-circle-fill"></i>';
  if (t === 'warning') return '<i class="bi bi-exclamation-triangle-fill"></i>';
  if (t === 'error') return '<i class="bi bi-x-circle-fill"></i>';
  return '<i class="bi bi-info-circle-fill"></i>';
}

function RemoveAlertToastById(id) {
  try {
    const host = document.getElementById('ALERTS_TOAST_HOST');
    if (!host) return;
    const node = host.querySelector(`.alert-toast[data-alert-id="${CSS.escape(id)}"]`);
    if (node) node.remove();
  } catch (e) {
    HandleNonFatalError('RemoveAlertToastById', e);
  }
}

function showAlertStyleToast({
  id = null,
  title = '',
  message = '',
  type = 'info',
  duration = 5000,
  linkAlert = false,
  iconHtml = null,
}) {
  const host = ensureToastHost();
  const el = document.createElement('div');
  el.className = 'alert-item alert-toast';
  el.setAttribute('data-severity', String(type || 'info').toLowerCase());
  if (id && linkAlert) el.setAttribute('data-alert-id', id);
  const hasMessage = Boolean(message && String(message).trim().length > 0);
  if (!hasMessage) el.classList.add('single-line');
  el.innerHTML = `
		<div class="alert-icon">${iconHtml ? iconHtml : linkAlert ? iconForAlert({ type }) : iconForType(type)}</div>
		<div class="alert-content">
			<div><strong>${Safe(title || 'Notice')}</strong></div>
			${message ? `<div class="alert-meta">${Safe(message)}</div>` : ''}
		</div>
		<div class="alert-dismiss">
			<button class="btn-dismiss" title="Dismiss" aria-label="Dismiss">✕</button>
		</div>`;
  host.appendChild(el);

  // Dismiss interaction
  const btn = el.querySelector('.btn-dismiss');
  if (btn)
    btn.addEventListener('click', () => {
      el.remove();
      if (linkAlert && id) {
        // Sync with alerts tray
        DismissAlert(id);
      }
    });

  // Auto-remove after duration with hover pause
  if (duration && duration > 0) {
    let remaining = duration;
    let timerId = null;
    let lastStart = Date.now();
    const clear = () => {
      if (timerId) {
        clearTimeout(timerId);
        timerId = null;
      }
    };
    const tick = () => {
      clear();
      lastStart = Date.now();
      timerId = setTimeout(() => {
        try {
          el.remove();
        } catch (e) {
          HandleNonFatalError('showAlertStyleToast:AutoRemove', e);
        }
      }, remaining);
    };
    const onMouseEnter = () => {
      // pause timer
      remaining -= Date.now() - lastStart;
      if (remaining < 0) remaining = 0;
      clear();
    };
    const onMouseLeave = () => {
      if (remaining === 0) {
        try {
          el.remove();
        } catch (e) {
          HandleNonFatalError('showAlertStyleToast:MouseLeaveRemove', e);
        }
      } else {
        tick();
      }
    };
    el.addEventListener('mouseenter', onMouseEnter);
    el.addEventListener('mouseleave', onMouseLeave);
    // start timer
    tick();
  }
}

async function Notify(Message, Type = 'info', Duration = 5000) {
  showAlertStyleToast({
    title: Message,
    message: '',
    type: Type,
    duration: Duration,
    linkAlert: false,
  });
}

async function ConfirmationDialog(Message) {
  return new Promise((resolve) => {
    // Create or reuse toast container
    const existing = document.getElementById('SHOWTRAK_CONFIRM_TOAST');
    if (existing) {
      try {
        existing.remove();
      } catch (err) {
    HandleNonFatalError('SelectionInit:NonFatal', err);
  }
    }

    const toastHtml = `
			<div id="SHOWTRAK_CONFIRM_TOAST" role="dialog" aria-live="assertive" aria-modal="true" class="confirm-toast no-drag">
				<div class="confirm-toast-body">
					<div class="confirm-toast-msg">${Safe(Message)}</div>
					<div class="confirm-toast-actions">
						<button type="button" class="btn btn-sm btn-secondary" id="CONFIRM_TOAST_CANCEL" tabindex="0">Cancel</button>
						<button type="button" class="btn btn-sm btn-danger" id="CONFIRM_TOAST_CONFIRM" tabindex="0">Confirm</button>
					</div>
				</div>
			</div>`;

    $('body').append(toastHtml);
    const $toast = $('#SHOWTRAK_CONFIRM_TOAST');
    const $btnCancel = $('#CONFIRM_TOAST_CANCEL');
    const $btnConfirm = $('#CONFIRM_TOAST_CONFIRM');

    window.__SHOWTRAK_CONFIRM_ACTIVE = true;

    const cleanup = () => {
      $(document).off('keydown.confirmToast');
      $btnCancel.off('click.confirmToast');
      $btnConfirm.off('click.confirmToast');
      try {
        $toast.remove();
      } catch (err) {
    HandleNonFatalError('SelectionInit:NonFatal', err);
  }
      window.__SHOWTRAK_CONFIRM_ACTIVE = false;
    };

    $btnCancel.on('click.confirmToast', () => {
      cleanup();
      resolve(false);
    });
    $btnConfirm.on('click.confirmToast', () => {
      cleanup();
      resolve(true);
    });

    // Keyboard controls while toast is visible
    $(document).on('keydown.confirmToast', function (e) {
      // If context menu is open/visible, ignore Enter/Space here
      const $ctx = $('#SHOWTRAK_CONTEXT_MENU');
      if ($ctx && $ctx.is(':visible')) {
        return;
      }
      const key = e.key;
      if (key === 'Enter' || key === ' ') {
        e.preventDefault();
        const active = document.activeElement;
        if (active === $btnConfirm.get(0)) return $btnConfirm.trigger('click');
        if (active === $btnCancel.get(0)) return $btnCancel.trigger('click');
        // default to confirm if focus is elsewhere
        return $btnConfirm.trigger('click');
      }
      if (key === 'Escape') {
        e.preventDefault();
        return $btnCancel.trigger('click');
      }
      if (key === 'ArrowLeft') {
        e.preventDefault();
        return $btnCancel.trigger('focus');
      }
      if (key === 'ArrowRight') {
        e.preventDefault();
        return $btnConfirm.trigger('focus');
      }
    });

    // Default focus on Confirm so Enter activates it naturally
    setTimeout(() => {
      try {
        $btnConfirm.trigger('focus');
      } catch (err) {
    HandleNonFatalError('SelectionInit:NonFatal', err);
  }
    }, 0);
  });
}

function UpdateSelectionCount() {
  const $status = $('#SELECTION_STATUS');
  if (!$status || !$status.length) return;

  if (!AlertActionsEnabled) {
    $status.text('Alert actions are currently disabled').addClass('text-danger');
    return;
  }

  $status
    .text(`${Selected.length} ${Selected.length == 1 ? 'Client' : 'Clients'} Selected`)
    .removeClass('text-danger');
  return;
}

function IsSelected(UUID) {
  return Selected.includes(UUID);
}

function Select(UUID) {
  // Do not allow selecting pending-adoption tiles
  try {
    const $tile = $(`.SHOWTRAK_PC[data-uuid='${UUID}']`);
    if ($tile && $tile.hasClass('PENDING')) return;
  } catch (err) {
    HandleNonFatalError('SelectionInit:NonFatal', err);
  }
  if (Selected.includes(UUID)) return;
  Selected.push(UUID);
  $(`.SHOWTRAK_PC[data-uuid='${UUID}']`).addClass('SELECTED');
  UpdateSelectionCount();
  return;
}

function Deselect(UUID) {
  Selected = Selected.filter((id) => id !== UUID);
  $(`.SHOWTRAK_PC[data-uuid='${UUID}']`).removeClass('SELECTED');
  UpdateSelectionCount();
  return;
}

function ClearSelection() {
  Selected.forEach((uuid) => {
    $(`.SHOWTRAK_PC[data-uuid='${uuid}']`).removeClass('SELECTED');
  });
  Selected = [];
  UpdateSelectionCount();
  return;
}

function ToggleSelection(UUID) {
  // Do not toggle selection for pending-adoption tiles
  try {
    const $tile = $(`.SHOWTRAK_PC[data-uuid='${UUID}']`);
    if ($tile && $tile.hasClass('PENDING')) return;
  } catch (err) {
    HandleNonFatalError('SelectionInit:NonFatal', err);
  }
  if (Selected.includes(UUID)) {
    Selected = Selected.filter((id) => id !== UUID);
    $(`.SHOWTRAK_PC[data-uuid='${UUID}']`).removeClass('SELECTED');
  } else {
    Selected.push(UUID);
    $(`.SHOWTRAK_PC[data-uuid='${UUID}']`).addClass('SELECTED');
  }
  UpdateSelectionCount();
}

async function UpdateOfflineIndicators() {
  let CurrentTime = new Date().getTime();
  $('.SHOWTRAK_PC_STATUS[data-type="INDICATOR_OFFLINE"]>[data-type="OFFLINE_SINCE"]').each(
    function () {
      let LastSeen = $(this).attr('data-offlinesince');
      if (!LastSeen) return;
      LastSeen = parseInt(LastSeen);
      let OfflineDuration = CurrentTime - LastSeen;
      let Hours = Math.floor(OfflineDuration / (1000 * 60 * 60));
      let Minutes = Math.floor((OfflineDuration % (1000 * 60 * 60)) / (1000 * 60));
      let Seconds = Math.floor((OfflineDuration % (1000 * 60)) / 1000);
      let HH = String(Hours).padStart(2, '0');
      let MM = String(Minutes).padStart(2, '0');
      let SS = String(Seconds).padStart(2, '0');
      $(this).html(`OFFLINE <span class="badge bg-ghost">${HH}:${MM}:${SS}</span>`);
    }
  );
}

$(async function () {
  const $menu = $('#SHOWTRAK_CONTEXT_MENU');

  // Copy-to-clipboard for readonly editor fields and inline values
  $(document).on('click', '.copy-field-btn', async function (e) {
    e.preventDefault();
    e.stopPropagation();
    const direct = $(this).attr('data-copy');
    let value = null;
    if (direct && String(direct).length > 0) {
      value = String(direct);
    } else {
      const targetSel = $(this).attr('data-target');
      const $input = targetSel ? $(targetSel) : null;
      if (!$input || $input.length === 0) return false;
      value = String($input.val() || '').trim();
    }
    if (!value) return false;
    try {
      await navigator.clipboard.writeText(value);
      // quick feedback: icon swap
      const $icon = $(this).find('i');
      const prev = $icon.attr('class');
      $icon.attr('class', 'bi bi-clipboard-check');
      setTimeout(() => {
        $icon.attr('class', prev);
      }, 900);
      } catch (e) {
        HandleNonFatalError('Clipboard:CopyField', e);
      }
    return false;
  });

    $(document).on('click', '#SELECTION_STATUS', function () {
      ClearSelection();
    });

    $(document).on('click', '.GROUP_TITLE_CLICKABLE[data-groupid]', function (e) {
      e.preventDefault();
      const groupId = $(this).attr('data-groupid');
      SelectByGroup(groupId);
    });

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
        const escapeHtml = (s) =>
          String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
        const sanitizeHref = (href) => {
          try {
            const h = String(href || '').trim();
            if (/^(https?:|mailto:)/i.test(h)) return h;
          } catch (err) {
    HandleNonFatalError('SelectionInit:NonFatal', err);
  }
          return '#';
        };
        const renderMarkdownSafe = (md) => {
          if (!md || typeof md !== 'string') return '';
          let text = md.replace(/\r\n/g, '\n');
          // Escape HTML first
          text = escapeHtml(text);
          // Extract fenced code blocks
          const codeBlocks = [];
          text = text.replace(/```([\s\S]*?)```/g, (_m, code) => {
            const idx = codeBlocks.push(code) - 1;
            return `%%CODEBLOCK_${idx}%%`;
          });
          // Headings
          text = text.replace(/^#{1,6}\s+(.+)$/gm, (m) => {
            const hashes = m.match(/^#+/)[0].length;
            const content = m.replace(/^#{1,6}\s+/, '');
            const level = Math.min(6, Math.max(1, hashes));
            return `<h${level} class="h${level + 2}">${content}</h${level}>`;
          });
          // Inline code (after fences are removed)
          text = text.replace(/`([^`]+)`/g, (_m, code) => `<code>${code}</code>`);
          // Links
          text = text.replace(/\[([^\]]+)\]\(([^\)]+)\)/g, (_m, label, href) => {
            const url = sanitizeHref(href);
            return `<a href="${url}" target="_blank" rel="noopener">${label}</a>`;
          });
          // Unordered lists (group contiguous items)
          text = text.replace(/(?:^|\n)((?:[\-\*\+]\s+.*(?:\n|$))+)/g, (_m, block) => {
            const items = block
              .trim()
              .split(/\n/)
              .map((line) => line.replace(/^[\-\*\+]\s+/, '').trim())
              .filter((x) => x.length > 0)
              .map((x) => `<li>${x}</li>`)
              .join('');
            return `\n<ul>${items}</ul>`;
          });
          // Bold and italic (do after lists so we don't break bullets)
          text = text
            .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
            .replace(/__(.+?)__/g, '<strong>$1</strong>')
            .replace(/(?<!\*)\*(?!\s)(.+?)(?<!\s)\*(?!\*)/g, '<em>$1</em>')
            .replace(/_(?!\s)(.+?)(?<!\s)_/g, '<em>$1</em>');
          // Paragraphs: wrap blocks that are not already block-level tags
          const blocks = text
            .split(/\n{2,}/)
            .map((b) => b.trim())
            .filter(Boolean);
          const html = blocks
            .map((b) => {
              if (/^<\/?(h\d|ul|ol|li|pre|blockquote|table|p|code)/i.test(b)) return b;
              return `<p>${b.replace(/\n/g, '<br/>')}</p>`;
            })
            .join('\n');
          // Restore fenced code blocks
          return html.replace(/%%CODEBLOCK_(\d+)%%/g, (_m, i) => {
            const code = codeBlocks[Number(i)] || '';
            return `<pre class="mb-2"><code>${code}</code></pre>`;
          });
        };
        const extractNotes = (info) => {
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
        const showNotes = (info) => {
          const notes = extractNotes(info);
          if (notes && typeof notes === 'string') {
            // Allow basic HTML if present from GitHub; otherwise escape text
            const looksHtml = /<\w+[^>]*>/.test(notes);
            if (looksHtml) {
              $notes.html(notes);
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

  // Open client editor from cog without affecting selection
  $(document).on('click', '.CLIENT_TILE_COG', function (e) {
    e.preventDefault();
    e.stopPropagation();
    // Monitoring targets use their own editor
    if ($(this).hasClass('MONITOR_TILE_COG')) {
      const tid = $(this).closest('.SHOWTRAK_PC').attr('data-target-id');
      if (tid) OpenMonitoringTargetEditor(parseInt(tid, 10));
      return false;
    }
    const uuid = $(this).closest('.SHOWTRAK_PC').attr('data-uuid');
    if (uuid) {
      OpenClientEditor(uuid);
    }
    return false;
  });
  $(document).on('click', '.SHOWTRAK_PC', function (e) {
    e.preventDefault();
    // Ignore clicks on pending-adoption tiles (blue)
    if ($(this).hasClass('PENDING')) return false;
    // Monitoring tiles aren't selectable client targets
    if ($(this).hasClass('MONITOR')) return false;
    let UUID = $(this).attr('data-uuid');
    ToggleSelection(UUID);
    return;
  });
  // Double-click opens read-only Client Info modal (not the editor)
  $(document).on('dblclick', '.SHOWTRAK_PC', function (e) {
    e.preventDefault();
    e.stopPropagation();
    // Ignore dblclick on pending-adoption tiles
    if ($(this).hasClass('PENDING')) return false;
    // Monitoring tiles open their own editor on dblclick instead
    if ($(this).hasClass('MONITOR')) {
      const tid = $(this).attr('data-target-id');
      if (tid) {
        if (AppMode === 'SHOW') {
          OpenMonitoringTargetHistory(parseInt(tid, 10));
        } else {
          OpenMonitoringTargetEditor(parseInt(tid, 10));
        }
      }
      return false;
    }
    const uuid = $(this).attr('data-uuid');
    if (uuid) OpenClientInfo(uuid);
    return false;
  });
  $(document).on('contextmenu', 'html', async function (e) {
    e.preventDefault();
    let Options = [];

    if (Selected.length == 0) {
      Options.push({
        Type: 'Info',
        Title: 'No Selected Clients',
        Class: 'text-muted',
      });
    }

    if (Selected.length > 0) {
      ScriptList = ScriptList.sort((a, b) => (a.Weight || 0) - (b.Weight || 0));
      for (const Script of ScriptList) {
        const ColourHex = (typeof Script.Colour === 'number' && Script.Colour >= 0 && Script.Colour <= 7)
          ? ['#e74c3c','#e67e22','#f1c40f','#2ecc71','#3498db','#9b59b6','#bdc3c7','#7f8c8d'][Script.Colour]
          : '#bdc3c7';
        Options.push({
          Type: 'Action',
          Title: `${Script.Name}`,
          Class: '',
          ColourHex,
          Action: async function () {
            if (Script.Confirmation) {
              let Confirmation = await ConfirmationDialog(
                `Are you sure you want to run "${Script.Name}" on ${Selected.length} ${
                  Selected.length == 1 ? 'Client' : 'Clients'
                }?`
              );
              if (!Confirmation) return;
            }
            await ExecuteScript(Script.ID, Selected, true);
          },
        });
      }
    }

    if (ScriptList.length > 0) {
      Options.push({
        Type: 'Divider',
      });
    }

    if (Selected.length > 0) {
      let SYSTEM_ALLOW_WOL = await GetSettingValue('SYSTEM_ALLOW_WOL');
      if (SYSTEM_ALLOW_WOL) {
        Options.push({
          Type: 'Action',
          Title: 'Wake On LAN',
          Class: 'text-light',
          Action: async function () {
            window.API.WakeOnLan(Selected);
            ShowExecutionToast();
          },
        });
      }
      Options.push({
        Type: 'Action',
        Title: 'Clear Selection',
        Class: 'text-danger',
        Shortcut: 'Ctrl+D',
        Action: async function () {
          ClearSelection();
        },
      });
    }

    Options.push({
      Type: 'Action',
      Title: 'Select All',
      Class: 'text-light',
      Shortcut: 'Ctrl+A',
      Action: async function () {
        AllClients.map((UUID) => Select(UUID));
      },
    });

    $menu.html('');

    Options.forEach((option) => {
      if (option.Type === 'Divider') {
        $menu.append(`<hr class="my-2">`);
      }
      if (option.Type === 'Info') {
        $menu.append(
          `<a class="SHOWTRAK_CONTEXTMENU_BUTTON dropdown-item ${Safe(
            option.Class
          )}" role="menuitem" aria-disabled="true" tabindex="-1">` +
            `<span class="context-title">${Safe(option.Title)}</span>` +
            `<span class="context-shortcut">${Safe(option.Shortcut || '')}</span>` +
            `</a>`
        );
      }
      if (option.Type === 'Action') {
        const dotHtml = option.ColourHex
          ? `<span class="context-colour-dot" style="background:${option.ColourHex}"></span>`
          : '';
        $menu.append(
          `<a class="SHOWTRAK_CONTEXTMENU_BUTTON dropdown-item ${Safe(
            option.Class
          )}" role="menuitem" tabindex="-1">` +
            dotHtml +
            `<span class="context-title">${Safe(option.Title)}</span>` +
            `<span class="context-shortcut">${Safe(option.Shortcut || '')}</span>` +
            `</a>`
        );
        $menu.find('a:last').on('click', function () {
          option.Action();
        });
      }
    });

    // Calculate menu position to prevent overflow and keep it within viewport bounds
    const viewportWidth = window.innerWidth || $(window).width();
    const viewportHeight = window.innerHeight || $(window).height();
    const edgePadding = 8;
    const boundsEl =
      document.getElementById('APPLICATION_CONTAINER') ||
      document.getElementById('APPLICATION') ||
      document.documentElement;
    const boundsRect = boundsEl.getBoundingClientRect();
    const minX = Math.max(edgePadding, Math.floor(boundsRect.left) + edgePadding);
    const minY = Math.max(edgePadding, Math.floor(boundsRect.top) + edgePadding);
    const maxX = Math.min(viewportWidth - edgePadding, Math.floor(boundsRect.right) - edgePadding);
    const maxY = Math.min(
      viewportHeight - edgePadding,
      Math.floor(boundsRect.bottom) - edgePadding
    );
    const availableHeight = Math.max(120, maxY - minY);
    const maxMenuHeight = Math.min(460, Math.max(220, Math.floor(availableHeight * 0.9)));

    // Measure with intended max height before final placement
    $menu.css({
      display: 'block',
      visibility: 'hidden',
      left: 0,
      top: 0,
      'max-height': `${maxMenuHeight}px`,
    });

    const menuWidth = $menu.outerWidth();
    const menuHeight = Math.min($menu.outerHeight(), maxMenuHeight);

    const clickX = e.clientX;
    const clickY = e.clientY;
    let left = clickX;
    let top = clickY;

    // Prefer opening toward available space first, then clamp to viewport
    if (left + menuWidth > maxX) {
      left = clickX - menuWidth;
    }
    if (top + menuHeight > maxY) {
      top = clickY - menuHeight;
    }

    const maxLeft = Math.max(minX, maxX - menuWidth);
    const maxTop = Math.max(minY, maxY - menuHeight);
    left = Math.min(Math.max(minX, left), maxLeft);
    top = Math.min(Math.max(minY, top), maxTop);

    $menu.css({
      display: 'block',
      visibility: 'visible',
      left: `${left}px`,
      top: `${top}px`,
    });

    // A11y roles and initial focus
    $menu.attr('role', 'menu');
    const $focusable = $menu.find(
      'a.SHOWTRAK_CONTEXTMENU_BUTTON[role="menuitem"]:not([aria-disabled="true"])'
    );
    if ($focusable.length > 0) {
      setTimeout(() => {
        try {
          $focusable.first().trigger('focus')[0].scrollIntoView({ block: 'nearest' });
        } catch (err) {
    HandleNonFatalError('SelectionInit:NonFatal', err);
  }
      }, 0);
    }

    // Keyboard navigation within context menu
    $menu.off('keydown').on('keydown', function (ev) {
      const key = ev.key;
      const $items = $menu.find(
        'a.SHOWTRAK_CONTEXTMENU_BUTTON[role="menuitem"]:not([aria-disabled="true"])'
      );
      if ($items.length === 0) return;
      const activeEl = document.activeElement;
      let idx = $items.index(activeEl);

      // Type-to-search (typeahead) for menu items by visible title
      const isChar =
        key && key.length === 1 && !ev.ctrlKey && !ev.metaKey && !ev.altKey && key !== ' ';
      if (isChar) {
        ev.preventDefault();
        const now = Date.now();
        let buf = ($menu.data('typeaheadBuffer') || '').toString();
        const lastTime = $menu.data('typeaheadTime') || 0;
        let cycleSingle = false;
        const lower = key.toLowerCase();
        if (now - lastTime > 700) {
          buf = lower; // start new buffer after pause
        } else if (buf.length === 1 && buf === lower) {
          // repeating the same char cycles matches
          buf = lower;
          cycleSingle = true;
        } else {
          buf = (buf + lower).slice(0, 64);
        }
        $menu.data('typeaheadBuffer', buf);
        $menu.data('typeaheadTime', now);
        const prevTimer = $menu.data('typeaheadTimer');
        if (prevTimer) {
          try {
            clearTimeout(prevTimer);
          } catch (err) {
    HandleNonFatalError('SelectionInit:NonFatal', err);
  }
        }
        $menu.data(
          'typeaheadTimer',
          setTimeout(() => {
            $menu.removeData('typeaheadBuffer');
            $menu.removeData('typeaheadTimer');
            $menu.removeData('typeaheadTime');
          }, 900)
        );

        const titles = $items
          .map((i, el) => $(el).find('.context-title').text().trim().toLowerCase())
          .get();
        let start = (idx >= 0 ? idx + 1 : 0) % $items.length;
        if (cycleSingle) start = (idx >= 0 ? idx + 1 : 0) % $items.length;

        let found = -1;
        for (let k = 0; k < titles.length; k++) {
          const pos = (start + k) % titles.length;
          if (titles[pos].startsWith(buf)) {
            found = pos;
            break;
          }
        }
        if (found === -1) {
          for (let k = 0; k < titles.length; k++) {
            const pos = (start + k) % titles.length;
            if (titles[pos].includes(buf)) {
              found = pos;
              break;
            }
          }
        }
        if (found !== -1) {
          const $t = $items.eq(found);
          $t.trigger('focus')[0].scrollIntoView({ block: 'nearest' });
        }
        return;
      }
      if (key === 'ArrowDown') {
        ev.preventDefault();
        idx = (idx + 1 + $items.length) % $items.length;
        $items.eq(idx).trigger('focus')[0].scrollIntoView({ block: 'nearest' });
        return;
      }
      if (key === 'ArrowUp') {
        ev.preventDefault();
        idx = (idx - 1 + $items.length) % $items.length;
        $items.eq(idx).trigger('focus')[0].scrollIntoView({ block: 'nearest' });
        return;
      }
      if (key === 'Home') {
        ev.preventDefault();
        $items.first().trigger('focus')[0].scrollIntoView({ block: 'nearest' });
        return;
      }
      if (key === 'End') {
        ev.preventDefault();
        $items.last().trigger('focus')[0].scrollIntoView({ block: 'nearest' });
        return;
      }
      if (key === 'Enter' || key === ' ') {
        ev.preventDefault();
        // Prevent bubbling to document-level handlers (e.g., confirmation toast)
        try {
          ev.stopImmediatePropagation();
        } catch (err) {
    HandleNonFatalError('SelectionInit:NonFatal', err);
  }
        try {
          ev.stopPropagation();
        } catch (err) {
    HandleNonFatalError('SelectionInit:NonFatal', err);
  }
        if (idx >= 0) {
          const $target = $items.eq(idx);
          // Defer the click so it occurs after keydown completes
          setTimeout(() => {
            try {
              $target.trigger('click');
            } catch (err) {
    HandleNonFatalError('SelectionInit:NonFatal', err);
  }
          }, 0);
        }
        return;
      }
      if (key === 'Escape') {
        ev.preventDefault();
        $menu.hide();
        return;
      }
    });

    // Hover-to-focus: hovering should take over keyboard control
    $menu
      .off('mouseenter', 'a.SHOWTRAK_CONTEXTMENU_BUTTON')
      .on('mouseenter', 'a.SHOWTRAK_CONTEXTMENU_BUTTON', function () {
        const $a = $(this);
        if ($a.attr('aria-disabled') === 'true') return;
        const prevTimer = $menu.data('typeaheadTimer');
        if (prevTimer) {
          try {
            clearTimeout(prevTimer);
          } catch (err) {
    HandleNonFatalError('SelectionInit:NonFatal', err);
  }
        }
        $menu.removeData('typeaheadBuffer');
        $menu.removeData('typeaheadTimer');
        $menu.removeData('typeaheadTime');
        $a.trigger('focus');
      });

    $menu.data('target', this);
    return;
  });
  $(document).on('click', function () {
    $menu.hide();
    return;
  });
  $menu.on('click', 'a', function (e) {
    e.stopPropagation();
    $menu.hide();
    return;
  });

  // Close execution toast on Escape
  $(document).on('keydown.execToast', function (e) {
    if (e.key === 'Escape') {
      HideExecutionToast();
    }
  });
});

setInterval(UpdateOfflineIndicators, 1000);

function ShowExecutionToast(title) {
  const $existing = $('#EXECUTION_TOAST');
  if ($existing.length) {
    $existing.addClass('show');
    if (title) {
      $existing.find('.exec-toast-header .exec-title').text(title);
    }
    // Bind outside click to dismiss when reused
    enableExecToastOutsideClose();
    return;
  }
  const safeTitle = title ? Safe(title) : 'Script Executions';
  const html = `
	<div id="EXECUTION_TOAST" class="exec-toast show no-drag" role="region" aria-live="polite" aria-label="Script executions">
		<div class="exec-toast-header">
			<strong class="exec-title">${safeTitle}</strong>
			<button type="button" class="btn btn-sm btn-light exec-toast-close" aria-label="Close">✕</button>
		</div>
		<div id="SHOWTRAK_EXECUTION_LIST" class="exec-toast-body"></div>
	</div>`;
  $('body').append(html);
  $('.exec-toast-close').on('click', () => HideExecutionToast());
  // Bind outside click to dismiss on create
  enableExecToastOutsideClose();

  // No modal on click per requirements; ensure no handler is attached
  $(document).off('click.execInfo', '.exec-info-btn');
}

function HideExecutionToast() {
  const $t = $('#EXECUTION_TOAST');
  if ($t.length) {
    $t.removeClass('show');
    // Remove outside-click handler when closing
    $(document).off('mousedown.execToastOutside touchstart.execToastOutside');
    // keep in DOM for quick reopen; remove after short delay
    setTimeout(() => {
      try {
        $t.remove();
      } catch (err) {
    HandleNonFatalError('SelectionInit:NonFatal', err);
  }
    }, 150);
  }
}

// Enable click/touch outside toast to dismiss
function enableExecToastOutsideClose() {
  $(document)
    .off('mousedown.execToastOutside touchstart.execToastOutside')
    .on('mousedown.execToastOutside touchstart.execToastOutside', function (e) {
      const $toast = $('#EXECUTION_TOAST');
      if (!$toast.length) {
        $(document).off('mousedown.execToastOutside touchstart.execToastOutside');
        return;
      }
      const $target = $(e.target);
      const inside = $target.closest('#EXECUTION_TOAST').length > 0;
      if (!inside) {
        HideExecutionToast();
      }
    });
}

async function Init() {
  Config = await window.API.GetConfig();
  $('#APPLICATION_NAVBAR_TITLE').text(`${Config.Application.Name}`);
  $('#APPLICATION_NAVBAR_STATUS').text('');

  // Show the currently open .ShowTrak file name in the navbar and keep it in
  // sync as files are opened/saved/created.
  // First, verify the previously open file still exists; if it was deleted or
  // moved, the working data is wiped so we can prompt for a fresh start.
  const [, MissingResult] = (await window.API.EnsureShowFileExists()) || [];
  if (MissingResult && MissingResult.Missing) {
    await Notify('Previous show file was missing. Open or create a new show.', 'error');
  }
  const CurrentShowFile = await window.API.GetCurrentShowFile();
  RenderShowFileName(CurrentShowFile);
  window.API.OnShowFileUpdated((Path) => RenderShowFileName(Path));

  // When no show is open, prompt the user to open one or create a new show.
  $('#NO_SHOW_OPEN').on('click', async () => {
    await OpenShow();
    const Opened = await window.API.GetCurrentShowFile();
    if (Opened) $('#SHOWTRAK_MODAL_NO_SHOW').modal('hide');
  });
  $('#NO_SHOW_NEW').on('click', async () => {
    const [Err] = await window.API.NewShow();
    if (Err) {
      await Notify(String(Err), 'error');
      return;
    }
    $('#SHOWTRAK_MODAL_NO_SHOW').modal('hide');
    await Notify('Created new show.', 'success');
  });

  // Legacy-data migration guard: force a Save As before continuing so data from
  // a pre-show-file version is not lost.
  $('#MIGRATE_SAVE').on('click', async () => {
    await SaveShowAs();
    const Saved = await window.API.GetCurrentShowFile();
    if (Saved) $('#SHOWTRAK_MODAL_MIGRATE').modal('hide');
  });

  if (!CurrentShowFile) {
    const HasLegacyData = await window.API.HasUnsavedShowData();
    if (HasLegacyData) {
      $('#SHOWTRAK_MODAL_MIGRATE').modal('show');
    } else {
      $('#SHOWTRAK_MODAL_NO_SHOW').modal('show');
    }
  }

  $('#SHOWTRAK_MODEL_CORE_OPEN_SETTINGS').on('click', async () => {
    await CloseAllModals();
    $('#SHOWTRAK_MODAL_SETTINGS').modal('show');
  });

  $('#SHOWTRAK_ABOUT_BUTTON').on('click', async () => {
    await OpenAboutModal();
  });

  $('#SHOWTRAK_ABOUT_WEBSITE').on('click', async () => {
    await window.API.OpenShowTrakWebsiteInBrowser();
  });

  $('#SHOWTRAK_ABOUT_GITHUB').on('click', async () => {
    await window.API.OpenShowTrakGithubInBrowser();
  });

  $('#SHOWTRAK_ABOUT_DEPENDENCIES').on(
    'click',
    '.SHOWTRAK_ABOUT_DEPENDENCY_LINK',
    async (Event) => {
      const PackageName = $(Event.currentTarget).attr('data-package-name');
      if (!PackageName) return;
      await window.API.OpenNpmPackageInBrowser(PackageName);
    }
  );

  const settingsMenu = document.getElementById('SETTINGS_MENU');
  $('#SETTINGS_MENU_DROPDOWN')
    .off('shown.bs.dropdown.settingsOffset hidden.bs.dropdown.settingsOffset')
    .on('shown.bs.dropdown.settingsOffset', () => {
      if (!settingsMenu) return;
      const currentTransform = settingsMenu.style.transform || '';
      if (currentTransform.includes('translateY(-10px)')) return;
      settingsMenu.style.transform = `${currentTransform} translateY(-10px)`.trim();
    })
    .on('hidden.bs.dropdown.settingsOffset', () => {
      if (!settingsMenu) return;
      const currentTransform = settingsMenu.style.transform || '';
      settingsMenu.style.transform = currentTransform
        .replace(' translateY(-10px)', '')
        .replace('translateY(-10px)', '')
        .trim();
    });

  $('#ADD_TARGET_MANUAL_ACTION').on('click', async () => {
    await OpenMonitoringTargetEditor(null);
  });

  $('#ADD_TARGET_BROWSE_ACTION').on('click', async () => {
    await OpenNetworkDiscoveryModal();
  });

  $('#ADD_GROUP_ACTION').on('click', async () => {
    await OpenGroupCreationModal();
  });

  $('#ADD_ALERT_ACTION').on('click', async () => {
    await OpenCreateAlertRuleEditor();
  });

  const addTargetMenu = document.getElementById('ADD_MONITORING_TARGET_MENU');
  $('#ADD_MONITORING_TARGET_DROPDOWN')
    .off('shown.bs.dropdown.addTargetOffset hidden.bs.dropdown.addTargetOffset')
    .on('shown.bs.dropdown.addTargetOffset', () => {
      if (!addTargetMenu) return;
      const currentTransform = addTargetMenu.style.transform || '';
      if (currentTransform.includes('translateY(-10px)')) return;
      addTargetMenu.style.transform = `${currentTransform} translateY(-10px)`.trim();
    })
    .on('hidden.bs.dropdown.addTargetOffset', () => {
      if (!addTargetMenu) return;
      const currentTransform = addTargetMenu.style.transform || '';
      addTargetMenu.style.transform = currentTransform
        .replace(' translateY(-10px)', '')
        .replace('translateY(-10px)', '')
        .trim();
    });

  $('#NETWORK_DISCOVERY_TOGGLE_SCAN').on('click', async () => {
    if (NetworkDiscoveryScanning) {
      await StopNetworkDiscoveryScan();
      SetNetworkDiscoveryStatus('Stopped');
      return;
    }
    await StartNetworkDiscoveryScan();
  });

  $('#NETWORK_DISCOVERY_RESULTS')
    .off('click', '.NETWORK_DISCOVERY_ADD')
    .on('click', '.NETWORK_DISCOVERY_ADD', async function () {
      const id = String($(this).attr('data-id') || '')
        .trim()
        .toLowerCase();
      if (!id || !NetworkDiscoveryResults.has(id)) return;
      const selected = NetworkDiscoveryResults.get(id);
      await StopNetworkDiscoveryScan();
      await OpenMonitoringTargetEditor(null, {
        Nickname: selected.Name || '',
        Address: selected.Address || '',
        Method: selected.MethodHint || null,
      });
    });

  $('#SHOWTRAK_MODAL_NETWORK_DISCOVERY')
    .off('hidden.bs.modal.networkDiscovery')
    .on('hidden.bs.modal.networkDiscovery', async () => {
      await StopNetworkDiscoveryScan();
      ResetNetworkDiscoveryState();
    });

  $('#MONITOR_HISTORY_RANGE_GROUP')
    .off('click.monitorRange', '[data-range]')
    .on('click.monitorRange', '[data-range]', function (e) {
      e.preventDefault();
      const NextRange = String($(this).attr('data-range') || '').trim();
      if (!MONITORING_HISTORY_RANGES[NextRange]) return;
      MonitorHistoryRangeKey = NextRange;
      RenderMonitoringHistoryModal();
    });

  $('#SHOWTRAK_MONITOR_HISTORY_MODAL')
    .off('shown.bs.modal.monitorHistory')
    .on('shown.bs.modal.monitorHistory', () => {
      RenderMonitoringHistoryModal();
    });

  $('#MONITOR_HISTORY_CANVAS')
    .off('mousemove.monitorTooltip mouseleave.monitorTooltip')
    .on('mousemove.monitorTooltip', function (e) {
      if (!MonitorHistoryHoverBars.length) {
        HideMonitoringHistoryTooltip();
        return;
      }
      const Rect = this.getBoundingClientRect();
      const X = e.clientX - Rect.left;
      const Y = e.clientY - Rect.top;
      let Hit = null;
      for (let i = 0; i < MonitorHistoryHoverBars.length; i++) {
        const Bar = MonitorHistoryHoverBars[i];
        if (X >= Bar.x - 2 && X <= Bar.x + Bar.w + 2 && Y >= Bar.y && Y <= Bar.y + Bar.h) {
          Hit = Bar;
          break;
        }
      }
      if (!Hit) {
        HideMonitoringHistoryTooltip();
        return;
      }
      ShowMonitoringHistoryTooltip(X, Y, Hit);
    })
    .on('mouseleave.monitorTooltip', function () {
      HideMonitoringHistoryTooltip();
    });

  if (!window.__monitorHistoryResizeBound) {
    window.__monitorHistoryResizeBound = true;
    window.addEventListener('resize', () => {
      if (!MonitorHistoryModalTargetID) return;
      if (!$('#SHOWTRAK_MONITOR_HISTORY_MODAL').hasClass('show')) return;
      if (MonitorHistoryResizeTimer) clearTimeout(MonitorHistoryResizeTimer);
      MonitorHistoryResizeTimer = setTimeout(() => {
        RenderMonitoringHistoryModal();
        MonitorHistoryResizeTimer = null;
      }, 80);
    });
  }

  window.API.OnNetworkDeviceScanEvent((Event) => {
    HandleNetworkDiscoveryEvent(Event);
  });

  $('#SHOWTRAK_MODEL_CORE_OSC_ROUTE_LIST_BUTTON').on('click', async () => {
    await OpenOSCDictionary();
  });

  $('#SHOWTRAK_MODEL_CORE_SCRIPT_MANAGER_BUTTON').on('click', async () => {
    await OpenScriptManager();
  });

  $('#SHOWTRAK_MODEL_CORE_GROUP_MANAGER_BUTTON').on('click', async () => {
    await OpenGroupManager();
  });

  $('#SHOWTRAK_MODEL_CORE_ALERT_MANAGER_BUTTON').on('click', async () => {
    await OpenAlertRuleManager();
  });

  $('#SHOWTRAK_MODEL_CORE_LOGSFOLDER').on('click', async () => {
    await window.API.OpenLogsFolder();
  });

  $('#SHOWTRAK_MODEL_CORE_SCRIPTSFOLDER').on('click', async () => {
    await window.API.OpenScriptsFolder();
  });

  $('#SHOWTRAK_MODEL_CORE_SAVEAS').on('click', async () => {
    await SaveShowAs();
  });

  $('#SHOWTRAK_MODEL_CORE_SAVE').on('click', async () => {
    await SaveShow();
  });

  $('#SHOWTRAK_MODEL_CORE_OPEN').on('click', async () => {
    await OpenShow();
  });

  $('#SHOWTRAK_MODEL_CORE_NEW').on('click', async () => {
    await NewShow();
  });

  $('#SHOWTRAK_MODEL_CORE_SUPPORTDISCORD').on('click', async () => {
    await window.API.OpenDiscordInviteLinkInBrowser();
  });

  $('#SHOWTRAK_MODEL_CORE_SHUTDOWN_BUTTON').on('click', async () => {
    await window.API.Shutdown();
  });

  // Initialize application mode from backend and wire toggle
  try {
    const mode = await window.API.GetMode();
    RenderMode(mode);
  } catch (_) {
    RenderMode('SHOW');
  }
  // legacy toggle binding removed

  await window.API.Loaded();
}

// Ensure the QRCode library is loaded; if missing, load the vendor script dynamically
function ensureQRCodeLib() {
  return new Promise((resolve) => {
    try {
      if (typeof window !== 'undefined' && typeof window.QRCode !== 'undefined') return resolve();
      // Attempt to load from the same path used in index.html
      const existing = document.querySelector('script[data-dyn="qrcode"]');
      if (existing) {
        // If already loading, poll a bit until available
        let tries = 0;
        const timer = setInterval(() => {
          tries++;
          if (typeof window !== 'undefined' && typeof window.QRCode !== 'undefined') {
            clearInterval(timer);
            return resolve();
          }
          if (tries > 50) {
            clearInterval(timer);
            return resolve();
          }
        }, 50);
        return;
      }
      const s = document.createElement('script');
      s.src = './vendors/qrcode/qrcode.min.js';
      s.async = false;
      s.dataset.dyn = 'qrcode';
      s.onload = () => resolve();
      s.onerror = () => resolve();
      document.head.appendChild(s);
    } catch {
      resolve();
    }
  });
}

// Modal display removed per requirements

Init();

// Read-only Client Info modal
async function OpenClientInfo(UUID) {
  try {
    await CloseAllModals();
  } catch (err) {
    HandleNonFatalError('SelectionInit:NonFatal', err);
  }
  let Client = null;
  try {
    Client = await window.API.GetClient(UUID);
  } catch (e) {
    console.error('Failed to fetch client', e);
  }
  if (!Client) return Notify('Client not found', 'error');

  const { Nickname, Hostname, IP, Version, MacAddress, OperatingSystem, GroupID, Online } = Client;
  // Group title lookup
  let groupTitle = 'No Group';
  try {
    const groups = await window.API.GetAllGroups();
    if (Array.isArray(groups)) {
      const g = groups.find((x) => x && x.GroupID === GroupID);
      if (g && g.Title) groupTitle = g.Title;
    }
  } catch (err) {
    HandleNonFatalError('SelectionInit:NonFatal', err);
  }

  $('#CLIENT_INFO_NICKNAME').val(Nickname && Nickname.length ? Nickname : Hostname || '');
  $('#CLIENT_INFO_HOSTNAME').val(Hostname || '');
  $('#CLIENT_INFO_OPERATING_SYSTEM').val(OperatingSystem || '');
  $('#CLIENT_INFO_GROUP').val(groupTitle);
  $('#CLIENT_INFO_IP').val(IP || 'Unknown IP');
  if (MacAddress && String(MacAddress).trim().length > 0) {
    $('#CLIENT_INFO_MAC').val(String(MacAddress).toUpperCase());
    $('#CLIENT_INFO_MAC_WRAPPER').removeClass('d-none');
  } else {
    $('#CLIENT_INFO_MAC').val('');
    $('#CLIENT_INFO_MAC_WRAPPER').addClass('d-none');
  }
  $('#CLIENT_INFO_UUID').val(UUID);
  $('#CLIENT_INFO_VERSION').val(Version || '');
  $('#CLIENT_INFO_STATUS').val(Online ? (Client.Degraded ? 'Degraded' : 'Online') : 'Offline');

  RenderClientInfoDetails(Client);

  $('#SHOWTRAK_CLIENT_INFO_USB_DEVICES')
    .off('click.critical-usb-toggle', '.SHOWTRAK_TOGGLE_CRITICAL_USB')
    .on('click.critical-usb-toggle', '.SHOWTRAK_TOGGLE_CRITICAL_USB', async function () {
      try {
        const IsUnavailable = String($(this).attr('data-unavailable') || '0') === '1';
        if (IsUnavailable) return;
        const SerialToken = ($(this).attr('data-serial') || '').toString();
        const SerialNumber = decodeURIComponent(SerialToken);
        const IsCritical = String($(this).attr('data-critical') || '0') === '1';
        if (!ClientInfoOpenUUID || !SerialNumber) return;

        const [Err] = IsCritical
          ? await window.API.RemoveClientUSBDeviceCritical(ClientInfoOpenUUID, SerialNumber)
          : await window.API.MarkClientUSBDeviceCritical(ClientInfoOpenUUID, {
              SerialNumber,
            });
        if (Err) return Notify(String(Err), 'error');

        await Notify(
          IsCritical ? 'Critical USB status removed' : 'USB device marked as critical',
          'success',
          1400
        );

        const Fresh = await window.API.GetClient(ClientInfoOpenUUID);
        if (Fresh) {
          $('#CLIENT_INFO_STATUS').val(
            Fresh.Online ? (Fresh.Degraded ? 'Degraded' : 'Online') : 'Offline'
          );
          RenderClientInfoDetails(Fresh);
        }
      } catch (err) {
        HandleNonFatalError('OpenClientInfo:ToggleCriticalUSB', err);
      }
    });

  // mark modal as open for this UUID and clear when hidden
  ClientInfoOpenUUID = UUID;
  try {
    const $modal = $('#SHOWTRAK_CLIENT_INFO');
    $modal.off('hidden.bs.modal.clientinfo').on('hidden.bs.modal.clientinfo', function () {
      ClientInfoOpenUUID = null;
      if (ClientInfoRefreshTimer) {
        clearInterval(ClientInfoRefreshTimer);
        ClientInfoRefreshTimer = null;
      }
      __clientInfoRefreshInFlight = false;
      
      // Dispose all popovers to prevent stuck state
      try {
        const popovers = document.querySelectorAll('[data-bs-toggle="popover"]');
        for (const el of popovers) {
          const instance = bootstrap.Popover.getInstance(el);
          if (instance) instance.dispose();
        }
      } catch (e) {
        // ignore popover cleanup errors
      }
    });
  } catch (err) {
    HandleNonFatalError('SelectionInit:NonFatal', err);
  }

  $('#SHOWTRAK_CLIENT_INFO').modal('show');

  // Start periodic refresh as a safety net in case events are missed
  try {
    if (ClientInfoRefreshTimer) {
      clearInterval(ClientInfoRefreshTimer);
      ClientInfoRefreshTimer = null;
    }
    ClientInfoRefreshTimer = setInterval(async () => {
      if (!ClientInfoOpenUUID) return;
      if (__clientInfoRefreshInFlight) return;
      __clientInfoRefreshInFlight = true;
      try {
        const fresh = await window.API.GetClient(ClientInfoOpenUUID);
        if (fresh) RenderClientInfoDetails(fresh);
      } catch (err) {
    HandleNonFatalError('SelectionInit:NonFatal', err);
  }
      __clientInfoRefreshInFlight = false;
    }, 4000);
  } catch (err) {
    HandleNonFatalError('SelectionInit:NonFatal', err);
  }
}

function RenderClientInfoDetails(Client) {
  try {
    $('#CLIENT_INFO_OPERATING_SYSTEM').val(
      (Client && Client.OperatingSystem ? String(Client.OperatingSystem) : '') || ''
    );
  } catch (err) {
    HandleNonFatalError('SelectionInit:NonFatal', err);
  }

  try {
    $('#CLIENT_INFO_STATUS').val(
      Client && Client.Online ? (Client.Degraded ? 'Degraded' : 'Online') : 'Offline'
    );
  } catch (err) {
    HandleNonFatalError('SelectionInit:NonFatal', err);
  }

  // Vitals (CPU/RAM) progress bars
  try {
    const rawCpu = Client && Client.Vitals ? Client.Vitals.CPU?.UsagePercentage : 0;
    const cpuNum = typeof rawCpu === 'number' ? rawCpu : parseFloat(rawCpu);
    const cpuClamped = isNaN(cpuNum) ? 0 : Math.max(0, Math.min(100, cpuNum));

    const rawRam = Client && Client.Vitals ? Client.Vitals.Ram?.UsagePercentage : 0;
    const ramNum = typeof rawRam === 'number' ? rawRam : parseFloat(rawRam);
    const ramClamped = isNaN(ramNum) ? 0 : Math.max(0, Math.min(100, ramNum));

    $('#CLIENT_INFO_CPU_BAR')
      .css('width', `${cpuClamped}%`)
      .attr('aria-valuenow', cpuClamped.toFixed(0));
    $('#CLIENT_INFO_CPU_LABEL').text(`${cpuClamped.toFixed(0)}%`);
    $('#CLIENT_INFO_RAM_BAR')
      .css('width', `${ramClamped}%`)
      .attr('aria-valuenow', ramClamped.toFixed(0));
    // Compose RAM label: used/total (percent%) if we have byte counts
    const ramUsed =
      Client && Client.Vitals && typeof Client.Vitals.Ram?.Used !== 'undefined'
        ? Client.Vitals.Ram.Used
        : null;
    const ramTotal =
      Client && Client.Vitals && typeof Client.Vitals.Ram?.Total !== 'undefined'
        ? Client.Vitals.Ram.Total
        : null;
    if (ramUsed != null && ramTotal != null) {
      const usedStr = FormatBytes(ramUsed);
      const totalStr = FormatBytes(ramTotal);
      if (usedStr && totalStr) {
        $('#CLIENT_INFO_RAM_LABEL').text(`${usedStr} / ${totalStr} (${ramClamped.toFixed(0)}%)`);
      } else {
        $('#CLIENT_INFO_RAM_LABEL').text(`${ramClamped.toFixed(0)}%`);
      }
    } else {
      $('#CLIENT_INFO_RAM_LABEL').text(`${ramClamped.toFixed(0)}%`);
    }
  } catch (err) {
    HandleNonFatalError('SelectionInit:NonFatal', err);
  }

  // USB devices
  try {
    const $usbList = $('#SHOWTRAK_CLIENT_INFO_USB_DEVICES');
    const list = Array.isArray(Client.USBDeviceList) ? Client.USBDeviceList : [];
    const clientKey = Client && Client.UUID ? String(Client.UUID) : '';
    const renderKey = `${clientKey}::${list
      .map((d) => `${d.SerialNumber || ''}|${d.IsCritical ? '1' : '0'}|${d.IsConnected === false ? '0' : '1'}`)
      .join(';;')}`;
    const previousRenderKey = $usbList.attr('data-render-key') || '';

    if (previousRenderKey !== renderKey) {
      // Dispose old popovers before replacing USB rows to avoid dangling tooltips.
      try {
        $usbList.find('.SHOWTRAK_TOGGLE_CRITICAL_USB[data-bs-toggle="popover"]').each(function () {
          const instance = bootstrap.Popover.getInstance(this);
          if (instance) instance.dispose();
        });
      } catch (e) {
        // Best effort cleanup only.
      }

      if (list.length === 0) {
        $usbList.html(`
          <div class="rounded-3 p-2 bg-ghost">
            <h6 class="mb-0">No USB Devices Connected</h6>
            <p class="text-sm mb-0">Devices that do not comply with WebUSB 1.3 cannot be displayed.</p>
          </div>`);
      } else {
        $usbList.html('');
        for (const dev of list) {
          const ManufacturerName = dev.ManufacturerName;
          const ProductName = dev.ProductName;
          const SerialNumber = dev.SerialNumber;
          const IsCritical = !!dev.IsCritical;
          const IsConnected = dev.IsConnected !== false;
          const HasSerial = typeof SerialNumber === 'string' && SerialNumber.trim().length > 0;
          const SerialToken = HasSerial ? encodeURIComponent(SerialNumber.trim()) : '';
          $usbList.append(`
            <div class="rounded-3 p-2 bg-ghost SHOWTRAK_CLIENT_USB_DEVICE_CARD">
              <div class="d-flex align-items-center gap-2">
                <h6 class="mb-0">${ManufacturerName ? Safe(ManufacturerName) : 'Generic'} ${
                  ProductName ? Safe(ProductName) : 'USB Device'
                }</h6>
              </div>
              <small class="text-light d-block mb-0 text-start">${
                HasSerial ? Safe(SerialNumber) : 'Unavailable'
              }</small>
              <button
                type="button"
                class="SHOWTRAK_TOGGLE_CRITICAL_USB ${IsCritical ? 'is-critical' : ''} ${
                  IsCritical && !IsConnected ? 'is-disconnected-critical' : ''
                } ${
                  HasSerial ? '' : 'is-unavailable'
                }"
                data-serial="${SerialToken}"
                data-critical="${IsCritical ? '1' : '0'}"
                data-unavailable="${HasSerial ? '0' : '1'}"
                ${
                  HasSerial
                    ? `title="${
                        IsCritical && !IsConnected
                          ? 'Remove critical status (device disconnected)'
                          : IsCritical
                          ? 'Remove critical status'
                          : 'Mark as critical'
                      }"`
                    : ''
                }
                aria-label="${
                  HasSerial
                    ? IsCritical && !IsConnected
                      ? 'Remove critical status (device disconnected)'
                      : IsCritical
                      ? 'Remove critical status'
                      : 'Mark as critical'
                    : 'Unavailble due to missing serial number'
                }"
                ${
                  HasSerial
                    ? ''
                    : 'data-bs-toggle="popover" data-bs-trigger="hover focus" data-bs-placement="left" data-bs-custom-class="SHOWTRAK_USB_POPOVER" data-bs-content="Unavailble due to missing serial number"'
                }
              >
                <i class="bi ${IsCritical && !IsConnected ? 'bi-x-circle-fill' : IsCritical ? 'bi-check-circle-fill' : 'bi-check-circle'}"></i>
                <span>${IsCritical && !IsConnected ? 'Disconnected' : 'Critical'}</span>
              </button>
            </div>
          `);
        }
      }

      $usbList.attr('data-render-key', renderKey);

      try {
        const Nodes = document.querySelectorAll(
          '#SHOWTRAK_CLIENT_INFO_USB_DEVICES .SHOWTRAK_TOGGLE_CRITICAL_USB[data-bs-toggle="popover"]'
        );
        for (const Node of Nodes) {
          if (!Node) continue;
          if (bootstrap.Popover.getInstance(Node)) continue;
          new bootstrap.Popover(Node, {
            container: 'body',
          });
        }
      } catch (err) {
        HandleNonFatalError('RenderClientInfoDetails:CriticalUSBPopoverInit', err);
      }
    }
  } catch (err) {
    HandleNonFatalError('SelectionInit:NonFatal', err);
  }

  // Network Interfaces
  try {
    const $netList = $('#SHOWTRAK_CLIENT_INFO_NET_INTERFACES');
    $netList.html('');
    const ifaces = Array.isArray(Client.NetworkInterfaces) ? Client.NetworkInterfaces : [];
    if (ifaces.length === 0) {
      $netList.html(
        `<div class="rounded-3 p-2 bg-ghost"><h6 class="mb-0">No Interfaces Reported</h6></div>`
      );
    } else {
      // Sort active first: interfaces with any external (non-internal) address
      const sorted = [...ifaces].sort((a, b) => {
        const aActive =
          Array.isArray(a.addresses) && a.addresses.some((x) => x.address && !x.internal);
        const bActive =
          Array.isArray(b.addresses) && b.addresses.some((x) => x.address && !x.internal);
        return (bActive ? 1 : 0) - (aActive ? 1 : 0);
      });
      for (const iface of sorted) {
        const nameRaw = iface && iface.name ? String(iface.name) : 'unknown';
        const name = Safe(nameRaw || 'unknown');
        const addresses = Array.isArray(iface.addresses) ? iface.addresses : [];
        const macs = Array.from(
          new Set(addresses.map((a) => (a.mac ? String(a.mac).toUpperCase() : '')).filter(Boolean))
        );
        const v4 = addresses.filter((a) => String(a.family).includes('4'));
        const v6 = addresses.filter((a) => String(a.family).includes('6'));
        const displayedAddrs = v4.length > 0 ? v4 : v6; // show IPv6 only if no IPv4 available
        const activeCount = addresses.filter((a) => a.address && !a.internal).length;
        const isActive = activeCount > 0;
        let addrHtml = '';
        if (displayedAddrs.length > 0) {
          for (let i = 0; i < displayedAddrs.length; i++) {
            const a = displayedAddrs[i];
            const fam = Safe(a.family || '');
            const addr = Safe(a.address || '');
            const mask = Safe(a.netmask || '');
            const cidr = a.cidr ? Safe(a.cidr) : '';
            const prefix = cidr && cidr.includes('/') ? `/${cidr.split('/')[1]}` : '';
            const mac = a.mac ? Safe(String(a.mac).toUpperCase()) : '';
            const internalBadge = a.internal
              ? '<span class="badge bg-ghost-light text-light">Internal Only</span>'
              : '<span class="badge bg-ghost text-light">External</span>';
            const scopeEl =
              typeof a.scopeid !== 'undefined' && a.scopeid !== null
                ? `<div class=\"text-sm text-muted\">scope ${Safe(a.scopeid)}</div>`
                : '';
            const idBase = 'IFACE_' + nameRaw.replace(/[^a-zA-Z0-9_-]/g, '') + '_' + i;
            const addrId = idBase + '_ADDR';
            const maskId = idBase + '_MASK';
            const macId = idBase + '_MAC';
            addrHtml += `
              <div class="rounded p-2 d-grid gap-2">
                <div class="d-flex justify-content-between align-items-center">
                  <div class="d-flex gap-2 align-items-center">
                    <span class="badge bg-ghost text-light">${fam}</span>
                    ${internalBadge}
                  </div>
                  ${scopeEl}
                </div>
                <div class="form-floating has-copy">
                  <input type="text" class="form-control disabled" id="${addrId}" value="${addr}${prefix}" disabled />
                  <label for="${addrId}">Address</label>
                  <button type="button" class="copy-field-btn" data-target="#${addrId}" title="Copy">
                    <i class="bi bi-clipboard"></i>
                  </button>
                </div>
                ${
                  mask
                    ? `<div class=\"form-floating has-copy\">` +
                      `<input type=\"text\" class=\"form-control disabled\" id=\"${maskId}\" value=\"${mask}\" disabled />` +
                      `<label for=\"${maskId}\">Netmask</label>` +
                      `<button type=\"button\" class=\"copy-field-btn\" data-target=\"#${maskId}\" title=\"Copy\"><i class=\"bi bi-clipboard\"></i></button>` +
                      `</div>`
                    : ''
                }
                ${
                  mac
                    ? `<div class=\"form-floating has-copy\">` +
                      `<input type=\"text\" class=\"form-control disabled\" id=\"${macId}\" value=\"${mac}\" disabled />` +
                      `<label for=\"${macId}\">MAC Address</label>` +
                      `<button type=\"button\" class=\"copy-field-btn\" data-target=\"#${macId}\" title=\"Copy\"><i class=\"bi bi-clipboard\"></i></button>` +
                      `</div>`
                    : ''
                }
              </div>`;
          }
        } else {
          addrHtml =
            '<div class="text-sm text-muted rounded p-2">No addresses (adapter inactive)</div>';
        }
        const macSummary = macs.length
          ? `<div class="text-sm text-muted">${macs.map((m) => `<code>${Safe(m)}</code>`).join(' • ')}</div>`
          : '';
        $netList.append(`
          <div class="rounded-3 p-2 bg-ghost">
            <div class="d-flex justify-content-between align-items-center">
              <div class="text-start">
                <h6 class="mb-0">${name}</h6>
              </div>
              <div class="d-flex gap-1 align-items-center">
                <span class="badge ${isActive ? 'bg-success' : 'bg-secondary'}">${isActive ? 'Active' : 'Inactive'}</span>
              </div>
            </div>
            <div class="d-grid gap-1 mt-2">${addrHtml}</div>
          </div>`);
      }
    }
  } catch (err) {
    HandleNonFatalError('SelectionInit:NonFatal', err);
  }
}
