// Show file associations (main process): opening a .ShowTrak file from the
// operating system, by double-clicking it or with "Open With".
//
// @showtrak/protocol/electron-main's CreateShowFileAssociations, configured for
// ShowTrak Server's show file. macOS delivers the file through 'open-file'
// (main.ts; the document type is declared in Info.plist, CFBundleDocumentTypes
// in forge.config.ts), Windows on the command line, and Squirrel's install
// hooks (./entry.ts) register the association per user.
//
// Requests are held here rather than acted on: the renderer takes the latest
// one through Show:OpenRequested once it is ready for it, so it goes through the
// same open, upgrade and save prompts as File > Open. ./entry.ts loads this
// before anything else (the Squirrel hooks run before the app quits on an
// install event), so it must not import any manager.
import { CreateShowFileAssociations } from '@showtrak/protocol/electron-main';
import type { ShowFileRequest, ShowFileRequestSource } from '@showtrak/protocol';

// A request's Source, Launch: the file started ShowTrak Server, so it replaces
// the last session's show without asking (unless that has unsaved changes).
// Running: the operator opened a file while a show was already up, which asks
// first.
export type { ShowFileRequest, ShowFileRequestSource };

export { SquirrelStubExecutable } from '@showtrak/protocol/electron-main';

export const {
  SHOW_FILE_EXTENSION,
  WINDOWS_PROG_ID,
  IsShowFilePath,
  ShowFileFromArgv,
  RequestShowFileOpen,
  TakeShowFileRequest,
  OnShowFileRequest,
  ResetShowFileRequestsForTests,
  WindowsAssociationCommands,
  HandleSquirrelFileAssociations,
} = CreateShowFileAssociations({
  Extension: 'showtrak',
  WindowsProgId: 'ShowTrak.ShowFile',
  WindowsTypeName: 'ShowTrak Show File',
});
