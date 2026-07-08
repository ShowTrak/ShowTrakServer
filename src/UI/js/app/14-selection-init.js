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
    if (typeof UpdateIdentifyStatusBanner === 'function') UpdateIdentifyStatusBanner();

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
      if (typeof UpdateIdentifyStatusBanner === 'function') UpdateIdentifyStatusBanner();
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

const MINIMUM_IDENTIFY_VERSION = [3, 7, 0];
const MINIMUM_DISPLAY_MONITORING_VERSION = [3, 8, 0];

function ParseSemverTuple(value) {
  const Match = String(value || '')
    .trim()
    .match(/(?:^|[^0-9])(\d+)\.(\d+)\.(\d+)(?:[^0-9]|$)/);
  if (!Match) return null;
  return [Number(Match[1]), Number(Match[2]), Number(Match[3])];
}

function IsVersionAtLeast(value, minimumTuple) {
  const Parsed = ParseSemverTuple(value);
  if (!Parsed) return false;
  for (let i = 0; i < minimumTuple.length; i++) {
    const Current = Parsed[i] || 0;
    const Minimum = minimumTuple[i] || 0;
    if (Current > Minimum) return true;
    if (Current < Minimum) return false;
  }
  return true;
}

function GetIdentifyTargetByUUID(UUID) {
  const AdoptedTarget = Array.isArray(AllClients)
    ? AllClients.find((c) => c && c.UUID === UUID)
    : null;
  const PendingTarget = Array.isArray(PendingAdoption)
    ? PendingAdoption.find((d) => d && d.UUID === UUID)
    : null;

  if (AdoptedTarget) {
    const Eligible =
      !IsIntegratedClientEntity(AdoptedTarget) &&
      !!AdoptedTarget.Online &&
      IsVersionAtLeast(AdoptedTarget.Version, MINIMUM_IDENTIFY_VERSION);
    return {
      UUID,
      Eligible,
      IsIdentifying: !!AdoptedTarget.Identifying,
    };
  }

  if (PendingTarget) {
    return {
      UUID,
      Eligible: IsVersionAtLeast(PendingTarget.Version, MINIMUM_IDENTIFY_VERSION),
      IsIdentifying: !!PendingTarget.Identifying,
    };
  }

  return {
    UUID,
    Eligible: false,
    IsIdentifying: false,
  };
}

function GetIdentifyingUUIDs() {
  // Primary source: live rendered tiles. This stays accurate even when an
  // incremental push updates classes before list caches are reconciled.
  const FromDom = new Set();
  try {
    $('.SHOWTRAK_PC.IDENTIFYING[data-uuid]').each(function () {
      const UUID = String($(this).attr('data-uuid') || '').trim();
      if (UUID) FromDom.add(UUID);
    });
  } catch (err) {
    HandleNonFatalError('SelectionInit:GetIdentifyingUUIDs', err);
  }
  if (FromDom.size > 0) return Array.from(FromDom);

  // Fallback source: cached entity lists.
  const Identifying = new Set();
  (Array.isArray(AllClients) ? AllClients : []).forEach((Client) => {
    if (Client && Client.UUID && Client.Identifying) Identifying.add(Client.UUID);
  });
  (Array.isArray(PendingAdoption) ? PendingAdoption : []).forEach((Device) => {
    if (Device && Device.UUID && Device.Identifying) Identifying.add(Device.UUID);
  });
  return Array.from(Identifying);
}

function ApplyIdentifyStateLocally(UUIDs, Identifying) {
  const Unique = new Set((Array.isArray(UUIDs) ? UUIDs : []).filter(Boolean));
  const Next = !!Identifying;
  if (!Unique.size) return;

  (Array.isArray(AllClients) ? AllClients : []).forEach((Client) => {
    if (!Client || !Client.UUID) return;
    if (!Unique.has(Client.UUID)) return;
    Client.Identifying = Next;
  });

  (Array.isArray(PendingAdoption) ? PendingAdoption : []).forEach((Device) => {
    if (!Device || !Device.UUID) return;
    if (!Unique.has(Device.UUID)) return;
    Device.Identifying = Next;
  });

  if (typeof RenderFullClientAndMonitorList === 'function') {
    RenderFullClientAndMonitorList();
  }
  UpdateIdentifyStatusBanner();
}

async function StopIdentifyingForUUIDs(UUIDs) {
  const List = Array.from(new Set((Array.isArray(UUIDs) ? UUIDs : []).filter(Boolean)));
  if (!List.length) return { succeeded: [], failed: [] };
  const Results = await Promise.all(List.map((UUID) => window.API.StopIdentifyingClient(UUID)));
  const Succeeded = [];
  const Failed = [];
  Results.forEach((Result, Index) => {
    const Err = Array.isArray(Result) ? Result[0] : null;
    if (Err) {
      Failed.push({ UUID: List[Index], Error: Err });
    } else {
      Succeeded.push(List[Index]);
    }
  });
  if (Succeeded.length) ApplyIdentifyStateLocally(Succeeded, false);
  // If server says a target is missing, clear it locally to avoid a stuck
  // banner caused by stale UI state.
  const Missing = Failed.filter((Entry) => /not found/i.test(String(Entry.Error || ''))).map(
    (Entry) => Entry.UUID
  );
  if (Missing.length) ApplyIdentifyStateLocally(Missing, false);
  const Errors = Failed.map((Entry) => Entry.Error).filter(Boolean);
  if (Errors.length && typeof Notify === 'function') {
    Notify(String(Errors[0]), 'danger');
  }
  return { succeeded: Succeeded, failed: Failed };
}

