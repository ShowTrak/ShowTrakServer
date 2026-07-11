import { openModal } from './lib/modal';
import { AllClients, ClientInfoOpenUUID, ClientOnlineState, DummyClients, MonitorHistoryModalContext, MonitoringTargets, __LastClients, setAlertRulesCache, setDummyClients, setMonitoringTargets } from './01-state';
import { HandleNonFatalError, Safe } from './04-utils';
import { RenderFullClientAndMonitorList, UpdateClientTile } from './06-client-list';
import { IsMonitorHistoryContextFor, LoadHistorySamplesForContext, RenderMonitoringHistoryModal, UpdateMonitoringTargetTile } from './07-monitoring';
import { AddAlert, Alerts, AlertsVisible, RenderAlerts, UpdateAlertsIndicator } from './10-alerts-tray';
import { CloseAllModals, RenderUpdateManagerClientList } from './11-modals';
import { RefreshMonitoringCheckDebugIfOpen, RefreshMonitoringEditorIfOpen } from './12-monitoring-editor';
import { RenderAlertRuleManagerList } from './13-alert-rules';
import { Notify, RenderClientInfoDetails, UpdateIdentifyStatusBanner } from './14-selection-init';
import { UpdateDummyClientTile } from './16-dummy-clients';

/** One line rendered in the OSC/HTTP debug terminal. */
interface OscHttpDebugEntry {
  protocol: string;
  timestamp: number;
  valid: boolean;
  summary: string;
  detail: string;
}

/** Optional query-parameter descriptor attached to an HTTP route. */
interface RouteQueryParam {
  Key?: string;
  Type?: string;
  Example?: string;
}

/** Structural view of an OSC/HTTP route as consumed by the reference renderer. */
interface RouteDefinition {
  Protocol?: string;
  Methods?: string[] | string;
  Path?: string;
  Title?: string;
  QueryParams?: RouteQueryParam[];
}

/** A grouped action holding its OSC and HTTP route variants. */
interface OscActionGroup {
  Title: string;
  OSC: RouteDefinition[];
  HTTP: RouteDefinition[];
}

export const HttpApiRoutes = [
  {
    Protocol: 'HTTP',
    Methods: ['GET'],
    Path: '/API/Clients',
    Title: 'List Remote/Monitoring/Dummy entities using optional filters',
    QueryParams: [
      { Key: 'GroupID', Type: 'number', Example: '1' },
      { Key: 'OperatingSystem', Type: 'string', Example: 'Windows | macOS | Linux' },
      { Key: 'Status', Type: 'enum', Example: 'ONLINE | OFFLINE | DEGRADED | IDLE' },
      { Key: 'Type', Type: 'enum', Example: 'Remote | Monitoring | Dummy' },
    ],
  },
];

export const OSC_HTTP_DEBUG_MAX_LINES = 300;
export let OscHttpDebugEntries: OscHttpDebugEntry[] = [];
export let OscHttpDebugModalOpen = false;

export function FormatDebugTime(timestamp: number) {
  const date = new Date(Number(timestamp) || Date.now());
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  return `${hours}:${minutes}:${seconds}`;
}

export function RenderOscHttpDebugTerminal() {
  const $terminal = $('#OSC_HTTP_DEBUG_TERMINAL');
  if (!$terminal.length) return;

  if (!OscHttpDebugEntries.length) {
    $terminal.html(
      '<div class="osc-http-debug-empty">Send OSC or HTTP traffic to inspect requests.</div>'
    );
    return;
  }

  $terminal.html(
    OscHttpDebugEntries.map((entry) => {
      const stateClass = entry.valid ? 'is-valid' : 'is-invalid';
      const icon = entry.valid ? '&#10003;' : '&#10005;';
      const protocol = Safe(String(entry.protocol || '').toUpperCase());
      const summary = Safe(entry.summary || 'Unknown request');
      const detail = entry.detail
        ? `<span class="osc-http-debug-detail">${Safe(entry.detail)}</span>`
        : '';
      return `
		<div class="osc-http-debug-line ${stateClass}">
			<div class="osc-http-debug-status">${icon}</div>
			<div class="osc-http-debug-meta">[${Safe(FormatDebugTime(entry.timestamp))}] ${protocol}</div>
			<div class="osc-http-debug-text"><span class="osc-http-debug-summary">${summary}</span>${detail}</div>
		</div>
	`;
    }).join('')
  );

  const terminal = $terminal.get(0);
  if (terminal) terminal.scrollTop = terminal.scrollHeight;
}

