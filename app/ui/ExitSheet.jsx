// glibren.5: "Exit Jobee'sLair?", asked before the app closes itself (Settings' "Exit Jobee'sLair", state/exit-app.js).
// It says what happens to the downloads: the ones the app itself runs stop (and go on from where they were when it
// opens again); the ones the background helper runs keep going. Cross on "Exit" closes the app; Circle or "Stay" goes
// back to Settings. `summary` is exitSummary's answer; `onExit()` closes the app.

import '../assets/Exo2.ttf';
import { jsx, jsxs } from 'react/jsx-runtime';
import { useState } from 'react';
import { useT } from '../i18n/index.js';
import { FocusRing } from './FocusRing.jsx';
import { Icon } from './Icon.jsx';
import { SideSheet } from './SideSheet.jsx';
import { colors, radius } from './colors.js';
import { Text, View } from '@ps5-react/core';

  var RED = "#f87171";
  var AMBER = "#fbbf24";
  function Choice({ focusKey, autoFocus, icon, label, detail, tone, onPress }) {
    return jsxs(View, { focusKey, autoFocus, onPress, style: { position: "relative", marginBottom: 12, borderRadius: radius.md, backgroundColor: colors.surface2, paddingHorizontal: 24, paddingVertical: 18, gap: 6 }, children: [
      jsx(FocusRing, {}),
      jsxs(View, { style: { flexDirection: "row", alignItems: "center", gap: 12 }, children: [
        jsx(Icon, { name: icon, size: 20, color: tone ?? colors.fg }),
        jsx(Text, { style: { fontFamily: "Exo2", fontSize: 22, fontWeight: 600, lineHeight: 30, color: tone ?? colors.fg }, children: label })
      ] }),
      jsx(Text, { style: { width: 640, fontFamily: "Exo2", fontSize: 19, lineHeight: 28, color: colors.subtle }, children: detail })
    ] });
  }
  // A line about the downloads, with a colored bar at its start (as Settings' Callout).
  function Note({ tone, children }) {
    return jsxs(View, { style: { flexDirection: "row", gap: 16, marginBottom: 12, borderRadius: radius.md, backgroundColor: colors.surface2, paddingHorizontal: 20, paddingVertical: 14 }, children: [
      jsx(View, { style: { width: 4, borderRadius: radius.pill, backgroundColor: tone } }),
      jsx(Text, { style: { width: 620, fontFamily: "Exo2", fontSize: 20, lineHeight: 28, color: colors.fg }, children })
    ] });
  }
  function ExitSheet({ summary, onClose, onExit }) {
    const t2 = useT();
    const [leaving, setLeaving] = useState(false);
    const notes = [];
    if (summary?.app) notes.push(jsx(Note, { tone: AMBER, children: t2("exit.appDownloads", { count: summary.app }) }, "app"));
    if (summary?.background) notes.push(jsx(Note, { tone: colors.glow, children: t2("exit.backgroundDownloads", { count: summary.background }) }, "background"));
    return jsx(SideSheet, { title: t2("exit.title"), subtitle: t2("exit.subtitle"), onClose, children: [
      ...notes,
      // Focus starts on "Exit": the row in Settings was already the choice, and this sheet the one confirmation.
      jsx(Choice, { focusKey: "exit:confirm", autoFocus: true, icon: "power", tone: RED, label: t2(leaving ? "exit.leaving" : "exit.confirm"), detail: t2("exit.confirmDetail"), onPress: () => {
        if (leaving) return;
        setLeaving(true);
        onExit();
      } }, "confirm"),
      jsx(Choice, { focusKey: "exit:stay", icon: "arrowLeft", label: t2("exit.stay"), detail: t2("exit.stayDetail"), onPress: onClose }, "stay")
    ] });
  }

export { ExitSheet };
