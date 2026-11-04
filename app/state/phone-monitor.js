// glibren: the downloads page for a phone on the home network, served by the background payload (bg-downloader,
// port 34201) while the app is closed. Settings has the switch (on by default) and the PIN that opens its
// controls (pause, resume, cancel); watching needs none. Only a salted SHA-256 of the PIN is kept, in
// settings.json, and only that reaches the payload (background-downloads.js, POST /config): the PIN itself is
// never stored. The address shown in Settings is the one the payload reports (its /health).

import { useEffect, useState } from 'react';
import { hex, newSecret, sha256, utf8 } from './secret-box.js';
import { loadList, saveList } from './saved.js';

  var SETTINGS = "settings.json";
  var PORT = 34201;
  var state = null;
  var probe = () => {};
  var listeners = /* @__PURE__ */ new Set();
  var read = () => loadList(SETTINGS, "settings");
  /** The salted hash the payload compares a phone's PIN with: SHA-256 of "<salt>:<pin>", in hex. */
  var pinHashOf = (salt, pin) => hex(sha256(utf8(`${salt}:${pin}`)));
  function current() {
    if (state === null) {
      const saved = read();
      const pin = saved.phoneMonitorPin;
      state = {
        on: saved.phoneMonitor !== false,
        pin: pin && /^[0-9a-f]{64}$/.test(pin.salt) && /^[0-9a-f]{64}$/.test(pin.hash) ? { salt: pin.salt, hash: pin.hash } : null,
        address: ""
      };
    }
    return state;
  }
  function changed(next) {
    state = { ...current(), ...next };
    for (const listener of [...listeners]) listener(state);
  }
  function phoneMonitorOn() {
    return current().on;
  }
  /** Turns the phone page on or off (the payload opens or closes its port at the next config). */
  function setPhoneMonitor(on) {
    saveList(SETTINGS, "settings", { ...read(), phoneMonitor: Boolean(on) });
    changed({ on: Boolean(on) });
  }
  function hasPhoneMonitorPin() {
    return Boolean(current().pin);
  }
  /**
   * Keeps a salted hash of a new PIN: six digits, as the companion's (anything else throws its message key).
   * Settings checks first that it is not easy to guess (companion/service.js pinProblem), as for the companion.
   */
  function choosePhoneMonitorPin(pin, entropy = `${Math.random()}`) {
    if (!/^\d{6}$/.test(String(pin))) throw new Error("pin.digits");
    const salt = newSecret(entropy);
    const saved = { salt, hash: pinHashOf(salt, pin) };
    saveList(SETTINGS, "settings", { ...read(), phoneMonitorPin: saved });
    changed({ pin: saved });
  }
  /** What the payload's POST /config takes for the page: on/off and the PIN's salt and hash ("" for none). */
  function phoneMonitorConfig() {
    const { on, pin } = current();
    return { monitor: on, pinSalt: pin?.salt ?? "", pinHash: pin?.hash ?? "" };
  }
  /** The console's address on the home network, as the payload reported it ("" until it did). */
  function setPhoneMonitorAddress(ip) {
    const address = typeof ip === "string" && /^\d{1,3}(\.\d{1,3}){3}$/.test(ip) ? `http://${ip}:${PORT}` : "";
    if (address !== current().address) changed({ address });
  }
  /** Calls `listener(state)` on every change; returns the function that stops it. */
  function onPhoneMonitor(listener) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }
  /** Who asks the running payload for its address (downloads.js): Settings calls it when it opens. */
  function setPhoneMonitorProbe(fn) {
    probe = typeof fn === "function" ? fn : () => {};
  }
  /** { on, hasPin, address } for Settings. */
  function usePhoneMonitor() {
    const view = (value) => ({ on: value.on, hasPin: Boolean(value.pin), address: value.address });
    const [value, setValue] = useState(() => view(current()));
    useEffect(() => {
      const stop = onPhoneMonitor((next) => setValue(view(next)));
      try {
        probe();
      } catch {
      }
      return stop;
    }, []);
    return value;
  }

export { PORT as PHONE_MONITOR_PORT, choosePhoneMonitorPin, hasPhoneMonitorPin, onPhoneMonitor, phoneMonitorConfig, phoneMonitorOn, pinHashOf, setPhoneMonitor, setPhoneMonitorAddress, setPhoneMonitorProbe, usePhoneMonitor };
