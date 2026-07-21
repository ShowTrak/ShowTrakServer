// Script-deployment orchestration for the main process.
//
// When the script catalog changes, or a client comes online / is adopted, the
// out-of-date online clients must be (re)deployed the current script set. This
// module owns that machinery: fingerprint comparison, the in-flight/queued
// deployment state machine (so overlapping triggers coalesce instead of
// stampeding the execution queue), and the debounce timer for filesystem-driven
// catalog changes. Extracted verbatim from main.ts — behavior is unchanged.

import { CreateLogger } from '../Modules/Logger';
import { SCRIPT_DEPLOY_DEBOUNCE_MS } from '../Modules/Config/constants';
import { Manager as ScriptManager } from '../Modules/ScriptManager';
import { Manager as ClientManager } from '../Modules/ClientManager';
import { Manager as ServerManager } from '../Modules/Server';
import { Manager as ScriptExecutionManager } from '../Modules/ScriptExecutionManager';

const Logger = CreateLogger('Main');

// Minimal structural shapes for the dynamically-shaped values this module reads.
interface DeploymentClientInfo {
  Integrated?: unknown;
  OperatingSystem?: unknown;
}
interface DeploymentScriptInfo {
  ID?: string;
  ParseError?: string;
  isValid?: boolean;
}
interface DeploymentExecutionInfo {
  Script?: { Name?: unknown } | null;
  Status?: unknown;
}

let ScriptChangeDeployTimer: ReturnType<typeof setTimeout> | null = null;
const ActiveScriptDeployment = {
  inFlight: false,
  serverFingerprint: '',
  targets: new Set<string>(),
  queuedServerFingerprint: '',
  queuedTargets: new Set<string>(),
};

function normalizeDeploymentTargets(TargetUUIDs: unknown): string[] {
  if (!Array.isArray(TargetUUIDs)) return [];
  return [...new Set(TargetUUIDs.filter((UUID) => typeof UUID === 'string' && UUID.trim()))];
}

function IsIntegratedClient(Client: DeploymentClientInfo | null | undefined): boolean {
  return !!(
    Client &&
    (Client.Integrated ||
      String(Client.OperatingSystem || '')
        .trim()
        .toLowerCase() === 'integrated')
  );
}

async function GetAllAdoptedClientUUIDs(): Promise<string[]> {
  const [Err, Clients] = await ClientManager.GetAll();
  if (Err || !Array.isArray(Clients)) return [];
  return normalizeDeploymentTargets(Clients.map((Client) => Client.UUID));
}

async function MarkDeploymentFailedForTargets(
  Targets: string[],
  ErrorMessage: string
): Promise<void> {
  await ScriptExecutionManager.ClearQueue();
  for (const UUID of Targets) {
    const RequestID = await ScriptExecutionManager.AddInternalTaskToQueue(
      UUID,
      'Deploying Scripts'
    );
    if (!RequestID) continue;
    await ScriptExecutionManager.Complete(RequestID, ErrorMessage);
  }
}

async function ResolveOutOfDateDeploymentTargets(TargetUUIDs: string[]) {
  const ServerFingerprint = await ScriptManager.GetDeploymentFingerprint();
  const OnlineOutOfDateTargets = [];
  const OfflineOutOfDateTargets = [];
  const UpToDateTargets = [];
  const SkippedIntegratedTargets = [];

  for (const UUID of TargetUUIDs) {
    const [ClientErr, Client] = await ClientManager.Get(UUID);
    if (ClientErr || !Client) continue;

    // Integrated clients execute event actions and should never receive
    // script-catalog deployment tasks.
    if (IsIntegratedClient(Client)) {
      SkippedIntegratedTargets.push(UUID);
      continue;
    }

    const ClientFingerprint =
      typeof Client.ScriptsFingerprint === 'string' ? Client.ScriptsFingerprint.trim() : '';
    const IsOutOfDate = !ClientFingerprint || ClientFingerprint !== ServerFingerprint;

    if (!IsOutOfDate) {
      UpToDateTargets.push(UUID);
      continue;
    }

    if (!Client.Online) {
      OfflineOutOfDateTargets.push(UUID);
      continue;
    }

    OnlineOutOfDateTargets.push(UUID);
  }

  return {
    serverFingerprint: ServerFingerprint,
    onlineOutOfDateTargets: OnlineOutOfDateTargets,
    offlineOutOfDateTargets: OfflineOutOfDateTargets,
    upToDateTargets: UpToDateTargets,
    skippedIntegratedTargets: SkippedIntegratedTargets,
  };
}

