// Show file associations (main process): opening a .ShowTrak file from the
// operating system, by double-clicking it or with "Open With".
//
// How a file reaches us depends on the platform:
// - macOS: Launch Services sends an 'open-file' event, both when the file
//   launches the app (the event fires before 'ready') and when the app is
//   already running. The document type itself is declared in Info.plist (see
//   CFBundleDocumentTypes in forge.config.ts).
// - Windows: the path is a command-line argument, of this process when the file
//   launched the app, or of a second instance (which hands its arguments over
//   through 'second-instance' and exits) when it was already running. Squirrel
//   has no notion of file associations, so the registry keys are written by the
//   install/update hooks below and removed again on uninstall.
//
// Requests are held here rather than acted on: the renderer takes the latest
// one through Show:OpenRequested once it is ready for it, so it goes through the
// same open, upgrade and save prompts as File > Open. This module loads before
// anything else in main.ts (the Squirrel hooks run before the app quits on an
// install event), so it must not import any manager.
import path from 'path';
import fs from 'fs';
import { spawnSync } from 'child_process';
import type { ShowFileRequest, ShowFileRequestSource } from '@showtrak/protocol';

export const SHOW_FILE_EXTENSION = 'showtrak';

// --- Requests ----------------------------------------------------------------

// A request is the protocol's ShowFileRequest. Its Source, Launch: the file
// started ShowTrak Server, so it replaces the last session's show without asking
// (unless that has unsaved changes). Running: the operator opened a file while a
// show was already up, which asks first.
export type { ShowFileRequest, ShowFileRequestSource };

// Only the latest request counts: one show is open at a time, so opening
// several files at once ends up on the last one anyway.
let Pending: ShowFileRequest | null = null;
// Set once the renderer first takes a request. Until then any request is part
// of the launch.
let RendererStarted = false;
let OnRequestListener: (() => void) | null = null;

export function IsShowFilePath(Value: unknown): Value is string {
  return (
    typeof Value === 'string' &&
    !Value.startsWith('-') &&
    path.extname(Value).toLowerCase() === `.${SHOW_FILE_EXTENSION}`
  );
}

// The show file named on a command line, if any: the last argument that is an
// existing .ShowTrak file. Relative paths resolve against WorkingDirectory (the
// second instance's, which can differ from ours). Switches, Squirrel's included,
// and anything else are ignored.
export function ShowFileFromArgv(
  Argv: readonly unknown[],
  WorkingDirectory: string = process.cwd()
): string | null {
  let Found: string | null = null;
  for (const Arg of Argv) {
    if (!IsShowFilePath(Arg)) continue;
    const Resolved = path.resolve(WorkingDirectory, Arg);
    try {
      if (fs.statSync(Resolved).isFile()) Found = Resolved;
    } catch {
      /* intentional: a path that does not exist is not a file to open */
    }
  }
  return Found;
}

// Hold FilePath for the renderer and tell it there is one waiting. Before the
// renderer has started this is a no-op beyond the hold: it takes the request
// itself during start-up.
export function RequestShowFileOpen(FilePath: string): void {
  Pending = { FilePath, Source: RendererStarted ? 'Running' : 'Launch' };
  if (RendererStarted && OnRequestListener) {
    try {
      OnRequestListener();
    } catch {
      /* intentional: notifying is best-effort, the request stays held */
    }
  }
}

// Take (and clear) the held request. The first call marks the renderer as
// started, so later requests ask before replacing the open show.
export function TakeShowFileRequest(): ShowFileRequest | null {
  RendererStarted = true;
  const Request = Pending;
  Pending = null;
  return Request;
}

// Called whenever a request arrives once the renderer is running (main.ts
// focuses the window and pushes ShowOpenRequested).
export function OnShowFileRequest(Listener: () => void): void {
  OnRequestListener = Listener;
}

// Test hook: back to a fresh launch.
export function ResetShowFileRequestsForTests(): void {
  Pending = null;
  RendererStarted = false;
  OnRequestListener = null;
}

// --- Windows registry (Squirrel install hooks) --------------------------------