export function AppendOscHttpDebugEntry(entry: OscHttpDebugEntry) {
  if (!OscHttpDebugModalOpen) return;
  OscHttpDebugEntries.push(entry);
  if (OscHttpDebugEntries.length > OSC_HTTP_DEBUG_MAX_LINES) {
    OscHttpDebugEntries = OscHttpDebugEntries.slice(-OSC_HTTP_DEBUG_MAX_LINES);
  }
  RenderOscHttpDebugTerminal();
}

export function RenderRouteEntry($Container: JQuery, _Route: RouteDefinition) {
  return $Container;
}

export function normalizeMethods(Value: string[] | string | undefined) {
  if (Array.isArray(Value)) {
    return Value.map((Method) =>
      String(Method || '')
        .trim()
        .toUpperCase()
    ).filter((Method) => Method);
  }
  if (typeof Value === 'string') {
    return Value.split(',')
      .map((Method) => Method.trim().toUpperCase())
      .filter((Method) => Method);
  }
  return [];
}

export function formatRoutePath(PathValue: string | undefined) {
  let PathFiller = '';
  for (const Segment of String(PathValue || '')
    .split('/')
    .filter((s) => s.length > 0)) {
    PathFiller += `<span>/</span>`;
    if (Segment.startsWith(':')) {
      PathFiller += `<span class="text-info">[${Safe(Segment.substring(1))}]</span>`;
    } else {
      PathFiller += `<span>${Safe(Segment)}</span>`;
    }
  }
  return PathFiller || '<span>/</span>';
}

export function renderQueryRows(Route: RouteDefinition) {
  if (!Route || !Array.isArray(Route.QueryParams) || Route.QueryParams.length === 0) return '';
  const Header = `
    <div class="osc-route-query-grid osc-route-query-header">
      <span>Key</span>
      <span>Value Type</span>
      <span>Example</span>
    </div>
  `;
  const Rows = Route.QueryParams.map((Param) => {
    return `
      <div class="osc-route-query-grid osc-route-query-row">
        <span class="osc-route-query-key">?${Safe(Param.Key || '')}=</span>
        <span class="osc-route-query-type">${Safe(Param.Type || 'string')}</span>
        <span class="osc-route-query-example">${Safe(Param.Example || '')}</span>
      </div>
    `;
  }).join('');
  return `<div class="osc-route-query-wrap">${Header}${Rows}</div>`;
}

export function renderProtocolRows(Protocol: string, Routes: RouteDefinition[]) {
  const Items = Array.isArray(Routes) ? Routes : [];
  if (Items.length === 0) {
    return `<div class="osc-action-route-unavailable">Unavailable</div>`;
  }

  return Items.map((Route) => {
    const Methods = normalizeMethods(Route.Methods)
      .filter((Method) => Method !== 'OSC')
      .join(', ');
    const MethodLabel =
      Protocol === 'HTTP' && Methods
        ? `<div class="osc-action-route-methods">${Safe(Methods)}</div>`
        : '';
    const QueryRows = Protocol === 'HTTP' ? renderQueryRows(Route) : '';
    return `
        <div class="osc-action-route-row">
          ${MethodLabel}
          <code class="bg-ghost rounded p-2 osc-route-path">${formatRoutePath(Route.Path)}</code>
          ${QueryRows}
        </div>
      `;
  }).join('');
}

export function renderActionGroup($Container: JQuery, Group: OscActionGroup) {
  const OscRows = renderProtocolRows('OSC', Group.OSC);
  const HttpRows = renderProtocolRows('HTTP', Group.HTTP);

  $Container.append(`
		<div class="d-grid gap-2 p-2 rounded bg-ghost rounded-3 osc-action-card">
			<div class="fw-semibold">${Safe(Group.Title || 'Untitled Route')}</div>
			<div class="osc-action-protocol-block">
				<div class="osc-action-protocol-label text-warning">OSC</div>
				<div class="osc-action-protocol-content">${OscRows}</div>
			</div>
			<div class="osc-action-protocol-block">
				<div class="osc-action-protocol-label text-info">HTTP</div>
				<div class="osc-action-protocol-content">${HttpRows}</div>
			</div>
		</div>
	`);
}

