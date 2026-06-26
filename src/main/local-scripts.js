// Local script helpers (main process).
//
// Pure/self-contained utilities for resolving and running script files on the
// host OS, plus small path/version normalizers. Extracted from main.js so they
// can be unit-tested in isolation. Behavior is identical to the original inline
// implementations.
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

const { CreateLogger } = require('../Modules/Logger');
const Logger = CreateLogger('LocalScripts');

// Normalize a relative path for comparison (forward slashes, no leading "./").
function normalizeRelativePathForCompare(value) {
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
function parseArgumentString(value) {
  const input = String(value || '').trim();
  if (!input) return [];

  const args = [];
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
function normalizeVersionToken(value) {
  return String(value || '')
    .trim()
    .replace(/^v/i, '')
    .toLowerCase();
}

// Resolve the command + args used to execute a script file based on its
// extension and the host platform.
function resolveLocalScriptLauncher(scriptPath) {
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
function runLocalScriptFile(scriptPath, extraArgs = []) {
  return new Promise((resolve) => {
    const launcher = resolveLocalScriptLauncher(scriptPath);

    if (process.platform !== 'win32') {
      try {
        fs.chmodSync(scriptPath, 0o755);
      } catch (chmodError) {
        Logger.warn(`Unable to set executable bit on ${scriptPath}: ${chmodError.message}`);
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
      (error, stdout, stderr) => {
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

module.exports = {
  normalizeRelativePathForCompare,
  getLocalPlatformKey,
  parseArgumentString,
  normalizeVersionToken,
  resolveLocalScriptLauncher,
  runLocalScriptFile,
};
