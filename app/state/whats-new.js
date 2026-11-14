// The one-time "What's new" panel (0.5.0 Pre Release 4): shown once per release that has one, after the store
// comes up; the release it was last shown for is kept in settings.json.

import { loadList, saveList } from './saved.js';

  var SETTINGS = "settings.json";
  // Raised when a release has a new panel to show (ui/WhatsNew.jsx). 0.5.2: its online card is where players
  // learn the anonymous stats are on, and where to turn them off. 0.5.3: PS5 packages, Homebrew search, Discover's
  // top games, "Device busy". 0.5.4: the PS5 keyboard, the phone companion live, focus, symbols and emoji. 0.5.5: dead
  // links for everyone, retries, the drive, nested archives. 0.5.6: big 7z archives, resumes, drives, false alarms.
  var WHATS_NEW = "0.5.6";
  var shouldShowWhatsNew = () => loadList(SETTINGS, "settings").whatsNewSeen !== WHATS_NEW;
  // The release whose panel was shown last ("" for none: a new install).
  var lastWhatsNewSeen = () => {
    const seen = loadList(SETTINGS, "settings").whatsNewSeen;
    return typeof seen === "string" ? seen : "";
  };
  function markWhatsNewSeen() {
    saveList(SETTINGS, "settings", { ...loadList(SETTINGS, "settings"), whatsNewSeen: WHATS_NEW });
    for (const listener of [...seenListeners]) listener();
  }
  // glibren.56 (abertura minima, state/opening.js): o painel nao abre sozinho; abre por Configuracoes > Sobre ("O que mudou
  // na versao X"), por openWhatsNew. Quem desenha o painel (ui/WhatsNew.jsx) escuta com onOpenWhatsNew.
  var openers = /* @__PURE__ */ new Set();
  var seenListeners = /* @__PURE__ */ new Set();
  function openWhatsNew() {
    for (const open of [...openers]) open();
    return openers.size > 0;
  }
  function onOpenWhatsNew(open) {
    openers.add(open);
    return () => openers.delete(open);
  }
  /** Avisa quando o painel e marcado como visto (a linha de Configuracoes tira o "Novo"). */
  function onWhatsNewSeen(listener) {
    seenListeners.add(listener);
    return () => seenListeners.delete(listener);
  }

export { WHATS_NEW, lastWhatsNewSeen, markWhatsNewSeen, onOpenWhatsNew, onWhatsNewSeen, openWhatsNew, shouldShowWhatsNew };
