// A cap on what game downloads take from the connection (from Overdrive 1.0.6), in MB/s as the app shows
// speeds (formatSpeed's MB is 1024 ** 2 bytes); 0 is no cap. Kept in settings.json beside the other
// settings and handed to the download engine (Downloads.setRateLimit, ps5-react ABI v21) at launch and on
// every change, running downloads included. The app's own update downloads unlimited and never waits on it.
// MODIFIED (glibren.13): any whole number of MB/s from 0 to MAX_SPEED_LIMIT (the most the background payload takes),
// stepped with − / + in Settings or typed on the phone page; LIMITS are only quick choices (the companion page), never
// a restriction. The same limit holds in the background payload: background-downloads.js sends it in POST /config (the
// payload caps the sum of all its jobs and connections, live) and adopts the exact one chosen on the phone page / Jobe
// Controle APK (adoptSpeedLimit), as it does the simultaneous downloads. onSpeedLimit tells it of every change.

import { useEffect, useState } from 'react';
import { loadList, saveList } from './saved.js';
import { Downloads } from '@ps5-react/core';
import { log } from '../services/logger.js';

  var MAX_SPEED_LIMIT = 1000;
  var LIMITS = [0, 50, 25, 15, 10, 5, 3, 2, 1];
  var SETTINGS = "settings.json";
  var valid = (limit) => Number.isInteger(limit) && limit >= 0 && limit <= MAX_SPEED_LIMIT;
  // A number from elsewhere (an old save, the phone): whole MB/s, within 0..MAX_SPEED_LIMIT; anything else is null.
  var tidy = (limit) => typeof limit === "number" && Number.isFinite(limit) && limit >= 0 ? Math.min(MAX_SPEED_LIMIT, Math.round(limit)) : null;
  var speedLimit = null;
  // The saved limit, read once (every value saved before is still a valid one).
  function current() {
    if (speedLimit === null) speedLimit = tidy(loadList(SETTINGS, "settings").speedLimit) ?? 0;
    return speedLimit;
  }
  var listeners = /* @__PURE__ */ new Set();
  // glibren-video-cap: a temporary cap while a video plays in the app (tube/TubePlayer.jsx, Settings > Videos), on top
  // of the saved limit: the lower of the two holds, and the saved one is never changed. 0 = none. The engine gets it at
  // once and the background payload on its next POST /config (downloads.js refreshes it on every change).
  var videoCap = 0;
  var videoCapListeners = /* @__PURE__ */ new Set();
  function effective() {
    const saved = current();
    if (!videoCap) return saved;
    return saved ? Math.min(saved, videoCap) : videoCap;
  }
  function apply() {
    try {
      const limit = effective();
      Downloads.setRateLimit?.(limit * 1024 ** 2);
      log("speed", limit ? `download limit ${limit} MB/s applied${videoCap ? " (video playing)" : ""}` : "download limit off");
    } catch (error) {
      console.log("[speed-limit] not applied:", error.message);
    }
  }
  /** Sets the limit (a whole number of MB/s, 0..MAX_SPEED_LIMIT; 0 for none), saves it and applies it at once. */
  function setSpeedLimit(limit) {
    if (!valid(limit)) return;
    speedLimit = limit;
    const { speedLimit: _old, ...settings } = loadList(SETTINGS, "settings");
    saveList(SETTINGS, "settings", limit ? { ...settings, speedLimit: limit } : settings);
    apply();
    for (const listener of [...listeners]) listener(limit);
  }
  /** glibren.13: one step up or down from the current limit (− / + in Settings), kept within 0..MAX_SPEED_LIMIT. */
  function stepSpeedLimit(delta) {
    const next = Math.min(MAX_SPEED_LIMIT, Math.max(0, current() + Math.round(delta)));
    if (next !== current()) setSpeedLimit(next);
  }
  /** glibren.13: takes the exact limit chosen elsewhere (the phone page); nonsense is ignored. */
  function adoptSpeedLimit(limit) {
    const value = tidy(limit);
    if (value !== null) setSpeedLimit(value);
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
  /** glibren-video-cap: sets (MB/s) or clears (0) the cap while a video plays; applies it at once. */
  function setVideoCap(limit) {
    const value = valid(limit) ? limit : 0;
    if (value === videoCap) return;
    videoCap = value;
    apply();
    for (const listener of [...videoCapListeners]) listener(value);
  }
  function onVideoCap(listener) {
    videoCapListeners.add(listener);
    return () => {
      videoCapListeners.delete(listener);
    };
  }

  /** glibren.41 (A1): the cap while a video plays (MB/s), 0 for none; the background payload gets it as a temporary field. */
  var videoCapNow = () => videoCap;

export { effective as speedLimitEffective, videoCapNow, onVideoCap, setVideoCap, LIMITS, MAX_SPEED_LIMIT, adoptSpeedLimit, applySpeedLimit, current as speedLimitNow, onSpeedLimit, setSpeedLimit, stepSpeedLimit, useSpeedLimit };
