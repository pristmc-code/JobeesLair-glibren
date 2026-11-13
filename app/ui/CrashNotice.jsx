// pac1: "O console desligou as HH:MM durante <atividade>", uma vez por queda (state/crash-notice.js). "Ver detalhes" mostra
// o ultimo passo registrado da conversao e as ultimas linhas do diario do payload; "OK" (ou Voltar) marca como vista.
// Durante uma conversao, sugere as opcoes da conversao (Configuracoes > Downloads). Mesmo modal de ui/Ps5PkgWarning.jsx.

import '../assets/Exo2.ttf';
import { jsx, jsxs } from 'react/jsx-runtime';
import { useState } from 'react';
import { useT } from '../i18n/index.js';
import { crashTime, dismissCrash, usePendingCrash } from '../state/crash-notice.js';
import { Button2 } from './Button.jsx';
import { LongText } from './LongText.jsx';
import { colors, radius } from './colors.js';
import { useAutoDismiss, withCountdown } from './useAutoDismiss.js';
import { FocusScope, Text, View, motion } from '@ps5-react/core';

  var ENTER = { type: "tween", duration: 0.24, ease: [0.22, 1, 0.36, 1] };
  var AMBER = "#fbbf24";
  var sans = (size, color, extra) => ({ fontFamily: "Exo2", fontSize: size, lineHeight: Math.round(size * 1.42), color, ...extra });
  function CrashNotice() {
    const t2 = useT();
    const crash = usePendingCrash();
    const [details, setDetails] = useState(false);
    const ok = () => {
      setDetails(false);
      dismissCrash();
      return true;
    };
    // glibren.44: passa sozinho depois de 10 s sem nenhum botao (o mesmo que "OK": marca como visto).
    const left = useAutoDismiss(Boolean(crash), ok);
    if (!crash) return null;
    const activity = t2(`crash.activity.${crash.activity}`, { name: crash.name || "?" });
    const time = crashTime(crash);
    const said = time ? t2("crash.detail", { time, activity }) : t2("crash.detailNoTime", { activity });
    return (
      // A modal: the page's actions stop here.
      jsx(FocusScope, { trap: true, autoFocus: true, onBack: ok, onAction: () => true, children: jsx(View, { style: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0, zIndex: 72, alignItems: "center", justifyContent: "center", backgroundColor: `${colors.canvas}f2` }, children: jsxs(motion.View, {
        initial: { opacity: 0, y: 24 },
        animate: { opacity: 1, y: 0 },
        transition: ENTER,
        style: { width: details ? 1500 : 900, gap: 22, borderRadius: radius.xl, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface, padding: 48 },
        children: [
          jsx(View, { style: { alignSelf: "flex-start", borderRadius: radius.pill, backgroundColor: AMBER, paddingHorizontal: 18, paddingVertical: 4 }, children: jsx(Text, { style: sans(19, colors.canvas, { fontWeight: 600 }), children: crash.lastTime || "?" }) }),
          jsx(Text, { style: sans(40, colors.fg, { fontWeight: 600 }), children: t2("crash.title") }),
          jsx(LongText, { style: sans(24, colors.fg, { lineHeight: 34 }), children: said }),
          crash.activity === "convert" ? jsx(LongText, { style: sans(21, colors.muted, { lineHeight: 30 }), children: t2("crash.suggest") }) : null,
          details && crash.milestone ? jsx(Text, { style: sans(21, AMBER, { numberOfLines: 2, ellipsizeMode: "tail" }), children: t2("crash.milestone", { step: crash.milestone }) }) : null,
          details ? jsx(View, { style: { gap: 2, borderRadius: radius.md, backgroundColor: colors.surface2, padding: 16 }, children: crash.lines.map((line, index) => jsx(Text, { style: sans(15, colors.subtle, { numberOfLines: 1, ellipsizeMode: "tail", lineHeight: 21 }), children: line }, index)) }) : null,
          jsxs(View, { style: { flexDirection: "row", flexWrap: "wrap", gap: 16 }, children: [
            jsx(Button2, { variant: "primary", size: "lg", label: withCountdown(t2("crash.ok"), left), autoFocus: true, focusKey: "crash:ok", onPress: ok }, "ok"),
            crash.lines.length || crash.milestone ? jsx(Button2, { variant: "secondary", size: "lg", label: t2(details ? "crash.hideDetails" : "crash.details"), focusKey: "crash:details", onPress: () => setDetails(!details) }, "details") : null
          ] })
        ]
      }) }) })
    );
  }

export { CrashNotice };
