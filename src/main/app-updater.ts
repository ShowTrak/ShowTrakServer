// ShowTrak Server's self-updater (main process): the kit's, pointed at this
// app's releases.
//
// The flows themselves (the simulated check of an unpackaged run, Electron's
// Squirrel updater on Windows, electron-updater elsewhere, the Stable and Beta
// channels, automatic background checks) are @showtrak/protocol/electron-main's
// CreateAppUpdater, shared with ShowTrak Timers. Status goes to the renderer on
// 'AppUpdate:Status'; Register() wires 'AppUpdate:Check' and
// 'AppUpdate:Install' (see ./registrars/updates).
import { CreateAppUpdater } from '@showtrak/protocol/electron-main';
import { CreateLogger } from '../Modules/Logger';

export const Manager = CreateAppUpdater({
  Owner: 'ShowTrak',
  Repo: 'ShowTrakServer',
  UserAgent: 'ShowTrakServer',
  TempConfigName: 'showtrak-app-update.yml',
  Logger: CreateLogger('AppUpdater'),
});
