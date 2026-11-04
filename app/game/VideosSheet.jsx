// "Videos" on a game's page: opens a homebrew YouTube app (ytps5, else YouTube Max'd) on a search for the game,
// its gameplay or its trailer (state/youtube.js). Nothing open is closed: the app comes up over Jobee'sLair. When
// neither app is installed the sheet says how to get one; when the launch fails it says why.

import '../assets/Exo2.ttf';
import { jsx, jsxs } from 'react/jsx-runtime';
import { useEffect, useRef, useState } from 'react';
import { tWhole, useT } from '../i18n/index.js';
import { PAYLOAD_DIR } from '../state/homebrew-store.js';
import { findVideoApp, launchAnswer, openVideos, searchText } from '../state/youtube.js';
import { FocusRing } from '../ui/FocusRing.jsx';
import { LongText } from '../ui/LongText.jsx';
import { SideSheet } from '../ui/SideSheet.jsx';
import { colors, radius } from '../ui/colors.js';
import { Option } from './OptionsSheet.jsx';
import { FileSystem, Payloads, Platform, Text, View } from '@ps5-react/core';

  var BODY = { width: 690, fontFamily: "Exo2", fontSize: 22, lineHeight: 32 };
  // The helper answers in launch.txt once the system took the launch; read back after this.
  var ANSWER_MS = 2500;
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
    useEffect(() => () => clearTimeout(timer.current), []);
    const open = (kind) => {
      if (status?.busy) return;
      setStatus({ busy: true, text: t2("videos.opening", { app: app.name }) });
      clearTimeout(timer.current);
      // A frame first, so "Opening" shows before the payload is sent.
      timer.current = setTimeout(() => {
        const sent = openVideos({ fs: FileSystem, payloads: Platform.OS === "ps5" ? Payloads : null, name: title, kind, payloadDir: PAYLOAD_DIR });
        if (!sent.ok) {
          const key = sent.reason === "write" ? "videos.writeFailed" : "videos.sendFailed";
          return setStatus({ bad: true, text: t2(key, { app: app.name, error: sent.error }) });
        }
        timer.current = setTimeout(() => {
          const answer = launchAnswer(FileSystem, PAYLOAD_DIR);
          console.log(`videos: ${app.titleId} ${answer.state} ${answer.code}`);
          if (answer.state === "launched") return onClose();
          if (answer.state === "running") return setStatus({ text: t2("videos.running", { app: app.name }) });
          if (answer.state === "failed") return setStatus({ bad: true, text: t2("videos.failed", { app: app.name, code: answer.code }) });
          setStatus({ bad: true, text: t2("videos.noAnswer") });
        }, ANSWER_MS);
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
