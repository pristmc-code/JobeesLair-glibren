// glibren.44: o que o jogador esta fazendo agora, para o que so pode acontecer quando ele nao esta usando a Jobee'sLair:
// o reinicio sozinho da atualizacao automatica (state/auto-restart.js) e os avisos da abertura que passam sozinhos
// (ui/useAutoDismiss.js).
//   - o controle: a hora do ultimo botao apertado (Controller.subscribe, eventos "press") e quem quer saber de cada
//     aperto (a contagem de um aviso para no primeiro);
//   - midia tocando: o player do YouTube (tube/TubePlayer.jsx) segura enquanto esta aberto (holdMedia);
//   - um dialogo aberto: quem abre um segura (holdDialog); o reinicio espera ele fechar.
// Nada aqui guarda historico: so a ultima hora e contadores.

import { Controller } from '@ps5-react/core';

  var lastInput = Date.now();
  var media = 0;
  var dialogs = 0;
  var pressListeners = /* @__PURE__ */ new Set();
  var started = false;
  /** Comeca a ouvir o controle (uma vez; os testes passam o seu `controller` e `now`). */
  function startActivity({ controller = Controller, now = Date.now } = {}) {
    if (started) return;
    started = true;
    lastInput = now();
    try {
      controller.subscribe((event) => {
        if (event?.type !== "press") return;
        noteInput(event, now());
      });
    } catch (error) {
      console.log(`[activity] controller not watched: ${error?.message ?? error}`);
    }
  }
  /** Um botao apertado (o que o controle avisa; os testes chamam direto). */
  function noteInput(event = { type: "press" }, at = Date.now()) {
    lastInput = at;
    for (const listener of [...pressListeners]) {
      try {
        listener(event);
      } catch {
      }
    }
  }
  /** Ha quanto tempo (ms) nenhum botao foi apertado. */
  var idleFor = (now = Date.now()) => Math.max(0, now - lastInput);
  /** `listener(evento)` a cada botao apertado; devolve quem para. */
  function onPress(listener) {
    pressListeners.add(listener);
    return () => pressListeners.delete(listener);
  }
  function counter(add) {
    add(1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      add(-1);
    };
  }
  /** Video tocando (o player): devolve quem solta. */
  var holdMedia = () => counter((n) => media = Math.max(0, media + n));
  /** Um dialogo aberto: devolve quem solta. */
  var holdDialog = () => counter((n) => dialogs = Math.max(0, dialogs + n));
  var mediaPlaying = () => media > 0;
  var dialogOpen = () => dialogs > 0;
  /** Para os testes: tudo como no comeco. */
  function resetActivity(at = Date.now()) {
    lastInput = at;
    media = 0;
    dialogs = 0;
    pressListeners.clear();
  }

export { dialogOpen, holdDialog, holdMedia, idleFor, mediaPlaying, noteInput, onPress, resetActivity, startActivity };
