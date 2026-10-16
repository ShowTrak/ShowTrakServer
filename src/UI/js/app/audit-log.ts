// The audit log in the renderer: the Logs tab of the view modal (one entity)
// and the Audit Log modal (everything). Both are the same panel — a search box,
// filters, the rows, and "Load Older" — over GetAuditLog, kept live by the
// AuditLogAppended push while they are on screen. Row markup and the live
// filter live in lib/audit-log.
import type { AuditEntityType, AuditLogEntry, AuditLogQuery } from '@showtrak/protocol';
import {
  AUDIT_CATEGORY_OPTIONS,
  AUDIT_ENTITY_TYPE_OPTIONS,
  AuditEntriesHtml,
  AuditEntryMatches,
  MergeAuditEntries,
} from './lib/audit-log';
import { buildModalHeader } from './lib/modal-header';
import { closeModal, openModal } from './lib/modal';
import { HandleNonFatalError, Safe } from './utils';
import { MonitorHistoryModalContext } from './state';
import { CloseAllModals } from './modals';
import { OnClientInfoTabShown, SelectClientInfoTab } from './client-info-nav';
import { OpenClientInfo } from './client-info-modal';
import {
  OpenDummyClientHistory,
  OpenFreeKioskTerminalHistory,
  OpenMonitoringTargetHistory,
} from './monitoring-history-modal';

const PAGE_SIZE = 200;
// A list left open through a busy evening keeps growing at the top; past this
// the oldest rows are let go (they are still a "Load Older" away).
const MAX_HELD_ENTRIES = 2000;
const SEARCH_DEBOUNCE_MS = 250;
const AUDIT_LOG_MODAL_ID = 'AUDIT_LOG_MODAL';

interface PanelOptions {
  ShowEntity: boolean;
  // The Audit Log modal can narrow by entity type; a Logs tab is one entity.
  EntityTypeFilter: boolean;
  // The fixed part of the query (which entity), or null while there is none.
  Scope: () => AuditLogQuery | null;
  // The element that scrolls the list, so a live row arriving at the top does
  // not shove what the operator is reading down the page.
  ScrollParent: () => HTMLElement | null;
}

class AuditLogPanel {
  private $root: JQuery;
  private Options: PanelOptions;
  private Entries: AuditLogEntry[] = [];
  private HasMore = false;
  private Active = false;
  // Bumped by every reload, so a slow read that lands after a newer one is dropped.
  private Generation = 0;
  private SearchTimer: ReturnType<typeof setTimeout> | null = null;

  constructor($root: JQuery, Options: PanelOptions) {
    this.$root = $root;
    this.Options = Options;
    this.Build();
  }

  private Build() {
    const Categories = AUDIT_CATEGORY_OPTIONS.map(
      ([Value, Label]) => `<option value="${Safe(Value)}">${Safe(Label)}</option>`
    ).join('');
    const Types = AUDIT_ENTITY_TYPE_OPTIONS.map(
      ([Value, Label]) => `<option value="${Safe(Value)}">${Safe(Label)}</option>`
    ).join('');
    this.$root.addClass('audit-log-panel').html(`
      <div class="audit-log-toolbar">
        <input type="search" class="form-control form-control-sm audit-log-search" placeholder="Search…" aria-label="Search the audit log" />
        ${this.Options.EntityTypeFilter ? `<select class="form-select form-select-sm audit-log-type" aria-label="Show entries for">${Types}</select>` : ''}
        <select class="form-select form-select-sm audit-log-category" aria-label="Show activity">${Categories}</select>
      </div>
      <div class="audit-log-list" role="log" aria-live="polite"></div>
      <button type="button" class="btn btn-light btn-sm w-100 audit-log-more d-none">Load Older</button>
    `);
    this.$root.on('input', '.audit-log-search', () => {
      if (this.SearchTimer) clearTimeout(this.SearchTimer);
      this.SearchTimer = setTimeout(() => void this.Reload(), SEARCH_DEBOUNCE_MS);
    });
    this.$root.on('change', '.audit-log-category, .audit-log-type', () => void this.Reload());
    this.$root.on('click', '.audit-log-more', () => void this.LoadOlder());
    this.$root.on('click', 'button.audit-entity', function () {
      void OpenAuditEntity(
        String(this.getAttribute('data-audit-entity-type') || ''),
        String(this.getAttribute('data-audit-entity-id') || '')
      );
    });
  }

