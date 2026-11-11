// glibren.31: a tela guardada para a volta do app de videos (state/return-screen.js) no arquivo de verdade, em DATA_DIR.
// Sem o catalogo aqui: quem monta a pilha (state/nav.jsx) diz quais jogos existem.

import { FileSystem } from '@ps5-react/core';
import { DATA_DIR } from './data-dir.js';
import { RETURN_FILE, forgetReturnScreen, saveReturnScreen, takeReturnScreen } from './return-screen.js';

  var RETURN_PATH = `${DATA_DIR}/${RETURN_FILE}`;
  var log = (line) => console.log(`jobeeslair: ${line}`);
  var taken = false;
  /** Guarda a pilha de telas antes de abrir o app de videos. */
  function rememberScreen(stack) {
    try {
      FileSystem.mkdir(DATA_DIR, { recursive: true });
    } catch {
    }
    return saveReturnScreen(FileSystem, RETURN_PATH, stack, { log });
  }
  /** A abertura seguinte comeca no inicio (o app de videos nao abriu; a atualizacao ou Sair fecham o app). */
  function forgetScreen() {
    forgetReturnScreen(FileSystem, RETURN_PATH);
  }
  /**
   * A pilha para a primeira montagem da navegacao: a guardada (apagada ao ler) ou null. Uma vez por execucao do app:
   * a navegacao remontada (troca de tema) comeca no inicio, como antes.
   */
  function takeStartStack(root, isGame) {
    if (taken) return null;
    taken = true;
    try {
      return takeReturnScreen(FileSystem, RETURN_PATH, root, { isGame, log });
    } catch (error) {
      log(`return screen: ${error?.message ?? error}`);
      return null;
    }
  }

export { RETURN_PATH, forgetScreen, rememberScreen, takeStartStack };
