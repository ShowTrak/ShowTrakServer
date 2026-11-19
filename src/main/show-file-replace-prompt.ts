// Whether a show file opened from the operating system (see ./file-associations)
// may replace the show that is open now.
//
// A double-click in Finder or Explorer is much easier to make by accident than
// File > Open, and it swaps out the show every client and monitor is running
// against. So:
// - Unsaved changes are never lost: with autosave on they are saved first, as
//   on quit; otherwise the operator is asked to save them (or not, or cancel).
// - A file opened while ShowTrak was already running asks before replacing the
//   open show, even with nothing to save.
// - A file that launched ShowTrak opens straight away when there is nothing to
//   save: launching with it is the operator asking for exactly that show.
import path from 'path';
import type { ShowFileRequest } from './file-associations';

interface MessageBoxOptions {
  type: 'question';
  buttons: string[];
  defaultId: number;
  cancelId: number;
  noLink: boolean;
  message: string;
  detail: string;
}

export interface ReplacePromptDeps {
  GetCurrentFilePath(): string | null;
  HasUnsavedChanges(): Promise<boolean>;
  // Data in the working database with no show file behind it (a show from
  // before show files existed).
  HasUnsavedWorkingData(): Promise<boolean>;
  IsAutosaveEnabled(): Promise<boolean>;
  Save(FilePath: string): Promise<[unknown, unknown]>;
  // A location for a show that has never been saved; null when cancelled.
  PickSavePath(): Promise<string | null>;
  ShowMessageBox(Options: MessageBoxOptions): Promise<number>;
  ShowError(Title: string, Message: string): void;
  OnSaved(): void;
}

async function SaveCurrent(Deps: ReplacePromptDeps, CurrentPath: string | null): Promise<boolean> {
  const SavePath = CurrentPath || (await Deps.PickSavePath());
  if (!SavePath) return false;
  const [Err] = await Deps.Save(SavePath);
  if (Err) {
    Deps.ShowError('Failed to Save Show', String(Err));
    return false;
  }
  Deps.OnSaved();
  return true;
}

export async function ConfirmShowFileReplace(
  Request: ShowFileRequest,
  Deps: ReplacePromptDeps
): Promise<boolean> {
  const CurrentPath = Deps.GetCurrentFilePath();
  const NewName = path.basename(Request.FilePath);
  const Unsaved = CurrentPath ? await Deps.HasUnsavedChanges() : await Deps.HasUnsavedWorkingData();

  if (Unsaved) {
    if (CurrentPath && (await Deps.IsAutosaveEnabled())) {
      if (!(await SaveCurrent(Deps, CurrentPath))) return false;
    } else {
      const Response = await Deps.ShowMessageBox({
        type: 'question',
        buttons: ['Save', "Don't Save", 'Cancel'],
        defaultId: 0,
        cancelId: 2,
        noLink: true,
        message: 'You have unsaved show changes.',
        detail: CurrentPath
          ? `Save changes to ${path.basename(CurrentPath)} before opening ${NewName}?`
          : `Save this show before opening ${NewName}?`,
      });
      if (Response === 2) return false;
      if (Response === 0 && !(await SaveCurrent(Deps, CurrentPath))) return false;
      // The operator has answered for the open show; don't ask a second time.
      return true;
    }
  }

  if (!CurrentPath || Request.Source === 'Launch') return true;
  const Response = await Deps.ShowMessageBox({
    type: 'question',
    buttons: ['Open', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
    message: `Open ${NewName}?`,
    detail: `This closes ${path.basename(CurrentPath)}, the show that is running now.`,
  });
  return Response === 0;
}
