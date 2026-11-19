// The main bundle's entry (scripts/build-main.js), loaded by ./boot.ts.
//
// On Windows, Squirrel runs the app with --squirrel-install, -updated,
// -uninstall or -obsolete around an install or update. Those runs only register
// (or remove) the .ShowTrak file association and the shortcuts, then quit. They
// must stop here, before ./main loads: past this point a Squirrel run would bind
// the HTTP, Socket.IO and OSC ports (main's modules do that as they load), take
// the single-instance lock (so the real first launch after an install could
// find it held and quit), open the database, and, while the app is already
// running, hand its arguments to the running copy, which brings its window to
// the front in the middle of a show on every background update.
import { HandleSquirrelFileAssociations } from './main/file-associations';

const { app } = require('electron/main') as typeof import('electron/main');

HandleSquirrelFileAssociations();
if (require('electron-squirrel-startup')) {
  app.quit();
} else {
  require('./main');
}
