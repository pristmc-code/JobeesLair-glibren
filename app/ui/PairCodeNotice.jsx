// Pareamento por aparelho: o codigo de 6 digitos na tela da Jobe enquanto ele vale (state/device-pairing.js; o payload
// tambem manda a notificacao do sistema). So mostra: nao pega o foco nem segura botao nenhum (o jogador continua usando a
// Jobe), fica no canto de cima e some sozinho quando o codigo e usado ou vence. Texto quebra linha (sem reticencias).

import '../assets/Exo2.ttf';
import { jsx, jsxs } from 'react/jsx-runtime';
import { useEffect, useState } from 'react';
import { useT } from '../i18n/index.js';
import { usePairCode } from '../state/device-pairing.js';
import { colors, radius } from './colors.js';
import { Text, View } from '@ps5-react/core';

  var WIDTH = 640;
  var PAD = 32;
  var sans = (size, color, extra) => ({ fontFamily: "Exo2", fontSize: size, lineHeight: Math.round(size * 1.42), color, ...extra });
  function PairCodeNotice({ state: given = null, now = Date.now }) {
    const t2 = useT();
    const live = usePairCode();
    const state = given ?? live;
    const [, tick] = useState(0);
    const on = Boolean(state?.code) && state.until > now();
    useEffect(() => {
      if (!on) return void 0;
      const id = setInterval(() => tick((n) => n + 1), 1e3);
      return () => clearInterval(id);
    }, [on]);
    if (!on) return null;
    const seconds = Math.max(0, Math.ceil((state.until - now()) / 1e3));
    const spaced = `${state.code.slice(0, 3)} ${state.code.slice(3)}`;
    const inner = WIDTH - 2 * PAD;
    return jsx(View, { style: { position: "absolute", top: 120, right: 64, zIndex: 96, width: WIDTH, borderRadius: radius.xl, borderWidth: 2, borderColor: colors.glow, backgroundColor: colors.surface, padding: PAD }, children: jsxs(View, { style: { gap: 10 }, children: [
      jsx(Text, { style: sans(24, colors.muted, { width: inner }), children: t2("pair.notice.title", { name: state.name || "?" }) }),
      jsx(Text, { style: sans(84, colors.fg, { width: inner, fontWeight: 700, letterSpacing: 8 }), children: spaced }),
      jsx(Text, { style: sans(21, colors.muted, { width: inner }), children: t2("pair.notice.detail", { seconds: String(seconds) }) })
    ] }) });
  }

export { PairCodeNotice };
