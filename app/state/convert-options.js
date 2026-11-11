// pac1: as opcoes da conversao para .exfat feita pelo payload de fundo (bg_convert.c), em Configuracoes > Downloads:
//   - "Pausa entre conversoes" (convertPauseSeconds): espera entre o fim de uma conversao e o comeco da proxima;
//   - "Limite de escrita da conversao" (convertWriteLimit, MB/s): a conversao grava no maximo isso por segundo;
//   - "Gravar em pedacos" (convertSyncMB): forca a gravacao no disco (fsync) a cada N MB durante a conversao, e cada
//     uma fica no diario do payload com o tempo que levou (para ver se o disco USB engasga).
// Todas desligadas (0) por padrao; guardadas em settings.json so quando ligadas. Vao ao payload no POST /config
// (background-downloads.js syncConcurrency), que as grava no config.json dele; mudar uma chega ao payload no ar na hora.

import { useEffect, useState } from 'react';
import { loadList, saveList } from './saved.js';

  var SETTINGS = "settings.json";
  var CONVERT_OPTIONS = {
    convertPauseSeconds: [0, 30, 60, 120, 300],
    convertWriteLimit: [0, 25, 50, 100, 200],
    convertSyncMB: [0, 64, 128, 256, 512]
  };
  var values = null;
  var listeners = /* @__PURE__ */ new Set();
  function convertOptions() {
    if (values === null) {
      let saved = {};
      try {
        saved = loadList(SETTINGS, "settings") ?? {};
      } catch {
        saved = {};
      }
      values = {};
      for (const [key, choices] of Object.entries(CONVERT_OPTIONS)) values[key] = choices.includes(saved[key]) ? saved[key] : 0;
    }
    return values;
  }
  /** Escolhe um valor (um da lista da opcao), grava e avisa quem ouve (o payload no ar recebe na hora). */
  function setConvertOption(key, value) {
    if (!CONVERT_OPTIONS[key]?.includes(value)) return;
    values = { ...convertOptions(), [key]: value };
    try {
      const { [key]: _old, ...settings } = loadList(SETTINGS, "settings") ?? {};
      saveList(SETTINGS, "settings", value === 0 ? settings : { ...settings, [key]: value });
    } catch (problem) {
      console.log(`jobeeslair: settings: ${key} not saved (${problem?.message ?? problem})`);
    }
    for (const listener of [...listeners]) listener(values);
  }
  function onConvertOptions(listener) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }
  function useConvertOptions() {
    const [now, setNow] = useState(convertOptions);
    useEffect(() => onConvertOptions(setNow), []);
    return now;
  }
  // So para os testes: volta a ler do settings.json.
  function resetConvertOptions() {
    values = null;
  }

export { CONVERT_OPTIONS, convertOptions, onConvertOptions, resetConvertOptions, setConvertOption, useConvertOptions };
