// glibren.44: o aviso do reinicio sozinho da atualizacao automatica (state/auto-restart.js): "Atualizando para X em
// N s" com o botao "Adiar" (focado; X ou O adiam 30 min). Qualquer outro botao cancela a contagem no proprio vigia.

import '../assets/Exo2.ttf';
import { jsx, jsxs } from 'react/jsx-runtime';
import { useEffect, useState } from 'react';
import { useT } from '../i18n/index.js';
import { autoRestart, useAutoRestart } from '../state/auto-restart.js';
import { Button2 } from './Button.jsx';
import { colors, radius } from './colors.js';
import { FocusScope, Text, View } from '@ps5-react/core';

  var sans = (size, color, extra) => ({ fontFamily: "Exo2", fontSize: size, lineHeight: Math.round(size * 1.42), color, ...extra });
  function AutoRestartNotice({ state: given = null, now = Date.now }) {
    const t2 = useT();
    const live = useAutoRestart();
    const state = given ?? live;
    const [, tick] = useState(0);
    const counting = state?.phase === "countdown";
    useEffect(() => {
      if (!counting) return void 0;
      const id = setInterval(() => tick((n) => n + 1), 250);
      return () => clearInterval(id);
    }, [counting]);
    if (!counting && state?.phase !== "restarting") return null;
    const seconds = Math.max(0, Math.ceil((state.endsAt - now()) / 1e3));
    const postpone = () => {
      autoRestart()?.postpone();
      return true;
    };
    return jsx(FocusScope, { trap: true, autoFocus: true, onBack: postpone, onAction: () => true, children: jsx(View, { style: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0, zIndex: 95, alignItems: "center", justifyContent: "center", backgroundColor: `${colors.canvas}e6` }, children: jsxs(View, { style: { width: 900, gap: 22, borderRadius: radius.xl, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface, padding: 48 }, children: [
      jsx(Text, { style: sans(36, colors.fg, { fontWeight: 600, width: 804 }), children: state.phase === "restarting" ? t2("update.autoRestart.now", { version: state.version ?? "" }) : t2("update.autoRestart.title", { version: state.version ?? "", seconds: String(seconds) }) }),
      jsx(Text, { style: sans(22, colors.muted, { width: 804 }), children: t2("update.autoRestart.detail") }),
      state.phase === "countdown" ? jsx(View, { style: { flexDirection: "row" }, children: jsx(Button2, { variant: "primary", size: "lg", icon: "pause", label: t2("update.autoRestart.postpone"), autoFocus: true, focusKey: "autorestart:postpone", onPress: postpone }) }) : null
    ] }) }) });
  }

export { AutoRestartNotice };
