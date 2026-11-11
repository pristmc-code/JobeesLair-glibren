// glibren-tube: o player do YouTube dentro da Jobee'sLair, em tela cheia (useImmersive: sem cabecalho nem rodape).
// Toca com o <Video> do ps5-react (docs/VIDEO.md) a playlist HLS master (video + audio num link so) que o
// tube-service.elf monta em 127.0.0.1 para a qualidade escolhida; sem cabecalhos (o token nao vai ao YouTube; /media
// nao pede token).
//   - Qualidade: a melhor ate 1080p (state/tube-service.js defaultChoice); R2 abre a lista; trocar reabre na mesma
//     posicao (startTime).
//   - Legendas: a do idioma do app (WebVTT do servico, prop `subtitles`, faixa 1000); Triangulo liga/desliga (fica
//     guardado, state/tube-settings.js); o texto e desenhado pelo app (onSubtitle).
//   - SponsorBlock (Configuracoes > Videos, ligado por padrao): ao entrar num trecho, pula para o fim dele.
//   - X pausa/continua; Esquerda/Direita ou L1/R1 voltam/avancam 10 s; Circulo fecha (com a lista de qualidades aberta,
//     fecha so a lista).
//   - Erro do player: resolve de novo com links novos (fresh) e reabre na posicao; de novo, tenta a qualidade abaixo;
//     sem mais nenhuma, diz o erro.

