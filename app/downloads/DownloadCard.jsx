// Jobee'sLair download card: one job as a square-edged graphite tile in the dashboard grid.
// A state stripe down its leading edge and a state chip name what it is doing (accent while it moves,
// amber held, red failed, green done); the big readout is its percentage; the meter, sizes, time left and a
// live speed trace follow; the controls sit along the bottom: the main action (Pause, Resume, Retry,
// Restart, Install, Continue on the page, Choose another source), the game page, and a cancel that arms
// before it deletes.
// The card redraws only when the job's shape changes (memo on shapeOf); the moving numbers live in
// CardMeter and CardSpeed, which follow the job's own progress, so a running download repaints its meter
// and not the whole card.

import '../assets/Exo2.ttf';
import '../assets/JetBrainsMono-Regular.ttf';
import { jsx, jsxs } from 'react/jsx-runtime';
import { memo, useEffect, useState } from 'react';
import { SpeedChart } from './SpeedChart.jsx';
import { STALE_PARTIAL, cause, explainError, finalError } from './errors.js';
import { formatSpeed, formatTimeLeft } from './format.js';
import { WAITING, clearAction, formatOf, partOf, shownState, stateLabel } from './labels.js';
import { fractionOf, shapeOf, useProgress } from './useQueue.js';
import { useThroughput } from './useThroughput.js';
import { isCdnProvider } from '../game/sources.js';
import { SPAN_MAX, fitBytes } from '../i18n/fit.js';
import { useT } from '../i18n/index.js';
import { BUSY, COMPLETE } from '../state/download-queue.js';
import { takeOverDownload, useBackgroundOwner } from '../state/background-downloads.js';
import { readinessOf, readinessText, stageLabel } from '../state/readiness.js';
import { formatBytes } from '../state/size.js';
import { Button2 } from '../ui/Button.jsx';
import { CdnSpark } from '../ui/CdnAura.jsx';
import { Cover } from '../ui/Cover.jsx';
import { ShimmerText } from '../ui/ShimmerText.jsx';
import { colors, radius } from '../ui/colors.js';
import { logical, px } from '../ui/scale.js';
import { Text, View, motion } from '@ps5-react/core';
import { serviceName } from '../state/debrid.js';
import { errorCode, errorDetail } from '../state/exfat-convert.js';
import { t as t2Static } from '../i18n/core.js';

  var CARD_WIDTH = 900;
  var INNER = CARD_WIDTH - 2 * 28 - 2; // the padding and the border
  var THUMB = { width: px(72), height: px(96), borderRadius: radius.sm };
  var ARM_MS = 3e3;
  var AMBER = "#fbbf24", RED = "#f87171", GREEN = "#4ade80";
  var primaryKey = (id) => `downloads:${id}`;
  var mono = (size, color, extra) => ({ fontFamily: "JetBrainsMono-Regular", fontSize: size, lineHeight: Math.round(size * 1.45), color, ...extra });
  var font = (size, color, extra) => ({ fontFamily: "Exo2", fontSize: size, lineHeight: Math.round(size * 1.42), color, ...extra });
  // The card's tone: what color its stripe, chip and meter take, from its readiness stage: green once it
  // is installed or played, red only for what the gamer can act on (a stopped download, a game that won't
  // start), amber while it waits on the gamer, the accent while it moves.
  function toneOf(job2, ready) {
    if (ready?.tone === "bad") return RED;
    if (ready?.tone === "good") return GREEN;
    if (["paused", "pausing", "awaiting-browser"].includes(job2.state)) return AMBER;
    return colors.accentHi;
  }
  // MODIFIED (0.5.0 Pre Release 3): a download in parts waiting on the browser opens it from here ("Wait"
  // while it counts down to opening it by itself), not from the game page.
  function primary({ state, error: error2, parts, autoOpenAt, aheadAt, convert }, run, openGame, ready) {
    if (state === "awaiting-browser" && autoOpenAt) return { icon: "pause", label: "downloads.action.waitPart", onPress: () => run("waitForPart") };
    // 0.5.0 Pre Release 4: the next part's browser about to open while this one downloads.
    if (aheadAt && BUSY.includes(state)) return { icon: "pause", label: "downloads.action.waitPart", onPress: () => run("waitForPart") };
    if (state === "awaiting-browser" && parts?.length > 1) return { icon: "external", label: "downloads.action.openBrowser", onPress: () => run("openBrowser") };
    if (ready?.action === "seeWhy") return { icon: "alert", label: "ready.seeWhy", onPress: () => run("seeWhy") };
    if (state === "pausing") return { icon: "pause", label: "downloads.action.pausing", onPress: () => {
    } };
    if (BUSY.includes(state)) return { icon: "pause", label: "downloads.action.pause", onPress: () => run("pause") };
    // glibren.16: a conversion to .exfat under way stops here (the download stays, with "Convert again" and "Use without
    // converting"; the original stays in BACKUP). The X beside it still cancels the whole download.
    if (state === "converting") return { icon: "x", label: "downloads.action.cancelConvert", onPress: () => run("cancelConversion") };
    if (["paused", "failed"].includes(state) && STALE_PARTIAL.test(cause(error2))) return { icon: "download", label: "downloads.action.restart", onPress: () => run("restart") };
    if (state === "paused") return { icon: "play", label: "downloads.action.resume", onPress: () => run("resume") };
    // 0.5.4: a refusal Retry would only meet again (an archive the console can't unpack): the game page,
    // whose button then opens the list of sources.
    // glibren.12: a conversion to .exfat that stopped: try it again (and "Use without converting" beside it).
    if (state === "failed" && convert) return { icon: "restart", label: "downloads.action.retryConvert", onPress: () => run("retryConversion") };
    if (state === "failed" && finalError(error2, Boolean(parts))) return { icon: "list", label: "download.otherSource.label", onPress: openGame };
    if (state === "failed") return { icon: "download", label: "downloads.action.retry", onPress: () => run("resume") };
    // 0.5.5 (GitHub issue #2): a lone download whose link expired opens its host's page from here too, where the
    // link is caught again; before, this went to the game page, whose words asked for the link to be typed in.
    if (state === "awaiting-browser") return { icon: "external", label: "download.button.awaiting-browser", onPress: () => run("openBrowser") };
    if (state === "downloaded") return { icon: "circleCheck", label: "downloads.action.install", onPress: () => run("register") };
    // 0.5.5: a package waiting on the player (download-queue.js heldPackage, or the console refused it) installs from here.
    if (state === "installer-required") return { icon: "download", label: "downloads.action.install", onPress: () => run("install") };
    // 0.5.1: extracted, but its game folder was not found then: look again and install.
    if (state === "extracted") return { icon: "circleCheck", label: "downloads.action.install", onPress: () => run("installExtracted") };
    if (state === "attention") return { icon: "restart", label: "downloads.action.checkAgain", onPress: () => run("register") };
    return null;
  }
  // Cancel arms on the first press (it turns into a delete for three seconds), deletes on the second: an
  // unfinished job's partial files, or a finished game from disk (ShadowMount uninstalls it first).
  function CancelButton({ id, action, run, onFocus, onBlur, autoFocus = false }) {
    const [armed, setArmed] = (0, useState)(false);
    (0, useEffect)(() => {
      if (!armed) return void 0;
      const timer = setTimeout(() => setArmed(false), ARM_MS);
      return () => clearTimeout(timer);
    }, [armed]);
    return /* @__PURE__ */ (0, jsx)(Button2, {
      variant: armed ? "primary" : "secondary",
      size: "icon",
      icon: armed ? "delete" : "x",
      focusKey: `downloads-cancel:${id}`,
      ...autoFocus ? { autoFocus } : {},
      onFocus,
      onBlur: () => {
        setArmed(false);
        onBlur();
      },
      onPress: () => {
        if (action === "remove" || action === "clear") {
          run(action);
          return;
        }
        setArmed(!armed);
        if (armed) run(action);
      }
    });
  }
  // The moving part: percentage, meter, sizes and time left, from the job's own progress.
  // glibren.16: `rate` adds the speed after the sizes (a conversion to .exfat, which has no speed trace of its own);
  // `progress` gives the numbers directly (a conversion the payload runs outside the queue: ConversionCard).
  function CardMeter({ id, tone, moving, complete, waiting: waiting2, label, detail: detail2, rate = false, progress: given = null }) {
    const t2 = useT();
    const followed = useProgress(id);
    const progress = given ?? followed;
    const { written = 0, total = null, bytesPerSecond = 0 } = progress ?? {};
    const fraction = complete ? 1 : fractionOf(progress);
    const percent = complete || total ? `${Math.floor(fraction * 100)}%` : "—";
    const left = moving && total && bytesPerSecond ? formatTimeLeft((total - written) / bytesPerSecond) : "";
    const speed = rate && moving && bytesPerSecond ? `  \xB7  ${formatSpeed(bytesPerSecond)}` : "";
    const size = detail2 ?? (complete ? formatBytes(total || written) : total ? t2("download.status.progress", { done: formatBytes(written), total: formatBytes(total) }) + speed : written ? t2("download.soFar", { size: formatBytes(written) }) + speed : "");
    return /* @__PURE__ */ (0, jsxs)(View, { style: { gap: 12 }, children: [
      /* @__PURE__ */ (0, jsxs)(View, { style: { width: INNER, flexDirection: "row", alignItems: "flex-end", justifyContent: "space-between" }, children: [
        waiting2 ? /* @__PURE__ */ (0, jsx)(View, { style: { width: 600 }, children: /* @__PURE__ */ (0, jsx)(ShimmerText, { textStyle: font(21, colors.fg), background: colors.surface, children: label }) }) : /* @__PURE__ */ (0, jsxs)(Text, { style: font(21, colors.fg, { width: 600, numberOfLines: 1, ellipsizeMode: "tail" }), children: [
          fitBytes(label, SPAN_MAX),
          /* @__PURE__ */ (0, jsx)(Text, { style: { color: colors.muted }, children: left ? fitBytes(`  \xB7  ${left}`, SPAN_MAX) : "" })
        ] }),
        /* @__PURE__ */ (0, jsx)(Text, { style: { width: 220, textAlign: "end", fontFamily: "JetBrainsMono-Regular", fontSize: 40, lineHeight: 46, color: complete || moving ? tone : colors.muted }, children: percent })
      ] }),
      // The meter: a 10 px square track, filled in the card's tone; a moving one carries a lighter edge.
      // Layout is in screen pixels; motion's x is in 1280-wide design units, hence logical().
      /* @__PURE__ */ (0, jsx)(View, { style: { width: INNER, height: 10, borderRadius: radius.pill, roundedClip: true, backgroundColor: colors.surface3 }, children: /* @__PURE__ */ (0, jsx)(motion.View, {
        style: { position: "absolute", top: 0, bottom: 0, left: 0, width: INNER, backgroundColor: tone },
        initial: false,
        animate: { x: -(1 - fraction) * logical(INNER) },
        transition: { type: "tween", duration: 0.25, ease: "linear" },
        children: moving ? /* @__PURE__ */ (0, jsx)(View, { style: { position: "absolute", top: 0, bottom: 0, right: 0, width: 18, backgroundColor: "#ffffff66" } }) : null
      }) }),
      /* @__PURE__ */ (0, jsx)(Text, { style: mono(18, colors.muted, { width: INNER, numberOfLines: 1, ellipsizeMode: "tail" }), children: size || " " })
    ] });
  }
  // A running download's speed and its last minute, drawn only while it downloads.
  function CardSpeed({ id, tone }) {
    const { network } = useThroughput(id);
    const latest = network[network.length - 1] ?? 0;
    return /* @__PURE__ */ (0, jsxs)(View, { style: { flexDirection: "row", alignItems: "center", gap: 18 }, children: [
      /* @__PURE__ */ (0, jsx)(SpeedChart, { samples: network, max: Math.max(...network, 1), color: tone, width: 200, height: 40 }),
      /* @__PURE__ */ (0, jsx)(Text, { style: { width: 170, textAlign: "end", fontFamily: "JetBrainsMono-Regular", fontSize: 22, lineHeight: 30, color: colors.fg }, children: latest ? formatSpeed(latest) : "—" })
    ] });
  }
  // The seconds left before the next part's browser opens by itself (download-queue.js scheduleNextPart).
  function NextPartCountdown({ job: job2 }) {
    const t2 = useT();
    const [, tick] = (0, useState)(0);
    (0, useEffect)(() => {
      const id = setInterval(() => tick((n) => n + 1), 500);
      return () => clearInterval(id);
    }, []);
    const seconds = Math.max(0, Math.ceil((job2.autoOpenAt - Date.now()) / 1e3));
    return /* @__PURE__ */ (0, jsx)(Text, { style: font(20, AMBER, { numberOfLines: 1, ellipsizeMode: "tail" }), children: t2("downloads.nextPartIn", { part: (job2.partIndex ?? 0) + 1, seconds }) });
  }
  // The next part's link, captured while this part downloads (download-queue.js scheduleAhead): the countdown
  // to its browser, then where its capture stands.
  function AheadLine({ job: job2 }) {
    const t2 = useT();
    const [, tick] = (0, useState)(0);
    (0, useEffect)(() => {
      if (!job2.aheadAt) return void 0;
      const id = setInterval(() => tick((n) => n + 1), 500);
      return () => clearInterval(id);
    }, [job2.aheadAt]);
    const part = (job2.aheadPart ?? 0) + 1;
    const text = job2.aheadAt ? t2("downloads.aheadIn", { part, seconds: Math.max(0, Math.ceil((job2.aheadAt - Date.now()) / 1e3)) }) : job2.aheadState === "capturing" ? t2("downloads.aheadCapturing", { part }) : job2.aheadState === "ready" ? t2("downloads.aheadReady", { part }) : t2("downloads.aheadFailed", { part });
    return /* @__PURE__ */ (0, jsx)(Text, { style: font(20, job2.aheadState === "ready" ? GREEN : AMBER, { numberOfLines: 1, ellipsizeMode: "tail" }), children: text });
  }
  function DownloadCardView({ job: job2, game, autoFocus, run, onOpenGame, onFocusRow }) {
    const t2 = useT();
    // Which of its controls has focus (null: none), so the card's edge lights while focus is anywhere in it,
    // whichever order a move's blur and focus arrive in.
    const [within, setWithin] = (0, useState)(null);
    const { state, release } = job2;
    // glibren-bg: o payload de segundo plano baixa este (continua com o app fechado); o jogador pode trazer para o app.
    const background = useBackgroundOwner(job2.downloadDestination) && BUSY.includes(state);
    const shown = shownState(job2);
    const complete = COMPLETE.includes(state);
    const moving = BUSY.includes(state) && state !== "pausing" || state === "converting";
    const ready = readinessOf(job2);
    const tone = toneOf(job2, ready);
    const openGame = () => onOpenGame(job2);
    const main = primary(job2, (name) => run(job2, name), openGame, ready);
    const focusOf = (name) => ({
      onFocus: () => {
        setWithin(name);
        onFocusRow(job2);
      },
      onBlur: () => setWithin((current) => current === name ? null : current)
    });
    // glibren: a download through the debrid service says so ("via TorBox"), as the source list does.
    const via = release.debrid ? t2("debrid.via").replace("TorBox", serviceName(release.debrid.service)) : null;
    const meta = [formatOf(job2, release), partOf(job2), `${release.provider} ${release.version || ""}`.trim(), via, job2.root].filter(Boolean).join(" \xB7 ");
    // 0.5.5: a busy server's download tries again by itself (download-queue.js retryLater), and says so.
    // glibren.16: a conversion's error already says what to do (downloads.convert.error.*, .cancelled): said as it is.
    const explained = job2.error && (state === "failed" && job2.convert ? { title: job2.error, action: "" } : explainError(job2.error, Boolean(release.parts)));
    const problem = explained && job2.retryAt ? { ...explained, action: t2("downloads.retryingSoon") } : explained;
    // The file's own title id is another game's (a PKG's header, download-queue.js noteTitle): said after any problem.
    const mismatch = job2.titleMismatch ? t2("downloads.titleMismatch", { found: job2.titleMismatch, expected: job2.titleId }) : "";
    const note = !problem && !mismatch && background ? t2("downloads.background.hint") : problem ? problem.action ? t2("downloads.problem", { title: problem.title, action: problem.action }) : problem.title : mismatch || (ready.action === "seeWhy" ? t2("ready.seeWhyHint") : state === "downloaded" ? job2.message || t2("downloads.installHint") : state === "installer-required" || state === "converting" ? job2.message || "" : "");
    const cdn = isCdnProvider(release.provider);
    return /* @__PURE__ */ (0, jsxs)(View, { style: { width: CARD_WIDTH, flexDirection: "row", borderRadius: radius.lg, roundedClip: true, borderWidth: 1, borderColor: within ? colors.glow : colors.line, backgroundColor: within ? colors.surface2 : colors.surface }, children: [
      /* @__PURE__ */ (0, jsxs)(View, { style: { flex: 1, gap: 18, padding: 28 }, children: [
        /* @__PURE__ */ (0, jsxs)(View, { style: { flexDirection: "row", gap: 24 }, children: [
          /* @__PURE__ */ (0, jsx)(Cover, { game, label: false, style: THUMB }),
          /* @__PURE__ */ (0, jsxs)(View, { style: { flex: 1, gap: 6 }, children: [
            /* @__PURE__ */ (0, jsxs)(View, { style: { flexDirection: "row", alignItems: "center", gap: 14 }, children: [
              /* @__PURE__ */ (0, jsxs)(View, { style: { flexDirection: "row", alignItems: "center", gap: 8, borderRadius: radius.sm, backgroundColor: colors.canvas2, paddingHorizontal: 12, paddingVertical: 2 }, children: [
                /* @__PURE__ */ (0, jsx)(View, { style: { width: 10, height: 10, borderRadius: radius.pill, backgroundColor: tone } }),
                /* @__PURE__ */ (0, jsx)(Text, { style: mono(16, tone, { letterSpacing: 1.5 }), children: fitBytes(stageLabel(ready.stage).toUpperCase(), 96) })
              ] }),
              cdn ? /* @__PURE__ */ (0, jsx)(CdnSpark, { size: 13 }) : null,
              background ? /* @__PURE__ */ (0, jsx)(View, { style: { borderRadius: radius.sm, backgroundColor: colors.canvas2, paddingHorizontal: 12, paddingVertical: 2 }, children: /* @__PURE__ */ (0, jsx)(Text, { style: mono(16, colors.accentHi, { letterSpacing: 1.5 }), children: fitBytes(t2("downloads.background.chip").toUpperCase(), 96) }) }) : null,
              /* @__PURE__ */ (0, jsx)(Text, { style: mono(17, colors.subtle, { flex: 1, numberOfLines: 1, ellipsizeMode: "tail" }), children: meta })
            ] }),
            /* @__PURE__ */ (0, jsx)(Text, { style: font(27, colors.fg, { fontWeight: 600, numberOfLines: 1, ellipsizeMode: "tail", letterSpacing: 0.4 }), children: job2.title }),
            job2.autoOpenAt && state === "awaiting-browser" ? /* @__PURE__ */ (0, jsx)(NextPartCountdown, { job: job2 }) : job2.aheadState && !problem && BUSY.includes(state) ? /* @__PURE__ */ (0, jsx)(AheadLine, { job: job2 }) : /* @__PURE__ */ (0, jsx)(Text, { style: font(20, problem ? RED : colors.muted, { numberOfLines: 1, ellipsizeMode: "tail" }), children: note || " " })
          ] })
        ] }),
        /* @__PURE__ */ (0, jsx)(CardMeter, {
          id: job2.id,
          tone,
          moving,
          complete,
          waiting: WAITING.includes(shown),
          label: shown === "finishing" ? stateLabel(shown) : readinessText(ready),
          detail: shown === "finishing" ? t2("downloads.writingToDisk") : null,
          rate: state === "converting"
        }),
        /* @__PURE__ */ (0, jsxs)(View, { style: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" }, children: [
          /* @__PURE__ */ (0, jsxs)(View, { style: { flexDirection: "row", gap: 12 }, children: [
            // 0.5.4: at least 230 wide, wider for a longer label ("Choose another source"), never cut.
            main ? /* @__PURE__ */ (0, jsx)(Button2, { variant: "primary", icon: main.icon, label: t2(main.label), style: { minWidth: 230 }, autoFocus, focusKey: primaryKey(job2.id), ...focusOf("main"), onPress: main.onPress }) : null,
            /* @__PURE__ */ (0, jsx)(Button2, { variant: main ? "secondary" : "primary", icon: "chevronRight", label: t2("downloads.action.gamePage"), style: { width: 210 }, autoFocus: main ? false : autoFocus, focusKey: main ? `downloads-page:${job2.id}` : primaryKey(job2.id), ...focusOf("page"), onPress: openGame }),
            // glibren.12: the game as it came (folder published, archive extracted or package installed), original kept.
            state === "failed" && job2.convert ? jsx(Button2, { variant: "secondary", icon: "folder", label: t2("downloads.action.useWithoutConverting"), focusKey: `downloads-plain:${job2.id}`, ...focusOf("plain"), onPress: () => run(job2, "skipConversion") }) : null,
            background ? /* @__PURE__ */ (0, jsx)(Button2, { variant: "secondary", size: "icon", icon: "download", focusKey: `downloads-takeover:${job2.id}`, ...focusOf("takeover"), onPress: () => void takeOverDownload(job2.downloadDestination) }) : null,
            /* @__PURE__ */ (0, jsx)(CancelButton, { id: job2.id, action: clearAction(state), run: (name) => run(job2, name), ...focusOf("cancel") })
          ] }),
          state === "downloading" ? /* @__PURE__ */ (0, jsx)(CardSpeed, { id: job2.id, tone }) : null
        ] })
      ] })
    ] });
  }
  var DownloadCard = (0, memo)(
    DownloadCardView,
    (a, b) => shapeOf(a.job) === shapeOf(b.job) && a.autoFocus === b.autoFocus
  );

  // ---- glibren.16: a conversion to .exfat the background payload runs outside the queue ----
  // (state/payload-conversions.js: started with the app closed, or for a download no longer in the queue.) The same tile
  // as a download's: chip, title, the state under it (or the error), the meter with its percentage, sizes, speed and
  // time left; "Cancel conversion" while it runs (the payload stops it and deletes its .part; the original stays), the X
  // to clear it from the list once it ended.
  // glibren.22: "extracting": the payload unpacks the archive first (glibren.20).
  var CONVERSION_TEXT = { queued: "downloads.convert.queued", extracting: "downloads.convert.extracting", converting: "downloads.convert.running", verifying: "downloads.convert.verifying", done: "downloads.convert.done", failed: "downloadState.failed" };
  var conversionKey = (item) => `conv-${item.id}`;
  function conversionError(item) {
    return t2Static(`downloads.convert.error.${errorCode(item.error)}`, { detail: errorDetail(item.error) });
  }
  function ConversionCard({ item, game, autoFocus, onCancel, onForget }) {
    const t2 = useT();
    const [within, setWithin] = (0, useState)(null);
    const active = ["queued", "extracting", "converting", "verifying"].includes(item.state);
    const tone = item.state === "failed" ? RED : item.state === "done" ? GREEN : colors.accentHi;
    const text = t2(CONVERSION_TEXT[item.state] ?? "downloads.convert.queued");
    const note = item.state === "failed" ? conversionError(item) : t2("downloads.payloadConv.hint");
    const focusOf = (name) => ({
      onFocus: () => setWithin(name),
      onBlur: () => setWithin((current) => current === name ? null : current)
    });
    const meta = ["EXFAT", item.label || ""].filter(Boolean).join(" \xB7 ");
    return jsx(View, { style: { width: CARD_WIDTH, flexDirection: "row", borderRadius: radius.lg, roundedClip: true, borderWidth: 1, borderColor: within ? colors.glow : colors.line, backgroundColor: within ? colors.surface2 : colors.surface }, children: jsxs(View, { style: { flex: 1, gap: 18, padding: 28 }, children: [
      jsxs(View, { style: { flexDirection: "row", gap: 24 }, children: [
        jsx(Cover, { game, label: false, style: THUMB }),
        jsxs(View, { style: { flex: 1, gap: 6 }, children: [
          jsxs(View, { style: { flexDirection: "row", alignItems: "center", gap: 14 }, children: [
            jsxs(View, { style: { flexDirection: "row", alignItems: "center", gap: 8, borderRadius: radius.sm, backgroundColor: colors.canvas2, paddingHorizontal: 12, paddingVertical: 2 }, children: [
              jsx(View, { style: { width: 10, height: 10, borderRadius: radius.pill, backgroundColor: tone } }),
              jsx(Text, { style: mono(16, tone, { letterSpacing: 1.5 }), children: fitBytes(t2(item.state === "done" ? "downloads.convert.done" : item.state === "failed" ? "downloadState.failed" : "downloadState.converting").toUpperCase(), 96) })
            ] }),
            jsx(View, { style: { borderRadius: radius.sm, backgroundColor: colors.canvas2, paddingHorizontal: 12, paddingVertical: 2 }, children: jsx(Text, { style: mono(16, colors.accentHi, { letterSpacing: 1.5 }), children: fitBytes(t2("downloads.background.chip").toUpperCase(), 96) }) }),
            jsx(Text, { style: mono(17, colors.subtle, { flex: 1, numberOfLines: 1, ellipsizeMode: "tail" }), children: meta })
          ] }),
          jsx(Text, { style: font(27, colors.fg, { fontWeight: 600, numberOfLines: 1, ellipsizeMode: "tail", letterSpacing: 0.4 }), children: item.name || game?.title || "" }),
          jsx(Text, { style: font(20, item.state === "failed" ? RED : colors.muted, { numberOfLines: 1, ellipsizeMode: "tail" }), children: note || " " })
        ] })
      ] }),
      jsx(CardMeter, {
        id: conversionKey(item),
        tone,
        moving: item.state === "converting" || item.state === "extracting", // glibren.20: o payload descompacta antes
        complete: item.state === "done",
        waiting: item.state === "queued" || item.state === "verifying",
        label: text,
        rate: true,
        progress: { written: item.written || 0, total: item.total || null, bytesPerSecond: item.bytesPerSecond || 0 }
      }),
      jsx(View, { style: { flexDirection: "row", gap: 12 }, children: active ? [
        jsx(Button2, { variant: "primary", icon: "x", label: t2("downloads.action.cancelConvert"), style: { minWidth: 230 }, autoFocus, focusKey: primaryKey(conversionKey(item)), ...focusOf("main"), onPress: () => onCancel(item) }, "cancel")
      ] : [
        jsx(CancelButton, { id: conversionKey(item), action: "clear", autoFocus, run: () => onForget(item), ...focusOf("clear") }, "clear")
      ] })
    ] }) });
  }

export { CARD_WIDTH, CancelButton, ConversionCard, DownloadCard, conversionKey, primaryKey };
