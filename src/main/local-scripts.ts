// Local script helpers (main process).
//
// Pure/self-contained utilities for resolving and running script files on the
// host OS, plus small path/version normalizers. Extracted from main.js so they
// can be unit-tested in isolation. Behavior is identical to the original inline
// implementations.
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

import { CreateLogger } from '../Modules/Logger';

const Logger = CreateLogger('LocalScripts');

// Resolve a script-relative file path to an absolute path while enforcing that
// it stays inside the script's own folder. This is the single traversal guard
// shared by Scripts:OpenFile and Scripts:RunLocalFile. It rejects folder IDs
// that contain a path separator or "..", absolute relative paths, and any
// resolved path that escapes the script folder. Returns the standard
// `[Err, TargetFilePath]` tuple; existence/stat checks stay with the caller.
function resolveContainedScriptFile(
  scriptsDirectory: string,
  ID: unknown,
  RelativeFilePath: unknown
): [string, null] | [null, string] {
  if (typeof ID !== 'string' || !ID.trim()) return ['Invalid script ID', null];
  if (typeof RelativeFilePath !== 'string' || !RelativeFilePath.trim()) {
    return ['Invalid file path', null];
  }
  if (ID.includes('..') || ID.includes('/') || ID.includes('\\')) {
    return ['Invalid script ID', null];
  }
  if (path.isAbsolute(RelativeFilePath)) return ['Invalid file path', null];

  const ScriptFolderPath = path.resolve(scriptsDirectory, ID);
  const TargetFilePath = path.resolve(ScriptFolderPath, RelativeFilePath);
  const ScriptFolderPrefix = ScriptFolderPath.endsWith(path.sep)
    ? ScriptFolderPath
    : `${ScriptFolderPath}${path.sep}`;
  if (TargetFilePath !== ScriptFolderPath && !TargetFilePath.startsWith(ScriptFolderPrefix)) {
    return ['Invalid file path', null];
  }
  return [null, TargetFilePath];
}

// Normalize a relative path for comparison (forward slashes, no leading "./").
function normalizeRelativePathForCompare(value: unknown) {
  return String(value || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '');
}

// Map the running platform to the ShowTrak platform key used in script configs.
function getLocalPlatformKey() {
  if (process.platform === 'win32') return 'Windows';
  if (process.platform === 'darwin') return 'macOS';
  return 'Linux';
}

// Split a shell-style argument string into argv, honouring single/double quotes
// and backslash escapes.
function parseArgumentString(value: unknown) {
  const input = String(value || '').trim();
  if (!input) return [];

  const args: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let escaping = false;

  const pushCurrent = () => {
    if (current.length > 0) {
      args.push(current);
      current = '';
    }
  };

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];

    if (escaping) {
      current += ch;
      escaping = false;
      continue;
    }
    if (ch === '\\') {
      escaping = true;
      continue;
    }

    if (inSingle) {
      if (ch === "'") inSingle = false;
      else current += ch;
      continue;
    }

    if (inDouble) {
      if (ch === '"') inDouble = false;
      else current += ch;
      continue;
    }

    if (ch === "'") {
      inSingle = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      continue;
    }

    if (/\s/.test(ch)) {
      pushCurrent();
      continue;
    }

    current += ch;
  }

  if (escaping) current += '\\';
  pushCurrent();
  return args;
}

// Strip a leading "v" and lower-case a version token for loose comparison.
function normalizeVersionToken(value: unknown) {
  return String(value || '')
    .trim()
    .replace(/^v/i, '')
    .toLowerCase();
}

// Resolve the command + args used to execute a script file based on its
// extension and the host platform.
function resolveLocalScriptLauncher(scriptPath: string) {
  const extension = path.extname(scriptPath).toLowerCase();

  if (process.platform === 'win32') {
    switch (extension) {
      case '.bat':
      case '.cmd':
        return { command: 'cmd.exe', args: ['/c', scriptPath] };
      case '.ps1':
        return {
          command: 'powershell.exe',
          args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
        };
      case '.exe':
        return { command: scriptPath, args: [] };
      default:
        return { command: 'cmd.exe', args: ['/c', scriptPath] };
    }
  }

  switch (extension) {
    case '.sh':
    case '.command':
      return { command: '/bin/sh', args: [scriptPath] };
    case '.bash':
    case '.zsh':
      return { command: '/bin/bash', args: [scriptPath] };
    case '.py':
      return { command: 'python3', args: [scriptPath] };
    case '.js':
      return { command: 'node', args: [scriptPath] };
    default:
      return { command: scriptPath, args: [] };
  }
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
        Logger.warn(`Unable to set executable bit on ${scriptPath}: ${chmodMessage}`);
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
  parseArgumentString,
  normalizeVersionToken,
  resolveLocalScriptLauncher,
  runLocalScriptFile,
};
