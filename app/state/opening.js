// glibren.56 (abertura minima): o que aparece entre abrir a Jobe e chegar na loja. Com "Abertura minima" ligada (o padrao,
// Configuracoes > Aparencia), so o logo e a animacao girando (ui/Opening.jsx) enquanto a loja fica pronta; depois, a loja.
// Nada de termos, novidades, aviso de queda, pergunta dos relatorios, faixa de recados ou oferta de atualizacao por cima.
// O que saiu da abertura nao sumiu: fica em Configuracoes > Sobre (openingPlan diz onde). Desligada, tudo volta como antes.
//
// Guardado no settings.json: "minimalOpening" (false = o comportamento antigo; ausente = ligada) e "termsAccepted" (true
// depois da 1a vez que os termos foram aceitos, pelo botao Continuar do aviso antigo ou em silencio na abertura minima).
// As duas chaves ficam so no app (o payload nao as conhece: settings-sync guarda as recusadas como locais).

import { useEffect, useState } from 'react';
import { loadList, saveList } from './saved.js';

  var SETTINGS = "settings.json";
  var value = null;
  var listeners = /* @__PURE__ */ new Set();
  function readSettings() {
    try {
      return loadList(SETTINGS, "settings") ?? {};
    } catch {
      return {};
    }
  }
  /** Se a abertura e a minima (ligada por padrao). */
  function minimalOpening() {
    if (value === null) value = readSettings().minimalOpening !== false;
    return value;
  }
  function setMinimalOpening(on) {
    value = Boolean(on);
    try {
      saveList(SETTINGS, "settings", { ...readSettings(), minimalOpening: value });
    } catch (problem) {
      console.log(`jobeeslair: settings: minimalOpening not saved (${problem?.message ?? problem})`);
    }
    for (const listener of [...listeners]) listener(value);
  }
  function useMinimalOpening() {
    const [on, setOn] = useState(minimalOpening);
    useEffect(() => {
      listeners.add(setOn);
      setOn(minimalOpening());
      return () => {
        listeners.delete(setOn);
      };
    }, []);
    return on;
  }
  /** Se os termos ja foram aceitos alguma vez. */
  var termsAccepted = () => readSettings().termsAccepted === true;
  /** Os termos aceitos (pelo Continuar do aviso antigo, ou em silencio na abertura minima). `how` vai para o log. */
  function acceptTerms(how = "continue") {
    if (termsAccepted()) return false;
    try {
      saveList(SETTINGS, "settings", { ...readSettings(), termsAccepted: true });
    } catch (problem) {
      console.log(`jobeeslair: settings: termsAccepted not saved (${problem?.message ?? problem})`);
    }
    console.log(`jobeeslair: terms of use accepted (${how})`);
    return true;
  }
  /**
   * O que a abertura mostra e para onde foi o resto. `minimal`: a chave; `accepted`: os termos ja aceitos.
   * -> { intro, terms, reveal, whatsNew, crash, autoReportAsk, announcementBar, updateOffer }: "splash" (o logo com as
   * linhas de telemetria), "mark" (so o logo e a animacao girando), "every-launch", "modal", "bar", "settings" (em
   * Configuracoes > Sobre), "silent" (aceitos sem perguntar), "off" (padrao desligado, sem perguntar), "badge" (o ponto
   * no botao de atualizacao da ilha, na loja) ou false (nao aparece).
   */
  function openingPlan({ minimal = minimalOpening(), accepted = termsAccepted() } = {}) {
    if (!minimal) return { intro: "splash", terms: "every-launch", reveal: true, whatsNew: "modal", crash: "modal", autoReportAsk: "modal", announcementBar: "bar", updateOffer: "modal" };
    return { intro: "mark", terms: accepted ? false : "silent", reveal: false, whatsNew: "settings", crash: "settings", autoReportAsk: "off", announcementBar: "settings", updateOffer: "badge" };
  }
  /**
   * As camadas da abertura, de baixo para cima, como index.jsx (Boot) as desenha: "store" (a loja), "opening" (o logo e o
   * anel girando), "splash" (o logo com a telemetria), "terms" (os termos com Continuar) e "reveal" (o vortice).
   * `booted`: a loja pode montar; `curtain`: o logo (ou o vortice) ainda esta por cima dela.
   */
  function bootLayers({ minimal, booted, curtain, introDone = false, introLeaving = false }) {
    if (booted) return curtain ? ["store", minimal ? "opening" : "reveal"] : ["store"];
    if (minimal) return ["opening"];
    return [introDone || introLeaving ? "terms" : null, introDone ? null : "splash"].filter(Boolean);
  }
  // So para os testes.
  function resetOpening() {
    value = null;
    for (const listener of [...listeners]) listener(minimalOpening());
  }

export { acceptTerms, bootLayers, minimalOpening, openingPlan, resetOpening, setMinimalOpening, termsAccepted, useMinimalOpening };