export function normalizeRouteForOrdering(PathValue: string | undefined) {
  const Stripped = String(PathValue || '').replace(/^\/(?:ShowTrak|API)(?=\/|$)/i, '');
  return Stripped.startsWith('/') ? Stripped : `/${Stripped}`;
}

export const ROUTE_DISPLAY_ORDER = [
  '/Clients',
  '/Shutdown',
  '/Shutdown/Force',
  '/Client/:UUID/Select',
  '/Client/:UUID/Deselect',
  '/Client/:UUID/WakeOnLAN',
  '/Client/:UUID/RunScript/:ScriptID',
  '/Dummy/:ID/Heartbeat',
  '/Group/:GroupID/Select',
  '/Group/:GroupID/Deselect',
  '/Group/:GroupID/WakeOnLAN',
  '/Group/:GroupID/RunScript/:ScriptID',
  '/All/Select',
  '/All/Deselect',
  '/All/WakeOnLAN',
  '/All/RunScript/:ScriptID',
  '/Selection/WakeOnLAN',
  '/Selection/RunScript/:ScriptID',
];

export const ROUTE_SECTION_ORDER: Record<string, number> = {
  Clients: 0,
  Shutdown: 10,
  Client: 20,
  Dummy: 30,
  Group: 40,
  All: 50,
  Selection: 60,
};

export function getLogicalRouteOrder(PathValue: string) {
  const NormalizedPath = normalizeRouteForOrdering(PathValue);
  const ExplicitIndex = ROUTE_DISPLAY_ORDER.indexOf(NormalizedPath);
  if (ExplicitIndex >= 0) return ExplicitIndex;

  const Segment = NormalizedPath.split('/').filter(Boolean)[0] || '';
  const SectionBase = Object.prototype.hasOwnProperty.call(ROUTE_SECTION_ORDER, Segment)
    ? ROUTE_SECTION_ORDER[Segment] * 100
    : 9000;
  return SectionBase;
}

export async function OpenOSCDictionary() {
  await CloseAllModals();
  openModal('OSC_ROUTE_LIST_MODAL');
}

export async function OpenOscHttpDebugTerminal() {
  await CloseAllModals();
  openModal('OSC_HTTP_DEBUG_MODAL');
}

