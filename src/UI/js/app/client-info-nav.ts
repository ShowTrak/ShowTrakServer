// The view modal's left-hand tab rail. #SHOWTRAK_CLIENT_INFO is shared by
// clients, monitoring targets, dummy clients and FreeKiosk terminals; each kind
// gets its own set of tabs (see lib/client-info-tabs). Each pane carries
// `data-client-info-tab`. Some panes are static markup and some are rebuilt on
// every render (the FreeKiosk ones), so RefreshClientInfoTabs is called after a
// render to hide whatever is not on the active tab.
import {
  ClientInfoTabsFor,
  AvailableClientInfoTabs,
  DEFAULT_CLIENT_INFO_TAB,
  ResolveClientInfoTab,
} from './lib/client-info-tabs';
import type { ClientInfoKind, ClientInfoSurface, ClientInfoTabKey } from './lib/client-info-tabs';
import { Capabilities } from './state';
import { Safe } from './utils';

const Surface: ClientInfoSurface = Capabilities.isWeb ? 'web' : 'desktop';

let Kind: ClientInfoKind = 'client';
let RenderedKind: ClientInfoKind | null = null;
let ActiveTab: ClientInfoTabKey = DEFAULT_CLIENT_INFO_TAB;
// Tabs carrying an active alarm (lib/client-info-alarms), marked on the rail.
let AlarmTabs = new Set<ClientInfoTabKey>();
const TabShownListeners: Array<(Key: ClientInfoTabKey) => void> = [];

// Panes that fetch on demand (Logs) hear when the operator moves between tabs.
export function OnClientInfoTabShown(Listener: (Key: ClientInfoTabKey) => void) {
  TabShownListeners.push(Listener);
}

function AnnounceActiveTab() {
  for (const Listener of TabShownListeners) {
    try {
      Listener(ActiveTab);
    } catch {
      /* intentional: one pane's failure must not stop the others hearing it */
    }
  }
}

// The rail's buttons only change with the kind, so they are rebuilt on a kind
// change rather than on every render.
function EnsureClientInfoNav() {
  const $nav = $('#CLIENT_INFO_NAV');
  if (!$nav.length) return;
  if (!$nav.data('bound')) {
    $nav.on('click', '.settings-nav-item', function () {
      const Key = this.getAttribute('data-client-info-tab-target');
      if (Key === ActiveTab) return;
      ActiveTab = ResolveClientInfoTab(Key, Kind, Surface);
      RefreshClientInfoTabs();
      // A new pane starts at its top, not wherever the last one was scrolled to.
      $('#CLIENT_INFO_CONTENT').scrollTop(0);
      AnnounceActiveTab();
    });
    $nav.data('bound', true);
  }
  if (RenderedKind === Kind) return;
  RenderedKind = Kind;
  $nav.html(
    ClientInfoTabsFor(Kind, Surface)
      .map(
        (Tab) =>
          `<button type="button" class="settings-nav-item" role="tab" aria-selected="false" data-client-info-tab-target="${Safe(Tab.Key)}"><span class="settings-nav-item-title">${Safe(Tab.Title)}</span><i class="bi bi-exclamation-triangle-fill settings-nav-item-alarm d-none" role="img" aria-label="Alarm active"></i></button>`
      )
      .join('')
  );
}

/** Show the active tab's panes and mark its rail button. */
export function RefreshClientInfoTabs() {
  EnsureClientInfoNav();
  $('#SHOWTRAK_CLIENT_INFO .modal-body').addClass('is-tabbed');
  $('#CLIENT_INFO_NAV').removeClass('d-none');

  ActiveTab = ResolveClientInfoTab(ActiveTab, Kind, Surface);
  const Available: string[] = AvailableClientInfoTabs(Kind, Surface);
  $('#CLIENT_INFO_NAV .settings-nav-item').each(function () {
    const Key = this.getAttribute('data-client-info-tab-target') || '';
    const IsActive = Key === ActiveTab;
    $(this)
      .toggleClass('d-none', !Available.includes(Key))
      .toggleClass('active', IsActive)
      .attr('aria-selected', IsActive ? 'true' : 'false');
    $(this)
      .find('.settings-nav-item-alarm')
      .toggleClass('d-none', !AlarmTabs.has(Key as ClientInfoTabKey));
  });
  $('#CLIENT_INFO_CONTENT [data-client-info-tab]').each(function () {
    $(this).toggleClass('is-inactive-tab', this.getAttribute('data-client-info-tab') !== ActiveTab);
  });
}

/** Which entity the modal is showing, and so which tabs the rail offers. */
export function SetClientInfoKind(Next: ClientInfoKind) {
  Kind = Next;
  RefreshClientInfoTabs();
}

/** Mark the tabs with an active alarm; the rest are cleared. */
export function SetClientInfoAlarmTabs(Tabs: readonly ClientInfoTabKey[]) {
  AlarmTabs = new Set(Tabs);
  RefreshClientInfoTabs();
}

/** Each newly opened entity starts on the first tab, with no alarms until it renders. */
export function ResetClientInfoTab() {
  ActiveTab = DEFAULT_CLIENT_INFO_TAB;
  AlarmTabs = new Set();
  $('#CLIENT_INFO_CONTENT').scrollTop(0);
  AnnounceActiveTab();
}

/** The tab the operator is looking at. */
export function GetActiveClientInfoTab(): ClientInfoTabKey {
  return ActiveTab;
}

/** Switch to a tab from code (the Audit Log opens an entity on its Logs). */
export function SelectClientInfoTab(Key: ClientInfoTabKey) {
  const Next = ResolveClientInfoTab(Key, Kind, Surface);
  if (Next === ActiveTab) return;
  ActiveTab = Next;
  RefreshClientInfoTabs();
  $('#CLIENT_INFO_CONTENT').scrollTop(0);
  AnnounceActiveTab();
}
