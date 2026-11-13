// The console's facts that do not change while the app runs (system language, firmware, model), read once.
// DeviceInfo.get() also reads both temperature sensors, the CPU clock, free memory and process time on
// every call: on the PS5 those are kernel and sensor calls on the render thread. Settings asked for it
// on each draw of its language card, the source picker on each of its draws; nothing in a render does
// now.
// MODIFIED (glibren.54): the firmware is the console's real one, as the download payload reads it from the kernel
// (/data/JobeesLair/bg/firmware, written as the payload starts; the "firmware" of its /health). Inside the app's process
// the system call can report a faked one (13.090.001 on a 12.00 PS5, first real diagnostics of 13/11/2026), and the
// compatibility notes, the "ready" rule and the payload's catalog went by it. Without the payload's file: the app's own
// reading, as before. `appFirmware` keeps what the app's process saw (for the log).

import { DeviceInfo, FileSystem, Platform } from '@ps5-react/core';

  var EMPTY = { language: null, firmware: null, model: null, appFirmware: null };
  var FIRMWARE_FILE = "/data/JobeesLair/bg/firmware";
  var known = null;
  /** The payload's reading of the real firmware ("12.00"), or null. */
  function payloadFirmware(fs = FileSystem) {
    try {
      const file = globalThis.__jobeFirmwareFile || (Platform.OS === "ps5" ? FIRMWARE_FILE : null);
      if (!file) return null;
      const text = String(fs.readFile(file) ?? "").trim();
      return /^\d{1,2}\.\d{2}$/.test(text) ? text : null;
    } catch {
      return null;
    }
  }
  function deviceFacts() {
    if (known) return known;
    try {
      const info = DeviceInfo.get();
      const own = info?.firmware || null;
      known = { language: info?.language || null, firmware: payloadFirmware() || own, model: info?.model || null, appFirmware: own };
    } catch {
      return EMPTY;
    }
    return known;
  }
  /** glibren.54: the payload told the real firmware (its /health): from now on it is the one used. -> true when it changed. */
  function setConsoleFirmware(text) {
    if (typeof text !== "string" || !/^\d{1,2}\.\d{2}$/.test(text)) return false;
    const facts = deviceFacts();
    if (facts === EMPTY || facts.firmware === text) return false;
    known = { ...facts, firmware: text };
    return true;
  }

export { deviceFacts, payloadFirmware, setConsoleFirmware };
