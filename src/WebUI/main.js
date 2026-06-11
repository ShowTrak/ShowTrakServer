/* ShowTrak Web UI
 * Real-time, permission-aware mobile/desktop client viewer.
 * Talks to the server '/ui' Socket.IO namespace.
 */
/* global io */
(function () {
  'use strict';

  const TOKEN_KEY = 'showtrak_token';

  // ---- Connection ---------------------------------------------------------
  const socket = io('/ui', {
    transports: ['websocket', 'polling'],
    auth: (cb) => cb({ token: sessionStorage.getItem(TOKEN_KEY) || undefined }),
    reconnection: true,
    reconnectionDelay: 800,
    reconnectionDelayMax: 4000,
    timeout: 6000,
  });

  // ---- State --------------------------------------------------------------
  let clients = [];
  let groups = [];
  let monitors = [];
  let scripts = [];
  let config = {
    Enabled: true,
    PasswordProtection: false,
    AllowRemoteScripts: false,
    WOLEnabled: false,
    Authed: false,
  };
  let detailUUID = null;
  let netFamily = 'IPv4';
  let pin = '';
  let everConnected = false;

  // ---- Element refs -------------------------------------------------------
  const $ = (id) => document.getElementById(id);
  const el = {
    main: $('appMain'),
    content: $('APPLICATION_CONTENT'),
    empty: $('emptyState'),
    loading: $('loadingOverlay'),
    login: $('loginOverlay'),
    authControls: $('authControls'),
    loginSubtitle: $('loginSubtitle'),
    disabledNotice: $('disabledNotice'),
    pinDisplay: $('pinDisplay'),
    pinError: $('pinError'),
    logoutBtn: $('logoutBtn'),
    viewToggleBtn: $('viewToggleBtn'),
    viewToggleIcon: $('viewToggleIcon'),
    viewToggleLabel: $('viewToggleLabel'),
    connDot: $('connDot'),
    connBanner: $('connBanner'),
    connBannerText: $('connBannerText'),
    sheetBackdrop: $('sheetBackdrop'),
    detailSheet: $('detailSheet'),
    detailName: $('detailName'),
    detailStatus: $('detailStatus'),
    detailVitals: $('detailVitals'),
    cpuBar: $('cpuBar'),
    ramBar: $('ramBar'),
    cpuPct: $('cpuPct'),
    ramPct: $('ramPct'),
    detailInfo: $('detailInfo'),
    usbSection: $('usbSection'),
    usbList: $('usbList'),
    netSection: $('netSection'),
    netFamilyV4Btn: $('netFamilyV4Btn'),
    netFamilyV6Btn: $('netFamilyV6Btn'),
    netList: $('netList'),
    appsSection: $('appsSection'),
    appsList: $('appsList'),
    runScriptBtn: $('runScriptBtn'),
    wolBtn: $('wolBtn'),
    detailClose: $('detailClose'),
    scriptsSheet: $('scriptsSheet'),
    scriptsList: $('scriptsList'),
    scriptsSubtitle: $('scriptsSubtitle'),
    scriptsClose: $('scriptsClose'),
    confirmModal: $('confirmModal'),
    confirmText: $('confirmText'),
    confirmOk: $('confirmOk'),
    confirmCancel: $('confirmCancel'),
    toastHost: $('toastHost'),
  };

  // ---- Utilities ----------------------------------------------------------
  function safe(input) {
    if (input === null || input === undefined) return '';
    return String(input)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function clampPct(v) {
    const n = Number(v);
    if (!isFinite(n)) return 0;
    return Math.max(0, Math.min(100, n));
  }

  function FormatInterval(ms) {
    const n = Number(ms) || 0;
    if (n < 60000) return `${Math.round(n / 1000)}s`;
    const m = Math.floor(n / 60000);
    const s = Math.round((n % 60000) / 1000);
    return s ? `${m}m ${s}s` : `${m}m`;
  }

  function FormatLatency(ms) {
    if (ms == null) return '';
    if (ms < 1) return '<1ms';
    return `${Math.round(ms)}ms`;
  }

  function FormatMonitorStatus(Online, LastLatencyMs, LastError) {
    if (Online) return FormatLatency(LastLatencyMs) || 'Online';
    const ErrorText = typeof LastError === 'string' ? LastError.trim() : '';
    if (!ErrorText) return 'Offline';
    if (
      /timed?\s*out|timeout|unreachable|refused|reset|network\s+is\s+unreachable|no\s+route\s+to\s+host|socket\s+hang\s+up|econnrefused|econnreset|ehostunreach|enetunreach/i.test(
        ErrorText
      )
    ) {
      return 'Offline';
    }
    if (/enotfound|eai_again|nxdomain|dns|name\s+or\s+service\s+not\s+known/i.test(ErrorText)) {
      return 'DNS Error';
    }
    if (/cert|certificate|tls|ssl|self\s*signed|unable\s+to\s+verify/i.test(ErrorText)) {
      return 'TLS Error';
    }
    const HttpMatch = ErrorText.match(/\bHTTP\s+(\d{3})\b/i);
    if (HttpMatch) return `HTTP ${HttpMatch[1]}`;
    return ErrorText;
  }

  function timeAgo(ts) {
    const diff = Math.max(0, Date.now() - Number(ts));
    const s = Math.floor(diff / 1000);
    if (s < 5) return 'just now';
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.floor(h / 24);
    return `${d}d ago`;
  }

  function getCpu(c) {
    return c && c.Vitals && c.Vitals.CPU ? c.Vitals.CPU.UsagePercentage : 0;
  }
  function getRam(c) {
    return c && c.Vitals && c.Vitals.Ram ? c.Vitals.Ram.UsagePercentage : 0;
  }

  function normalizeFamily(family) {
    const value = String(family || '').toUpperCase();
    if (value === '4' || value === 'IPV4') return 'IPv4';
    if (value === '6' || value === 'IPV6') return 'IPv6';
    return value;
  }

  function inferAddressActive(address) {
    if (!address || typeof address !== 'object') return false;
    if (typeof address.active === 'boolean') return address.active;
    const ip = String(address.address || '').trim();
    if (!ip) return false;
    if (ip === '0.0.0.0' || ip === '::') return false;
    return true;
  }

  function paintNetworkInterfaces(client) {
    const isIPv4 = netFamily === 'IPv4';
    el.netFamilyV4Btn.classList.toggle('btn-light', isIPv4);
    el.netFamilyV4Btn.classList.toggle('btn-outline-light', !isIPv4);
    el.netFamilyV4Btn.setAttribute('aria-pressed', String(isIPv4));
    el.netFamilyV6Btn.classList.toggle('btn-light', !isIPv4);
    el.netFamilyV6Btn.classList.toggle('btn-outline-light', isIPv4);
    el.netFamilyV6Btn.setAttribute('aria-pressed', String(!isIPv4));

    const nets = Array.isArray(client && client.NetworkInterfaces) ? client.NetworkInterfaces : [];
    const cards = [];

    for (const iface of nets) {
      const ifaceName = iface && iface.name ? iface.name : 'Interface';
      const addresses = Array.isArray(iface && iface.addresses) ? iface.addresses : [];
      const matching = addresses.filter((a) => normalizeFamily(a && a.family) === netFamily);

      for (const addr of matching) {
        const ip = addr && addr.address ? addr.address : 'Unknown address';
        const mask = addr && addr.netmask ? addr.netmask : 'Unknown';
        const mac = addr && addr.mac ? addr.mac : 'Unknown';
        const isInternal = !!(addr && addr.internal);
        const isActive = inferAddressActive(addr);
        cards.push(
          `<article class="net-iface-card${isActive ? '' : ' inactive'}">`
            + `${isInternal ? '<span class="net-iface-badge">Internal Only</span>' : ''}`
            + `<div class="net-iface-name">${safe(ifaceName)}</div>`
            + `<div class="net-iface-ip">${safe(ip)}</div>`
            + `<div class="net-iface-meta"><div>${safe(mask)}</div><div>${safe(mac)}</div></div>`
          + '</article>'
        );
      }
    }

    if (cards.length) {
      el.netList.innerHTML = cards.join('');
      return;
    }

    if (nets.length) {
      el.netList.innerHTML = `<div class="net-empty-card">No ${safe(netFamily)} network interfaces detected for this client.</div>`;
      return;
    }

    el.netList.innerHTML = '<div class="net-empty-card">No network interfaces reported.</div>';
  }

  function setNetFamily(family) {
    const normalized = normalizeFamily(family);
    if (normalized !== 'IPv4' && normalized !== 'IPv6') return;
    if (netFamily === normalized) return;
    netFamily = normalized;
    if (detailUUID) paintDetail();
  }

  // ---- Toasts -------------------------------------------------------------
  function toast(message, type) {
    const node = document.createElement('div');
    node.className = `toast ${type || 'info'}`;
    node.textContent = message;
    el.toastHost.appendChild(node);
    setTimeout(() => {
      node.style.transition = 'opacity 200ms ease';
      node.style.opacity = '0';
      setTimeout(() => node.remove(), 220);
    }, 3200);
  }

  // ---- Confirmation -------------------------------------------------------
  let confirmHandler = null;
  function openConfirm(message, onOk) {
    el.confirmText.textContent = message || 'Are you sure?';
    confirmHandler = onOk;
    el.confirmModal.classList.remove('hidden');
  }
  function closeConfirm() {
    el.confirmModal.classList.add('hidden');
    confirmHandler = null;
  }
  el.confirmOk.addEventListener('click', () => {
    const h = confirmHandler;
    closeConfirm();
    if (h) h();
  });
  el.confirmCancel.addEventListener('click', closeConfirm);

  el.netFamilyV4Btn.addEventListener('click', () => setNetFamily('IPv4'));
  el.netFamilyV6Btn.addEventListener('click', () => setNetFamily('IPv6'));

  // ---- Connection status --------------------------------------------------
  function setConn(state) {
    el.connDot.classList.remove('online', 'offline', 'connecting');
    el.connDot.classList.add(state);
    if (state === 'online') {
      el.connDot.title = 'Connected';
      el.connBanner.classList.add('hidden');
    } else if (state === 'connecting') {
      el.connDot.title = 'Connecting…';
      if (everConnected) {
        el.connBannerText.textContent = 'Reconnecting to ShowTrak Server…';
        el.connBanner.classList.remove('hidden');
      }
    } else {
      el.connDot.title = 'Disconnected';
      el.connBannerText.textContent = 'Lost connection to ShowTrak Server…';
      el.connBanner.classList.remove('hidden');
    }
  }

  // ---- Auth / view gating -------------------------------------------------
  function applyAuthView() {
    const disabled = config.Enabled === false;
    const needsLogin = config.PasswordProtection && !config.Authed;
    if (disabled) {
      el.login.classList.remove('hidden');
      el.main.classList.add('hidden');
      el.loading.classList.add('hidden');
      el.logoutBtn.classList.add('hidden');
      el.loginSubtitle.textContent = 'Access is disabled in ShowTrak settings';
      el.disabledNotice.classList.remove('hidden');
      el.authControls.classList.add('hidden');
      el.pinError.classList.add('hidden');
    } else if (needsLogin) {
      el.loginSubtitle.textContent = 'Enter the access passcode';
      el.disabledNotice.classList.add('hidden');
      el.authControls.classList.remove('hidden');
      el.login.classList.remove('hidden');
      el.main.classList.add('hidden');
      el.loading.classList.add('hidden');
      el.logoutBtn.classList.add('hidden');
    } else {
      el.loginSubtitle.textContent = 'Enter the access passcode';
      el.disabledNotice.classList.add('hidden');
      el.authControls.classList.remove('hidden');
      el.login.classList.add('hidden');
      el.main.classList.remove('hidden');
      el.loading.classList.add('hidden');
      el.logoutBtn.classList.toggle('hidden', !config.PasswordProtection);
    }
  }

  // ---- Passcode keypad ----------------------------------------------------
  function renderPin() {
    const dots = el.pinDisplay.querySelectorAll('.pin-dot');
    dots.forEach((d, i) => d.classList.toggle('filled', i < pin.length));
  }
  function pinError() {
    el.pinError.classList.remove('hidden');
    el.pinDisplay.classList.add('shake');
    setTimeout(() => el.pinDisplay.classList.remove('shake'), 420);
  }
  function submitPin() {
    if (config.Enabled === false) return;
    socket.emit('auth:login', { password: pin }, (res) => {
      if (res && res.ok) {
        if (res.token) {
          sessionStorage.setItem(TOKEN_KEY, res.token);
        }
        config.Authed = true;
        pin = '';
        renderPin();
        el.pinError.classList.add('hidden');
        applyAuthView();
      } else {
        pin = '';
        renderPin();
        pinError();
      }
    });
  }
  function pushPin(digit) {
    if (pin.length >= 4) return;
    el.pinError.classList.add('hidden');
    pin += digit;
    renderPin();
    if (pin.length === 4) setTimeout(submitPin, 120);
  }
  el.login.querySelectorAll('.keypad-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = btn.getAttribute('data-key');
      if (key === 'back') {
        pin = pin.slice(0, -1);
        renderPin();
      } else if (key === 'clear') {
        pin = '';
        renderPin();
      } else {
        pushPin(key);
      }
    });
  });
  document.addEventListener('keydown', (e) => {
    if (el.login.classList.contains('hidden')) return;
    if (e.key >= '0' && e.key <= '9') pushPin(e.key);
    else if (e.key === 'Backspace') {
      pin = pin.slice(0, -1);
      renderPin();
    } else if (e.key === 'Enter' && pin.length > 0) submitPin();
  });

  // ---- Logout -------------------------------------------------------------
  el.logoutBtn.addEventListener('click', () => {
    socket.emit('auth:logout', () => {});
    sessionStorage.removeItem(TOKEN_KEY);
    location.reload();
  });

  // ---- Compact / expanded view (local-only, default compact) --------------
  function applyViewToggle() {
    const compact = document.body.classList.contains('compact');
    el.viewToggleIcon.className = compact
      ? 'bi bi-arrows-angle-expand'
      : 'bi bi-arrows-angle-contract';
    el.viewToggleLabel.textContent = compact ? 'Expand' : 'Compact';
    el.viewToggleBtn.title = compact ? 'Switch to expanded view' : 'Switch to compact view';
  }
  el.viewToggleBtn.addEventListener('click', () => {
    document.body.classList.toggle('compact');
    applyViewToggle();
  });
  applyViewToggle();

  // ---- Rendering: tiles ---------------------------------------------------
  function clientTileHTML(c) {
    const { Nickname, Hostname, IP, UUID, Version, Online } = c;
    const hasNick = Nickname && Nickname.length;
    const primaryName = hasNick ? Nickname : Hostname || UUID || 'Unnamed Client';
    const hostVersion = hasNick
      ? `${Hostname || UUID || 'Unnamed Client'} - v${Version || ''}`
      : `v${Version || ''}`;
    return `<div id="CLIENT_TILE_${safe(UUID)}" class="SHOWTRAK_PC ${
      Online ? 'ONLINE' : ''
    }" data-uuid="${safe(UUID)}" data-kind="client">
      <label class="text-sm" data-type="Hostname">${safe(hostVersion)}</label>
      <h5 class="mb-0" data-type="Nickname">${safe(primaryName)}</h5>
      <span class="CLIENT_TILE_COMPACT_STATUS${Online ? '' : ' d-none'}" data-type="COMPACT_ONLINE_STATUS">Online</span>
      <small class="text-sm text-light" data-type="IP">${IP ? safe(IP) : 'Unknown IP'}</small>
      <div class="SHOWTRAK_PC_STATUS ${
        Online ? 'd-grid' : 'd-none'
      } gap-2" data-type="INDICATOR_ONLINE">
        <div class="progress"><div data-type="CPU" class="progress-bar bg-white" role="progressbar" style="width:0%"></div></div>
        <div class="progress"><div data-type="RAM" class="progress-bar bg-white" role="progressbar" style="width:0%"></div></div>
      </div>
      <div class="SHOWTRAK_PC_STATUS ${Online ? 'd-none' : 'd-grid'}" data-type="INDICATOR_OFFLINE">
        <h7 class="mb-0" data-type="OFFLINE_SINCE" data-offlinesince="${safe(
          c.LastSeen
        )}">OFFLINE <span class="badge bg-ghost">00:00:00</span></h7>
      </div>
    </div>`;
  }

  function monitorTileHTML(T) {
    const Online = !!T.Online;
    const Degraded = !!T.Degraded;
    const Name = T.Nickname || T.Address || 'Unnamed';
    const Sub = T.Address || '';
    const Status = FormatMonitorStatus(Online, T.LastLatencyMs, T.LastError);
    const Method = String(T.Method || '').toUpperCase();
    const TileStateClass = Degraded ? 'DEGRADED' : Online ? 'ONLINE' : '';
    const TextClass = 'text-light';
    return `<div id="MONITOR_TILE_${safe(T.TargetID)}" class="SHOWTRAK_PC MONITOR ${TileStateClass}" data-target-id="${safe(
      T.TargetID
    )}" data-kind="monitor">
      <label class="text-sm" data-type="Method">${safe(Method)} · ${safe(
        FormatInterval(T.Interval)
      )}</label>
      <h5 class="mb-0" data-type="Name">${safe(Name)}</h5>
      <small class="text-sm text-light" data-type="Address">${safe(Sub)}</small>
      <div class="SHOWTRAK_PC_STATUS d-grid" data-type="MONITOR_STATUS">
        <h7 class="mb-0 ${TextClass}" data-type="MONITOR_STATUS_LABEL">${safe(Status)}</h7>
      </div>
    </div>`;
  }

  function renderAll() {
    const groupList = groups.slice();
    groupList.push({ GroupID: null, Title: 'No Group', Weight: 100000 });
    groupList.sort((a, b) => (a.Weight || 0) - (b.Weight || 0));

    let html = '';
    let tileCount = 0;

    for (const g of groupList) {
      const GroupID = g.GroupID;
      const groupClients = clients
        .filter((c) => c.GroupID === GroupID)
        .map((c) => ({ kind: 'client', weight: c.Weight || 0, data: c }));
      const groupMonitors = monitors
        .filter((m) => (m.GroupID || null) === GroupID)
        .map((m) => ({ kind: 'monitor', weight: m.Weight || 0, data: m }));

      const merged = groupClients.concat(groupMonitors).sort((a, b) => a.weight - b.weight);

      // Hide an empty "No Group" bucket, exactly like the desktop app.
      if (merged.length === 0 && GroupID == null) continue;

      let tiles = '';
      if (merged.length === 0) {
        tiles = `<div class="SHOWTRAK_PC_PLACEHOLDER">
          <h5 class="text-muted mb-0">Empty Group</h5>
          <p class="text-muted mb-0">This group has no clients assigned to it.</p>
        </div>`;
      } else {
        for (const item of merged) {
          tileCount++;
          tiles += item.kind === 'client' ? clientTileHTML(item.data) : monitorTileHTML(item.data);
        }
      }

      html += `<div class="GROUP_ROW">
        <div class="GROUP_TITLE_CLICKABLE m-3 me-0 mb-0 rounded">
          <div class="d-flex align-items-center text-center h-100">
            <span class="GROUP_TITLE py-2">${safe(g.Title)}</span>
          </div>
        </div>
        <div class="GROUP_CLIENTS bg-ghost rounded m-3 mb-0 d-flex flex-wrap justify-content-start align-items-center p-3 gap-3 w-100">
          ${tiles}
        </div>
      </div>`;
    }

    el.content.innerHTML = html;
    el.empty.classList.toggle('hidden', tileCount > 0);

    // Paint vitals for all currently online clients.
    for (const c of clients) {
      if (c.Online) applyClientVitals(c);
    }
  }

  function applyClientVitals(c) {
    const tile = document.getElementById(`CLIENT_TILE_${c.UUID}`);
    if (!tile) return;
    const cpu = tile.querySelector('[data-type="CPU"]');
    const ram = tile.querySelector('[data-type="RAM"]');
    if (cpu) cpu.style.width = clampPct(getCpu(c)) + '%';
    if (ram) ram.style.width = clampPct(getRam(c)) + '%';
  }

  // In-place update of a single client tile (real-time, no full re-render).
  function updateClientTile(c) {
    const tile = document.getElementById(`CLIENT_TILE_${c.UUID}`);
    if (!tile) return false;

    tile.classList.toggle('ONLINE', !!c.Online);

    const hasNick = c.Nickname && c.Nickname.length;
    const nick = tile.querySelector('[data-type="Nickname"]');
    if (nick) nick.textContent = hasNick ? c.Nickname : c.Hostname || c.UUID;
    const host = tile.querySelector('[data-type="Hostname"]');
    if (host)
      host.textContent = hasNick
        ? `${c.Hostname || ''} - v${c.Version || ''}`
        : `v${c.Version || ''}`;
    const ip = tile.querySelector('[data-type="IP"]');
    if (ip) ip.textContent = c.IP ? c.IP : 'Unknown IP';

    const compactStatus = tile.querySelector('[data-type="COMPACT_ONLINE_STATUS"]');
    if (compactStatus) compactStatus.classList.toggle('d-none', !c.Online);

    const onlineInd = tile.querySelector('[data-type="INDICATOR_ONLINE"]');
    const offlineInd = tile.querySelector('[data-type="INDICATOR_OFFLINE"]');
    if (c.Online) {
      if (onlineInd) {
        onlineInd.classList.add('d-grid');
        onlineInd.classList.remove('d-none');
      }
      if (offlineInd) {
        offlineInd.classList.add('d-none');
        offlineInd.classList.remove('d-grid');
      }
      applyClientVitals(c);
    } else {
      if (onlineInd) {
        onlineInd.classList.add('d-none');
        onlineInd.classList.remove('d-grid');
      }
      if (offlineInd) {
        offlineInd.classList.add('d-grid');
        offlineInd.classList.remove('d-none');
      }
    }
    const since = tile.querySelector('[data-type="OFFLINE_SINCE"]');
    if (since && c.LastSeen) since.setAttribute('data-offlinesince', c.LastSeen);
    return true;
  }

  function updateMonitorTile(T) {
    const tile = document.getElementById(`MONITOR_TILE_${T.TargetID}`);
    if (!tile) return false;
    const Online = !!T.Online;
    const Degraded = !!T.Degraded;
    tile.classList.toggle('ONLINE', Online && !Degraded);
    tile.classList.toggle('DEGRADED', Degraded);
    const nameEl = tile.querySelector('[data-type="Name"]');
    if (nameEl) nameEl.textContent = T.Nickname || T.Address || 'Unnamed';
    const addrEl = tile.querySelector('[data-type="Address"]');
    if (addrEl) addrEl.textContent = T.Address || '';
    const methodEl = tile.querySelector('[data-type="Method"]');
    if (methodEl)
      methodEl.textContent = `${String(T.Method || '').toUpperCase()} · ${FormatInterval(T.Interval)}`;
    const label = tile.querySelector('[data-type="MONITOR_STATUS_LABEL"]');
    if (label) {
      const Status = FormatMonitorStatus(Online, T.LastLatencyMs, T.LastError);
      label.textContent = Status;
      label.classList.remove('text-success', 'text-warning');
      label.classList.add('text-light');
    }
    return true;
  }

  // ---- Offline timers -----------------------------------------------------
  setInterval(() => {
    const now = Date.now();
    document.querySelectorAll('[data-type="OFFLINE_SINCE"]').forEach((node) => {
      const ls = node.getAttribute('data-offlinesince');
      if (!ls) return;
      const dur = now - parseInt(ls, 10);
      if (!isFinite(dur) || dur < 0) return;
      const h = Math.floor(dur / 3600000);
      const m = Math.floor((dur % 3600000) / 60000);
      const s = Math.floor((dur % 60000) / 1000);
      const pad = (n) => String(n).padStart(2, '0');
      node.innerHTML = `OFFLINE <span class="badge bg-ghost">${pad(h)}:${pad(m)}:${pad(s)}</span>`;
    });
  }, 1000);

  // ---- Detail sheet -------------------------------------------------------
  function openDetail(uuid) {
    detailUUID = uuid;
    paintDetail();
    el.sheetBackdrop.classList.remove('hidden');
    el.detailSheet.classList.remove('hidden');
    // Pull fresh full info (USB / network interfaces).
    socket.emit('client:get', uuid, (res) => {
      if (res && res.data) {
        upsertClient(res.data);
        if (detailUUID === uuid) paintDetail();
      }
    });
  }
  function closeDetail() {
    detailUUID = null;
    el.detailSheet.classList.add('hidden');
    el.sheetBackdrop.classList.add('hidden');
  }
  el.detailClose.addEventListener('click', closeDetail);
  el.sheetBackdrop.addEventListener('click', () => {
    closeDetail();
    closeScripts();
  });

  function FormatBytes(bytes) {
    const n = Number(bytes);
    if (!isFinite(n) || n <= 0) return null;
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    let val = n;
    while (val >= 1024 && i < units.length - 1) {
      val /= 1024;
      i++;
    }
    return `${val < 10 ? val.toFixed(1) : Math.round(val)} ${units[i]}`;
  }

  function paintDetail() {
    const c = clients.find((x) => x.UUID === detailUUID);
    if (!c) return;
    el.detailName.textContent = c.Nickname || c.Hostname || c.UUID;
    const statusText = c.Online ? (c.Degraded ? 'Degraded' : 'Online') : `Offline · ${timeAgo(c.LastSeen)}`;
    el.detailStatus.textContent = statusText;
    el.detailStatus.classList.toggle('online', !!c.Online && !c.Degraded);
    el.detailStatus.classList.toggle('degraded', !!c.Online && !!c.Degraded);
    el.detailStatus.classList.toggle('offline', !c.Online);

    // Vitals
    if (c.Online) {
      el.detailVitals.classList.remove('hidden');
      const cpu = clampPct(getCpu(c));
      const ram = clampPct(getRam(c));
      el.cpuBar.style.width = cpu + '%';
      el.ramBar.style.width = ram + '%';
      el.cpuPct.textContent = Math.round(cpu) + '%';
      // RAM label: used/total (pct%) when byte counts are available
      const ramUsed = c.Vitals && c.Vitals.Ram && c.Vitals.Ram.Used != null ? c.Vitals.Ram.Used : null;
      const ramTotal = c.Vitals && c.Vitals.Ram && c.Vitals.Ram.Total != null ? c.Vitals.Ram.Total : null;
      if (ramUsed != null && ramTotal != null) {
        const usedStr = FormatBytes(ramUsed);
        const totalStr = FormatBytes(ramTotal);
        el.ramPct.textContent = (usedStr && totalStr)
          ? `${usedStr} / ${totalStr} (${Math.round(ram)}%)`
          : `${Math.round(ram)}%`;
      } else {
        el.ramPct.textContent = Math.round(ram) + '%';
      }
    } else {
      el.detailVitals.classList.add('hidden');
    }

    // Info grid — mirrors the desktop modal fields
    const group = groups.find((g) => g.GroupID === c.GroupID);
    const fields = [
      c.Nickname && c.Nickname.length ? ['Nickname', c.Nickname] : null,
      ['Hostname', c.Hostname || '—'],
      c.OperatingSystem ? ['OS', c.OperatingSystem] : null,
      ['Status', c.Online ? (c.Degraded ? 'Degraded' : 'Online') : 'Offline'],
      ['IP', c.IP || '—'],
      c.MacAddress ? ['MAC', c.MacAddress] : null,
      ['Version', c.Version || '—'],
      ['Group', group ? group.Title : 'No Group'],
      ['Last Seen', c.LastSeen ? timeAgo(c.LastSeen) : '—'],
      ['UUID', c.UUID],
    ].filter(Boolean);
    el.detailInfo.innerHTML = fields
      .map(
        ([k, v]) =>
          `<div class="kv"><div class="k">${safe(k)}</div><div class="v">${safe(v)}</div></div>`
      )
      .join('');

    // USB devices — card layout matching desktop modal (read-only, no critical toggle)
    const usb = Array.isArray(c.USBDeviceList) ? c.USBDeviceList : [];
    if (usb.length === 0) {
      el.usbList.innerHTML = '<div class="device-card-empty">No USB devices reported.</div>';
    } else {
      el.usbList.innerHTML = usb.map((d) => {
        const name = (`${d.ManufacturerName || ''} ${d.ProductName || ''}`).trim() || 'USB Device';
        const serial = d.SerialNumber && String(d.SerialNumber).trim()
          ? String(d.SerialNumber).trim() : null;
        const isCritical = !!d.IsCritical;
        const isConnected = d.IsConnected !== false;
        let badges = '';
        if (isCritical && !isConnected) {
          badges = '<div class="device-card-badges"><span class="device-badge badge-critical-missing"><i class="bi bi-x-circle-fill"></i> Disconnected Critical</span></div>';
        } else if (isCritical) {
          badges = '<div class="device-card-badges"><span class="device-badge badge-critical"><i class="bi bi-check-circle-fill"></i> Critical</span></div>';
        }
        return `<div class="device-card">
          <div class="device-card-name">${safe(name)}</div>
          <div class="device-card-sub">${serial ? safe(serial) : 'Serial unavailable'}</div>
          ${badges}
        </div>`;
      }).join('');
    }

    // Network interfaces
    paintNetworkInterfaces(c);

    // Running applications — card layout matching desktop modal (read-only, no critical toggle)
    const apps = Array.isArray(c.RunningApplications && c.RunningApplications.Items)
      ? c.RunningApplications.Items : [];
    const appStatus = (c.RunningApplications && c.RunningApplications.Status) || {};
    const appStatusState = typeof appStatus.State === 'string' ? appStatus.State.trim().toLowerCase() : 'unknown';
    const appStatusMsg = typeof appStatus.Message === 'string' && appStatus.Message.trim()
      ? appStatus.Message.trim() : null;

    let appsHtml = '';
    if (appStatusState === 'permission_denied' || appStatusState === 'error') {
      appsHtml += `<div class="device-card" style="border:1px solid rgba(220,53,69,0.3);background:rgba(220,53,69,0.08);">
        <div class="device-card-name">Application Monitoring Warning</div>
        <div class="device-card-sub">${safe(appStatusMsg || 'The client cannot collect running applications because system permission was denied.')}</div>
      </div>`;
    }
    if (apps.length === 0) {
      appsHtml += '<div class="device-card-empty">No applications reported.</div>';
    } else {
      appsHtml += apps.map((app) => {
        const name = app && app.Name ? String(app.Name) : 'Unknown Application';
        const isCritical = !!app.IsCritical;
        const isRunning = app.IsRunning !== false;
        let badges = '';
        if (isCritical && !isRunning) {
          badges = '<div class="device-card-badges"><span class="device-badge badge-critical-missing"><i class="bi bi-x-circle-fill"></i> Not Running</span></div>';
        } else if (isCritical) {
          badges = '<div class="device-card-badges"><span class="device-badge badge-critical"><i class="bi bi-check-circle-fill"></i> Critical</span></div>';
        }
        return `<div class="device-card">
          <div class="device-card-name">${safe(name)}</div>
          ${badges}
        </div>`;
      }).join('');
    }
    el.appsList.innerHTML = appsHtml;

    // Permission-gated actions
    const canScript = config.AllowRemoteScripts && scripts.length > 0;
    const canWol = config.AllowRemoteScripts && config.WOLEnabled && !!c.MacAddress;
    el.runScriptBtn.classList.toggle('hidden', !canScript);
    el.wolBtn.classList.toggle('hidden', !canWol);
  }

  el.runScriptBtn.addEventListener('click', openScripts);
  el.wolBtn.addEventListener('click', () => {
    if (!detailUUID) return;
    socket.emit('wol:wake', { uuid: detailUUID }, (res) => {
      if (res && res.ok) toast('Wake on LAN packet sent', 'success');
      else if (res && res.error === 'forbidden') toast('Remote actions are disabled', 'error');
      else toast('Failed to send Wake on LAN', 'error');
    });
  });

  // ---- Scripts sheet ------------------------------------------------------
  function openScripts() {
    if (!detailUUID) return;
    if (!config.AllowRemoteScripts) {
      toast('Remote script execution is disabled', 'error');
      return;
    }
    const c = clients.find((x) => x.UUID === detailUUID);
    el.scriptsSubtitle.textContent = c ? c.Nickname || c.Hostname || '' : '';
    renderScripts();
    el.sheetBackdrop.classList.remove('hidden');
    el.scriptsSheet.classList.remove('hidden');
  }
  function closeScripts() {
    el.scriptsSheet.classList.add('hidden');
    if (el.detailSheet.classList.contains('hidden')) {
      el.sheetBackdrop.classList.add('hidden');
    }
  }
  el.scriptsClose.addEventListener('click', closeScripts);

  function renderScripts() {
    const list = scripts.slice().sort((a, b) => (a.weight || 0) - (b.weight || 0));
    if (!list.length) {
      el.scriptsList.innerHTML = '<div class="scripts-empty">No scripts available.</div>';
      return;
    }
    const COLOURS = [
      '#e74c3c','#e67e22','#f1c40f','#2ecc71',
      '#3498db','#9b59b6','#bdc3c7','#7f8c8d',
    ];
    el.scriptsList.innerHTML = '';
    for (const s of list) {
      const hex = COLOURS[s.colour] || COLOURS[6];
      const btn = document.createElement('button');
      btn.className = 'script-btn';
      btn.type = 'button';
      btn.style.setProperty('--script-accent', hex);
      btn.innerHTML = `<span class="script-accent-strip"></span><span class="script-name">${safe(s.name)}</span><span class="script-go"><i class="bi bi-play-fill"></i> Run</span>`;
      btn.addEventListener('click', () => {
        if (s.confirm) {
          openConfirm(`Run "${s.name}" on this client?`, () => runScript(s));
        } else {
          runScript(s);
        }
      });
      el.scriptsList.appendChild(btn);
    }
  }

  function runScript(s) {
    if (!detailUUID) return;
    // Close scripts sheet immediately — return to client detail view first
    closeScripts();
    socket.emit('scripts:run', { uuid: detailUUID, scriptId: s.id }, (res) => {
      if (res && res.ok) {
        toast(`"${s.name}" dispatched successfully`, 'success');
      } else if (res && res.error === 'forbidden') {
        toast('Remote script execution is disabled', 'error');
      } else if (res && typeof res.message === 'string' && res.message.trim()) {
        toast(res.message, 'error');
      } else {
        toast('Failed to run script', 'error');
      }
    });
  }

  // ---- Tile click delegation ---------------------------------------------
  el.content.addEventListener('click', (e) => {
    const tile = e.target.closest('.SHOWTRAK_PC[data-kind="client"]');
    if (tile) openDetail(tile.getAttribute('data-uuid'));
  });

  // ---- Cache helpers ------------------------------------------------------
  function upsertClient(updated) {
    const idx = clients.findIndex((x) => x.UUID === updated.UUID);
    if (idx === -1) clients.push(updated);
    else clients[idx] = Object.assign({}, clients[idx], updated);
  }

  // ---- Socket events ------------------------------------------------------
  socket.on('connect', () => {
    everConnected = true;
    setConn('online');
  });

  socket.io.on('reconnect_attempt', () => setConn('connecting'));
  socket.io.on('reconnect', () => setConn('online'));
  socket.on('disconnect', () => setConn('offline'));
  socket.on('connect_error', () => setConn(everConnected ? 'offline' : 'connecting'));

  window.addEventListener('offline', () => setConn('offline'));
  window.addEventListener('online', () => {
    if (!socket.connected) setConn('connecting');
  });

  // Server announces auth requirements + current permissions.
  socket.on('hello', (cfg) => {
    if (cfg) config = Object.assign(config, cfg);
    applyAuthView();
  });

  // Live permission/config changes (settings updated on the server).
  socket.on('config', (cfg) => {
    if (!cfg) return;
    config = Object.assign(config, cfg);
    applyAuthView();
    if (detailUUID) paintDetail();
  });

  // Full snapshot for an authenticated session.
  socket.on('bootstrap', (data) => {
    if (!data) return;
    clients = Array.isArray(data.clients) ? data.clients : [];
    groups = Array.isArray(data.groups) ? data.groups : [];
    monitors = Array.isArray(data.monitors) ? data.monitors : [];
    scripts = Array.isArray(data.scripts) ? data.scripts : [];
    if (data.config) config = Object.assign(config, data.config);
    applyAuthView();
    renderAll();
    if (detailUUID) paintDetail();
  });

  socket.on('clients:list', (list) => {
    clients = Array.isArray(list) ? list : [];
    renderAll();
    if (detailUUID) paintDetail();
  });

  socket.on('clients:updated', (client) => {
    if (!client) return;
    const prev = clients.find((x) => x.UUID === client.UUID);
    const groupChanged = !prev || prev.GroupID !== client.GroupID;
    upsertClient(client);
    if (groupChanged || !updateClientTile(clients.find((x) => x.UUID === client.UUID))) {
      renderAll();
    }
    if (detailUUID === client.UUID) paintDetail();
  });

  socket.on('groups:list', (list) => {
    groups = Array.isArray(list) ? list : [];
    renderAll();
    if (detailUUID) paintDetail();
  });

  socket.on('monitors:list', (list) => {
    monitors = Array.isArray(list) ? list : [];
    renderAll();
  });

  socket.on('monitors:updated', (monitor) => {
    if (!monitor) return;
    const idx = monitors.findIndex((m) => m.TargetID === monitor.TargetID);
    if (idx === -1) {
      monitors.push(monitor);
      renderAll();
    } else {
      monitors[idx] = monitor;
      if (!updateMonitorTile(monitor)) renderAll();
    }
  });

  // Initial connecting state
  setConn('connecting');
})();
