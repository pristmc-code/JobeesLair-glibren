// glibren.20: a lista Orbit Store (Configuracoes > Feeds), desligada por padrao.
//
// Ligada, o payload (app/native/bg_orbit.c, POST /orbit) baixa o catalogo publico do Orbit Store agora e a cada 6 h,
// decifra, converte e grava o feed da Jobe em /data/JobeesLair/orbit/orbit-store.json; o app le esse arquivo como um
// feed do PS5 (state/feeds.js: ORBIT_FEED entra na lista dos feeds so com a opcao ligada).
//
// O estado vem de orbit-store-status.json, que o payload grava ao lado: o app le o arquivo direto (sem precisar do
// payload no ar) e calcula aqui, com a mesma regra do payload, se a lista parou de atualizar:
//   "broken"  o catalogo baixou mas nao abre mais (o Orbit trocou a chave ou o formato);
//   "failing" nenhuma atualizacao deu certo nas ultimas 24 h;
//   "quiet"   o Orbit nao publica uma revisao nova ha 14 dias.
// O aviso aparece de tres jeitos: notificacao do PS5 mandada pelo payload quando comeca (mesmo com o app fechado),
// notificacao do app ao abrir (uma vez por problema) e a barra amarela de avisos enquanto durar (ui/AnnouncementBar.jsx),
// alem do texto nas Configuracoes.
//
// glibren.27: o app manda junto os codigos que ja conhece sem a lista ("known": o catalogo embutido, as outras edicoes e
// os outros feeds, ver state/catalog.js); o payload grava esses jogos so com os links (o app junta os links ao jogo que
// ja tem) e so os que o app nao tem com a pagina inteira. Uma lista gravada antes disso (sem "known" no estado) nao e
// lida: inteira, ela enchia o heap de 32 MiB e o app fechava ao abrir; o payload a regrava logo que recebe os codigos.

