// glibren.6: "Search TorBox" on a game's page: every file TorBox has of the game (state/torbox-search.js), by its
// code and by its name, with its size and type (.exfat first), and where it goes ("Save to", the default drive of
// Settings > Downloads). A press queues that file at once, through TorBox, with no source list in between.

import '../assets/Exo2.ttf';
import { jsx, jsxs } from 'react/jsx-runtime';
import { useEffect, useState } from 'react';
import { useT } from '../i18n/index.js';
import { cancellation } from '../state/download-sources.js';
import { downloadQueue, driveName, freeBytes, storageRoots } from '../state/downloads.js';
import { setDefaultDrive, startingDrive, useDefaultDrive } from '../state/last-drive.js';
import { formatBytes } from '../state/size.js';
import { downloadFile, searchTorBox } from '../state/torbox-search.js';
import { FocusRing } from '../ui/FocusRing.jsx';
import { SideSheet } from '../ui/SideSheet.jsx';
import { colors, radius } from '../ui/colors.js';
import { Text, View } from '@ps5-react/core';

  var GREEN = "#4ade80";
  var RED = "#f87171";
  var BODY = { fontFamily: "Exo2", fontSize: 21, lineHeight: 30 };
  var WIDTH = 1110;
  // The search asks while a download runs: the network is one task at a time, so the queue pauses meanwhile.
  var quietly = (reason, work) => {
    try {
      const queue = downloadQueue();
      return queue.quietNetwork ? queue.quietNetwork(reason, work) : work();
    } catch {
      return work();
    }
  };
  function DrivePill({ label, chosen, focusKey, onPress }) {
    return jsxs(View, { focusKey, focusable: true, onPress, style: { position: "relative", height: 52, paddingHorizontal: 22, alignItems: "center", justifyContent: "center", borderRadius: radius.md, backgroundColor: chosen ? colors.accent : colors.surface2 }, children: [
      jsx(FocusRing, {}),
      jsx(Text, { style: [BODY, { fontWeight: 600, color: chosen ? "#ffffff" : colors.fg }], children: label })
    ] });
  }
  function TypeBadge({ type, best }) {
    const tone = best ? GREEN : colors.muted;
    return jsx(View, { style: { width: 108, alignItems: "center", borderRadius: radius.xs, borderWidth: 1, borderColor: tone, paddingVertical: 2 }, children: jsx(Text, { style: { fontFamily: "Exo2", fontSize: 18, fontWeight: 700, color: tone, lineHeight: 24 }, children: type }) });
  }
  function FileRow({ file, state, autoFocus, onPress }) {
    const t2 = useT();
    const where = file.origin === "account" ? t2("torboxSearch.origin.account") : file.origin === "catalog" ? t2("torboxSearch.origin.catalog", { host: file.host || "?" }) : t2("torboxSearch.origin.search");
    const status = state?.queued ? t2("torboxSearch.queued") : state?.error ? state.error : file.piece ? t2("torboxSearch.piece") : null;
    return jsxs(View, { autoFocus, focusable: true, onPress, style: (_state) => [{ position: "relative", flexDirection: "row", alignItems: "center", gap: 18, borderRadius: radius.sm, paddingHorizontal: 18, paddingVertical: 12 }, _state.focused ? { backgroundColor: colors.surface2 } : null], children: [
      jsx(FocusRing, {}),
      jsx(TypeBadge, { type: file.type, best: file.format === "exfat" }),
      jsxs(View, { style: { flex: 1, gap: 2 }, children: [
        jsx(Text, { style: [BODY, { fontSize: 22, fontWeight: 600, color: colors.fg, numberOfLines: 1, ellipsizeMode: "middle" }], children: file.name }),
        jsx(Text, { style: [BODY, { color: status && (state?.error || file.piece) ? RED : status ? GREEN : colors.muted, numberOfLines: 1, ellipsizeMode: "tail" }], children: [file.size ? formatBytes(file.size) : t2("torboxSearch.sizeUnknown"), where, status].filter(Boolean).join(" \xB7 ") })
      ] })
    ] });
  }
  function TorBoxSheet({ game, onClose }) {
    const t2 = useT();
    const [roots] = useState(() => {
      try {
        return storageRoots();
      } catch {
        return ["/data"];
      }
    });
    const chosenDrive = useDefaultDrive();
    // Automatic: the last drive used, as a game page starts on (state/last-drive.js).
    const root2 = chosenDrive && roots.includes(chosenDrive) ? chosenDrive : roots[startingDrive(roots, () => true)] ?? roots[0];
    const [result, setResult] = useState({ files: [], sources: null, done: false, error: "" });
    const [states, setStates] = useState({});
    useEffect(() => {
      let live = true;
      const run = cancellation();
      quietly("TorBox search", () => searchTorBox(game, { signal: run.signal, onUpdate: (update) => live && setResult((before) => ({ ...before, ...update })) })).then((final) => live && setResult({ ...final, done: true, error: "" }), (error) => live && setResult((before) => ({ ...before, done: true, error: error?.message || String(error) })));
      return () => {
        live = false;
        run.cancel();
      };
    }, [game.id]);
    const queue = (file) => {
      if (states[file.key]?.queued) return;
      try {
        downloadFile(downloadQueue(), game, file, root2);
        setStates((before) => ({ ...before, [file.key]: { queued: true } }));
      } catch (error) {
        setStates((before) => ({ ...before, [file.key]: { error: error?.message || String(error) } }));
      }
    };
    const { files, sources, done, error } = result;
    const exfat = files.filter((file) => file.format === "exfat").length;
    const note = (name) => {
      const source = sources?.[name];
      if (!source || source.state === "searching") return t2("torboxSearch.source.searching", { source: t2(`torboxSearch.source.${name}`) });
      if (source.state === "unavailable") return t2("torboxSearch.source.unavailable", { source: t2(`torboxSearch.source.${name}`) });
      if (source.state === "failed") return t2("torboxSearch.source.failed", { source: t2(`torboxSearch.source.${name}`) });
      return t2("torboxSearch.source.count", { source: t2(`torboxSearch.source.${name}`), count: source.count });
    };
    const summary = error ? error : !done ? t2("torboxSearch.searching") : files.length ? t2("torboxSearch.found", { count: files.length, exfat }) : t2("torboxSearch.none");
    const free = freeBytes(root2);
    return jsx(SideSheet, { title: t2("torboxSearch.title"), subtitle: `${game.title} \xB7 ${game.id}`, width: WIDTH, onClose, children: jsxs(View, { style: { gap: 18, padding: 9 }, children: [
      jsxs(View, { style: { gap: 10, paddingHorizontal: 18 }, children: [
        jsx(Text, { style: [BODY, { fontSize: 23, fontWeight: 600, color: colors.fg }], children: t2("torboxSearch.saveTo", { drive: driveName(root2), free: free !== null && free !== void 0 ? formatBytes(free) : "?" }) }),
        jsxs(View, { style: { flexDirection: "row", flexWrap: "wrap", gap: 12 }, children: [
          jsx(DrivePill, { focusKey: "torbox:drive:auto", label: t2("settings.defaultDrive.auto"), chosen: !chosenDrive || !roots.includes(chosenDrive), onPress: () => setDefaultDrive(null) }),
          ...roots.map((root) => jsx(DrivePill, { focusKey: `torbox:drive:${root}`, label: driveName(root), chosen: chosenDrive === root, onPress: () => setDefaultDrive(root) }, root))
        ] })
      ] }),
      jsxs(View, { style: { gap: 4, paddingHorizontal: 18 }, children: [
        jsx(Text, { style: [BODY, { fontSize: 22, color: error ? RED : colors.fg }], children: summary }),
        jsx(Text, { style: [BODY, { color: colors.muted, numberOfLines: 2 }], children: ["account", "catalog", "search"].map(note).join(" \xB7 ") })
      ] }),
      jsx(View, { style: { gap: 4 }, children: files.map((file, index) => jsx(FileRow, { file, state: states[file.key], autoFocus: index === 0, onPress: () => queue(file) }, file.key)) })
    ] }) });
  }

export { TorBoxSheet };
