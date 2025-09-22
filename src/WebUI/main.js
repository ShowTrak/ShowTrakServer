const ns = '/ui';
const socket = io(ns, { transports: ['websocket', 'polling'] });

const el = {
  list: document.getElementById('clients'),
  tmpl: document.getElementById('client-card-tmpl'),
  search: document.getElementById('searchInput'),
  refresh: document.getElementById('refreshBtn'),
  viewList: document.getElementById('view-list'),
  viewDetail: document.getElementById('view-detail'),
  back: document.getElementById('backBtn'),
  home: document.getElementById('homeBtn'),
  dName: document.getElementById('d-name'),
  dStatus: document.getElementById('d-status'),
  dSubtitle: document.getElementById('d-subtitle'),
  info: document.getElementById('info'),
  usbList: document.getElementById('usbList'),
  netList: document.getElementById('netList'),
  cpuCanvas: document.getElementById('cpuChart'),
  ramCanvas: document.getElementById('ramChart'),
  scriptsSheet: document.getElementById('scripts-sheet'),
  scriptsList: document.getElementById('scriptsList'),
  openScriptsBtn: document.getElementById('openScriptsBtn'),
  closeScriptsBtn: document.getElementById('closeScriptsBtn'),
  wolBtn: document.getElementById('wolBtn'),
  offline: document.getElementById('offlineBanner'),
  confirm: document.getElementById('confirmModal'),
  confirmTitle: document.getElementById('confirmTitle'),
  confirmText: document.getElementById('confirmText'),
  confirmOk: document.getElementById('confirmOk'),
  confirmCancel: document.getElementById('confirmCancel'),
};

let clients = [];
let filter = '';
let selectedUUID = null;
let detail = null;
let scriptsCache = [];

// Basic history-based navigation
window.addEventListener('popstate', () => {
  const q = new URLSearchParams(location.search);
  const uuid = q.get('client');
  if (uuid) openDetail(uuid, false);
  else showList(false);
});

function render() {
  const q = filter.trim().toLowerCase();
  const data = q
    ? clients.filter((c) =>
        (c.Nickname && c.Nickname.toLowerCase().includes(q)) ||
        (c.Hostname && c.Hostname.toLowerCase().includes(q)) ||
        (c.UUID && c.UUID.toLowerCase().includes(q))
      )
    : clients;
  el.list.innerHTML = '';
  for (const c of data) {
    const node = el.tmpl.content.cloneNode(true);
    node.querySelector('.title').textContent = c.Nickname || c.Hostname || c.UUID;
    const status = node.querySelector('.status');
    status.textContent = c.Online ? 'Online' : 'Offline';
    status.style.color = c.Online ? 'var(--ok)' : 'var(--muted)';
    node.querySelector('.subtitle').textContent = c.Hostname || '—';
    const meta = node.querySelector('.meta');
    const badges = [];
    if (c.IP) badges.push(`IP ${c.IP}`);
    if (c.Version) badges.push(`v${c.Version}`);
    if (typeof c.GroupID !== 'undefined' && c.GroupID !== null) badges.push(`Group ${c.GroupID}`);
    if (c.Vitals && c.Vitals.CPU && typeof c.Vitals.CPU.UsagePercentage === 'number') {
      badges.push(`CPU ${Math.round(c.Vitals.CPU.UsagePercentage)}%`);
    }
    if (c.Vitals && c.Vitals.Ram && typeof c.Vitals.Ram.UsagePercentage === 'number') {
      badges.push(`RAM ${Math.round(c.Vitals.Ram.UsagePercentage)}%`);
    }
    for (const b of badges) {
      const span = document.createElement('span');
      span.className = 'badge';
      span.textContent = b;
      meta.appendChild(span);
    }
    const card = node.querySelector('.card');
    card.style.cursor = 'pointer';
    card.addEventListener('click', () => openDetail(c.UUID));
    el.list.appendChild(node);
  }
}

