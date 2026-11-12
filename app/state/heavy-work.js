// glibren.38: os trabalhos pesados de memoria do app em segundo plano, um de cada vez: a montagem da Biblioteca TorBox
// (state/torbox-library-run.js, pico ~35 MB com a lista Orbit) e a exportacao da loja para o payload (state/store-export.js,
// pico ~25 MB). Os dois juntos, com a tela, chegavam perto do limite do heap do JS; agora um espera o outro terminar.

  var current = null;
  var waiting = 0;
  /** Roda `work()` quando nenhum outro trabalho pesado estiver rodando. `onWait()` e chamado se precisar esperar. */
  async function exclusive(work, { onWait = () => {} } = {}) {
    if (current) onWait();
    waiting++;
    try {
      while (current) await current;
    } finally {
      waiting--;
    }
    let release;
    current = new Promise((resolve) => {
      release = resolve;
    });
    try {
      return await work();
    } finally {
      current = null;
      release();
    }
  }
  /** Se ha um trabalho pesado rodando (ou esperando). */
  var heavyBusy = () => Boolean(current) || waiting > 0;

export { exclusive, heavyBusy };
