// glibren-tube: as opcoes do YouTube dentro da Jobee'sLair, em settings.json ao lado das outras:
//   - "tubeSponsorBlock" (ligada por padrao): pular os trechos de patrocinio do SponsorBlock (Configuracoes > Videos);
//   - "tubeSubtitles" (desligada por padrao): mostrar as legendas; o Triangulo no player liga e desliga e fica guardado.
// Lidas a cada video aberto, entao uma mudanca vale para o proximo.

import { useEffect, useState } from 'react';
import { loadList, saveList } from './saved.js';

  var SETTINGS = "settings.json";
  function flag(key, fallback) {
    let value = null;
    const listeners = /* @__PURE__ */ new Set();
    const get = () => {
      if (value === null) {
        const saved = loadList(SETTINGS, "settings")[key];
        value = typeof saved === "boolean" ? saved : fallback;
      }
      return value;
    };
    const set = (on) => {
      value = Boolean(on);
      saveList(SETTINGS, "settings", { ...loadList(SETTINGS, "settings"), [key]: value });
      for (const listener of [...listeners]) listener(value);
    };
    const use = () => {
      const [on, setOn] = useState(get);
      useEffect(() => {
        listeners.add(setOn);
        return () => {
          listeners.delete(setOn);
        };
      }, []);
      return on;
    };
    return { get, set, use };
  }
  var sponsor = flag("tubeSponsorBlock", true);
  var subtitles = flag("tubeSubtitles", false);
  var tubeSponsorBlock = sponsor.get;
  var setTubeSponsorBlock = sponsor.set;
  var useTubeSponsorBlock = sponsor.use;
  var tubeSubtitles = subtitles.get;
  var setTubeSubtitles = subtitles.set;
  var useTubeSubtitles = subtitles.use;
  // glibren-tube-update: "tubeAutoUpdate" (ligada por padrao): baixar sozinho as versoes novas do servico do YouTube
  // (state/tube-update.js).
  var autoUpdate = flag("tubeAutoUpdate", true);
  var tubeAutoUpdate = autoUpdate.get;
  var setTubeAutoUpdate = autoUpdate.set;
  var useTubeAutoUpdate = autoUpdate.use;

  // glibren-tube-quality: "tubeQuality", a altura maxima da qualidade que o player abre (1080, 1440 ou 2160; padrao
  // 1080). Acima de 1080p so o decodificador do PS5 (H.264/HEVC/VP9) da conta; o R2 no player continua trocando.
  var QUALITY_CHOICES = [1080, 1440, 2160];
  var quality = null;
  var qualityListeners = /* @__PURE__ */ new Set();
  function tubeQuality() {
    if (quality === null) {
      const saved = loadList(SETTINGS, "settings").tubeQuality;
      quality = QUALITY_CHOICES.includes(saved) ? saved : 1080;
    }
    return quality;
  }
  function setTubeQuality(value) {
    if (!QUALITY_CHOICES.includes(value)) return;
    quality = value;
    saveList(SETTINGS, "settings", { ...loadList(SETTINGS, "settings"), tubeQuality: value });
    for (const listener of [...qualityListeners]) listener(value);
  }
  function useTubeQuality() {
    const [value, setValue] = useState(tubeQuality);
    useEffect(() => {
      qualityListeners.add(setValue);
      return () => {
        qualityListeners.delete(setValue);
      };
    }, []);
    return value;
  }

export { QUALITY_CHOICES as TUBE_QUALITY_CHOICES, setTubeQuality, tubeQuality, useTubeQuality, setTubeAutoUpdate, tubeAutoUpdate, useTubeAutoUpdate, setTubeSponsorBlock, setTubeSubtitles, tubeSponsorBlock, tubeSubtitles, useTubeSponsorBlock, useTubeSubtitles };
