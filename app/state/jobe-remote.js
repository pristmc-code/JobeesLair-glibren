// glibren.44: "Atualizar a Jobe" pela pagina do celular (e pelo app JobeControle). O payload so guarda o pedido
// (app/native/bg_jobe.c); quem atualiza e o app: a cada `everyMs` ele manda o estado dele (versao instalada, a ultima
// publicada que ja conhece, a fase da atualizacao) e pergunta se ha pedido. Com um pedido novo ele o assume ("taken":
// sai da fila do payload) e roda o mesmo fluxo de state/update.js: procurar -> baixar -> reiniciar para aplicar, com as
// travas de sempre: so no console (canInstall), nunca com uma conversao para .exfat em andamento, e o reiniciar espera
// o que o proprio app faz (restartToApply / applyWhenIdle) e nunca abre app por cima de outro (o updater.elf reabre a
// Jobe depois de ela fechar). Um pedido feito com a Jobe fechada fica no payload (24 h) e e atendido quando ela abrir.
// Este arquivo nao importa o runtime: a ligacao com o payload vem de background-downloads.js (setJobeSource) e o
// fluxo de state/update.js vem de jobe-remote-run.js.

var source = null;
/** background-downloads.js: { request(), report(body), conversions() }. */
function setJobeSource(next) {
  source = next ?? null;
}
var ACTIVE_CONVERSION = ["queued", "extracting", "converting", "verifying"];
var DOWNLOAD_LIMIT_MS = 3 * 3600e3;
var sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
var percentOf = (install) => install?.total ? Math.floor(Math.min(1, (Number(install.written) || 0) / install.total) * 100) : 0;

/**
 * `update`: { canInstall, check(): {update, checkedAt, failed}, snapshot(): {update, install, auto}, download(): boolean,
 * restart(): "" ou o motivo }. `text(key, vars)`: as mensagens no idioma do jogador; `notify(text)`: o aviso do sistema.
 */
function createJobeRemote({ link = () => source, update, version, text = (key) => key, notify = () => {}, log = () => {}, stepMs = 1e3, pause = sleep, now = Date.now }) {
  let view = { phase: "idle", percent: 0, error: "", detail: "" };
  let running = false;
  const handled = new Set();
  const set = (next) => {
    view = { ...view, error: "", detail: "", ...next };
  };
  function body(taken) {
    const snap = update.snapshot?.() ?? {};
    const latest = snap.update?.update?.version ?? (snap.update?.checkedAt && !snap.update?.failed ? version : "");
    return { installed: version, latest: latest || "", checkedAt: Math.floor((Number(snap.update?.checkedAt) || 0) / (snap.update?.checkedAt > 1e11 ? 1e3 : 1)), phase: view.phase,
      percent: view.percent, error: view.error, detail: String(view.detail ?? "").slice(0, 230), auto: snap.auto === true, ...taken ? { taken } : {} };
  }
  async function report(taken) {
    const target = link();
    if (!target) return;
    try {
      await target.report(body(taken));
    } catch {
    }
  }
  const fail = (error, detail) => {
    set({ phase: "failed", error, detail: detail ?? "" });
    log(`update requested on the phone: ${error}${detail ? ` (${detail})` : ""}`);
  };
  async function run(id, target) {
    running = true;
    try {
      set({ phase: "checking", percent: 0 });
      await report(id);
      log(`update requested on the phone (${id})`);
      notify(text("update.remote.requested"));
      if (!update.canInstall) return fail("console-only", text("update.install.consoleOnly"));
      let conversions = null;
      try {
        conversions = await target.conversions?.();
      } catch {
        conversions = null;
      }
      if (Array.isArray(conversions) && conversions.some((item) => ACTIVE_CONVERSION.includes(item?.state))) return fail("busy-convert", text("update.remote.busyConvert"));
      let checked = await update.check();
      for (let i = 0; i < 60 && update.snapshot().update?.checking; i++) await pause(stepMs); // outra procura ja em andamento
      checked = update.snapshot().update ?? checked;
      if (checked?.failed) return fail("check-failed", text("settings.update.failed"));
      const found = checked?.update;
      if (!found?.version) {
        set({ phase: "current", detail: text("update.remote.current", { version }) });
        return;
      }
      // glibren.46 (A-M1): sem a assinatura do glibren a versao nova nao e instalada; a Jobe fica na atual.
      if (found.unsigned) return fail("unsigned", text("settings.update.unsigned", { version: found.version }));
      const installState = () => update.snapshot().install ?? {};
      if (!["ready", "armed"].includes(installState().phase) || installState().version !== found.version) {
        if (!update.download() && !["waiting", "downloading", "checking", "ready", "armed"].includes(installState().phase)) return fail("download-failed", installState().error || "");
        for (const until = now() + DOWNLOAD_LIMIT_MS; ; ) {
          const install = installState();
          if (["ready", "armed"].includes(install.phase)) break;
          if (install.phase === "failed") return fail("download-failed", install.error || "");
          if (now() > until) return fail("download-failed", "");
          set({ phase: "downloading", percent: percentOf(install) });
          await report();
          await pause(stepMs);
        }
      }
      set({ phase: "ready", percent: 100 });
      await report();
      const reason = update.restart();
      if (reason) return fail("restart-refused", reason);
      set({ phase: "restarting", percent: 100 });
    } catch (problem) {
      fail("failed", problem?.message ?? String(problem));
    } finally {
      running = false;
      await report();
    }
  }
  /** Uma volta: manda o estado e assume um pedido novo. */
  async function tick() {
    const target = link();
    if (!target || running) return;
    let request = null;
    try {
      const answer = await target.request();
      request = answer?.status === 200 ? answer.data?.request : null;
    } catch {
      request = null;
    }
    const id = typeof request?.id === "string" ? request.id : "";
    if (id && !handled.has(id)) {
      handled.add(id);
      await run(id, target);
      return;
    }
    await report();
  }
  return { tick, state: () => view, busy: () => running };
}

export { createJobeRemote, setJobeSource };
