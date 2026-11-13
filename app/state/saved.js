// ../pub-game-store/native/state/saved.js
// reconstructed from the esbuild bundle in eboot.bin

import { useEffect, useState } from 'react';
import { SAVED_FILES, isRecord, isStringList, readJSON } from './read-json.js';
import { DATA_DIR, backupDir, readPath } from './data-dir.js';
import { FileSystem } from '@ps5-react/core';

  var dir = DATA_DIR;
  function loadList(name, what) {
    const valid = SAVED_FILES[name] ?? isStringList;
    return readJSON(
      FileSystem,
      readPath(name),
      valid === isRecord ? {} : [],
      valid,
      (message) => console.log(`jobeeslair: ${what}: ${message}`)
    );
  }
  // MODIFIED (glibren.4): debrid.json (the TorBox/AllDebrid keys) and the files the gamer fills in by hand are written
  // through to the disk too. Without it, a console that froze or lost power soon after a save (debrid.json is saved
  // again on every TorBox check) came back with the file empty or gone, and the key had to be entered again.
  var SYNCED = /* @__PURE__ */ new Set(["settings.json", "wishlist.json", "debrid.json", "feeds.json", "feed-mirrors.json", "themes.json"]);
  // MODIFIED (glibren.8): those same files also get a copy on /data (data-dir.js backupDir), which an uninstall
  // of the title does not take with its download0; readPath reads it when the data folder came back empty.
  // The copy is written on its own: a full or missing download0 does not keep it from being saved.
  // Fase 7 (state/settings-sync.js): cada gravacao do settings.json avisa o sincronizador (antes -> depois), que manda a
  // mudanca ao payload. Sem ele (testes, ou antes de o modulo carregar), nada muda.
  var settingsHook = null;
  function setSettingsHook(hook) {
    settingsHook = typeof hook === "function" ? hook : null;
  }
  function saveList(name, what, list) {
    const hook = name === "settings.json" ? settingsHook : null;
    const before = hook ? loadList(name, what) : null;
    writeList(name, what, list);
    if (!hook) return;
    try {
      hook(before, list);
    } catch (error2) {
      console.log(`jobeeslair: ${what}: settings sync not told: ${error2.message}`);
    }
  }
  function writeList(name, what, list) {
    const text = JSON.stringify(list);
    const sync = SYNCED.has(name);
    try {
      FileSystem.mkdir(dir, { recursive: true });
      FileSystem.writeFile(`${dir}/${name}.tmp`, text, { sync });
      FileSystem.rename(`${dir}/${name}.tmp`, `${dir}/${name}`);
    } catch (error2) {
      console.log(`jobeeslair: ${what} not saved: ${error2.message}`);
    }
    const backup = sync ? backupDir() : null;
    if (!backup) return;
    try {
      FileSystem.mkdir(backup, { recursive: true });
      FileSystem.writeFile(`${backup}/${name}.tmp`, text, { sync: true });
      FileSystem.rename(`${backup}/${name}.tmp`, `${backup}/${name}`);
    } catch (error2) {
      console.log(`jobeeslair: ${what} not copied to ${backup}: ${error2.message}`);
    }
  }
  function savedList(name, what) {
    let list = loadList(name, what);
    const listeners4 = /* @__PURE__ */ new Set();
    return {
      get: () => list,
      set: (next) => {
        list = next;
        saveList(name, what, list);
        for (const listener of listeners4) listener(list);
      },
      useList: () => {
        const [value, setValue] = (0, useState)(list);
        (0, useEffect)(() => {
          listeners4.add(setValue);
          setValue(list);
          return () => {
            listeners4.delete(setValue);
          };
        }, []);
        return value;
      }
    };
  }

export { loadList, saveList, savedList, setSettingsHook };
