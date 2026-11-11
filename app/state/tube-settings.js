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

export { setTubeSponsorBlock, setTubeSubtitles, tubeSponsorBlock, tubeSubtitles, useTubeSponsorBlock, useTubeSubtitles };
