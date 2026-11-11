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

import '../assets/Exo2.ttf';
import { jsx, jsxs } from 'react/jsx-runtime';
import { useEffect, useRef, useState } from 'react';
import { useT } from '../i18n/index.js';
import { FIRST_KEY, KeyboardSheet } from '../search/DockKeyboard.jsx';
import { useNavActions } from '../state/nav.jsx';
import { systemKeyboardOn, typeOnSystemKeyboard } from '../state/system-keyboard.js';
import { DEFAULT_FILTERS, DURATIONS, ORDERS, TYPES, UPLOADS, clockText, pickFirstVideo, tubeService } from '../state/tube-service.js';
import { FocusRing } from '../ui/FocusRing.jsx';
import { Icon } from '../ui/Icon.jsx';
import { HINT, useHints } from '../ui/Legend.jsx';
import { colors, radius } from '../ui/colors.js';
import { TubePlayer } from './TubePlayer.jsx';
import { FocusScope, Image, ScrollView, Text, View } from '@ps5-react/core';

  var MAX_QUERY = 100;
  var COLUMNS = 4;
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
  function VideoCard({ item, onPress }) {
    const t2 = useT();
    const corner = item.live ? jsx(Badge, { label: t2("tube.live"), tone: "#dc2626" }) : item.upcoming ? jsx(Badge, { label: t2("tube.upcoming"), tone: colors.surface3 }) : item.seconds ? jsx(Badge, { label: clockText(item.seconds), tone: "#000000cc" }) : null;
    return jsxs(View, { focusKey: itemKey(item.id), onPress, style: (state) => [{ position: "relative", width: CARD_W, gap: 8, borderRadius: radius.md, padding: 8, marginHorizontal: -8 }, state.focused ? { backgroundColor: colors.surface2 } : null], children: [
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
   * volta para onBack); `service`: o cliente (testes); `start`: o estado inicial (testes: { page, playing }).
   */
  function TubeScreen({ query: initialQuery = "", auto = false, onBack, service = tubeService(), start = null }) {
    const t2 = useT();
    const { focusLater } = useNavActions();
    useHints(HINTS);
    const [query, setQuery] = useState(initialQuery);
    const [filters, setFilters] = useState(DEFAULT_FILTERS);
    const [page, setPage] = useState(() => start?.page ?? { state: initialQuery ? "loading" : "idle", items: [], cursor: "", index: 0, error: "" });
    const [playing, setPlaying] = useState(() => start?.playing ?? null); // { item, back: true quando o Circulo sai da tela }
    const [typing, setTyping] = useState(false);
    const typed = useRef(query);
    typed.current = query;
    const cursors = useRef([""]); // cursors.current[n]: o cursor que leva a pagina n ("" na 0)
    const run = useRef({ n: 0, abort: null, autoDone: !auto });
    const load = (q, f, index) => {
      const state = run.current;
      state.abort?.();
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
            console.log(`tube: auto-play ${first.id} for "${q}"`);
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
    useEffect(() => {
      if (initialQuery && !start) load(initialQuery, filters, 0);
      return () => run.current.abort?.();
    }, []);
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
    const open = (item) => setPlaying({ item, back: false });
    const closePlayer = () => {
      const was = playing;
      setPlaying(null);
      if (was?.back) {
        onBack();
        return;
      }
      if (was) focusLater(itemKey(was.item.id));
    };
    if (playing) return jsx(TubePlayer, { item: playing.item, service, onClose: closePlayer }, playing.item.id);
    const onAction = (action) => {
      if (action === "triangle" && !typing) type();
      else return false;
      return true;
    };
    const rows = [];
    for (let at = 0; at < page.items.length; at += COLUMNS) rows.push(page.items.slice(at, at + COLUMNS));
    const results = page.state === "loading" ? jsx(Message, { icon: "search", title: t2("tube.loading") })
      : page.state === "error" ? jsx(Message, { icon: "alert", title: t2("tube.failed", { error: page.error }), action: jsx(PageButton, { id: "retry", icon: "restart", label: t2("tube.retry"), onPress: () => load(query, filters, page.index) }) })
      : page.state === "idle" ? jsx(Message, { icon: "search", title: t2("tube.searchPlaceholder") })
      : !page.items.length ? jsx(Message, { icon: "searchX", title: t2("tube.none", { query }) })
      : jsxs(View, { style: { gap: 18 }, children: [
        ...rows.map((row, index) => jsx(View, { style: { flexDirection: "row", gap: 24 }, children: row.map((item) => jsx(VideoCard, { item, onPress: () => open(item) }, item.id)) }, `row:${index}`)),
        page.index > 0 || page.cursor ? jsxs(View, { style: { flexDirection: "row", gap: 16, justifyContent: "center", paddingTop: 8 }, children: [
          page.index > 0 ? jsx(PageButton, { id: "previous", icon: "chevronLeft", label: t2("tube.previous"), onPress: () => load(query, filters, page.index - 1) }) : null,
          jsx(Text, { style: text(21, colors.muted, { alignSelf: "center" }), children: t2("tube.page", { page: page.index + 1 }) }),
          page.cursor ? jsx(PageButton, { id: "next", icon: "chevronRight", label: t2("tube.next"), onPress: () => load(query, filters, page.index + 1) }) : null
        ] }) : null
      ] });
    return jsxs(View, { style: { flex: 1, backgroundColor: colors.canvas }, children: [
      jsx(FocusScope, { autoFocus: !typing, inert: typing, onBack: () => {
        run.current.abort?.();
        onBack();
        return true;
      }, onAction, children: jsxs(ScrollView, { style: { flex: 1, gap: 22, paddingHorizontal: 48, paddingTop: 24, paddingBottom: typing ? 300 : 72 }, children: [
        jsxs(View, { scrollAnchor: true, style: { gap: 18 }, children: [
          jsx(View, { style: { height: 80, flexDirection: "row", alignItems: "center", gap: 16 }, children: jsx(Field, { query, onPress: type }) }),
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
