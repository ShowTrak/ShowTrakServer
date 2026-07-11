// Client "identify" flow (renderer): version gating, target eligibility, the
// set of currently-identifying UUIDs, local state application, bulk stop, and
// the status banner. Extracted verbatim from the old 14-selection-init
// god-module so that file can become a pure re-export barrel.
import { AllClients, IsIntegratedClientEntity, PendingAdoption } from './01-state';
import { HandleNonFatalError } from './04-utils';
import { RenderFullClientAndMonitorList } from './06-client-list';
import { Notify } from './lib/toasts';

export const MINIMUM_IDENTIFY_VERSION = [3, 7, 0];
export const MINIMUM_DISPLAY_MONITORING_VERSION = [3, 8, 0];

export function ParseSemverTuple(value: unknown) {
  const Match = String(value || '')
    .trim()
    .match(/(?:^|[^0-9])(\d+)\.(\d+)\.(\d+)(?:[^0-9]|$)/);
  if (!Match) return null;
  return [Number(Match[1]), Number(Match[2]), Number(Match[3])];
}

export function IsVersionAtLeast(value: unknown, minimumTuple: number[]) {
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

export function GetIdentifyTargetByUUID(UUID: string) {
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

export function GetIdentifyingUUIDs() {
  // Primary source: live rendered tiles. This stays accurate even when an
  // incremental push updates classes before list caches are reconciled.
  const FromDom = new Set<string>();
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
  const Identifying = new Set<string>();
  (Array.isArray(AllClients) ? AllClients : []).forEach((Client) => {
    if (Client && Client.UUID && Client.Identifying) Identifying.add(Client.UUID);
  });
  (Array.isArray(PendingAdoption) ? PendingAdoption : []).forEach((Device) => {
    if (Device && Device.UUID && Device.Identifying) Identifying.add(Device.UUID);
  });
  return Array.from(Identifying);
}

export function ApplyIdentifyStateLocally(UUIDs: string[], Identifying: boolean) {
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

  RenderFullClientAndMonitorList();
  UpdateIdentifyStatusBanner();
}

export async function StopIdentifyingForUUIDs(UUIDs: string[]) {
  const List = Array.from(new Set((Array.isArray(UUIDs) ? UUIDs : []).filter(Boolean)));
  if (!List.length) return { succeeded: [], failed: [] };
  const Results = await Promise.all(List.map((UUID) => window.API.StopIdentifyingClient(UUID)));
  const Succeeded: string[] = [];
  const Failed: Array<{ UUID: string; Error: unknown }> = [];
  Results.forEach((Result, Index) => {
    const Err: unknown = Array.isArray(Result) ? Result[0] : null;
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
  if (Errors.length) {
    Notify(String(Errors[0]), 'danger');
  }
  return { succeeded: Succeeded, failed: Failed };
}

export function UpdateIdentifyStatusBanner() {
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
