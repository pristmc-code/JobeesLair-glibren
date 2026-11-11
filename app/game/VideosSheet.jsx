// "Videos" on a game's page: opens a homebrew YouTube app (ytps5, else YouTube Max'd) on a search for the game,
// its gameplay or its trailer (state/youtube.js). When neither app is installed the sheet says how to get one.
// glibren.31: the PS5 has one app in front, and launching the video app with Jobee'sLair open was refused (and is
// suspected of a console crash), so Jobee'sLair now hands over and closes: the search file also names this title
// (voltar=, the video app opens Jobee'sLair again when the player leaves it), the screen open now is saved
// (state/return-screen-run.js: the app comes back on this game's page), the background payload is asked to open the
// video app once this one closed (POST /switch, state/background-downloads.js switchAppVia), and the app closes the way
// the update's restart does (the queue marked to carry on, state/exit-app.js leaveForSwitch). Without the background
// payload nothing closes and the sheet says why. glibren.32: with Settings > "Play the first video automatically" on
// (state/auto-play-first.js) the search file also says auto=1: the app plays the first result instead of the list.

import '../assets/Exo2.ttf';
import { jsx, jsxs } from 'react/jsx-runtime';
import { useEffect, useRef, useState } from 'react';
import { tWhole, useT } from '../i18n/index.js';
import { findVideoApp, openVideos, searchText } from '../state/youtube.js';
import { autoPlayFirst } from '../state/auto-play-first.js';
import { useNavState } from '../state/nav.jsx';
import { forgetScreen, rememberScreen } from '../state/return-screen-run.js';
import { switchAppVia } from '../state/background-downloads.js';
import { downloadQueue } from '../state/downloads.js';
import { leaveForSwitch } from '../state/exit-app.js';
import { TITLE_ID } from '../version.js';
import { FocusRing } from '../ui/FocusRing.jsx';
import { LongText } from '../ui/LongText.jsx';
import { SideSheet } from '../ui/SideSheet.jsx';
import { colors, radius } from '../ui/colors.js';
import { Option } from './OptionsSheet.jsx';
import { FileSystem, Text, View } from '@ps5-react/core';

  var BODY = { width: 690, fontFamily: "Exo2", fontSize: 22, lineHeight: 32 };
  // How long "Closing Jobee'sLair" stays up before the app closes.
  var LEAVE_MS = 1500;
  function Note({ autoFocus, children }) {
    return jsxs(View, { focusable: true, autoFocus, style: (_state) => [{ position: "relative", gap: 6, borderRadius: radius.sm, paddingHorizontal: 18, paddingVertical: 12 }, _state.focused ? { backgroundColor: colors.surface2 } : null], children: [
      jsx(FocusRing, {}),
      children
    ] });
  }
  function VideosSheet({ title, onClose }) {
    const t2 = useT();
    const [app] = useState(() => findVideoApp(FileSystem));
    const [status, setStatus] = useState(null);
    const timer = useRef(null);
    const nav = useNavState();
    useEffect(() => () => clearTimeout(timer.current), []);
    const leave = () => new Promise((resolve) => {
      setStatus({ busy: true, text: t2("videos.switching", { app: app.name }) });
      timer.current = setTimeout(() => resolve(leaveForSwitch({ prepare: () => downloadQueue().prepareUpdateRestart?.() })), LEAVE_MS);
    });
    const open = (kind) => {
      if (status?.busy) return;
      setStatus({ busy: true, text: t2("videos.opening", { app: app.name }) });
      clearTimeout(timer.current);
      // A frame first, so "Opening" shows before the payload is asked.
      timer.current = setTimeout(async () => {
        const sent = await openVideos({ fs: FileSystem, name: title, kind, returnTo: TITLE_ID, autoPlay: autoPlayFirst(), switchApp: switchAppVia, leave, beforeSwitch: () => rememberScreen(nav?.stack), afterFailure: forgetScreen });
        console.log(`videos: ${app.titleId} ${sent.ok ? "switching" : `${sent.reason} ${sent.error ?? ""}`}`);
        if (sent.ok) return;
        const key = sent.reason === "write" ? "videos.writeFailed" : "videos.noPayload";
        setStatus({ bad: true, text: t2(key, { app: app.name, error: sent.error }) });
      }, 50);
    };
    if (!app) {
      return jsx(SideSheet, { title: t2("videos.title"), subtitle: title, onClose, children: jsx(View, { style: { gap: 6, padding: 9 }, children: jsxs(Note, { autoFocus: true, children: [
        jsx(Text, { style: [BODY, { fontWeight: 600, color: colors.fg }], children: t2("videos.missing") }),
        jsx(LongText, { style: [BODY, { color: colors.muted }], children: tWhole("videos.missingHow") })
      ] }) }) });
    }
    const item = (kind, label) => ({ icon: "play", label, detail: t2("videos.searchIn", { text: searchText(title, kind), app: app.name }), next: true, onSelect: () => open(kind) });
    return jsx(SideSheet, { title: t2("videos.title"), subtitle: title, onClose, children: jsxs(View, { style: { gap: 6, padding: 9 }, children: [
      jsx(Option, { item: item("gameplay", t2("videos.gameplay")), autoFocus: true, onClose }, "gameplay"),
      jsx(Option, { item: item("trailer", t2("videos.trailer")), onClose }, "trailer"),
      status ? jsx(View, { style: { paddingHorizontal: 18, paddingVertical: 12 }, children: jsx(LongText, { style: [BODY, { color: status.bad ? "#f87171" : status.busy ? colors.muted : colors.fg }], children: status.text }) }) : null
    ] }) });
  }

export { VideosSheet };