  private Query(): AuditLogQuery | null {
    const Scope = this.Options.Scope();
    if (!Scope) return null;
    const Query: AuditLogQuery = { ...Scope };
    const Category = String(this.$root.find('.audit-log-category').val() || '');
    if (Category) Query.Category = Category as AuditLogQuery['Category'];
    const Search = String(this.$root.find('.audit-log-search').val() || '').trim();
    if (Search) Query.Search = Search;
    if (this.Options.EntityTypeFilter) {
      const Type = String(this.$root.find('.audit-log-type').val() || '');
      if (Type) Query.EntityType = Type as AuditEntityType;
    }
    return Query;
  }

  async Activate() {
    this.Active = true;
    await this.Reload();
  }

  Deactivate() {
    this.Active = false;
    this.Generation += 1;
    this.Entries = [];
    this.HasMore = false;
    if (this.SearchTimer) clearTimeout(this.SearchTimer);
    this.SearchTimer = null;
  }

  // Back to no search and no filters, for the next entity shown.
  ResetFilters() {
    this.$root.find('.audit-log-search').val('');
    this.$root.find('.audit-log-category, .audit-log-type').val('');
  }

  async Reload() {
    if (!this.Active) return;
    const Query = this.Query();
    const Generation = ++this.Generation;
    if (!Query) {
      this.Entries = [];
      this.HasMore = false;
      this.Render();
      return;
    }
    this.$root.addClass('is-loading');
    try {
      const Page = await window.API.GetAuditLog({ ...Query, Limit: PAGE_SIZE });
      if (Generation !== this.Generation) return;
      this.Entries = Page && Array.isArray(Page.Entries) ? Page.Entries : [];
      this.HasMore = !!(Page && Page.HasMore);
      this.Render();
    } catch (Err) {
      HandleNonFatalError('AuditLog:Reload', Err);
    } finally {
      if (Generation === this.Generation) this.$root.removeClass('is-loading');
    }
  }

  async LoadOlder() {
    const Query = this.Query();
    const Oldest = this.Entries[this.Entries.length - 1];
    if (!this.Active || !Query || !Oldest) return;
    const Generation = this.Generation;
    const $more = this.$root.find('.audit-log-more').prop('disabled', true);
    try {
      const Page = await window.API.GetAuditLog({
        ...Query,
        BeforeID: Oldest.ID,
        Limit: PAGE_SIZE,
      });
      if (Generation !== this.Generation) return;
      this.Entries = MergeAuditEntries(this.Entries, (Page && Page.Entries) || []);
      this.HasMore = !!(Page && Page.HasMore);
      this.Render();
    } catch (Err) {
      HandleNonFatalError('AuditLog:LoadOlder', Err);
    } finally {
      $more.prop('disabled', false);
    }
  }

  // New entries, as the server writes them.
  Append(Incoming: readonly AuditLogEntry[]) {
    if (!this.Active || !Array.isArray(Incoming) || !Incoming.length) return;
    const Query = this.Query();
    if (!Query) return;
    const Matching = Incoming.filter((Entry) => AuditEntryMatches(Entry, Query));
    if (!Matching.length) return;
    const Scroller = this.Options.ScrollParent();
    const List = this.$root.find('.audit-log-list').get(0) as HTMLElement | undefined;
    const BeforeHeight = List ? List.scrollHeight : 0;
    const Merged = MergeAuditEntries(this.Entries, Matching);
    if (Merged.length > MAX_HELD_ENTRIES) {
      Merged.length = MAX_HELD_ENTRIES;
      this.HasMore = true;
    }
    this.Entries = Merged;
    this.Render();
    // Reading further down: keep the rows where they were rather than letting
    // the new ones push them away. At the top, the new rows simply show.
    if (Scroller && List && Scroller.scrollTop > 0) {
      Scroller.scrollTop += List.scrollHeight - BeforeHeight;
    }
  }

