// Jobee'sLair Settings: a full-screen page of rounded cards in two columns. On the left: the phone
// companion (switch, live status, address, your PIN and changing it), audio and haptics, theme and light
// bar, language. On the right: storage and feeds (drives, catalog feeds with their mirrors), debrid
// providers (the TorBox API key and its connection test), the Source Addition Guide, and About (version,
// update check, origin and credits). Back closes it.
// Every card is a scroll anchor: focus on any row in it scrolls the whole card into view, header and all,
// so Up from lower cards always comes back to the top cards and their headers instead of leaving them cut
// off above the viewport. The page has a solid canvas under its scrolling cards, so the engine can
// copy-scroll them; the page slides in as one piece (a full-screen container is translated, not faded).
// 0.5.1: far less text. A row shows its name and its state; what a setting does (its `hint`) shows under the
// row only while it has focus, and the paragraphs (what debrid is, what feeds are, the credits, the legal
// notice) are gone from view or folded behind a row.
// MODIFIED (glibren.9): the TorBox library (its own category): build it, pick its sources, use its store version.
// MODIFIED (glibren.5): "Exit Jobee'sLair" at the end of the categories' column (ui/ExitSheet.jsx, state/exit-app.js), and
// the "Pause when the app closes" choice (0 to 30 s) under "Keep downloading when I close the app".