import '../assets/Exo2.ttf';
import { jsx, jsxs } from 'react/jsx-runtime';
import { useEffect, useRef, useState } from 'react';
import { getLocale } from '../i18n/core.js';
import { useT } from '../i18n/index.js';
import { useImmersive } from '../state/nav.jsx';
import { clockText, defaultChoice, sponsorSkipTo, tubeService } from '../state/tube-service.js';
import { setTubeSubtitles, tubeSponsorBlock, useTubeSubtitles } from '../state/tube-settings.js';
import { ButtonHints } from '../ui/ButtonHints.jsx';
import { FocusRing } from '../ui/FocusRing.jsx';
import { Icon } from '../ui/Icon.jsx';
import { SideSheet } from '../ui/SideSheet.jsx';
import { colors, radius } from '../ui/colors.js';
import { FocusScope, Text, Video, View, useControllerEvents } from '@ps5-react/core';

  var SEEK_STEP = 10;
  var BAR_MS = 4e3;
  var NOTICE_MS = 2500;
  var SUBTITLE_TRACK = 1e3; // os arquivos de `subtitles` sao listados a partir de 1000 (docs/VIDEO.md)
  var HINTS = [
    { button: "cross", label: "tube.hint.pause" },
    { button: "l1r1", label: "tube.hint.seek" },
    { button: "triangle", label: "tube.hint.subtitles" },
    { button: "r2", label: "tube.hint.quality" },
    { button: "circle", label: "hints.close" }
  ];
  var QUALITY_HINTS = [{ button: "cross", label: "hints.select" }, { button: "circle", label: "hints.close" }];
  var text = (size, color, extra) => ({ fontFamily: "Exo2", fontSize: size, lineHeight: Math.round(size * 1.4), color, ...extra });
  var FULL = { position: "absolute", top: 0, right: 0, bottom: 0, left: 0 };

  function QualityRow({ choice, current, autoFocus, onPress }) {
    return jsxs(View, { focusKey: `tube:quality:${choice.label}`, autoFocus, onPress, style: (state) => [{ position: "relative", flexDirection: "row", alignItems: "center", gap: 18, borderRadius: radius.sm, paddingHorizontal: 18, paddingVertical: 16 }, state.focused ? { backgroundColor: colors.surface2 } : null], children: [
      jsx(FocusRing, {}),
      jsx(Icon, { name: current ? "check" : "play", size: 18, color: current ? colors.accentHi : colors.muted }),
      jsx(Text, { style: text(23, colors.fg, { fontWeight: current ? 700 : 500 }), children: choice.label })
    ] });
  }

  /**
   * `item`: o video da lista ({ id, title, channel, seconds }); `onClose(reason)`: "back" (Circulo) ou "end" (acabou).
   * `service`: o cliente do tube-service (para os testes; padrao o do app); `start`: o estado inicial (testes:
   * { info, choice, phase }).
   */
  function TubePlayer({ item, onClose, service = tubeService(), start = null }) {
    const t2 = useT();
    useImmersive(true);
    const subsOn = useTubeSubtitles();
    const [info, setInfo] = useState(() => start?.info ?? null); // { title, channel, duration, choices, caption }
    const [choice, setChoice] = useState(() => start?.choice ?? -1);
    const [startAt, setStartAt] = useState(0);
    const [phase, setPhase] = useState(() => start?.phase ?? "resolving"); // resolving | playing | failed
    const [problem, setProblem] = useState(() => start?.problem ?? "");
    const [paused, setPaused] = useState(false);
    const [position, setPosition] = useState(0);
    const [bar, setBar] = useState(true);
    const [menu, setMenu] = useState(false);
    const [subtitle, setSubtitle] = useState("");
    const [notice, setNotice] = useState("");
    const video = useRef(null);
    const live = useRef({ position: 0, segments: [], skipUntil: 0, tries: 0, freshUsed: false, alive: true, abort: null });
    const barTimer = useRef(null);
    const noticeTimer = useRef(null);
    const showBar = () => {
      setBar(true);
      clearTimeout(barTimer.current);
      barTimer.current = setTimeout(() => setBar(false), BAR_MS);
    };
    const say = (message) => {
      setNotice(message);
      clearTimeout(noticeTimer.current);
      noticeTimer.current = setTimeout(() => setNotice(""), NOTICE_MS);
    };
    // Resolve (de novo, com `fresh`) e escolhe a qualidade: a de mesmo nome, se ainda houver, senao a padrao.
    const load = async (fresh, keepLabel) => {
      const state = live.current;
      const listeners = /* @__PURE__ */ new Set();
      const signal = { aborted: false, addEventListener: (type, listener) => listeners.add(listener), removeEventListener: (type, listener) => listeners.delete(listener) };
      state.abort = () => {
        signal.aborted = true;
        for (const listener of [...listeners]) listener();
      };
      try {
        const next = await service.resolve(item.id, { locale: getLocale?.() ?? "en", fresh, signal });
        if (!state.alive || signal.aborted) return;
        const same = keepLabel ? next.choices.findIndex((entry) => entry.label === keepLabel) : -1;
        setInfo(next);
        setChoice(same >= 0 ? same : defaultChoice(next.choices));
        setPhase("playing");
      } catch (error) {
        if (!state.alive || signal.aborted) return;
        setProblem(error?.code ?? error?.message ?? String(error));
        setPhase("failed");
      }
    };
    useEffect(() => {
      const state = live.current;
      state.alive = true;
      void load(false, "");
      if (tubeSponsorBlock()) service.sponsor(item.id).then((segments) => {
        if (state.alive) state.segments = segments;
      });
      showBar();
      return () => {
        state.alive = false;
        state.abort?.();
        clearTimeout(barTimer.current);
        clearTimeout(noticeTimer.current);
      };
    }, []);
    const seekBy = (delta) => {
      const duration = info?.duration || Infinity;
      const target = Math.max(0, Math.min(duration - 1, live.current.position + delta));
      live.current.position = target;
      setPosition(target);
      video.current?.seek(target);
      showBar();
    };
    const togglePause = () => {
      setPaused((value) => !value);
      showBar();
    };
    const toggleSubtitles = () => {
      if (!info?.caption) {
        say(t2("tube.noSubtitles"));
        return;
      }
      setTubeSubtitles(!subsOn);
      say(t2(subsOn ? "tube.subtitlesOff" : "tube.subtitlesOn"));
    };
    const chooseQuality = (index) => {
      setMenu(false);
      if (index === choice) return;
      setStartAt(live.current.position);
      live.current.tries = 0;
      setChoice(index);
      showBar();
    };
    const onProgress = ({ currentTime }) => {
      const state = live.current;
      state.position = currentTime;
      state.tries = 0;
      const shown = Math.floor(currentTime);
      if (shown !== Math.floor(position)) setPosition(currentTime);
      if (!state.segments.length || Date.now() < state.skipUntil) return;
      const to = sponsorSkipTo(state.segments, currentTime);
      if (to === null) return;
      // Um pulo por vez: o proximo onProgress ainda pode vir de antes do seek.
      state.skipUntil = Date.now() + 1500;
      state.position = to;
      video.current?.seek(to);
      say(t2("tube.sponsorSkipped"));
    };
    const onError = ({ error }) => {
      const state = live.current;
      console.log(`tube: player error on ${item.id} (${info?.choices[choice]?.label ?? "?"}): ${error}`);
      setStartAt(state.position);
      // 1) os links podem ter vencido: resolve de novo e reabre na mesma qualidade e posicao.
      if (!state.freshUsed) {
        state.freshUsed = true;
        setPhase("resolving");
        void load(true, info?.choices[choice]?.label ?? "");
        return;
      }
      // 2) a qualidade abaixo (ou acima, quando esta era a ultima), uma vez cada.
      state.tries += 1;
      const count = info?.choices.length ?? 0;
      if (state.tries < count) {
        setChoice((index) => index + 1 < count ? index + 1 : 0);
        return;
      }
      setProblem(String(error ?? ""));
      setPhase("failed");
    };
    // Esquerda/Direita do D-pad voltam/avancam (o X e o Circulo vem pelo FocusScope).
    useControllerEvents(phase === "playing" && !menu ? (event) => {
      if (event.type !== "press") return;
      if (event.button === "left") seekBy(-SEEK_STEP);
      else if (event.button === "right") seekBy(SEEK_STEP);
      else if (event.button === "up" || event.button === "down") showBar();
    } : null);
    const onAction = (action) => {
      if (menu) return false;
      if (action === "l1") seekBy(-SEEK_STEP);
      else if (action === "r1") seekBy(SEEK_STEP);
      else if (action === "triangle") toggleSubtitles();
      else if (action === "r2" && info?.choices.length) {
        setMenu(true);
        showBar();
      } else return false;
      return true;
    };
    const onBack = () => {
      if (menu) {
        setMenu(false);
        return true;
      }
      onClose("back");
      return true;
    };
    const current = info?.choices[choice] ?? null;
    const duration = info?.duration || item.seconds || 0;
    const progress = duration > 0 ? Math.min(1, position / duration) : 0;
    const title = info?.title || item.title;
    return jsx(FocusScope, { trap: true, autoFocus: true, onBack, onAction, children: jsxs(View, { style: [FULL, { backgroundColor: "#000000" }], children: [
      current ? jsx(Video, {
        ref: video,
        source: current.url,
        style: FULL,
        paused,
        startTime: startAt,
        subtitles: info.caption ? [info.caption] : void 0,
        subtitleTrack: subsOn && info.caption ? SUBTITLE_TRACK : -1,
        onLoad: () => setPhase("playing"),
        onProgress,
        onEnd: () => onClose("end"),
        onError,
        onSubtitle: setSubtitle
      }, current.url) : null,
      // A superficie que recebe o X (pausar) e mantem o foco no player.
      jsx(View, { focusKey: "tube:player", autoFocus: true, onPress: togglePause, style: FULL }),
      subsOn && subtitle ? jsx(View, { style: { position: "absolute", left: 160, right: 160, bottom: bar ? 210 : 72, alignItems: "center" }, children: jsx(View, { style: { borderRadius: radius.sm, backgroundColor: "#000000b3", paddingHorizontal: 22, paddingVertical: 10 }, children: jsx(Text, { style: text(36, "#ffffff", { textAlign: "center", fontWeight: 600 }), children: subtitle }) }) }) : null,
      phase === "resolving" ? jsxs(View, { style: [FULL, { alignItems: "center", justifyContent: "center", gap: 16 }], children: [
        jsx(Icon, { name: "play", size: 40, color: colors.accentHi }),
        jsx(Text, { style: text(30, colors.fg, { fontWeight: 600 }), children: t2("tube.loadingVideo") }),
        jsx(Text, { style: text(22, colors.muted, { numberOfLines: 1, ellipsizeMode: "tail", width: 1400, textAlign: "center" }), children: title })
      ] }) : null,
      phase === "failed" ? jsxs(View, { style: [FULL, { alignItems: "center", justifyContent: "center", gap: 16 }], children: [
        jsx(Icon, { name: "alert", size: 40, color: "#f87171" }),
        jsx(Text, { style: text(30, colors.fg, { fontWeight: 600 }), children: t2("tube.playFailed", { error: problem || "?" }) }),
        jsx(Text, { style: text(22, colors.muted, { numberOfLines: 1, ellipsizeMode: "tail", width: 1400, textAlign: "center" }), children: title })
      ] }) : null,
      notice ? jsx(View, { style: { position: "absolute", top: 48, right: 48, borderRadius: radius.md, backgroundColor: `${colors.surface}e6`, paddingHorizontal: 24, paddingVertical: 14 }, children: jsx(Text, { style: text(22, colors.fg, { fontWeight: 600 }), children: notice }) }) : null,
      bar || paused || phase !== "playing" ? jsxs(View, { style: { position: "absolute", left: 0, right: 0, bottom: 0, paddingTop: 90, backgroundGradient: { type: "linear", to: "top", stops: [{ color: "#000000e6", offset: 0 }, { color: "#00000000", offset: 1 }] } }, children: [
        jsxs(View, { style: { paddingHorizontal: 64, gap: 6 }, children: [
          jsx(Text, { style: text(30, "#ffffff", { fontWeight: 700, numberOfLines: 1, ellipsizeMode: "tail" }), children: title }),
          jsx(Text, { style: text(22, "#cbd5e1", { numberOfLines: 1, ellipsizeMode: "tail" }), children: [info?.channel || item.channel, current?.label].filter(Boolean).join("  ·  ") }),
          jsxs(View, { style: { flexDirection: "row", alignItems: "center", gap: 18, marginTop: 10 }, children: [
            jsx(Icon, { name: paused ? "play" : "pause", size: 22, color: "#ffffff" }),
            jsx(Text, { style: text(22, "#ffffff", { width: 110 }), children: clockText(position) }),
            jsx(View, { style: { flex: 1, height: 8, borderRadius: radius.pill, backgroundColor: "#ffffff40" }, children: jsx(View, { style: { width: `${Math.round(progress * 1e3) / 10}%`, height: 8, borderRadius: radius.pill, backgroundColor: colors.accentHi } }) }),
            jsx(Text, { style: text(22, "#ffffff", { width: 110, textAlign: "right" }), children: clockText(duration) })
          ] })
        ] }),
        jsx(ButtonHints, { hints: HINTS })
      ] }) : null,
      menu && info ? jsx(SideSheet, { title: t2("tube.quality"), subtitle: title, onClose: () => setMenu(false), hints: QUALITY_HINTS, width: 620, children: jsx(View, { style: { gap: 4, padding: 9 }, children: info.choices.map((entry, index) => jsx(QualityRow, { choice: entry, current: index === choice, autoFocus: index === choice, onPress: () => chooseQuality(index) }, entry.label)) }) }) : null
    ] }) });
  }

export { TubePlayer };
