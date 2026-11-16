// pac1: as opcoes da conversao para .exfat feita pelo payload de fundo (bg_convert.c), em Configuracoes > Downloads:
//   - "Pausa entre conversoes" (convertPauseSeconds): espera entre o fim de uma conversao e o comeco da proxima;
//   - "Limite de escrita da conversao" (convertWriteLimit, MB/s): a conversao grava no maximo isso por segundo;
//   - "Gravar em pedacos" (convertSyncMB): forca a gravacao no disco (fsync) a cada N MB durante a conversao, e cada
//     uma fica no diario do payload com o tempo que levou (para ver se o disco USB engasga).
// glibren.71: e o formato da conversao (convertFormat) e o nivel de compressao (convertLevel, avancado), em
// CONVERT_CHOICES: o primeiro de cada lista e o padrao. "exfat" = o nosso exfat_writer (bg_convert.c, sem nada mais); os
// outros sao feitos pelo ps5-dump-forge (127.0.0.1:8095) que o payload chama: .ffpkg, .ffpfs, .ffpfsc, .pkg (FPKG de
// debug, Kraken), "<imagem>_zstd" (a imagem com os arquivos em packs zstd), "pasta" (so extrai), "pasta_zstd" e
// "pasta_lz4" (pasta com packs; zstd/LZ4 precisam do ampr-emu-ng). Os ids sao os mesmos do glibren. O nivel "padrao"
// nao manda nada (vale o padrao do Dump Forge); os outros viram o nivel de cada formato em bg_convert.c (forge_level).
// O glibren. Desligar a conversao e a chave "convertExfat" (state/exfat-convert.js), que continua como era.
// Todas desligadas (0) por padrao; guardadas em settings.json so quando ligadas (as de texto: so fora do padrao). Vao ao payload no POST /config
// (background-downloads.js syncConcurrency), que as grava no config.json dele; mudar uma chega ao payload no ar na hora.

import { useEffect, useState } from 'react';
import { loadList, saveList } from './saved.js';

  var SETTINGS = "settings.json";
  var CONVERT_OPTIONS = {
    convertPauseSeconds: [0, 30, 60, 120, 300],
    convertWriteLimit: [0, 25, 50, 100, 200],
    convertSyncMB: [0, 64, 128, 256, 512]
  };
  var CONVERT_CHOICES = {
    convertFormat: ["exfat", "ffpkg", "ffpfs", "ffpfsc", "pkg", "exfat_zstd", "ffpkg_zstd", "ffpfs_zstd", "ffpfsc_zstd", "pasta", "pasta_zstd", "pasta_lz4"],
    convertLevel: ["padrao", "rapido", "equilibrado", "menor", "sem"]
  };
  // As extensoes do que cada formato grava em <disco>/homebrew/ ("" = uma pasta).
  var FORMAT_EXT = { exfat: ".exfat", ffpkg: ".ffpkg", ffpfs: ".ffpfs", ffpfsc: ".ffpfsc", pkg: ".pkg", exfat_zstd: ".exfat", ffpkg_zstd: ".ffpkg", ffpfs_zstd: ".ffpfs", ffpfsc_zstd: ".ffpfsc", pasta: "", pasta_zstd: "", pasta_lz4: "" };
  // Os niveis que cada formato aceita (nenhum = o formato nao tem nivel). "sem" so no .pkg (Kraken stored) e no .ffpfsc
  // (zlib 0).
  function levelsFor(format) {
    if (format === "pkg" || format === "ffpfsc") return CONVERT_CHOICES.convertLevel;
    if (/_zstd$/.test(format) || format === "pasta_lz4") return CONVERT_CHOICES.convertLevel.filter((level) => level !== "sem");
    return [];
  }
  var choicesOf = (key) => CONVERT_OPTIONS[key] ?? CONVERT_CHOICES[key];
  var fallbackOf = (key) => CONVERT_CHOICES[key] ? CONVERT_CHOICES[key][0] : 0;
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
      for (const [key, choices] of Object.entries({ ...CONVERT_OPTIONS, ...CONVERT_CHOICES })) values[key] = choices.includes(saved[key]) ? saved[key] : fallbackOf(key);
    }
    return values;
  }
  /** Escolhe um valor (um da lista da opcao), grava e avisa quem ouve (o payload no ar recebe na hora). */
  function setConvertOption(key, value) {
    if (!choicesOf(key)?.includes(value)) return;
    values = { ...convertOptions(), [key]: value };
    try {
      const { [key]: _old, ...settings } = loadList(SETTINGS, "settings") ?? {};
      saveList(SETTINGS, "settings", value === fallbackOf(key) ? settings : { ...settings, [key]: value });
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
  /** O formato escolhido ("exfat" quando nada foi escolhido). */
  const convertFormat = () => convertOptions().convertFormat;
  /** Se o formato precisa do ps5-dump-forge (todos menos "exfat" e "pasta", que o payload faz sozinho). */
  const needsForge = (format) => format !== "exfat" && format !== "pasta";
  // So para os testes: volta a ler do settings.json.
  function resetConvertOptions() {
    values = null;
  }

export { CONVERT_CHOICES, CONVERT_OPTIONS, FORMAT_EXT, convertFormat, levelsFor, convertOptions, needsForge, onConvertOptions, resetConvertOptions, setConvertOption, useConvertOptions };
