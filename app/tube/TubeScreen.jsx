// glibren-tube: a tela de videos do YouTube dentro da Jobee'sLair (rota "tube", index.jsx). Busca pelo tube-service.elf
// (state/tube-service.js) e toca no player interno (TubePlayer.jsx), sem abrir outro app.
//   - Campo de busca: o teclado do sistema (state/system-keyboard.js), como a busca da loja; sem ele, as teclas da
//     loja (search/DockKeyboard.jsx). Triangulo tambem abre.
//   - Filtros (cada um troca ao apertar X e busca de novo): ordem (relevancia / mais vistos), duracao (qualquer /
//     menos de 3 min / 3 a 20 min / mais de 20 min), data de envio (qualquer / hoje / semana / mes / ano) e tipo
//     (videos / Shorts / tudo). O servico nao ordena por data: a "data de envio" filtra.
//   - Resultados em grade (miniatura, titulo, canal e duracao), uma pagina por vez (ate 24, so os campos da tela):
//     "Proxima pagina" segue o cursor do servico; "Pagina anterior" refaz pelos cursores guardados.
//   - Abrir um video troca a tela pelo player; Circulo no player volta aqui com a mesma busca, filtros, pagina e o
//     mesmo item focado. Aberta com `auto` (Trailer/Gameplay com "Tocar o primeiro video automaticamente"), toca
//     direto o primeiro video normal (state/tube-service.js pickFirstVideo) e o Circulo no player volta para a
//     pagina do jogo (onBack).
//   - glibren-fast: o item focado por um instante (PREFETCH_DWELL_MS) e resolvido em segundo plano
//     (service.prefetch); sair dele cancela. No modo auto, o primeiro video comeca a ser resolvido assim que a busca
//     responde, antes do player montar. Ao abrir, o player usa o resolve pronto (ou o em andamento).
//   - glibren-a: aberta pelo pedido do glibren (state/tube-request.js) com `ensure` (sobe o servico antes; sem ele, o
//     erro na tela) e `back` (o title ID de voltar=): o botao "Voltar ao glibren" no topo, e o Circulo na raiz (ou ao
//     fechar o video no modo auto) pede ao payload a troca de volta e fecha o app; se a troca falhar, um aviso curto e
//     o inicio da Jobe.