function UpdateIdentifyStatusBanner() {
  const $Banner = $('#IDENTIFY_STATUS_BANNER');
  const $Text = $('#IDENTIFY_STATUS_TEXT');
  if (!$Banner.length || !$Text.length) return;
  const IdentifyingUUIDs = GetIdentifyingUUIDs();
  const Count = IdentifyingUUIDs.length;
  if (!Count) {
    $Banner.addClass('d-none');
    return;
  }
  $Text.text(`You are currently identifying ${Count} ${Count === 1 ? 'client' : 'clients'}`);
  const hasConfirmToast = $('#SHOWTRAK_CONFIRM_TOAST').length > 0;
  $Banner.toggleClass('stacked-above-confirm', hasConfirmToast);
  $Banner.removeClass('d-none');
}

function Select(UUID) {
  // Allow selecting adopted clients and pending-adoption devices. Monitoring
  // and dummy tiles use prefixed data-uuid values so they never match here.
  try {
    const $tiles = $(`.SHOWTRAK_PC[data-uuid='${UUID}']`);
    if (!$tiles || !$tiles.length) return;
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
  // Allow toggling adopted clients and pending-adoption devices.
  try {
    const $tiles = $(`.SHOWTRAK_PC[data-uuid='${UUID}']`);
    if (!$tiles || !$tiles.length) return;
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
      $(this).html(`Offline <span class="badge bg-ghost">${HH}:${MM}:${SS}</span>`);
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

  $(document).on('click', '#IDENTIFY_STOP_ALL_BUTTON', async function (e) {
    e.preventDefault();
    try {
      await StopIdentifyingForUUIDs(GetIdentifyingUUIDs());
    } catch (err) {
      HandleNonFatalError('SelectionInit:StopIdentifyAll', err);
    } finally {
      UpdateIdentifyStatusBanner();
    }
  });

  $(document).on('click', '.GROUP_TITLE_CLICKABLE[data-groupid]', function (e) {
    e.preventDefault();
    const groupId = $(this).attr('data-groupid');
    SelectByGroup(groupId);
  });

  // Global keybinds: toggle a group's selection when its assigned keyboard/numpad
  // number is pressed. Ignored while typing in a field or while a modal is open.
  $(document).on('keydown.groupKeybind', function (e) {
    if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;

    const Target = e.target;
    if (Target) {
      const Tag = String(Target.tagName || '').toUpperCase();
      if (Tag === 'INPUT' || Tag === 'TEXTAREA' || Tag === 'SELECT' || Target.isContentEditable) {
        return;
      }
    }

    if (document.querySelector('.modal.show')) return;

    const Groups = Array.isArray(__LastGroups) ? __LastGroups : [];
    const Match = Groups.find((Group) => Group && Group.KeyBind === e.code);
    if (!Match) return;

    e.preventDefault();
    SelectByGroup(Match.GroupID);
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
    // Dummy clients use their own editor
    if ($(this).hasClass('DUMMY_TILE_COG')) {
      const duid = $(this).closest('.SHOWTRAK_PC').attr('data-dummy-uuid');
      if (duid) OpenDummyClientEditor(duid);
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
    // Monitoring tiles aren't selectable client targets
    if ($(this).hasClass('MONITOR')) return false;
    // Dummy tiles aren't selectable client targets
    if ($(this).hasClass('DUMMY')) return false;
    // Pending-adoption tiles are selectable (for Identify), but clicking the
    // Adopt button must not toggle selection.
    if ($(this).hasClass('PENDING')) {
      if ($(e.target).closest('.ADOPT_BTN, [data-type="PENDING_ACTION"]').length) return false;
      const PendingUUID = $(this).attr('data-uuid');
      if (PendingUUID) ToggleSelection(PendingUUID);
      return false;
    }
    let UUID = $(this).attr('data-uuid');
    ToggleSelection(UUID);
    return;
  });
  // Double-click opens read-only info/history views (not editors)
  $(document).on('dblclick', '.SHOWTRAK_PC', function (e) {
    e.preventDefault();
    e.stopPropagation();
    // Ignore dblclick on pending-adoption tiles
    if ($(this).hasClass('PENDING')) return false;
    // Monitoring tiles always open history on dblclick; edit mode uses the cog.
    if ($(this).hasClass('MONITOR')) {
      const tid = $(this).attr('data-target-id');
      if (tid) {
        OpenMonitoringTargetHistory(parseInt(tid, 10));
      }
      return false;
    }
    // Dummy tiles open uptime history on dblclick
    if ($(this).hasClass('DUMMY')) {
      const duid = $(this).attr('data-dummy-uuid');
      if (duid) OpenDummyClientHistory(duid);
      return false;
    }
    const uuid = $(this).attr('data-uuid');
    if (uuid) OpenClientInfo(uuid);
    return false;
  });
  $(document).on('contextmenu', 'html', async function (e) {
    e.preventDefault();

    const $tile = $(e.target).closest('.SHOWTRAK_PC');
    if ($tile.length) {
      const TileUUID = $tile.attr('data-uuid');
      const IsClientTile =
        TileUUID &&
        !$tile.hasClass('MONITOR') &&
        !$tile.hasClass('DUMMY') &&
        !$tile.hasClass('GROUP');
      if (IsClientTile && !Selected.includes(TileUUID)) {
        ClearSelection();
        Select(TileUUID);
      }
    }

    let Options = [];

    if (Selected.length == 0) {
      Options.push({
        Type: 'Info',
        Title: 'No Selected Clients',
        Class: 'text-muted',
      });
    }

    if (Selected.length > 0) {
      // Build the set of actions that can run on EVERY selected client.
      //  - OS clients expose their scripts (compatible with the client's OS).
      //  - Integrated clients expose their declared events.
      // A mixed selection (e.g. a Windows client + an integrated client) shares
      // no runnable actions, so the menu shows none.
      const CONTEXT_COLOUR_PALETTE = [
        '#e74c3c',
        '#e67e22',
        '#f1c40f',
        '#2ecc71',
        '#3498db',
        '#9b59b6',
        '#bdc3c7',
        '#7f8c8d',
      ];
      const ColourFromIndex = (Index) =>
        typeof Index === 'number' && Index >= 0 && Index <= 7
          ? CONTEXT_COLOUR_PALETTE[Index]
          : '#bdc3c7';

      ScriptList = ScriptList.sort((a, b) => (a.Weight || 0) - (b.Weight || 0));

      const SelectedClients = Selected.map((UUID) =>
        AllClients.find((c) => c && c.UUID === UUID)
      ).filter(Boolean);

      const IsIntegratedClient = (Client) =>
        !!(Client && (Client.Integrated || Client.OperatingSystem === 'Integrated'));

      // Catalogue of every integrated event seen across the selection (by ID),
      // used to render label/colour once an event is in the shared set.
      const EventCatalogue = new Map();

      // Compute the runnable action keys for a single client.
      const RunnableKeysFor = (Client) => {
        const Keys = new Set();
        if (IsIntegratedClient(Client)) {
          const Actions = Array.isArray(Client.IntegratedActions) ? Client.IntegratedActions : [];
          for (const Action of Actions) {
            if (!Action || !Action.ID) continue;
            Keys.add(`event:${Action.ID}`);
            if (!EventCatalogue.has(Action.ID)) EventCatalogue.set(Action.ID, Action);
          }
        } else {
          const OS = Client.OperatingSystem;
          for (const Script of ScriptList) {
            const Compatible = Array.isArray(Script.CompatiblePlatforms)
              ? Script.CompatiblePlatforms
              : [];
            if (OS && Compatible.includes(OS)) Keys.add(`script:${String(Script.ID)}`);
          }
        }
        return Keys;
      };

      // Intersection of runnable keys across all selected clients.
      let SharedKeys = null;
      for (const Client of SelectedClients) {
        const Keys = RunnableKeysFor(Client);
        if (SharedKeys === null) {
          SharedKeys = Keys;
        } else {
          SharedKeys = new Set([...SharedKeys].filter((Key) => Keys.has(Key)));
        }
      }
      if (!SharedKeys) SharedKeys = new Set();

      const SharedScripts = ScriptList.filter((Script) =>
        SharedKeys.has(`script:${String(Script.ID)}`)
      );
      for (const Script of SharedScripts) {
        const ColourHex = ColourFromIndex(Script.Colour);
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

      const SharedEvents = [...EventCatalogue.values()]
        .filter((Action) => SharedKeys.has(`event:${Action.ID}`))
        .sort((a, b) => String(a.Label || '').localeCompare(String(b.Label || '')));
      for (const Event of SharedEvents) {
        Options.push({
          Type: 'Action',
          Title: `${Event.Label || Event.ID}`,
          Class: '',
          ColourHex: ColourFromIndex(Event.ColourIndex),
          Action: async function () {
            await TriggerIntegratedEvent(Event.ID, Selected);
          },
        });
      }

      if (SharedScripts.length + SharedEvents.length > 0) {
        Options.push({
          Type: 'Divider',
        });
      }

      // Identify / Stop Identifying for selected clients.
      const IdentifyTargets = Selected.map((UUID) => GetIdentifyTargetByUUID(UUID)).filter(
        (Target) => Target && Target.Eligible
      );
      const IdentifyStartTargets = IdentifyTargets.filter((Target) => !Target.IsIdentifying);
      const IdentifyStopTargets = IdentifyTargets.filter((Target) => Target.IsIdentifying);

      if (IdentifyStartTargets.length > 0) {
        Options.push({
          Type: 'Action',
          Title: IdentifyStartTargets.length === 1 ? 'Identify Client' : 'Identify Clients',
          Class: 'text-light',
          Action: async function () {
            try {
              const UUIDs = IdentifyStartTargets.map((Target) => Target.UUID);
              const Results = await Promise.all(
                UUIDs.map((UUID) => window.API.IdentifyClient(UUID))
              );
              const Succeeded = [];
              const Failed = [];
              Results.forEach((Result, Index) => {
                const Err = Array.isArray(Result) ? Result[0] : null;
                if (Err) Failed.push({ UUID: UUIDs[Index], Error: Err });
                else Succeeded.push(UUIDs[Index]);
              });
              if (Succeeded.length) ApplyIdentifyStateLocally(Succeeded, true);
              const Errors = Failed.map((Entry) => Entry.Error).filter(Boolean);
              if (Errors.length && typeof Notify === 'function')
                Notify(String(Errors[0]), 'danger');
            } catch (err) {
              HandleNonFatalError('SelectionInit:Identify', err);
            }
          },
        });
      }

      if (IdentifyStopTargets.length > 0) {
        Options.push({
          Type: 'Action',
          Title:
            IdentifyStopTargets.length === 1 ? 'Stop Identifying' : 'Stop Identifying Selected',
          Class: 'text-light',
          Action: async function () {
            try {
              await StopIdentifyingForUUIDs(IdentifyStopTargets.map((Target) => Target.UUID));
            } catch (err) {
              HandleNonFatalError('SelectionInit:StopIdentify', err);
            }
          },
        });
      }

      if (IdentifyStartTargets.length + IdentifyStopTargets.length > 0) {
        Options.push({ Type: 'Divider' });
      }
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
        AllClients.map((Client) => Select(Client.UUID));
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
    const navbarEl = document.querySelector('.dragbar');
    const navbarRect = navbarEl ? navbarEl.getBoundingClientRect() : null;
    const minX = Math.max(edgePadding, Math.floor(boundsRect.left) + edgePadding);
    const containerMinY = Math.max(edgePadding, Math.floor(boundsRect.top) + edgePadding);
    const navbarMinY = navbarRect
      ? Math.min(viewportHeight - edgePadding, Math.floor(navbarRect.bottom) + edgePadding)
      : edgePadding;
    const minY = Math.max(containerMinY, navbarMinY);
    const maxX = Math.min(viewportWidth - edgePadding, Math.floor(boundsRect.right) - edgePadding);
    const maxY = Math.min(
      viewportHeight - edgePadding,
      Math.floor(boundsRect.bottom) - edgePadding
    );
    const availableHeight = Math.max(120, maxY - minY);
    // Allow the menu to use most of the available UI height while still
    // staying inside the viewport-clamped UI bounds.
    const maxMenuHeight = Math.max(220, Math.floor(availableHeight - edgePadding));

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

  UpdateIdentifyStatusBanner();
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
  if (window.__ShowTrakExecutionAutoDismissTimer) {
    clearTimeout(window.__ShowTrakExecutionAutoDismissTimer);
    window.__ShowTrakExecutionAutoDismissTimer = null;
  }
  if (window.__ShowTrakDeploymentAutoDismissTimer) {
    clearTimeout(window.__ShowTrakDeploymentAutoDismissTimer);
    window.__ShowTrakDeploymentAutoDismissTimer = null;
  }
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
  window.API.OnAppMenuAction((ActionID) => {
    const id = String(ActionID || '').trim();
    if (!id) return;
    const button = document.getElementById(id);
    if (!button) return;
    button.click();
  });

  const isMacOS =
    navigator.userAgentData?.platform === 'macOS' || /Mac/i.test(navigator.platform || '');
  if (isMacOS) {
    window.API.OnWindowFullscreenChanged((IsFullscreen) => {
      document.body.classList.toggle('macos-native-fullscreen', Boolean(IsFullscreen));
    });
  }

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

  $('#ADD_DUMMY_CLIENT_ACTION').on('click', async () => {
    await OpenDummyClientEditor(null);
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

  $('#SHOWTRAK_CLIENT_INFO')
    .off('shown.bs.modal.monitorHistory')
    .on('shown.bs.modal.monitorHistory', () => {
      RenderMonitoringHistoryModal();
    });

  $('#MONITOR_HISTORY_EDIT_BUTTON')
    .off('click.monitorHistoryEdit')
    .on('click.monitorHistoryEdit', async function (e) {
      e.preventDefault();
      if (AppMode !== 'EDIT') return;
      const TargetID = Number($(this).attr('data-target-id'));
      if (!Number.isFinite(TargetID)) return;
      await OpenMonitoringTargetEditor(TargetID);
    });

  // Hover tooltip for status-timeline blocks (delegated; container persists).
  $('#MONITOR_HISTORY_TIMELINES')
    .off('mousemove.statusTt mouseleave.statusTt')
    .on('mousemove.statusTt', '.status-timeline-block', function (e) {
      MonitorHistoryTooltipHover = { x: e.clientX, y: e.clientY };
      ShowStatusTimelineTooltip(this, e.clientX, e.clientY);
    })
    .on('mouseleave.statusTt', function () {
      MonitorHistoryTooltipHover = null;
      HideStatusTimelineTooltip();
    });

  window.API.OnNetworkDeviceScanEvent((Event) => {
    HandleNetworkDiscoveryEvent(Event);
  });

  $('#SHOWTRAK_MODEL_CORE_OSC_ROUTE_LIST_BUTTON').on('click', async () => {
    await OpenOSCDictionary();
  });

  $('#SHOWTRAK_MODEL_CORE_OSC_HTTP_DEBUG_BUTTON').on('click', async () => {
    await OpenOscHttpDebugTerminal();
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

  $('#SHOWTRAK_MODEL_CORE_UPDATE_MANAGER_BUTTON').on('click', async () => {
    await OpenUpdateManagerModal();
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

  window.API.OnUpdateManagerDownloadProgress((Progress) => {
    try {
      if (!Progress || typeof SetUpdateManagerDownloadProgress !== 'function') return;
      const Percent = typeof Progress.percent === 'number' ? Progress.percent : 0;
      const Message = Progress.message || '';
      UpdateManagerDownloadInProgress = (Progress.phase || '') !== 'complete';
      SetUpdateManagerDownloadProgress(Percent, Message);
      if (typeof ApplyUpdateManagerButtonLocks === 'function') {
        ApplyUpdateManagerButtonLocks();
      }
    } catch (e) {
      HandleNonFatalError('UpdateManager:DownloadProgress', e);
    }
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
  if (typeof UpdateIdentifyStatusBanner === 'function') UpdateIdentifyStatusBanner();
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
  $('#CLIENT_INFO_VERSION').val(FormatClientVersionLabel(Client));
  $('#CLIENT_INFO_STATUS').val(GetClientStatusDisplayText(Client));

  window.__ClientInfoNetFamily = 'IPv4';

  RenderClientInfoDetails(Client);

  // Drive the shared status-timeline graph (same modal used by monitoring
  // targets and dummy clients) for this client.
  MonitorHistoryModalContext = { type: 'client', id: UUID };
  MonitorHistorySeries = [];
  MonitorHistoryTooltipHover = null;
  try {
    await LoadHistorySamplesForContext();
  } catch (err) {
    HandleNonFatalError('OpenClientInfo:LoadHistory', err);
  }
  RenderMonitoringHistoryModal();

  $('#SHOWTRAK_CLIENT_INFO_NET_FAMILY_V4')
    .off('click.net-family')
    .on('click.net-family', async function () {
      try {
        window.__ClientInfoNetFamily = 'IPv4';
        if (!ClientInfoOpenUUID) return;
        const Fresh = await window.API.GetClient(ClientInfoOpenUUID);
        if (Fresh) RenderClientInfoDetails(Fresh);
      } catch (err) {
        HandleNonFatalError('OpenClientInfo:NetFamilyToggle', err);
      }
    });

  $('#SHOWTRAK_CLIENT_INFO_NET_FAMILY_V6')
    .off('click.net-family')
    .on('click.net-family', async function () {
      try {
        window.__ClientInfoNetFamily = 'IPv6';
        if (!ClientInfoOpenUUID) return;
        const Fresh = await window.API.GetClient(ClientInfoOpenUUID);
        if (Fresh) RenderClientInfoDetails(Fresh);
      } catch (err) {
        HandleNonFatalError('OpenClientInfo:NetFamilyToggle', err);
      }
    });

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
          $('#CLIENT_INFO_STATUS').val(GetClientStatusDisplayText(Fresh));
          RenderClientInfoDetails(Fresh);
        }
      } catch (err) {
        HandleNonFatalError('OpenClientInfo:ToggleCriticalUSB', err);
      }
    });

  $('#SHOWTRAK_CLIENT_INFO_DISPLAYS')
    .off('click.critical-display-toggle', '.SHOWTRAK_TOGGLE_CRITICAL_DISPLAY')
    .on('click.critical-display-toggle', '.SHOWTRAK_TOGGLE_CRITICAL_DISPLAY', async function () {
      try {
        const IsUnavailable = String($(this).attr('data-unavailable') || '0') === '1';
        if (IsUnavailable) return;
        const DisplayToken = ($(this).attr('data-display') || '').toString();
        const DisplayID = decodeURIComponent(DisplayToken);
        const IsCritical = String($(this).attr('data-critical') || '0') === '1';
        if (!ClientInfoOpenUUID || !DisplayID) return;

        const [Err] = IsCritical
          ? await window.API.RemoveClientDisplayCritical(ClientInfoOpenUUID, DisplayID)
          : await window.API.MarkClientDisplayCritical(ClientInfoOpenUUID, {
              DisplayID,
            });
        if (Err) return Notify(String(Err), 'error');

        await Notify(
          IsCritical ? 'Critical display status removed' : 'Display marked as critical',
          'success',
          1400
        );

        const Fresh = await window.API.GetClient(ClientInfoOpenUUID);
        if (Fresh) {
          $('#CLIENT_INFO_STATUS').val(GetClientStatusDisplayText(Fresh));
          RenderClientInfoDetails(Fresh);
        }
      } catch (err) {
        HandleNonFatalError('OpenClientInfo:ToggleCriticalDisplay', err);
      }
    });

  $('#SHOWTRAK_CLIENT_INFO_RUNNING_APPLICATIONS')
    .off('click.critical-app-toggle', '.SHOWTRAK_TOGGLE_CRITICAL_APP')
    .on('click.critical-app-toggle', '.SHOWTRAK_TOGGLE_CRITICAL_APP', async function () {
      try {
        const NameToken = ($(this).attr('data-name') || '').toString();
        const ApplicationName = decodeURIComponent(NameToken);
        const IsCritical = String($(this).attr('data-critical') || '0') === '1';
        if (!ClientInfoOpenUUID || !ApplicationName) return;

        const [Err] = IsCritical
          ? await window.API.RemoveClientApplicationCritical(ClientInfoOpenUUID, ApplicationName)
          : await window.API.MarkClientApplicationCritical(ClientInfoOpenUUID, {
              Name: ApplicationName,
            });
        if (Err) return Notify(String(Err), 'error');

        await Notify(
          IsCritical ? 'Critical application status removed' : 'Application marked as critical',
          'success',
          1400
        );

        const Fresh = await window.API.GetClient(ClientInfoOpenUUID);
        if (Fresh) {
          $('#CLIENT_INFO_STATUS').val(GetClientStatusDisplayText(Fresh));
          RenderClientInfoDetails(Fresh);
        }
      } catch (err) {
        HandleNonFatalError('OpenClientInfo:ToggleCriticalApplication', err);
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

      // Shared status-timeline modal state teardown.
      MonitorHistoryModalContext = null;
      MonitorHistorySeries = [];
      MonitorHistoryTooltipHover = null;
      HideStatusTimelineTooltip();

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
  const IsIntegrated = IsIntegratedClientEntity(Client);

  try {
    $('#CLIENT_INFO_USB_SECTION').toggleClass('d-none', IsIntegrated);
    $('#CLIENT_INFO_DISPLAYS_SECTION').toggleClass('d-none', IsIntegrated);
    $('#CLIENT_INFO_NETWORK_SECTION').toggleClass('d-none', IsIntegrated);
    $('#CLIENT_INFO_RUNNING_APPS_SECTION').toggleClass('d-none', IsIntegrated);
  } catch (err) {
    HandleNonFatalError('SelectionInit:NonFatal', err);
  }

  try {
    $('#CLIENT_INFO_OPERATING_SYSTEM').val(
      (Client && Client.OperatingSystem ? String(Client.OperatingSystem) : '') || ''
    );
  } catch (err) {
    HandleNonFatalError('SelectionInit:NonFatal', err);
  }

  try {
    $('#CLIENT_INFO_STATUS').val(GetClientStatusDisplayText(Client));
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

  if (IsIntegrated) {
    try {
      $('#SHOWTRAK_CLIENT_INFO_USB_DEVICES').attr('data-render-key', '').html('');
      $('#SHOWTRAK_CLIENT_INFO_DISPLAYS').attr('data-render-key', '').html('');
      $('#SHOWTRAK_CLIENT_INFO_RUNNING_APPLICATIONS').attr('data-render-key', '').html('');
      $('#SHOWTRAK_CLIENT_INFO_NET_INTERFACES').html('');
    } catch (err) {
      HandleNonFatalError('SelectionInit:NonFatal', err);
    }
    return;
  }

  // USB devices
  try {
    const $usbList = $('#SHOWTRAK_CLIENT_INFO_USB_DEVICES');
    const list = Array.isArray(Client.USBDeviceList) ? Client.USBDeviceList : [];
    const clientKey = Client && Client.UUID ? String(Client.UUID) : '';
    const renderKey = `${clientKey}::${list
      .map(
        (d) =>
          `${d.SerialNumber || ''}|${d.IsCritical ? '1' : '0'}|${d.IsConnected === false ? '0' : '1'}`
      )
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
                } ${HasSerial ? '' : 'is-unavailable'}"
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
            customClass: 'SHOWTRAK_USB_POPOVER',
          });
        }
      } catch (err) {
        HandleNonFatalError('RenderClientInfoDetails:CriticalUSBPopoverInit', err);
      }
    }
  } catch (err) {
    HandleNonFatalError('SelectionInit:NonFatal', err);
  }

  // Displays
  try {
    const $displayList = $('#SHOWTRAK_CLIENT_INFO_DISPLAYS');
    const DisplayMonitoringSupported = IsVersionAtLeast(
      Client && Client.Version,
      MINIMUM_DISPLAY_MONITORING_VERSION
    );
    const displays = Array.isArray(Client.DisplayList) ? Client.DisplayList : [];
    const clientKey = Client && Client.UUID ? String(Client.UUID) : '';
    const renderKey = `${clientKey}::${DisplayMonitoringSupported ? 'supported' : 'unsupported'}::${displays
      .map(
        (d) =>
          `${d.DisplayID || ''}|${d.IsCritical ? '1' : '0'}|${
            d.IsConnected === false ? '0' : '1'
          }|${d.Mismatch ? '1' : '0'}|${d.CurrentSignature || ''}|${d.ExpectedSignature || ''}|${d.ScreenNumber || ''}`
      )
      .join(';;')}`;
    const previousRenderKey = $displayList.attr('data-render-key') || '';

    const FormatDisplayResolution = (d) => {
      const w = parseInt(d && d.Width, 10) || 0;
      const h = parseInt(d && d.Height, 10) || 0;
      if (!w || !h) return null;
      const rate =
        d && d.RefreshRate != null && Number.isFinite(Number(d.RefreshRate))
          ? Math.round(Number(d.RefreshRate))
          : null;
      return rate ? `${w} × ${h} @ ${rate}Hz` : `${w} × ${h}`;
    };

    if (previousRenderKey !== renderKey) {
      if (!DisplayMonitoringSupported) {
        $displayList.html(`
          <div class="rounded-3 p-2 bg-ghost">
            <h6 class="mb-0">Display Monitoring Unavailable</h6>
            <p class="text-sm mb-0">Display monitoring is only available in ShowTrak Client 3.8.0 and above.</p>
          </div>`);
        $displayList.attr('data-render-key', renderKey);
      } else if (displays.length === 0) {
        $displayList.html(`
          <div class="rounded-3 p-2 bg-ghost">
            <h6 class="mb-0">No Displays Detected</h6>
            <p class="text-sm mb-0">This client has not reported any connected displays.</p>
          </div>`);
      } else {
        $displayList.html('');
        for (const disp of displays) {
          const DisplayID = disp.DisplayID;
          const HasID = typeof DisplayID === 'string' && DisplayID.trim().length > 0;
          const DisplayToken = HasID ? encodeURIComponent(DisplayID.trim()) : '';
          const IsCritical = !!disp.IsCritical;
          const IsConnected = disp.IsConnected !== false;
          const IsMismatch = !!disp.Mismatch;
          const ScreenNumber =
            disp.ScreenNumber != null && Number.isFinite(Number(disp.ScreenNumber))
              ? Math.trunc(Number(disp.ScreenNumber))
              : null;
          const ScreenNumberBadge =
            ScreenNumber != null && IsConnected
              ? `<span class="SHOWTRAK_DISPLAY_NUMBER" title="Identify screen number">${ScreenNumber}</span>`
              : '';
          const Label =
            disp.Label && String(disp.Label).trim().length > 0
              ? String(disp.Label).trim()
              : disp.Primary
                ? 'Primary Display'
                : 'Display';
          const CurrentRes = FormatDisplayResolution(disp);
          const ExpectedRes =
            IsMismatch || !IsConnected
              ? FormatDisplayResolution({
                  Width: (disp.ExpectedSignature || '').split('x')[0],
                  Height: ((disp.ExpectedSignature || '').split('x')[1] || '').split('@')[0],
                  RefreshRate: (disp.ExpectedSignature || '').split('@')[1],
                })
              : null;

          let subText;
          if (!IsConnected) {
            subText = ExpectedRes ? `Expected ${Safe(ExpectedRes)}` : 'Disconnected';
          } else if (IsMismatch) {
            subText = `${CurrentRes ? Safe(CurrentRes) : 'Unknown'}${
              ExpectedRes ? ` (expected ${Safe(ExpectedRes)})` : ''
            }`;
          } else {
            subText = CurrentRes ? Safe(CurrentRes) : 'Resolution unavailable';
          }

          const IconClass =
            IsCritical && !IsConnected
              ? 'bi-x-circle-fill'
              : IsCritical && IsMismatch
                ? 'bi-exclamation-triangle-fill'
                : IsCritical
                  ? 'bi-check-circle-fill'
                  : 'bi-check-circle';
          const ButtonLabel =
            IsCritical && !IsConnected
              ? 'Missing'
              : IsCritical && IsMismatch
                ? 'Changed'
                : 'Critical';
          const TitleText = !HasID
            ? 'Unavailable due to missing identifier'
            : IsCritical && !IsConnected
              ? 'Remove critical status (display disconnected)'
              : IsCritical && IsMismatch
                ? 'Display configuration changed — remove critical status'
                : IsCritical
                  ? 'Remove critical status'
                  : 'Mark as critical';

          $displayList.append(`
            <div class="rounded-3 p-2 bg-ghost SHOWTRAK_CLIENT_USB_DEVICE_CARD">
              <div class="d-flex align-items-center gap-2">
                ${ScreenNumberBadge}
                <h6 class="mb-0">${Safe(Label)}${disp.Primary ? ' <small class="text-light">(Primary)</small>' : ''}</h6>
              </div>
              <small class="text-light d-block mb-0 text-start">${subText}</small>
              <button
                type="button"
                class="SHOWTRAK_TOGGLE_CRITICAL_DISPLAY ${IsCritical ? 'is-critical' : ''} ${
                  IsCritical && !IsConnected ? 'is-disconnected-critical' : ''
                } ${IsCritical && IsMismatch ? 'is-mismatch-critical' : ''} ${HasID ? '' : 'is-unavailable'}"
                data-display="${DisplayToken}"
                data-critical="${IsCritical ? '1' : '0'}"
                data-unavailable="${HasID ? '0' : '1'}"
                ${HasID ? `title="${TitleText}"` : ''}
                aria-label="${TitleText}"
              >
                <i class="bi ${IconClass}"></i>
                <span>${ButtonLabel}</span>
              </button>
            </div>
          `);
        }
      }

      $displayList.attr('data-render-key', renderKey);
    }
  } catch (err) {
    HandleNonFatalError('SelectionInit:NonFatal', err);
  }

  // Running applications
  try {
    const $appsList = $('#SHOWTRAK_CLIENT_INFO_RUNNING_APPLICATIONS');
    const apps = Array.isArray(Client?.RunningApplications?.Items)
      ? Client.RunningApplications.Items
      : [];
    const appStatus = Client?.RunningApplications?.Status || {};
    const appStatusState =
      typeof appStatus.State === 'string' && appStatus.State.trim().length > 0
        ? appStatus.State.trim().toLowerCase()
        : 'unknown';
    const appStatusMessage =
      typeof appStatus.Message === 'string' && appStatus.Message.trim().length > 0
        ? appStatus.Message.trim()
        : null;
    const renderKey = `${Client?.UUID || ''}::${apps
      .map(
        (app) =>
          `${app?.Name || ''}|${app?.IsCritical ? '1' : '0'}|${app?.IsRunning === false ? '0' : '1'}`
      )
      .join(';;')}::${appStatusState}|${appStatusMessage || ''}`;

    if (($appsList.attr('data-render-key') || '') !== renderKey) {
      if (apps.length === 0) {
        let filler = '';
        if (appStatusState === 'permission_denied' || appStatusState === 'error') {
          filler += `
            <div class="rounded-3 p-2 bg-danger bg-opacity-25 border border-danger-subtle">
              <h6 class="mb-1">Application Monitoring Warning</h6>
              <p class="text-sm mb-0">${Safe(
                appStatusMessage ||
                  'The client cannot collect running applications because system permission was denied.'
              )}</p>
            </div>`;
        }
        filler += `
          <div class="rounded-3 p-2 bg-ghost">
            <h6 class="mb-0">No applications reported</h6>
            <p class="text-sm mb-0">The client has not sent an application snapshot yet.</p>
          </div>`;
        $appsList.html(filler);
      } else {
        let html = '';
        if (appStatusState === 'permission_denied' || appStatusState === 'error') {
          html += `
            <div class="rounded-3 p-2 bg-danger bg-opacity-25 border border-danger-subtle">
              <h6 class="mb-1">Application Monitoring Warning</h6>
              <p class="text-sm mb-0">${Safe(
                appStatusMessage ||
                  'The client cannot collect running applications because system permission was denied.'
              )}</p>
            </div>`;
        }
        for (const app of apps) {
          const name = app?.Name ? String(app.Name) : 'Unknown Application';
          const IsCritical = !!app?.IsCritical;
          const IsRunning = app?.IsRunning !== false;
          const NameToken = encodeURIComponent(name);
          html += `
            <div class="rounded-3 p-2 bg-ghost SHOWTRAK_CLIENT_USB_DEVICE_CARD">
              <div class="d-flex align-items-center gap-2">
                <h6 class="mb-0">${Safe(name)}</h6>
              </div>
              <button
                type="button"
                class="SHOWTRAK_TOGGLE_CRITICAL_USB SHOWTRAK_TOGGLE_CRITICAL_APP ${IsCritical ? 'is-critical' : ''} ${
                  IsCritical && !IsRunning ? 'is-disconnected-critical' : ''
                }"
                data-name="${NameToken}"
                data-critical="${IsCritical ? '1' : '0'}"
                title="${
                  IsCritical && !IsRunning
                    ? 'Remove critical status (application not running)'
                    : IsCritical
                      ? 'Remove critical status'
                      : 'Mark as critical'
                }"
                aria-label="${
                  IsCritical && !IsRunning
                    ? 'Remove critical status (application not running)'
                    : IsCritical
                      ? 'Remove critical status'
                      : 'Mark as critical'
                }"
              >
                <i class="bi ${IsCritical && !IsRunning ? 'bi-x-circle-fill' : IsCritical ? 'bi-check-circle-fill' : 'bi-check-circle'}"></i>
                <span>${IsCritical && !IsRunning ? 'Not Running' : 'Critical'}</span>
              </button>
            </div>`;
        }
        $appsList.html(html);
      }

      $appsList.attr('data-render-key', renderKey);
    }
  } catch (err) {
    HandleNonFatalError('SelectionInit:NonFatal', err);
  }

  // Network Interfaces
  try {
    const $netList = $('#SHOWTRAK_CLIENT_INFO_NET_INTERFACES');
    const $v4 = $('#SHOWTRAK_CLIENT_INFO_NET_FAMILY_V4');
    const $v6 = $('#SHOWTRAK_CLIENT_INFO_NET_FAMILY_V6');
    const selectedFamily = window.__ClientInfoNetFamily === 'IPv6' ? 'IPv6' : 'IPv4';
    window.__ClientInfoNetFamily = selectedFamily;
    const isV4 = selectedFamily === 'IPv4';
    $v4
      .toggleClass('btn-light', isV4)
      .toggleClass('btn-outline-light', !isV4)
      .attr('aria-pressed', isV4 ? 'true' : 'false');
    $v6
      .toggleClass('btn-light', !isV4)
      .toggleClass('btn-outline-light', isV4)
      .attr('aria-pressed', isV4 ? 'false' : 'true');

    $netList.html('');
    const ifaces = Array.isArray(Client.NetworkInterfaces) ? Client.NetworkInterfaces : [];

    const normalizeFamily = (family) => {
      const value = String(family || '').toUpperCase();
      if (value === '4' || value === 'IPV4') return 'IPv4';
      if (value === '6' || value === 'IPV6') return 'IPv6';
      return value;
    };
    const isAddressActive = (address) => {
      if (!address || typeof address !== 'object') return false;
      if (typeof address.active === 'boolean') return address.active;
      const ip = String(address.address || '').trim();
      if (!ip) return false;
      if (ip === '0.0.0.0' || ip === '::') return false;
      return true;
    };

    if (ifaces.length === 0) {
      $netList.html(
        '<div class="rounded-3 p-2 bg-ghost"><h6 class="mb-0">No Interfaces Reported</h6></div>'
      );
    } else {
      const cards = [];
      for (const iface of ifaces) {
        const nameRaw = iface && iface.name ? String(iface.name) : 'unknown';
        const name = Safe(nameRaw || 'unknown');
        const addresses = Array.isArray(iface.addresses) ? iface.addresses : [];
        const matchingAddresses = addresses.filter(
          (a) => normalizeFamily(a && a.family) === selectedFamily
        );
        if (!matchingAddresses.length) continue;

        for (const address of matchingAddresses) {
          const ip = Safe(address && address.address ? address.address : 'Unknown address');
          const mask = Safe(address && address.netmask ? address.netmask : 'Unknown');
          const mac = Safe(address && address.mac ? String(address.mac).toUpperCase() : 'Unknown');
          const inactiveClass = isAddressActive(address) ? '' : ' is-inactive';
          const kindBadge =
            address && address.internal
              ? '<span class="SHOWTRAK_NET_IFACE_KIND_BADGE">Internal Only</span>'
              : '';
          cards.push(`
            <div class="rounded-3 p-2 bg-ghost SHOWTRAK_NET_IFACE_CARD${inactiveClass}">
              ${kindBadge}
              <div class="SHOWTRAK_NET_IFACE_NAME">${name}</div>
              <div class="SHOWTRAK_NET_IFACE_IP mt-1">${ip}</div>
              <div class="SHOWTRAK_NET_IFACE_META mt-1">${mask}</div>
              <div class="SHOWTRAK_NET_IFACE_META">${mac}</div>
            </div>`);
        }
      }

      if (!cards.length) {
        $netList.html(
          `<div class="rounded-3 p-2 bg-ghost"><h6 class="mb-0">No ${selectedFamily} Interfaces Detected</h6></div>`
        );
      } else {
        $netList.html(cards.join(''));
      }
    }
  } catch (err) {
    HandleNonFatalError('SelectionInit:NonFatal', err);
  }
}
