import { closeModal, openModal } from './lib/modal';
import { buildModalHeader } from './lib/modal-header';
import {
  AllClients,
  ClientInfoOpenUUID,
  ClientOnlineState,
  DummyClients,
  MonitorHistoryModalContext,
  MonitoringTargets,
  __LastClients,
  setAlertRulesCache,
  setDummyClients,
  setMonitoringTargets,
} from './01-state';
import { HandleNonFatalError, Safe } from './04-utils';
import { RenderFullClientAndMonitorList, UpdateClientTile } from './06-client-list';
import {
  IsMonitorHistoryContextFor,
  LoadHistorySamplesForContext,
  RenderMonitoringHistoryModal,
  UpdateMonitoringTargetTile,
} from './07-monitoring';
import {
  AddAlert,
  Alerts,
  AlertsVisible,
  RenderAlerts,
  UpdateAlertsIndicator,
} from './10-alerts-tray';
import { CloseAllModals, RenderUpdateManagerClientList } from './11-modals';
import {
  RefreshMonitoringCheckDebugIfOpen,
  RefreshMonitoringEditorIfOpen,
} from './12-monitoring-editor';
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

// Which protocol the reference is currently showing, and the last set of action
// groups pushed from the backend — cached so the toggle can re-render without a
// fresh push.
export let OscReferenceProtocol: 'OSC' | 'HTTP' = 'OSC';
export let OscReferenceGroups: OscActionGroup[] = [];

export function setOscReferenceProtocol(Protocol: 'OSC' | 'HTTP') {
  OscReferenceProtocol = Protocol;
}

export function setOscReferenceGroups(Groups: OscActionGroup[]) {
  OscReferenceGroups = Array.isArray(Groups) ? Groups : [];
}

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
        ${MethodLabel}
        <code class="osc-route-path">${formatRoutePath(Route.Path)}</code>
        ${QueryRows}
      `;
  }).join('');
}

/** Renders one action card for the selected protocol, or nothing if the action
 *  has no route for that protocol. */
export function renderActionGroup(
  $Container: JQuery,
  Group: OscActionGroup,
  Protocol: 'OSC' | 'HTTP'
) {
  const Routes = Protocol === 'OSC' ? Group.OSC : Group.HTTP;
  if (!Array.isArray(Routes) || Routes.length === 0) return;

  $Container.append(`
		<div class="d-grid gap-2 p-2 rounded bg-ghost rounded-3 osc-action-card">
			<div class="fw-semibold osc-action-title">${Safe(Group.Title || 'Untitled Route')}</div>
			${renderProtocolRows(Protocol, Routes)}
		</div>
	`);
}

/** Renders the OSC/HTTP segmented toggle shown at the top of the reference.
 *  Uses the shared `.st-segmented-toggle` look; `.osc-protocol-toggle-btn` is the
 *  click hook wired in InitOscFeeds. */
export function renderProtocolToggle(Active: 'OSC' | 'HTTP') {
  const Button = (Protocol: 'OSC' | 'HTTP') => {
    const IsActive = Active === Protocol;
    return `<button type="button" class="st-segmented-toggle-btn osc-protocol-toggle-btn${
      IsActive ? ' is-active' : ''
    }" data-protocol="${Protocol}" aria-pressed="${IsActive ? 'true' : 'false'}">${Protocol}</button>`;
  };
  return `<div class="st-segmented-toggle osc-protocol-toggle" role="group" aria-label="Protocol">${Button(
    'OSC'
  )}${Button('HTTP')}</div>`;
}

/** (Re)renders the reference list for the currently-selected protocol from the
 *  cached action groups. Called on each backend push and on every toggle. */
export function RenderOscReference() {
  const $List = $('#OSC_ROUTE_LIST');
  if (!$List.length) return;

  const IntroNote =
    OscReferenceProtocol === 'OSC'
      ? 'Showing OSC message addresses. Use the toggle to view the HTTP API.'
      : 'Showing HTTP routes, served under the <code>/API</code> prefix. Use the toggle to view OSC addresses.';

  $List.html('');
  $List.append(`
		<div class="d-grid gap-2 p-2 rounded bg-ghost-light rounded-3">
			<div class="osc-reference-intro-head">
				<div class="fw-semibold">OSC/API Reference</div>
				${renderProtocolToggle(OscReferenceProtocol)}
			</div>
			<div class="text-muted small">${IntroNote}</div>
		</div>
	`);

  let CurrentSection = -1;
  for (const Group of OscReferenceGroups) {
    const Routes = OscReferenceProtocol === 'OSC' ? Group.OSC : Group.HTTP;
    if (!Array.isArray(Routes) || Routes.length === 0) continue;
    const GroupPath = (Routes[0] && Routes[0].Path) || '';
    const SectionIndex = getRouteSectionIndex(GroupPath);
    if (SectionIndex !== CurrentSection) {
      CurrentSection = SectionIndex;
      $List.append(
        `<div class="osc-route-section-header">${Safe(getRouteSectionTitle(GroupPath))}</div>`
      );
    }
    renderActionGroup($List, Group, OscReferenceProtocol);
  }
}

export function normalizeRouteForOrdering(PathValue: string | undefined) {
  const Stripped = String(PathValue || '').replace(/^\/(?:ShowTrak|API)(?=\/|$)/i, '');
  return Stripped.startsWith('/') ? Stripped : `/${Stripped}`;
}