// Called by the bootstrap orchestrator in main.ts — never at import time.
// Wires the OSC/HTTP debug modal and registers every OSC-feed push handler;
// bodies unchanged from the former import-time subscriptions.
export function InitOscFeeds() {
  $('#OSC_HTTP_DEBUG_MODAL')
  .off('shown.bs.modal.oschttpdebug hidden.bs.modal.oschttpdebug')
  .on('shown.bs.modal.oschttpdebug', () => {
    OscHttpDebugEntries = [];
    OscHttpDebugModalOpen = true;
    RenderOscHttpDebugTerminal();
  })
  .on('hidden.bs.modal.oschttpdebug', () => {
    OscHttpDebugModalOpen = false;
    OscHttpDebugEntries = [];
    RenderOscHttpDebugTerminal();
  });

window.API.Notify(async (Message, Type, Duration) => {
  Notify(Message, Type, Duration);
});

window.API.DebugTrafficEntry(async (Entry) => {
  AppendOscHttpDebugEntry({
    protocol: Entry && Entry.protocol ? Entry.protocol : 'unknown',
    timestamp: Entry && Entry.timestamp ? Entry.timestamp : Date.now(),
    valid: !!(Entry && Entry.valid),
    summary: Entry && Entry.summary ? Entry.summary : 'Unknown request',
    detail: Entry && Entry.detail ? Entry.detail : '',
  });
});

window.API.SetOSCList(async (Routes) => {
  const MirroredHttpRoutes = (Array.isArray(Routes) ? Routes : []).map((Route) => {
    // Keep OSC labels unchanged, but mirror HTTP paths without OSC namespace prefixes.
    const NormalizedPath =
      String((Route && Route.Path) || '').replace(/^\/(?:ShowTrak|API)(?=\/|$)/i, '') || '/';
    const ApiPath = `/API${NormalizedPath === '/' ? '' : NormalizedPath}`;
    return {
      Protocol: 'HTTP',
      Methods: ['GET', 'POST'],
      Path: ApiPath,
      Title: Route.Title || `HTTP mirror for ${Route.Path}`,
    };
  });

  const OscRoutes = (Array.isArray(Routes) ? Routes : []).map((Route) => ({
    Protocol: 'OSC',
    Methods: ['OSC'],
    Path: Route.Path,
    Title: Route.Title || Route.Path,
  }));

  const UnifiedRoutes = [...HttpApiRoutes, ...MirroredHttpRoutes, ...OscRoutes];
  const ActionGroups = new Map<string, OscActionGroup>();

  for (const Route of UnifiedRoutes) {
    const Key = String(Route.Title || Route.Path || '')
      .trim()
      .toLowerCase();
    if (!ActionGroups.has(Key)) {
      ActionGroups.set(Key, {
        Title: Route.Title || Route.Path,
        OSC: [],
        HTTP: [],
      });
    }
    const Group = ActionGroups.get(Key)!;
    if (String(Route.Protocol || '').toUpperCase() === 'OSC') {
      Group.OSC.push(Route);
    } else {
      Group.HTTP.push(Route);
    }
  }

  const SortedGroups = Array.from(ActionGroups.values()).sort((A, B) => {
    const APath = (A.HTTP[0] && A.HTTP[0].Path) || (A.OSC[0] && A.OSC[0].Path) || '';
    const BPath = (B.HTTP[0] && B.HTTP[0].Path) || (B.OSC[0] && B.OSC[0].Path) || '';
    const AOrder = getLogicalRouteOrder(APath);
    const BOrder = getLogicalRouteOrder(BPath);
    if (AOrder !== BOrder) return AOrder - BOrder;
    return normalizeRouteForOrdering(APath).localeCompare(normalizeRouteForOrdering(BPath));
  });

  for (const Group of SortedGroups) {
    Group.OSC.sort((A, B) => String(A.Path || '').localeCompare(String(B.Path || '')));
    Group.HTTP.sort((A, B) => String(A.Path || '').localeCompare(String(B.Path || '')));
  }

  $('#OSC_ROUTE_LIST').html('');
  $('#OSC_ROUTE_LIST').append(`
		<div class="d-grid gap-2 p-2 rounded bg-ghost-light rounded-3">
			<div class="fw-semibold">OSC/API Reference</div>
			<div class="text-muted small">Grouped by action. Each action shows OSC and HTTP availability.</div>
		</div>
	`);
  for (const Group of SortedGroups) {
    renderActionGroup($('#OSC_ROUTE_LIST'), Group);
  }
  return;
});

window.API.ClientUpdated(async (Data) => {
  // Keep cached full-client list in sync with live heartbeat updates so
  // secondary views (e.g. Update Manager) reflect current Online state.
  try {
    if (Array.isArray(__LastClients) && Data && Data.UUID) {
      const idx = __LastClients.findIndex((client) => client && client.UUID === Data.UUID);
      if (idx >= 0) {
        __LastClients[idx] = {
          ...__LastClients[idx],
          ...Data,
        };
      }
    }

    // Keep AllClients (used by the right-click action menu) in sync too, so the
    // intersection logic sees live OperatingSystem / IntegratedActions / Online.
    if (Array.isArray(AllClients) && Data && Data.UUID) {
      const aidx = AllClients.findIndex((client) => client && client.UUID === Data.UUID);
      if (aidx >= 0) {
        AllClients[aidx] = {
          ...AllClients[aidx],
          ...Data,
        };
      }
    }

    if ($('#SHOWTRAK_MODAL_UPDATE_MANAGER').hasClass('show')) {
      RenderUpdateManagerClientList();
    }
  } catch (err) {
    HandleNonFatalError('ClientUpdated:UpdateManagerCacheSync', err);
  }

  // Online transition handling: auto-dismiss any pending offline alerts when a
  // client comes back online. Offline transitions intentionally do not raise a
  // UI notification.
  try {
    const prev = ClientOnlineState.get(Data.UUID);
    if (typeof prev === 'boolean' && prev !== Data.Online && Data.Online) {
      try {
        let changed = false;
        for (const a of Alerts) {
          if (!a.dismissed && a.type === 'offline' && a.clientUUID === Data.UUID) {
            a.dismissed = true;
            changed = true;
          }
        }
        if (changed) {
          UpdateAlertsIndicator();
          if (AlertsVisible) RenderAlerts();
        }
      } catch (err) {
        HandleNonFatalError('ClientUpdated:DismissOfflineAlert', err);
      }
    }
    ClientOnlineState.set(Data.UUID, !!Data.Online);
  } catch (err) {
    HandleNonFatalError('ClientUpdated:TransitionAlerts', err);
  }
  const { UUID } = Data;
  UpdateClientTile(Data);
  // If Client Info modal is open for this client, refresh network interfaces (and USB if present)
  try {
    const $modal = $('#SHOWTRAK_CLIENT_INFO');
    if (ClientInfoOpenUUID && ClientInfoOpenUUID === UUID && $modal.hasClass('show')) {
      RenderClientInfoDetails(Data);
    }
  } catch (err) {
    HandleNonFatalError('ClientUpdated:RenderClientInfoDetails', err);
  }
  // If the shared status-timeline graph is showing this client, reload its
  // series live so the timeline and status card stay current.
  if (IsMonitorHistoryContextFor('client', UUID)) {
    try {
      await LoadHistorySamplesForContext();
      RenderMonitoringHistoryModal();
    } catch (err) {
      HandleNonFatalError('ClientUpdated:RefreshClientHistory', err);
    }
  }
  return;
});

// --- Monitoring Targets ---
window.API.SetFullMonitoringTargetList(async (List) => {
    setMonitoringTargets(Array.isArray(List) ? List : []);
  // Re-render the full client+monitor view so monitors slot back into their groups.
  RenderFullClientAndMonitorList();
  UpdateIdentifyStatusBanner();
});

window.API.MonitoringTargetUpdated(async (Target) => {
  if (!Target || !Target.TargetID) return;
  const idx = MonitoringTargets.findIndex((t) => t.TargetID === Target.TargetID);
  const prev = idx === -1 ? null : MonitoringTargets[idx];
  if (idx === -1) {
    MonitoringTargets.push(Target);
  } else {
    MonitoringTargets[idx] = Target;
  }
  // If a monitor changed groups, re-render. Otherwise update in place.
  if (!prev || (prev.GroupID || null) !== (Target.GroupID || null)) {
    RenderFullClientAndMonitorList();
  } else {
    UpdateMonitoringTargetTile(Target);
  }
  // Keep the open editor's per-check status list fresh.
  RefreshMonitoringEditorIfOpen(Target.TargetID);
  // Keep the open check editor's "last response" debug panel fresh.
  RefreshMonitoringCheckDebugIfOpen(Target.TargetID);
  // If the history modal is showing this target, reload its series live.
  if (
    MonitorHistoryModalContext &&
    MonitorHistoryModalContext.type === 'target' &&
    Number(MonitorHistoryModalContext.id) === Number(Target.TargetID)
  ) {
    await LoadHistorySamplesForContext();
    RenderMonitoringHistoryModal();
  }
});

window.API.SetFullAlertRuleList(async (List) => {
    setAlertRulesCache(Array.isArray(List) ? List : []);
  RenderAlertRuleManagerList();
});

// --- Dummy Clients ---
window.API.SetFullDummyClientList(async (List) => {
    setDummyClients(Array.isArray(List) ? List : []);
  // Re-render the full client+monitor view so dummies slot back into groups.
  RenderFullClientAndMonitorList();
});

window.API.DummyClientUpdated(async (Dummy) => {
  if (!Dummy || !Dummy.UUID) return;
  const idx = DummyClients.findIndex((d) => d.UUID === Dummy.UUID);
  const prev = idx === -1 ? null : DummyClients[idx];
  if (idx === -1) {
    DummyClients.push(Dummy);
  } else {
    DummyClients[idx] = Dummy;
  }
  // If a dummy changed groups (or is new), re-render. Otherwise update in place.
  if (!prev || (prev.GroupID || null) !== (Dummy.GroupID || null)) {
    RenderFullClientAndMonitorList();
  } else {
    UpdateDummyClientTile(Dummy);
  }
  if (IsMonitorHistoryContextFor('dummy', Dummy.UUID)) {
    await LoadHistorySamplesForContext();
    RenderMonitoringHistoryModal();
  }
});

window.API.CreateShowTrakAlert(async (Payload) => {
  if (!Payload) return;
  AddAlert({
    type: 'warning',
    severity: Payload.Severity || 'info',
    title: Payload.Title || 'ShowTrak Alert',
    message: Payload.Message || '',
    clientUUID: Payload.UUID || null,
  });
});
}