import '../assets/Exo2.ttf';
import '../assets/JetBrainsMono-Regular.ttf';
import supportQr from '../assets/support-qr.png';
import { Fragment, jsx, jsxs } from 'react/jsx-runtime';
import { useEffect, useMemo, useState } from 'react';
import { CREATOR, choosePin, pinProblem, setCompanion, setCompanionAway, useCompanion } from '../companion/service.js';
import { URLDialog } from '../downloads/URLDialog.jsx';
import { formatDate2, formatNumber2 } from '../i18n/core.js';
import { chooseLanguage, languageChoice, systemLocale, tWhole, useT } from '../i18n/index.js';
import { LOCALES } from '../i18n/locales.js';
import { autoReportsChoice, reportCode, reportRelay, sendReport, setAutoReports, subscribeAutoReports } from '../state/bug-report.js';
import { online, useOnline } from '../state/online.js';
import { debridStatus, refreshTorBoxHosts, setAllDebridKey, setTorBoxKey, setTorBoxQuick, testAllDebrid, testTorBox, torBoxQuotas, useDebrid, useTorBoxQuick } from '../state/debrid.js';
import { HOMEBREW_ONLY } from '../edition.js';
import { MAX_SPEED_LIMIT, setSpeedLimit, stepSpeedLimit, useSpeedLimit } from '../state/speed-limit.js';
import { setAutoContinueParts, useAutoContinueParts } from '../state/auto-continue.js';
import { setAutoPlayFirst, useAutoPlayFirst } from '../state/auto-play-first.js';
import { TUBE_DOWNLOAD_CAP_MAX, setTubeDownloadCap, stepTubeDownloadCap, useTubeDownloadCap, TUBE_QUALITY_CHOICES, setTubeAutoUpdate, setTubeQuality, setTubeSponsorBlock, useTubeAutoUpdate, useTubeQuality, useTubeSponsorBlock } from '../state/tube-settings.js';
import { tubeUpdater } from '../state/tube-service.js';
import { TubeAccountRows, TubeRevertRow } from './TubeAccount.jsx';
import { deleteBackup, listBackup, setConvertToExfat, useConvertToExfat } from '../state/exfat-convert.js';
import { setPs5PkgWarning, usePs5PkgWarning } from '../state/ps5-pkg-warning.js';
import { PAUSE_CHOICES, setBackgroundDownloads, setPauseOnCloseSeconds, useBackgroundDownloads, usePauseOnCloseSeconds } from '../state/background-downloads.js';
import { CONVERT_OPTIONS, setConvertOption, useConvertOptions } from '../state/convert-options.js';
import { exitSummary, leaveApp } from '../state/exit-app.js';
import { memorySample, memorySnapshot, subscribeMemory } from '../state/memory-meter.js';
import { DiagnosticsRow } from './DiagnosticsRow.jsx'; // glibren.44
import { PayloadRows } from './PayloadRows.jsx'; // glibren.49 (Fase 2)
import { choosePhoneMonitorPin, setPhoneMonitor, usePhoneMonitor } from '../state/phone-monitor.js';
import { SIMULTANEOUS_CHOICES, setSimultaneousDownloads, useSimultaneousDownloads } from '../state/simultaneous-downloads.js';
import { setScreenSaver, showScreenSaver, useScreenSaverOn } from '../state/screen-saver.js';
import { setEnergySaver, usePower } from '../state/power.js';
import { homebrew, setDarkxexCatalog, useDarkxexCatalog, useHomebrewVersion } from '../state/homebrew-store.js';
import { setTypingChoice, useTypingChoice } from '../state/system-keyboard.js';
import { useNavActions } from '../state/nav.jsx';
import { downloadQueue, driveName } from '../state/downloads.js';
import { useDrives } from '../state/drives.js';
import { setDefaultDrive, useDefaultDrive } from '../state/last-drive.js';
import { MAX_FEEDS, MAX_MIRRORS, addFeed, addLocalFeed, addMirror, feedsSnapshot, orbitFeedSnapshot, refreshFeedsNow, refreshOrbitFeed, removeFeed, removeMirror, useFeeds } from '../state/feeds.js';
import { setOrbitFeed, useOrbitFeed, useOrbitStatus } from '../state/orbit-feed.js';
import { isoStamp, parseStamp } from '../state/clock.js';
import { FeedFilePicker } from './FeedFilePicker.jsx';
import { formatBytes } from '../state/size.js';
import { applyStoreMode, setSourceShown, sourceShown, useStoreMode } from '../state/store-mode.js';
import { cancelLibrary, librarySources, librarySummary, startLibrary, useLibraryProgress } from '../state/torbox-library-run.js';
import { canInstall, checkForUpdate, openUpdateDialog, setAutoInstall, updateDetail, useAutoInstall, useInstall, useUpdate } from '../state/update.js';
import { REPO, VERSION_LABEL } from '../version.js';
import { JLMark } from './JLMark.jsx';
import { LongText } from './LongText.jsx';
import { FocusRing } from './FocusRing.jsx';
import { Icon } from './Icon.jsx';
import { Menu, MenuDivider, MenuItem } from './Menu.jsx';
import { ExitSheet } from './ExitSheet.jsx';
import { PinDialog } from './PinDialog.jsx';
import { ProgressBar } from './ProgressBar.jsx';
import { QRCode } from './QRCode.jsx';
import { chooseTheme, colors, commitTheme, radius } from './colors.js';
import { setNavigationHaptics, useNavigationHaptics } from './haptics.js';
import { onStatusLight, setStatusLight, statusLightOn } from './lightBar.js';
import { logical } from './scale.js';
import { PRESETS, presetOf, useActiveTheme } from './themes.js';
import { DeviceInfo, FileSystem, FocusScope, Image, Keyboard, Linking, ScrollView, Text, View, motion, useIsFocused } from '@ps5-react/core';

  var CARD = { gap: 16, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface, padding: 34 };
  var THUMB = { type: "tween", duration: 0.18, ease: "easeOut" };
  var text = (size, color, extra) => ({ fontFamily: "Exo2", fontSize: size, lineHeight: Math.round(size * 1.4), color, ...extra });
  var STATUS = {
    off: { color: colors.subtle, label: "settings.status.off" },
    starting: { color: "#fbbf24", label: "settings.status.starting" },
    live: { color: "#4ade80", label: "settings.status.live" },
    locked: { color: "#fbbf24", label: "settings.status.locked" },
    error: { color: "#f87171", label: "settings.status.error" }
  };
  // A status tag with a colored dot: the companion's state at a glance.
  function Chip({ status }) {
    const t2 = useT();
    const { color, label } = STATUS[status];
    return /* @__PURE__ */ (0, jsxs)(View, { style: { flexDirection: "row", alignItems: "center", gap: 10, borderRadius: radius.sm, backgroundColor: colors.surface3, paddingHorizontal: 18, paddingVertical: 6 }, children: [
      /* @__PURE__ */ (0, jsx)(View, { style: { width: 10, height: 10, borderRadius: radius.pill, backgroundColor: color } }),
      /* @__PURE__ */ (0, jsx)(Text, { style: text(19, colors.fg, { fontWeight: 600 }), children: t2(label) })
    ] });
  }
  // The switch: a pill track and a round thumb that slides across it. The thumb is positioned inside the
  // track (not centered on it) and moves 30 px, which motion takes in 1280-wide design units (logical),
  // so at any output size it stops short of the track's end; the track clips to its rounded shape anyway.
  function Switch({ on }) {
    const focused = useIsFocused();
    return /* @__PURE__ */ (0, jsx)(View, { style: { width: 76, height: 44, borderRadius: radius.pill, roundedClip: true, borderWidth: 1, borderColor: on || focused ? colors.accentHi : colors.glassEdge, backgroundColor: on ? colors.accent : colors.surface3 }, children: /* @__PURE__ */ (0, jsx)(motion.View, {
      style: { position: "absolute", left: 4, top: 4, width: 34, height: 34, borderRadius: radius.pill, backgroundColor: on ? colors.accentFg : colors.muted },
      initial: false,
      animate: { x: on ? logical(30) : 0 },
      transition: THUMB
    }) });
  }
  function CardHead({ icon, title, right }) {
    return /* @__PURE__ */ (0, jsxs)(View, { style: { flexDirection: "row", alignItems: "center", gap: 18, marginBottom: 6 }, children: [
      /* @__PURE__ */ (0, jsx)(View, { style: { width: 52, height: 52, alignItems: "center", justifyContent: "center", borderRadius: radius.md, backgroundColor: colors.surface3 }, children: /* @__PURE__ */ (0, jsx)(Icon, { name: icon, size: 24, color: colors.glow }) }),
      /* @__PURE__ */ (0, jsx)(Text, { style: text(28, colors.fg, { flex: 1, fontWeight: 600, letterSpacing: 0.2 }), children: title }),
      right ?? null
    ] });
  }
  // A focusable row inside a card: a title and detail, and at its end a switch or an icon.
  // `detail` is the row's state, always shown ("Set (…1234)", "Connected · Pro plan"); `hint` says what the
  // setting does, and shows only while the row has focus.
  function RowFace({ name, detail, hint, end }) {
    const focused = useIsFocused();
    return /* @__PURE__ */ (0, jsxs)(Fragment, { children: [
      /* @__PURE__ */ (0, jsx)(FocusRing, { round: "md" }),
      /* @__PURE__ */ (0, jsxs)(View, { style: { flex: 1, gap: 3 }, children: [
        /* @__PURE__ */ (0, jsx)(Text, { style: text(23, colors.fg, { fontWeight: 600, numberOfLines: 1, ellipsizeMode: "tail" }), children: name }),
        detail ? /* @__PURE__ */ (0, jsx)(Text, { style: text(20, focused ? colors.fg : colors.muted, { numberOfLines: 2, ellipsizeMode: "tail" }), children: detail }) : null,
        // 0.5.5: in pieces when longer than a Text node keeps (ui/LongText.jsx), as Hindi and Bengali hints were.
        hint && focused ? /* @__PURE__ */ (0, jsx)(LongText, { style: text(20, colors.muted, { numberOfLines: 3, ellipsizeMode: "tail" }), children: hint }) : null
      ] }),
      end
    ] });
  }
  var ROW = (_state) => [{ position: "relative", flexDirection: "row", alignItems: "center", gap: 24, borderRadius: radius.md, paddingHorizontal: 20, paddingVertical: 16, marginHorizontal: -20 }, _state.focused ? { backgroundColor: colors.surface3 } : null];
  function Row({ focusKey, name, detail, hint, end, onPress, autoFocus, onBlur }) {
    return /* @__PURE__ */ (0, jsx)(View, { focusKey, autoFocus, onPress, onBlur, style: ROW, children: /* @__PURE__ */ (0, jsx)(RowFace, { name, detail, hint, end }) });
  }
  // A paragraph or two behind a row (the credits, the legal notice): shown only once the row is opened.
  function Folded({ focusKey, name, paragraphs }) {
    const [open, setOpen] = (0, useState)(false);
    return /* @__PURE__ */ (0, jsxs)(Fragment, { children: [
      /* @__PURE__ */ (0, jsx)(Row, { focusKey, name, end: /* @__PURE__ */ (0, jsx)(Icon, { name: open ? "chevronUp" : "chevronDown", color: colors.muted }), onPress: () => setOpen((value) => !value) }),
      // 0.5.4: each in a row it flexes across, as a Callout's (a Text stacked straight in the card was measured at the
      // page's width before the card's was known, and got too few lines), and in pieces the engine keeps whole
      // (ui/LongText.jsx): the stats' "What it sends" and the legal notice had lost their ends.
      ...open ? paragraphs.map((paragraph, index) => /* @__PURE__ */ (0, jsx)(View, { style: { flexDirection: "row" }, children: /* @__PURE__ */ (0, jsx)(LongText, { style: text(20, colors.muted), box: { flex: 1 }, children: paragraph }) }, index)) : []
    ] });
  }
  function Callout({ tone = "info", children }) {
    const color = tone === "error" ? "#f87171" : tone === "warn" ? "#fbbf24" : colors.glow;
    return /* @__PURE__ */ (0, jsxs)(View, { style: { flexDirection: "row", gap: 16, borderRadius: radius.md, backgroundColor: colors.surface2, paddingHorizontal: 20, paddingVertical: 14 }, children: [
      /* @__PURE__ */ (0, jsx)(View, { style: { width: 4, borderRadius: radius.pill, backgroundColor: color } }),
      /* @__PURE__ */ (0, jsx)(Text, { style: text(20, colors.fg, { flex: 1 }), children })
    ] });
  }
  function CompanionCard({ onChoosePin }) {
    const t2 = useT();
    const companion = useCompanion();
    const status = !companion.enabled ? "off" : companion.state === "failed" ? "error" : companion.locked ? "locked" : companion.state === "listening" ? "live" : "starting";
    let body = null;
    if (status === "error") body = /* @__PURE__ */ (0, jsx)(Callout, { tone: "error", children: t2("settings.companion.failed", { error: companion.error }) });
    else if (status === "starting") body = /* @__PURE__ */ (0, jsx)(Callout, { children: t2("settings.companion.starting") });
    else if (status !== "off" && !companion.address) body = /* @__PURE__ */ (0, jsx)(Callout, { tone: "warn", children: t2("settings.companion.offline") });
    // 0.5.0 Pre Release 4: a QR code of the address beside it, so a phone camera opens the page (typing an IP
    // on a phone is where it most often went wrong).
    else if (status !== "off") body = /* @__PURE__ */ (0, jsxs)(View, { style: { gap: 14 }, children: [
      /* @__PURE__ */ (0, jsxs)(View, { style: { flexDirection: "row", alignItems: "center", gap: 28 }, children: [
        /* @__PURE__ */ (0, jsx)(QRCode, { text: companion.url, size: 216 }),
        /* @__PURE__ */ (0, jsxs)(View, { style: { flex: 1, gap: 14 }, children: [
          /* @__PURE__ */ (0, jsx)(Text, { style: text(20, colors.muted), children: t2("settings.companion.open") }),
          /* @__PURE__ */ (0, jsx)(View, { style: { borderRadius: radius.md, backgroundColor: colors.canvas2, paddingHorizontal: 22, paddingVertical: 14 }, children: /* @__PURE__ */ (0, jsx)(Text, { style: { fontFamily: "JetBrainsMono-Regular", fontSize: 25, lineHeight: 34, color: colors.fg }, children: companion.url }) }),
          /* @__PURE__ */ (0, jsxs)(View, { style: { alignSelf: "flex-start", flexDirection: "row", alignItems: "center", gap: 18, borderRadius: radius.md, backgroundColor: colors.canvas2, paddingHorizontal: 22, paddingVertical: 6 }, children: [
            /* @__PURE__ */ (0, jsx)(Text, { style: text(16, colors.subtle, { fontWeight: 600, letterSpacing: 2 }), children: t2("settings.companion.pin") }),
            /* @__PURE__ */ (0, jsx)(Text, { style: { fontFamily: "JetBrainsMono-Regular", fontSize: 36, lineHeight: 46, letterSpacing: 6, color: colors.glow }, children: companion.pin })
          ] })
        ] })
      ] }),
      companion.locked ? /* @__PURE__ */ (0, jsx)(Callout, { tone: "warn", children: t2("settings.companion.locked") }) : companion.phones ? /* @__PURE__ */ (0, jsx)(Text, { style: text(20, colors.muted), children: t2("settings.companion.phones", { count: companion.phones }) }) : null
    ] });
    // Turning it on for the first time asks for a PIN first: the switch changes nothing until one is set.
    const toggle = () => {
      if (!setCompanion(!companion.enabled)) onChoosePin("create");
    };
    return /* @__PURE__ */ (0, jsxs)(View, { scrollAnchor: true, style: CARD, children: [
      /* @__PURE__ */ (0, jsx)(CardHead, { icon: "globe", title: t2("settings.card.companion"), right: /* @__PURE__ */ (0, jsx)(Chip, { status }) }),
      /* @__PURE__ */ (0, jsx)(Row, { focusKey: "settings:companion", name: t2("settings.companion"), hint: companion.hasPin ? t2("settings.companion.detail") : `${t2("settings.companion.detail")}. ${t2("settings.companion.noPin")}`, end: /* @__PURE__ */ (0, jsx)(Switch, { on: companion.enabled }), onPress: toggle }),
      body,
      // Experimental: the helper that answers the phone while the app is closed (companion/service.js).
      companion.enabled ? /* @__PURE__ */ (0, jsx)(Row, { focusKey: "settings:companionAway", name: t2("settings.companion.away"), detail: companion.away && companion.awayAnswer && !["ready", "updated", "sent", "sending", "stopped"].includes(companion.awayAnswer) ? t2("settings.companion.awayFailed", { error: companion.awayAnswer }) : null, hint: t2("settings.companion.awayDetail"), end: /* @__PURE__ */ (0, jsx)(Switch, { on: companion.away }), onPress: () => setCompanionAway(!companion.away) }) : null,
      companion.hasPin ? /* @__PURE__ */ (0, jsx)(Row, { focusKey: "settings:pin", name: t2("settings.companion.changePin"), hint: t2("settings.companion.changePinDetail"), end: /* @__PURE__ */ (0, jsx)(Icon, { name: "chevronRight", color: colors.muted }), onPress: () => onChoosePin("change") }) : null
    ] });
  }
  function FeedbackCard() {
    const t2 = useT();
    const vibration = useNavigationHaptics();
    return /* @__PURE__ */ (0, jsxs)(View, { scrollAnchor: true, style: CARD, children: [
      /* @__PURE__ */ (0, jsx)(CardHead, { icon: "star", title: t2("settings.card.feedback") }),
      /* @__PURE__ */ (0, jsx)(Row, { focusKey: "settings:vibration", name: t2("settings.vibration"), hint: t2("settings.vibrationDetail"), end: /* @__PURE__ */ (0, jsx)(Switch, { on: vibration }), onPress: () => setNavigationHaptics(!vibration) })
    ] });
  }
  // The screen saver (0.5.0 Pre Release 4; ui/ScreenSaver.jsx): on or off, and a look at it now.
  function ScreenSaverCard() {
    const t2 = useT();
    const on = useScreenSaverOn();
    return /* @__PURE__ */ (0, jsxs)(View, { scrollAnchor: true, style: CARD, children: [
      /* @__PURE__ */ (0, jsx)(CardHead, { icon: "disc", title: t2("settings.card.screenSaver") }),
      /* @__PURE__ */ (0, jsx)(Row, { focusKey: "settings:screenSaver", name: t2("settings.screenSaver"), hint: t2("settings.screenSaverDetail"), end: /* @__PURE__ */ (0, jsx)(Switch, { on }), onPress: () => setScreenSaver(!on) }),
      /* @__PURE__ */ (0, jsx)(Row, { focusKey: "settings:screenSaverNow", name: t2("settings.screenSaverNow"), hint: t2("settings.screenSaverNowDetail"), end: /* @__PURE__ */ (0, jsx)(Icon, { name: "play", color: colors.muted }), onPress: showScreenSaver })
    ] });
  }
  // glibren.45: "Economizar energia" (state/power.js), and what the app does by itself at rest whatever it is set to. The
  // note wraps as long as it needs (ui/LongText.jsx), in every language.
  function EnergyCard() {
    const t2 = useT();
    const { saver } = usePower();
    return jsxs(View, { scrollAnchor: true, style: CARD, children: [
      jsx(CardHead, { icon: "power", title: t2("settings.card.energy") }),
      jsx(Row, { focusKey: "settings:energySaver", name: t2("settings.energySaver"), detail: saver ? t2("settings.energySaverOn") : t2("settings.energySaverOff"), end: jsx(Switch, { on: saver }), onPress: () => setEnergySaver(!saver) }),
      ...["settings.energyWhat", "settings.energyRest"].map((key) => jsx(View, { style: { flexDirection: "row" }, children: jsx(LongText, { style: text(20, colors.muted), box: { flex: 1 }, children: t2(key) }) }, key))
    ] });
  }
  // glibren.48: the Homebrew section's second list, the darkxex catalog (state/darkxex-catalog.js): on by default. The
  // note wraps as long as it needs (ui/LongText.jsx), in every language.
  function HomebrewCard() {
    const t2 = useT();
    const on = useDarkxexCatalog();
    useHomebrewVersion();
    const stats = on ? homebrew().index.darkxex : null;
    const detail = !on ? t2("settings.darkxexOff") : stats ? t2("settings.darkxexOn", { added: stats.added, duplicates: stats.duplicates }) : t2("settings.darkxexWaiting");
    return jsxs(View, { scrollAnchor: true, style: CARD, children: [
      jsx(CardHead, { icon: "package", title: t2("settings.card.homebrew") }),
      jsx(Row, { focusKey: "settings:darkxex", name: t2("settings.darkxex"), detail, end: jsx(Switch, { on }), onPress: () => void setDarkxexCatalog(!on) }),
      jsx(View, { style: { flexDirection: "row" }, children: jsx(LongText, { style: text(20, colors.muted), box: { flex: 1 }, children: t2("settings.darkxexWhat") }) })
    ] });
  }
  // glibren.32: the game page's Videos (game/VideosSheet.jsx): play the first result at once instead of the list.
  function VideosCard() {
    const t2 = useT();
    const on = useAutoPlayFirst();
    // glibren-tube: SponsorBlock in the videos played inside the app (tube/TubePlayer.jsx).
    const sponsor = useTubeSponsorBlock();
    const autoUpdate = useTubeAutoUpdate();
    const service = useTubeServiceInfo();
    return jsxs(View, { scrollAnchor: true, style: CARD, children: [
      jsx(CardHead, { icon: "play", title: t2("videos.title") }),
      jsx(Row, { focusKey: "settings:autoPlayFirst", name: t2("settings.autoPlayFirst"), hint: t2("settings.autoPlayFirstDetail"), end: jsx(Switch, { on }), onPress: () => setAutoPlayFirst(!on) }),
      jsx(TubeQualityRow, {}),
      jsx(TubeDownloadCapRow, {}),
      jsx(Row, { focusKey: "settings:tubeSponsorBlock", name: t2("settings.tubeSponsorBlock"), hint: t2("settings.tubeSponsorBlockDetail"), end: jsx(Switch, { on: sponsor }), onPress: () => setTubeSponsorBlock(!sponsor) }),
      // glibren.42: the YouTube account (TV sign-in through the service; hidden with a service that cannot).
      jsx(TubeAccountRows, { info: service }),
      // glibren-tube-update: the YouTube service updates itself (state/tube-update.js), and which one is in use.
      jsx(Row, { focusKey: "settings:tubeAutoUpdate", name: t2("settings.tubeAutoUpdate"), hint: t2("settings.tubeAutoUpdateDetail"), end: jsx(Switch, { on: autoUpdate }), onPress: () => setTubeAutoUpdate(!autoUpdate) }),
      jsx(Row, { focusKey: "settings:tubeService", name: t2("settings.tubeService"), detail: tubeServiceText(t2, service) }),
      // glibren.42 (A6): back to the built-in service when a downloaded update misbehaves.
      jsx(TubeRevertRow, {})
    ] });
  }
  // glibren-tube-quality: the quality YouTube videos open in (state/tube-settings.js), one pill per choice as the
  // simultaneous downloads' row.
  function TubeQualityRow() {
    const t2 = useT();
    const chosen = useTubeQuality();
    return jsxs(View, { style: { gap: 10 }, children: [
      jsxs(View, { style: { gap: 3 }, children: [
        jsx(Text, { style: text(23, colors.fg, { fontWeight: 600 }), children: t2("settings.tubeQuality") }),
        jsx(Text, { style: text(20, colors.muted), children: t2("settings.tubeQualityDetail") })
      ] }),
      jsx(View, { style: { flexDirection: "row", gap: 12 }, children: TUBE_QUALITY_CHOICES.map((value) => jsx(View, {
        focusKey: `settings:tubeQuality:${value}`,
        focusable: true,
        onPress: () => setTubeQuality(value),
        style: { position: "relative", flex: 1, height: 56, alignItems: "center", justifyContent: "center", borderRadius: radius.md, backgroundColor: value === chosen ? colors.accent : colors.surface2 },
        children: jsx(SpeedFace, { label: value === 2160 ? "4K" : `${value}p`, chosen: value === chosen })
      }, value)) })
    ] });
  }
  // glibren-video-cap: the downloads' cap while a video plays (state/tube-settings.js), any whole MB/s chosen with
  // − / + as the speed limit's row; "leave as is" (0) turns it off.
  function TubeDownloadCapRow() {
    const t2 = useT();
    const value = useTubeDownloadCap();
    const key = (id, label, onPress, options = {}) => jsx(View, {
      focusKey: `settings:tubeDownloadCap:${id}`,
      focusable: true,
      onPress,
      style: { position: "relative", flex: options.flex ?? 1, height: 56, alignItems: "center", justifyContent: "center", borderRadius: radius.md, backgroundColor: options.chosen ? colors.accent : colors.surface2, opacity: options.disabled ? 0.45 : 1 },
      children: jsx(SpeedFace, { label, chosen: Boolean(options.chosen) })
    }, id);
    return jsxs(View, { style: { gap: 10 }, children: [
      jsxs(View, { style: { gap: 3 }, children: [
        jsx(Text, { style: text(23, colors.fg, { fontWeight: 600 }), children: t2("settings.tubeDownloadCap") }),
        jsx(Text, { style: text(20, colors.muted), children: t2("settings.tubeDownloadCapDetail") })
      ] }),
      jsxs(View, { style: { flexDirection: "row", gap: 12, alignItems: "center" }, children: [
        key("down10", "−10", () => stepTubeDownloadCap(-10), { disabled: value <= 0 }),
        key("down", "−", () => stepTubeDownloadCap(-1), { disabled: value <= 0 }),
        jsx(View, { style: { flex: 2, height: 56, alignItems: "center", justifyContent: "center", borderRadius: radius.md, borderWidth: 2, borderColor: value ? colors.accent : colors.surface2 }, children: jsx(Text, { style: text(23, colors.fg, { fontWeight: 700 }), children: value ? t2("units.speed", { n: String(value) }) : t2("settings.tubeDownloadCapOff") }) }, "value"),
        key("up", "+", () => stepTubeDownloadCap(1), { disabled: value >= TUBE_DOWNLOAD_CAP_MAX }),
        key("up10", "+10", () => stepTubeDownloadCap(10), { disabled: value >= TUBE_DOWNLOAD_CAP_MAX }),
        key("off", t2("settings.tubeDownloadCapOff"), () => setTubeDownloadCap(0), { flex: 2, chosen: value === 0 })
      ] })
    ] });
  }
  // glibren-tube-update: what the service row says: the version in use (or the one that would start) and where from.
  function tubeServiceText(t2, info) {
    if (!info) return t2("settings.tubeServiceNone");
    const version = info.version ?? "?";
    return t2(info.source === "downloaded" ? "settings.tubeServiceDownloaded" : info.source === "embedded" ? "settings.tubeServiceBuiltIn" : "settings.tubeServiceOther", { version });
  }
  function useTubeServiceInfo() {
    const read = () => {
      try {
        return tubeUpdater().inUse();
      } catch {
        return null;
      }
    };
    const [info, setInfo] = (0, useState)(read);
    (0, useEffect)(() => tubeUpdater().subscribe(() => setInfo(read())), []);
    return info;
  }
  // One swatch per preset: its accent filled, the accent frame when focused, a check on the chosen one.
  function SwatchFace({ preset, chosen }) {
    const focused = useIsFocused();
    return /* @__PURE__ */ (0, jsxs)(View, { style: { width: 88, height: 88, alignItems: "center", justifyContent: "center", borderRadius: radius.md, borderWidth: focused ? 3 : 1, borderColor: focused ? preset.hi : chosen ? colors.fg : colors.line, backgroundColor: colors.surface2 }, children: [
      /* @__PURE__ */ (0, jsx)(View, { style: { width: 56, height: 56, borderRadius: radius.pill, backgroundColor: preset.accent } }),
      chosen ? /* @__PURE__ */ (0, jsx)(View, { style: { position: "absolute" }, children: /* @__PURE__ */ (0, jsx)(Icon, { name: "check", size: 30, color: preset.fg }) }) : null
    ] });
  }
  function useStatusLight() {
    const [on, setOn] = (0, useState)(statusLightOn);
    (0, useEffect)(() => onStatusLight(setOn), []);
    return on;
  }
  function ThemeCard() {
    const t2 = useT();
    const active = useActiveTheme();
    const light = useStatusLight();
    const [shown, setShown] = (0, useState)(null);
    const [changed, setChanged] = (0, useState)(false);
    const label = presetOf(shown ?? active);
    return /* @__PURE__ */ (0, jsxs)(View, { scrollAnchor: true, style: CARD, children: [
      /* @__PURE__ */ (0, jsx)(CardHead, { icon: "disc", title: t2("settings.card.theme") }),
      /* @__PURE__ */ (0, jsx)(Text, { style: text(23, colors.fg, { fontWeight: 600 }), children: `${t2("settings.theme")} · ${t2(label.name)}` }),
      /* @__PURE__ */ (0, jsx)(View, { style: { flexDirection: "row", gap: 16, paddingVertical: 6 }, children: PRESETS.map((preset) => /* @__PURE__ */ (0, jsx)(View, {
        focusKey: `settings:theme:${preset.id}`,
        focusable: true,
        onFocus: () => setShown(preset.id),
        onBlur: () => setShown(null),
        onPress: () => {
          if (preset.id === active) return;
          chooseTheme(preset.id);
          setChanged(true);
        },
        children: /* @__PURE__ */ (0, jsx)(SwatchFace, { preset, chosen: preset.id === active })
      }, preset.id)) }),
      changed ? /* @__PURE__ */ (0, jsx)(Callout, { children: t2("settings.theme.redraw") }) : null,
      /* @__PURE__ */ (0, jsx)(Row, { focusKey: "settings:statusLight", name: t2("settings.statusLight"), hint: t2("settings.statusLightDetail"), end: /* @__PURE__ */ (0, jsx)(Switch, { on: light }), onPress: () => setStatusLight(!light) })
    ] });
  }
  // 0.5.4: whether typing opens the PS5's own keyboard (state/system-keyboard.js) or the store's keys.
  function keyboardThere() {
    try {
      return Keyboard.available;
    } catch {
      return false;
    }
  }
  function LanguageCard() {
    const t2 = useT();
    const typing = useTypingChoice();
    const [there] = (0, useState)(keyboardThere);
    const choice = languageChoice();
    const [open, setOpen] = (0, useState)(false);
    const nameOf = (code) => LOCALES.find((locale) => locale.code === code)?.name ?? code;
    const current = choice === null ? `${t2("language.system")} · ${nameOf(systemLocale())}` : nameOf(choice);
    return /* @__PURE__ */ (0, jsxs)(View, { scrollAnchor: true, style: CARD, children: [
      /* @__PURE__ */ (0, jsx)(CardHead, { icon: "languages", title: t2("settings.card.language") }),
      /* @__PURE__ */ (0, jsxs)(View, { style: { position: "relative" }, children: [
        /* @__PURE__ */ (0, jsx)(Row, { focusKey: "settings:language", name: current, hint: t2("language.subtitle"), end: /* @__PURE__ */ (0, jsx)(Icon, { name: open ? "chevronDown" : "chevronUp", color: colors.muted }), onPress: () => setOpen((value) => !value) }),
        /* @__PURE__ */ (0, jsxs)(Menu, { open, placement: "above", onClose: () => setOpen(false), rows: LOCALES.length + 2, children: [
          /* @__PURE__ */ (0, jsx)(MenuItem, { label: t2("language.system"), checked: choice === null, onSelect: () => chooseLanguage(null) }),
          /* @__PURE__ */ (0, jsx)(MenuDivider, {}),
          LOCALES.map(({ code, name }) => /* @__PURE__ */ (0, jsx)(MenuItem, { label: name, checked: choice === code, onSelect: () => chooseLanguage(code) }, code))
        ] })
      ] }),
      /* @__PURE__ */ (0, jsx)(Row, { focusKey: "settings:typing", name: t2("settings.typing"), hint: t2(there ? "settings.typingDetail" : "settings.typingMissing"), end: /* @__PURE__ */ (0, jsx)(Switch, { on: there && typing === "system" }), onPress: () => {
        if (there) setTypingChoice(typing === "system" ? "keys" : "system");
      } })
    ] });
  }
  var hostOf = (url) => /^https?:\/\/([^/?#]+)/i.exec(url)?.[1] ?? url;
  // glibren.14: when a file on the console was read, in the console's own time: "07/11/2026 14:05".
  function readTime(stamp) {
    const ms = parseStamp(stamp);
    if (ms == null) return "—";
    let offset = 0;
    try {
      offset = Number(DeviceInfo.utcOffset(ms)) || 0;
    } catch {
    }
    const local = isoStamp(ms + offset * 6e4);
    return `${formatDate2(local.slice(0, 10))} ${local.slice(11, 16)}`;
  }
  // A file on the console: its path, its games and when it was read; unreadable, why, and what is still shown.
  function localDetail(t2, feed) {
    if (feed.state === "refreshing") return `${feed.url} \xB7 ${t2("settings.feeds.refreshing")}`;
    if (feed.state === "failed") {
      const kept = feed.games ? ` ${t2("settings.feeds.localKept", { count: feed.games })}` : "";
      return `${feed.url} \xB7 ${t2("settings.feeds.localFailed", { error: feed.error })}${kept}`;
    }
    return `${feed.url} \xB7 ${t2("settings.feeds.localGames", { count: feed.games, date: feed.fetchedAt ? readTime(feed.fetchedAt) : "—" })}`;
  }
  function feedDetail(t2, feed) {
    if (feed.local) return localDetail(t2, feed);
    if (feed.state === "refreshing") return t2("settings.feeds.refreshing");
    if (feed.state === "failed") return t2("settings.feeds.failed", { error: feed.error });
    // glibren.27: data e hora do ultimo download (era so a data), como os arquivos do PS5 mostram.
    const base = t2("settings.feeds.games", { count: feed.games, date: feed.fetchedAt ? readTime(feed.fetchedAt) : "—" });
    const extra = [feed.via ? t2("settings.feeds.via", { host: hostOf(feed.via) }) : null, feed.mirrors.length ? t2("settings.feeds.mirrors", { count: feed.mirrors.length }) : null].filter(Boolean);
    return extra.length ? `${base} \xB7 ${extra.join(" \xB7 ")}` : base;
  }
  // A drive's space comes from the cache (state/drives.js): nothing in a render asks the drive itself.
  function Drive({ root, usage }) {
    const t2 = useT();
    const free = usage?.free ?? null;
    const total = usage?.total ?? null;
    return /* @__PURE__ */ (0, jsxs)(View, { style: { gap: 10 }, children: [
      /* @__PURE__ */ (0, jsxs)(View, { style: { flexDirection: "row", justifyContent: "space-between" }, children: [
        /* @__PURE__ */ (0, jsx)(Text, { style: text(21, colors.fg, { fontWeight: 600 }), children: driveName(root) }),
        /* @__PURE__ */ (0, jsx)(Text, { style: { fontFamily: "JetBrainsMono-Regular", fontSize: 18, lineHeight: 28, color: colors.muted }, children: free != null && total ? t2("settings.storage.free", { free: formatBytes(free), total: formatBytes(total) }) : "—" })
      ] }),
      total ? /* @__PURE__ */ (0, jsx)(ProgressBar, { fraction: Math.min(1, Math.max(0, 1 - free / total)), width: 520, active: false }) : null
    ] });
  }
  // A feed's row and the menu it opens: add a mirror, remove one, remove the feed.
  function FeedRow({ feed, onMirror }) {
    const t2 = useT();
    const [open, setOpen] = (0, useState)(false);
    return /* @__PURE__ */ (0, jsxs)(View, { style: { position: "relative" }, children: [
      /* @__PURE__ */ (0, jsx)(Row, {
        focusKey: `settings:feed:${feed.url}`,
        name: feed.name ?? feed.url,
        detail: feedDetail(t2, feed),
        end: /* @__PURE__ */ (0, jsx)(Icon, { name: feed.state === "failed" ? "alert" : feed.local ? "file" : "layers", color: feed.state === "failed" ? "#f87171" : colors.muted }),
        onPress: () => setOpen((value) => !value)
      }),
      // glibren.14: a file on the console has no mirrors; removing it removes only the link, never the file.
      feed.local ? jsx(Menu, { open, onClose: () => setOpen(false), rows: 1, children: [
        jsx(MenuItem, { label: t2("settings.feeds.removeLink"), autoFocus: true, onSelect: () => removeFeed(feed.url) }, "remove")
      ] }) : /* @__PURE__ */ (0, jsxs)(Menu, { open, onClose: () => setOpen(false), rows: feed.own.length + 3, children: [
        feed.own.length < MAX_MIRRORS ?/* @__PURE__ */ (0, jsx)(MenuItem, { label: t2("settings.feeds.addMirror"), autoFocus: true, onSelect: () => onMirror(feed.url) }) : null,
        ...feed.own.map((mirror) => /* @__PURE__ */ (0, jsx)(MenuItem, { label: t2("settings.feeds.removeMirror", { host: hostOf(mirror) }), onSelect: () => removeMirror(feed.url, mirror) }, mirror)),
        /* @__PURE__ */ (0, jsx)(MenuDivider, {}),
        /* @__PURE__ */ (0, jsx)(MenuItem, { label: t2("settings.feeds.removeFeed"), onSelect: () => removeFeed(feed.url) })
      ] })
    ] });
  }
  // The download speed limit (state/speed-limit.js): one pill per choice, the chosen one filled.
  function SpeedFace({ label, chosen }) {
    const focused = useIsFocused();
    return /* @__PURE__ */ (0, jsxs)(Fragment, { children: [
      /* @__PURE__ */ (0, jsx)(FocusRing, { round: "md" }),
      /* @__PURE__ */ (0, jsx)(Text, { style: text(21, chosen ? colors.accentFg : focused ? colors.fg : colors.muted, { fontWeight: 600 }), children: label })
    ] });
  }
  // MODIFIED (glibren.13): any whole MB/s from 0 ("no limit") to 1000, as the phone page: − / + step 1 MB/s (−10 / +10
  // for big jumps with the controller), the value between them, and "no limit" to go back to 0. Each press applies.
  function SpeedLimitRow() {
    const t2 = useT();
    const limit = useSpeedLimit();
    const key = (id, label, onPress, options = {}) => /* @__PURE__ */ (0, jsx)(View, {
      focusKey: `settings:speed:${id}`,
      // Always focusable (focus never vanishes at 0 or 1000); at an edge a press changes nothing.
      focusable: true,
      onPress,
      style: { position: "relative", flex: options.flex ?? 1, height: 56, alignItems: "center", justifyContent: "center", borderRadius: radius.md, backgroundColor: options.chosen ? colors.accent : colors.surface2, opacity: options.disabled ? 0.45 : 1 },
      children: /* @__PURE__ */ (0, jsx)(SpeedFace, { label, chosen: Boolean(options.chosen) })
    }, id);
    return /* @__PURE__ */ (0, jsxs)(View, { style: { gap: 10 }, children: [
      /* @__PURE__ */ (0, jsxs)(View, { style: { gap: 3 }, children: [
        /* @__PURE__ */ (0, jsx)(Text, { style: text(23, colors.fg, { fontWeight: 600 }), children: t2("settings.speedLimit") }),
        /* @__PURE__ */ (0, jsx)(Text, { style: text(20, colors.muted), children: t2("settings.speedLimitDetail") })
      ] }),
      /* @__PURE__ */ (0, jsxs)(View, { style: { flexDirection: "row", gap: 12, alignItems: "center" }, children: [
        key("down10", "−10", () => stepSpeedLimit(-10), { disabled: limit <= 0 }),
        key("down", "−", () => stepSpeedLimit(-1), { disabled: limit <= 0 }),
        /* @__PURE__ */ (0, jsx)(View, { style: { flex: 2, height: 56, alignItems: "center", justifyContent: "center", borderRadius: radius.md, borderWidth: 2, borderColor: limit ? colors.accent : colors.surface2 }, children: /* @__PURE__ */ (0, jsx)(Text, { style: text(23, colors.fg, { fontWeight: 700 }), children: limit ? t2("units.speed", { n: String(limit) }) : t2("settings.speedUnlimited") }) }, "value"),
        key("up", "+", () => stepSpeedLimit(1), { disabled: limit >= MAX_SPEED_LIMIT }),
        key("up10", "+10", () => stepSpeedLimit(10), { disabled: limit >= MAX_SPEED_LIMIT }),
        key("none", t2("settings.speedUnlimited"), () => setSpeedLimit(0), { flex: 2, chosen: limit === 0 })
      ] })
    ] });
  }
  // glibren: how many downloads run at once (state/simultaneous-downloads.js), as the speed limit's row.
  function SimultaneousRow() {
    const t2 = useT();
    const count = useSimultaneousDownloads();
    return /* @__PURE__ */ (0, jsxs)(View, { style: { gap: 10 }, children: [
      /* @__PURE__ */ (0, jsxs)(View, { style: { gap: 3 }, children: [
        /* @__PURE__ */ (0, jsx)(Text, { style: text(23, colors.fg, { fontWeight: 600 }), children: t2("settings.simultaneous") }),
        /* @__PURE__ */ (0, jsx)(Text, { style: text(20, colors.muted), children: t2("settings.simultaneousDetail") })
      ] }),
      /* @__PURE__ */ (0, jsx)(View, { style: { flexDirection: "row", gap: 12 }, children: SIMULTANEOUS_CHOICES.map((value) => /* @__PURE__ */ (0, jsx)(View, {
        focusKey: `settings:simultaneous:${value}`,
        focusable: true,
        onPress: () => setSimultaneousDownloads(value),
        style: { position: "relative", flex: 1, height: 56, alignItems: "center", justifyContent: "center", borderRadius: radius.md, backgroundColor: value === count ? colors.accent : colors.surface2 },
        children: /* @__PURE__ */ (0, jsx)(SpeedFace, { label: String(value), chosen: value === count })
      }, value)) })
    ] });
  }
  // MODIFIED (glibren.5): how long the background helper pauses when the app closes (state/background-downloads.js), as
  // the simultaneous downloads' row: one pill per choice, 0 ("Off") twice as wide, as the speed limit's "Unlimited".
  function PauseOnCloseRow() {
    const t2 = useT();
    const seconds = usePauseOnCloseSeconds();
    return jsxs(View, { style: { gap: 10 }, children: [
      jsxs(View, { style: { gap: 3 }, children: [
        jsx(Text, { style: text(23, colors.fg, { fontWeight: 600 }), children: t2("settings.pauseOnClose") }),
        jsx(Text, { style: text(20, colors.muted), children: t2("settings.pauseOnCloseDetail") })
      ] }),
      jsx(View, { style: { flexDirection: "row", gap: 12 }, children: PAUSE_CHOICES.map((value) => jsx(View, {
        focusKey: `settings:pauseOnClose:${value}`,
        focusable: true,
        onPress: () => setPauseOnCloseSeconds(value),
        style: { position: "relative", flex: value ? 1 : 2, height: 56, alignItems: "center", justifyContent: "center", borderRadius: radius.md, backgroundColor: value === seconds ? colors.accent : colors.surface2 },
        children: jsx(SpeedFace, { label: value ? t2("settings.pauseOnCloseValue", { n: String(value) }) : t2("settings.pauseOnCloseOff"), chosen: value === seconds })
      }, value)) })
    ] });
  }
  // pac1: one of the conversion's options (state/convert-options.js) as the pause's row: "Off" twice as wide, then one
  // pill per value. `name`: the setting's key (convertPauseSeconds, convertWriteLimit, convertSyncMB).
  var CONVERT_ROWS = {
    convertPauseSeconds: { title: "settings.convertPause", detail: "settings.convertPauseDetail", value: "settings.convertPauseValue" },
    convertWriteLimit: { title: "settings.convertWrite", detail: "settings.convertWriteDetail", value: "units.speed" },
    convertSyncMB: { title: "settings.convertSync", detail: "settings.convertSyncDetail", value: "settings.convertSyncValue" }
  };
  function ConvertOptionRow({ name }) {
    const t2 = useT();
    const current = useConvertOptions()[name];
    const row = CONVERT_ROWS[name];
    return jsxs(View, { style: { gap: 10 }, children: [
      jsxs(View, { style: { gap: 3 }, children: [
        jsx(Text, { style: text(23, colors.fg, { fontWeight: 600 }), children: t2(row.title) }),
        jsx(Text, { style: text(20, colors.muted), children: t2(row.detail) })
      ] }),
      jsx(View, { style: { flexDirection: "row", gap: 12 }, children: CONVERT_OPTIONS[name].map((value) => jsx(View, {
        focusKey: `settings:${name}:${value}`,
        focusable: true,
        onPress: () => setConvertOption(name, value),
        style: { position: "relative", flex: value ? 1 : 2, height: 56, alignItems: "center", justifyContent: "center", borderRadius: radius.md, backgroundColor: value === current ? colors.accent : colors.surface2 },
        children: jsx(SpeedFace, { label: value ? t2(row.value, { n: String(value) }) : t2("settings.convertOptionOff"), chosen: value === current })
      }, value)) })
    ] });
  }
  // glibren.6: the drive every download starts on (state/last-drive.js), as the rows above: "Automatic" (the last
  // drive used, as before) and one pill per drive plugged in. A drive picked and unplugged reads as Automatic.
  function DefaultDriveRow({ roots }) {
    const t2 = useT();
    const chosen = useDefaultDrive();
    const auto = !chosen || !roots.includes(chosen);
    return jsxs(View, { style: { gap: 10 }, children: [
      jsxs(View, { style: { gap: 3 }, children: [
        jsx(Text, { style: text(23, colors.fg, { fontWeight: 600 }), children: t2("settings.defaultDrive") }),
        jsx(Text, { style: text(20, colors.muted), children: t2("settings.defaultDriveDetail") })
      ] }),
      jsx(View, { style: { flexDirection: "row", gap: 12 }, children: [null, ...roots].map((root) => jsx(View, {
        focusKey: `settings:defaultDrive:${root ?? "auto"}`,
        focusable: true,
        onPress: () => setDefaultDrive(root),
        style: { position: "relative", flex: 1, height: 56, alignItems: "center", justifyContent: "center", borderRadius: radius.md, backgroundColor: (root ? chosen === root : auto) ? colors.accent : colors.surface2 },
        children: jsx(SpeedFace, { label: root ? driveName(root) : t2("settings.defaultDrive.auto"), chosen: root ? chosen === root : auto })
      }, root ?? "auto")) })
    ] });
  }
  // glibren.12: the BACKUP folder (the original files of the games converted to .exfat): how much it holds on every
  // drive and, opened, each game; a game pressed twice (within 3 s, as a card's cancel) has its original deleted.
  // A summary read when the card shows and on each open; nothing native asks.
  function BackupRow({ roots }) {
    const t2 = useT();
    const [open, setOpen] = (0, useState)(false);
    const [found, setFound] = (0, useState)({ games: [], totalBytes: 0 });
    const [armed, setArmed] = (0, useState)(null);
    const [problem, setProblem] = (0, useState)("");
    const refresh = () => {
      try {
        setFound(listBackup(FileSystem, roots));
      } catch (error) {
        setProblem(error.message);
      }
    };
    (0, useEffect)(refresh, [roots.join("|")]);
    (0, useEffect)(() => {
      if (!armed) return void 0;
      const timer = setTimeout(() => setArmed(null), 3e3);
      return () => clearTimeout(timer);
    }, [armed]);
    const summary = found.games.length ? t2("settings.backupSummary", { count: found.games.length, size: formatBytes(found.totalBytes) }) : t2("settings.backupEmpty");
    const remove = (game) => {
      setArmed(null);
      setProblem("");
      deleteBackup(FileSystem, game.root, game.name, (path) => downloadQueue().readsFrom?.(path) ?? false).then(refresh, (error) => setProblem(error.busy ? t2("settings.backupBusy") : t2("settings.backupFailed", { error: error.message })));
    };
    return jsxs(View, { children: [
      jsx(Row, { focusKey: "settings:backup", name: t2("settings.backup"), detail: summary, hint: t2("settings.backupDetail"), end: jsx(Icon, { name: open ? "chevronUp" : "chevronDown", color: colors.muted }), onPress: () => {
        setOpen(!open);
        refresh();
      } }),
      ...open ? found.games.map((game) => jsx(Row, {
        focusKey: `settings:backup:${game.path}`,
        name: game.name,
        // glibren.12: o sistema e o codigo, o formato ("RAR · 3 partes"), o tamanho e o disco; embaixo, os arquivos (so
        // os nomes) e se o .exfat convertido existe.
        detail: armed === game.path ? t2("settings.backupConfirm", { size: formatBytes(game.bytes) }) : [game.platform ? `${game.platform.toUpperCase()}${game.code ? ` ${game.code}` : ""}` : game.code, game.format ? `${game.format.toUpperCase()}${game.parts > 1 ? ` \xB7 ${t2("settings.backupParts", { count: game.parts })}` : ""}` : "", formatBytes(game.bytes), driveName(game.root)].filter(Boolean).join(" \xB7 "),
        hint: [game.converted ? t2("settings.backupConverted", { file: game.converted }) : t2("settings.backupNotConverted"), (game.fileNames || []).slice(0, 4).join(", ") + (game.fileNames?.length > 4 || game.moreFiles ? ` ${t2("settings.backupMore", { count: (game.fileNames?.length ?? 0) - Math.min(4, game.fileNames?.length ?? 0) + (game.moreFiles || 0) })}` : "")].filter(Boolean).join(" \xB7 "),
        end: jsx(Icon, { name: armed === game.path ? "delete" : "x", color: armed === game.path ? "#f87171" : colors.muted }),
        onPress: () => armed === game.path ? remove(game) : setArmed(game.path)
      }, game.path)) : [],
      open && problem ? jsx(Callout, { tone: "error", children: problem }) : null
    ] });
  }
  // Drives, the speed limit and whether a download in parts opens the browser for its next part by itself.
  function DownloadsCard({ onPhonePin }) {
    const t2 = useT();
    const drives = useDrives();
    const autoParts = useAutoContinueParts();
    const background = useBackgroundDownloads();
    const convertExfat = useConvertToExfat();
    const warnPs5Pkg = usePs5PkgWarning();
    const phone = usePhoneMonitor();
    const phoneHint = !phone.on ? t2("settings.phoneMonitorDetail") : phone.address ? t2("settings.phoneMonitorAddress", { url: phone.address }) : t2("settings.phoneMonitorNoAddress");
    return /* @__PURE__ */ (0, jsxs)(View, { scrollAnchor: true, style: CARD, children: [
      /* @__PURE__ */ (0, jsx)(CardHead, { icon: "download", title: t2("settings.card.downloads") }),
      /* @__PURE__ */ (0, jsx)(Row, { focusKey: "settings:autoParts", name: t2("settings.autoParts"), hint: t2("settings.autoPartsDetail"), end: /* @__PURE__ */ (0, jsx)(Switch, { on: autoParts }), onPress: () => setAutoContinueParts(!autoParts) }),
      // glibren-bg: downloads em segundo plano (state/background-downloads.js).
      /* @__PURE__ */ (0, jsx)(Row, { focusKey: "settings:background", name: t2("settings.background"), hint: t2("settings.backgroundDetail"), end: /* @__PURE__ */ (0, jsx)(Switch, { on: background }), onPress: () => setBackgroundDownloads(!background) }),
      // MODIFIED (glibren.5): the background helper's pause when the app closes (0 to 30 s), only with the background
      // downloads on (without them nothing downloads while the app is closed).
      background ? jsx(View, { style: { paddingVertical: 8 }, children: jsx(PauseOnCloseRow, {}) }) : null,
      // glibren.12: PS5 games to .exfat (state/exfat-convert.js), and the BACKUP folder with the originals.
      jsx(Row, { focusKey: "settings:convertExfat", name: t2("settings.convertExfat"), hint: t2("settings.convertExfatDetail"), end: jsx(Switch, { on: convertExfat }), onPress: () => setConvertToExfat(!convertExfat) }),
      // pac1: the conversion's options (the payload converts): pause between conversions, write limit, write in chunks.
      ...convertExfat ? ["convertPauseSeconds", "convertWriteLimit", "convertSyncMB"].map((name) => jsx(View, { style: { paddingVertical: 8 }, children: jsx(ConvertOptionRow, { name }) }, name)) : [],
      jsx(BackupRow, { roots: drives.roots }),
      // glibren.16: Install on a PS5 .pkg asks first above firmware 11.60 (state/ps5-pkg-warning.js, ui/Ps5PkgWarning.jsx).
      jsx(Row, { focusKey: "settings:warnPs5Pkg", name: t2("settings.warnPs5Pkg"), hint: t2("settings.warnPs5PkgDetail"), end: jsx(Switch, { on: warnPs5Pkg }), onPress: () => setPs5PkgWarning(!warnPs5Pkg) }),
      // glibren: a pagina do celular (state/phone-monitor.js): ver os downloads do segundo plano e, com o PIN, controla-los.
      /* @__PURE__ */ (0, jsx)(Row, { focusKey: "settings:phoneMonitor", name: t2("settings.phoneMonitor"), hint: phoneHint, end: /* @__PURE__ */ (0, jsx)(Switch, { on: phone.on }), onPress: () => setPhoneMonitor(!phone.on) }),
      phone.on ? /* @__PURE__ */ (0, jsx)(Row, { focusKey: "settings:phoneMonitorPin", name: t2(phone.hasPin ? "settings.phoneMonitorPinChange" : "settings.phoneMonitorPin"), hint: t2(phone.hasPin ? "settings.phoneMonitorPinDetail" : "settings.phoneMonitorNoPin"), end: /* @__PURE__ */ (0, jsx)(Icon, { name: "chevronRight", color: colors.muted }), onPress: () => onPhonePin(phone.hasPin ? "change" : "create") }) : null,
      /* @__PURE__ */ (0, jsx)(View, { style: { height: 1, marginVertical: 8, backgroundColor: colors.line } }),
      /* @__PURE__ */ (0, jsx)(SimultaneousRow, {}),
      /* @__PURE__ */ (0, jsx)(View, { style: { height: 1, marginVertical: 8, backgroundColor: colors.line } }),
      /* @__PURE__ */ (0, jsx)(SpeedLimitRow, {}),
      /* @__PURE__ */ (0, jsx)(View, { style: { height: 1, marginVertical: 8, backgroundColor: colors.line } }),
      jsx(DefaultDriveRow, { roots: drives.roots }),
      /* @__PURE__ */ (0, jsx)(View, { style: { height: 1, marginVertical: 8, backgroundColor: colors.line } }),
      ...drives.roots.map((root) => /* @__PURE__ */ (0, jsx)(Drive, { root, usage: drives.usage[root] }, root))
    ] });
  }
  // glibren.20: the Orbit Store list (off by default): the switch, what the payload last did, and a warning while it has
  // stopped updating. A new copy written by the payload is read as soon as Settings sees it (shown after a restart).
  function OrbitRow() {
    const t2 = useT();
    const { on, status, stale } = useOrbitStatus();
    const lastOk = Number(status?.lastOk) || 0;
    (0, useEffect)(() => {
      if (on && lastOk) void refreshOrbitFeed();
    }, [on, lastOk]);
    const feed = on ? orbitFeedSnapshot() : null;
    let detail = t2("settings.orbit.off");
    if (on && status?.busy) detail = t2("settings.orbit.busy");
    else if (on && !lastOk) detail = status?.error ? t2("settings.orbit.error", { error: status.error }) : t2("settings.orbit.waiting");
    else if (on) {
      const ok = t2("settings.orbit.ok", { count: Number(status.games) || feed?.games || 0, links: Number(status.releases) || 0, revision: Number(status.revision) || 0, date: readTime(isoStamp(lastOk * 1e3)) });
      detail = status?.error ? `${ok} · ${t2("settings.orbit.error", { error: status.error })}` : ok;
    }
    return /* @__PURE__ */ (0, jsxs)(Fragment, { children: [
      jsx(Row, { focusKey: "settings:feeds:orbit", name: t2("settings.orbit.name"), detail, hint: t2("settings.orbit.hint"), end: jsx(Switch, { on }), onPress: () => setOrbitFeed(!on) }),
      stale ? /* @__PURE__ */ (0, jsx)(Callout, { tone: "warn", children: t2(`orbit.stale.${stale}`) }) : null,
      feed?.restart ? /* @__PURE__ */ (0, jsx)(Callout, { children: t2("settings.feeds.restart") }) : null
    ] });
  }
  // glibren.25: "Show in the store": one switch per catalog the store has games from (the bundled one, the live one,
  // each feed, the Orbit Store list). Off, its games leave the store (both versions) but the feed stays included and
  // updated; with only one on, the store shows only that catalog. The last one shown cannot be turned off.
  function ShownCatalogs() {
    const t2 = useT();
    useStoreMode();
    const { focusLater } = useNavActions();
    const [sources] = (0, useState)(() => librarySources());
    const [notice, setNotice] = (0, useState)("");
    if (sources.length < 2) return null;
    return jsxs(Fragment, { children: [
      jsx(View, { style: { height: 1, marginVertical: 8, backgroundColor: colors.line } }),
      jsx(Text, { style: text(20, colors.muted, { fontWeight: 600, letterSpacing: 1 }), children: t2("settings.feeds.shown") }),
      notice ? jsx(Callout, { tone: "warn", children: notice }) : null,
      ...sources.map((source) => jsx(Row, { focusKey: `settings:feeds:shown:${source.id}`, name: sourceLabel(t2, source), detail: shownDetail(t2, source), hint: t2("settings.feeds.shownHint"), end: jsx(Switch, { on: sourceShown(source.id) }), onPress: () => {
        const { ok, reason } = setSourceShown(source.id, !sourceShown(source.id));
        setNotice(ok ? "" : reason === "last" ? t2("settings.feeds.shownLast") : reason === "empty" ? t2("storeMode.empty") : t2("storeMode.never"));
        // glibren.26: o foco fica na linha tocada (a .25 refazia as linhas a cada troca e o foco subia para o topo).
        focusLater(`settings:feeds:shown:${source.id}`);
      } }, source.id))
    ] });
  }
  // glibren.27: a catalog's line under "Show in the store": its games and, for the live catalog and a web feed, when its
  // copy was last downloaded (the live catalog has no row of its own in the feeds list).
  function shownDetail(t2, source) {
    const games = t2("tblib.sourceGames", { count: source.count });
    if (source.kind === "bundled") return games;
    const [feed] = feedsSnapshot([source.id]);
    if (!feed?.fetchedAt) return games;
    return t2("settings.feeds.games", { count: source.count, date: readTime(feed.fetchedAt) });
  }
  // glibren.14: no limit of three feeds any more (MAX_FEEDS is only a safety ceiling), and "Add a file from the PS5".
  function FeedsCard({ onAdd, onAddFile, onMirror }) {
    const t2 = useT();
    const feeds = useFeeds();
    const orbitOn = useOrbitFeed();
    return /* @__PURE__ */ (0, jsxs)(View, { scrollAnchor: true, style: CARD, children: [
      /* @__PURE__ */ (0, jsx)(CardHead, { icon: "layers", title: t2("settings.card.feeds") }),
      jsx(OrbitRow, {}),
      ...feeds.map((feed) => /* @__PURE__ */ (0, jsx)(FeedRow, { feed, onMirror }, feed.url)),
      feeds.length < MAX_FEEDS ? /* @__PURE__ */ (0, jsx)(Row, { focusKey: "settings:feeds:add", name: t2("settings.feeds.add"), hint: t2("settings.feeds.detail"), end: /* @__PURE__ */ (0, jsx)(Icon, { name: "external", color: colors.muted }), onPress: onAdd }) : null,
      feeds.length < MAX_FEEDS ? jsx(Row, { focusKey: "settings:feeds:addFile", name: t2("settings.feeds.addFile"), hint: t2("settings.feeds.addFileHint"), end: jsx(Icon, { name: "folder", color: colors.muted }), onPress: onAddFile }) : null,
      feeds.length || orbitOn ? /* @__PURE__ */ (0, jsx)(Row, { focusKey: "settings:feeds:refresh", name: t2("settings.feeds.refresh"), detail: feeds.some((feed) => feed.state === "refreshing") ? t2("settings.feeds.refreshing") : null, hint: t2("settings.feeds.refreshHint"), end: /* @__PURE__ */ (0, jsx)(Icon, { name: "restart", color: colors.muted }), onPress: () => void refreshFeedsNow() }) : null,
      feeds.some((feed) => feed.restart) ? /* @__PURE__ */ (0, jsx)(Callout, { children: t2("settings.feeds.restart") }) : null,
      jsx(ShownCatalogs, {})
    ] });
  }
  // Debrid providers: the TorBox API key (typed in, kept as its last four characters on screen), a
  // connection test that pauses a running download while it asks (the network is one task at a time),
  // and removing the key. With a key, the source list offers TorBox on the hosts it supports.
  var quietly = (reason, work) => downloadQueue().quietNetwork ? downloadQueue().quietNetwork(reason, work) : work();
  // glibren.23: one host's quota today: "1fichier: 3 of 5 links · 20 GB of 100 GB", or that it is out of it or down.
  function quotaLine(t2, host) {
    const parts = [];
    if (host.linkLimit) parts.push(t2("settings.debrid.quotaLinks", { used: formatNumber2(host.linkUsed), limit: formatNumber2(host.linkLimit) }));
    if (host.bytesLimit) parts.push(t2("settings.debrid.quotaBytes", { used: formatBytes(host.bytesUsed), limit: formatBytes(host.bytesLimit) }));
    if (!host.working) parts.push(t2("settings.debrid.quotaDown"));
    else if (!host.quota) parts.push(t2("settings.debrid.quotaOut"));
    return `${host.name}: ${parts.join(" \xB7 ")}`;
  }
  function DebridCard({ onKey, onAllDebridKey }) {
    const t2 = useT();
    const debrid = useDebrid();
    const [test, setTest] = (0, useState)({ state: "idle", error: "" });
    const [allTest, setAllTest] = (0, useState)({ state: "idle", error: "" });
    const runAll = () => {
      if (allTest.state === "testing") return;
      setAllTest({ state: "testing", error: "" });
      testAllDebrid({ quiet: quietly }).then(
        () => setAllTest({ state: "ok", error: "" }),
        (error2) => setAllTest({ state: "failed", error: error2.message })
      );
    };
    const all = debrid.allDebrid;
    const allStatus = allTest.state === "testing" ? t2("settings.alldebrid.testing") : allTest.state === "failed" ? null : debridStatus(t2, "alldebrid", all.account);
    const run = () => {
      if (test.state === "testing") return;
      setTest({ state: "testing", error: "" });
      testTorBox({ quiet: (reason, work) => downloadQueue().quietNetwork ? downloadQueue().quietNetwork(reason, work) : work() }).then(
        () => setTest({ state: "ok", error: "" }),
        (error2) => setTest({ state: "failed", error: error2.message })
      );
    };
    const status = test.state === "testing" ? t2("settings.debrid.testing") : test.state === "failed" ? null : debridStatus(t2, "torbox", debrid.account);
    // glibren.23
    const quick = useTorBoxQuick();
    const [quota, setQuota] = (0, useState)({ state: "idle", error: "" });
    const [showQuota, setShowQuota] = (0, useState)(false);
    const quotas = torBoxQuotas();
    const readQuota = () => {
      if (quota.state === "reading") return;
      if (showQuota) {
        setShowQuota(false);
        return;
      }
      setShowQuota(true);
      setQuota({ state: "reading", error: "" });
      refreshTorBoxHosts({ quiet: quietly }).then(() => setQuota({ state: "ok", error: "" }), (error2) => setQuota({ state: "failed", error: error2.message }));
    };
    const quotaText = quota.state === "reading" ? t2("settings.debrid.quotaReading") : quotas ? t2("settings.debrid.quotaSummary", { working: formatNumber2(quotas.working), out: formatNumber2(quotas.out) }) : t2("settings.debrid.quotaUnknown");
    return /* @__PURE__ */ (0, jsxs)(View, { scrollAnchor: true, style: CARD, children: [
      /* @__PURE__ */ (0, jsx)(CardHead, { icon: "zap", title: t2("settings.card.debrid") }),
      /* @__PURE__ */ (0, jsx)(Row, { focusKey: "settings:torbox:key", name: t2("settings.debrid.key"), detail: debrid.configured ? t2("settings.debrid.keySet", { key: debrid.masked }) : t2("settings.debrid.keyNone"), hint: `${t2("settings.debrid.detail")} ${t2("settings.debrid.stored")}`, end: /* @__PURE__ */ (0, jsx)(Icon, { name: "chevronRight", color: colors.muted }), onPress: onKey }),
      debrid.configured ? /* @__PURE__ */ (0, jsx)(Row, { focusKey: "settings:torbox:test", name: t2("settings.debrid.test"), detail: status, hint: t2("settings.debrid.testDetail"), end: /* @__PURE__ */ (0, jsx)(Icon, { name: test.state === "testing" ? "globe" : "restart", color: colors.muted }), onPress: run }) : null,
      test.state === "failed" ? /* @__PURE__ */ (0, jsx)(Callout, { tone: "error", children: test.error }) : null,
      // glibren.23: the quick check (Orbit Store's way) and the hosts' quota today.
      debrid.configured ? jsx(Row, { focusKey: "settings:torbox:quick", name: t2("settings.debrid.quick"), hint: t2("settings.debrid.quickDetail"), end: jsx(Switch, { on: quick }), onPress: () => setTorBoxQuick(!quick) }) : null,
      debrid.configured ? jsx(Row, { focusKey: "settings:torbox:quota", name: t2("settings.debrid.quota"), detail: quotaText, hint: t2("settings.debrid.quotaDetail"), end: jsx(Icon, { name: quota.state === "reading" ? "globe" : showQuota ? "chevronUp" : "chevronDown", color: colors.muted }), onPress: readQuota }) : null,
      debrid.configured && showQuota && quotas?.hosts.length ? jsx(View, { style: { gap: 4, paddingHorizontal: 24, paddingBottom: 12 }, children: quotas.hosts.slice(0, 40).map((host) => jsx(Text, { style: { fontFamily: "Exo2", fontSize: 19, lineHeight: 27, color: host.working && host.quota ? colors.muted : "#fbbf24" }, children: quotaLine(t2, host) }, host.name)) }) : null,
      quota.state === "failed" ? jsx(Callout, { tone: "error", children: quota.error }) : null,
      debrid.configured ? /* @__PURE__ */ (0, jsx)(Row, { focusKey: "settings:torbox:remove", name: t2("settings.debrid.remove"), hint: t2("settings.debrid.removeDetail"), end: /* @__PURE__ */ (0, jsx)(Icon, { name: "trash", color: colors.muted }), onPress: () => {
        setTorBoxKey("");
        setTest({ state: "idle", error: "" });
      } }) : null,
      // 0.5.1: AllDebrid, used when TorBox has no key.
      jsx(Row, { focusKey: "settings:alldebrid:key", name: t2("settings.alldebrid.key"), detail: all.configured ? t2("settings.debrid.keySet", { key: all.masked }) : t2("settings.debrid.keyNone"), hint: t2("settings.alldebrid.stored"), end: jsx(Icon, { name: "chevronRight", color: colors.muted }), onPress: onAllDebridKey }),
      all.configured ? jsx(Row, { focusKey: "settings:alldebrid:test", name: t2("settings.debrid.test"), detail: allStatus, hint: t2("settings.alldebrid.testDetail"), end: jsx(Icon, { name: allTest.state === "testing" ? "globe" : "restart", color: colors.muted }), onPress: runAll }) : null,
      allTest.state === "failed" ? jsx(Callout, { tone: "error", children: allTest.error }) : null,
      all.configured ? jsx(Row, { focusKey: "settings:alldebrid:remove", name: t2("settings.debrid.remove"), hint: t2("settings.alldebrid.removeDetail"), end: jsx(Icon, { name: "trash", color: colors.muted }), onPress: () => {
        setAllDebridKey("");
        setAllTest({ state: "idle", error: "" });
      } }) : null,
      all.configured && debrid.configured ? jsx(Callout, { children: t2("settings.alldebrid.both") }) : null
    ] });
  }
  // glibren.9: the TorBox library (state/torbox-library.js): built only when the gamer presses the button, over the
  // sources picked here (all by default), and it keeps going with the app on another page. Its store version is
  // switched here or at the top of Discover (browse/StoreModeBar.jsx).
  function sourceLabel(t2, source) {
    if (source.kind === "bundled") return t2("tblib.source.bundled");
    if (source.kind === "live") return t2("tblib.source.live");
    return source.name || hostOf(source.id);
  }
  var minutesOf = (ms) => String(Math.max(1, Math.round(ms / 6e4)));
  function libraryDetail(t2, run, summary) {
    if (run.state === "running") {
      if (run.waitingUntil) return t2("tblib.waiting", { seconds: String(Math.max(1, Math.round((run.waitingUntil - Date.now()) / 1e3))) });
      if (run.phase === "account") return t2("tblib.phase.account");
      if (run.phase === "list") return t2("tblib.phase.list");
      const base = t2("tblib.running", { done: formatNumber2(run.done), total: formatNumber2(run.total), found: formatNumber2(run.found) });
      return run.etaMs ? `${base} · ${t2("tblib.eta", { minutes: minutesOf(run.etaMs) })}` : base;
    }
    if (run.state === "done") return t2("tblib.done", { found: formatNumber2(run.found), total: formatNumber2(run.total), calls: formatNumber2(run.calls) });
    if (run.state === "cancelled") return t2("tblib.cancelled", { done: formatNumber2(run.done), total: formatNumber2(run.total) });
    if (run.state === "failed") return t2("tblib.failed", { error: run.error });
    if (summary.open) return t2("tblib.status.open", { done: formatNumber2(summary.open.done), total: formatNumber2(summary.open.total) });
    if (summary.builtAt) return t2("tblib.status.built", { confirmed: formatNumber2(summary.confirmed), games: formatNumber2(summary.games), date: formatDate2(summary.builtAt.slice(0, 10)) });
    return t2("tblib.status.never");
  }
  function TorBoxLibraryCard() {
    const t2 = useT();
    const debrid = useDebrid();
    const run = useLibraryProgress();
    const store = useStoreMode();
    const [sources] = (0, useState)(() => librarySources());
    const [off, setOff] = (0, useState)([]);
    const [notice, setNotice] = (0, useState)("");
    // Read again whenever the run's state changes (a run that ends writes the file).
    const summary = (0, useMemo)(() => librarySummary(), [run.state]);
    const running = run.state === "running";
    // glibren.26: a contagem de uma espera do TorBox anda (a tela só se redesenhava quando chegava uma resposta).
    const [, tick] = (0, useState)(0);
    (0, useEffect)(() => {
      if (!run.waitingUntil) return void 0;
      const timer = setInterval(() => tick((n) => n + 1), 1e3);
      return () => clearInterval(timer);
    }, [run.waitingUntil]);
    const picked = sources.filter((source) => !off.includes(source.id)).map((source) => source.id);
    const chosen = off.length ? picked : null;
    const start = (fresh, onlyNew = false) => {
      if (!debrid.configured) return setNotice(t2("tblib.needKey"));
      if (!picked.length) return setNotice(t2("tblib.noSource"));
      setNotice("");
      void startLibrary({ sources: fresh || onlyNew ? chosen : summary.open?.sources ?? chosen, fresh, onlyNew: onlyNew || !fresh && Boolean(summary.open?.onlyNew) });
    };
    const resumable = !running && summary.open;
    // glibren.25: jogos que chegaram depois da última montagem (a lista Orbit Store ligada depois, um feed novo):
    // um botão verifica só eles, sem refazer os já verificados.
    const fresher = !running && !resumable && summary.unchecked > 0;
    const fraction = run.total ? run.done / run.total : 0;
    // glibren.13: the games TorBox holds only as a broken copy (an error page kept as the file), left out of the store.
    const broken = run.state === "idle" ? summary.broken : run.broken || 0;
    return jsxs(View, { scrollAnchor: true, style: CARD, children: [
      jsx(CardHead, { icon: "grid", title: t2("settings.card.torboxLibrary") }),
      jsx(Callout, { children: libraryDetail(t2, run, summary) }),
      broken ? jsx(Callout, { tone: "warn", children: t2("tblib.broken", { count: broken }) }) : null,
      fresher ? jsx(Callout, { tone: "warn", children: t2("tblib.unchecked", { count: summary.unchecked }) }) : null,
      running ? jsx(ProgressBar, { fraction, width: 760, active: true }) : null,
      !debrid.configured ? jsx(Callout, { tone: "warn", children: t2("tblib.needKey") }) : null,
      notice ? jsx(Callout, { tone: "warn", children: notice }) : null,
      running
        ? jsx(Row, { focusKey: "settings:tblib:build", name: t2("tblib.cancel"), hint: t2("tblib.cancelHint"), end: jsx(Icon, { name: "x", color: colors.muted }), onPress: cancelLibrary })
        : jsx(Row, { focusKey: "settings:tblib:build", name: resumable ? t2("tblib.continue", { done: formatNumber2(summary.open.done), total: formatNumber2(summary.open.total) }) : t2("tblib.build"), hint: t2("tblib.hint"), end: jsx(Icon, { name: "play", color: colors.muted }), onPress: () => start(false) }),
      fresher ? jsx(Row, { focusKey: "settings:tblib:new", name: t2("tblib.checkNew", { count: formatNumber2(summary.unchecked) }), hint: t2("tblib.checkNewHint"), end: jsx(Icon, { name: "play", color: colors.muted }), onPress: () => start(false, true) }) : null,
      resumable ? jsx(Row, { focusKey: "settings:tblib:fresh", name: t2("tblib.rebuild"), hint: t2("tblib.rebuildHint"), end: jsx(Icon, { name: "restart", color: colors.muted }), onPress: () => start(true) }) : null,
      jsx(Row, { focusKey: "settings:tblib:store", name: t2("tblib.useStore"), detail: store.count ? t2("tblib.storeCount", { count: formatNumber2(store.count) }) : null, hint: t2("tblib.useStoreHint"), end: jsx(Switch, { on: store.mode === "torbox" }), onPress: () => {
        const { ok, reason } = applyStoreMode(store.mode === "torbox" ? "full" : "torbox");
        setNotice(ok ? "" : reason === "empty" ? t2("storeMode.empty") : t2("storeMode.never"));
      } }),
      jsx(View, { style: { height: 1, marginVertical: 8, backgroundColor: colors.line } }),
      jsx(Text, { style: text(20, colors.muted, { fontWeight: 600, letterSpacing: 1 }), children: t2("tblib.sources") }),
      ...sources.map((source) => jsx(Row, { focusKey: `settings:tblib:src:${source.id}`, name: sourceLabel(t2, source), detail: t2("tblib.sourceGames", { count: source.count }), end: jsx(Switch, { on: !off.includes(source.id) }), onPress: () => {
        if (running) return;
        setOff((list) => list.includes(source.id) ? list.filter((id) => id !== source.id) : [...list, source.id]);
      } }, source.id))
    ] });
  }
  // The Source Addition Guide: how a catalog feed gets into the store, step by step. One row until opened;
  // then each step is focusable, so the controller walks down it and the page scrolls along.
  var STEP = (_state) => [{ position: "relative", flexDirection: "row", alignItems: "flex-start", gap: 20, paddingHorizontal: 20, paddingVertical: 14, marginHorizontal: -20, borderRadius: radius.md }, _state.focused ? { backgroundColor: colors.surface3 } : null];
  function StepFace({ index, title, detail }) {
    const focused = useIsFocused();
    return /* @__PURE__ */ (0, jsxs)(Fragment, { children: [
      /* @__PURE__ */ (0, jsx)(FocusRing, { round: "md" }),
      /* @__PURE__ */ (0, jsx)(View, { style: { width: 44, height: 44, alignItems: "center", justifyContent: "center", borderRadius: radius.pill, backgroundColor: focused ? colors.accent : colors.surface3 }, children: /* @__PURE__ */ (0, jsx)(Text, { style: { fontFamily: "JetBrainsMono-Regular", fontSize: 22, lineHeight: 30, color: focused ? colors.accentFg : colors.glow }, children: String(index + 1) }) }),
      /* @__PURE__ */ (0, jsxs)(View, { style: { flex: 1, gap: 4 }, children: [
        /* @__PURE__ */ (0, jsx)(Text, { style: text(23, colors.fg, { fontWeight: 600 }), children: title }),
        /* @__PURE__ */ (0, jsx)(Text, { style: text(20, focused ? colors.fg : colors.muted), children: detail })
      ] })
    ] });
  }
  function GuideCard() {
    const t2 = useT();
    const companion = useCompanion();
    const [open, setOpen] = (0, useState)(false);
    const steps = [
      [t2("settings.guide.find"), t2("settings.guide.findDetail")],
      [t2("settings.guide.console"), t2("settings.guide.consoleDetail")],
      [t2("settings.guide.phone"), t2("settings.guide.phoneDetail", { url: companion.url || "http://192.168.x.x:34177/" })],
      [t2("settings.guide.mirrors"), t2("settings.guide.mirrorsDetail", { count: MAX_MIRRORS })],
      [t2("settings.guide.refresh"), t2("settings.guide.refreshDetail")],
      [t2("settings.guide.reopen"), t2("settings.guide.reopenDetail")]
    ];
    return /* @__PURE__ */ (0, jsxs)(View, { scrollAnchor: true, style: CARD, children: [
      /* @__PURE__ */ (0, jsx)(CardHead, { icon: "list", title: t2("settings.card.guide") }),
      /* @__PURE__ */ (0, jsx)(Row, { focusKey: "settings:guide", name: open ? t2("settings.guide.hide") : t2("settings.guide.show"), hint: t2("settings.guide.detail"), end: /* @__PURE__ */ (0, jsx)(Icon, { name: open ? "chevronUp" : "chevronDown", color: colors.muted }), onPress: () => setOpen((value) => !value) }),
      ...open ? steps.map(([title, detail], index) => /* @__PURE__ */ (0, jsx)(View, { focusKey: `settings:guide:${index}`, focusable: true, style: STEP, children: /* @__PURE__ */ (0, jsx)(StepFace, { index, title, detail }) }, index)) : []
    ] });
  }
  // The optional donation link: a QR code for the phone and a short note, shown only when the row is
  // opened. Nothing in the app depends on it, asks for it or reminds anyone of it.
  // 0.5.6: Ko-fi in place of Buy Me a Coffee, its page itself, one step fewer than jobees.org's Support screen
  // (which keeps the crypto addresses and the supporters' names).
  var SUPPORT_URL = "https://ko-fi.com/jvk3r";
  // The panel takes focus when it opens, so the page scrolls until the whole code shows and stays there for a
  // phone to scan (only the rows around it could take focus before, and either one scrolled half the code
  // away). Cross on it folds it again.
  function SupportPanel({ onClose }) {
    const t2 = useT();
    return /* @__PURE__ */ (0, jsxs)(View, { focusKey: "settings:support:qr", onPress: onClose, style: { position: "relative", flexDirection: "row", alignItems: "center", gap: 28, borderRadius: radius.md, backgroundColor: colors.surface2, padding: 22 }, children: [
      /* @__PURE__ */ (0, jsx)(FocusRing, { round: "md" }),
      // Drawn at the image's own size (packaging/support-qr.py: 37 modules x 6 px), so no module edge blurs.
      /* @__PURE__ */ (0, jsx)(View, { style: { borderRadius: radius.md, backgroundColor: "#ffffff", padding: 6 }, children: /* @__PURE__ */ (0, jsx)(Image, { source: supportQr, resizeMode: "contain", style: { width: 222, height: 222 } }) }),
      /* @__PURE__ */ (0, jsxs)(View, { style: { flex: 1, gap: 12 }, children: [
        /* @__PURE__ */ (0, jsx)(Text, { style: text(21, colors.fg), children: t2("settings.support.note") }),
        /* @__PURE__ */ (0, jsx)(Text, { style: text(20, colors.muted), children: t2("settings.support.free") }),
        /* @__PURE__ */ (0, jsx)(Text, { style: text(19, colors.subtle), children: t2("settings.support.scan") }),
        /* @__PURE__ */ (0, jsx)(Text, { style: { fontFamily: "JetBrainsMono-Regular", fontSize: 20, lineHeight: 28, color: colors.glow }, children: SUPPORT_URL.replace("https://", "") })
      ] })
    ] });
  }
  // 0.5.1: "Report a bug": press once to arm, again to send the logs to the Jobee'sLair Discord (state/bug-report.js).
  // Only in a build that has the relay's address. 0.5.5: the console's report code under it (a player's post is
  // matched to their logs by it), and the switch for sending the logs by themselves when something fails.
  function ReportRow() {
    const t2 = useT();
    const [available] = (0, useState)(() => Boolean(reportRelay()));
    const [report, setReport] = (0, useState)({ state: "idle", error: "" });
    (0, useEffect)(() => {
      if (report.state !== "armed") return void 0;
      const timer = setTimeout(() => setReport({ state: "idle", error: "" }), 4e3);
      return () => clearTimeout(timer);
    }, [report.state]);
    if (!available) return null;
    const press = () => {
      if (report.state === "sending") return;
      if (report.state !== "armed") return setReport({ state: "armed", error: "" });
      setReport({ state: "sending", error: "" });
      sendReport({ queue: downloadQueue() }).then(
        () => setReport({ state: "sent", error: "" }),
        (error2) => setReport({ state: "failed", error: error2.message })
      );
    };
    const detail = report.state === "armed" ? t2("settings.report.armed") : report.state === "sending" ? t2("settings.report.sending") : report.state === "sent" ? t2("settings.report.sent", { code: reportCode() }) : t2("settings.report.code", { code: reportCode() });
    return jsxs(Fragment, { children: [
      jsx(Row, { focusKey: "settings:bugReport", name: t2("settings.report.row"), detail, hint: t2("settings.report.detail"), end: jsx(Icon, { name: report.state === "sent" ? "circleCheck" : "alert", color: report.state === "armed" ? colors.glow : colors.muted }), onPress: press }),
      report.state === "failed" ? jsx(Callout, { tone: "error", children: report.error }) : null,
      jsx(AutoReportRow, {})
    ] });
  }
  function AutoReportRow() {
    const t2 = useT();
    const [on, setOn] = (0, useState)(() => autoReportsChoice() === true);
    (0, useEffect)(() => subscribeAutoReports(() => setOn(autoReportsChoice() === true)), []);
    return jsx(Row, { focusKey: "settings:autoReports", name: t2("settings.report.autoRow"), hint: t2("settings.report.autoDetail"), end: jsx(Switch, { on }), onPress: () => setAutoReports(!on) });
  }
  // 0.5.2: the announcements up now, whole (the bar under the top island can cut a long one short), the stats
  // switch and what it sends (state/online.js).
  function OnlineRows() {
    const t2 = useT();
    const { enabled, announcements } = useOnline();
    return jsxs(Fragment, { children: [
      ...announcements.map((note) => jsx(Callout, { tone: note.level === "warning" ? "warn" : "info", children: `${t2("news.title")}: ${note.text}` }, note.id)),
      jsx(Row, { focusKey: "settings:stats", name: t2("settings.online.row"), hint: t2("settings.online.detail"), end: jsx(Switch, { on: enabled }), onPress: () => online().setEnabled(!enabled) }),
      jsx(Folded, { focusKey: "settings:stats:what", name: t2("settings.online.what"), paragraphs: [tWhole("settings.online.sends"), tWhole("settings.online.never")] })
    ] });
  }
  // glibren (medidor de memoria, state/memory-meter.js): "Memória: agora X MB · pico Y MB (em <ação>)"; aberta, as
  // telas e ações que mais usaram, da maior para a menor. Uma amostra ao abrir a página e outra a cada 30 s.
  var MEMORY_ACTIONS = {
    "inicio": "start",
    "loja:montar": "store",
    "loja:trocar": "storeChange",
    "loja:abrir": "live",
    "loja:atualizar": "live",
    "orbit:abrir": "orbit",
    "orbit:atualizar": "orbit",
    "feeds:abrir": "feeds",
    "feeds:atualizar": "feeds",
    "biblioteca-torbox:ler": "library",
    "biblioteca-torbox:montar": "library",
    "biblioteca-torbox:gravar": "libraryWrite",
    "descobrir-formatos": "formats",
    "descobrir-formatos:inicio": "formats",
    "procurar-torbox": "torboxSearch"
  };
  function memoryActionName(t2, action) {
    const name = String(action ?? "");
    if (name === "tela:tube") return "YouTube";
    if (name.startsWith("tela:")) return t2("settings.memory.screen", { name: name.slice(5) });
    const key = MEMORY_ACTIONS[name];
    return key ? t2(`settings.memory.action.${key}`) : name;
  }
  var memoryMB = (bytes) => formatNumber2(bytes / (1024 * 1024), { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  function MemoryRows({ startOpen = false } = {}) {
    const t2 = useT();
    const [open, setOpen] = (0, useState)(startOpen === true);
    const [meter, setMeter] = (0, useState)(() => {
      memorySample();
      return memorySnapshot();
    });
    (0, useEffect)(() => subscribeMemory(() => setMeter(memorySnapshot())), []);
    const { last, peak, top } = meter;
    const detail = last && peak ? t2("settings.memory.detail", { now: memoryMB(last.used), peak: memoryMB(peak.used), action: memoryActionName(t2, peak.action) }) : t2("settings.memory.none");
    const hint = last?.limit ? t2("settings.memory.hint", { limit: formatNumber2(last.limit / (1024 * 1024), { maximumFractionDigits: 1 }) }) : void 0;
    return jsxs(Fragment, { children: [
      jsx(Row, { focusKey: "settings:memory", name: t2("settings.memory.row"), detail, hint, end: top.length ? jsx(Icon, { name: open ? "chevronUp" : "chevronDown", color: colors.muted }) : null, onPress: () => setOpen((value) => !value) }),
      ...open ? top.map((item, index) => jsx(Text, { style: text(20, colors.muted), children: t2("settings.memory.item", { n: index + 1, action: memoryActionName(t2, item.action), mb: memoryMB(item.used) }) }, item.action)) : []
    ] });
  }
  function AboutCard() {
    const t2 = useT();
    const { online: count } = useOnline();
    const update = useUpdate();
    const install = useInstall();
    const automatic = useAutoInstall();
    const [support, setSupport] = (0, useState)(false);
    const { focusLater } = useNavActions();
    return /* @__PURE__ */ (0, jsxs)(View, { scrollAnchor: true, style: CARD, children: [
      /* @__PURE__ */ (0, jsx)(CardHead, { icon: "star", title: t2("settings.card.about") }),
      /* @__PURE__ */ (0, jsxs)(View, { style: { flexDirection: "row", alignItems: "center", gap: 24 }, children: [
        /* @__PURE__ */ (0, jsx)(JLMark, { height: 72 }),
        /* @__PURE__ */ (0, jsxs)(View, { style: { flex: 1, gap: 4 }, children: [
          /* @__PURE__ */ (0, jsx)(Text, { style: text(26, colors.fg, { fontWeight: 600 }), children: t2("settings.about.version", { version: VERSION_LABEL }) }),
          /* @__PURE__ */ (0, jsx)(Text, { style: text(22, colors.glow), children: t2("settings.about.creator", { creator: CREATOR }) }),
          /* @__PURE__ */ (0, jsx)(Text, { style: text(20, colors.muted), children: t2("settings.about.ai", { creator: CREATOR }) }),
          count ? jsx(Text, { style: text(20, colors.glow), children: t2("online.now", { count: formatNumber2(count) }) }) : null
        ] })
      ] }),
      /* @__PURE__ */ (0, jsx)(Row, { focusKey: "settings:update", name: t2("settings.update.row"), detail: updateDetail(t2, update, install), end: /* @__PURE__ */ (0, jsx)(Icon, { name: update.update ? "download" : "restart", color: update.update ? colors.glow : colors.muted }), onPress: () => update.update ? openUpdateDialog() : void checkForUpdate() }),
      canInstall ? /* @__PURE__ */ (0, jsx)(Row, { focusKey: "settings:autoUpdate", name: t2("settings.update.auto"), hint: t2("settings.update.autoDetail"), end: /* @__PURE__ */ (0, jsx)(Switch, { on: automatic }), onPress: () => setAutoInstall(!automatic) }) : null,
      /* @__PURE__ */ (0, jsx)(Row, { focusKey: "settings:project", name: t2("settings.about.project"), detail: `github.com/${REPO}`, end: /* @__PURE__ */ (0, jsx)(Icon, { name: "external", color: colors.muted }), onPress: () => {
        try {
          Linking.openURL(`https://github.com/${REPO}`);
        } catch {
        }
      } }),
      /* @__PURE__ */ (0, jsx)(Row, { focusKey: "settings:support", name: t2("settings.support.row"), hint: t2("settings.support.detail"), end: /* @__PURE__ */ (0, jsx)(Icon, { name: support ? "chevronUp" : "chevronDown", color: colors.muted }), onPress: () => {
        setSupport(!support);
        if (!support) focusLater("settings:support:qr");
      } }),
      support ? /* @__PURE__ */ (0, jsx)(SupportPanel, { onClose: () => {
        setSupport(false);
        focusLater("settings:support");
      } }) : null,
      jsx(ReportRow, {}),
      jsx(MemoryRows, {}),
      jsx(DiagnosticsRow, { Row, Callout }), // glibren.44: o diagnostico pelo GitHub
      jsx(PayloadRows, { Row }), // glibren.49 (Fase 2): versao do payload, atualizacao propria e voltar ao embutido
      jsx(OnlineRows, {}),
      /* @__PURE__ */ (0, jsx)(Folded, { focusKey: "settings:credits", name: t2("settings.about.creditsRow"), paragraphs: [tWhole("settings.about.origin"), tWhole("settings.about.credits")] })
    ] });
  }
  // The content neutrality and takedown notice (the same text as README.md and LICENSE): what the app is, what it
  // does not hold, who configures what, and how to report an infringing feed or catalog entry.
  function NoticeCard() {
    const t2 = useT();
    return /* @__PURE__ */ (0, jsxs)(View, { scrollAnchor: true, style: CARD, children: [
      /* @__PURE__ */ (0, jsx)(CardHead, { icon: "alert", title: t2("settings.card.legal") }),
      /* @__PURE__ */ (0, jsx)(Text, { style: text(20, colors.muted), children: t2("settings.legal.neutral") }),
      /* @__PURE__ */ (0, jsx)(Folded, { focusKey: "settings:legal:read", name: t2("settings.legal.read"), paragraphs: [tWhole("settings.legal.nohost"), tWhole("settings.legal.feeds"), tWhole("settings.legal.report")] }),
      /* @__PURE__ */ (0, jsx)(Row, { focusKey: "settings:report", name: t2("settings.legal.reportRow"), detail: `github.com/${REPO}/issues`, end: /* @__PURE__ */ (0, jsx)(Icon, { name: "external", color: colors.muted }), onPress: () => {
        try {
          Linking.openURL(`https://github.com/${REPO}/issues/new?template=takedown.yml`);
        } catch {
        }
      } })
    ] });
  }
  // ---- The section (0.5.0 Pre Release 3) -------------------------------------------------------------------
  // Settings is a section like Downloads and Files: the island's gear, or L1/R1, opens it, and Circle goes back.
  // Its categories are on the left: focusing one shows its cards on the right (Right or Cross goes into
  // them, Left comes back to the category). Every dialog it opens hands focus back to the row that opened it:
  // a dialog that closed without doing so left focus nowhere, and the page could not be moved or left.
  var CATEGORIES = [
    { id: "companion", icon: "globe", label: "settings.companion" },
    { id: "downloads", icon: "download", label: "settings.card.downloads" },
    { id: "feeds", icon: "layers", label: "settings.card.feeds" },
    { id: "debrid", icon: "zap", label: "settings.card.debrid" },
    { id: "torboxLibrary", icon: "grid", label: "settings.card.torboxLibrary" },
    { id: "look", icon: "disc", label: "settings.card.look" },
    { id: "guide", icon: "list", label: "settings.card.guide" },
    { id: "about", icon: "star", label: "settings.card.about" }
    // 0.5.1: the homebrew-only edition has no store to feed, no debrid, no companion and no source guide.
  ].filter((item) => !HOMEBREW_ONLY || ["downloads", "look", "about"].includes(item.id));
  var RAIL = 420;
  function CategoryFace({ icon, label, selected }) {
    const focused = useIsFocused();
    const lit = selected || focused;
    return /* @__PURE__ */ (0, jsxs)(Fragment, { children: [
      /* @__PURE__ */ (0, jsx)(FocusRing, { round: "md" }),
      /* @__PURE__ */ (0, jsx)(View, { style: { width: 5, height: 30, borderRadius: radius.pill, backgroundColor: selected ? colors.accentHi : "transparent" } }),
      /* @__PURE__ */ (0, jsx)(Icon, { name: icon, size: 20, color: lit ? colors.glow : colors.muted }),
      /* @__PURE__ */ (0, jsx)(Text, { style: text(23, lit ? colors.fg : colors.muted, { flex: 1, fontWeight: selected ? 600 : 400, numberOfLines: 1, ellipsizeMode: "tail" }), children: label })
    ] });
  }
  function SettingsScreen({ onBack, start = HOMEBREW_ONLY ? "downloads" : "companion" }) {
    const t2 = useT();
    const { focusLater } = useNavActions();
    const [category, setCategory] = (0, useState)(start);
    const [adding, setAdding] = (0, useState)(false);
    // glibren.14: the file picker of "Add a file from the PS5", over the drives plugged in.
    const [pickingFile, setPickingFile] = (0, useState)(false);
    const [mirrorOf, setMirrorOf] = (0, useState)(null);
    const [pinMode, setPinMode] = (0, useState)(null);
    const [phonePinMode, setPhonePinMode] = (0, useState)(null);
    const [keying, setKeying] = (0, useState)(false);
    const [keyingAll, setKeyingAll] = (0, useState)(false);
    // MODIFIED (glibren.5): the exit sheet, with the downloads as they were when it opened (state/exit-app.js).
    const [exiting, setExiting] = (0, useState)(null);
    // Drawn again in a newly chosen accent while open; the rest of the store follows once it is left.
    useActiveTheme();
    (0, useEffect)(() => () => commitTheme(), []);
    // A closed dialog gives focus back to the row it came from.
    const closed = (key) => focusLater(key);
    const cards = {
      companion: [/* @__PURE__ */ (0, jsx)(CompanionCard, { onChoosePin: setPinMode }, "companion")],
      // glibren.48: the homebrew-only edition has no Feeds page, so its Homebrew card goes under Downloads.
      downloads: [/* @__PURE__ */ (0, jsx)(DownloadsCard, { onPhonePin: setPhonePinMode }, "downloads"), ...HOMEBREW_ONLY ? [jsx(HomebrewCard, {}, "homebrew")] : []],
      feeds: [/* @__PURE__ */ (0, jsx)(FeedsCard, { onAdd: () => setAdding(true), onAddFile: () => setPickingFile(true), onMirror: setMirrorOf }, "feeds"), jsx(HomebrewCard, {}, "homebrew")],
      debrid: [/* @__PURE__ */ (0, jsx)(DebridCard, { onKey: () => setKeying(true), onAllDebridKey: () => setKeyingAll(true) }, "debrid")],
      torboxLibrary: [jsx(TorBoxLibraryCard, {}, "torboxLibrary")],
      look: [/* @__PURE__ */ (0, jsx)(ThemeCard, {}, "theme"), /* @__PURE__ */ (0, jsx)(LanguageCard, {}, "language"), /* @__PURE__ */ (0, jsx)(FeedbackCard, {}, "feedback"), /* @__PURE__ */ (0, jsx)(ScreenSaverCard, {}, "screenSaver"), jsx(EnergyCard, {}, "energy"), jsx(VideosCard, {}, "videos")],
      guide: [/* @__PURE__ */ (0, jsx)(GuideCard, {}, "guide")],
      about: [/* @__PURE__ */ (0, jsx)(AboutCard, {}, "about"), /* @__PURE__ */ (0, jsx)(NoticeCard, {}, "notice")]
    };
    return /* @__PURE__ */ (0, jsxs)(View, { style: { flex: 1 }, children: [
      /* @__PURE__ */ (0, jsx)(FocusScope, { autoFocus: true, onBack: () => {
        onBack();
        return true;
      }, children: /* @__PURE__ */ (0, jsxs)(View, { style: { flex: 1, flexDirection: "row", gap: 48, paddingHorizontal: 48 }, children: [
        /* @__PURE__ */ (0, jsxs)(View, { style: { width: RAIL, gap: 6, paddingTop: 18 }, children: [
          /* @__PURE__ */ (0, jsxs)(View, { style: { flexDirection: "row", alignItems: "center", gap: 18, marginBottom: 24 }, children: [
            /* @__PURE__ */ (0, jsx)(JLMark, { height: 44 }),
            /* @__PURE__ */ (0, jsxs)(View, { style: { gap: 0 }, children: [
              /* @__PURE__ */ (0, jsx)(Text, { style: text(36, colors.fg, { fontWeight: 700, letterSpacing: 1 }), children: t2("settings.title") }),
              /* @__PURE__ */ (0, jsx)(Text, { style: { fontFamily: "JetBrainsMono-Regular", fontSize: 17, lineHeight: 24, color: colors.subtle }, children: `v${VERSION_LABEL}` })
            ] })
          ] }),
          /* @__PURE__ */ (0, jsx)(FocusScope, { focusKey: "settings:categories", children: CATEGORIES.map((item, index) => /* @__PURE__ */ (0, jsx)(View, {
            focusKey: `settings:cat:${item.id}`,
            autoFocus: item.id === start,
            onFocus: () => setCategory(item.id),
            onPress: () => focusLater("settings:content"),
            style: (state) => [{ position: "relative", height: 64, flexDirection: "row", alignItems: "center", gap: 16, borderRadius: radius.md, paddingHorizontal: 14 }, category === item.id || state.focused ? { backgroundColor: colors.surface2 } : null],
            children: /* @__PURE__ */ (0, jsx)(CategoryFace, { icon: item.icon, label: t2(item.label), selected: category === item.id })
          }, item.id)).concat([
            // MODIFIED (glibren.5): "Exit Jobee'sLair", under the categories and in their scope, so Down from the last one
            // reaches it. Not a category: it shows no cards, and Cross asks first (ui/ExitSheet.jsx).
            jsx(View, { style: { height: 1, marginVertical: 12, marginHorizontal: 14, backgroundColor: colors.line } }, "exit:line"),
            jsx(View, {
              focusKey: "settings:exit",
              onPress: () => setExiting(exitSummary(downloadQueue().snapshot?.() ?? [])),
              style: (state) => [{ position: "relative", height: 64, flexDirection: "row", alignItems: "center", gap: 16, borderRadius: radius.md, paddingHorizontal: 14 }, state.focused ? { backgroundColor: colors.surface2 } : null],
              children: jsx(CategoryFace, { icon: "power", label: t2("settings.exit"), selected: false })
            }, "exit")
          ]) })
        ] }),
        /* @__PURE__ */ (0, jsx)(FocusScope, { focusKey: "settings:content", ends: ["down"], children: /* @__PURE__ */ (0, jsx)(ScrollView, { style: { flex: 1, gap: 32, paddingTop: 18, paddingBottom: 72 }, children: cards[category] }, category) })
      ] }) }),
      adding ? /* @__PURE__ */ (0, jsx)(URLDialog, { title: t2("settings.feeds.add"), detail: t2("settings.feeds.addDetail"), submit: addFeed, onClose: () => {
        setAdding(false);
        closed("settings:feeds:add");
      } }) : null,
      pickingFile ? jsx(FeedFilePicker, { onPick: addLocalFeed, onClose: () => {
        setPickingFile(false);
        closed("settings:feeds:addFile");
      } }) : null,
      mirrorOf ? /* @__PURE__ */ (0, jsx)(URLDialog, { title: t2("settings.feeds.addMirror"), detail: t2("settings.feeds.mirrorDetail"), submit: (value) => addMirror(mirrorOf, value), onClose: () => {
        const url = mirrorOf;
        setMirrorOf(null);
        closed(`settings:feed:${url}`);
      } }) : null,
      keying ? /* @__PURE__ */ (0, jsx)(URLDialog, { title: t2("settings.debrid.keyTitle"), detail: t2("settings.debrid.keyDetail"), initial: "", kind: "key", submit: setTorBoxKey, onClose: () => {
        setKeying(false);
        closed("settings:torbox:key");
      } }) : null,
      keyingAll ? jsx(URLDialog, { title: t2("settings.alldebrid.key"), detail: t2("settings.alldebrid.keyDetail"), initial: "", submit: setAllDebridKey, onClose: () => {
        setKeyingAll(false);
        closed("settings:alldebrid:key");
      } }) : null,
      pinMode ? /* @__PURE__ */ (0, jsx)(PinDialog, { mode: pinMode, onDone: choosePin, onClose: () => {
        const mode = pinMode;
        setPinMode(null);
        closed(mode === "change" ? "settings:pin" : "settings:companion");
      } }) : null,
      exiting ? jsx(ExitSheet, { summary: exiting, onExit: () => leaveApp(), onClose: () => {
        setExiting(null);
        closed("settings:exit");
      } }) : null,
      phonePinMode ? /* @__PURE__ */ (0, jsx)(PinDialog, { mode: phonePinMode, onDone: (pin) => {
        // O mesmo cuidado do PIN do companion: nada de digitos repetidos ou em sequencia.
        const refused = pinProblem(pin);
        if (refused) throw new Error(refused);
        choosePhoneMonitorPin(pin);
      }, onClose: () => {
        setPhonePinMode(null);
        closed("settings:phoneMonitorPin");
      } }) : null
    ] });
  }

export { MemoryRows, SettingsScreen };