  private Render() {
    const $list = this.$root.find('.audit-log-list');
    if (!this.Entries.length) {
      const Filtered =
        !!String(this.$root.find('.audit-log-search').val() || '').trim() ||
        !!this.$root.find('.audit-log-category').val() ||
        !!this.$root.find('.audit-log-type').val();
      $list.html(
        `<div class="audit-log-empty">${
          Filtered ? 'No entries match.' : 'Nothing recorded in the last 24 hours.'
        }</div>`
      );
    } else {
      $list.html(AuditEntriesHtml(this.Entries, { ShowEntity: this.Options.ShowEntity }));
    }
    this.$root.find('.audit-log-more').toggleClass('d-none', !this.HasMore);
  }
}

let TabPanel: AuditLogPanel | null = null;
let ModalPanel: AuditLogPanel | null = null;

// Which entity the view modal is showing, as the audit log names it.
function ViewModalScope(): AuditLogQuery | null {
  const Context = MonitorHistoryModalContext;
  if (!Context || Context.id === null || Context.id === undefined || Context.id === '') return null;
  const Types: Record<string, AuditEntityType> = {
    client: 'client',
    freekiosk: 'freekiosk',
    dummy: 'dummy',
    target: 'monitor',
  };
  const EntityType = Types[Context.type];
  return EntityType ? { EntityType, EntityID: String(Context.id) } : null;
}

// Open an entity's view modal straight onto its Logs tab.
async function OpenAuditEntity(Type: string, ID: string) {
  if (!ID) return;
  try {
    if (Type === 'client') await OpenClientInfo(ID);
    else if (Type === 'freekiosk') await OpenFreeKioskTerminalHistory(ID);
    else if (Type === 'dummy') await OpenDummyClientHistory(ID);
    else if (Type === 'monitor') await OpenMonitoringTargetHistory(Number(ID));
    else return;
    SelectClientInfoTab('logs');
  } catch (Err) {
    HandleNonFatalError('AuditLog:OpenEntity', Err);
  }
}

export async function OpenAuditLog() {
  await CloseAllModals();
  if (!ModalPanel) return;
  ModalPanel.ResetFilters();
  openModal(AUDIT_LOG_MODAL_ID);
  await ModalPanel.Activate();
}

export function InitAuditLog() {
  const $tab = $('#CLIENT_INFO_LOGS_SECTION');
  if ($tab.length) {
    TabPanel = new AuditLogPanel($tab, {
      ShowEntity: false,
      EntityTypeFilter: false,
      Scope: ViewModalScope,
      ScrollParent: () => document.getElementById('CLIENT_INFO_CONTENT'),
    });
    // Only read while the tab is actually showing: the view modal is open
    // far more often than its logs are looked at.
    OnClientInfoTabShown((Key) => {
      if (!TabPanel) return;
      if (Key === 'logs') {
        TabPanel.ResetFilters();
        void TabPanel.Activate();
      } else {
        TabPanel.Deactivate();
      }
    });
    $('#SHOWTRAK_CLIENT_INFO').on('hidden.bs.modal', () => TabPanel && TabPanel.Deactivate());
  }

  const $panel = $('#AUDIT_LOG_PANEL');
  if ($panel.length) {
    ModalPanel = new AuditLogPanel($panel, {
      ShowEntity: true,
      EntityTypeFilter: true,
      Scope: () => ({}),
      ScrollParent: () => $panel.find('.audit-log-list').get(0) || null,
    });
    $('#AUDIT_LOG_HEADER')
      .empty()
      .append(
        buildModalHeader({
          title: 'Audit Log',
          titleId: 'AUDIT_LOG_MODAL_Label',
          onClose: () => closeModal(AUDIT_LOG_MODAL_ID),
        }).$el
      );
    $(`#${AUDIT_LOG_MODAL_ID}`).on('hidden.bs.modal', () => ModalPanel && ModalPanel.Deactivate());
  }

  $('#SHOWTRAK_MODEL_CORE_AUDIT_LOG_BUTTON').on('click', () => void OpenAuditLog());

  window.API.AuditLogAppended((Entries) => {
    if (TabPanel) TabPanel.Append(Entries);
    if (ModalPanel) ModalPanel.Append(Entries);
  });
}