function upsertClient(updated) {
  const idx = clients.findIndex((x) => x.UUID === updated.UUID);
  if (idx === -1) clients.push(updated);
  else clients[idx] = { ...clients[idx], ...updated };
}

// Socket wiring
socket.on('connect', () => {
  setOffline(false);
  // Fetch initial data
  socket.emit('clients:get', (res) => {
    if (res && res.data) {
      clients = res.data;
      render();
    }
  });
});

socket.on('clients:list', (list) => {
  clients = list || [];
  render();
});

socket.on('clients:updated', (client) => {
  if (!client) return;
  upsertClient(client);
  render();
  if (selectedUUID && client.UUID === selectedUUID) {
    // update detail vitals on-the-fly
    detail = { ...detail, ...client };
    paintDetail(detail);
  }
});

socket.io.on('reconnect_attempt', () => setOffline(true));
socket.on('disconnect', () => setOffline(true));
window.addEventListener('online', () => setOffline(false));
window.addEventListener('offline', () => setOffline(true));

function setOffline(isOffline) {
  if (!el.offline) return;
  el.offline.classList.toggle('hidden', !isOffline);
}

// UI events
el.search.addEventListener('input', (e) => {
  filter = e.target.value || '';
  render();
});

el.refresh.addEventListener('click', () => {
  socket.emit('clients:get', (res) => {
    if (res && res.data) {
      clients = res.data;
      render();
    }
  });
});

// List/detail helpers
function showList(push = true) {
  selectedUUID = null;
  detail = null;
  el.viewDetail.classList.add('hidden');
  el.viewList.classList.remove('hidden');
  if (push) history.pushState({}, '', location.pathname);
}

async function openDetail(uuid, push = true) {
  selectedUUID = uuid;
  el.viewList.classList.add('hidden');
  el.viewDetail.classList.remove('hidden');
  if (push) {
    const url = new URL(location.href);
    url.searchParams.set('client', uuid);
    history.pushState({}, '', url);
  }
  // fetch detail and scripts
  await Promise.all([
    new Promise((resolve) =>
      socket.emit('client:get', uuid, (res) => {
        detail = res && res.data ? res.data : null;
        resolve();
      })
    ),
    new Promise((resolve) =>
      socket.emit('scripts:list', (res) => {
        scriptsCache = (res && res.data) || [];
        resolve();
      })
    ),
  ]);
  paintDetail(detail);
}

el.back.addEventListener('click', () => showList());
el.home.addEventListener('click', () => {
  // Close any sheets and navigate to list
  if (el.scriptsSheet) el.scriptsSheet.classList.add('hidden');
  showList();
});

function openScriptsSheet() {
  renderScriptsSheet();
  el.scriptsSheet.classList.remove('hidden');
}
function closeScriptsSheet() {
  el.scriptsSheet.classList.add('hidden');
}
el.openScriptsBtn.addEventListener('click', openScriptsSheet);
el.closeScriptsBtn.addEventListener('click', closeScriptsSheet);

function renderScriptsSheet() {
  el.scriptsList.innerHTML = '';
  for (const s of scriptsCache) {
    const btn = document.createElement('button');
    btn.className = 'script-btn ' + (s.style ? `script-style-${s.style}` : '');
    const name = document.createElement('div');
    name.className = 'script-name';
    name.textContent = s.name;
    const go = document.createElement('div');
    go.textContent = 'Run';
    btn.append(name, go);
    btn.addEventListener('click', () => openConfirm(`Run \n${s.name}?`, () => runScript(s)));
    el.scriptsList.appendChild(btn);
  }
}

function runScript(s) {
  if (!selectedUUID) return;
  socket.emit('scripts:run', { uuid: selectedUUID, scriptId: s.id }, (_res) => {
    closeScriptsSheet();
    closeConfirm();
  });
}

