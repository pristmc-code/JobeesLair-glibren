// glibren.22: "BACKUP folder" in the Downloads tab: what the background payload keeps in <drive>/BACKUP (the originals
// of the games it converts to .exfat), with what became of each, and what only the phone page could do before: convert
// one or all of them, delete one (a second press within three seconds) and read the payload's log, newest lines first.
// The list comes from the payload (GET /backup, state/payload-conversions.js useBackup) and is read again every 3 s
// while the sheet is open; without the payload running it says so.

import '../assets/Exo2.ttf';
import '../assets/JetBrainsMono-Regular.ttf';
import { jsx, jsxs } from 'react/jsx-runtime';
import { useEffect, useState } from 'react';
import { formatNumber2 } from '../i18n/core.js';
import { useT } from '../i18n/index.js';
import { backupStatus, convertAllBackup, convertBackup, deleteBackup, payloadLog, useBackup } from '../state/payload-conversions.js';
import { formatBytes } from '../state/size.js';
import { Button2 } from '../ui/Button.jsx';
import { FocusRing } from '../ui/FocusRing.jsx';
import { SideSheet } from '../ui/SideSheet.jsx';
import { colors, radius } from '../ui/colors.js';
import { Text, View } from '@ps5-react/core';

  var BODY = { width: 690, fontFamily: "Exo2", fontSize: 22, lineHeight: 32 };
  var SMALL = { width: 690, fontFamily: "Exo2", fontSize: 19, lineHeight: 28 };
  var LINE = { width: 690, fontFamily: "JetBrainsMono-Regular", fontSize: 15, lineHeight: 22, color: colors.muted };
  var RED = "#f87171", GREEN = "#4ade80", AMBER = "#fbbf24";
  var ARM_MS = 3e3;
  var LOG_LINES = 80;
  var percentOf = (status) => status.total ? Math.min(100, Math.floor(status.written / status.total * 100)) : 0;
  function statusText(t2, status) {
    switch (status.state) {
      case "converted":
        return [t2("downloads.backup.state.converted", { file: status.file }), GREEN];
      case "ps4":
        return [t2("downloads.backup.state.ps4"), colors.muted];
      case "queued":
        return [t2("downloads.backup.state.queued"), colors.accentHi];
      case "extracting":
        return [t2("downloads.backup.state.extracting", { percent: percentOf(status) }), colors.accentHi];
      case "converting":
      case "verifying":
        return [t2("downloads.backup.state.converting", { percent: percentOf(status) }), colors.accentHi];
      case "failed":
        return [t2("downloads.backup.state.failed", { error: status.error.slice(0, 220) }), RED];
      default:
        return [t2("downloads.backup.state.idle"), AMBER];
    }
  }
  var keyOf = (item) => `backup:${item.root}/${item.name}`;
  function Item({ item, autoFocus, onDone }) {
    const t2 = useT();
    const [armed, setArmed] = (0, useState)(false);
    const [busy, setBusy] = (0, useState)(false);
    (0, useEffect)(() => {
      if (!armed) return void 0;
      const timer = setTimeout(() => setArmed(false), ARM_MS);
      return () => clearTimeout(timer);
    }, [armed]);
    const status = backupStatus(item);
    const [text, tone] = statusText(t2, status);
    const running = ["queued", "extracting", "converting", "verifying"].includes(status.state);
    const canConvert = !running && !["ps4", "converted"].includes(status.state) && item.platform !== "ps4";
    const run = (work) => {
      if (busy) return;
      setBusy(true);
      void work().then((result) => onDone(result, item)).finally(() => setBusy(false));
    };
    const detail = [item.code, item.format ? item.format.toUpperCase() : "", item.parts ? t2("downloads.backup.parts", { count: item.parts }) : "", formatBytes(item.bytes || 0)].filter(Boolean).join(" \xB7 ");
    return /* @__PURE__ */ jsxs(View, { style: { gap: 8, borderRadius: radius.sm, borderWidth: 1, borderColor: colors.line, paddingHorizontal: 18, paddingVertical: 14 }, children: [
      /* @__PURE__ */ jsx(Text, { style: [BODY, { color: colors.fg, numberOfLines: 1, ellipsizeMode: "middle" }], children: item.name }),
      /* @__PURE__ */ jsx(Text, { style: [SMALL, { color: colors.subtle, numberOfLines: 1, ellipsizeMode: "tail" }], children: `${item.root} \xB7 ${detail}` }),
      /* @__PURE__ */ jsx(Text, { style: [SMALL, { color: tone, numberOfLines: 3, ellipsizeMode: "tail" }], children: text }),
      /* @__PURE__ */ jsxs(View, { style: { flexDirection: "row", gap: 12, marginTop: 4 }, children: [
        canConvert ? /* @__PURE__ */ jsx(Button2, { variant: "primary", size: "md", icon: "restart", label: t2(status.state === "idle" ? "downloads.backup.convert" : "downloads.backup.again"), autoFocus, focusKey: `${keyOf(item)}:convert`, onPress: () => run(() => convertBackup(item)) }) : null,
        /* @__PURE__ */ jsx(Button2, { variant: armed ? "primary" : "secondary", size: "md", icon: armed ? "delete" : "x", label: t2(armed ? "downloads.backup.deleteArmed" : "downloads.backup.delete"), autoFocus: autoFocus && !canConvert, focusKey: `${keyOf(item)}:delete`, onBlur: () => setArmed(false), onPress: () => {
          if (armed) run(() => deleteBackup(item));
          setArmed(!armed);
        } })
      ] })
    ] });
  }
  function Note({ children, tone = colors.muted, autoFocus = false }) {
    return /* @__PURE__ */ jsxs(View, { focusable: true, autoFocus, style: (state) => [{ position: "relative", borderRadius: radius.sm, paddingHorizontal: 18, paddingVertical: 12 }, state.focused ? { backgroundColor: colors.surface2 } : null], children: [
      /* @__PURE__ */ jsx(FocusRing, {}),
      /* @__PURE__ */ jsx(Text, { style: [BODY, { color: tone }], children })
    ] });
  }
  function BackupSheet({ onClose }) {
    const t2 = useT();
    const data = useBackup();
    const [message, setMessage] = (0, useState)(null);
    const [log, setLog] = (0, useState)(null);
    const games = data?.games ?? [];
    const pending = games.filter((item) => backupStatus(item).state === "idle" || backupStatus(item).state === "failed").length;
    const told = (result, item) => {
      if (result.ok && result.data && "queued" in result.data) setMessage([t2("downloads.backup.convertAllDone", { queued: result.data.queued ?? 0, converted: result.data.converted ?? 0, ps4: result.data.ps4 ?? 0, nothing: result.data.nothing ?? 0 }), colors.fg]);
      else if (result.ok) setMessage(null);
      else setMessage([result.error === "converting" ? t2("downloads.backup.busy") : result.error === "ps4" ? t2("downloads.backup.state.ps4") : result.error === "converted" ? t2("downloads.backup.state.converted", { file: item?.converted || "" }) : t2("downloads.backup.failed", { error: result.error }), RED]);
    };
    const showLog = () => {
      if (log) {
        setLog(null);
        return;
      }
      setLog({ loading: true });
      void payloadLog().then((text) => setLog(text == null ? { error: true } : { lines: text.split("\n").filter((line) => line.trim()).slice(-LOG_LINES).reverse() }));
    };
    const subtitle = data ? t2("downloads.backup.subtitle", { count: formatNumber2(games.length), size: formatBytes(data.totalBytes) }) : "";
    const body = data === void 0 ? [/* @__PURE__ */ jsx(Note, { autoFocus: true, children: t2("downloads.backup.loading") }, "loading")] : data === null ? [/* @__PURE__ */ jsx(Note, { autoFocus: true, children: t2("downloads.backup.noPayload") }, "none")] : [
      /* @__PURE__ */ jsxs(View, { style: { flexDirection: "row", gap: 12, paddingHorizontal: 9 }, children: [
        /* @__PURE__ */ jsx(Button2, { variant: "primary", size: "md", icon: "restart", label: t2("downloads.backup.convertAll"), autoFocus: true, focusKey: "backup:convert-all", onPress: () => void convertAllBackup().then((result) => told(result)) }),
        /* @__PURE__ */ jsx(Button2, { variant: "secondary", size: "md", icon: "list", label: t2(log ? "downloads.backup.hideLog" : "downloads.backup.showLog"), focusKey: "backup:log", onPress: showLog })
      ] }, "actions"),
      message ? /* @__PURE__ */ jsx(Text, { style: [SMALL, { color: message[1], paddingHorizontal: 18 }], children: message[0] }, "message") : null,
      pending ? /* @__PURE__ */ jsx(Text, { style: [SMALL, { color: colors.subtle, paddingHorizontal: 18 }], children: t2("downloads.backup.pending", { count: formatNumber2(pending) }) }, "pending") : null,
      log ? /* @__PURE__ */ jsxs(View, { focusable: true, style: (state) => [{ position: "relative", gap: 2, borderRadius: radius.sm, paddingHorizontal: 18, paddingVertical: 12 }, state.focused ? { backgroundColor: colors.surface2 } : null], children: [
        /* @__PURE__ */ jsx(FocusRing, {}),
        log.loading ? /* @__PURE__ */ jsx(Text, { style: LINE, children: t2("downloads.backup.loading") }) : log.error ? /* @__PURE__ */ jsx(Text, { style: LINE, children: t2("downloads.backup.noPayload") }) : log.lines.map((line, index) => /* @__PURE__ */ jsx(Text, { style: LINE, children: line }, index))
      ] }, "log") : null,
      games.length ? null : /* @__PURE__ */ jsx(Note, { children: t2("downloads.backup.empty") }, "empty"),
      ...games.map((item) => /* @__PURE__ */ jsx(Item, { item, onDone: told }, keyOf(item)))
    ].filter(Boolean);
    return /* @__PURE__ */ jsx(SideSheet, { title: t2("downloads.backup.title"), subtitle, onClose, width: 860, children: /* @__PURE__ */ jsx(View, { style: { gap: 14, padding: 9 }, children: body }) });
  }

export { BackupSheet };
