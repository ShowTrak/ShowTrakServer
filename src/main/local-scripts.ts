// Local script helpers (main process).
//
// Utilities for resolving and running script files on the host OS, plus small
// path/version normalizers. The launcher table and the path check are the
// Client's own (@showtrak/protocol/runtime), so a script the operator runs on
// this machine runs the way it does when dispatched to a client.
import path from 'path';
import fs from 'fs';
import { execFile } from 'child_process';

import {
  IsSafeScriptID,
  NormalizeScriptRelativePath,
  ResolveScriptFile,
  ResolveScriptLauncher,
} from '@showtrak/protocol/runtime';
import { CreateLogger } from '../Modules/Logger';

const Logger = CreateLogger('LocalScripts');

// Resolve a script-relative file path to an absolute path while enforcing that
// it stays inside the script's own folder. This is the single traversal guard
// shared by Scripts:OpenFile and Scripts:RunLocalFile, and it is the Client's
// guard too (@showtrak/protocol/runtime ResolveScriptFile): the ID must be one
// safe folder name, and the path, normalized the way the Client normalizes it,
// must have no `..` at all and land strictly inside that folder. Returns the
// standard `[Err, TargetFilePath]` tuple; existence/stat checks stay with the
// caller.
function resolveContainedScriptFile(
  scriptsDirectory: string,
  ID: unknown,
  RelativeFilePath: unknown
): [string, null] | [null, string] {
  if (!IsSafeScriptID(ID)) return ['Invalid script ID', null];
  const TargetFilePath = ResolveScriptFile(scriptsDirectory, ID, RelativeFilePath);
  if (!TargetFilePath) return ['Invalid file path', null];
  return [null, TargetFilePath];
}

// Normalize a relative path for comparison (forward slashes, no leading "./").
function normalizeRelativePathForCompare(value: unknown) {
  return NormalizeScriptRelativePath(value);
}

// Map the running platform to the ShowTrak platform key used in script configs.
function getLocalPlatformKey() {
  if (process.platform === 'win32') return 'Windows';
  if (process.platform === 'darwin') return 'macOS';
  return 'Linux';
}

// Strip a leading "v" and lower-case a version token for loose comparison.
function normalizeVersionToken(value: unknown) {
  return String(value || '')
    .trim()
    .replace(/^v/i, '')
    .toLowerCase();
}

// Resolve the command + args used to execute a script file based on its
// extension and the host platform. The Client runs dispatched scripts with the
// same table (@showtrak/protocol/runtime ResolveScriptLauncher).
function resolveLocalScriptLauncher(scriptPath: string) {
  return ResolveScriptLauncher(scriptPath);
}

// Execute a local script file, resolving to null on success or an error message
// string on failure.
function runLocalScriptFile(scriptPath: string, extraArgs: string[] = []) {
  return new Promise((resolve) => {
    const launcher = resolveLocalScriptLauncher(scriptPath);

    if (process.platform !== 'win32') {
      try {
        fs.chmodSync(scriptPath, 0o755);
      } catch (chmodError: unknown) {
        const chmodMessage = chmodError instanceof Error ? chmodError.message : String(chmodError);
        Logger.warn(`Failed to set executable bit on ${scriptPath}: ${chmodMessage}`);
      }
    }

    execFile(
      launcher.command,
      launcher.args.concat(extraArgs),
      {
        cwd: path.dirname(scriptPath),
        windowsHide: true,
        maxBuffer: 10 * 1024 * 1024,
      },
      (error: Error | null, stdout: string, stderr: string) => {
        if (error) {
          const message = (stderr || '').trim() || error.message || 'Script execution failed';
          resolve(message);
          return;
        }
        Logger.success(`Local script completed: ${scriptPath}`);
        if ((stdout || '').trim()) {
          Logger.log(`Local script output: ${(stdout || '').trim()}`);
        }
        resolve(null);
      }
    );
  });
}

export {
  resolveContainedScriptFile,
  normalizeRelativePathForCompare,
  getLocalPlatformKey,
  normalizeVersionToken,
  resolveLocalScriptLauncher,
  runLocalScriptFile,
};
