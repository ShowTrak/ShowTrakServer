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
import type { ClientInfoKind, ClientInfoTabKey } from './lib/client-info-tabs';
import { Safe } from './utils';

let Kind: ClientInfoKind = 'client';
let RenderedKind: ClientInfoKind | null = null;
let ActiveTab: ClientInfoTabKey = DEFAULT_CLIENT_INFO_TAB;
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
      ActiveTab = ResolveClientInfoTab(Key, Kind);
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
    ClientInfoTabsFor(Kind)
      .map(
        (Tab) =>
          `<button type="button" class="settings-nav-item" role="tab" aria-selected="false" data-client-info-tab-target="${Safe(Tab.Key)}">${Safe(Tab.Title)}</button>`
      )
      .join('')
  );
}

/** Show the active tab's panes and mark its rail button. */
export function RefreshClientInfoTabs() {
  EnsureClientInfoNav();
  $('#SHOWTRAK_CLIENT_INFO .modal-body').addClass('is-tabbed');
  $('#CLIENT_INFO_NAV').removeClass('d-none');

  ActiveTab = ResolveClientInfoTab(ActiveTab, Kind);
  const Available: string[] = AvailableClientInfoTabs(Kind);
  $('#CLIENT_INFO_NAV .settings-nav-item').each(function () {
    const Key = this.getAttribute('data-client-info-tab-target') || '';
    const IsActive = Key === ActiveTab;
    $(this)
      .toggleClass('d-none', !Available.includes(Key))
      .toggleClass('active', IsActive)
      .attr('aria-selected', IsActive ? 'true' : 'false');
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

/** Each newly opened entity starts on the first tab. */
export function ResetClientInfoTab() {
  ActiveTab = DEFAULT_CLIENT_INFO_TAB;
  $('#CLIENT_INFO_CONTENT').scrollTop(0);
  AnnounceActiveTab();
}

/** Switch to a tab from code (the Audit Log opens an entity on its Logs). */
export function SelectClientInfoTab(Key: ClientInfoTabKey) {
  const Next = ResolveClientInfoTab(Key, Kind);
  if (Next === ActiveTab) return;
  ActiveTab = Next;
  RefreshClientInfoTabs();
  $('#CLIENT_INFO_CONTENT').scrollTop(0);
  AnnounceActiveTab();
}
