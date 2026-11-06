// glibren: how many of the queue's downloads run at once, 1 to 4 (Settings, "Simultaneous downloads"); 1 is the
// queue as it always was. Kept in settings.json beside the other settings. The queue (download-queue.js) starts up
// to this many, and hands the number to the download engine's lanes (Downloads.setConcurrency, ps5-react) and to
// the background payload (background-downloads.js, POST /config). Lowering it stops nothing: the downloads
// running go on, and no other starts until fewer run.
// MODIFIED (glibren.8): it can also be chosen on the phone page / the Jobe Controle APK (the payload's POST /api/config);
// background-downloads.js then adopts that number here (setSimultaneousDownloads), so both sides keep the same one.

import { useEffect, useState } from 'react';
import { loadList, saveList } from './saved.js';

  var CHOICES = [1, 2, 3, 4];
  var SETTINGS = "settings.json";
  var count = null;
  var listeners = /* @__PURE__ */ new Set();
  /** The saved number, read once; anything else reads as 1. */
  function simultaneousDownloads() {
    if (count === null) {
      const saved = loadList(SETTINGS, "settings").simultaneousDownloads;
      count = CHOICES.includes(saved) ? saved : 1;
    }
    return count;
  }
  /** Sets the number (one of CHOICES), saves it and tells the queue at once. */
  function setSimultaneousDownloads(value) {
    if (!CHOICES.includes(value)) return;
    count = value;
    const { simultaneousDownloads: _old, ...settings } = loadList(SETTINGS, "settings");
    saveList(SETTINGS, "settings", value > 1 ? { ...settings, simultaneousDownloads: value } : settings);
    for (const listener of [...listeners]) listener(value);
  }
  /** Calls `listener(n)` on every change; returns the function that stops it. */
  function onSimultaneousDownloads(listener) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }
  function useSimultaneousDownloads() {
    const [value, setValue] = useState(simultaneousDownloads);
    useEffect(() => onSimultaneousDownloads(setValue), []);
    return value;
  }

export { CHOICES as SIMULTANEOUS_CHOICES, onSimultaneousDownloads, setSimultaneousDownloads, simultaneousDownloads, useSimultaneousDownloads };
