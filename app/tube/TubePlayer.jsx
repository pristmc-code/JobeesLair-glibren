// glibren-tube: o player do YouTube dentro da Jobee'sLair, em tela cheia (useImmersive: sem cabecalho nem rodape).
// Toca com o <Video> do ps5-react (docs/VIDEO.md) a playlist HLS master (video + audio num link so) que o
// tube-service.elf monta em 127.0.0.1 para a qualidade escolhida; sem cabecalhos (o token nao vai ao YouTube; /media
// nao pede token).
//   - Qualidade: a melhor ate 1080p (state/tube-service.js defaultChoice); R2 abre a lista; trocar reabre na mesma
//     posicao (startTime). glibren.55: o formato fica guardado (tube-settings.js tubeCodec): a linha "Automatico"
//     (prefere o H.264) ou o formato da qualidade escolhida (H.264/VP9) vale para os proximos videos; as de VP9 tem um
//     aviso (pode engasgar; VP9 HDR vai pelo processador), e decodificado pelo processador o player avisa.
//   - Legendas: a do idioma do app (WebVTT do servico, prop `subtitles`, faixa 1000); Triangulo liga/desliga (fica
//     guardado, state/tube-settings.js); o texto e desenhado pelo app (onSubtitle).
//   - SponsorBlock (Configuracoes > Videos, ligado por padrao): ao entrar num trecho, pula para o fim dele.
//   - X pausa/continua; Esquerda/Direita ou L1/R1 voltam/avancam 10 s; Circulo fecha (com a lista de qualidades aberta,
//     fecha so a lista).
//   - Erro do player: resolve de novo com links novos (fresh) e reabre na posicao; de novo, tenta a qualidade abaixo
//     do mesmo formato (glibren.55: tube-service.js fallbackChoice; antes ia para a proxima da lista, o VP9 da mesma
//     altura, e o H.264 "voltava sozinho" para o VP9), avisando qual; sem mais nenhuma, diz o erro. glibren.42 (A11): os links sao renovados de novo depois de um tempo tocando
//     (FRESH_AFTER_MS), ate FRESH_MAX vezes por video (antes, uma vez so: um video longo ou pausado por horas parava).
//   - glibren.42: video que pede login (authentication_required) manda entrar em Configuracoes > Videos; conta vencida
//     ou sem acesso dizem isso; o que abriu pela conta mostra "pela sua conta" na barra. glibren.44: com um servico
//     antigo (sem a conta) e uma versao nova pronta, troca o servico e tenta o video de novo uma vez; conta sem a idade
//     confirmada (account_age_unverified, servico 0.2.2) tem texto proprio.
//   - glibren-fast: abre na hora (o resolve pode ja estar pronto: o pre-resolve da tela de resultados) com a miniatura
//     do video e um indicador ate o primeiro quadro (fase "opening" entre o resolve e o onLoad/primeiro onProgress).

