// glibren.42: the YouTube account in Settings > Videos (the tube-service's TV sign-in, service 0.2.0 / api 2 with the
// "account" feature). Signing in shows the code and the address (with a QR of the address) and asks the service every
// few seconds (POST /v1/account/signin/poll, the interval it gives) until it is done, refused or expired; signed in,
// the row shows the account's name and "Sign out". The credentials never reach the app: they stay in the service
// (/data/JobeesLair/tube/account.json, 0600, on the console only).
// glibren.44: with an older service (no "account" feature) the row stays (it was hidden, and on the PS5 the player
// said "the service in use can't sign in" with nothing to do about it): it says which version is in use and, with a
// newer one ready, offers "Update the service now" (tube-service.js upgradeNow: quit + start the new one), then the
// sign-in. With the service not up yet, the row only says "Press to check" and starts it on demand (the service is
// never started just by opening Settings).
// glibren.44: after a state change that removes the focused row (the code's "Cancel" when the sign-in is done, the
// update row), focus goes to the account row explicitly (an app close was seen on the PS5 right after signing in).
// Also here: "Back to the built-in version" (A6), shown while a downloaded service version is ahead of the built-in one.

import '../assets/Exo2.ttf';
import '../assets/JetBrainsMono-Regular.ttf';
import { Fragment, jsx, jsxs } from 'react/jsx-runtime';
import { useEffect, useRef, useState } from 'react';
import { useT } from '../i18n/index.js';
import { tubeService, tubeUpdater } from '../state/tube-service.js';
import { newer } from '../state/updater.js';
import { FocusRing } from './FocusRing.jsx';
import { Icon } from './Icon.jsx';
import { QRCode } from './QRCode.jsx';
import { colors, radius } from './colors.js';
import { Text, View, useFocusActions, useIsFocused } from '@ps5-react/core';

  // The first service version that signs in (tube-service VERSION 0.2.0, api 2).
  var ACCOUNT_SINCE = "0.2.0";
  var text = (size, color, extra) => ({ fontFamily: "Exo2", fontSize: size, lineHeight: Math.round(size * 1.4), color, ...extra });
  var ROW = (state) => [{ position: "relative", flexDirection: "row", alignItems: "center", gap: 24, borderRadius: radius.md, paddingHorizontal: 20, paddingVertical: 16, marginHorizontal: -20 }, state.focused ? { backgroundColor: colors.surface3 } : null];

  function Face({ name, detail, hint, icon }) {
    const focused = useIsFocused();
    return jsxs(Fragment, { children: [
      jsx(FocusRing, { round: "md" }),
      jsxs(View, { style: { flex: 1, gap: 3 }, children: [
        jsx(Text, { style: text(23, colors.fg, { fontWeight: 600, numberOfLines: 1, ellipsizeMode: "tail" }), children: name }),
        detail ? jsx(Text, { style: text(20, focused ? colors.fg : colors.muted, { numberOfLines: 2, ellipsizeMode: "tail" }), children: detail }) : null,
        hint && focused ? jsx(Text, { style: text(20, colors.muted, { numberOfLines: 3, ellipsizeMode: "tail" }), children: hint }) : null
      ] }),
      icon ? jsx(Icon, { name: icon, color: colors.muted }) : null
    ] });
  }
  function Row({ focusKey, name, detail, hint, icon, onPress }) {
    return jsx(View, { focusKey, onPress, style: ROW, children: jsx(Face, { name, detail, hint, icon }) });
  }

  /** What the service row knows without starting it: "yes", "no" (an older version would start) or "unknown". */
  function offeredBy(service, info) {
    if (service.isReady?.()) return service.hasAccount?.() ? "yes" : "no";
    const version = info?.version;
    if (typeof version === "string" && version && newer(ACCOUNT_SINCE, version)) return "no";
    return "unknown";
  }

  /**
   * `service`: the tube-service client (tests); `info`: what Settings shows as the service in use ({ source, version }).
   */
  function TubeAccountRows({ service = tubeService(), info = null, start = null }) {
    const t2 = useT();
    // idle (not asked yet) | checking | out | in | code | busy | old (glibren.44: the service in use can't sign in).
    // `start`: the tests' state ({ state, name, code }).
    const [state, setState] = useState(() => start?.state ?? (offeredBy(service, info) === "no" ? "old" : service.isReady?.() ? "checking" : "idle"));
    const { focus } = useFocusActions();
    // glibren.44: the row to focus after the next commit (the focused one may be gone with the state change).
    const focusNext = useRef("");
    useEffect(() => {
      const key = focusNext.current;
      if (!key) return;
      focusNext.current = "";
      try {
        focus?.(key);
      } catch {
      }
    }, [state]);
    const moveTo = (next, key = "settings:tubeAccount") => {
      focusNext.current = key;
      setState(next);
    };
    // The version up (or the one Settings says would start) and a newer one ready to replace it.
    const inUse = () => (service.isReady?.() ? service.runningVersion?.() : null) || info?.version || "";
    const ready = () => {
      try {
        return service.newerReady?.(inUse() || void 0) ?? null;
      } catch {
        return null;
      }
    };
    const [name, setName] = useState(() => start?.name ?? "");
    const [code, setCode] = useState(() => start?.code ?? null); // { code, url, expiresIn, interval }
    const [note, setNote] = useState("");
    const live = useRef({ alive: true, timer: null, release: null, round: 0 });
    const stopPolling = () => {
      const current = live.current;
      clearTimeout(current.timer);
      current.timer = null;
      current.round += 1;
      current.release?.();
      current.release = null;
    };
    useEffect(() => {
      const current = live.current;
      current.alive = true;
      if (state === "checking") void refresh();
      return () => {
        current.alive = false;
        stopPolling();
      };
    }, []);
    const failed = (error) => {
      if (!live.current.alive) return;
      setNote(t2("settings.tubeAccountFailed", { error: error?.code ?? error?.message ?? String(error) }));
      moveTo("idle");
    };
    async function refresh() {
      setState("checking");
      try {
        const up = await service.ensure();
        if (!live.current.alive) return;
        if (!up?.ok) throw Object.assign(new Error(up?.reason ?? "service"), { code: up?.reason ?? "service" });
        if (!service.hasAccount?.()) {
          moveTo("old");
          return;
        }
        const now = await service.account();
        if (!live.current.alive) return;
        setName(now.name);
        setState(now.signedIn ? "in" : "out");
      } catch (error) {
        failed(error);
      }
    }
    async function poll(round, interval) {
      const current = live.current;
      if (!current.alive || round !== current.round) return;
      try {
        const answer = await service.signInPoll();
        if (!current.alive || round !== current.round) return;
        if (answer.state === "done" && answer.signedIn !== false) {
          stopPolling();
          setCode(null);
          setNote("");
          setName(typeof answer.name === "string" ? answer.name : "");
          moveTo("in");
          return;
        }
        if (answer.state === "denied" || answer.state === "expired") {
          stopPolling();
          setCode(null);
          setNote(t2(answer.state === "denied" ? "settings.tubeAccountDenied" : "settings.tubeAccountExpired"));
          moveTo("out");
          return;
        }
        const next = answer.interval ?? interval;
        current.timer = setTimeout(() => void poll(round, next), next * 1e3);
      } catch (error) {
        if (!current.alive || round !== current.round) return;
        // One answer that did not come (the service busy): asked again at the next interval, a few times.
        current.misses = (current.misses ?? 0) + 1;
        if (current.misses < 4) {
          current.timer = setTimeout(() => void poll(round, interval), interval * 1e3);
          return;
        }
        stopPolling();
        setCode(null);
        failed(error);
      }
    }
    async function signIn() {
      setState("busy");
      setNote("");
      try {
        const started = await service.signIn();
        if (!live.current.alive) return;
        stopPolling();
        const current = live.current;
        // The service's /media links and the sign-in are the service's: it stays up (and a newer version waits) meanwhile.
        current.release = service.hold?.() ?? null;
        current.misses = 0;
        const round = current.round;
        setCode(started);
        moveTo("code", "settings:tubeAccountCancel");
        current.timer = setTimeout(() => void poll(round, started.interval), started.interval * 1e3);
      } catch (error) {
        failed(error);
      }
    }
    function cancel() {
      stopPolling();
      setCode(null);
      moveTo("out");
    }
    // glibren.44: "Update the service now": the newer version replaces the one up (never with a video job running),
    // then the sign-in starts (or the account shows, when already signed in on that service).
    async function update() {
      setState("busy");
      setNote("");
      try {
        const done = await service.upgradeNow();
        if (!live.current.alive) return;
        if (!done?.ok) {
          setNote(t2(done?.reason === "busy" ? "settings.tubeAccountBusy" : done?.reason === "none" ? "settings.tubeAccountNoUpdate" : "settings.tubeAccountFailed", { error: done?.reason ?? "?" }));
          moveTo(service.hasAccount?.() ? "out" : "old");
          return;
        }
        if (!service.hasAccount?.()) {
          moveTo("old");
          return;
        }
        const now = await service.account();
        if (!live.current.alive) return;
        setName(now.name);
        if (now.signedIn) moveTo("in");
        else await signIn();
      } catch (error) {
        failed(error);
      }
    }
    async function signOut() {
      setState("busy");
      try {
        await service.signOut();
        if (!live.current.alive) return;
        setName("");
        setNote("");
        moveTo("out");
      } catch (error) {
        failed(error);
      }
    }
    const hint = t2("settings.tubeAccountDetail");
    if (state === "old") {
      const version = inUse() || "?";
      const next = ready();
      return jsxs(Fragment, { children: [
        jsx(Row, { focusKey: "settings:tubeAccount", name: t2("settings.tubeAccount"), detail: note || `${t2("settings.tubeAccountOld", { version })}${next ? "" : ` ${t2("settings.tubeAccountNoUpdate")}`}`, hint, icon: "chevronRight", onPress: () => void refresh() }),
        next ? jsx(Row, { focusKey: "settings:tubeAccountUpdate", name: t2("settings.tubeAccountUpdateNow"), detail: t2("settings.tubeAccountUpdateReady", { version: next }), icon: "chevronRight", onPress: () => void update() }) : null
      ] });
    }
    if (state === "code" && code) return jsxs(View, { style: { gap: 14 }, children: [
      jsx(Text, { style: text(23, colors.fg, { fontWeight: 600 }), children: t2("settings.tubeAccount") }),
      jsxs(View, { style: { flexDirection: "row", alignItems: "center", gap: 28 }, children: [
        jsx(QRCode, { text: code.url, size: 200 }),
        jsxs(View, { style: { flex: 1, gap: 12 }, children: [
          jsx(Text, { style: text(20, colors.muted), children: t2("settings.tubeAccountSteps", { url: code.url }) }),
          jsx(View, { style: { alignSelf: "flex-start", borderRadius: radius.md, backgroundColor: colors.canvas2, paddingHorizontal: 22, paddingVertical: 8 }, children: jsx(Text, { style: { fontFamily: "JetBrainsMono-Regular", fontSize: 40, lineHeight: 52, letterSpacing: 6, color: colors.glow }, children: code.code }) }),
          jsx(Text, { style: text(20, colors.muted), children: t2("settings.tubeAccountWaiting", { minutes: String(Math.max(1, Math.round(code.expiresIn / 60))) }) })
        ] })
      ] }),
      jsx(Row, { focusKey: "settings:tubeAccountCancel", name: t2("settings.tubeAccountCancel"), icon: "x", onPress: cancel })
    ] });
    if (state === "in") return jsxs(Fragment, { children: [
      jsx(Row, { focusKey: "settings:tubeAccount", name: t2("settings.tubeAccount"), detail: name ? t2("settings.tubeAccountSignedIn", { name }) : t2("settings.tubeAccountSignedInNoName"), hint }),
      jsx(Row, { focusKey: "settings:tubeAccountSignOut", name: t2("settings.tubeAccountSignOut"), icon: "chevronRight", onPress: () => void signOut() })
    ] });
    if (state === "out") return jsx(Row, { focusKey: "settings:tubeAccount", name: t2("settings.tubeAccountSignIn"), detail: note || null, hint, icon: "chevronRight", onPress: () => void signIn() });
    // idle, checking, busy
    const waiting = state === "checking" || state === "busy";
    return jsx(Row, { focusKey: "settings:tubeAccount", name: t2("settings.tubeAccount"), detail: waiting ? "…" : note || t2("settings.tubeAccountCheck"), hint, icon: waiting ? null : "chevronRight", onPress: waiting ? void 0 : () => void refresh() });
  }

  /** A6: "Back to the built-in version", while a downloaded version is ahead of the built-in one. */
  function TubeRevertRow({ updater = tubeUpdater(), service = tubeService() }) {
    const t2 = useT();
    const ahead = () => {
      try {
        return updater.aheadOfEmbedded?.() === true;
      } catch {
        return false;
      }
    };
    const [shown, setShown] = useState(ahead);
    const [done, setDone] = useState("");
    useEffect(() => updater.subscribe?.(() => setShown(ahead())), []);
    if (!shown && !done) return null;
    const revert = () => {
      try {
        updater.revertToEmbedded();
        const first = updater.candidates()[0];
        setDone(t2("settings.tubeReverted", { version: first?.version ?? "?" }));
        setShown(false);
        // The one up now is the downloaded one, set aside: it quits once nobody uses it (tube-service.js refreshIfIdle),
        // and the built-in one starts next time.
        void service.refreshIfIdle?.();
      } catch (error) {
        setDone(String(error?.message ?? error));
      }
    };
    return jsx(Row, { focusKey: "settings:tubeRevert", name: t2("settings.tubeRevert"), detail: done || null, hint: t2("settings.tubeRevertDetail"), icon: done ? null : "chevronRight", onPress: done ? void 0 : revert });
  }

export { ACCOUNT_SINCE, TubeAccountRows, TubeRevertRow, offeredBy };
