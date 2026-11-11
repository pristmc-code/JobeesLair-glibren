// glibren-a: o pedido do glibren para tocar YouTube (state/tube-request.js) no FileSystem de verdade. No PS5 a pasta e
// /data/JobeesLair/tube (a do tube-service.js, que o glibren le e grava); fora dele, `tube` na pasta de dados do app.
// A edicao so-Homebrew nao anuncia nem le: o pedido e para a Jobee'sLair (a loja), que o glibren abre.

import { FileSystem, Platform } from '@ps5-react/core';
import { HOMEBREW_ONLY } from '../edition.js';
import { DATA_DIR } from './data-dir.js';
import { TUBE_DIR } from './tube-service.js';
import { switchAppVia } from './background-downloads.js';
import { downloadQueue } from './downloads.js';
import { leaveForSwitch } from './exit-app.js';
import { forgetScreen } from './return-screen-run.js';
import { TITLE_ID } from '../version.js';
import { returnToCaller, takeTubeRequest, tubeRequestStack, writeTubeCapability } from './tube-request.js';

  var log = (line) => console.log(`jobeeslair: ${line}`);
  var requestDir = () => Platform.OS === "ps5" ? TUBE_DIR : `${DATA_DIR}/tube`;
  var taken = false;
  /** A cada abertura: diz ao glibren que esta Jobe abre o YouTube por pedido (jobe-tube.txt, "api=1"). */
  function advertiseTube() {
    if (HOMEBREW_ONLY) return false;
    return writeTubeCapability(FileSystem, requestDir(), { log });
  }
  /**
   * A pilha para a primeira montagem da navegacao quando o glibren pediu YouTube (o pedido e a tela guardada sao
   * apagados), ou null. Uma vez por execucao: a navegacao remontada (troca de tema) nao abre de novo.
   */
  function takeTubeStartStack(root) {
    if (taken || HOMEBREW_ONLY) return null;
    taken = true;
    try {
      const request = takeTubeRequest(FileSystem, requestDir(), { log });
      if (!request) return null;
      forgetScreen();
      return tubeRequestStack(request, root);
    } catch (error) {
      log(`tube request: ${error?.message ?? error}`);
      return null;
    }
  }
  /** Volta ao glibren (ou outro `to`): POST /switch ao payload de fundo e fecha. { ok } ou { ok: false, error }. */
  function backToCaller(to) {
    return returnToCaller(to, { from: TITLE_ID, switchApp: switchAppVia, leave: leaveForSwitch, prepare: () => downloadQueue().prepareUpdateRestart?.(), log });
  }

export { advertiseTube, backToCaller, requestDir, takeTubeStartStack };
