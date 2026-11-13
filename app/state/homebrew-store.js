// The Homebrew section's one instance (state/homebrew.js) on the console's runtime, and its React hooks.
// The index is read the first time anything asks (the section, the companion, the update badge), and the
// live one is fetched once, a while after launch, so it never competes with the store's first screens.

import { useEffect, useState } from 'react';
import { Archives, Downloads, FileSystem, Http, Packages, Payloads, Platform } from '@ps5-react/core';
import { DATA_DIR } from './data-dir.js';
import { freeBytes, refreshDrives, storageRoots } from './drives.js';
import { createShadowClient } from './shadowmount.js';
import { downloadQueue, driveName } from './downloads.js';
import { createHomebrew } from './homebrew.js';
import { online } from './online.js';
import { formatBytes } from './size.js';
import { loadList, saveList } from './saved.js';
import { confirmDarkxexFile } from './darkxex-catalog.js';

  var PS5 = Platform.OS === "ps5";
  // Payloads live on the console's own /data, where loaders and the companion's helper can reach them.
  var PAYLOAD_DIR = PS5 ? "/data/JobeesLair/payloads" : `${FileSystem.dataDir}/JobeesLair/payloads`;
  var REFRESH_DELAY_MS = 12e3;
  var store = null;
  // glibren.48: "Catalogo darkxex" (settings.json `homebrewDarkxex`; on unless turned off). Read once.
  var SETTINGS = "settings.json";
  var darkxexSetting = null;
  var darkxexListeners = /* @__PURE__ */ new Set();
  function darkxexCatalogOn() {
    if (darkxexSetting === null) {
      try {
        darkxexSetting = loadList(SETTINGS, "settings").homebrewDarkxex !== false;
      } catch {
        darkxexSetting = true;
      }
    }
    return darkxexSetting;
  }
  function setDarkxexCatalog(on) {
    darkxexSetting = Boolean(on);
    try {
      saveList(SETTINGS, "settings", { ...loadList(SETTINGS, "settings"), homebrewDarkxex: darkxexSetting });
    } catch (error) {
      console.log(`[homebrew] darkxex switch not saved: ${error?.message || error}`);
    }
    console.log(`[homebrew] darkxex catalog ${darkxexSetting ? "on" : "off"}`);
    for (const listener of [...darkxexListeners]) listener(darkxexSetting);
    return homebrew().darkxexChanged();
  }
  function useDarkxexCatalog() {
    const [on, setOn] = useState(darkxexCatalogOn);
    useEffect(() => {
      darkxexListeners.add(setOn);
      return () => darkxexListeners.delete(setOn);
    }, []);
    return on;
  }
  // The highest signed catalog sequence accepted (darkxex-catalog.js verifyManifest: never lower).
  var sequenceFile = () => `${DATA_DIR}/homebrew-darkxex-sequence.json`;
  function readSequence() {
    try {
      return Number(JSON.parse(FileSystem.readFile(sequenceFile())).sequence) || 0;
    } catch {
      return 0;
    }
  }
  async function confirmDarkxex({ file, app }) {
    const signed = await confirmDarkxexFile({ get: (url, options) => Http.request(url, options), file, repo: app.repo, minSequence: readSequence() });
    try {
      if (signed.sequence > readSequence()) FileSystem.writeFile(sequenceFile(), JSON.stringify({ sequence: signed.sequence }));
    } catch {
    }
    return signed;
  }
  // ShadowMount asked the way the library asks it: `now` pauses the download in progress for the moment it takes
  // (the runtime runs one network task at a time, so a request would otherwise wait behind the whole file);
  // `background` is skipped while a download holds the network.
  var shadowClient = null;
  var client = () => shadowClient ?? (shadowClient = createShadowClient({ http: Http, transferring: () => downloadQueue().transferring?.() ?? false, quiet: (reason, work) => downloadQueue().quietNetwork(reason, work) }));
  function homebrew() {
    if (store) return store;
    store = createHomebrew({
      fs: FileSystem,
      http: Http,
      downloads: Downloads,
      archives: Archives,
      packages: PS5 ? Packages : null,
      payloads: PS5 ? Payloads : null,
      shadow: PS5 ? (route, body) => client().now(`homebrew: ${route}`, route, body) : null,
      shadowQuick: PS5 ? (route, body) => client().background(route, body) : null,
      dataDir: DATA_DIR,
      payloadDir: PAYLOAD_DIR,
      roots: () => storageRoots(),
      freeBytes: (root) => freeBytes(root),
      driveName: (root) => driveName(root),
      sizeText: (bytes) => formatBytes(bytes),
      readBundled: () => FileSystem.readFile("/app0/data/homebrew.json"),
      platform: Platform.OS,
      // 0.5.2: which apps install and which fail, for the dashboard (state/online.js; only with stats on).
      onInstalled: (result) => online().installed(result),
      darkxexOn: darkxexCatalogOn,
      darkxexConfirm: confirmDarkxex
    });
    return store;
  }
  var refreshTimer = null;
  // Once per launch: the live index, a while after the store is up. Returns a stop function.
  function startHomebrewRefresh() {
    if (refreshTimer) return () => {};
    refreshTimer = setTimeout(() => {
      void refreshDrives().catch(() => {}).then(() => homebrew().rescan());
      void homebrew().refresh();
    }, REFRESH_DELAY_MS);
    return () => {
      clearTimeout(refreshTimer);
      refreshTimer = null;
    };
  }
  // Redraws the component whenever the section's state changes (an index arrives, an install moves).
  function useHomebrewVersion() {
    const [version, setVersion] = useState(() => homebrew().version);
    useEffect(() => homebrew().subscribe(() => setVersion(homebrew().version)), []);
    return version;
  }
  function useHomebrew() {
    useHomebrewVersion();
    return homebrew();
  }
  // One app's state, redrawn only when it changes (an install's progress moves in whole percents).
  function useHomebrewStatus(id) {
    const read = () => homebrew().statusOf(id);
    const [status, setStatus] = useState(read);
    useEffect(() => homebrew().subscribe(() => {
      const next = read();
      setStatus((last) => sameStatus(last, next) ? last : next);
    }), [id]);
    return status;
  }
  var sameStatus = (a, b) => a.installed === b.installed && a.update === b.update && a.failed === b.failed && a.record === b.record && a.outside === b.outside && (a.task?.phase ?? null) === (b.task?.phase ?? null) && (a.task?.written ?? 0) === (b.task?.written ?? 0) && (a.task?.total ?? 0) === (b.task?.total ?? 0);
  // How many installed apps have a newer release: the island's badge. The island is up from launch, so it
  // waits a few seconds before reading the index, unless something else has read it already.
  var BADGE_DELAY_MS = 6e3;
  function useHomebrewUpdates() {
    const [count, setCount] = useState(() => store ? store.updates().length : 0);
    useEffect(() => {
      let off = null;
      const read = () => setCount(homebrew().updates().length);
      const start = () => {
        off = homebrew().subscribe(read);
        read();
      };
      const id = store ? (start(), null) : setTimeout(start, BADGE_DELAY_MS);
      return () => {
        if (id) clearTimeout(id);
        off?.();
      };
    }, []);
    return count;
  }

export { PAYLOAD_DIR, darkxexCatalogOn, homebrew, setDarkxexCatalog, startHomebrewRefresh, useDarkxexCatalog, useHomebrew, useHomebrewStatus, useHomebrewUpdates, useHomebrewVersion };