export const ROUTE_DISPLAY_ORDER = [
  '/Clients',
  '/Shutdown',
  '/Shutdown/Force',
  '/Client/:Slug/Select',
  '/Client/:Slug/Deselect',
  '/Client/:Slug/WakeOnLAN',
  '/Client/:Slug/RunScript/:ScriptID',
  '/Dummy/:Slug/Heartbeat',
  '/Group/:Slug/Select',
  '/Group/:Slug/Deselect',
  '/Group/:Slug/WakeOnLAN',
  '/Group/:Slug/RunScript/:ScriptID',
  '/Tag/:Slug/Select',
  '/Tag/:Slug/Deselect',
  '/Tag/:Slug/WakeOnLAN',
  '/Tag/:Slug/RunScript/:ScriptID',
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
  Tag: 45,
  All: 50,
  Selection: 60,
};

export function getLogicalRouteOrder(PathValue: string) {
  const NormalizedPath = normalizeRouteForOrdering(PathValue);
  const ExplicitIndex = ROUTE_DISPLAY_ORDER.indexOf(NormalizedPath);
  if (ExplicitIndex >= 0) return ExplicitIndex;

  const Segment = NormalizedPath.split('/').filter(Boolean)[0] || '';
  const SectionBase = Object.prototype.hasOwnProperty.call(ROUTE_SECTION_ORDER, Segment)
    ? ROUTE_SECTION_ORDER[Segment]! * 100 // hasOwnProperty checked above
    : 9000;
  return SectionBase;
}

/**
 * Display sections for the reference, in render order. Each section owns one or
 * more leading path segments; anything unmatched falls through to "Other".
 */
export const ROUTE_SECTIONS: { Title: string; Segments: string[] }[] = [
  { Title: 'Control', Segments: ['Shutdown'] },
  { Title: 'Clients', Segments: ['Clients', 'Client', 'Dummy'] },
  { Title: 'Tags', Segments: ['Tag'] },
  { Title: 'Groups', Segments: ['Group'] },
  { Title: 'All', Segments: ['All'] },
  { Title: 'Selections', Segments: ['Selection'] },
];

/** Section index for a route path; ROUTE_SECTIONS.length means "Other". */
export function getRouteSectionIndex(PathValue: string) {
  const Segment = (normalizeRouteForOrdering(PathValue).split('/').filter(Boolean)[0] || '')
    .trim()
    .toLowerCase();
  const Index = ROUTE_SECTIONS.findIndex((Section) =>
    Section.Segments.some((Owned) => Owned.toLowerCase() === Segment)
  );
  return Index === -1 ? ROUTE_SECTIONS.length : Index;
}

export function getRouteSectionTitle(PathValue: string) {
  const Index = getRouteSectionIndex(PathValue);
  return ROUTE_SECTIONS[Index] ? ROUTE_SECTIONS[Index].Title : 'Other';
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
  // Both OSC modals are top-level (title + close). Titles are static, so the
  // headers are built once here; the title ids are kept for aria-labelledby.
  $('#OSC_ROUTE_LIST_HEADER')
    .empty()
    .append(
      buildModalHeader({
        title: 'OSC/API Reference',
        titleId: 'OSC_ROUTE_LIST_MODAL_Label',
        onClose: () => closeModal('OSC_ROUTE_LIST_MODAL'),
      }).$el
    );
  $('#OSC_HTTP_DEBUG_HEADER')
    .empty()
    .append(
      buildModalHeader({
        title: 'OSC/API Debug Terminal',
        titleId: 'OSC_HTTP_DEBUG_MODAL_Label',
        onClose: () => closeModal('OSC_HTTP_DEBUG_MODAL'),
      }).$el
    );

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

  // Delegated so it survives the list being re-rendered on each toggle/push.
  $('#OSC_ROUTE_LIST')
    .off('click.oscprotocol')
    .on('click.oscprotocol', '.osc-protocol-toggle-btn', function () {
      const Protocol = $(this).attr('data-protocol') === 'HTTP' ? 'HTTP' : 'OSC';
      if (Protocol === OscReferenceProtocol) return;
      setOscReferenceProtocol(Protocol);
      RenderOscReference();
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
      // Section first (Control, Clients, Tags, …), then the intra-section order.
      const ASection = getRouteSectionIndex(APath);
      const BSection = getRouteSectionIndex(BPath);
      if (ASection !== BSection) return ASection - BSection;
      const AOrder = getLogicalRouteOrder(APath);
      const BOrder = getLogicalRouteOrder(BPath);
      if (AOrder !== BOrder) return AOrder - BOrder;
      return normalizeRouteForOrdering(APath).localeCompare(normalizeRouteForOrdering(BPath));
    });

    for (const Group of SortedGroups) {
      Group.OSC.sort((A, B) => String(A.Path || '').localeCompare(String(B.Path || '')));
      Group.HTTP.sort((A, B) => String(A.Path || '').localeCompare(String(B.Path || '')));
    }

    setOscReferenceGroups(SortedGroups);
    RenderOscReference();
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
    // A status update for a target we don't know about is not grounds to add it:
    // creation always follows up with a full list push, and a late update for a
    // deleted target would otherwise resurrect its tile until the next restart.
    if (idx === -1) return;
    const prev = MonitoringTargets[idx]!; // idx !== -1 guaranteed above
    MonitoringTargets[idx] = Target;
    // If a monitor changed groups, re-render. Otherwise update in place.
    if ((prev.GroupID || null) !== (Target.GroupID || null)) {
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
