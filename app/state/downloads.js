// ../pub-game-store/native/state/downloads.js
// reconstructed from the esbuild bundle in eboot.bin
// MODIFIED: the queue gets the browser capture on the PS5 (its file links read out of the console's browser).
// MODIFIED: storageRoots and freeBytes read state/drives.js, which keeps the drives and their space off the
// render thread (a drive waking up froze the screen when they were asked for synchronously).
// MODIFIED: the queue's resolver gets the debrid provider (state/debrid.js), for sources sent through TorBox.

import { t } from '../i18n/core.js';
import { getGame } from './catalog.js';
import { remoteCatalog, remoteCatalogOn } from './catalog-remote.js';
import { DATA_DIR } from './data-dir.js';
import { createDownloadQueue } from './download-queue.js';
import { createSourceResolver } from './download-sources.js';
import { debridHandoff, debridResolver, debridSecret, forgetTorBoxCopy } from './debrid.js';
import { createBackgroundDownloads, onBackgroundDownloads, onPauseOnClose, pauseOnCloseSeconds } from './background-downloads.js';
import { onSimultaneousDownloads, setSimultaneousDownloads, simultaneousDownloads } from './simultaneous-downloads.js';
import { onPhoneMonitor, phoneMonitorConfig, setPhoneMonitorAddress, setPhoneMonitorProbe } from './phone-monitor.js';
import { adoptSpeedLimit, onSpeedLimit, onVideoCap, speedLimitNow, videoCapNow } from './speed-limit.js';
import { convertOptions, onConvertOptions } from './convert-options.js';
import { recordCapture } from './capture-hosts.js';
import { libraryRoot, queueLibraryRequest, queueStoreRequest } from './phone-library.js';
import { startRemoteDownload } from '../companion/remote-download.js';
import { onDefaultDrive } from './last-drive.js';
import { createMockDownloadQueue } from './mock-download-queue.js';
import { freeBytes, storageRoots } from './drives.js';
import { createShadowClient, createShadowMountProbe } from './shadowmount.js';
import { createMountMonitor, mountMonitor } from './mount-monitor.js';
import { createPlaytime, playtimeStore } from './playtime.js';
import { parseStamp } from './clock.js';
import { deviceFacts } from './device.js';
import { OLD_TITLE_ID } from './title-migration.js';
import { TITLE_ID } from '../version.js';
import { autoContinueParts } from './auto-continue.js';
import { convertToExfatOn, onConvertToExfat } from './exfat-convert.js';
import { ps5PkgWarningOn } from './ps5-pkg-warning.js';
import { online } from './online.js';
import { Archives, BrowserCapture, DeviceInfo, DownloadFormats, Downloads, FileSystem, Http, Linking, Notifications, Packages, Payloads, Platform, Power } from '@ps5-react/core';

  var instance;
  var background = null;
  // Jobee'sLair's own launches (this version's title ID, and the one 0.4.0 and Overdrive use) are not games played.
  var OWN_TITLES = [TITLE_ID, OLD_TITLE_ID];
  var mocked = () => Platform.OS !== "ps5" && FileSystem.exists(`${DATA_DIR}/mock-downloads`);
  var stateDir = Platform.OS === "ps5" ? `/data/ps5-react/${TITLE_ID}/queue` : void 0;
  var utcOffset = (ms) => {
    try {
      return DeviceInfo.utcOffset(ms);
    } catch {
      return 0;
    }
  };
  // Hours played per title, beside the queue (whose ShadowMount log reads feed it).
  var playtime = playtimeStore(() => createPlaytime({ fs: FileSystem, file: `${stateDir ?? DATA_DIR}/playtime.json`, offsetMinutes: utcOffset }));
  // ShadowMount's mounts and each game's health, asked in the background (never behind a download).
  if (Platform.OS === "ps5") mountMonitor(() => createMountMonitor({
    client: createShadowClient({ http: Http, transferring: () => downloadQueue().transferring?.() ?? false, quiet: (reason, work) => downloadQueue().quietNetwork(reason, work) }),
    fs: FileSystem,
    parse: (value) => parseStamp(value, utcOffset(Date.now())),
    onLaunch: (title, at) => !OWN_TITLES.includes(title) && playtime.played(title, at)
  }));
  var downloadQueue = () => instance ?? (instance = mocked() ? createMockDownloadQueue() : createDownloadQueue({
    fs: FileSystem,
    archives: Archives,
    // glibren-bg: com a opcao ligada, o download da fila e do payload de segundo plano (background-downloads.js).
    // glibren: e serve a pagina do celular (phone-monitor.js); uma pausa ou um cancelamento pedidos la voltam a fila.
    downloads: background = createBackgroundDownloads({
      downloads: Downloads,
      http: Http,
      fs: FileSystem,
      payloads: Payloads,
      platform: Platform.OS,
      // glibren.49 (Fase 2): o payload se atualiza sozinho (assinado); ate 3 subidas quando um baixado nao responde.
      selfUpdate: true,
      startTries: 3,
      handoff: debridHandoff,
      secret: debridSecret,
      text: t,
      concurrency: simultaneousDownloads,
      // Pareamento: "pairText" e o aviso do codigo no idioma do jogador ({code} e {name}: o payload troca).
      monitor: () => ({ ...phoneMonitorConfig(), monitorText: t("downloads.background.monitorNotice", { address: "{address}" }), pairText: t("pair.notify", { code: "{code}", name: "{name}" }) }),
      addressSeen: setPhoneMonitorAddress,
      // MODIFIED (glibren.8): com a chave do item da fila (um marcador nao tem caminho) e a acao "resume".
      onRemote: (destination, action, key) => instance?.remoteAction?.(destination, action, key),
      // MODIFIED (glibren.5): a pausa ao fechar o app (0 a 30 s, Configuracoes) vai ao payload no POST /config.
      pauseOnCloseSeconds,
      // MODIFIED (glibren.8): os downloads simultaneos escolhidos na pagina do celular / APK viram os das Configuracoes.
      adoptConcurrency: setSimultaneousDownloads,
      // glibren.13: o limite de velocidade das Configuracoes vale tambem no payload; o escolhido no celular volta para ca.
      // glibren.41 (A1): the payload gets the SAVED limit as speedLimit (kept in its config.json, compared with the one
      // chosen on the phone) and the cap while a video plays apart, as a field that expires by itself.
      speedLimit: speedLimitNow,
      videoCap: videoCapNow,
      adoptSpeedLimit,
      // glibren.18: o disco padrao e a conversao, para o payload comecar sozinho (app fechado) um pedido do celular.
      autoStart: () => ({ root: libraryRoot(storageRoots()), convert: convertToExfatOn() }),
      // pac1: pausa entre conversoes, limite de escrita e gravar em pedacos (Configuracoes > Downloads).
      convertOptions,
      // glibren: um jogo pedido na Biblioteca TorBox do celular entra nesta fila, pelo TorBox, no disco padrao.
      // glibren (item 2): um da Loja completa do celular ("store") vai como o Baixar da ficha do jogo.
      onLibraryRequest: (request) => request?.store ? queueStoreRequest(request, { start: startRemoteDownload, getGame, fetchGame: (id) => remoteCatalogOn() ? remoteCatalog()?.game(id) : null, roots: storageRoots() }) : queueLibraryRequest(request, { queue: downloadQueue(), roots: storageRoots(), getGame })
    }),
    // glibren: quantos downloads rodam ao mesmo tempo (Configuracoes).
    concurrency: simultaneousDownloads,
    http: Http,
    formats: DownloadFormats,
    dataDir: FileSystem.dataDir,
    stateDir,
    platform: Platform.OS,
    notifications: Notifications,
    power: Power,
    linking: Linking,
    browserCapture: Platform.OS === "ps5" ? BrowserCapture : null,
    onCapture: recordCapture,
    sources: createSourceResolver({ http: Http, debrid: debridResolver }),
    packages: Packages,
    releasesOf: (id) => getGame(id)?.releases || [],
    firmware: () => deviceFacts().firmware,
    playtime,
    autoContinue: autoContinueParts,
    // glibren.12: PS5 games become .exfat when their download ends (Settings > Downloads); the payload converts.
    convertExfat: convertToExfatOn,
    // 0.5.4: each launch learned goes to the players' numbers (state/online.js; only with stats on).
    onLaunch: (title, report) => !OWN_TITLES.includes(title) && online().launched({ title, ...report }),
    forgetDebridCopy: forgetTorBoxCopy, // glibren.60: "Apagar do TorBox e baixar de novo"
    // glibren.16: above firmware 11.60 a PS5 package waits on Install, which warns first (Settings > Downloads).
    warnPs5Packages: ps5PkgWarningOn
  }));
  // glibren: a change of simultaneous downloads (Settings) reaches the queue, its engine lanes and the payload at once.
  onSimultaneousDownloads(() => instance?.concurrencyChanged?.());
  // glibren: the phone page's switch or PIN reaches a payload already running; Settings asks it for the address.
  // MODIFIED (glibren.13): ligar a pagina sobe o payload ja (startBackgroundAtLaunch), sem esperar um download.
  onPhoneMonitor(() => {
    background?.refreshConfig?.();
    void startBackgroundAtLaunch();
  });
  setPhoneMonitorProbe(() => background?.refreshConfig?.());
  // glibren.13: ligar a opcao de segundo plano tambem sobe o payload (desligada, startAtLaunch nao faz nada).
  onBackgroundDownloads(() => void startBackgroundAtLaunch());
  // MODIFIED (glibren.5): mudar o tempo da pausa ao fechar o app chega ao payload no ar na hora.
  onPauseOnClose(() => background?.refreshConfig?.());
  // glibren.13: mudar o limite de velocidade (Configuracoes, ou adotado do celular) chega ao payload no ar na hora.
  onSpeedLimit(() => background?.refreshConfig?.());
  // glibren.41 (A1): while a video plays the cap is sent again every 30 s (it expires in the payload after 90 s).
  let videoCapTimer = null;
  onVideoCap((cap) => {
    background?.refreshConfig?.();
    clearInterval(videoCapTimer);
    videoCapTimer = cap > 0 ? setInterval(() => background?.refreshConfig?.(), 30e3) : null;
  });
  // glibren.18: o disco padrao ou a conversao mudados chegam ao payload no ar (pedidos do celular com o app fechado).
  onDefaultDrive(() => background?.refreshConfig?.());
  onConvertToExfat(() => background?.refreshConfig?.());
  // pac1: as opcoes da conversao mudadas chegam ao payload no ar.
  onConvertOptions(() => background?.refreshConfig?.());
  // glibren.13: the background payload up at launch, for the phone page and its TorBox library/store (only on the PS5,
  // with background downloads and the phone page on: background-downloads.js startAtLaunch). Never throws or blocks.
  function startBackgroundAtLaunch() {
    try {
      downloadQueue();
      return background?.startAtLaunch?.() ?? Promise.resolve("");
    } catch (error2) {
      console.log(`[downloads] background payload not started: ${error2?.message}`);
      return Promise.resolve("");
    }
  }
  // 0.5.4: the first time with stats on, the launches known from before go to the players' numbers too.
  function reportPastLaunches() {
    try {
      online().launchedBefore((downloadQueue().launchHistory?.() ?? []).filter((report) => !OWN_TITLES.includes(report.title)));
    } catch (error2) {
      console.log(`[downloads] past launches not kept to send: ${error2?.message}`);
    }
  }
  var shadowMountUp = Platform.OS === "ps5" ? createShadowMountProbe({ http: Http, now: Date.now }) : async () => true;
  function driveName(root2) {
    if (root2 === "/data") return t("drives.internal");
    const mount = /^\/mnt\/(usb|ext)(\d+)$/.exec(root2);
    if (!mount) return t("drives.thisDevice");
    return t(mount[1] === "usb" ? "drives.usb" : "drives.extended", { number: String(Number(mount[2]) + 1) });
  }

export { downloadQueue, driveName, freeBytes, reportPastLaunches, shadowMountUp, startBackgroundAtLaunch, storageRoots };
