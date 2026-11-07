// glibren.16: "This PS5 .pkg won't open", asked when Install is pressed on a PS5 package (PPSA) with the console's
// firmware above 11.60 and the warning on (state/ps5-pkg-warning.js; Settings > Downloads). A PS5 fake package installs
// there but does not start (it starts only up to 11.60). "Install anyway" installs it; "Cancel" (or Back) leaves it
// waiting on Install; "Don't warn me again" turns the warning off and installs. Focus starts on Cancel.
// Same modal as ui/AutoReportAsk.jsx.

import '../assets/Exo2.ttf';
import { jsx, jsxs } from 'react/jsx-runtime';
import { useT } from '../i18n/index.js';
import { answerPs5PkgWarning, usePendingPs5PkgWarning } from '../state/ps5-pkg-warning.js';
import { Button2 } from './Button.jsx';
import { LongText } from './LongText.jsx';
import { colors, radius } from './colors.js';
import { FocusScope, Text, View, motion } from '@ps5-react/core';

  var ENTER = { type: "tween", duration: 0.24, ease: [0.22, 1, 0.36, 1] };
  var AMBER = "#fbbf24";
  var sans = (size, color, extra) => ({ fontFamily: "Exo2", fontSize: size, lineHeight: Math.round(size * 1.42), color, ...extra });
  function Ps5PkgWarning() {
    const t2 = useT();
    const asked = usePendingPs5PkgWarning();
    if (!asked) return null;
    const cancel = () => {
      answerPs5PkgWarning("cancel");
      return true;
    };
    return (
      // A modal: the page's actions stop here.
      jsx(FocusScope, { trap: true, autoFocus: true, onBack: cancel, onAction: () => true, children: jsx(View, { style: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0, zIndex: 70, alignItems: "center", justifyContent: "center", backgroundColor: `${colors.canvas}f2` }, children: jsxs(motion.View, {
        initial: { opacity: 0, y: 24 },
        animate: { opacity: 1, y: 0 },
        transition: ENTER,
        style: { width: 900, gap: 26, borderRadius: radius.xl, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface, padding: 52 },
        children: [
          jsx(View, { style: { alignSelf: "flex-start", borderRadius: radius.pill, backgroundColor: AMBER, paddingHorizontal: 18, paddingVertical: 4 }, children: jsx(Text, { style: sans(19, colors.canvas, { fontWeight: 600 }), children: `FPKG \xB7 ${asked.firmware}` }) }),
          jsx(Text, { style: sans(40, colors.fg, { fontWeight: 600 }), children: t2("ps5Pkg.title") }),
          asked.title ? jsx(Text, { style: sans(23, colors.subtle, { numberOfLines: 1, ellipsizeMode: "tail" }), children: asked.title }) : null,
          // Longer than one Text node keeps in most languages (ui/LongText.jsx).
          jsx(LongText, { style: sans(23, colors.fg, { lineHeight: 34 }), children: t2("ps5Pkg.detail", { firmware: asked.firmware }) }),
          jsxs(View, { style: { flexDirection: "row", flexWrap: "wrap", gap: 16 }, children: [
            jsx(Button2, { variant: "primary", size: "lg", icon: "download", label: t2("ps5Pkg.install"), focusKey: "ps5pkg:install", onPress: () => answerPs5PkgWarning("install") }, "install"),
            jsx(Button2, { variant: "secondary", size: "lg", label: t2("ps5Pkg.cancel"), autoFocus: true, focusKey: "ps5pkg:cancel", onPress: cancel }, "cancel"),
            jsx(Button2, { variant: "secondary", size: "lg", label: t2("ps5Pkg.never"), focusKey: "ps5pkg:never", onPress: () => answerPs5PkgWarning("never") }, "never")
          ] })
        ]
      }) }) })
    );
  }

export { Ps5PkgWarning };