export const WINDOWS_PROG_ID = 'ShowTrak.ShowFile';
const WINDOWS_TYPE_NAME = 'ShowTrak Show File';
const CLASSES_KEY = 'HKCU\\Software\\Classes';

// Squirrel installs each version into <root>\app-<version>\ and keeps a stub
// executable of the same name in <root> that starts the newest one, passing its
// arguments through. The association points at the stub, so it survives updates
// (which delete the old app-<version> folder).
export function SquirrelStubExecutable(ExecPath: string): string {
  return path.resolve(path.dirname(ExecPath), '..', path.basename(ExecPath));
}

// The reg.exe invocations that register (or remove) the association. Per-user
// (HKCU), as Squirrel installs per-user, so no elevation is needed.
export function WindowsAssociationCommands(
  Action: 'register' | 'unregister',
  StubPath: string
): string[][] {
  const ExtensionKey = `${CLASSES_KEY}\\.${SHOW_FILE_EXTENSION}`;
  const ProgIdKey = `${CLASSES_KEY}\\${WINDOWS_PROG_ID}`;
  if (Action === 'unregister') {
    return [
      ['delete', ProgIdKey, '/f'],
      ['delete', `${ExtensionKey}\\OpenWithProgids`, '/v', WINDOWS_PROG_ID, '/f'],
    ];
  }
  return [
    ['add', ExtensionKey, '/ve', '/d', WINDOWS_PROG_ID, '/f'],
    ['add', `${ExtensionKey}\\OpenWithProgids`, '/v', WINDOWS_PROG_ID, '/t', 'REG_NONE', '/f'],
    ['add', ProgIdKey, '/ve', '/d', WINDOWS_TYPE_NAME, '/f'],
    ['add', `${ProgIdKey}\\DefaultIcon`, '/ve', '/d', `"${StubPath}",0`, '/f'],
    ['add', `${ProgIdKey}\\shell\\open\\command`, '/ve', '/d', `"${StubPath}" "%1"`, '/f'],
  ];
}

type RegRunner = (Args: string[]) => { status: number | null };

const RunReg: RegRunner = (Args) =>
  spawnSync('reg.exe', Args, { windowsHide: true, stdio: 'ignore', timeout: 5000 });

// Whether .showtrak's default handler is still ours. Uninstalling leaves the
// extension alone when something else has since claimed it.
function ExtensionPointsAtUs(Run: (Args: string[]) => { status: number | null; stdout?: string }) {
  const Result = Run(['query', `${CLASSES_KEY}\\.${SHOW_FILE_EXTENSION}`, '/ve']);
  return Result.status === 0 && String(Result.stdout || '').includes(WINDOWS_PROG_ID);
}

// Run from main.ts before electron-squirrel-startup handles (and quits on) the
// same events. Synchronous, as Squirrel waits on the hook process and the app
// quits straight after. Returns the action taken, for logging and tests.
export function HandleSquirrelFileAssociations(
  Argv: readonly string[] = process.argv,
  Options: { Platform?: string; ExecPath?: string; Run?: RegRunner } = {}
): 'register' | 'unregister' | null {
  if ((Options.Platform ?? process.platform) !== 'win32') return null;
  const Event = Argv[1];
  const Action =
    Event === '--squirrel-install' || Event === '--squirrel-updated'
      ? 'register'
      : Event === '--squirrel-uninstall'
        ? 'unregister'
        : null;
  if (!Action) return null;
  const Run = Options.Run ?? RunReg;
  const Stub = SquirrelStubExecutable(Options.ExecPath ?? process.execPath);
  try {
    for (const Args of WindowsAssociationCommands(Action, Stub)) Run(Args);
    if (Action === 'unregister') {
      const Query = (Args: string[]) =>
        Options.Run
          ? Options.Run(Args)
          : spawnSync('reg.exe', Args, { windowsHide: true, encoding: 'utf8', timeout: 5000 });
      if (ExtensionPointsAtUs(Query)) {
        Run(['delete', `${CLASSES_KEY}\\.${SHOW_FILE_EXTENSION}`, '/ve', '/f']);
      }
    }
  } catch {
    /* intentional: a failed association must never fail the install itself */
  }
  return Action;
}
