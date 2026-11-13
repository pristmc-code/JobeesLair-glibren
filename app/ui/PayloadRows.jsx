// glibren.49 (Fase 2): "Payload de downloads" e "Voltar ao payload embutido" em Configuracoes > Sobre
// (state/payload-self.js). A linha mostra a versao em uso (embutida ou baixada e assinada) ou o que esta acontecendo
// (procurando, baixando, pronta esperando ficar ocioso, precisa de uma Jobe nova, falhou); apertar procura uma versao
// nova agora. "Voltar ao payload embutido" so aparece com um baixado em uso ou a frente do embutido.
// Row e Callout vem do Settings.jsx (os mesmos das outras linhas da pagina).
import { Fragment, jsx, jsxs } from 'react/jsx-runtime';
import { useEffect, useState } from 'react';
import { useT } from '../i18n/index.js';
import { checkPayloadSelf, payloadSelfStatus, revertable, revertPayloadSelf, statusLine } from '../state/payload-self.js';
import { colors } from './colors.js';
import { Icon } from './Icon.jsx';

var BUSY = ["checking", "downloading", "swapping"];

function PayloadRows({ Row }) {
  const t2 = useT();
  const [status, setStatus] = useState(null);
  const [done, setDone] = useState("");
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    let timer = null;
    const load = () => payloadSelfStatus().then((next) => {
      if (!alive) return;
      setStatus(next);
      // enquanto procura/baixa/troca, de 2 em 2 s; parado, nada
      timer = next && BUSY.includes(next.phase) ? setTimeout(load, 2e3) : null;
    }, () => {});
    load();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [done, tick]);
  const line = statusLine(status);
  const check = () => {
    if (status && BUSY.includes(status.phase)) return;
    setStatus((now) => now ? { ...now, phase: "checking" } : now);
    checkPayloadSelf().then(() => setTick((n) => n + 1), () => {});
  };
  const revert = () => {
    revertPayloadSelf().then((next) => {
      setStatus(next);
      setDone(t2("settings.payload.reverted"));
    }, () => {});
  };
  return jsxs(Fragment, { children: [
    jsx(Row, { focusKey: "settings:payload", name: t2("settings.payload.row"), detail: t2(line.key, line.vars), hint: t2("settings.payload.hint"),
      end: jsx(Icon, { name: "restart", color: status?.source === "downloaded" ? colors.glow : colors.muted }), onPress: check }),
    revertable(status) || done ? jsx(Row, { focusKey: "settings:payloadRevert", name: t2("settings.payload.revert"), detail: done || null, hint: t2("settings.payload.revertHint"),
      icon: done ? null : "chevronRight", onPress: done ? void 0 : revert }) : null
  ] });
}

export { PayloadRows };
