// Fase 7: uma configuracao mudada pela pagina do celular (no payload) passa a valer no app na hora, pelo mesmo setter que
// a tela de Configuracoes usa (state/settings-sync.js chama estes quando a chave chega do payload). undefined = a chave
// saiu: volta ao padrao do modulo. Chave fora daqui (hiddenSources, companion, companionAway e as internas) vale na
// proxima abertura do app: o settings.json local ja esta atualizado.
import { Platform } from '@ps5-react/core';
import { setSettingsSource, watchSetting } from './settings-sync.js';
import { PAUSE_CHOICES, payloadSettings, setBackgroundDownloads, setPauseOnCloseSeconds } from './background-downloads.js';
import { setSimultaneousDownloads } from './simultaneous-downloads.js';
import { setSpeedLimit } from './speed-limit.js';
import { setDefaultDrive } from './last-drive.js';
import { setAutoContinueParts } from './auto-continue.js';
import { setConvertToExfat } from './exfat-convert.js';
import { CONVERT_OPTIONS, setConvertOption } from './convert-options.js';
import { setPs5PkgWarning } from './ps5-pkg-warning.js';
import { setPhoneMonitor } from './phone-monitor.js';
import { setTorBoxQuick } from './debrid.js';
import { setOrbitFeed } from './orbit-feed.js';
import { setDarkxexCatalog } from './homebrew-store.js';
import { applyStoreMode } from './store-mode.js';
import { DEFAULT_FORMAT_FILTER, setFormatFilter } from './format-filter.js';
import { chooseLanguage } from '../i18n/index.js';
import { setScreenSaver } from './screen-saver.js';
import { setEnergySaver } from './power.js';
import { setStatusLight } from '../ui/lightBar.js';
import { setNavigationHaptics } from '../ui/haptics.js';
import { setTypingChoice } from './system-keyboard.js';
import { setAutoInstall } from './update.js';
import { setAutoReports } from './bug-report.js';
import { setTubeAutoUpdate, setTubeDownloadCap, setTubeQuality, setTubeSponsorBlock, setTubeSubtitles } from './tube-settings.js';
import { setAutoPlayFirst } from './auto-play-first.js';

  var orTrue = (value) => value !== false;
  var orFalse = (value) => value === true;
  var whole = (value, fallback) => Number.isInteger(value) ? value : fallback;
  // chave -> o que fazer com o valor novo (cada setter confere o valor do jeito dele, como na tela de Configuracoes)
  var APPLY = {
    backgroundDownloads: (value) => setBackgroundDownloads(orTrue(value)),
    pauseOnCloseSeconds: (value) => setPauseOnCloseSeconds(PAUSE_CHOICES.includes(value) ? value : 30),
    simultaneousDownloads: (value) => setSimultaneousDownloads(whole(value, 1)),
    speedLimit: (value) => setSpeedLimit(whole(value, 0)),
    defaultDrive: (value) => setDefaultDrive(typeof value === "string" ? value : null),
    autoContinueParts: (value) => setAutoContinueParts(orTrue(value)),
    convertExfat: (value) => setConvertToExfat(orTrue(value)),
    warnPs5Pkg: (value) => setPs5PkgWarning(orTrue(value)),
    phoneMonitor: (value) => setPhoneMonitor(orTrue(value)),
    torboxQuick: (value) => setTorBoxQuick(orTrue(value)),
    orbitFeed: (value) => setOrbitFeed(orFalse(value)),
    homebrewDarkxex: (value) => setDarkxexCatalog(orTrue(value)),
    storeMode: (value) => applyStoreMode(value === "torbox" ? "torbox" : "full"),
    linkFormats: (value) => setFormatFilter(value ?? DEFAULT_FORMAT_FILTER),
    language: (value) => chooseLanguage(typeof value === "string" ? value : null),
    screenSaver: (value) => setScreenSaver(orTrue(value)),
    energySaver: (value) => setEnergySaver(orFalse(value)),
    statusLight: (value) => setStatusLight(orTrue(value)),
    vibration: (value) => setNavigationHaptics(orTrue(value)),
    typing: (value) => setTypingChoice(value === "keys" ? "keys" : "system"),
    autoInstallUpdates: (value) => setAutoInstall(orFalse(value)),
    autoReports: (value) => typeof value === "boolean" && setAutoReports(value),
    tubeSponsorBlock: (value) => setTubeSponsorBlock(orTrue(value)),
    tubeSubtitles: (value) => setTubeSubtitles(orFalse(value)),
    tubeAutoUpdate: (value) => setTubeAutoUpdate(orTrue(value)),
    tubeQuality: (value) => setTubeQuality(whole(value, 1080)),
    tubeDownloadCap: (value) => setTubeDownloadCap(whole(value, 5)),
    autoPlayFirstVideo: (value) => setAutoPlayFirst(orFalse(value))
  };
  for (const key of Object.keys(CONVERT_OPTIONS)) APPLY[key] = (value) => setConvertOption(key, whole(value, 0));
  var started = false;
  /**
   * Liga as configuracoes ao payload (so no PS5): o payload de segundo plano no ar (background-downloads.js) e a fonte;
   * sem ele, ou com um antigo, fica tudo no settings.json local, como antes.
   */
  function startSettingsSync() {
    if (started) return;
    started = true;
    for (const [key, apply] of Object.entries(APPLY)) watchSetting(key, apply);
    if (Platform.OS !== "ps5") return;
    const settings = () => payloadSettings();
    void setSettingsSource({
      health: async () => await settings()?.health() ?? null,
      get: async () => await settings()?.get() ?? null,
      post: async (body) => await settings()?.post(body) ?? null
    });
  }

export { APPLY as SETTINGS_APPLY, startSettingsSync };
