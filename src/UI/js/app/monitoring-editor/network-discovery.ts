// Network discovery scan (renderer).
//
// The "scan my network for devices" modal: kicks off a server-side sweep,
// renders results as they stream back over the NetworkScanEvent channel, and
// hands a chosen device to the monitoring editor as a pre-filled target.
//
// Extracted from the 1581-line monitoring-editor.ts. It shared a file with the
// editor only because both are reached from the same modal — nothing in the
// editor calls into this module, so it is a self-contained feature.
import type { NetworkScanEvent, NetworkScanResult } from '@showtrak/protocol';
import { closeModal, openModal } from '../lib/modal';
import { buildModalHeader } from '../lib/modal-header';
import {
  NetworkDiscoveryProgress,
  NetworkDiscoveryResults,
  NetworkDiscoveryScanID,
  NetworkDiscoveryScanning,
  setNetworkDiscoveryProgress,
  setNetworkDiscoveryResults,
  setNetworkDiscoveryScanID,
  setNetworkDiscoveryScanning,
} from '../state';
import { ErrorMessage, HandleNonFatalError, Safe } from '../utils';
import { CloseAllModals } from '../modals';
import { Notify } from '../selection-init';
import { EnsureMonitoringMethodsLoaded } from './method-fields';

/** A network-discovered device as merged/stored in the discovery results map. */
interface DiscoveredDevice {
  ID?: string;
  Name?: string;
  Address?: string;
  Hostname?: string | null;
  Source?: string;
  ServiceType?: string;
  Port?: number | null;
  MethodHint?: string;
  Services?: Array<{ type: string; port: number | null }>;
}

export function SetNetworkDiscoveryStatus(label: string) {
  $('#NETWORK_DISCOVERY_STATUS').text(label || 'Idle');
}

export function ParseIPv4ToNumber(address: unknown) {
  const parts = String(address || '')
    .trim()
    .split('.')
    .map((part) => Number(part));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return null;
  }
  return (((parts[0]! * 256 + parts[1]!) * 256 + parts[2]!) * 256 + parts[3]!) >>> 0; // length === 4 checked above
}

export function RenderNetworkDiscoveryScanButton() {
  const $btn = $('#NETWORK_DISCOVERY_TOGGLE_SCAN');
  if (!$btn.length) return;
  $btn.prop('disabled', false);
  if (NetworkDiscoveryScanning) {
    $btn.addClass('is-scanning').text('Cancel Scan');
  } else {
    $btn.removeClass('is-scanning').text('Start Scan');
  }
}

export function SetNetworkDiscoveryProgress(percent: number, current = 0, total = 0) {
  const p = Math.max(0, Math.min(100, Number.isFinite(Number(percent)) ? Number(percent) : 0));
  const cur = Number.isFinite(Number(current)) ? Number(current) : 0;
  const tot = Number.isFinite(Number(total)) ? Number(total) : 0;
  setNetworkDiscoveryProgress({
    percent: p,
    current: cur,
    total: tot,
  });
  const $btn = $('#NETWORK_DISCOVERY_TOGGLE_SCAN');
  if ($btn.length) {
    $btn.css('--scan-progress', `${p}%`);
  }
}

export function RenderNetworkDiscoveryResults() {
  const $host = $('#NETWORK_DISCOVERY_RESULTS_BODY');
  if (!$host.length) return;
  const list = Array.from<DiscoveredDevice>(NetworkDiscoveryResults.values()).sort((a, b) => {
    const aIp = ParseIPv4ToNumber(a.Address);
    const bIp = ParseIPv4ToNumber(b.Address);
    if (aIp != null && bIp != null) return aIp - bIp;
    if (aIp != null) return -1;
    if (bIp != null) return 1;
    return String(a.Address || '').localeCompare(String(b.Address || ''));
  });

  if (!list.length) {
    $host.html(`
      <tr>
        <td colspan="5" class="text-muted text-center py-3">
          No devices discovered yet. Start a scan to search your local network.
        </td>
      </tr>
    `);
    return;
  }

  let html = '';
  for (const item of list) {
    const id = Safe(item.ID);
    const sourceKey = String(item.Source || 'unknown').toLowerCase();
    const sourceLabel =
      sourceKey === 'bonjour' ? 'mDNS' : sourceKey === 'pjlink' ? 'PJLink' : 'Scan';
    const serviceList = Array.isArray(item.Services) ? item.Services.slice(0, 5) : [];
    const details: string[] = [];
    if (item.Hostname) details.push(`host: ${Safe(item.Hostname)}`);
    if (serviceList.length) {
      details.push(`services: ${Safe(serviceList.map((s) => s.type).join(', '))}`);
    } else if (item.ServiceType) {
      details.push(`service: ${Safe(item.ServiceType)}`);
    }
    if (item.Port) details.push(`port: ${Safe(String(item.Port))}`);
    const detailsText = details.length ? details.join(' · ') : '-';
    html += `
      <tr>
        <td>
          <div class="nd-name">${Safe(item.Name || item.Address || 'Unnamed Device')}</div>
        </td>
        <td>
          <div class="nd-address">${Safe(item.Address || '')}</div>
        </td>
        <td>
          <span class="badge bg-ghost-light text-light">${Safe(sourceLabel)}</span>
        </td>
        <td>
          <div class="nd-details">${Safe(detailsText)}</div>
        </td>
        <td class="text-end">
          <button type="button" class="btn btn-light btn-sm NETWORK_DISCOVERY_ADD" data-id="${id}">
            Add
          </button>
        </td>
      </tr>`;
  }
  $host.html(html);
}

