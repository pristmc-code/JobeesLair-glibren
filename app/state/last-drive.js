// The drive the last download went to (0.5.5, GitHub issue #2): a game page starts on it while it is there and
// has room, so a player who keeps every download on an extended drive doesn't switch drives each time. Kept in
// settings.json beside the other settings; set when a download is queued from a game page.
// MODIFIED (glibren.6): a default drive the gamer picks in Settings > Downloads (or in "Search TorBox"), kept as
// settings.json's "defaultDrive": while it is plugged in and has room, every download starts on it; without one
// ("Automatic") the last drive used, as before.

import { useEffect, useState } from 'react';
import { loadList, saveList } from './saved.js';

  var SETTINGS = "settings.json";
  var value;
  function lastDrive() {
    if (value === void 0) {
      const saved = loadList(SETTINGS, "settings").lastDrive;
      value = typeof saved === "string" && saved ? saved : null;
    }
    return value;
  }
  function rememberDrive(root2) {
    if (!root2 || root2 === lastDrive()) return;
    value = root2;
    saveList(SETTINGS, "settings", { ...loadList(SETTINGS, "settings"), lastDrive: root2 });
  }
  var chosen;
  var listeners = /* @__PURE__ */ new Set();
  /** glibren.6: the default drive (a storage root such as "/data" or "/mnt/ext0"), or null for Automatic. */
  function defaultDrive() {
    if (chosen === void 0) {
      const saved = loadList(SETTINGS, "settings").defaultDrive;
      chosen = typeof saved === "string" && saved.startsWith("/") ? saved : null;
    }
    return chosen;
  }
  /** glibren.6: sets the default drive (null: Automatic, the last drive used). */
  function setDefaultDrive(root2) {
    const next = typeof root2 === "string" && root2.startsWith("/") ? root2 : null;
    if (next === defaultDrive()) return;
    chosen = next;
    const { defaultDrive: _old, ...settings } = loadList(SETTINGS, "settings");
    saveList(SETTINGS, "settings", next ? { ...settings, defaultDrive: next } : settings);
    for (const listener of listeners) listener(next);
  }
  /** glibren.6: the default drive, re-rendering when it changes. */
  function useDefaultDrive() {
    const [current, setCurrent] = useState(defaultDrive);
    useEffect(() => {
      listeners.add(setCurrent);
      return () => listeners.delete(setCurrent);
    }, []);
    return current;
  }
  /**
   * The index in `roots` a new download starts on: the default drive (glibren.6), else the last drive used, when it
   * is listed and `fits(root)`; else the first drive that fits (as before 0.5.5), else the first.
   */
  function startingDrive(roots, fits, last = defaultDrive() ?? lastDrive()) {
    const index = last ? roots.indexOf(last) : -1;
    if (index >= 0 && fits(roots[index])) return index;
    return Math.max(0, roots.findIndex(fits));
  }

export { defaultDrive, lastDrive, rememberDrive, setDefaultDrive, startingDrive, useDefaultDrive };
