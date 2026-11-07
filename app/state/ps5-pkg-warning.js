// glibren.16: o aviso de que um .pkg de PS5 nao abre neste firmware.
//
// Um pacote falso (FPKG) de PS5 instala em qualquer firmware em que o kstuff roda, mas so abre ate o 11.60
// (state/firmware.js ps5FakePackagesLaunch). Ate o glibren.15 a fila segurava, acima do 11.60, so o .pkg de PS5 de uma
// fonte que nao dizia ser FPKG ("downloads.fpkgHeld", com um texto longo no cartao); o resto instalava sozinho.
// Agora e uma opcao (Configuracoes > Downloads, ligada por padrao), "Avisar que .pkg de PS5 nao abre neste firmware":
//   - ligada, com o firmware do console acima do 11.60: o .pkg de PS5 (PPSA) espera no botao Instalar de sempre, e
//     tocar Instalar (cartao de download, pagina do jogo ou Biblioteca) abre o aviso (ui/Ps5PkgWarning.jsx) com
//     "Instalar mesmo assim", "Cancelar" e "Nao avisar de novo" (que desliga a opcao e instala);
//   - desligada: instala direto, sem aviso, como um .pkg de PS4;
//   - firmware desconhecido, 11.60 ou abaixo, ou .pkg de PS4 (CUSA): nada muda, nunca avisa.

import { useEffect, useState } from 'react';
import { loadList, saveList } from './saved.js';
import { consoleFirmware, firmwareText, ps5FakePackagesLaunch } from './firmware.js';
import { deviceFacts } from './device.js';

  var SETTINGS = "settings.json";
  // ---- A opcao (ligada por padrao; guardada em settings.json como "warnPs5Pkg") ----
  var enabled = null;
  var listeners = /* @__PURE__ */ new Set();
  function ps5PkgWarningOn() {
    if (enabled === null) {
      try {
        enabled = loadList(SETTINGS, "settings").warnPs5Pkg !== false;
      } catch {
        enabled = true;
      }
    }
    return enabled;
  }
  function setPs5PkgWarning(on) {
    enabled = Boolean(on);
    try {
      saveList(SETTINGS, "settings", { ...loadList(SETTINGS, "settings"), warnPs5Pkg: enabled });
    } catch (problem) {
      console.log(`jobeeslair: settings: warnPs5Pkg not saved (${problem?.message ?? problem})`);
    }
    for (const listener of [...listeners]) listener(enabled);
  }
  function onPs5PkgWarning(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }
  function usePs5PkgWarning() {
    const [on, setOn] = useState(ps5PkgWarningOn);
    useEffect(() => onPs5PkgWarning(setOn), []);
    return on;
  }

  // ---- Que pacote e de PS5 ----
  var baseName = (path) => String(path || "").slice(String(path || "").lastIndexOf("/") + 1);
  // Os pacotes do job (ou o arquivo baixado): de PS5 quando um nome tem PPSA, ou quando nenhum tem CUSA e o jogo e PPSA.
  function isPs5Package(job) {
    const paths = (job?.packages ?? [job?.downloadDestination || job?.artifact?.destination]).filter(Boolean);
    return paths.map(baseName).some((name) => /PPSA\d{5}/i.test(name) || !/CUSA\d{5}/i.test(name) && /^PPSA/i.test(job?.titleId || ""));
  }
  // O firmware do console ("12.00") quando o aviso vale para este job; null quando nao (opcao desligada, firmware
  // desconhecido ou ate 11.60, pacote de PS4).
  function ps5PkgWarningFor(job, firmware, on = ps5PkgWarningOn()) {
    if (!on || ps5FakePackagesLaunch(firmware) !== false || !isPs5Package(job)) return null;
    return firmwareText(consoleFirmware(firmware));
  }

  // ---- O aviso aberto (um por vez), lido pelo dialogo em ui/Ps5PkgWarning.jsx ----
  var pending = null;
  var pendingListeners = /* @__PURE__ */ new Set();
  function tellPending() {
    for (const listener of [...pendingListeners]) listener(pending);
  }
  var consoleFirmwareNow = () => {
    try {
      return deviceFacts().firmware;
    } catch {
      return null;
    }
  };
  /**
   * Tocar Instalar num pacote: `install()` na hora, ou (opcao ligada, .pkg de PS5, firmware acima do 11.60) o aviso
   * primeiro. Devolve true quando o aviso abriu.
   */
  function installWithPs5Warning(job, install, firmware = consoleFirmwareNow()) {
    const shown = ps5PkgWarningFor(job, firmware);
    if (!shown) {
      install();
      return false;
    }
    console.log(`[ps5-pkg] ${job?.id}: a PS5 package on firmware ${shown}; asking before installing`);
    pending = { id: job.id, title: job.title || "", firmware: shown, install };
    tellPending();
    return true;
  }
  /** A resposta do aviso: "install" (Instalar mesmo assim), "never" (Nao avisar de novo: desliga e instala) ou "cancel". */
  function answerPs5PkgWarning(choice) {
    const asked = pending;
    pending = null;
    tellPending();
    if (!asked) return;
    if (choice === "never") setPs5PkgWarning(false);
    if (choice === "install" || choice === "never") asked.install();
  }
  var pendingPs5PkgWarning = () => pending;
  function usePendingPs5PkgWarning() {
    const [asked, setAsked] = useState(pendingPs5PkgWarning);
    useEffect(() => {
      pendingListeners.add(setAsked);
      return () => {
        pendingListeners.delete(setAsked);
      };
    }, []);
    return asked;
  }

export { answerPs5PkgWarning, installWithPs5Warning, isPs5Package, onPs5PkgWarning, pendingPs5PkgWarning, ps5PkgWarningFor, ps5PkgWarningOn, setPs5PkgWarning, usePendingPs5PkgWarning, usePs5PkgWarning };