function openConfirm(message, onOk) {
  if (!el.confirm) return;
  el.confirmTitle.textContent = 'Confirm Action';
  el.confirmText.textContent = message || 'Are you sure?';
  el.confirm.classList.remove('hidden');
  el.confirmOk.onclick = () => {
    try { onOk && onOk(); } finally { /* close in runScript */ }
  };
  el.confirmCancel.onclick = closeConfirm;
}
function closeConfirm() {
  if (!el.confirm) return;
  el.confirm.classList.add('hidden');
}

el.wolBtn.addEventListener('click', () => {
  if (!selectedUUID) return;
  socket.emit('wol:wake', { uuid: selectedUUID }, (res) => {
    // noop; could show toast on success/fail
  });
});

// Simple line chart painter (no deps)
const cpuSeries = new Array(60).fill(0);
const ramSeries = new Array(60).fill(0);
function pushSeries(series, val) {
  series.push(val);
  if (series.length > 120) series.shift();
}
function drawSeries(canvas, series, color) {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  // grid
  ctx.strokeStyle = '#263043';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = (h / 4) * i + 0.5;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }
  // line
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  const n = series.length;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * w;
    const y = h - (series[i] / 100) * h;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

function paintDetail(c) {
  if (!c) return;
  el.dName.textContent = c.Nickname || c.Hostname || c.UUID;
  el.dStatus.textContent = c.Online ? 'Online' : 'Offline';
  el.dStatus.style.color = c.Online ? 'var(--ok)' : 'var(--muted)';
  el.dSubtitle.textContent = c.Hostname || '—';
  // info grid
  el.info.innerHTML = '';
  const fields = [
    ['UUID', c.UUID],
    ['IP', c.IP || '—'],
    ['MAC', c.MacAddress || '—'],
    ['Version', c.Version || '—'],
    ['Group', (c.GroupID ?? '—') + ''],
    ['Last Seen', c.LastSeen ? timeAgo(c.LastSeen) : '—'],
  ];
  for (const [k, v] of fields) {
    const div = document.createElement('div');
    div.className = 'kv';
    const kk = document.createElement('div');
    kk.className = 'k';
    kk.textContent = k;
    const vv = document.createElement('div');
    vv.className = 'v';
    vv.textContent = v;
    div.append(kk, vv);
    el.info.appendChild(div);
  }
  // lists
  el.usbList.innerHTML = '';
  (c.USBDeviceList || []).forEach((d) => {
    const li = document.createElement('div');
    li.className = 'list-item';
    li.textContent = `${d.ManufacturerName || ''} ${d.ProductName || ''}`.trim() || 'USB Device';
    el.usbList.appendChild(li);
  });
  el.netList.innerHTML = '';
  (c.NetworkInterfaces || []).forEach((n) => {
    const li = document.createElement('div');
    li.className = 'list-item';
    const addrs = (n.addresses || []).filter((a) => a.family === 'IPv4' && !a.internal);
    li.textContent = `${n.name} — ${addrs.map((a) => a.address).join(', ')}`;
    el.netList.appendChild(li);
  });
  // charts
  const cpu = Math.round((c.Vitals?.CPU?.UsagePercentage ?? 0) * 1);
  const ram = Math.round((c.Vitals?.Ram?.UsagePercentage ?? 0) * 1);
  pushSeries(cpuSeries, cpu);
  pushSeries(ramSeries, ram);
  drawSeries(el.cpuCanvas, cpuSeries, '#60a5fa');
  drawSeries(el.ramCanvas, ramSeries, '#34d399');
}

function timeAgo(ts) {
  const now = Date.now();
  const diff = Math.max(0, now - Number(ts));
  const s = Math.floor(diff / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  const w = Math.floor(d / 7);
  if (w < 4) return `${w}w ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  const y = Math.floor(d / 365);
  return `${y}y ago`;
}

// Kick off correct view on initial load
(function initRoute() {
  const q = new URLSearchParams(location.search);
  const uuid = q.get('client');
  if (uuid) openDetail(uuid, false);
})();
