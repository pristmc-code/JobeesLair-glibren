// glibren.9: a escolha da versão da loja no topo da tela inicial (Discover), pelo controle: "Loja: Completa |
// TorBox". TorBox mostra só os jogos que a Biblioteca TorBox confirmou (state/store-mode.js); sem biblioteca
// montada, diz o porquê e oferece ir direto ao botão de montar (Configurações > Biblioteca TorBox).
// glibren.14: Cima do destaque volta para cá (STORE_BAR_UP) e Cima daqui vai para a ilha. O atalho R3 troca a
// versão de qualquer tela da loja (ui/StoreKey.jsx).

import '../assets/Exo2.ttf';
import { jsx, jsxs } from 'react/jsx-runtime';
import { useState } from 'react';
import { formatNumber2 } from '../i18n/core.js';
import { useT } from '../i18n/index.js';
import { useNavActions } from '../state/nav.jsx';
import { applyStoreMode, storeMode, useStoreMode } from '../state/store-mode.js';
import { FocusRing } from '../ui/FocusRing.jsx';
import { Icon } from '../ui/Icon.jsx';
import { colors, radius } from '../ui/colors.js';
import { Text, View } from '@ps5-react/core';

  var PILL = (chosen) => (state) => [{ position: "relative", height: 48, flexDirection: "row", alignItems: "center", gap: 10, borderRadius: radius.pill, paddingHorizontal: 22, borderWidth: 1, borderColor: chosen ? colors.accentHi : colors.line, backgroundColor: chosen ? colors.accent : colors.surface2 }, state.focused && !chosen ? { backgroundColor: colors.surface3 } : null];
  var label = (size, color, extra) => ({ fontFamily: "Exo2", fontSize: size, lineHeight: Math.round(size * 1.4), color, ...extra });
  /** O botão da versão em uso, aonde Cima do destaque (Spotlight.jsx, HeroThumbs.jsx) leva. */
  var STORE_BAR_UP = () => `storemode:${storeMode()}`;
  function Pill({ focusKey, text, icon, chosen, onPress }) {
    return jsxs(View, { focusKey, onPress, nextFocusUp: "nav:current", style: PILL(chosen), children: [
      jsx(FocusRing, { round: "full" }),
      icon ? jsx(Icon, { name: icon, size: 18, color: chosen ? colors.accentFg : colors.muted }) : null,
      jsx(Text, { style: label(20, chosen ? colors.accentFg : colors.fg, { fontWeight: 600 }), children: text })
    ] });
  }
  function StoreModeBar() {
    const t2 = useT();
    const { push, focusLater } = useNavActions();
    const { mode, count } = useStoreMode();
    const [notice, setNotice] = useState("");
    const choose = (next) => {
      if (next === mode) return;
      const { ok, reason } = applyStoreMode(next);
      if (ok) {
        setNotice("");
        focusLater(`storemode:${next}`);
      } else setNotice(reason === "empty" ? t2("storeMode.empty") : t2("storeMode.never"));
    };
    return jsxs(View, { style: { flexDirection: "row", alignItems: "center", gap: 14, minHeight: 52 }, children: [
      jsx(Text, { style: label(20, colors.muted, { fontWeight: 600, letterSpacing: 1 }), children: t2("storeMode.label") }),
      jsx(Pill, { focusKey: "storemode:full", text: t2("storeMode.full"), chosen: mode === "full", onPress: () => choose("full") }),
      jsx(Pill, { focusKey: "storemode:torbox", icon: "zap", text: count ? t2("storeMode.torboxCount", { count: formatNumber2(count) }) : t2("storeMode.torbox"), chosen: mode === "torbox", onPress: () => choose("torbox") }),
      notice ? jsx(Text, { style: label(19, "#fbbf24", { flexShrink: 1 }), children: notice }) : null,
      notice ? jsx(Pill, { focusKey: "storemode:build", icon: "settings", text: t2("storeMode.openBuilder"), chosen: false, onPress: () => push({ name: "settings", start: "torboxLibrary" }, "storemode:build") }) : null
    ] });
  }

export { STORE_BAR_UP, StoreModeBar };
