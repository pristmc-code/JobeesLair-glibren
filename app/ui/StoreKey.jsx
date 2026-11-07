// glibren.14: o atalho R3 (apertar o analógico direito) troca a versão da loja, Completa <-> TorBox
// (state/store-mode.js), de qualquer tela da loja (Discover, ficha do jogo, busca), sem ir até a barra do topo do
// Discover. O R3 não é uma ação do ps5-react (só os botões de input.js são): ele vem dos eventos do controle
// (useControllerEvents), ouvidos só enquanto uma tela da loja está à vista. Vale quando o rodapé mostra a dica dele
// (ui/Legend.jsx storeKeyLive): com um painel, o teclado ou o filtro abertos, não. Um aviso curto diz em que loja
// ficou e quantos jogos ela tem; sem a Biblioteca TorBox montada, diz o porquê e a loja não muda.

import { jsx } from 'react/jsx-runtime';
import { useEffect, useState } from 'react';
import { AnimatePresence, useControllerEvents } from '@ps5-react/core';
import { useT } from '../i18n/index.js';
import { useIsImmersive, useNavActions, useNavState } from '../state/nav.jsx';
import { toggleStoreMode } from '../state/store-mode.js';
import { STORE_KEY_SCREENS, storeKeyLive } from './Legend.jsx';
import { Toast } from './Toast.jsx';
import { HOMEBREW_ONLY } from '../edition.js';

  var TOAST_MS = 4e3;
  /** O aviso de uma troca (toggleStoreMode): a loja em que ficou e quantos jogos, ou por que não trocou. */
  function storeKeyNotice(result, t2) {
    if (!result.ok) return { icon: "alert", failed: true, status: t2("storeMode.cantSwitch"), title: t2("hints.storeTorbox"), detail: result.reason === "empty" ? t2("storeMode.empty") : t2("storeMode.never") };
    return { icon: result.mode === "torbox" ? "zap" : "disc", failed: false, status: t2("storeMode.switched"), title: t2(result.mode === "torbox" ? "hints.storeTorbox" : "hints.storeFull"), detail: t2("catalog.gameCount", { count: result.count }) };
  }
  /** Um R3 apertado em `screen`: troca a loja (se vale agora) e diz o que houve; null quando não vale. */
  function pressStoreKey(screen2, { focusLater } = {}) {
    if (!storeKeyLive(screen2)) return null;
    const result = toggleStoreMode();
    // No Discover a página é montada de novo (index.jsx, storeEpoch): o foco vai para a versão escolhida, no topo.
    if (result.ok && screen2 === "browse") focusLater?.(`storemode:${result.mode}`);
    return result;
  }
  function StoreKey() {
    const t2 = useT();
    const { top } = useNavState();
    const { focusLater } = useNavActions();
    const immersive = useIsImmersive();
    const [notice, setNotice] = useState(null);
    const listening = !HOMEBREW_ONLY && !immersive && STORE_KEY_SCREENS.has(top.name);
    useControllerEvents(listening ? (event) => {
      if (event.type !== "press" || event.button !== "r3") return;
      const result = pressStoreKey(top.name, { focusLater });
      if (result) setNotice((last) => ({ ...storeKeyNotice(result, t2), n: (last?.n ?? 0) + 1 }));
    } : null);
    useEffect(() => {
      if (!notice) return void 0;
      const id = setTimeout(() => setNotice(null), TOAST_MS);
      return () => clearTimeout(id);
    }, [notice]);
    return jsx(AnimatePresence, { children: notice ? jsx(Toast, { icon: notice.icon, status: notice.status, title: notice.title, detail: notice.detail, failed: notice.failed, duration: TOAST_MS }, notice.n) : null });
  }

export { StoreKey, pressStoreKey, storeKeyNotice };