import '../assets/Exo2.ttf';
import { jsx, jsxs } from 'react/jsx-runtime';
import { useEffect, useRef, useState } from 'react';
import { getLocale } from '../i18n/core.js';
import { useT } from '../i18n/index.js';
import { useImmersive } from '../state/nav.jsx';
import { choiceNote, clockText, codecFamily, defaultChoice, fallbackChoice, sponsorSkipTo, tubeService } from '../state/tube-service.js';
import { setTubeCodec, setTubeSubtitles, tubeCodec, tubeDownloadCap, tubeQuality, tubeSponsorBlock, useTubeCodec, useTubeSubtitles } from '../state/tube-settings.js';
import { setVideoCap } from '../state/speed-limit.js';
import { holdMedia } from '../state/activity.js';
import { ButtonHints } from '../ui/ButtonHints.jsx';
import { Skeleton } from '../ui/Skeleton.jsx';
import { FocusRing } from '../ui/FocusRing.jsx';
import { Icon } from '../ui/Icon.jsx';
import { SideSheet } from '../ui/SideSheet.jsx';
import { colors, radius } from '../ui/colors.js';
import { FocusScope, Image, Text, Video, View, useControllerEvents } from '@ps5-react/core';

  var SEEK_STEP = 10;
  var BAR_MS = 4e3;
  var NOTICE_MS = 2500;
  var SUBTITLE_TRACK = 1e3;
  var FRESH_AFTER_MS = 6e4;
  var FRESH_MAX = 8;
  // glibren.42: os erros do servico que tem texto proprio (o resto mostra o codigo em tube.playFailed, inteiro).
  // glibren.44: o servico 0.2.2 manda codigos com sufixo ("extraction_failed: UNPLAYABLE (...)"): o texto proprio vale
  // pelo comeco do codigo; o generico mostra o codigo todo. account_age_unverified: a conta precisa confirmar a idade.
  var codeIs = (code, name) => code === name || code.startsWith(`${name}:`) || code.startsWith(`${name} `);
  function problemText(t2, code, accountOffered) {
    const value = String(code ?? "");
    if (codeIs(value, "authentication_required")) return t2(accountOffered ? "tube.needsSignIn" : "tube.needsSignInOld");
    if (codeIs(value, "account_expired")) return t2("tube.accountExpired");
    if (codeIs(value, "account_not_allowed")) return t2("tube.accountNotAllowed");
    if (codeIs(value, "account_age_unverified")) return t2("tube.accountAgeUnverified");
    return t2("tube.playFailed", { error: value || "?" });
  } // os arquivos de `subtitles` sao listados a partir de 1000 (docs/VIDEO.md)
  /**
   * glibren.44: o resolve do player (`run`), e uma segunda vez quando o video pede login e o servico no ar e um antigo
   * sem a conta, com uma versao nova pronta: troca o servico agora (tube-service.js upgradeNow; nunca com outro job
   * andando) e tenta de novo, uma vez por video (`state.upgraded`). `stopped()`: o player fechou.
   */
  async function resolveWithUpgrade(service, run, { state, stopped = () => false, log = () => {} }) {
    try {
      return await run();
    } catch (error) {
      const code = String(error?.code ?? error?.message ?? "");
      if (stopped() || state.upgraded || !codeIs(code, "authentication_required") || service.hasAccount?.() || !service.newerReady?.() || !service.upgradeNow) throw error;
      state.upgraded = true;
      service.cancelPrefetch?.();
      let swapped = null;
      try {
        swapped = await service.upgradeNow();
      } catch (swapError) {
        swapped = { ok: false, reason: swapError?.message ?? String(swapError) };
      }
      log(`needs an account; service ${swapped?.ok ? `now ${swapped.version ?? ""}` : `not swapped (${swapped?.reason ?? "?"})`}`);
      if (!swapped?.ok || stopped()) throw error;
      return run();
    }
  }
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
  // A miniatura que a lista ja mostrou (mesmo endereco: costuma vir do cache de imagens), maior, no "carregando".
  var thumb = (id) => `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;
  var POSTER_W = 640, POSTER_H = 360;

  /** O "carregando" do player: a miniatura do video, um indicador pulsando e o titulo. */
  function Opening({ id, label, title }) {
    return jsxs(View, { style: [FULL, { alignItems: "center", justifyContent: "center", gap: 22, backgroundColor: "#000000" }], children: [
      jsx(View, { style: { width: POSTER_W, height: POSTER_H, borderRadius: radius.md, roundedClip: true, backgroundColor: colors.surface2 }, children: jsx(Image, { source: { uri: thumb(id) }, style: { width: POSTER_W, height: POSTER_H }, resizeMode: "cover" }) }),
      jsx(Skeleton, { pulse: true, style: { width: POSTER_W, height: 8, borderRadius: radius.pill, backgroundColor: colors.accentHi } }),
      jsx(Text, { style: text(30, colors.fg, { fontWeight: 600 }), children: label }),
      jsx(Text, { style: text(22, colors.muted, { numberOfLines: 1, ellipsizeMode: "tail", width: 1400, textAlign: "center" }), children: title })
    ] });
  }

  // glibren.55: o aviso de cada qualidade (tube-service.js choiceNote) e a linha "Automatico".
  var NOTE_TEXT = { vp9: "tube.noteVp9", vp9only: "tube.noteVp9Only", cpu: "tube.noteCpu" };
  var ROW_TEXT_W = 500;
  function QualityRow({ label, note, current, autoFocus, onPress, focusKey }) {
    return jsxs(View, { focusKey, autoFocus, onPress, style: (state) => [{ position: "relative", flexDirection: "row", alignItems: "center", gap: 18, borderRadius: radius.sm, paddingHorizontal: 18, paddingVertical: 16 }, state.focused ? { backgroundColor: colors.surface2 } : null], children: [
      jsx(FocusRing, {}),
      jsx(Icon, { name: current ? "check" : "play", size: 18, color: current ? colors.accentHi : colors.muted }),
      jsxs(View, { style: { gap: 4 }, children: [
        jsx(Text, { style: text(23, colors.fg, { fontWeight: current ? 700 : 500, width: ROW_TEXT_W }), children: label }),
        note ? jsx(Text, { style: text(19, colors.warn ?? "#fbbf24", { width: ROW_TEXT_W }), children: note }) : null
      ] })
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
    // glibren-tube-update: o player usa o servico (os links /media sao dele): uma versao nova so entra depois.
    useEffect(() => service.hold?.(), []);
    // glibren.44: um video aberto: a atualizacao automatica nao reinicia o app (state/auto-restart.js).
    useEffect(() => holdMedia(), []);
    // glibren-video-cap: os downloads ficam limitados enquanto o player esta aberto (Configuracoes > Videos); ao
    // fechar, volta o limite salvo.
    useEffect(() => {
      setVideoCap(tubeDownloadCap());
      return () => setVideoCap(0);
    }, []);
    const [info, setInfo] = useState(() => start?.info ?? null); // { title, channel, duration, choices, caption }
    const [choice, setChoice] = useState(() => start?.choice ?? -1);
    const [startAt, setStartAt] = useState(0);
    const [phase, setPhase] = useState(() => start?.phase ?? "resolving"); // resolving | opening | playing | failed
    const [problem, setProblem] = useState(() => start?.problem ?? "");
    const [paused, setPaused] = useState(false);
    const [position, setPosition] = useState(0);
    const [bar, setBar] = useState(true);
    const [menu, setMenu] = useState(() => Boolean(start?.menu));
    const [subtitle, setSubtitle] = useState("");
    const [notice, setNotice] = useState("");
    // glibren-tube-quality: quem decodifica o video aberto ("sceVideodec2" = o do PS5, "ffmpeg" = software), do onStatus.
    const [decoder, setDecoder] = useState("");
    const video = useRef(null);
    const live = useRef({ position: 0, segments: [], skipUntil: 0, tries: 0, freshCount: 0, freshAt: 0, alive: true, abort: null, upgraded: false, tried: /* @__PURE__ */ new Set(), cpuSaid: "" });
    const codecPref = useTubeCodec();
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
        const next = await resolveWithUpgrade(service, () => service.resolve(item.id, { locale: getLocale?.() ?? "en", fresh, signal }), {
          state,
          stopped: () => !state.alive || signal.aborted,
          log: (line) => console.log(`tube: ${item.id} ${line}`)
        });
        if (!state.alive || signal.aborted) return;
        const same = keepLabel ? next.choices.findIndex((entry) => entry.label === keepLabel) : -1;
        const picked = same >= 0 ? same : defaultChoice(next.choices, tubeQuality(), tubeCodec());
        setInfo(next);
        setChoice(picked);
        setPhase("opening");
        // glibren.55: o formato guardado que este video nao tem, ou o automatico sem H.264: diz o que vai tocar.
        const pickedChoice = next.choices[picked];
        const wanted = tubeCodec();
        if (!keepLabel && pickedChoice && wanted !== "auto" && codecFamily(pickedChoice.codec) !== wanted) say(t2("tube.codecMissing", { codec: wanted === "vp9" ? "VP9" : "H.264", label: pickedChoice.label }));
        else if (!keepLabel && pickedChoice && wanted === "auto" && choiceNote(next.choices, picked) === "vp9only") say(t2("tube.onlyVp9", { label: pickedChoice.label }));
      } catch (error) {
        if (!state.alive || signal.aborted) return;
        setProblem(String(error?.code ?? error?.message ?? String(error)));
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
    // glibren.55: uma escolha do jogador grava o formato (H.264/VP9; "auto" pela linha Automatico) e zera as tentativas
    // (os erros de antes nao contam contra ela: a primeira falha dela ainda pede links novos).
    const switchTo = (index) => {
      const state = live.current;
      state.tries = 0;
      state.tried.clear();
      state.freshCount = 0;
      state.freshAt = 0;
      state.cpuSaid = "";
      if (index === choice || index < 0) return;
      setStartAt(state.position);
      setDecoder("");
      setChoice(index);
      setPhase("opening");
      showBar();
    };
    const chooseQuality = (index) => {
      setMenu(false);
      const family = codecFamily(info?.choices[index]?.codec);
      if (family === "h264" || family === "vp9") setTubeCodec(family);
      switchTo(index);
    };
    const chooseAuto = () => {
      setMenu(false);
      setTubeCodec("auto");
      if (info?.choices.length) switchTo(defaultChoice(info.choices, tubeQuality(), "auto"));
    };
    // O primeiro quadro: sai do "carregando" (o onLoad ou o primeiro onProgress, o que vier antes).
    const opened = () => setPhase((last) => last === "opening" ? "playing" : last);
    const onProgress = ({ currentTime }) => {
      const state = live.current;
      if (phase === "opening") opened();
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
      // 1) os links podem ter vencido: resolve de novo e reabre na mesma qualidade e posicao. A primeira vez sempre; as
      // seguintes so depois de FRESH_AFTER_MS da anterior (um erro logo depois de links novos nao e de link vencido).
      if (state.freshCount === 0 || state.freshCount < FRESH_MAX && Date.now() - state.freshAt >= FRESH_AFTER_MS) {
        state.freshCount += 1;
        state.freshAt = Date.now();
        state.tries = 0;
        setPhase("resolving");
        void load(true, info?.choices[choice]?.label ?? "");
        return;
      }
      // 2) glibren.55: a qualidade abaixo do mesmo formato, depois as outras (tube-service.js fallbackChoice), uma vez
      // cada, dizendo qual; o formato guardado (tubeCodec) nao muda: o proximo video abre no escolhido.
      state.tries += 1;
      const list = info?.choices ?? [];
      if (list[choice]) state.tried.add(list[choice].label);
      const next = fallbackChoice(list, choice, state.tried);
      if (next >= 0) {
        say(t2("tube.fellBack", { label: list[next].label }));
        setDecoder("");
        setChoice(next);
        setPhase("opening");
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
        onLoad: opened,
        onProgress,
        onEnd: () => onClose("end"),
        onError,
        onSubtitle: setSubtitle,
        onStatus: (status) => {
          if (!status?.decoder) return;
          setDecoder(status.decoder);
          // glibren.55: decodificado pelo processador (FFmpeg): avisa uma vez por qualidade aberta.
          if (status.decoder === "ffmpeg" && live.current.cpuSaid !== current.label) {
            live.current.cpuSaid = current.label;
            say(t2("tube.cpuDecoding"));
          }
        }
      }, current.url) : null,
      // A superficie que recebe o X (pausar) e mantem o foco no player.
      jsx(View, { focusKey: "tube:player", autoFocus: true, onPress: togglePause, style: FULL }),
      subsOn && subtitle ? jsx(View, { style: { position: "absolute", left: 160, right: 160, bottom: bar ? 210 : 72, alignItems: "center" }, children: jsx(View, { style: { borderRadius: radius.sm, backgroundColor: "#000000b3", paddingHorizontal: 22, paddingVertical: 10 }, children: jsx(Text, { style: text(36, "#ffffff", { textAlign: "center", fontWeight: 600 }), children: subtitle }) }) }) : null,
      phase === "resolving" || phase === "opening" ? jsx(Opening, { id: item.id, label: t2("tube.loadingVideo"), title }) : null,
      phase === "failed" ? jsxs(View, { style: [FULL, { alignItems: "center", justifyContent: "center", gap: 16 }], children: [
        jsx(Icon, { name: "alert", size: 40, color: "#f87171" }),
        jsx(Text, { style: text(30, colors.fg, { fontWeight: 600, width: 1500, textAlign: "center" }), children: problemText(t2, problem, Boolean(service.hasAccount?.())) }),
        jsx(Text, { style: text(22, colors.muted, { numberOfLines: 1, ellipsizeMode: "tail", width: 1400, textAlign: "center" }), children: title })
      ] }) : null,
      notice ? jsx(View, { style: { position: "absolute", top: 48, right: 48, borderRadius: radius.md, backgroundColor: `${colors.surface}e6`, paddingHorizontal: 24, paddingVertical: 14 }, children: jsx(Text, { style: text(22, colors.fg, { fontWeight: 600 }), children: notice }) }) : null,
      bar || paused || phase !== "playing" ? jsxs(View, { style: { position: "absolute", left: 0, right: 0, bottom: 0, paddingTop: 90, backgroundGradient: { type: "linear", to: "top", stops: [{ color: "#000000e6", offset: 0 }, { color: "#00000000", offset: 1 }] } }, children: [
        jsxs(View, { style: { paddingHorizontal: 64, gap: 6 }, children: [
          jsx(Text, { style: text(30, "#ffffff", { fontWeight: 700, numberOfLines: 1, ellipsizeMode: "tail" }), children: title }),
          jsx(Text, { style: text(22, "#cbd5e1", { numberOfLines: 1, ellipsizeMode: "tail" }), children: [info?.channel || item.channel, current?.label, info?.signedIn ? t2("tube.signedInPlayback") : "", decoder ? t2(decoder === "sceVideodec2" ? "tube.decoderHardware" : "tube.decoderSoftware") : ""].filter(Boolean).join("  ·  ") }),
          jsxs(View, { style: { flexDirection: "row", alignItems: "center", gap: 18, marginTop: 10 }, children: [
            jsx(Icon, { name: paused ? "play" : "pause", size: 22, color: "#ffffff" }),
            jsx(Text, { style: text(22, "#ffffff", { width: 110 }), children: clockText(position) }),
            jsx(View, { style: { flex: 1, height: 8, borderRadius: radius.pill, backgroundColor: "#ffffff40" }, children: jsx(View, { style: { width: `${Math.round(progress * 1e3) / 10}%`, height: 8, borderRadius: radius.pill, backgroundColor: colors.accentHi } }) }),
            jsx(Text, { style: text(22, "#ffffff", { width: 110, textAlign: "right" }), children: clockText(duration) })
          ] })
        ] }),
        jsx(ButtonHints, { hints: HINTS })
      ] }) : null,
      menu && info ? jsx(SideSheet, { title: t2("tube.quality"), subtitle: title, onClose: () => setMenu(false), hints: QUALITY_HINTS, width: 620, children: jsxs(View, { style: { gap: 4, padding: 9 }, children: [
        jsx(QualityRow, { focusKey: "tube:quality:auto", label: t2("tube.formatAuto"), note: "", current: codecPref === "auto", autoFocus: false, onPress: chooseAuto }, "auto"),
        ...info.choices.map((entry, index) => {
          const note = choiceNote(info.choices, index);
          return jsx(QualityRow, { focusKey: `tube:quality:${entry.label}`, label: entry.label, note: note ? t2(NOTE_TEXT[note]) : "", current: index === choice, autoFocus: index === choice, onPress: () => chooseQuality(index) }, entry.label);
        })
      ] }) }) : null
    ] }) });
  }

export { problemText, resolveWithUpgrade, TubePlayer };
