// glibren.44: "Enviar diagnostico" em Configuracoes > Sobre (state/diagnostics.js). Quem envia e o payload; o app manda
// junto a Memoria (agora, pico, ranking) e as versoes (Jobe, tube-service em uso, titulo) e mostra o resultado:
// "Enviado (pasta ...)" ou o erro (sem chave, chave invalida/expirada, sem permissao, sem internet...).
// No PS5 nao ha campo de chave: so o estado dela ("configurada" / "cole pelo app JobeControle ou pela pagina do
// celular"); a chave e colada na pagina do celular (bg_monitor.html). Sem o simbolo de visto: as fontes do app nao o
// desenham (tests/locales.test.mjs).
// Row e Callout vem do Settings.jsx (os mesmos das outras linhas da pagina).
import { Fragment, jsx, jsxs } from 'react/jsx-runtime';
import { useEffect, useState } from 'react';
import { useT } from '../i18n/index.js';
import { diagnosticsBody, diagnosticsKeyState, diagnosticsMessageKey, sendDiagnostics } from '../state/diagnostics.js';
import { memorySample, memorySnapshot } from '../state/memory-meter.js';
import { tubeService } from '../state/tube-service.js';
import { TITLE_ID, VERSION_LABEL } from '../version.js';
import { colors } from './colors.js';
import { Icon } from './Icon.jsx';
import { Text, View } from '@ps5-react/core';
import { crashTime, dismissCrash, usePendingCrash } from '../state/crash-notice.js'; // glibren.56
import { useMinimalOpening } from '../state/opening.js'; // glibren.56

// glibren.56 (abertura minima): a queda do console nao interrompe mais; fica como uma marca discreta nesta linha (um ponto
// amarelo e "O console desligou as HH:MM durante ...") e, abaixo, "Ver detalhes" com o ultimo passo e as linhas do diario.
// Decisao do usuario (13/11): a marca fica ate o jogador apertar "Ver detalhes" (sair de Sobre nao a apaga). Ao apertar, a
// queda conta como vista (dismissCrash) e os detalhes seguem abertos pela copia guardada aqui ate sair de Sobre.
var AMBER = "#fbbf24";
function crashSaid(t2, crash) {
  const activity = t2(`crash.activity.${crash.activity}`, { name: crash.name || "?" });
  const time = crashTime(crash);
  return time ? t2("crash.detail", { time, activity }) : t2("crash.detailNoTime", { activity });
}
function useCrashMark() {
  const minimal = useMinimalOpening();
  const pending = usePendingCrash();
  return minimal ? pending : null;
}

function runningTube() {
  try {
    return tubeService().runningVersion() ?? "";
  } catch {
    return "";
  }
}

function DiagnosticsRow({ Row, Callout }) {
  const t2 = useT();
  const [state, setState] = useState({ phase: "idle", result: null, sent: 0, total: 0 });
  // null = ainda nao se sabe (payload fora do ar); true/false = a chave esta/nao esta no payload
  const [keySet, setKeySet] = useState(null);
  const pendingMark = useCrashMark();
  // A queda aberta por "Ver detalhes" (ja marcada como vista): os detalhes ficam ate sair de Sobre.
  const [opened, setOpened] = useState(null);
  const crash = pendingMark ?? opened;
  const crashOpen = opened !== null;
  const toggleCrash = () => {
    if (opened) return setOpened(null);
    setOpened(crash);
    dismissCrash();
  };
  useEffect(() => {
    let alive = true;
    diagnosticsKeyState().then((value) => {
      if (alive) setKeySet(value);
    }, () => {});
    return () => {
      alive = false;
    };
  }, [state.phase]);
  const press = () => {
    if (state.phase === "sending") return;
    setState({ phase: "sending", result: null, sent: 0, total: 0 });
    memorySample();
    const body = diagnosticsBody({ snapshot: memorySnapshot(), jobe: VERSION_LABEL, tube: runningTube(), title: TITLE_ID });
    sendDiagnostics(body, { progress: ({ sent, total }) => setState((now) => now.phase === "sending" ? { ...now, sent, total } : now) }).then(
      (result) => setState({ phase: result.state, result, sent: 0, total: 0 }),
      () => setState({ phase: "failed", result: { state: "failed", error: "no-payload" }, sent: 0, total: 0 })
    );
  };
  const detail = state.phase === "sending" ? t2("settings.diag.sending", { sent: state.sent, total: state.total || "?" })
    : state.phase === "done" ? t2("settings.diag.sent", { folder: state.result.folder })
    : crash ? crashSaid(t2, crash)
    : keySet === true ? t2("settings.diag.keySet")
    : keySet === false ? t2("settings.diag.keyMissing")
    : null;
  const failed = state.phase === "failed" ? t2(diagnosticsMessageKey(state.result), { code: state.result?.http || state.result?.error || "?" }) : null;
  return jsxs(Fragment, { children: [
    jsx(Row, { focusKey: "settings:diagnostics", name: t2("settings.diag.row"), detail, hint: t2("settings.diag.hint"), end: pendingMark && state.phase === "idle" ? jsx(View, { style: { width: 14, height: 14, borderRadius: 7, backgroundColor: AMBER } }) : jsx(Icon, { name: state.phase === "done" ? "circleCheck" : "external", color: state.phase === "done" || keySet === true ? colors.glow : colors.muted }), onPress: press }),
    crash ? jsx(Row, { focusKey: "settings:crashDetails", name: t2(crashOpen ? "crash.hideDetails" : "crash.details"), end: jsx(Icon, { name: crashOpen ? "chevronUp" : "chevronDown", color: colors.muted }), onPress: toggleCrash }) : null,
    crash && crashOpen && crash.milestone ? jsx(Text, { style: { fontFamily: "Exo2", fontSize: 19, lineHeight: 27, color: AMBER }, children: t2("crash.milestone", { step: crash.milestone }) }) : null,
    ...(crash && crashOpen ? crash.lines.map((line, index) => jsx(Text, { style: { fontFamily: "JetBrainsMono-Regular", fontSize: 15, lineHeight: 21, color: colors.subtle, numberOfLines: 1, ellipsizeMode: "tail" }, children: line }, `crash:${index}`)) : []),
    failed ? jsx(Callout, { tone: "error", children: failed }) : null
  ] });
}

export { DiagnosticsRow, runningTube };