import '../assets/Exo2.ttf';
import { jsx, jsxs } from 'react/jsx-runtime';
import { useEffect, useRef, useState } from 'react';
import { getLocale } from '../i18n/core.js';
import { useT } from '../i18n/index.js';
import { FIRST_KEY, KeyboardSheet } from '../search/DockKeyboard.jsx';
import { useNavActions } from '../state/nav.jsx';
import { systemKeyboardOn, typeOnSystemKeyboard } from '../state/system-keyboard.js';
import { DEFAULT_FILTERS, DURATIONS, ORDERS, TYPES, UPLOADS, checkTubeUpdateSoon, clockText, pickFirstVideo, tubeService } from '../state/tube-service.js';
import { FocusRing } from '../ui/FocusRing.jsx';
import { Icon } from '../ui/Icon.jsx';
import { HINT, useHints } from '../ui/Legend.jsx';
import { colors, radius } from '../ui/colors.js';
import { TubePlayer } from './TubePlayer.jsx';
import { backToCaller } from '../state/tube-request-run.js';
import { FocusScope, Image, ScrollView, Text, View } from '@ps5-react/core';

  var MAX_QUERY = 100;
  // Quanto o aviso "nao deu para voltar ao glibren" fica antes de ir ao inicio da Jobe.
  var LEAVE_FAILED_MS = 2500;
  var COLUMNS = 4;
  // Quanto o foco fica num video antes de resolver em segundo plano (passar rapido pela grade nao pede nada).
  var PREFETCH_DWELL_MS = 300;
  var localeNow = () => getLocale?.() ?? "en";
  var CARD_W = 438, THUMB_H = 246;
  var HINTS = [HINT.select, { button: "triangle", label: "hints.type" }, HINT.back];
  var text = (size, color, extra) => ({ fontFamily: "Exo2", fontSize: size, lineHeight: Math.round(size * 1.4), color, ...extra });
  var FILTERS = [
    { key: "order", values: ORDERS, label: (t2, value) => t2(`tube.order.${value}`), icon: "list" },
    { key: "duration", values: DURATIONS, label: (t2, value) => t2(`tube.duration.${value}`), icon: "restart" },
    { key: "upload_date", values: UPLOADS, label: (t2, value) => t2(`tube.upload.${value}`), icon: "star" },
    { key: "type", values: TYPES, label: (t2, value) => t2(`tube.type.${value}`), icon: "play" }
  ];
  var itemKey = (id) => `tube:item:${id}`;
  // A miniatura pequena (320x180) do proprio YouTube: menos memoria que a do servico (480x360 com faixas).
  var thumb = (id) => `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;

  function Field({ query, onPress }) {
    const t2 = useT();
    return jsxs(View, { focusKey: "tube:field", onPress, style: (state) => [{ position: "relative", flex: 1, height: 80, flexDirection: "row", alignItems: "center", gap: 18, borderRadius: radius.lg, borderWidth: 2, borderColor: state.focused ? colors.accentHi : colors.line, backgroundColor: colors.surface, paddingHorizontal: 30 }], children: [
      jsx(FocusRing, { round: "lg" }),
      jsx(Icon, { name: "search", size: 22, color: colors.accentHi }),
      jsx(Text, { style: text(28, query ? colors.fg : colors.subtle, { flex: 1, fontWeight: query ? 600 : 400, numberOfLines: 1, ellipsizeMode: "tail" }), children: query || t2("tube.searchPlaceholder") }),
      jsx(Text, { style: text(20, colors.muted), children: "YouTube" })
    ] });
  }
  function FilterChip({ id, icon, label, active, onPress }) {
    return jsxs(View, { focusKey: `tube:filter:${id}`, onPress, style: (state) => [{ position: "relative", height: 52, flexDirection: "row", alignItems: "center", gap: 8, borderRadius: radius.md, paddingHorizontal: 20, backgroundColor: active ? colors.accent : colors.surface2 }, state.focused && !active ? { backgroundColor: colors.surface3 } : null], children: [
      jsx(FocusRing, { round: "md" }),
      jsx(Icon, { name: icon, size: 14, color: active ? "#ffffff" : colors.fg }),
      jsx(Text, { style: text(20, active ? "#ffffff" : colors.fg, { fontWeight: 600 }), children: label })
    ] });
  }
  function Badge({ label, tone }) {
    return jsx(View, { style: { borderRadius: radius.xs, backgroundColor: tone, paddingHorizontal: 8, paddingVertical: 2 }, children: jsx(Text, { style: text(17, "#ffffff", { fontWeight: 700 }), children: label }) });
  }
  function VideoCard({ item, onPress, onFocus, onBlur }) {
    const t2 = useT();
    const corner = item.live ? jsx(Badge, { label: t2("tube.live"), tone: "#dc2626" }) : item.upcoming ? jsx(Badge, { label: t2("tube.upcoming"), tone: colors.surface3 }) : item.seconds ? jsx(Badge, { label: clockText(item.seconds), tone: "#000000cc" }) : null;
    return jsxs(View, { focusKey: itemKey(item.id), onPress, onFocus, onBlur, style: (state) => [{ position: "relative", width: CARD_W, gap: 8, borderRadius: radius.md, padding: 8, marginHorizontal: -8 }, state.focused ? { backgroundColor: colors.surface2 } : null], children: [
      jsx(FocusRing, { round: "md" }),
      jsxs(View, { style: { width: CARD_W - 16, height: THUMB_H - 9, borderRadius: radius.sm, roundedClip: true, backgroundColor: colors.surface2 }, children: [
        jsx(Image, { source: { uri: thumb(item.id) }, style: { width: CARD_W - 16, height: THUMB_H - 9 }, resizeMode: "cover" }),
        corner ? jsx(View, { style: { position: "absolute", right: 10, bottom: 10 }, children: corner }) : null,
        item.short ? jsx(View, { style: { position: "absolute", left: 10, top: 10 }, children: jsx(Badge, { label: t2("tube.short"), tone: colors.accent }) }) : null
      ] }),
      jsx(Text, { style: text(22, colors.fg, { fontWeight: 600, numberOfLines: 2, ellipsizeMode: "tail", width: CARD_W - 16 }), children: item.title }),
      jsx(Text, { style: text(19, colors.muted, { numberOfLines: 1, ellipsizeMode: "tail", width: CARD_W - 16 }), children: item.channel })
    ] });
  }
  function PageButton({ id, icon, label, onPress }) {
    return jsxs(View, { focusKey: `tube:page:${id}`, onPress, style: (state) => [{ position: "relative", height: 60, flexDirection: "row", alignItems: "center", gap: 12, borderRadius: radius.md, paddingHorizontal: 26, backgroundColor: state.focused ? colors.surface3 : colors.surface2 }], children: [
      jsx(FocusRing, { round: "md" }),
      jsx(Icon, { name: icon, size: 16, color: colors.fg }),
      jsx(Text, { style: text(21, colors.fg, { fontWeight: 600 }), children: label })
    ] });
  }
  function Message({ icon, title, detail, action }) {
    return jsxs(View, { style: { alignItems: "center", gap: 14, paddingTop: 60 }, children: [
      jsx(Icon, { name: icon, size: 30, color: colors.subtle }),
      jsx(Text, { style: text(26, colors.fg, { fontWeight: 600, textAlign: "center" }), children: title }),
      detail ? jsx(Text, { style: text(21, colors.muted, { textAlign: "center", width: 1200 }), children: detail }) : null,
      action ?? null
    ] });
  }

  /**
   * `query`: a busca inicial; `auto`: tocar o primeiro video normal assim que a busca responder (e o Circulo no player
   * volta para onBack); `service`: o cliente (testes); `start`: o estado inicial (testes: { page, playing, leaving }).
   * glibren-a: `ensure`: sobe o servico (service.ensure) antes da primeira busca; `back`: o title ID para voltar (o
   * pedido do glibren); `goBack(back)`: a volta (state/tube-request-run.js backToCaller; trocado nos testes).
   */
  function TubeScreen({ query: initialQuery = "", auto = false, back = "", ensure = false, goBack = backToCaller, onBack, service = tubeService(), start = null }) {
    const t2 = useT();
    const { focusLater } = useNavActions();
    useHints(HINTS);
    const [query, setQuery] = useState(initialQuery);
    const [filters, setFilters] = useState(DEFAULT_FILTERS);
    const [page, setPage] = useState(() => start?.page ?? { state: ensure ? "starting" : initialQuery ? "loading" : "idle", items: [], cursor: "", index: 0, error: "" });
    const [playing, setPlaying] = useState(() => start?.playing ?? null); // { item, back: true quando o Circulo sai da tela }
    const [typing, setTyping] = useState(false);
    // glibren-tube-update: a tela usa o servico (uma versao nova so entra depois que ela fecha) e, ao abrir, olha se ha
    // versao nova dele (no maximo 1x a cada 6 h, em segundo plano).
    useEffect(() => {
      checkTubeUpdateSoon();
      return service.hold?.();
    }, []);
    // glibren-a: a volta ao glibren em curso ({ text }) ou recusada ({ bad, text }).
    const [leaving, setLeaving] = useState(() => start?.leaving ?? null);
    const leavingNow = useRef(false);
    const leaveTimer = useRef(null);
    const typed = useRef(query);
    typed.current = query;
    const cursors = useRef([""]); // cursors.current[n]: o cursor que leva a pagina n ("" na 0)
    const run = useRef({ n: 0, abort: null, autoDone: !(auto && initialQuery) });
    // glibren-fast: o pre-resolve do item focado (o timer do instante de foco e o video sendo aberto, que um onBlur
    // na troca de tela nao deve cancelar).
    const prefetchTimer = useRef(null);
    const opening = useRef("");
    const focusItem = (item) => {
      clearTimeout(prefetchTimer.current);
      if (item.upcoming) return;
      prefetchTimer.current = setTimeout(() => service.prefetch?.(item.id, { locale: localeNow() }), PREFETCH_DWELL_MS);
    };
    const blurItem = (item) => {
      clearTimeout(prefetchTimer.current);
      if (opening.current !== item.id) service.cancelPrefetch?.(opening.current);
    };
    const load = (q, f, index) => {
      const state = run.current;
      state.abort?.();
      clearTimeout(prefetchTimer.current);
      service.cancelPrefetch?.();
      const n = ++state.n;
      const listeners = /* @__PURE__ */ new Set();
      const signal = { aborted: false, addEventListener: (type, listener) => listeners.add(listener), removeEventListener: (type, listener) => listeners.delete(listener) };
      state.abort = () => {
        signal.aborted = true;
        for (const listener of [...listeners]) listener();
      };
      if (index === 0) cursors.current = [""];
      setPage((last) => ({ ...last, state: "loading", error: "" }));
      const asked = index === 0 ? service.search(q, f, { signal }) : service.more(cursors.current[index], { signal });
      asked.then((result) => {
        if (n !== state.n) return;
        cursors.current[index + 1] = result.cursor;
        setPage({ state: "ready", items: result.items, cursor: result.cursor, index, error: "" });
        if (!state.autoDone) {
          state.autoDone = true;
          const first = pickFirstVideo(result.items);
          if (first) {
            console.log(`tube: auto-play ${first.id}`); // glibren.41 (A7): sem o texto da busca no log
            opening.current = first.id;
            service.prefetch?.(first.id, { locale: localeNow() });
            setPlaying({ item: first, back: true });
            return;
          }
        }
        focusLater(result.items.length ? itemKey(result.items[0].id) : "tube:field");
      }, (error) => {
        if (n !== state.n || error?.code === "cancelled") return;
        // Um cursor vencido (~120 s): a busca volta ao comeco.
        if (index > 0 && /expired|invalid/.test(String(error?.code ?? ""))) return load(q, f, 0);
        console.log(`tube: search failed: ${error?.code ?? ""} ${error?.message ?? error}`);
        setPage((last) => ({ ...last, state: "error", error: error?.code ?? error?.message ?? String(error) }));
      });
    };
    // glibren-a: o servico no ar antes da primeira busca (aberta pelo glibren, sem passar pela folha Videos). Sem
    // busca, abre o teclado.
    const startService = () => {
      const state = run.current;
      const n = ++state.n;
      setPage((last) => ({ ...last, state: "starting", error: "" }));
      Promise.resolve().then(() => service.ensure()).then((ready) => ready, (error) => ({ ok: false, reason: error?.message ?? String(error) })).then((ready) => {
        if (n !== state.n) return;
        console.log(`tube: service ${ready?.ok ? `up ${ready.version ?? ""}` : `${ready?.reason ?? ""} ${ready?.error ?? ""}`}`);
        if (!ready?.ok) {
          setPage((last) => ({ ...last, state: "down", error: [ready?.reason, ready?.error].filter(Boolean).join(": ") }));
          focusLater(back ? "tube:page:glibren-down" : "tube:page:retry");
          return;
        }
        if (initialQuery) {
          load(initialQuery, filters, 0);
          return;
        }
        setPage((last) => ({ ...last, state: "idle" }));
        type();
      });
    };
    useEffect(() => {
      if (!start) {
        if (ensure) startService();
        else if (initialQuery) load(initialQuery, filters, 0);
      }
      return () => {
        run.current.abort?.();
        ++run.current.n;
        clearTimeout(leaveTimer.current);
        clearTimeout(prefetchTimer.current);
        service.cancelPrefetch?.();
      };
    }, []);
    // glibren-a: o Circulo na raiz. Com `back`, volta ao glibren (troca pelo payload e fecha o app); se a troca falhar,
    // um aviso curto e o inicio da Jobe. Sem `back`, a tela anterior (onBack), como sempre.
    const leaveRoot = () => {
      run.current.abort?.();
      if (!back) {
        onBack();
        return;
      }
      if (leavingNow.current) return;
      leavingNow.current = true;
      setLeaving({ text: t2("tube.leaving") });
      Promise.resolve().then(() => goBack(back)).then((result) => result, (error) => ({ ok: false, error: error?.message ?? String(error) })).then((result) => {
        if (result?.ok) return;
        setLeaving({ bad: true, text: t2("tube.leaveFailed", { error: result?.error || "?" }) });
        leaveTimer.current = setTimeout(onBack, LEAVE_FAILED_MS);
      });
    };
    const search = (term) => {
      const clean = term.replace(/\s+/g, " ").trim().slice(0, MAX_QUERY);
      setQuery(clean);
      if (clean) load(clean, filters, 0);
    };
    const type = () => {
      if (!systemKeyboardOn()) {
        setTyping(true);
        focusLater(FIRST_KEY);
        return;
      }
      void typeOnSystemKeyboard({ title: t2("tube.searchPlaceholder"), text: query, maxLength: MAX_QUERY, enter: "search" }).then((result) => {
        if (!result) {
          setTyping(true);
          focusLater(FIRST_KEY);
          return;
        }
        if (result.status === "done") search(result.text);
        else focusLater("tube:field");
      });
    };
    const cycle = (key) => {
      const spec = FILTERS.find((entry) => entry.key === key);
      const at = spec.values.indexOf(filters[key]);
      const next = { ...filters, [key]: spec.values[(at + 1) % spec.values.length] };
      setFilters(next);
      if (query) load(query, next, 0);
    };
    const open = (item) => {
      clearTimeout(prefetchTimer.current);
      opening.current = item.id;
      setPlaying({ item, back: false });
    };
    const closePlayer = () => {
      const was = playing;
      opening.current = "";
      setPlaying(null);
      if (was?.back) {
        leaveRoot();
        return;
      }
      if (was) focusLater(itemKey(was.item.id));
    };
    // glibren-a: "Voltando ao glibren" (ou o aviso de que nao deu) no lugar da tela, ate o app fechar.
    if (leaving) return jsx(View, { style: { flex: 1, backgroundColor: colors.canvas }, children: jsx(FocusScope, { autoFocus: true, onBack: () => true, children: jsx(Message, { icon: leaving.bad ? "alert" : "restart", title: leaving.text }) }) });
    if (playing) return jsx(TubePlayer, { item: playing.item, service, onClose: closePlayer }, playing.item.id);
    const onAction = (action) => {
      if (action === "triangle" && !typing) type();
      else return false;
      return true;
    };
    const rows = [];
    for (let at = 0; at < page.items.length; at += COLUMNS) rows.push(page.items.slice(at, at + COLUMNS));
    const backButton = (id) => jsx(PageButton, { id, icon: "chevronLeft", label: t2("tube.backToGlibren"), onPress: leaveRoot });
    const results = page.state === "starting" ? jsx(Message, { icon: "restart", title: t2("videos.preparing") })
      : page.state === "down" ? jsx(Message, { icon: "alert", title: t2("videos.tubeFailed", { error: page.error || "?" }), action: jsxs(View, { style: { flexDirection: "row", gap: 16 }, children: [
        back ? backButton("glibren-down") : null,
        jsx(PageButton, { id: "retry", icon: "restart", label: t2("tube.retry"), onPress: startService })
      ] }) })
      : page.state === "loading" ? jsx(Message, { icon: "search", title: t2("tube.loading") })
      : page.state === "error" ? jsx(Message, { icon: "alert", title: t2("tube.failed", { error: page.error }), action: jsx(PageButton, { id: "retry", icon: "restart", label: t2("tube.retry"), onPress: () => load(query, filters, page.index) }) })
      : page.state === "idle" ? jsx(Message, { icon: "search", title: t2("tube.searchPlaceholder") })
      : !page.items.length ? jsx(Message, { icon: "searchX", title: t2("tube.none", { query }) })
      : jsxs(View, { style: { gap: 18 }, children: [
        ...rows.map((row, index) => jsx(View, { style: { flexDirection: "row", gap: 24 }, children: row.map((item) => jsx(VideoCard, { item, onPress: () => open(item), onFocus: () => focusItem(item), onBlur: () => blurItem(item) }, item.id)) }, `row:${index}`)),
        page.index > 0 || page.cursor ? jsxs(View, { style: { flexDirection: "row", gap: 16, justifyContent: "center", paddingTop: 8 }, children: [
          page.index > 0 ? jsx(PageButton, { id: "previous", icon: "chevronLeft", label: t2("tube.previous"), onPress: () => load(query, filters, page.index - 1) }) : null,
          jsx(Text, { style: text(21, colors.muted, { alignSelf: "center" }), children: t2("tube.page", { page: page.index + 1 }) }),
          page.cursor ? jsx(PageButton, { id: "next", icon: "chevronRight", label: t2("tube.next"), onPress: () => load(query, filters, page.index + 1) }) : null
        ] }) : null
      ] });
    return jsxs(View, { style: { flex: 1, backgroundColor: colors.canvas }, children: [
      jsx(FocusScope, { autoFocus: !typing, inert: typing, onBack: () => {
        leaveRoot();
        return true;
      }, onAction, children: jsxs(ScrollView, { style: { flex: 1, gap: 22, paddingHorizontal: 48, paddingTop: 24, paddingBottom: typing ? 300 : 72 }, children: [
        jsxs(View, { scrollAnchor: true, style: { gap: 18 }, children: [
          jsxs(View, { style: { height: 80, flexDirection: "row", alignItems: "center", gap: 16 }, children: [
            back ? backButton("glibren") : null,
            jsx(Field, { query, onPress: type })
          ] }),
          jsx(View, { style: { flexDirection: "row", flexWrap: "wrap", gap: 12 }, children: FILTERS.map((spec) => jsx(FilterChip, { id: spec.key, icon: spec.icon, label: spec.label(t2, filters[spec.key]), active: filters[spec.key] !== DEFAULT_FILTERS[spec.key], onPress: () => cycle(spec.key) }, spec.key)) }),
          query && page.state === "ready" ? jsx(Text, { style: text(28, colors.fg, { fontWeight: 600, numberOfLines: 1, ellipsizeMode: "tail" }), children: t2("tube.resultsFor", { query }) }) : null
        ] }),
        jsx(FocusScope, { focusKey: "tube:results", children: results })
      ] }) }),
      typing ? jsx(KeyboardSheet, { onChange: (update) => setQuery((last) => update(last)), onSubmit: () => {
        setTyping(false);
        search(typed.current);
      }, onClose: () => {
        setTyping(false);
        focusLater("tube:field");
      } }) : null
    ] });
  }

export { TubeScreen };