import { useEffect, useState } from 'react';
import { FileSystem, Notifications, Platform } from '@ps5-react/core';
import { DATA_DIR } from './data-dir.js';
import { loadList, saveList } from './saved.js';

  var SETTINGS = "settings.json";
  // glibren.25: no PS5 a pasta que o payload grava (bg_orbit.c: /data/JobeesLair/orbit). Ate a .24 o app lia da sua
  // pasta de dados (/download0 ou /data/ps5-react/<ID>), onde o arquivo nunca aparece: a lista ficava em "Baixando o
  // catalogo pela primeira vez" para sempre e nao entrava na loja nem nas fontes da Biblioteca TorBox.
  var ORBIT_DIR = Platform.OS === "ps5" ? "/data/JobeesLair/orbit" : `${DATA_DIR}/orbit`;
  var ORBIT_FEED = `${ORBIT_DIR}/orbit-store.json`;
  var ORBIT_STATUS = `${ORBIT_DIR}/orbit-store-status.json`;
  var STALE_S = 24 * 3600, QUIET_S = 14 * 24 * 3600;
  // De quanto em quanto a barra de avisos rele o estado (um arquivo pequeno) com o app aberto.
  var CHECK_MS = 10 * 6e4;

  // ---- A opcao (guardada em settings.json como "orbitFeed") ----
  var enabled = null;
  var listeners = /* @__PURE__ */ new Set();
  function orbitFeedOn() {
    if (enabled === null) {
      try {
        enabled = loadList(SETTINGS, "settings").orbitFeed === true;
      } catch {
        enabled = false;
      }
    }
    return enabled;
  }
  function setOrbitFeed(on) {
    enabled = Boolean(on);
    try {
      saveList(SETTINGS, "settings", { ...loadList(SETTINGS, "settings"), orbitFeed: enabled });
    } catch (problem) {
      console.log(`jobeeslair: settings: orbitFeed not saved (${problem?.message ?? problem})`);
    }
    // Ligar baixa agora (o payload nao repete antes de 1 min); desligar so para as atualizacoes.
    void sendOrbit(enabled ? withKnown({ enabled, refresh: enabled }) : { enabled, refresh: enabled });
    for (const listener of [...listeners]) listener(enabled);
  }
  function onOrbitFeed(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }
  function useOrbitFeed() {
    const [on, setOn] = useState(orbitFeedOn);
    useEffect(() => onOrbitFeed(setOn), []);
    return on;
  }

  // ---- glibren.27: os codigos que o app ja conhece sem a lista (state/catalog.js os da ao carregar) ----
  var knownIds = null;
  var TITLE_ID = /^(?:PPSA|CUSA)\d{5}$/;
  /** glibren.27: guarda os codigos conhecidos; vao ao payload com a opcao (ao abrir o app e ao ligar a lista). */
  function setOrbitKnown(ids) {
    knownIds = [...new Set(ids)].filter((id) => TITLE_ID.test(id)).sort();
  }
  var orbitKnownIds = () => knownIds;
  var withKnown = (body) => knownIds ? { ...body, known: knownIds } : body;
  /**
   * glibren.27: se o arquivo da lista ja foi gravado com os codigos conhecidos (leve) e pode ser lido; antes disso o
   * app nao le a lista (a inteira, de um payload antigo ou ainda sem os codigos, nao cabe no heap).
   */
  var orbitFeedReady = (status = readOrbitStatus()) => num(status?.conv) >= 3 && num(status?.known) > 0;

  // ---- O payload (background-downloads.js registra como falar com ele) ----
  var source = null, pending = null;
  function setOrbitSource(send) {
    source = typeof send === "function" ? send : null;
    if (source && pending) {
      const body = pending;
      pending = null;
      void sendOrbit(body);
    }
  }
  async function sendOrbit(body) {
    if (!source) {
      pending = { ...pending ?? {}, ...body };
      return null;
    }
    try {
      return await source(body);
    } catch (problem) {
      console.log(`jobeeslair: orbit: payload did not answer (${problem?.message ?? problem})`);
      return null;
    }
  }
  // "Atualizar feeds" nas Configuracoes: pede ao payload uma atualizacao agora (ele recusa se tentou ha menos de 1 min).
  var requestOrbitRefresh = () => orbitFeedOn() ? sendOrbit({ enabled: true, refresh: true }) : Promise.resolve(null);

  // ---- O estado ----
  function readOrbitStatus() {
    try {
      if (!FileSystem.exists(ORBIT_STATUS)) return null;
      const value = JSON.parse(String(FileSystem.readFile(ORBIT_STATUS) ?? ""));
      return value && typeof value === "object" ? value : null;
    } catch {
      return null;
    }
  }
  var num = (value) => Number.isFinite(value) ? value : 0;
  /** A regra de bg_orbit.c (orbit_stale_locked): "" em dia (ou desligada), "broken", "failing" ou "quiet". */
  function orbitStale(status, on = orbitFeedOn(), nowS = Math.floor(Date.now() / 1e3)) {
    if (!on || !status) return "";
    if (status.kind === "broken") return "broken";
    const since = num(status.lastOk) || num(status.enabledAt);
    if (num(status.lastTry) && since && nowS - since > STALE_S) return "failing";
    // Ligada ha mais de 24 h sem nenhuma tentativa: o payload nao esta rodando para atualizar.
    if (!num(status.lastTry) && num(status.enabledAt) && nowS - num(status.enabledAt) > STALE_S) return "failing";
    if (num(status.lastOk) && num(status.revisionSince) && nowS - num(status.revisionSince) > QUIET_S) return "quiet";
    return "";
  }
  /** Para as Configuracoes: o estado relido a cada `ms` enquanto a tela esta aberta. */
  function useOrbitStatus(ms = 5e3) {
    const on = useOrbitFeed();
    const [status, setStatus] = useState(readOrbitStatus);
    useEffect(() => {
      if (!on) return void 0;
      setStatus(readOrbitStatus());
      const id = setInterval(() => setStatus(readOrbitStatus()), ms);
      return () => clearInterval(id);
    }, [on]);
    return { on, status, stale: orbitStale(status, on) };
  }
  /** Para a barra de avisos: o problema de agora ("" quando nao ha), relido a cada CHECK_MS. */
  function useOrbitStale() {
    const on = useOrbitFeed();
    const [stale, setStale] = useState(() => orbitStale(readOrbitStatus(), on));
    useEffect(() => {
      setStale(orbitStale(readOrbitStatus(), on));
      if (!on) return void 0;
      const id = setInterval(() => setStale(orbitStale(readOrbitStatus(), on)), CHECK_MS);
      return () => clearInterval(id);
    }, [on]);
    return stale;
  }

  // ---- Ao abrir o app ----
  // Manda ao payload o que a opcao diz (ele guarda; so baixa quando a hora chega) e, com a lista parada, avisa uma vez
  // por problema (guardado em settings.json como "orbitTold"; volta a avisar se o problema mudar ou depois de voltar).
  function startOrbitFeed(t) {
    const on = orbitFeedOn();
    const status = readOrbitStatus();
    if (on || status?.enabled) void sendOrbit(on ? withKnown({ enabled: on }) : { enabled: on });
    const stale = orbitStale(status, on);
    let told = "";
    try {
      told = String(loadList(SETTINGS, "settings").orbitTold ?? "");
    } catch {
    }
    if (stale === told) return stale;
    try {
      saveList(SETTINGS, "settings", { ...loadList(SETTINGS, "settings"), orbitTold: stale });
    } catch {
    }
    if (stale) {
      try {
        Notifications.notify(t(`orbit.stale.${stale}`));
      } catch (problem) {
        console.log(`jobeeslair: orbit: notification not shown (${problem?.message ?? problem})`);
      }
    }
    return stale;
  }

export { ORBIT_FEED, ORBIT_STATUS, onOrbitFeed, orbitFeedOn, orbitFeedReady, orbitKnownIds, orbitStale, setOrbitKnown, readOrbitStatus, requestOrbitRefresh, sendOrbit, setOrbitFeed, setOrbitSource, startOrbitFeed, useOrbitFeed, useOrbitStale, useOrbitStatus };