export function ResetNetworkDiscoveryState() {
  setNetworkDiscoveryScanID(null);
  setNetworkDiscoveryScanning(false);
  setNetworkDiscoveryResults(new Map());
  RenderNetworkDiscoveryScanButton();
  SetNetworkDiscoveryStatus('Idle');
  SetNetworkDiscoveryProgress(0, 0, 0);
  RenderNetworkDiscoveryResults();
}

export function MergeNetworkDiscoveryResult(result: NetworkScanResult) {
  if (!result || !result.Address) return;
  const addressKey = String(result.Address).trim().toLowerCase();
  if (!addressKey) return;
  const existing = (NetworkDiscoveryResults.get(addressKey) || {}) as DiscoveredDevice;
  const existingServices = Array.isArray(existing.Services) ? existing.Services : [];
  const nextServices = existingServices.slice();
  if (result.Source === 'bonjour') {
    const serviceType = String(result.ServiceType || '').trim();
    const servicePort = result.Port == null ? null : Number(result.Port);
    const dedupeKey = `${serviceType.toLowerCase()}:${Number.isFinite(servicePort) ? servicePort : 0}`;
    if (
      serviceType &&
      !nextServices.some(
        (s) => `${String(s.type || '').toLowerCase()}:${Number(s.port) || 0}` === dedupeKey
      )
    ) {
      nextServices.push({
        type: serviceType,
        port: Number.isFinite(servicePort) ? servicePort : null,
      });
    }
  }

  // A PJLink hint is the most specific we can offer for a projector, so never
  // let a later plain-probe/mDNS result for the same address downgrade it.
  const methodHint =
    existing.MethodHint === 'pjlink' ? 'pjlink' : result.MethodHint || existing.MethodHint;
  // Likewise keep the richer PJLink source badge once we've seen it.
  const source = existing.Source === 'pjlink' ? 'pjlink' : result.Source || existing.Source;

  NetworkDiscoveryResults.set(addressKey, {
    ...existing,
    ...result,
    Source: source,
    MethodHint: methodHint,
    Hostname: result.Hostname || existing.Hostname || null,
    Services: nextServices,
    ID: addressKey,
  });
  RenderNetworkDiscoveryResults();
}

export function HandleNetworkDiscoveryEvent(event: NetworkScanEvent) {
  if (!event || !event.ScanID) return;
  if (!NetworkDiscoveryScanID || event.ScanID !== NetworkDiscoveryScanID) return;
  if (event.Type === 'status') {
    SetNetworkDiscoveryStatus(event.Status || 'Scanning');
    if (event.Progress) {
      SetNetworkDiscoveryProgress(
        event.Progress.Percent,
        event.Progress.Current,
        event.Progress.Total
      );
    }
    return;
  }
  if (event.Type === 'result' && event.Result) {
    MergeNetworkDiscoveryResult(event.Result);
    return;
  }
  if (event.Type === 'done') {
    setNetworkDiscoveryScanning(false);
    RenderNetworkDiscoveryScanButton();
    SetNetworkDiscoveryStatus(event.Status || 'Completed');
    SetNetworkDiscoveryProgress(
      100,
      NetworkDiscoveryProgress.total,
      NetworkDiscoveryProgress.total
    );
  }
}

export async function StopNetworkDiscoveryScan() {
  if (!NetworkDiscoveryScanID) {
    setNetworkDiscoveryScanning(false);
    RenderNetworkDiscoveryScanButton();
    return;
  }
  const scanID = NetworkDiscoveryScanID;
  setNetworkDiscoveryScanID(null);
  setNetworkDiscoveryScanning(false);
  RenderNetworkDiscoveryScanButton();
  try {
    await window.API.StopNetworkDeviceScan(scanID);
  } catch (err) {
    HandleNonFatalError('MonitoringEditor:StopNetworkDiscoveryScan', err);
  }
}

export async function StartNetworkDiscoveryScan() {
  if (NetworkDiscoveryScanning) return;
  await EnsureMonitoringMethodsLoaded();
  setNetworkDiscoveryResults(new Map());
  SetNetworkDiscoveryProgress(0, 0, 0);
  RenderNetworkDiscoveryResults();
  setNetworkDiscoveryScanning(true);
  RenderNetworkDiscoveryScanButton();
  SetNetworkDiscoveryStatus('Starting...');

  try {
    const [Err, Result] = await window.API.StartNetworkDeviceScan({
      EnableBonjour: true,
      EnableProbe: true,
      EnablePJLink: true,
      TimeoutMs: 12000,
      MaxHostsPerSubnet: 512,
      ProbePorts: [80, 443, 22, 445, 3389, 8080, 4352],
    });
    if (Err) {
      setNetworkDiscoveryScanning(false);
      RenderNetworkDiscoveryScanButton();
      SetNetworkDiscoveryStatus('Failed');
      return Notify(Err, 'error');
    }
    setNetworkDiscoveryScanID(Result && Result.ScanID ? Result.ScanID : null);
    SetNetworkDiscoveryStatus('Scanning...');
  } catch (e) {
    setNetworkDiscoveryScanning(false);
    RenderNetworkDiscoveryScanButton();
    SetNetworkDiscoveryStatus('Failed');
    Notify(ErrorMessage(e, 'Failed to start scan'), 'error');
  }
}

export async function OpenNetworkDiscoveryModal() {
  await CloseAllModals();
  ResetNetworkDiscoveryState();
  $('#NETWORK_DISCOVERY_HEADER')
    .empty()
    .append(
      buildModalHeader({
        title: 'LAN Discovery',
        onClose: () => closeModal('SHOWTRAK_MODAL_NETWORK_DISCOVERY'),
      }).$el
    );
  openModal('SHOWTRAK_MODAL_NETWORK_DISCOVERY');
  await StartNetworkDiscoveryScan();
}
