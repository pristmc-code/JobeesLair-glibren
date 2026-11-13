// glibren.45: quanto trabalho pesado cabe num quadro, no console. O relogio do JavaScript no ps5-react (Date.now() e
// performance.now(), o "engine clock" do embeddedReact) so anda ENTRE quadros: dentro de um quadro ele fica parado. Um
// laco que cedia o quadro "a cada 6 ms de trabalho" (feed-format.js finishPaced, store-export.js) nunca via o tempo passar
// e rodava tudo de uma vez: a atualizacao dos feeds 8 s depois de abrir e a exportacao da loja 20 s depois travavam a tela
// e seguravam um nucleo por segundos (o log do catalogo dizia "836310 bytes in 0 ms").
// Aqui o trabalho e contado em passos (o `yield` de um gerador, um jogo, um lote): cada parte roda `units` passos e
// devolve o quadro; na parte seguinte, o tempo que passou desde a anterior (esse o relogio mede: a parte e o desenho do
// quadro) ajusta `units`: um quadro ate `calm` ms deixa a proxima parte 25% maior, um acima de `limit` corta pela metade.
// Fora do console (testes, qjs) o relogio anda sempre, e a conta vale do mesmo jeito.

  var CALM_MS = 18;
  var LIMIT_MS = 25;
  // Com a tela parada (o jogador esperando a loja), partes maiores: so um quadro capado (50 ms no motor) corta.
  var HURRY_CALM_MS = 45;
  var HURRY_LIMIT_MS = 49;
  /**
   * -> { begin(): passos desta parte, spend(n=1): true quando a parte acabou, hurry(), units(), slowest() }. `now` so para
   * os testes.
   */
  function createFramePace({ start = 4, max = 4096, now = () => Date.now() } = {}) {
    let units = start, last = null, used = 0, worst = 0;
    let calm = CALM_MS, limit = LIMIT_MS;
    return {
      begin() {
        const at = now();
        if (last !== null) {
          const took = at - last;
          if (took > worst) worst = took;
          if (took > limit) units = Math.max(1, Math.floor(units / 2));
          else if (took <= calm) units = Math.min(max, Math.ceil(units * 1.25));
        }
        last = at;
        used = 0;
        return units;
      },
      spend(n = 1) {
        used += n;
        return used >= units;
      },
      hurry() {
        calm = HURRY_CALM_MS;
        limit = HURRY_LIMIT_MS;
      },
      units: () => units,
      /** O maior intervalo entre duas partes (ms): o quadro mais lento enquanto o trabalho durou. */
      slowest: () => worst
    };
  }
  /** Roda um gerador ate o fim, `pause()` (um quadro) entre as partes. -> o valor do gerador. */
  async function finishFramed(steps, pause, pace = createFramePace()) {
    pace.begin();
    for (; ; ) {
      const step = steps.next();
      if (step.done) return step.value;
      if (pace.spend()) {
        await pause();
        pace.begin();
      }
    }
  }

export { CALM_MS, LIMIT_MS, createFramePace, finishFramed };
