// Where Jobee'sLair keeps its files (settings, PIN, feeds, theme, download queue) in the console's data
// storage. Early builds kept them in a folder named "overdrive"; those files are still read until the
// first save into the current folder, so renaming the folder loses nothing.
//
// MODIFIED (glibren.8): /download0 is the title's own disk image (/user/download/<ID>/download0.dat). It goes
// with the title: when the console or ShadowMount+ uninstalls PPSA99471 and installs it again (a source
// deleted and copied back, auto_remove_missing_games, Remove in ShadowMount+'s page) it comes back empty, and
// a launch whose download0 fails the write proof keeps its data in /data/ps5-react/<ID> instead
// (ps5-react filesystem_access.cpp). Either way the app started as on its first run. On the PS5, saved.js
// also keeps a copy of the files the gamer fills in by hand in BACKUP_DIR, on /data, which no uninstall
// touches; a file missing from the current and the legacy folder is read from there, and the next save puts
// it back in place.

import { FileSystem, Platform } from '@ps5-react/core';

  var DATA_DIR = `${FileSystem.dataDir}/JobeesLair`;
  var LEGACY_DATA_DIR = `${FileSystem.dataDir}/overdrive`;
  var BACKUP_DIR = "/data/JobeesLair/saved";
  // Only on the console: elsewhere the data folder is not lost with an install.
  var backupDir = () => Platform.OS === "ps5" ? BACKUP_DIR : null;
  var exists = (path) => {
    try {
      return FileSystem.exists(path);
    } catch {
      return false;
    }
  };
  var restored = /* @__PURE__ */ new Set();
  // The path to read a file from: the current folder's, else an older build's, else the copy on /data, else
  // the current one.
  function readPath(name) {
    const current = `${DATA_DIR}/${name}`;
    if (exists(current)) return current;
    const legacy = `${LEGACY_DATA_DIR}/${name}`;
    if (exists(legacy)) return legacy;
    const backup = backupDir();
    if (backup && exists(`${backup}/${name}`)) {
      if (!restored.has(name)) {
        restored.add(name);
        console.log(`jobeeslair: ${name} is not in ${DATA_DIR}; read from the copy in ${backup}`);
      }
      return `${backup}/${name}`;
    }
    return current;
  }

export { BACKUP_DIR, DATA_DIR, LEGACY_DATA_DIR, backupDir, readPath };
