// glibren.44: o diagnostico pelo GitHub (Configuracoes > Sobre > "Enviar diagnostico"). Quem envia e o payload
// (app/native/bg_diag.c, POST /diag/send na API local): ele junta os logs, higieniza e manda para o repositorio privado
// pristmc-code/ps5-diagnosticos com a chave colada na pagina do celular (o app nunca ve a chave). O app so manda junto
// a amostra da Memoria (agora, pico e ranking) e as versoes instaladas, e acompanha a rodada pelo GET /diag.
// A ligacao com o payload vem de background-downloads.js (setDiagnosticsSource); sem ela (testes, sem payload) as
// chamadas devolvem { status: 0 }.

var source = null;
/** background-downloads.js: { status(): {status, data}, send(body): {status, data} }. */
function setDiagnosticsSource(next) {
  source = next ?? null;
}

var MAX_TOP = 10;
// A amostra da Memoria enxuta (o corpo do POST cabe folgado nos 64 KiB do payload).
function memoryPart(snapshot) {
  const pick = (item) => item && typeof item === "object" ? { used: Number(item.used) || 0, limit: Number(item.limit) || 0, action: String(item.action ?? "").slice(0, 80), at: Number(item.at) || 0,
    processUsed: item.processUsed ?? null, processSize: item.processSize ?? null } : null;
  const top = Array.isArray(snapshot?.top) ? snapshot.top.slice(0, MAX_TOP).map((item) => ({ action: String(item?.action ?? "").slice(0, 80), used: Number(item?.used) || 0 })) : [];
  return { last: pick(snapshot?.last), peak: pick(snapshot?.peak), top };
}

/** O corpo do POST /diag/send: { memory: {last, peak, top}, versions: {jobe, tube, title} }. */
function diagnosticsBody({ snapshot = null, jobe = "", tube = "", title = "" } = {}) {
  return { memory: memoryPart(snapshot), versions: { jobe: String(jobe ?? ""), tube: String(tube ?? ""), title: String(title ?? "") } };
}

var wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Pede uma rodada e espera o fim. Devolve { state: "done", folder } ou { state: "failed", error, http }.
 * error: "no-key" | "busy" | "no-payload" | "network" | "unauthorized" | "forbidden" | "no-repo" | "http" | ...
 * `progress({sent, total})` a cada consulta.
 */
async function sendDiagnostics(body, { link = source, pollMs = 1500, limitMs = 6 * 60e3, progress = () => {}, pause = wait } = {}) {
  if (!link) return { state: "failed", error: "no-payload" };
  let answer;
  try {
    answer = await link.send(body);
  } catch {
    answer = { status: 0, data: {} };
  }
  if (answer?.status !== 200) {
    const error = answer?.status === 409 ? "busy" : typeof answer?.data?.error === "string" && answer.status === 400 ? answer.data.error : "no-payload";
    return { state: "failed", error };
  }
  for (const until = Date.now() + limitMs; Date.now() < until; ) {
    await pause(pollMs);
    let state = null;
    try {
      const status = await link.status();
      state = status?.status === 200 ? status.data : null;
    } catch {
      state = null;
    }
    if (!state) continue;
    progress({ sent: Number(state.sent) || 0, total: Number(state.total) || 0 });
    if (state.state === "done") return { state: "done", folder: String(state.folder ?? "") };
    if (state.state === "failed") return { state: "failed", error: String(state.error || "http"), http: Number(state.http) || 0 };
  }
  return { state: "failed", error: "no-payload" };
}

/** A chave do GitHub esta no payload? true/false; null sem payload no ar (o estado nunca sobe o payload). */
async function diagnosticsKeyState({ link = source } = {}) {
  if (!link) return null;
  try {
    const answer = await link.status();
    return answer?.status === 200 && typeof answer.data?.configured === "boolean" ? answer.data.configured : null;
  } catch {
    return null;
  }
}

/** A chave de i18n do resultado (settings.diag.*). */
function diagnosticsMessageKey(result) {
  if (result?.state === "done") return "settings.diag.sent";
  const known = { "no-key": "noKey", busy: "busy", "no-payload": "noPayload", network: "network", unauthorized: "unauthorized", forbidden: "forbidden", "no-repo": "forbidden" };
  return `settings.diag.${known[result?.error] ?? "failed"}`;
}

export { diagnosticsBody, diagnosticsKeyState, diagnosticsMessageKey, sendDiagnostics, setDiagnosticsSource };
