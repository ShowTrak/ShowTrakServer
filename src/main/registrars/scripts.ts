// IPC registrar: script execution, script-catalog management, and local script
// file open/run. Extracted verbatim from main.ts, including the
// `openFileWithWorkspaceEditor` / `runCommandForOpen` helpers that only
// Scripts:OpenFile uses.

import { CreateLogger } from '../../Modules/Logger';
import { SCRIPT_EXECUTION_DEFAULT_TIMEOUT_MS } from '../../Modules/Config/constants';
import { RPC } from '../rpc';
import { validationErrorTuple } from '../ipc/create-handler';
import { TriggerScriptDeployment } from '../deployment';
import {
  resolveContainedScriptFile,
  normalizeRelativePathForCompare,
  getLocalPlatformKey,
  parseArgumentString,
  runLocalScriptFile,
} from '../local-scripts';
const { shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
import { Manager as ServerManager } from '../../Modules/Server';
import { Manager as ScriptManager } from '../../Modules/ScriptManager';
import { Manager as ScriptWhitelistManager } from '../../Modules/ScriptWhitelistManager';
import { Manager as SampleScriptsManager } from '../../Modules/SampleScripts';
import { Manager as SettingsManager } from '../../Modules/SettingsManager';
import { Manager as AppDataManager } from '../../Modules/AppData';
import { Manager as BroadcastManager } from '../../Modules/Broadcast';
import { Manager as IPCValidation } from '../../Modules/IPCValidation';

const Logger = CreateLogger('Main');

function runCommandForOpen(command: string, args: string[]) {
  return new Promise<string | null>((resolve) => {
    execFile(command, args, (error: Error | null) => {
      if (error) {
        resolve(error.message || String(error));
        return;
      }
      resolve(null);
    });
  });
}

async function openFileWithWorkspaceEditor(filePath: string) {
  const selectedEditor = await SettingsManager.GetValue('SYSTEM_WORKSPACE_DEFAULT_EDITOR');
  const editorName = String(selectedEditor || 'System Default').trim();

  if (!editorName || editorName === 'System Default') {
    return shell.openPath(filePath);
  }

  if (editorName === 'Visual Studio Code') {
    if (process.platform === 'darwin') {
      const openErr = await runCommandForOpen('open', ['-a', 'Visual Studio Code', filePath]);
      if (!openErr) return '';
      Logger.warn('Open in Visual Studio Code failed, falling back to system default:', openErr);
      return shell.openPath(filePath);
    }
    if (process.platform === 'win32') {
      const openErr = await runCommandForOpen('cmd', ['/c', 'code', '-g', filePath]);
      if (!openErr) return '';
      Logger.warn('Open in Visual Studio Code failed, falling back to system default:', openErr);
      return shell.openPath(filePath);
    }
    const openErr = await runCommandForOpen('code', ['-g', filePath]);
    if (!openErr) return '';
    Logger.warn('Open in Visual Studio Code failed, falling back to system default:', openErr);
    return shell.openPath(filePath);
  }

  return shell.openPath(filePath);
}

function register(): void {
  RPC.handle('ExecuteScript', async (_Event: unknown, Scripts: unknown, Targets: unknown, ResetList: unknown) => {
    let ValidScripts, ValidTargets, ValidResetList;
    try {
      ValidScripts = IPCValidation.ScriptID(Scripts);
      ValidTargets = IPCValidation.UUIDList(Targets || [], 'Targets');
      ValidResetList = IPCValidation.Boolean(ResetList, 'ResetList');
    } catch (error) {
      return validationErrorTuple(error);
    }
    await ServerManager.ExecuteScripts(ValidScripts, ValidTargets, ValidResetList);
    return [null, true];
  });

  // Trigger an integrated client action (event) on the selected integrated
  // clients. Validated like ExecuteScript but routed through the integrated
  // event protocol.
  RPC.handle('TriggerIntegratedEvent', async (_Event: unknown, EventID: unknown, Targets: unknown) => {
    let ValidEventID, ValidTargets;
    try {
      ValidEventID = IPCValidation.IntegratedEventID(EventID);
      ValidTargets = IPCValidation.UUIDList(Targets || [], 'Targets');
    } catch (error) {
      return validationErrorTuple(error);
    }
    await ServerManager.TriggerIntegratedEvent(ValidEventID, ValidTargets);
    return [null, true];
  });

  RPC.handle('DeleteScripts', async (_Event: unknown, List: unknown) => {
    let ValidList;
    try {
      ValidList = IPCValidation.UUIDList(List || [], 'Targets');
    } catch (error) {
      return validationErrorTuple(error);
    }
    await ServerManager.ExecuteBulkRequest('DeleteScripts', ValidList, 'Delete Scripts');
    return;
  });

  RPC.handle('UpdateScripts', async (_Event: unknown, List: unknown) => {
    try {
      List = IPCValidation.UUIDList(List || [], 'Targets');
    } catch (error) {
      return validationErrorTuple(error);
    }
    await TriggerScriptDeployment(List, 'manual-request');
    return [null, true];
  });

  // Script Manager: return the catalog (including invalid scripts) for editing.
  RPC.handle('Scripts:GetManagerList', async () => {
    const Scripts = (await ScriptManager.GetScripts()) || [];
    return Scripts.map((s) => ({
      id: s.ID,
      name: s.Name,
      description: s.Description || '',
      colour: typeof s.Colour === 'number' ? s.Colour : 6,
      icon: typeof s.Icon === 'string' && s.Icon ? s.Icon : 'terminal',
      weight: s.Weight || 0,
      confirm: !!s.Confirmation,
      timeoutMs:
        'Timeout' in s && typeof s.Timeout === 'number'
          ? s.Timeout
          : SCRIPT_EXECUTION_DEFAULT_TIMEOUT_MS,
      enabled: !!s.isEnabled,
      valid: !!s.isValid,
      parseError: 'ParseError' in s ? s.ParseError || null : null,
      platforms: s.Platforms || {},
      compatiblePlatforms: s.CompatiblePlatforms || [],
      issues: s.ValidationErrors || [],
    }));
  });

  // Script Manager: read the editable fields + folder file list for one script.
  RPC.handle('Scripts:GetConfig', async (_Event: unknown, ID: unknown) => {
    let ValidID;
    try {
      ValidID = IPCValidation.ScriptFolderID(ID);
    } catch (error) {
      return validationErrorTuple(error);
    }
    const [Err, Data] = await ScriptManager.GetEditable(ValidID);
    if (Err) return [Err, null];
    return [null, Data];
  });

  // Script Manager: validate, normalize and persist structured field edits
  // (optionally renaming the script folder/ID).
  RPC.handle('Scripts:SaveConfig', async (_Event: unknown, ID: unknown, Fields: unknown) => {
    let ValidID, ValidFields;
    try {
      ValidID = IPCValidation.ScriptFolderID(ID);
      ValidFields = IPCValidation.ScriptFieldsPayload(Fields);
    } catch (error) {
      return validationErrorTuple(error);
    }
    const [Err, Data] = await ScriptManager.SaveFields(ValidID, ValidFields);
    if (Err) return [Err, null];
    // A rename changes the folder ID; carry the whitelist across so a restricted
    // script does not silently revert to "all clients" under its new ID.
    if (Data && Data.id && Data.id !== ValidID) {
      await ScriptWhitelistManager.RenameScript(ValidID, Data.id);
    }
    return [null, Data];
  });

  // Script Manager: read the per-show whitelist scope for one script. Returns
  // null when unrestricted (all clients) — the default for every script.
  RPC.handle('Scripts:GetWhitelist', async (_Event: unknown, ID: unknown) => {
    let ValidID;
    try {
      ValidID = IPCValidation.ScriptFolderID(ID);
    } catch (error) {
      return validationErrorTuple(error);
    }
    const Scope = await ScriptWhitelistManager.GetScope(ValidID);
    return [null, Scope];
  });

  // Script Manager: persist the per-show whitelist scope for one script.
  RPC.handle('Scripts:SetWhitelist', async (_Event: unknown, ID: unknown, Scope: unknown) => {
    let ValidID, ValidScope;
    try {
      ValidID = IPCValidation.ScriptFolderID(ID);
      ValidScope = IPCValidation.ScriptWhitelistScope(Scope);
    } catch (error) {
      return validationErrorTuple(error);
    }
    await ScriptWhitelistManager.SetScope(ValidID, ValidScope);
    // Re-push the catalog (from cache — no disk reload, fingerprint unchanged so
    // no redundant deployment) so every UI immediately reflects the restriction.
    BroadcastManager.emit('ScriptsUpdated');
    return [null, true];
  });

  // Script Manager: persist a new display order (drag-and-drop reordering).
  RPC.handle('Scripts:SetOrder', async (_Event: unknown, OrderedIDs: unknown) => {
    try {
      OrderedIDs = IPCValidation.ScriptOrderList(OrderedIDs);
    } catch (error) {
      return validationErrorTuple(error);
    }
    const [Err] = await ScriptManager.SetOrder(OrderedIDs);
    if (Err) return [Err, null];
    return [null, true];
  });

  // Script Manager: delete a script folder from disk.
  RPC.handle('Scripts:Delete', async (_Event: unknown, ID: unknown) => {
    let ValidID;
    try {
      ValidID = IPCValidation.ScriptFolderID(ID);
    } catch (error) {
      return validationErrorTuple(error);
    }
    const [Err] = await ScriptManager.Delete(ValidID);
    if (Err) return [Err, null];
    // Drop any whitelist row for the now-deleted script (no-op if unrestricted).
    await ScriptWhitelistManager.DeleteForScript(ValidID);
    return [null, true];
  });

  // Script Manager: create a new blank script (placeholder config + empty
  // per-platform script files, not yet runnable). Returns the new script ID.
  RPC.handle('Scripts:Create', async () => {
    const [Err, Data] = await ScriptManager.CreateBlank();
    if (Err) return [Err, null];
    if (!Data) return ['Failed to create script', null];
    return [null, { id: Data.id }];
  });

  // Script Manager: list the available sample scripts (templates) fetched from
  // the public ShowTrak SampleScripts repository.
  RPC.handle('Scripts:GetSampleList', async () => {
    try {
      const List = await SampleScriptsManager.GetSampleList();
      return [null, List];
    } catch (err) {
      Logger.error('Failed to list sample scripts:', err);
      return ['Failed to load sample scripts', null];
    }
  });

  // Script Manager: force a refresh of the sample scripts catalog.
  RPC.handle('Scripts:RefreshSamples', async () => {
    const Result = await SampleScriptsManager.Refresh();
    if (!Result.ok) return [Result.error || 'Failed to refresh sample scripts', null];
    const List = await SampleScriptsManager.GetSampleList();
    return [null, List];
  });

  // Script Manager: create a new script from a sample template. Requires a
  // DesiredID that does not collide with an existing script.
  RPC.handle('Scripts:CreateFromTemplate', async (_Event: unknown, SampleID: unknown, DesiredID: unknown) => {
    let ValidSampleID;
    try {
      ValidSampleID = IPCValidation.ScriptSampleID(SampleID);
    } catch (error) {
      return validationErrorTuple(error);
    }
    const Sample = await SampleScriptsManager.GetSample(ValidSampleID);
    if (!Sample) return ['Template not found', null];
    const Result = await ScriptManager.CreateFromTemplate(Sample, DesiredID);
    if (!Result.ok) {
      const Message =
        Result.errors && Result.errors[0] ? Result.errors[0] : 'Failed to create script';
      return [Message, Result];
    }
    return [null, Result];
  });

  RPC.handle('OpenScriptsFolder', async (_event: unknown) => {
    const LogsPath = AppDataManager.GetScriptsDirectory();
    Logger.log('Opening scrippts folder:', LogsPath);
    // Cross-platform and properly quoted
    await shell.openPath(LogsPath);
    return;
  });

  RPC.handle('Scripts:OpenFolder', async (_event: unknown, ID: unknown) => {
    let FolderID: string;
    try {
      // ScriptFolderID rejects path separators and "..", so the join below can
      // never escape the scripts directory.
      FolderID = IPCValidation.ScriptFolderID(ID);
    } catch {
      return;
    }
    const ScriptsDirectory = AppDataManager.GetScriptsDirectory();
    const ScriptFolderPath = path.join(ScriptsDirectory, FolderID);
    Logger.log('Opening script folder:', ScriptFolderPath);
    await shell.openPath(ScriptFolderPath);
  });

  RPC.handle('Scripts:OpenFile', async (_event: unknown, ID: unknown, RelativeFilePath: unknown) => {
    const [PathErr, TargetFilePath] = resolveContainedScriptFile(
      AppDataManager.GetScriptsDirectory(),
      ID,
      RelativeFilePath
    );
    if (PathErr || !TargetFilePath) return [PathErr || 'Invalid file path', null];

    if (!fs.existsSync(TargetFilePath)) return ['File not found', null];
    const stat = fs.statSync(TargetFilePath);
    if (!stat.isFile()) return ['Path is not a file', null];

    Logger.log('Opening script file:', TargetFilePath);
    const OpenErr = await openFileWithWorkspaceEditor(TargetFilePath);
    if (OpenErr) return [OpenErr, null];
    return [null, true];
  });

  RPC.handle('Scripts:RunLocalFile', async (_event: unknown, ID: unknown, RelativeFilePath: unknown) => {
    const [PathErr, TargetFilePath] = resolveContainedScriptFile(
      AppDataManager.GetScriptsDirectory(),
      ID,
      RelativeFilePath
    );
    if (PathErr || !TargetFilePath) return [PathErr || 'Invalid file path', null];

    // resolveContainedScriptFile above already proved ID resolves to a contained
    // script folder, so it is a usable folder/script id string here.
    const Script = await ScriptManager.Get(String(ID));
    if (!Script || !Script.Platforms) return ['Script not found', null];

    const PlatformKey = getLocalPlatformKey();
    const MappedFile = normalizeRelativePathForCompare(Script.Platforms[PlatformKey]);
    const PlatformArgumentString =
      Script && Script.Arguments && typeof Script.Arguments[PlatformKey] === 'string'
        ? Script.Arguments[PlatformKey]
        : '';
    const PlatformArgs = parseArgumentString(PlatformArgumentString);
    const RequestedFile = normalizeRelativePathForCompare(RelativeFilePath);
    if (!MappedFile) {
      return [`No ${PlatformKey} executable is configured for this script`, null];
    }
    if (RequestedFile !== MappedFile) {
      return [`Only the mapped ${PlatformKey} executable can be run locally`, null];
    }

    if (!fs.existsSync(TargetFilePath)) return ['File not found', null];
    const stat = fs.statSync(TargetFilePath);
    if (!stat.isFile()) return ['Path is not a file', null];

    Logger.log(`Running local script (${PlatformKey}):`, TargetFilePath);
    const RunErr = await runLocalScriptFile(TargetFilePath, PlatformArgs);
    if (RunErr) return [RunErr, null];
    return [null, true];
  });
}

export { register };