async function TriggerScriptDeployment(TargetUUIDs: unknown, Reason = 'manual'): Promise<void> {
  const Targets = normalizeDeploymentTargets(TargetUUIDs);
  if (Targets.length === 0) return;

  const DeploymentTargetInfo = await ResolveOutOfDateDeploymentTargets(Targets);
  const DeployTargets = DeploymentTargetInfo.onlineOutOfDateTargets;
  if (DeployTargets.length === 0) {
    Logger.log('Skipping script deployment; no out-of-date online clients', {
      reason: Reason,
      requestedTargets: Targets.length,
      upToDateTargets: DeploymentTargetInfo.upToDateTargets.length,
      offlineOutOfDateTargets: DeploymentTargetInfo.offlineOutOfDateTargets.length,
      skippedIntegratedTargets: DeploymentTargetInfo.skippedIntegratedTargets.length,
    });
    return;
  }

  const Scripts = (await ScriptManager.GetScripts()) || [];
  const InvalidScripts = Scripts.filter(
    (Script: DeploymentScriptInfo) => !Script || Script.isValid === false
  );

  if (InvalidScripts.length > 0) {
    const InvalidIDs = InvalidScripts.map((Script: DeploymentScriptInfo) => {
      const ID = Script && Script.ID ? Script.ID : 'Unknown Script';
      const ParseError = Script && Script.ParseError ? String(Script.ParseError) : '';
      return ParseError ? `${ID} (${ParseError})` : ID;
    });
    const ReasonMessage = `Invalid command JSON (Script.json): ${InvalidIDs.join(', ')}`;
    Logger.warn('Skipping script deployment due to invalid Script.json', {
      reason: Reason,
      targets: DeployTargets.length,
      invalidScripts: InvalidIDs,
    });
    await MarkDeploymentFailedForTargets(DeployTargets, ReasonMessage);
    return;
  }

  Logger.log('Triggering script deployment', {
    reason: Reason,
    targets: DeployTargets.length,
    requestedTargets: Targets.length,
    upToDateTargets: DeploymentTargetInfo.upToDateTargets.length,
    offlineOutOfDateTargets: DeploymentTargetInfo.offlineOutOfDateTargets.length,
    skippedIntegratedTargets: DeploymentTargetInfo.skippedIntegratedTargets.length,
    serverFingerprint: DeploymentTargetInfo.serverFingerprint,
  });

  const IsSameDeploymentSession =
    ActiveScriptDeployment.inFlight &&
    ActiveScriptDeployment.serverFingerprint === DeploymentTargetInfo.serverFingerprint;

  if (IsSameDeploymentSession) {
    const AdditionalTargets = DeployTargets.filter(
      (UUID) => !ActiveScriptDeployment.targets.has(UUID)
    );
    if (AdditionalTargets.length === 0) {
      Logger.log('Skipping duplicate in-flight deployment dispatch', {
        reason: Reason,
        targets: DeployTargets.length,
        serverFingerprint: DeploymentTargetInfo.serverFingerprint,
      });
      return;
    }
    await ServerManager.ExecuteBulkRequest(
      'UpdateScripts',
      AdditionalTargets,
      'Deploying Scripts',
      {
        resetQueue: false,
      }
    );
    AdditionalTargets.forEach((UUID) => ActiveScriptDeployment.targets.add(UUID));
    return;
  }

  if (ActiveScriptDeployment.inFlight) {
    DeployTargets.forEach((UUID) => ActiveScriptDeployment.queuedTargets.add(UUID));
    ActiveScriptDeployment.queuedServerFingerprint = DeploymentTargetInfo.serverFingerprint;
    Logger.log('Queued deployment while another deployment is active', {
      reason: Reason,
      queuedTargets: ActiveScriptDeployment.queuedTargets.size,
      queuedServerFingerprint: ActiveScriptDeployment.queuedServerFingerprint,
      activeServerFingerprint: ActiveScriptDeployment.serverFingerprint,
    });
    return;
  }

  ActiveScriptDeployment.inFlight = true;
  ActiveScriptDeployment.serverFingerprint = DeploymentTargetInfo.serverFingerprint;
  ActiveScriptDeployment.targets = new Set(DeployTargets);

  await ServerManager.ExecuteBulkRequest('UpdateScripts', DeployTargets, 'Deploying Scripts', {
    resetQueue: true,
  });
}

function ScheduleScriptChangeDeployment(): void {
  if (ScriptChangeDeployTimer) clearTimeout(ScriptChangeDeployTimer);
  ScriptChangeDeployTimer = setTimeout(async () => {
    ScriptChangeDeployTimer = null;
    const Targets = await GetAllAdoptedClientUUIDs();
    await TriggerScriptDeployment(Targets, 'scripts-changed');
  }, SCRIPT_DEPLOY_DEBOUNCE_MS);
}

// Called from the ScriptExecutionUpdated fan-out: once no 'Deploying Scripts'
// tasks remain pending, the in-flight session is complete — clear it and flush
// any deployment that was queued while it ran.
function ReconcileDeploymentQueueAfterExecutions(Executions: DeploymentExecutionInfo[]): void {
  const PendingScriptDeployments = (Executions || []).filter(
    (Execution: DeploymentExecutionInfo) => {
      return (
        Execution &&
        Execution.Script &&
        Execution.Script.Name === 'Deploying Scripts' &&
        Execution.Status === 'Pending'
      );
    }
  );

  if (PendingScriptDeployments.length === 0) {
    const QueuedTargets = [...ActiveScriptDeployment.queuedTargets];
    ActiveScriptDeployment.inFlight = false;
    ActiveScriptDeployment.serverFingerprint = '';
    ActiveScriptDeployment.targets.clear();

    ActiveScriptDeployment.queuedTargets.clear();
    ActiveScriptDeployment.queuedServerFingerprint = '';

    if (QueuedTargets.length > 0) {
      TriggerScriptDeployment(QueuedTargets, 'queued-after-inflight').catch((Err) =>
        Logger.error('Queued deployment trigger failed', Err)
      );
    }
  }
}

export {
  TriggerScriptDeployment,
  ScheduleScriptChangeDeployment,
  ReconcileDeploymentQueueAfterExecutions,
};
