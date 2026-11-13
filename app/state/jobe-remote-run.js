// glibren.44: liga o "Atualizar a Jobe" da pagina do celular (state/jobe-remote.js) ao fluxo da atualizacao do app
// (state/update.js). Uma vez por execucao (index.jsx), so no PS5: a primeira volta logo depois de abrir (um pedido feito
// com a Jobe fechada e atendido aqui) e depois a cada EVERY_MS.
import { Notifications, Platform } from '@ps5-react/core';
import { t } from '../i18n/core.js';
import { canInstall, checkForUpdate, downloadUpdate, restartToApply, updateSnapshot } from './update.js';
import { createJobeRemote } from './jobe-remote.js';
import { VERSION } from '../version.js';

  var FIRST_MS = 6e3;
  var EVERY_MS = 5e3;
  var started = false;
  function startJobeRemote() {
    if (started || Platform.OS !== "ps5") return () => {};
    started = true;
    const remote = createJobeRemote({
      update: { canInstall, check: () => checkForUpdate(), snapshot: updateSnapshot, download: downloadUpdate, restart: restartToApply },
      version: VERSION,
      text: (key, vars) => t(key, vars),
      notify: (message) => {
        try {
          Notifications.notify(message);
        } catch {
        }
      },
      log: (line) => console.log(`jobeeslair: ${line}`)
    });
    let timer = null;
    const loop = async () => {
      try {
        await remote.tick();
      } catch {
      }
      timer = setTimeout(loop, EVERY_MS);
    };
    timer = setTimeout(loop, FIRST_MS);
    return () => {
      clearTimeout(timer);
      started = false;
    };
  }

export { startJobeRemote };
