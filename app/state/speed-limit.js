// A cap on what game downloads take from the connection (from Overdrive 1.0.6), in MB/s as the app shows
// speeds (formatSpeed's MB is 1024 ** 2 bytes); 0 is no cap. Kept in settings.json beside the other
// settings and handed to the download engine (Downloads.setRateLimit, ps5-react ABI v21) at launch and on
// every change, running downloads included. The app's own update downloads unlimited and never waits on it.
// MODIFIED (glibren.13): more choices (the phone page offers the same list), and the same limit holds in the
// background payload: background-downloads.js sends it in POST /config (the payload caps the sum of all its jobs and
// connections, live) and adopts the one chosen on the phone page / Jobe Controle APK (setSpeedLimit), as it does the
// simultaneous downloads. onSpeedLimit tells it of every change.

import { useEffect, useState } from 'react';
import { loadList, saveList } from './saved.js';
import { Downloads } from '@ps5-react/core';
import { log } from '../services/logger.js';

  var LIMITS = [0, 50, 25, 15, 10, 5, 3, 2, 1];
  var SETTINGS = "settings.json";
  var nearest = (limit) => LIMITS.filter(Boolean).reduce((best, value) => Math.abs(value - limit) < Math.abs(best - limit) ? value : best);
  var speedLimit = null;
  // The saved limit, read once (one no longer offered becomes the nearest that is).
  function current() {
    if (speedLimit === null) {
      const saved = loadList(SETTINGS, "settings").speedLimit;
      speedLimit = LIMITS.includes(saved) ? saved : typeof saved === "number" && saved > 0 ? nearest(saved) : 0;
    }
    return speedLimit;
  }
  var listeners = /* @__PURE__ */ new Set();
  function apply() {
    try {
      Downloads.setRateLimit?.(current() * 1024 ** 2);
      log("speed", current() ? `download limit ${current()} MB/s applied` : "download limit off");
    } catch (error) {
      console.log("[speed-limit] not applied:", error.message);
    }
  }
  /** Sets the limit (one of LIMITS, MB/s; 0 for none), saves it and applies it at once. */
  function setSpeedLimit(limit) {
    if (!LIMITS.includes(limit)) return;
    speedLimit = limit;
    const { speedLimit: _old, ...settings } = loadList(SETTINGS, "settings");
    saveList(SETTINGS, "settings", limit ? { ...settings, speedLimit: limit } : settings);
    apply();
    for (const listener of [...listeners]) listener(limit);
  }
  /** glibren.13: takes a limit chosen elsewhere (the phone page, any MB/s): the nearest one offered (0 stays none). */
  function adoptSpeedLimit(limit) {
    if (typeof limit !== "number" || !(limit >= 0)) return;
    setSpeedLimit(limit > 0 ? nearest(limit) : 0);
  }
  /** glibren.13: calls `listener(limit)` on every change; returns the function that stops it. */
  function onSpeedLimit(listener) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }
  function useSpeedLimit() {
    const [limit, setLimit] = (0, useState)(current);
    (0, useEffect)(() => onSpeedLimit(setLimit), []);
    return limit;
  }
  /** Hands the saved limit to the engine; called once at launch. */
  var applySpeedLimit = apply;

export { LIMITS, adoptSpeedLimit, applySpeedLimit, current as speedLimitNow, onSpeedLimit, setSpeedLimit, useSpeedLimit };
