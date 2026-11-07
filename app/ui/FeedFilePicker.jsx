// glibren.14: "Add a file from the PS5" (Settings, Catalog feeds): a side sheet that walks the console's drives (the
// internal /data, USB and extended drives) folder by folder and shows only folders and .json files. Cross on a file
// links it as a feed (`onPick(path)`, which throws with the reason when it cannot be used: the reason shows here and
// the sheet stays open); Circle closes it. Folders are listed when opened, never while the sheet draws.

import '../assets/Exo2.ttf';
import '../assets/JetBrainsMono-Regular.ttf';
import { jsx, jsxs } from 'react/jsx-runtime';
import { useState } from 'react';
import { useT } from '../i18n/index.js';
import { driveName } from '../state/downloads.js';
import { useDrives } from '../state/drives.js';
import { feedFolder, parentFolder } from '../state/local-feed.js';
import { useNavActions } from '../state/nav.jsx';
import { formatBytes } from '../state/size.js';
import { FocusRing } from './FocusRing.jsx';
import { Icon } from './Icon.jsx';
import { SideSheet } from './SideSheet.jsx';
import { colors, radius } from './colors.js';
import { FileSystem, Text, View } from '@ps5-react/core';

  // Jobee'sLair's own folder on the internal drive, offered beside the drives.
  var JOBE_DIR = "/data/JobeesLair";
  function Entry({ focusKey, autoFocus, icon, label, detail, tone, onPress }) {
    return jsxs(View, { focusKey, autoFocus, onPress, style: { position: "relative", flexDirection: "row", alignItems: "center", gap: 16, marginBottom: 10, borderRadius: radius.md, backgroundColor: colors.surface2, paddingHorizontal: 22, paddingVertical: 14 }, children: [
      jsx(FocusRing, {}),
      jsx(Icon, { name: icon, size: 22, color: tone ?? colors.glow }),
      jsxs(View, { style: { flex: 1, gap: 2 }, children: [
        jsx(Text, { style: { fontFamily: "Exo2", fontSize: 22, fontWeight: 600, lineHeight: 30, color: colors.fg, numberOfLines: 1, ellipsizeMode: "middle" }, children: label }),
        detail ? jsx(Text, { style: { fontFamily: "JetBrainsMono-Regular", fontSize: 17, lineHeight: 24, color: colors.subtle, numberOfLines: 1, ellipsizeMode: "middle" }, children: detail }) : null
      ] })
    ] });
  }
  function Note({ tone, children }) {
    return jsxs(View, { style: { flexDirection: "row", gap: 16, marginBottom: 12, borderRadius: radius.md, backgroundColor: colors.surface2, paddingHorizontal: 20, paddingVertical: 14 }, children: [
      jsx(View, { style: { width: 4, borderRadius: radius.pill, backgroundColor: tone } }),
      jsx(Text, { style: { width: 640, fontFamily: "Exo2", fontSize: 20, lineHeight: 28, color: colors.fg }, children })
    ] });
  }
  function FeedFilePicker({ roots: given, onPick, onClose, fs = FileSystem }) {
    const t2 = useT();
    // The drives plugged in (state/drives.js), unless the caller names them.
    const drives = useDrives();
    const roots = given ?? drives.roots;
    const { focusLater } = useNavActions();
    // null: the drives; else the folder shown and what it holds.
    const [dir, setDir] = useState(null);
    const [listing, setListing] = useState({ folders: [], files: [], more: 0 });
    const [problem, setProblem] = useState("");
    const open = (next) => {
      setProblem("");
      if (next === null) {
        setDir(null);
        focusLater("feedfile:top");
        return;
      }
      try {
        setListing(feedFolder(fs, next));
        setDir(next);
        focusLater("feedfile:top");
      } catch (error) {
        setProblem(t2("settings.feeds.pick.failed", { error: error.message }));
      }
    };
    const pick = (path) => {
      setProblem("");
      try {
        onPick(path);
        onClose();
      } catch (error) {
        setProblem(error.message);
      }
    };
    const rows = [];
    if (dir === null) {
      roots.forEach((root, index) => rows.push(jsx(Entry, { focusKey: index ? `feedfile:${root}` : "feedfile:top", autoFocus: index === 0, icon: "hardDrive", label: driveName(root), detail: root, onPress: () => open(root) }, root)));
      rows.push(jsx(Entry, { focusKey: `feedfile:${JOBE_DIR}`, icon: "folder", label: t2("settings.feeds.pick.jobe"), detail: JOBE_DIR, onPress: () => open(JOBE_DIR) }, JOBE_DIR));
    } else {
      const up = parentFolder(dir);
      rows.push(jsx(Entry, { focusKey: "feedfile:top", autoFocus: true, icon: "arrowLeft", tone: colors.muted, label: up ? t2("settings.feeds.pick.up") : t2("settings.feeds.pick.drives"), detail: up ?? null, onPress: () => open(up) }, "up"));
      for (const folder of listing.folders) rows.push(jsx(Entry, { focusKey: `feedfile:${folder.path}`, icon: "folder", label: folder.name, onPress: () => open(folder.path) }, folder.path));
      for (const file of listing.files) rows.push(jsx(Entry, { focusKey: `feedfile:${file.path}`, icon: "file", label: file.name, detail: file.size != null ? formatBytes(file.size) : null, onPress: () => pick(file.path) }, file.path));
      if (!listing.folders.length && !listing.files.length) rows.push(jsx(Note, { tone: colors.muted, children: t2("settings.feeds.pick.empty") }, "empty"));
      if (listing.more > 0) rows.push(jsx(Note, { tone: colors.muted, children: t2("settings.feeds.pick.more", { count: listing.more }) }, "more"));
    }
    return jsx(SideSheet, { title: t2("settings.feeds.pick.title"), subtitle: dir ?? t2("settings.feeds.pick.subtitle"), onClose, children: [
      problem ? jsx(Note, { tone: "#f87171", children: problem }, "problem") : null,
      ...rows
    ] });
  }

export { FeedFilePicker };
