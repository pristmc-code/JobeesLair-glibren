// glibren.5: o botao "Sair da Jobee'sLair" (Configuracoes, no fim da coluna das categorias; ui/ExitSheet.jsx).
//
// Antes, para fechar o app o jogador usava o PS5 (e, quando o console travou, fechou forcando). Agora o app fecha
// sozinho: primeiro avisa o payload de segundo plano (POST /bye, background-downloads.js sayByeToPayload), para ele
// contar o app como fechado ja, sem esperar ~15 s de silencio, e aplicar a pausa ao fechar conforme a opcao; espera a
// resposta por no maximo BYE_WAIT_MS e fecha mesmo sem ela (BackHandler.exitApp, como update.js restartToApply).

import { BackHandler } from '@ps5-react/core';
import { BUSY } from './download-queue.js';
import { inBackground, sayByeToPayload } from './background-downloads.js';
import { forgetScreen } from './return-screen-run.js';

  var BYE_WAIT_MS = 1e3;
  /**
   * O que a folha de saida conta: `app`, os downloads (e extracoes, instalacoes) que o proprio app faz agora, que param
   * ao fechar e continuam de onde pararam quando ele abrir de novo; `background`, os que o payload baixa, que continuam.
   * `jobs`: o snapshot da fila; `owned(destination)`: se o payload baixa aquele destino.
   */
  function exitSummary(jobs, owned = inBackground) {
    let app = 0, background = 0;
    for (const job of jobs ?? []) {
      if (!BUSY.includes(job?.state)) continue;
      if (owned(job.downloadDestination)) ++background;
      else if (job.state !== "queued") ++app;
    }
    return { app, background };
  }
  /**
   * Avisa o payload (no maximo `waitMs`) e fecha o app. `bye` e `exit` trocados nos testes. glibren.31: `forget` apaga a
   * tela guardada para a volta do app de videos (return-screen-run.js): quem sai pelo botao reabre no inicio.
   * `prepare`: chamado antes de avisar o payload (a troca para o app de videos marca a fila, como a atualizacao).
   */
  /**
   * glibren.31: fecha o app para o app de videos abrir (POST /switch ja aceito pelo payload): guarda a tela (nao esquece),
   * marca a fila para voltar sozinha quando a Jobe reabrir (prepareUpdateRestart, via `prepare`), avisa o payload e fecha.
   */
  function leaveForSwitch(options = {}) {
    return leaveApp({ ...options, forget: null });
  }
  async function leaveApp({ bye = sayByeToPayload, exit = () => BackHandler.exitApp(), waitMs = BYE_WAIT_MS, log = (line) => console.log(`[exit] ${line}`), forget = forgetScreen, prepare = null } = {}) {
    try {
      forget?.();
    } catch {
    }
    try {
      prepare?.();
    } catch (error) {
      log(`before closing: ${error?.message ?? error}`);
    }
    let timer = null;
    const told = await Promise.race([
      Promise.resolve().then(bye).then((answer) => answer ? "told" : "not told", () => "not told"),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve("no answer in time"), waitMs);
      })
    ]);
    clearTimeout(timer);
    log(`closing the app (background helper: ${told})`);
    exit();
    return told;
  }

export { BYE_WAIT_MS, exitSummary, leaveApp, leaveForSwitch };
