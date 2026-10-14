// The Client Info modal's left-hand tab rail. #SHOWTRAK_CLIENT_INFO is shared
// with the monitor, dummy and FreeKiosk views, so the rail is only switched on
// for real clients (RenderMonitoringHistoryModal decides which); everything else
// keeps the single status pane. Each pane carries `data-client-info-tab`.
import {
  AvailableClientInfoTabs,
  CLIENT_INFO_TABS,
  DEFAULT_CLIENT_INFO_TAB,
  ResolveClientInfoTab,
} from './lib/client-info-tabs';
import type { ClientInfoTabKey } from './lib/client-info-tabs';
import { Safe } from './utils';

let Tabbed = false;
let Integrated = false;
let ActiveTab: ClientInfoTabKey = DEFAULT_CLIENT_INFO_TAB;

// The rail's buttons never change, so they are built once on first use.
function EnsureClientInfoNav() {
  const $nav = $('#CLIENT_INFO_NAV');
  if (!$nav.length || $nav.children().length) return;
  for (const Tab of CLIENT_INFO_TABS) {
    $nav.append(
      `<button type="button" class="settings-nav-item" role="tab" aria-selected="false" data-client-info-tab-target="${Safe(Tab.Key)}">${Safe(Tab.Title)}</button>`
    );
  }
  $nav.on('click', '.settings-nav-item', function () {
    const Key = this.getAttribute('data-client-info-tab-target');
    if (Key === ActiveTab) return;
    ActiveTab = ResolveClientInfoTab(Key, Integrated);
    ApplyClientInfoTabs();
    // A new pane starts at its top, not wherever the last one was scrolled to.
    $('#CLIENT_INFO_CONTENT').scrollTop(0);
  });
}

function ApplyClientInfoTabs() {
  EnsureClientInfoNav();
  const $panes = $('#CLIENT_INFO_CONTENT [data-client-info-tab]');
  $('#SHOWTRAK_CLIENT_INFO .modal-body').toggleClass('is-tabbed', Tabbed);
  $('#CLIENT_INFO_NAV').toggleClass('d-none', !Tabbed);

  if (!Tabbed) {
    $panes.removeClass('is-inactive-tab');
    return;
  }

  ActiveTab = ResolveClientInfoTab(ActiveTab, Integrated);
  const Available: string[] = AvailableClientInfoTabs(Integrated);
  $('#CLIENT_INFO_NAV .settings-nav-item').each(function () {
    const Key = this.getAttribute('data-client-info-tab-target') || '';
    const IsActive = Key === ActiveTab;
    $(this)
      .toggleClass('d-none', !Available.includes(Key))
      .toggleClass('active', IsActive)
      .attr('aria-selected', IsActive ? 'true' : 'false');
  });
  $panes.each(function () {
    $(this).toggleClass('is-inactive-tab', this.getAttribute('data-client-info-tab') !== ActiveTab);
  });
}

/** Rail on for a real client, off for the other entities sharing the modal. */
export function SetClientInfoTabbed(On: boolean) {
  Tabbed = On;
  ApplyClientInfoTabs();
}

/** Integrated (SDK) clients only have the Status and Info tabs. */
export function SetClientInfoIntegrated(On: boolean) {
  Integrated = On;
  ApplyClientInfoTabs();
}

/** Each newly opened client starts on the first tab. */
export function ResetClientInfoTab() {
  ActiveTab = DEFAULT_CLIENT_INFO_TAB;
  $('#CLIENT_INFO_CONTENT').scrollTop(0);
}
