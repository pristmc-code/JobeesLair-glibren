// glibren.49 (Fase 2 do modelo Orbit): a versao do payload de downloads e a atualizacao propria dele, para
// Configuracoes > Sobre (ui/PayloadRows.jsx). Quem procura, confere a assinatura, baixa e troca e o proprio payload
// (app/native/bg_self.c, GET/POST /self-update na API local); o app so pede e mostra. A ligacao com o payload vem de
// background-downloads.js (setPayloadSelfSource); sem ela (testes, sem payload) as chamadas devolvem null.
import { newer } from './updater.js';

var source = null;
/** background-downloads.js: { status(), check(force), revert() }, cada um devolve { status, data }. */
function setPayloadSelfSource(next) {
  source = next ?? null;
}

var VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;
var PHASES = ["idle", "checking", "downloading", "ready", "waiting", "swapping", "current", "needs-app", "failed"];

/** O estado do payload validado ({ version, source, embedded, installed, latest, phase, percent, error, bad, ... }) ou null. */
function cleanStatus(data) {
  if (!data || typeof data !== "object" || data.ok !== true || typeof data.version !== "string" || !VERSION.test(data.version)) return null;
  const text = (value, max = 160) => typeof value === "string" ? value.slice(0, max) : "";
  const version = (value) => typeof value === "string" && VERSION.test(value) ? value : null;
  return {
    version: data.version,
    source: data.source === "downloaded" ? "downloaded" : "embedded",
    embedded: version(data.embedded),
    installed: version(data.installed),
    previous: version(data.previous),
    latest: version(data.latest),
    phase: PHASES.includes(data.phase) ? data.phase : "idle",
    percent: Number.isInteger(data.percent) ? Math.max(0, Math.min(100, data.percent)) : 0,
    error: text(data.error),
    waiting: text(data.waiting, 16),
    replace: data.replace === true,
    bad: Array.isArray(data.bad) ? data.bad.filter((item) => typeof item === "string" && VERSION.test(item)).slice(0, 16) : []
  };
}

async function ask(name, ...args) {
  const link = source;
  if (!link) return null;
  try {
    const answer = await link[name](...args);
    return answer?.status === 200 ? cleanStatus(answer.data) : null;
  } catch {
    return null;
  }
}
/** O estado agora (null: payload fora do ar ou antigo, sem a rota). */
var payloadSelfStatus = () => ask("status");
/** Procura (e baixa) uma versao nova agora, sem o intervalo de 6 h. */
var checkPayloadSelf = () => ask("check", true);
/** "Voltar ao payload embutido". */
var revertPayloadSelf = () => ask("revert");

/** Ha um baixado em uso ou a frente do embutido (o que "Voltar ao payload embutido" desfaria). */
function revertable(status) {
  if (!status) return false;
  if (status.source === "downloaded" && !status.replace) return true;
  return Boolean(status.installed && status.embedded && newer(status.installed, status.embedded) && !status.bad.includes(status.installed));
}

/** A chave e as variaveis do texto da linha (o que esta acontecendo, senao a versao em uso). */
function statusLine(status) {
  if (!status) return { key: "settings.payload.off", vars: {} };
  const target = status.latest ?? status.version;
  switch (status.phase) {
    case "checking": return { key: "settings.payload.checking", vars: {} };
    case "downloading": return { key: "settings.payload.downloading", vars: { version: target, percent: status.percent } };
    case "ready": case "waiting": case "swapping": return { key: "settings.payload.ready", vars: { version: target } };
    case "needs-app": return { key: "settings.payload.needsApp", vars: { version: target } };
    case "failed": return { key: "settings.payload.failed", vars: { error: status.error || "?" } };
    case "current": return { key: "settings.payload.current", vars: { version: status.version } };
    default: return { key: status.source === "downloaded" ? "settings.payload.downloaded" : "settings.payload.embedded", vars: { version: status.version } };
  }
}

export { checkPayloadSelf, cleanStatus, payloadSelfStatus, revertable, revertPayloadSelf, setPayloadSelfSource, statusLine };
