// Downloads em segundo plano: o download continua quando a Jobee'sLair fecha (o jogador abre um jogo).
//
// Quem baixa e o payload bg-downloader.elf (app/native/bg_downloader.c), enviado ao elfldr (127.0.0.1:9021)
// por Payloads.send, como o companion. Ele fica vivo depois que o app fecha e fala so em 127.0.0.1:34200, com o
// token que ele mesmo grava em /data/JobeesLair/bg/token (lido aqui pelo FileSystem do app).
//
// Por que o app entrega o download ao payload JA NO INICIO (e nao "ao sair"): o ps5-react nao avisa o JS quando
// o app vai fechar; com outro app na frente o processo fica suspenso (o JS para) e, quando um jogo abre, o
// sistema mata o app. Nao ha um momento confiavel para entregar. Entao, com a opcao ligada (padrao), cada
// download da fila nasce no payload e o app so acompanha: nunca os dois baixam o mesmo arquivo.
//
// Este modulo embrulha o Downloads do ps5-react (createBackgroundDownloads): a fila (download-queue.js) chama
// downloads.enqueue() como sempre e recebe uma tarefa com a mesma interface (subscribe, done, cancel,
// snapshot). Por baixo, a tarefa e do payload; se ele nao subir, ou a opcao estiver desligada, ou o download
// nao couber (pecas, a atualizacao do proprio app), e o motor nativo, como antes.
// Espelhos (mirrors: o mesmo arquivo em outros links, download-mirrors.js): o payload baixa so do link principal,
// para o download continuar com o app fechado. As opcoes guardadas mantem os espelhos, entao, se o download voltar
// ao motor do app ("Baixar pelo app", payload que some), ele volta a usa-los. Com a opcao desligada, o app usa os
// espelhos desde o inicio, como antes.
// A parcial (.part/.resume/.complete) tem o mesmo formato nos dois, entao:
//   - "Baixar pelo app" (takeOverDownload) libera o job no payload (ele grava o checkpoint e esquece o job) e
//     continua no motor nativo de onde parou;
//   - se o payload some, o app continua sozinho do ultimo checkpoint;
//   - ao abrir o app, a fila retoma o job e esta tarefa se liga ao job que o payload ja tinha (pelo destino, ou
//     pelo caminho onde ele publicou a imagem), mostrando o progresso dele; um job que terminou com o app
//     fechado entrega o resultado (concluido, ou o erro, que a fila trata como sempre: link vencido, etc.).
//
// Pontos de contato com o resto do app (para facilitar a juncao com outros ramos):
//   - download-queue.js: o enqueue do arquivo unico leva `background: { title, publishTo, source }`;
//   - downloads.js: a fila recebe createBackgroundDownloads(...) no lugar do Downloads;
//   - debrid.js: debridHandoff(source) (servico + pedido + arquivo do TorBox) e debridSecret(service) (a chave,
//     entregue ao payload so por POST /secret em 127.0.0.1, nunca gravada nem registrada);
//   - Settings.jsx (a opcao) e DownloadCard.jsx (o selo "segundo plano" e o botao "Baixar pelo app").
//   - downloads simultaneos (state/simultaneous-downloads.js): setConcurrency(n) passa o numero ao motor nativo
//     (Downloads.setConcurrency) e ao payload (POST /config), que entao baixa ate n jobs ao mesmo tempo.
//   - glibren.5: a opcao "Pausa ao fechar o app" (0 a 30 s, abaixo) vai junto no POST /config; o botao "Sair"
//     (state/exit-app.js) avisa o payload por POST /bye (sayByeToPayload) antes de fechar o app.
//   - MODIFIED (glibren.8): os downloads simultaneos tambem mudam pela pagina do celular / APK Jobe Controle (POST
//     /api/config no payload). O payload diz quem escolheu ("concurrencyBy": "remote") e um "concurrencyStamp" no /health
//     e no /jobs; o app adota o numero do celular (adoptConcurrency -> Configuracoes) uma vez por stamp, antes de mandar
//     o seu, e nao o sobrescreve. As conexoes por download escolhidas no celular ficam no payload (connectionsSet), que
//     as aplica ao job do mesmo item da fila (a "key", que agora vai tambem no POST /jobs).
//   - glibren.13: o limite de velocidade (state/speed-limit.js, MB/s) vai junto no POST /config ("speedLimit"; o payload
//     segura a soma de todos os jobs e conexoes, ao vivo) e o escolhido na pagina do celular volta do mesmo jeito que os
//     downloads simultaneos ("speedLimitBy": "remote" + "speedLimitStamp" -> adoptSpeedLimit -> Configuracoes).
//   - glibren.12: a conversao para .exfat (download-queue.js queueConversion) roda no payload: convert(request) manda
//     POST /convert e acompanha GET /convert (progresso, fim, erro com codigo); cancel() manda /convert/<id>/cancel. A
//     mesma chave (o id do item da fila) de novo acompanha a que ja existe (o app reabriu com ela em andamento).
//   - glibren: a Biblioteca TorBox na pagina do celular (POST /api/library/add no payload) deixa pedidos no payload
//     (marcadores "waiting-app" com "library" no GET /jobs). Com o app aberto, a cada requestsMs, cada pedido vai a fila
//     (onLibraryRequest -> phone-library.js) e sai do payload (forget); se a fila recusar, o motivo volta (refuse).

import { useEffect, useState } from 'react';
import { loadList, saveList } from './saved.js';
import { originOf } from './link-formats.js';
import { noteConversionWait, setBackupSource, setConversionSource } from './payload-conversions.js';
import { setCrashSource } from './crash-notice.js';
import { setOrbitSource } from './orbit-feed.js';
import { setLibraryPayload } from './torbox-library-payload.js';
import { setDiagnosticsSource } from './diagnostics.js';
import { setJobeSource } from './jobe-remote.js';
import { setPayloadSelfSource } from './payload-self.js';
import { setPairingSource } from './device-pairing.js';
import { setConsoleFirmware } from './device.js';

  var SETTINGS = "settings.json";
  var ELF = "/app0/bg-downloader.elf";
  var STATE_DIR = "/data/JobeesLair/bg";
  var PORT = 34200;
  // glibren.13: a versao do protocolo do bg-downloader.elf deste app (BG_API em app/native/bg_downloader.c, no /health).
  // glibren.20: 16, a lista Orbit Store (GET/POST /orbit).
  // glibren.21: 17, RAR cifrado pelo rar-extract.elf do app (o payload da glibren.20 nao abre).
  // glibren.22: 18, a tela Pasta BACKUP do app (GET /backup, POST /backup/convert, /backup/convert-all, /backup/delete,
  // GET /log); e o antigo e trocado mesmo ocupado (ver ensurePayloadNow).
  // glibren.23: 19, TorBox como o Orbit Store (procura o link na conta antes de criar; um createwebdownload a cada 61 s).
  // glibren.25: 20, Converter responde fila/posicao/ja convertido; a lista Orbit grava "busy" ao baixar.
  // glibren.26: 21, a lista Orbit regravada enxuta (ORBIT_CONV) e a conta TorBox em paginas.
  // glibren.27: 22, a lista Orbit com os codigos que o app ja conhece (POST /orbit "known"): o jogo conhecido vai so com
  // os links.
  // glibren.31: 23, a troca de app (POST /switch): o app de videos abre depois que a Jobe fecha, e volta por ela.
  // pac1: 24, a pausa entre conversoes e o limite de escrita da conversao (POST /config "convertPauseSeconds",
  // "convertWriteLimit"; GET /convert "waitSeconds") e a queda da sessao anterior (GET /crash, last-crash.json).
  // glibren.38: 27, a rede da Biblioteca TorBox (GET/POST /library/build).
  // glibren.43: 28, /switch pelo primeiro plano (kern.msgbuf) e um ritmo so para o TorBox: sobe para o app trocar o
  // payload da .42 que ainda estiver no ar (sem rota nova).
  // glibren.44: 29, account.json da Biblioteca TorBox so com os arquivos que o app usa (+ "codes"): o payload da .43
  // mandava todos os arquivos de cada item da conta e o app segurava ~20 MB (sem rota nova).
  // glibren.44: 30, o diagnostico pelo GitHub (GET /diag, POST /diag/send; /api/diag* na pagina do celular; bg_diag.c).
  // glibren.44: 31, a area Jobe da pagina do celular (GET /jobe, POST /jobe/state; /api/jobe*; bg_jobe.c) e GET /focus.
  // glibren.47: 32, a pagina de testes da Fase 0 (GET /teste).
  // glibren.49: 33, a atualizacao propria assinada do payload (GET/POST /self-update; "minAppApi" e "replace" no /health).
  // glibren.50: 34, o pareamento por aparelho (GET /pair, POST /pair/remove|pin, "pairText" no POST /config; bg_pair.c).
  // glibren.51: 35, as configuracoes no payload (GET/POST /settings; "settings"/"settingsRev"/"settingsStore" no /health).
  // glibren.54: 37, a Fase 4 (a TV pede as paginas da loja: /api/catalog/cards, cartas com metacritic/providers/platforms,
  // arte na pagina inicial; state/catalog-remote.js exige 37 para o caminho remoto).
  var PAYLOAD_API = 37;
  // glibren.49 (Fase 2): a versao do bg-downloader.elf embutido neste app (BG_VERSION em app/native/bg_downloader.c; o
  // tests/bg-self-update.test.mjs confere que sao iguais). Vai em <stateDir>/app.json junto com PAYLOAD_API: o payload
  // so usa um baixado MAIS NOVO que este e compativel com esta API (contrato em app/native/bg_self.c).
  var BG_EMBEDDED_VERSION = "1.37.0";
  var MiB = 1024 * 1024;
  var ENGINE_RANGE = 32 * MiB; // o rangeBytes padrao do motor nativo: a parcial so e a mesma com o mesmo valor

  // ---- A opcao "Continuar baixando quando eu fechar o app" (ligada por padrao) ----
  var enabled = null;
  var settingListeners = /* @__PURE__ */ new Set();
  function backgroundDownloadsOn() {
    if (enabled === null) enabled = loadList(SETTINGS, "settings").backgroundDownloads !== false;
    return enabled;
  }
  function setBackgroundDownloads(on) {
    enabled = Boolean(on);
    saveList(SETTINGS, "settings", { ...loadList(SETTINGS, "settings"), backgroundDownloads: enabled });
    for (const listener of settingListeners) listener(enabled);
  }
  /** glibren.13: chama `listener(ligada)` a cada mudanca da opcao; devolve a funcao que para. */
  function onBackgroundDownloads(listener) {
    settingListeners.add(listener);
    return () => {
      settingListeners.delete(listener);
    };
  }
  function useBackgroundDownloads() {
    const [on, setOn] = useState(backgroundDownloadsOn);
    useEffect(() => {
      settingListeners.add(setOn);
      return () => {
        settingListeners.delete(setOn);
      };
    }, []);
    return on;
  }

  // ---- glibren.5: a opcao "Pausa ao fechar o app" (0 a 30 s, de 5 em 5; padrao 30 s) ----
  // Ao perceber que o app fechou, o payload fica esse tempo sem rede e sem disco (modo quieto: protecao contra um
  // travamento enquanto o PS5 desmonta o app); 0 = sem pausa, ele continua baixando direto. O jogador escolhe o tempo
  // para testar qual evita o travamento. Guardada em settings.json so quando diferente de 30 ("pauseOnCloseSeconds");
  // vai ao payload no POST /config. Um valor fora da lista vale 30; o antigo "pauseOnClose": false (nunca publicado) vale 0.
  var PAUSE_CHOICES = [0, 5, 10, 15, 20, 25, 30];
  var PAUSE_DEFAULT = 30;
  var pauseSeconds = null;
  var pauseListeners = /* @__PURE__ */ new Set();
  function pauseOnCloseSeconds() {
    if (pauseSeconds === null) {
      const saved = loadList(SETTINGS, "settings");
      pauseSeconds = PAUSE_CHOICES.includes(saved.pauseOnCloseSeconds) ? saved.pauseOnCloseSeconds : saved.pauseOnClose === false ? 0 : PAUSE_DEFAULT;
    }
    return pauseSeconds;
  }
  /** Escolhe o tempo (um de PAUSE_CHOICES), grava e avisa quem ouve (o payload no ar recebe na hora). */
  function setPauseOnCloseSeconds(value) {
    if (!PAUSE_CHOICES.includes(value)) return;
    pauseSeconds = value;
    const { pauseOnCloseSeconds: _old, pauseOnClose: _older, ...settings } = loadList(SETTINGS, "settings");
    saveList(SETTINGS, "settings", value === PAUSE_DEFAULT ? settings : { ...settings, pauseOnCloseSeconds: value });
    for (const listener of [...pauseListeners]) listener(value);
  }
  /** Chama `listener(segundos)` a cada mudanca; devolve a funcao que para. */
  function onPauseOnClose(listener) {
    pauseListeners.add(listener);
    return () => {
      pauseListeners.delete(listener);
    };
  }
  function usePauseOnCloseSeconds() {
    const [value, setValue] = useState(pauseOnCloseSeconds);
    useEffect(() => onPauseOnClose(setValue), []);
    return value;
  }
  // O Downloads embrulhado em uso (o da fila), para o botao "Sair" avisar o payload.
  var current = null;
  /** glibren.5: avisa o payload no ar que o app vai fechar (POST /bye). Verdadeiro quando ele respondeu. */
  function sayByeToPayload() {
    return current?.bye ? current.bye() : Promise.resolve(false);
  }
  /**
   * glibren.44: o foco do controle agora, pelo payload (GET /focus, kern.msgbuf): true quando e a Jobee'sLair, false
   * quando e outro app, null quando nao se sabe (sem payload, um antigo, sem a linha no msgbuf).
   */
  async function payloadFocus() {
    try {
      const answer = current?.focus ? await current.focus() : null;
      return answer?.known ? answer.jobe === true ? true : answer.jobe === false ? false : null : null;
    } catch {
      return null;
    }
  }
  /** glibren.31: pede ao payload a troca de app (POST /switch): { ok } ou { ok: false, error } (sem payload configurado). */
  function switchAppVia(to, from) {
    return current?.switchApp ? current.switchApp(to, from) : Promise.resolve({ ok: false, error: "the background payload is not set up" });
  }

  // ---- Quem baixa cada destino agora (para o cartao na tela de downloads) ----
  var owners = /* @__PURE__ */ new Map(); // destino -> { takeOver }
  var ownerListeners = /* @__PURE__ */ new Set();
  function setOwner(destination, entry) {
    if (entry) owners.set(destination, entry);
    else owners.delete(destination);
    for (const listener of ownerListeners) listener();
  }
  /** True enquanto o payload (e nao o app) baixa `destination`. */
  function inBackground(destination) {
    return Boolean(destination && owners.has(destination));
  }
  function useBackgroundOwner(destination) {
    const [owned, setOwned] = useState(() => inBackground(destination));
    useEffect(() => {
      const listener = () => setOwned(inBackground(destination));
      ownerListeners.add(listener);
      listener();
      return () => {
        ownerListeners.delete(listener);
      };
    }, [destination]);
    return owned;
  }
  /** "Baixar pelo app": tira o download do payload e continua no motor do app, aproveitando a parcial. */
  function takeOverDownload(destination) {
    return owners.get(destination)?.takeOver() ?? Promise.resolve(false);
  }

  var wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  var TERMINAL = ["completed", "failed", "cancelled", "needs-app"];
  var baseName = (path) => String(path).slice(String(path).lastIndexOf("/") + 1);

  /**
   * O Downloads do ps5-react com os downloads da fila entregues ao payload. `downloads`: o Downloads do runtime;
   * `http`: Http; `fs`: FileSystem; `payloads`: Payloads; `platform`: Platform.OS; `handoff(source)`: a fonte
   * como o payload a entende ({ provider, kind, id, fileId, zip }); `secret(service)`: a chave do servico
   * debrid; `text(key, vars)`: as mensagens da notificacao no idioma do jogador.
   */
  // glibren.41 (A1): o limite do video vale 90 s no payload e o app renova a cada 30 s enquanto o video toca.
var VIDEO_CAP_TTL_S = 90;
var VIDEO_CAP_RENEW_MS = 30e3;
function createBackgroundDownloads({
    downloads,
    http,
    fs,
    payloads,
    platform,
    handoff = () => null,
    secret = () => "",
    text = (key) => key,
    on = backgroundDownloadsOn,
    log = (line) => console.log(`[background] ${line}`),
    pollMs = 1e3,
    startWaitMs = 8e3,
    port = PORT,
    stateDir = STATE_DIR,
    concurrency = () => 1,
    // glibren: a pagina do celular (phone-monitor.js): o que vai junto no POST /config ({monitor, pinSalt, pinHash,
    // monitorText}, ou null), o IP que o payload informa, e quem trata uma pausa ou um cancelamento pedidos no celular.
    monitor = () => null,
    addressSeen = () => {},
    onRemote = null,
    // glibren: a fila entregue com antecedencia (syncQueue): de quanto em quanto o app avisa que esta aberto (o payload
    // so comeca sozinho o que foi entregue depois de ~15 s sem noticias do app) e a espera antes de mandar a fila.
    heartbeatMs = 5e3,
    queueDelayMs = 300,
    // glibren.5: a pausa ao fechar o app, em segundos (0 a 30), que vai no POST /config; null (o padrao aqui) nao manda o
    // campo, e o payload fica como esta (30 s, se ninguem mudou).
    pauseOnCloseSeconds = () => null,
    // glibren.8: grava nas Configuracoes os downloads simultaneos escolhidos no celular (setSimultaneousDownloads), ou null.
    adoptConcurrency = null,
    // glibren.13: o limite de velocidade das Configuracoes em MB/s (0 = sem limite), que vai no POST /config; null nao
    // manda o campo. adoptSpeedLimit grava nas Configuracoes o escolhido no celular (setSpeedLimit), ou null.
    speedLimit = () => null,
    adoptSpeedLimit = null,
    // glibren.41 (A1): o limite enquanto um video toca (MB/s, 0 = nenhum). Vai no POST /config como "videoCap" com
    // validade ("videoCapSeconds"): o payload nunca grava e volta sozinho ao limite salvo se o app parar de renovar
    // (fechado com o video aberto, ou caiu). Enquanto vale, a configuracao e mandada de novo a cada VIDEO_CAP_RENEW_MS.
    videoCap = () => 0,
    // glibren.18: o disco padrao e a conversao ({ root, convert }) que vao no POST /config ("autoRoot", "autoConvert"):
    // com eles o payload comeca sozinho, com o app fechado, um pedido da Biblioteca TorBox feito no celular. null: nada.
    autoStart = () => null,
    // pac1: as opcoes da conversao ({ convertPauseSeconds, convertWriteLimit, convertSyncMB }, state/convert-options.js)
    // que vao no POST /config; null nao manda nada.
    convertOptions = () => null,
    // glibren.13: a "api" minima do payload no ar; um mais antigo e trocado pelo ELF deste app (ensurePayloadNow).
    payloadApi = PAYLOAD_API,
    // glibren.49 (Fase 2): a versao do ELF embutido (vai no app.json do payload); quantas vezes o app manda o payload
    // quando ninguem responde (um baixado que nao sobe conta uma tentativa no payload e, na 2a, e marcado como ruim: a
    // 3a sobe o anterior ou o embutido); e se pede ao payload, uma vez por abertura, para procurar uma versao nova dele.
    embeddedVersion = BG_EMBEDDED_VERSION,
    startTries = 1,
    selfUpdate = false,
    // glibren: poe na fila um pedido da Biblioteca TorBox feito no celular ({ id, hash, file, whole, code, platform,
    // title, size }; lanca o motivo quando nao da), ou null; e de quanto em quanto os pedidos sao vistos (0 = so quando
    // adoptRequests() e chamado).
    onLibraryRequest = null,
    requestsMs = 5e3
  }) {
    const base = `http://127.0.0.1:${port}`;
    let secretsFor = null; // pid do payload que ja recebeu a chave
    let configFor = null; // pid + a configuracao que o payload ja recebeu (downloads simultaneos, pagina do celular)
    let videoCapSent = false; // glibren.41 (A1): o payload recebeu um limite de video (falta mandar o 0 que o tira)
    const readToken = () => {
      try {
        const value = String(fs.readFile(`${stateDir}/token`) ?? "").trim();
        return /^[0-9a-f]{64}$/.test(value) ? value : "";
      } catch {
        return "";
      }
    };
    async function call(token, method, path, body) {
      const response = await http.request(`${base}${path}`, {
        method,
        headers: body === void 0 ? { "X-Jobe-Token": token } : { "X-Jobe-Token": token, "Content-Type": "application/json" },
        body: body === void 0 ? void 0 : JSON.stringify(body),
        maxBytes: 1024 * 1024
      });
      let data = {};
      try {
        data = await response.json();
      } catch {
      }
      return { status: response.status, data: data ?? {} };
    }
    // glibren.8: o payload diz que os downloads simultaneos foram escolhidos no celular: o app passa a usar esse numero
    // (uma vez por stamp; se o jogador mudar no app depois, o payload volta a "app" e nada e adotado).
    let adoptedStamp = null;
    let adoptedSpeedStamp = null;
    function adoptRemote(data) {
      adoptRemoteSpeed(data);
      if (typeof adoptConcurrency !== "function" || data?.concurrencyBy !== "remote") return;
      const count = data.concurrency;
      if (!Number.isInteger(count) || count < 1 || count > 4 || adoptedStamp === data.concurrencyStamp) return;
      adoptedStamp = data.concurrencyStamp;
      if (count === concurrency()) return;
      log(`simultaneous downloads set on the phone: ${count} (was ${concurrency()})`);
      try {
        adoptConcurrency(count);
      } catch (problem) {
        log(`simultaneous downloads from the phone not kept: ${problem?.message ?? problem}`);
      }
    }
    // glibren.13: o limite de velocidade escolhido no celular, do mesmo jeito (uma vez por stamp).
    function adoptRemoteSpeed(data) {
      if (typeof adoptSpeedLimit !== "function" || data?.speedLimitBy !== "remote") return;
      const limit = data.speedLimit;
      if (!Number.isInteger(limit) || limit < 0 || adoptedSpeedStamp === data.speedLimitStamp) return;
      adoptedSpeedStamp = data.speedLimitStamp;
      if (limit === speedLimit()) return;
      log(`download speed limit set on the phone: ${limit} MB/s (was ${speedLimit()})`);
      try {
        adoptSpeedLimit(limit);
      } catch (problem) {
        log(`download speed limit from the phone not kept: ${problem?.message ?? problem}`);
      }
    }
    async function health(token) {
      try {
        const answer = await call(token, "GET", "/health");
        if (answer.status === 200 && answer.data?.ok) adoptRemote(answer.data);
        if (answer.status === 200 && answer.data?.ok && "ip" in answer.data) addressSeen(answer.data.ip);
        // glibren.54: o firmware de verdade, lido do kernel pelo payload (o do processo do app pode vir fingido)
        if (answer.status === 200 && answer.data?.ok && setConsoleFirmware(answer.data.firmware)) log(`console firmware ${answer.data.firmware} (from the payload)`);
        return answer.status === 200 && answer.data?.ok ? answer.data : null;
      } catch {
        return null;
      }
    }
    // O payload no ar: o token dele, ou "" (sem payload: o app baixa como antes).
    // glibren.13: uma subida por vez: quem chama enquanto outra esta em andamento (a abertura do app e a fila ao mesmo
    // tempo) espera a mesma, e o ELF nunca vai duas vezes.
    let ensuring = null;
    function ensurePayload() {
      if (!ensuring) ensuring = ensurePayloadNow().finally(() => {
        ensuring = null;
      });
      return ensuring;
    }
    // glibren.13: o payload no ar pode ser de uma versao anterior do app (ele nao sai sozinho: continua rodando depois
    // de o app ser atualizado, ate o PS5 reiniciar) e nao ter o que este app usa (o limite de velocidade). O /health diz
    // a "api" dele; menor que PAYLOAD_API (ou sem ela), o app manda o ELF novo, que pede ao antigo para sair (ele grava
    // os checkpoints e a fila) e continua a fila de onde parou. So quando o antigo nao esta baixando nada: ocupado, ele
    // fica ate a proxima vez que o app precisar do payload sem nada rodando.
    // glibren.49: e nao foi posto de lado ("Voltar ao payload embutido": replace) nem e um baixado de API maior que nao
    // declarou compatibilidade com este app (minAppApi maior que o PAYLOAD_API daqui).
    const upToDate = (state) => Number.isInteger(state?.api) && state.api >= payloadApi && state.replace !== true &&
      !(state.api > payloadApi && Number.isInteger(state.minAppApi) && state.minAppApi > payloadApi);
    let staleSaid = null;
    // glibren.20b: o rar-extract.elf do app (UnRAR num programa separado) vai para a pasta do payload: com ele o payload
    // descompacta RAR cifrado (os do DLPSGAME), que a libarchive dele nao abre. Uma vez por abertura, so quando mudou.
    let rarStaged = false;
    function stageRarWorker() {
      if (rarStaged || platform !== "ps5" || typeof fs.copyAsync !== "function") return;
      rarStaged = true;
      const from = "/app0/rar-extract.elf", to = `${stateDir}/rar-extract.elf`;
      try {
        const source = fs.stat(from);
        const here = fs.exists(to) ? fs.stat(to) : null;
        if (!source || here && here.size === source.size) return;
        if (here) fs.remove(to);
        if (fs.exists(`${to}.partial`)) fs.remove(`${to}.partial`);
        const task = fs.copyAsync(from, to, { verify: false, resume: false });
        task?.done?.then(() => log("rar-extract.elf handed to the payload"), (problem) => log(`rar-extract.elf not copied: ${problem?.message ?? problem}`));
      } catch (problem) {
        log(`rar-extract.elf not copied: ${problem?.message ?? problem}`);
      }
    }
    // glibren.49 (Fase 2): antes de subir o payload, o app diz a ele a PAYLOAD_API e a versao do embutido (app.json) e
    // deixa uma copia do ELF embutido (embedded.elf), para "Voltar ao payload embutido" funcionar sem o app aberto.
    let embeddedStaged = false;
    function tellPayload() {
      if (platform !== "ps5" || typeof fs.writeFile !== "function") return;
      let previous = null;
      try {
        previous = JSON.parse(String(fs.readFile(`${stateDir}/app.json`) ?? "") || "null");
      } catch {
      }
      try {
        if (previous?.api !== payloadApi || previous?.embedded !== embeddedVersion) {
          fs.mkdir?.(stateDir, { recursive: true });
          fs.writeFile(`${stateDir}/app.json.tmp`, JSON.stringify({ api: payloadApi, embedded: embeddedVersion }), { sync: true });
          fs.rename(`${stateDir}/app.json.tmp`, `${stateDir}/app.json`);
        }
      } catch (problem) {
        log(`app.json not written for the payload: ${problem?.message ?? problem}`);
      }
      if (embeddedStaged || typeof fs.copyAsync !== "function") return;
      embeddedStaged = true;
      const to = `${stateDir}/embedded.elf`;
      try {
        const source = fs.stat(ELF);
        const here = fs.exists(to) ? fs.stat(to) : null;
        if (!source || here && here.size === source.size && previous?.embedded === embeddedVersion) return;
        if (here) fs.remove(to);
        if (fs.exists(`${to}.partial`)) fs.remove(`${to}.partial`);
        const task = fs.copyAsync(ELF, to, { verify: false, resume: false });
        task?.done?.then(() => log("embedded payload copied for the payload's revert"), (problem) => log(`embedded.elf not copied: ${problem?.message ?? problem}`));
      } catch (problem) {
        log(`embedded.elf not copied: ${problem?.message ?? problem}`);
      }
    }
    // glibren.49: uma vez por abertura, com o payload no ar, ele procura a versao nova dele (no maximo a cada 6 h, la).
    let selfAsked = false;
    function askSelfUpdate(token) {
      if (!selfUpdate || selfAsked || !token) return;
      selfAsked = true;
      call(token, "POST", "/self-update", { action: "check" }).then((answer) => {
        if (answer.status === 200) log(`payload ${answer.data?.version ?? "?"} (${answer.data?.source ?? "?"}) looks for a newer version of itself`);
      }, () => {});
    }
    async function ensurePayloadNow() {
      const token = await ensurePayloadOnce();
      askSelfUpdate(token);
      return token;
    }
    async function ensurePayloadOnce() {
      stageRarWorker();
      tellPayload();
      let token = readToken();
      let state = token ? await health(token) : null;
      if (state && upToDate(state)) return token;
      if (state) {
        if (platform !== "ps5" || !payloads) return token;
        // glibren.22: trocado mesmo baixando ou convertendo. Esperar ele ficar ocioso deixava o antigo no ar para sempre
        // com uma fila longa (ou uma conversao que nunca acabava), e o app novo sem o que ele traz. O antigo grava os
        // checkpoints e a fila ao sair; o novo continua os downloads de onde pararam e poe as conversoes de volta na fila.
        // glibren.49: o motivo da troca (antigo, posto de lado ou um baixado incompativel com este app).
        const what = state.replace === true ? "set aside (back to the built-in payload)" : Number.isInteger(state.api) && state.api > payloadApi ? `not meant for this app (api ${state.api}, minAppApi ${state.minAppApi})` : `an older one (api ${state.api ?? "none"})`;
        if (state.running > 0 || state.quiet) log(`payload ${state.pid} is ${what} and busy; it saves where it was and this app's payload carries on`);
        else log(`payload ${state.pid} is ${what}; sending this app's payload in its place`);
      }
      if (platform !== "ps5" || !payloads) return "";
      // glibren.49: ate startTries subidas quando ninguem responde (um baixado que cai na subida: o payload conta as
      // tentativas e, na 2a, marca a versao como ruim; a seguinte sobe o anterior ou o embutido).
      for (let attempt = 1; ; attempt++) {
        const answered = await sendAndWait(state, token);
        if (answered.done || attempt >= startTries) return answered.token;
        log(`payload did not answer; sending it again (${attempt + 1} of ${startTries})`);
      }
    }
    async function sendAndWait(state, token) {
      try {
        const result = payloads.send(ELF, { answer: false });
        if (!result?.ok) {
          log(`payload not sent: ${result?.error ?? "no answer"}`);
          return { done: true, token: state ? token : "" };
        }
      } catch (error) {
        log(`payload not sent: ${error?.message ?? error}`);
        return { done: true, token: state ? token : "" };
      }
      let answered = "";
      for (const until = Date.now() + startWaitMs; Date.now() < until; ) {
        await wait(Math.min(400, startWaitMs));
        token = readToken();
        state = token ? await health(token) : null;
        if (state && upToDate(state)) return { done: true, token };
        if (state) answered = token;
      }
      // O antigo ainda responde (o novo nao subiu): segue com ele, como antes.
      if (answered) {
        log("the new payload did not take over in time; keeping the one running");
        return { done: true, token: answered };
      }
      log("payload did not answer in time; downloading in the app");
      return { done: false, token: "" };
    }
    // glibren.13: uma entrega por servico de cada vez (a abertura do app e a fila podem pedir juntas).
    const handing = /* @__PURE__ */ new Map();
    function handSecret(token, provider) {
      if (!handing.has(provider)) handing.set(provider, handSecretNow(token, provider).finally(() => handing.delete(provider)));
      return handing.get(provider);
    }
    async function handSecretNow(token, provider) {
      if (provider !== "torbox" && provider !== "alldebrid") return;
      const state = await health(token);
      if (!state || secretsFor === `${state.pid}:${provider}`) return;
      const key = secret(provider);
      if (!key) return;
      const answer = await call(token, "POST", "/secret", { service: provider, key });
      if (answer.status === 200) secretsFor = `${state.pid}:${provider}`;
    }
    // O payload baixa ate `concurrency()` jobs ao mesmo tempo, e serve a pagina do celular como `monitor()` diz: a
    // configuracao vai a cada payload novo (pid) e a cada mudanca.
    // MODIFIED (glibren.8): pergunta antes (health adota o numero escolhido no celular) e so depois monta o que manda.
    async function syncConcurrency(token) {
      if (!token) return;
      const state = await health(token);
      const count = concurrency();
      const pause = pauseOnCloseSeconds();
      const cap = speedLimit(); // glibren.13
      const auto = autoStart(); // glibren.18
      const autoFields = auto && typeof auto.root === "string" && /^\/[^\u0000\\]*[^/]$/.test(auto.root) && !auto.root.split("/").includes("..") ? { autoRoot: auto.root, autoConvert: auto.convert !== false } : {};
      // pac1: so os campos validos das opcoes da conversao.
      const conv = convertOptions() ?? {};
      const convFields = Object.fromEntries(["convertPauseSeconds", "convertWriteLimit", "convertSyncMB"].filter((key) => Number.isInteger(conv[key]) && conv[key] >= 0).map((key) => [key, conv[key]]));
      const video = videoCap() | 0;
      // o campo do video so vai quando ha limite, e uma vez com 0 para tira-lo (videoCapSent); sem video, o corpo e o de antes
      const videoFields = video > 0 ? { videoCap: video, videoCapSeconds: VIDEO_CAP_TTL_S } : videoCapSent ? { videoCap: 0 } : {};
      const body = { concurrency: count, ...Number.isInteger(pause) ? { pauseOnCloseSeconds: pause } : {}, ...Number.isInteger(cap) && cap >= 0 ? { speedLimit: cap } : {}, ...autoFields, ...convFields, ...monitor() ?? {}, ...videoFields };
      // com o limite do video ligado, a mesma configuracao vale de novo a cada renovacao (a validade e contada no payload)
      const key = `${state?.pid}:${JSON.stringify(body)}${video > 0 ? `:${Math.floor(Date.now() / VIDEO_CAP_RENEW_MS)}` : ""}`;
      if (!state || configFor === key) return;
      const answer = await call(token, "POST", "/config", body);
      if (answer.status === 200) {
        configFor = key;
        videoCapSent = video > 0;
      }
      else log(`payload did not take its configuration (${count} simultaneous downloads; HTTP ${answer.status})`);
    }
    const eligible = (options) => platform === "ps5" && on() && options.background && typeof options.url === "string" &&
      /^https?:\/\//.test(options.url) && options.destination && !options.pieces && !options.unlimited;
    // O job como o payload o recebe (POST /jobs, ou um item de POST /queue).
    // glibren.12: so os campos de origem que o payload aceita (host, format, parts), ja validados.
    function originFields(origin) {
      const out = {};
      if (typeof origin?.host === "string" && /^[a-z0-9.-]{1,64}$/.test(origin.host)) out.host = origin.host;
      if (typeof origin?.format === "string" && /^[a-z0-9]{1,8}$/.test(origin.format)) out.format = origin.format;
      if (Number.isInteger(origin?.parts) && origin.parts > 1) out.parts = Math.min(origin.parts, 999);
      return out;
    }
    // glibren.12: o sistema ("ps5"/"ps4"), o codigo do jogo e (num marcador) o nome do arquivo, validados.
    function systemFields(meta, withFile) {
      const out = {};
      if (meta?.platform === "ps5" || meta?.platform === "ps4") out.platform = meta.platform;
      if (typeof meta?.code === "string" && /^[A-Z]{4}\d{5}$/.test(meta.code)) out.code = meta.code;
      if (withFile && typeof meta?.file === "string" && meta.file.length <= 128 && !meta.file.startsWith(".") && !/[\u0000-\u001f\u007f/\\]/.test(meta.file)) out.file = meta.file;
      return out;
    }
    function jobBody(options, meta, source) {
      const destination = options.destination;
      const publishTo = meta.publishTo && meta.publishTo !== destination ? meta.publishTo : "";
      const name = meta.title || baseName(destination);
      return {
        // glibren.12: de onde vem (site do download direto) e o formato, para os selos da pagina do celular.
        ...originFields(originOf(meta.source)),
        ...systemFields(meta, false),
        url: options.url,
        destination,
        storageRoot: options.storageRoot || "",
        name,
        sha256: options.sha256 || "",
        expectedBytes: options.expectedBytes || 0,
        rangeBytes: options.rangeBytes || ENGINE_RANGE,
        connections: options.connections || 8,
        rejectHtml: Boolean(options.rejectHtml),
        publishTo,
        source,
        notifyDone: text("downloads.background.notifyDone", { name }),
        notifyFailed: text("downloads.background.notifyFailed", { name }),
        // glibren.8: o item da fila do app, para o payload aplicar as conexoes escolhidas no celular para ele.
        ...typeof meta.key === "string" && /^[^\u0000-\u001f"\\\u007f]{1,127}$/.test(meta.key) ? { key: meta.key } : {}
      };
    }
    // Um job entregue com antecedencia que o app passou a acompanhar: o payload so o comeca com o app aberto assim.
    const follow = (job) => job?.ahead && !job.followed ? call(token0(), "POST", `/jobs/${job.id}/follow`).catch(() => {}) : null;
    const token0 = () => readToken();

    function hybridTask(options, meta) {
      const destination = options.destination;
      const listeners = /* @__PURE__ */ new Set();
      let snapshot = Object.freeze({ id: 0, destination, state: "queued", received: 0, written: 0, total: null, bytesPerSecond: 0, connections: 0, retries: 0, bufferedBytes: 0 });
      let resolve, reject;
      const done = new Promise((ok, fail) => {
        resolve = ok;
        reject = fail;
      });
      done.catch(() => {});
      let mode = "starting", native = null, token = "", jobId = null, cancelled = false, settled = false, failures = 0, timer = null;
      let remoteAsked = false; // a pausa pedida no celular ja foi entregue a fila (onRemote)
      const emit = (next) => {
        snapshot = Object.freeze({ ...next, destination });
        for (const listener of [...listeners]) {
          try {
            listener(snapshot);
          } catch (error) {
            console.error("Download progress listener failed:", error);
          }
        }
      };
      const error = (message, name) => {
        const value = new Error(`Downloads.enqueue ${destination}: ${message}`);
        if (name) value.name = name;
        return value;
      };
      const finish = (ok, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (owners.get(destination)?.task === task) setOwner(destination, null);
        if (ok) resolve(value);
        else reject(value);
        listeners.clear();
      };
      const forget = () => jobId && call(token, "POST", `/jobs/${jobId}/forget`).catch(() => {});
      // Espera o payload largar o arquivo (checkpoint gravado, job esquecido) antes de o app mexer nele.
      async function release() {
        try {
          await call(token, "POST", `/jobs/${jobId}/release`);
          for (let i = 0; i < 150; ++i) {
            const answer = await call(token, "GET", "/jobs");
            if (!answer.data?.jobs?.some((job) => job.id === jobId)) return true;
            await wait(100);
          }
        } catch {
        }
        return false;
      }
      // MODIFIED (glibren.8): a pausa (no app, ou a do celular repetida pela fila) nao libera mais o job: "park" o para
      // com o checkpoint e o deixa "paused" no payload, de volta a fila entregue, para ele continuar na pagina do celular
      // (Pausado, com o progresso) e poder ser retomado de la. Espera ele parar antes de a tarefa terminar. Um payload
      // antigo, sem "park", libera como antes.
      async function park() {
        try {
          const answer = await call(token, "POST", `/jobs/${jobId}/park`);
          if (answer.status === 404 && answer.data?.error === "unknown action") return release();
          if (answer.status !== 200) return false;
          for (let i = 0; i < 150; ++i) {
            const job = (await call(token, "GET", "/jobs")).data?.jobs?.find((item) => item.id === jobId);
            if (!job || !["queued", "connecting", "downloading", "verifying"].includes(job.state)) return true;
            await wait(100);
          }
        } catch {
        }
        return false;
      }
      // glibren.42 (A2): o payload calado pode estar vivo e lento (uma conversao pesada num disco USB) e ainda gravando a
      // parcial: o app so assume o arquivo quando ela parou de crescer por um tempo (pollMs x 20: 20 s no PS5). Um
      // payload que solta o job (release) ou some de vez para de gravar; um vivo e mudo continua, e o app espera.
      const partSize = () => {
        for (const path of [`${destination}.part`, destination]) {
          try {
            const info = fs.stat?.(path);
            if (info && Number.isFinite(info.size)) return `${path}:${info.size}`;
          } catch {
          }
        }
        return "";
      };
      async function stillWriting() {
        const first = partSize();
        for (const until = Date.now() + pollMs * 20; Date.now() < until; ) {
          await wait(pollMs * 2);
          if (settled) return false;
          if (partSize() !== first) return true;
        }
        return false;
      }
      let mutedSaid = false;
      function runNative() {
        mode = "native";
        if (owners.get(destination)?.task === task) setOwner(destination, null);
        native = downloads.enqueue(options);
        native.subscribe((progress) => {
          if (!settled) emit(progress);
        });
        native.done.then((value) => finish(true, value), (value) => finish(false, value));
        if (cancelled) native.cancel();
      }
      const shown = (job) => ({
        id: snapshot.id,
        state: ["connecting", "downloading", "verifying"].includes(job.state) ? job.state : "queued",
        received: job.written || 0,
        written: job.written || 0,
        total: job.total || null,
        bytesPerSecond: job.bytesPerSecond || 0,
        connections: job.connectionsActive || 0,
        retries: job.retries || 0,
        bufferedBytes: 0,
        owner: "payload"
      });
      // O que o payload tem para este destino ao (re)abrir: o resultado de um job que terminou com o app fechado.
      function settle(job) {
        if (job.state === "completed") {
          forget();
          finish(true, { ...shown(job), state: "completed", destination });
          return true;
        }
        if (job.state === "cancelled") {
          forget();
          // Cancelado no celular: a fila cancela o download como se fosse aqui (apaga o que sobrou), sem trocar de fonte.
          if (job.by === "remote" && onRemote) {
            log(`${baseName(destination)}: cancelled on the phone`);
            onRemote(destination, "cancel");
          }
          finish(false, error("cancelled", "AbortError"));
          return true;
        }
        if (job.state === "failed" || job.state === "needs-app") {
          forget();
          finish(false, error(job.error || "download failed"));
          return true;
        }
        return false;
      }
      async function poll() {
        if (settled || mode !== "payload") return;
        let job;
        try {
          const answer = await call(token, "GET", "/jobs");
          if (answer.status !== 200) throw new Error(`HTTP ${answer.status}`);
          job = answer.data.jobs?.find((item) => item.id === jobId);
          failures = 0;
          adoptRemote(answer.data);
        } catch (problem) {
          // O payload sumiu (morto pelo gerenciador de payloads, ou o sistema): o app continua do ultimo checkpoint.
          if (++failures >= 15) {
            if (await stillWriting()) {
              failures = 0;
              if (!mutedSaid) log(`payload not answering (${problem?.message ?? problem}) but still writing ${baseName(destination)}; waiting for it`);
              mutedSaid = true;
              if (!settled && mode === "payload") timer = setTimeout(poll, pollMs);
              return;
            }
            log(`payload stopped answering (${problem?.message ?? problem}) and its file stopped growing; continuing in the app`);
            if (!settled && mode === "payload") runNative();
            return;
          }
          timer = setTimeout(poll, pollMs);
          return;
        }
        if (settled || mode !== "payload") return;
        if (!job) {
          if (cancelled) finish(false, error("cancelled", "AbortError"));
          else runNative();
          return;
        }
        emit(shown(job));
        if (settle(job)) return;
        // Um payload que voltou (e perdeu o "follow" da memoria) espera o app: avisa de novo.
        if (job.ahead && !job.followed) follow(job);
        // Pausado pelo payload (troca de rede, repouso): retoma. Pausado no celular: fica pausado, e a fila do app
        // passa a mostra-lo pausado (onRemote -> pausa -> park: glibren.8, o job fica pausado no payload, com a parcial).
        if (job.state === "paused" && !cancelled && job.by !== "remote") call(token, "POST", `/jobs/${jobId}/resume`).catch(() => {});
        else if (job.state === "paused" && job.by === "remote" && !remoteAsked && onRemote) {
          remoteAsked = true;
          log(`${baseName(destination)}: paused on the phone`);
          onRemote(destination, "pause");
        }
        timer = setTimeout(poll, pollMs);
      }
      async function start() {
        try {
          token = await ensurePayload();
          if (cancelled) return finish(false, error("cancelled", "AbortError"));
          if (!token) return runNative();
          const source = handoff(meta.source) || { provider: "direct" };
          await handSecret(token, source.provider).catch(() => {});
          await syncConcurrency(token).catch(() => {});
          const list = await call(token, "GET", "/jobs");
          const existing = list.data?.jobs?.find((job) => job.destination === destination || job.published && job.published === destination);
          if (existing) {
            jobId = existing.id;
            log(`${baseName(destination)}: following the background job ${jobId} (${existing.state})`);
            if (settle(existing)) return;
            // Entregue com antecedencia (a fila do app): agora e o app que o comeca.
            await follow(existing);
          } else {
            let answer = await call(token, "POST", "/jobs", jobBody(options, meta, source));
            // glibren.41 (J3): 409 de um job que ja terminou mas o payload ainda esta fechando (o trabalhador dele): espera
            // um instante e pede de novo, em vez de seguir o antigo (que ja falhou ou terminou).
            for (let tries = 0; answer.status === 409 && answer.data?.id && tries < 6; tries++) {
              const other = (await call(token, "GET", "/jobs")).data?.jobs?.find((job) => job.id === answer.data.id);
              if (!other || !["completed", "failed", "cancelled"].includes(other.state)) break;
              await wait(500);
              answer = await call(token, "POST", "/jobs", jobBody(options, meta, source));
            }
            if (answer.status === 409 && answer.data?.id) jobId = answer.data.id;
            else if (answer.status === 201 && answer.data?.id) jobId = answer.data.id;
            else {
              log(`payload refused the download (HTTP ${answer.status}: ${answer.data?.error ?? ""}); downloading in the app`);
              return runNative();
            }
            log(`${baseName(destination)}: handed to the background job ${jobId}${options.mirrors?.length ? ` (main link only; the app keeps ${options.mirrors.length} mirror(s) for a take-over)` : ""}`);
          }
          if (cancelled) {
            await release();
            return finish(false, error("cancelled", "AbortError"));
          }
          mode = "payload";
          setOwner(destination, { task, takeOver });
          poll();
        } catch (problem) {
          log(`background download not started (${problem?.message ?? problem}); downloading in the app`);
          if (settled) return;
          if (jobId) await release();
          if (cancelled) finish(false, error("cancelled", "AbortError"));
          else runNative();
        }
      }
      async function takeOver() {
        if (mode !== "payload" || settled) return false;
        mode = "handing";
        clearTimeout(timer);
        setOwner(destination, null);
        log(`${baseName(destination)}: taking the download back from the background job ${jobId}`);
        const released = await release();
        // glibren.42 (A2): sem a resposta do payload, o arquivo so e assumido se parou de crescer; senao o payload segue com
        // ele (dois escritores na mesma parcial estragariam o arquivo sem que o tamanho acusasse).
        if (!released && !cancelled && await stillWriting()) {
          log("the background job did not let go and is still writing; it keeps the download");
          if (settled) return false;
          mode = "payload";
          setOwner(destination, { task, takeOver });
          poll();
          return false;
        }
        if (!released) log("the background job did not let go in time and its file stopped growing; continuing in the app");
        if (cancelled) finish(false, error("cancelled", "AbortError"));
        else runNative();
        return true;
      }
      const task = Object.freeze({
        get id() {
          return snapshot.id;
        },
        done,
        cancel() {
          if (settled || cancelled) return;
          cancelled = true;
          if (mode === "native") native?.cancel();
          else if (mode === "payload") {
            mode = "handing";
            clearTimeout(timer);
            release().finally(() => finish(false, error("cancelled", "AbortError")));
          }
        },
        // MODIFIED (glibren.8): pausar (download-queue.js pauseJob): no payload, park (o job fica pausado la); no motor
        // do app, ou ainda comecando, e o cancel de antes.
        pause() {
          if (settled || cancelled) return;
          if (mode !== "payload") return task.cancel();
          cancelled = true;
          mode = "handing";
          clearTimeout(timer);
          park().finally(() => finish(false, error("paused", "AbortError")));
        },
        get snapshot() {
          return snapshot;
        },
        subscribe(listener) {
          if (typeof listener !== "function") throw new TypeError("Downloads.subscribe: expected a function");
          listener(snapshot);
          if (!settled) listeners.add(listener);
          return () => listeners.delete(listener);
        }
      });
      start();
      return task;
    }

    const wrapper = Object.create(downloads);
    wrapper.enqueue = (request) => {
      const { background, ...options } = request ?? {};
      if (!eligible({ ...options, background })) return downloads.enqueue(options);
      return hybridTask(options, background);
    };
    wrapper.setRateLimit = (bytesPerSecond) => downloads.setRateLimit(bytesPerSecond);
    // Downloads simultaneos: as faixas do motor nativo agora, e o payload se estiver no ar (senao, ao subir).
    wrapper.setConcurrency = (count) => {
      let lanes = 1;
      try {
        if (typeof downloads.setConcurrency === "function") lanes = downloads.setConcurrency(count);
      } catch (error) {
        log(`engine lanes not set: ${error?.message ?? error}`);
      }
      syncConcurrency(readToken()).catch(() => {});
      return lanes;
    };
    // glibren: a pagina do celular mudou (ligada/desligada, PIN): o payload no ar recebe a configuracao de novo.
    // glibren.5: e a pausa ao fechar o app tambem.
    wrapper.refreshConfig = () => syncConcurrency(readToken()).catch(() => {});
    // glibren.5: o botao "Sair": o app vai fechar. O payload no ar passa a conta-lo como fechado ja (sem esperar ~15 s de
    // silencio) e aplica a pausa conforme a opcao. O batimento para, para nao parecer que o app continua aberto.
    wrapper.bye = async () => {
      if (beat) {
        clearInterval(beat);
        beat = null;
      }
      const token = readToken();
      if (!token) return false;
      try {
        const answer = await call(token, "POST", "/bye");
        if (answer.status !== 200) log(`payload did not take the goodbye (HTTP ${answer.status})`);
        return answer.status === 200;
      } catch (problem) {
        log(`payload not told the app is closing (${problem?.message ?? problem})`);
        return false;
      }
    };
    // glibren.31: a troca de app (POST /switch, bg_downloader.c switch_route): o payload espera `from` fechar, mais ~15 s,
    // e abre `to` (o app de videos; ele usa a mesma rota para voltar). No PS5 sobe o payload se preciso (e troca um
    // antigo, sem a rota). { ok: true } quando ele aceitou; { ok: false, error } senao: o app nao fecha entao.
    wrapper.switchApp = async (to, from) => {
      let token = readToken();
      try {
        if (platform === "ps5" && payloads) token = await ensurePayload();
      } catch (problem) {
        log(`payload not started for the switch (${problem?.message ?? problem})`);
      }
      if (!token) return { ok: false, error: "the background payload is not running" };
      try {
        const answer = await call(token, "POST", "/switch", { to, from });
        if (answer.status === 200 && answer.data?.ok === true) {
          log(`payload switches to ${to} once ${from} closes`);
          return { ok: true };
        }
        const error = answer.status === 404 ? "the background payload is too old (no /switch)" : `HTTP ${answer.status}${answer.data?.error ? `: ${answer.data.error}` : ""}`;
        log(`payload did not take the switch to ${to}: ${error}`);
        return { ok: false, error };
      } catch (problem) {
        log(`payload not asked to switch to ${to} (${problem?.message ?? problem})`);
        return { ok: false, error: problem?.message ?? String(problem) };
      }
    };
    // glibren: a fila inteira com antecedencia. `items` na ordem da fila: { key, name, total, request? }, `request` o
    // pedido de enqueue (com `background`) de um download que o payload baixa sozinho (link direto, ou TorBox ja
    // pedido); sem ele, so um marcador "waiting-app" para o celular. Com a opcao desligada (ou fora do PS5), uma fila
    // ja entregue e retirada. Enquanto ha algo entregue, um batimento a cada heartbeatMs diz que o app esta aberto.
    let queueSent = "", queueTimer = null, beat = null, queueItems = null, queueBusy = null;
    wrapper.queueAhead = () => platform === "ps5" && on();
    wrapper.syncQueue = (items) => {
      queueItems = items;
      clearTimeout(queueTimer);
      queueTimer = setTimeout(() => {
        queueTimer = null;
        queueBusy = (queueBusy || Promise.resolve()).then(sendQueue, sendQueue);
      }, queueDelayMs);
      queueTimer?.unref?.();
      return queueTimer;
    };
    wrapper.flushQueue = async () => {
      clearTimeout(queueTimer);
      queueTimer = null;
      await (queueBusy = (queueBusy || Promise.resolve()).then(sendQueue, sendQueue));
    };
    // MODIFIED (glibren.8): o que o celular pediu (by "remote") para um item da fila entregue que o app nao acompanha
    // (os pausados e os que ainda nao comecaram): retomar um pausado no app, pausar um que o app tem na fila, cancelar.
    // Vai a fila do app (onRemote, com a chave do item) uma vez por pedido; o payload tira a marca quando a fila do app
    // concorda (POST /queue). Visto ao mandar a fila e a cada batimento.
    const phoneAsked = /* @__PURE__ */ new Map(); // chave -> acao ja entregue a fila
    let reconciling = false;
    async function reconcile(token) {
      if (!onRemote || reconciling || !queueItems?.length) return;
      reconciling = true;
      try {
        const answer = await call(token, "GET", "/jobs");
        const jobs = answer.status === 200 ? answer.data?.jobs ?? [] : [];
        for (const item of queueItems) {
          const key = String(item.key);
          const destination = item.request?.destination || "";
          const job = jobs.find((entry) => !entry.followed && (entry.key === key || destination && entry.destination === destination));
          if (!job || job.by !== "remote") {
            phoneAsked.delete(key);
            continue;
          }
          const paused = job.state === "paused";
          const action = job.state === "cancelled" ? "cancel" : paused && !item.paused ? "pause" :
            !paused && item.paused && ["queued", "waiting-app", "connecting", "downloading", "verifying"].includes(job.state) ? "resume" : null;
          if (!action || phoneAsked.get(key) === action) continue;
          phoneAsked.set(key, action);
          log(`${item.name || key}: ${action} asked on the phone`);
          onRemote(destination, action, key);
        }
      } finally {
        reconciling = false;
      }
    }
    async function sendQueue() {
      const ahead = wrapper.queueAhead();
      const list = ahead ? queueItems ?? [] : [];
      const items = list.map((item) => {
        const { background, ...options } = item.request ?? {};
        const source = item.request && eligible({ ...options, background }) ? handoff(background.source) || { provider: "direct" } : null;
        // So o que o payload sabe baixar sozinho e renovar: link direto, ou o TorBox (com o pedido); o resto espera o app.
        const job = source && ["direct", "torbox"].includes(source.provider) ? jobBody(options, background, source) : null;
        // MODIFIED (glibren.8): o pausado no app vai junto (paused, com o progresso), para nao sumir da pagina do celular.
        const paused = item.paused ? { paused: true, written: Math.max(0, Math.round(Number(item.written) || 0)) } : {};
        // glibren.12: a origem tambem no item (um marcador nao tem job): site, formato, partes e o servico debrid.
        const via = item.origin?.via === "torbox" || item.origin?.via === "alldebrid" ? { via: item.origin.via } : {};
        return { key: String(item.key), name: String(item.name || ""), total: Math.max(0, Math.round(Number(item.total) || 0)), ...paused, ...originFields(item.origin), ...via, ...systemFields(item, true), ...item.extracting === true ? { extracting: true } : {}, ...job ? { job } : {} };
      });
      const body = JSON.stringify({ items });
      if (body === queueSent) return;
      // Sem nada para o payload baixar, ele nao e chamado so para mostrar marcadores.
      const token = items.some((item) => item.job) ? await ensurePayload() : readToken();
      if (!token || !await health(token)) {
        if (!items.length) queueSent = body;
        return;
      }
      await reconcile(token).catch(() => {});
      for (const item of items) if (item.job?.source?.provider === "torbox") await handSecret(token, "torbox").catch(() => {});
      await syncConcurrency(token).catch(() => {});
      const answer = await call(token, "POST", "/queue", { items });
      if (answer.status !== 200) {
        log(`payload did not take the queue (HTTP ${answer.status}: ${answer.data?.error ?? ""})`);
        return;
      }
      queueSent = body;
      const handed = items.filter((item) => item.job).length;
      log(`queue handed to the payload: ${handed} to download by itself, ${items.length - handed} waiting for the app`);
      if (items.length && !beat) {
        beat = setInterval(() => {
          const now = readToken();
          if (now) health(now).then((alive) => alive && reconcile(now)).catch(() => {});
        }, heartbeatMs);
        beat?.unref?.();
      } else if (!items.length && beat) {
        clearInterval(beat);
        beat = null;
      }
    }
    // glibren: os pedidos da Biblioteca TorBox feitos no celular. Um por vez (adopting): a fila os recebe na ordem em que
    // foram pedidos; o pedido so sai do payload depois de a fila aceitar (forget) ou recusar (refuse, com o motivo).
    // glibren.18: um pedido que o payload ja comecou sozinho (app fechado; library.autoStarted) e adotado sem baixar de
    // novo: a fila o recebe igual (o mesmo destino: ela acha a parcial e acompanha o job do payload) e o payload fica
    // sabendo (POST /jobs/<id>/adopt); um que ja terminou so e marcado (a conversao ou o .pkg em PS4/ ja estao no disco).
    let adopting = null;
    const autoTried = /* @__PURE__ */ new Set(); // os que a fila recusou nesta sessao: o payload segue com eles
    async function adoptRequests(token) {
      if (typeof onLibraryRequest !== "function" || !token) return 0;
      if (adopting) return adopting;
      adopting = (async () => {
        let taken = 0;
        try {
          const answer = await call(token, "GET", "/jobs");
          const asked = answer.status === 200 ? (answer.data?.jobs ?? []).filter((job) => job?.library && job.placeholder && job.state === "waiting-app") : [];
          for (const job of asked) {
            const request = { ...job.library, title: String(job.name || ""), size: Number(job.library.size || job.total) || 0 };
            let problem = "";
            try {
              await onLibraryRequest(request);
            } catch (error) {
              problem = String(error?.message || error || "not queued").slice(0, 380);
            }
            if (problem) {
              log(`${request.title || job.id}: phone request not queued (${problem})`);
              await call(token, "POST", `/jobs/${job.id}/refuse`, { error: problem }).catch(() => {});
            } else {
              taken += 1;
              log(`${request.title || job.id}: queued from the phone's TorBox library`);
              await call(token, "POST", `/jobs/${job.id}/forget`).catch(() => {});
            }
          }
          const started = answer.status === 200 ? (answer.data?.jobs ?? []).filter((job) => job?.library?.autoStarted && !job.library.autoAdopted && !autoTried.has(job.id) && !["failed", "cancelled"].includes(job.state)) : [];
          for (const job of started) {
            const title = String(job.name || "");
            if (job.state !== "completed") {
              try {
                await onLibraryRequest({ ...job.library, title, size: Number(job.library.size || job.total) || 0 });
              } catch (error) {
                autoTried.add(job.id);
                log(`${title || job.id}: started by the payload with the app closed; not queued here (${String(error?.message || error).slice(0, 200)}); the payload goes on with it`);
                continue;
              }
              taken += 1;
            }
            log(`${title || job.id}: ${job.state === "completed" ? "downloaded" : "being downloaded"} by the payload with the app closed; adopted`);
            await call(token, "POST", `/jobs/${job.id}/adopt`).catch(() => {});
          }
        } catch {
        }
        return taken;
      })().finally(() => {
        adopting = null;
      });
      return adopting;
    }
    wrapper.adoptRequests = () => adoptRequests(readToken());
    // glibren.13: o payload no ar ja na abertura do app (sem esperar um download), para a pagina do celular e a
    // Biblioteca/Loja TorBox dela funcionarem: so no PS5, com a opcao de segundo plano e a pagina do celular ligadas.
    // Sobe (ensurePayload, a mesma subida da fila), manda a configuracao (pagina, PIN, simultaneos, limite), a chave do
    // TorBox se houver, e ve os pedidos do celular; o vigia de pedidos (abaixo) segue a cada requestsMs e conta como o app
    // falando com ele. Nunca trava a abertura: devolve uma promessa que so resolve (o token, ou "") e erros vao ao log.
    wrapper.startAtLaunch = async () => {
      try {
        if (platform !== "ps5" || !on() || monitor()?.monitor !== true) return "";
        const token = await ensurePayload();
        if (!token) return "";
        await syncConcurrency(token).catch(() => {});
        await handSecret(token, "torbox").catch(() => {});
        await adoptRequests(token).catch(() => {});
        log("payload up at launch for the phone page");
        return token;
      } catch (problem) {
        log(`payload not started at launch: ${problem?.message ?? problem}`);
        return "";
      }
    };
    if (typeof onLibraryRequest === "function" && requestsMs > 0 && platform === "ps5") {
      const watch = setInterval(() => {
        const token = readToken();
        if (token) adoptRequests(token).catch(() => {});
      }, requestsMs);
      watch?.unref?.();
    }
    // glibren.12: a conversao para .exfat no payload. Devolve uma tarefa { subscribe, done, cancel, snapshot } como as de
    // download: o progresso ({state, written, total}) a cada pollMs, `done` com a conversao pronta, ou falha com o erro
    // dela ("space: ...", "not-direct: ...": download-queue.js trata pelo codigo). O payload sumindo no meio: o app o manda
    // de novo e pergunta pela mesma chave (ele recomeca a conversao do zero, se a perdeu).
    wrapper.convert = (request) => {
      const listeners = /* @__PURE__ */ new Set();
      let snapshot = { state: "queued", written: 0, total: null };
      let id = null, token = "", cancelled = false;
      const tell = (next) => {
        snapshot = next;
        for (const listener of listeners) listener(snapshot);
      };
      const start = async () => {
        token = await ensurePayload();
        if (!token) throw new Error("unavailable: the background helper (bg-downloader.elf) did not start");
        const answer = await call(token, "POST", "/convert", request);
        if (answer.status !== 200 && answer.status !== 201) throw new Error(`source: the helper refused the conversion (HTTP ${answer.status}: ${answer.data?.error ?? ""})`);
        id = answer.data.id;
        log(`${request.name}: conversion to .exfat ${answer.data.attached ? "followed again" : "handed to the payload"} (${id})`);
      };
      const done = (async () => {
        await start();
        let misses = 0;
        for (; ; ) {
          if (cancelled) call(token, "POST", `/convert/${id}/cancel`).catch(() => {});
          await wait(pollMs);
          let item = null;
          try {
            const answer = await call(token, "GET", "/convert");
            if (answer.status !== 200) throw new Error(`HTTP ${answer.status}`);
            item = (answer.data?.conversions ?? []).find((entry) => entry.id === id) ?? null;
            misses = 0;
          } catch (problem) {
            // O payload caiu ou foi trocado: manda de novo e pergunta pela chave (no maximo ~30 tentativas seguidas).
            if (++misses > 30) throw new Error(`unavailable: the background helper stopped answering (${problem?.message ?? problem})`);
            await start().catch(() => {});
            continue;
          }
          if (!item) {
            await start();
            continue;
          }
          tell({ state: item.state, written: Number(item.written) || 0, total: Number(item.total) || null });
          if (item.state === "done") return item;
          if (item.state === "failed") throw new Error(item.error || "write: the conversion failed");
          if (item.state === "cancelled") throw Object.assign(new Error("Conversion cancelled."), { name: "AbortError" });
        }
      })();
      return {
        subscribe(listener) {
          listeners.add(listener);
          listener(snapshot);
          return () => listeners.delete(listener);
        },
        done,
        snapshot: () => snapshot,
        cancel() {
          cancelled = true;
          if (id && token) call(token, "POST", `/convert/${id}/cancel`).catch(() => {});
        }
      };
    };
    // glibren.16: as conversoes do payload para a tela de Downloads (state/payload-conversions.js), inclusive as que a fila
    // nao pediu. So pergunta a um payload que ja esta no ar (com token): nunca o sobe para isso. null = sem resposta.
    wrapper.conversions = async () => {
      const token = readToken();
      if (!token) return null;
      const answer = await call(token, "GET", "/convert");
      // pac1: a pausa entre conversoes (quanto falta para a proxima comecar), para a tela de Downloads.
      if (answer.status === 200) noteConversionWait(answer.data?.waitSeconds);
      return answer.status === 200 && Array.isArray(answer.data?.conversions) ? answer.data.conversions : null;
    };
    // pac1: a queda da sessao anterior do payload (GET /crash -> last-crash.json), para o aviso ao abrir (crash-notice.js).
    // So pergunta a um payload no ar; null sem payload ou sem queda.
    wrapper.crash = async () => {
      const token = readToken();
      if (!token) return null;
      const answer = await call(token, "GET", "/crash");
      return answer.status === 200 && answer.data?.crash && typeof answer.data.crash === "object" ? answer.data.crash : null;
    };
    setCrashSource(wrapper.crash);
    wrapper.cancelConversion = async (id) => {
      const token = readToken();
      if (token && id) await call(token, "POST", `/convert/${encodeURIComponent(id)}/cancel`);
    };
    wrapper.forgetConversion = async (id) => {
      const token = readToken();
      if (token && id) await call(token, "POST", `/convert/${encodeURIComponent(id)}/forget`);
    };
    setConversionSource({ list: wrapper.conversions, cancel: wrapper.cancelConversion, forget: wrapper.forgetConversion });
    // glibren.20: a lista Orbit Store (state/orbit-feed.js): liga/desliga e pede uma atualizacao no payload, que sobe
    // para isso (so no PS5). Devolve o estado dele, ou null sem payload.
    wrapper.orbit = async (body) => {
      if (platform !== "ps5" || !payloads) return null;
      const token = await ensurePayload();
      if (!token) return null;
      const answer = await call(token, "POST", "/orbit", body);
      if (answer.status !== 200) log(`payload did not take the Orbit Store list setting (HTTP ${answer.status})`);
      return answer.status === 200 ? answer.data : null;
    };
    setOrbitSource(wrapper.orbit);
    // glibren.38: a rede da Biblioteca TorBox (state/torbox-library-payload.js, app/native/bg_library.c). So no PS5 e com um
    // payload de api >= 27; status e cancelar so perguntam a um payload no ar, comecar sobe o payload e entrega a chave
    // do TorBox (POST /secret) antes. null: a montagem fica toda no app.
    const libraryAnswer = (answer) => answer.status === 200 && answer.data?.ok && Number(answer.data.api) >= 27 ? answer.data : null;
    wrapper.library = {
      dir: `${stateDir}/library`,
      async status() {
        const token = platform === "ps5" ? readToken() : "";
        return token ? libraryAnswer(await call(token, "GET", "/library/build")) : null;
      },
      async start(run) {
        if (platform !== "ps5" || !payloads) return null;
        const token = await ensurePayload();
        if (!token) return null;
        await handSecret(token, "torbox").catch(() => {});
        const answer = await call(token, "POST", "/library/build", { run });
        if (answer.status !== 200) log(`payload did not take the TorBox library run (HTTP ${answer.status}: ${answer.data?.error ?? ""})`);
        return libraryAnswer(answer);
      },
      async cancel() {
        const token = platform === "ps5" ? readToken() : "";
        return token ? libraryAnswer(await call(token, "POST", "/library/build/cancel", {})) : null;
      }
    };
    setLibraryPayload(wrapper.library);
    // glibren.22: a tela Pasta BACKUP (state/payload-conversions.js): a lista, converter um ou todos, apagar e o diario.
    // Lista e diario so perguntam a um payload no ar; converter e apagar sobem o payload se preciso (so no PS5).
    const backupToken = async (start) => {
      const token = readToken();
      if (token || !start || platform !== "ps5" || !payloads) return token;
      return await ensurePayload();
    };
    async function backupCall(start, method, path, body) {
      const token = await backupToken(start);
      if (!token) return { status: 0, data: { error: "no payload" } };
      return await call(token, method, path, body);
    }
    wrapper.backup = {
      async list() {
        const answer = await backupCall(false, "GET", "/backup");
        return answer.status === 200 && Array.isArray(answer.data?.games) ? answer.data : null;
      },
      convert: (root, name) => backupCall(true, "POST", "/backup/convert", { root, name }),
      convertAll: () => backupCall(true, "POST", "/backup/convert-all", {}),
      remove: (root, name) => backupCall(true, "POST", "/backup/delete", { root, name }),
      async log() {
        const answer = await backupCall(false, "GET", "/log");
        return answer.status === 200 && typeof answer.data?.text === "string" ? answer.data.text : null;
      }
    };
    setBackupSource(wrapper.backup);
    // glibren.44: o diagnostico pelo GitHub (state/diagnostics.js): enviar sobe o payload se preciso (so no PS5); o
    // estado so pergunta a um payload no ar.
    wrapper.diagnostics = {
      status: () => backupCall(false, "GET", "/diag"),
      send: (body) => backupCall(true, "POST", "/diag/send", body)
    };
    setDiagnosticsSource(wrapper.diagnostics);
    // glibren.44: "Atualizar a Jobe" pela pagina do celular (state/jobe-remote.js): so com um payload no ar (nunca o sobe).
    wrapper.jobe = {
      request: () => backupCall(false, "GET", "/jobe"),
      report: (body) => backupCall(false, "POST", "/jobe/state", body),
      conversions: () => wrapper.conversions()
    };
    setJobeSource(wrapper.jobe);
    // glibren.49 (Fase 2): a versao do payload e a atualizacao propria dele (Configuracoes > Sobre; state/payload-self.js).
    // status/revert so com um payload no ar; check sobe o payload se preciso.
    wrapper.payloadSelf = {
      status: () => backupCall(false, "GET", "/self-update"),
      check: (force = true) => backupCall(true, "POST", "/self-update", { action: "check", force: force === true }),
      revert: () => backupCall(false, "POST", "/self-update", { action: "revert" })
    };
    setPayloadSelfSource(wrapper.payloadSelf);
    // Pareamento por aparelho (state/device-pairing.js, app/native/bg_pair.c): o codigo para a tela da Jobe, os aparelhos
    // pareados e o PIN antigo. So com um payload no ar (nunca o sobe); um payload antigo responde 404 e nada aparece.
    wrapper.pairing = {
      status: () => backupCall(false, "GET", "/pair"),
      remove: (id) => backupCall(false, "POST", "/pair/remove", { id }),
      pin: (on) => backupCall(false, "POST", "/pair/pin", { on: on === true })
    };
    setPairingSource(wrapper.pairing);
    // glibren.44: o foco do controle pelo kern.msgbuf (GET /focus, so leitura): { ok, known, jobe, focus, at }, ou null sem
    // payload no ar (ou um antigo, api < 31). jobe === true: o foco esta na propria Jobe.
    wrapper.focus = async () => {
      const token = readToken();
      if (!token) return null;
      try {
        const answer = await call(token, "GET", "/focus");
        return answer.status === 200 && answer.data?.ok === true && typeof answer.data.known === "boolean" ? answer.data : null;
      } catch {
        return null;
      }
    };
    // Fase 7: as configuracoes no payload (state/settings-sync.js, app/native/bg_settings.c). So com um payload no ar
    // (nunca o sobe); health devolve o /health (com "settings", "settingsRev", "settingsStore") ou null.
    wrapper.settings = {
      health: async () => {
        const token = readToken();
        return token ? await health(token) : null;
      },
      get: () => backupCall(false, "GET", "/settings"),
      post: (body) => backupCall(false, "POST", "/settings", body)
    };
    current = wrapper;
    return wrapper;
  }

  /** Fase 7: as rotas de configuracoes do payload desta abertura (wrapper.settings), ou null antes de a fila existir. */
  var payloadSettings = () => current?.settings ?? null;

export { BG_EMBEDDED_VERSION, payloadFocus, payloadSettings, PAYLOAD_API, backgroundDownloadsOn, createBackgroundDownloads, inBackground, onBackgroundDownloads, onPauseOnClose, PAUSE_CHOICES, pauseOnCloseSeconds, sayByeToPayload, switchAppVia, setBackgroundDownloads, setPauseOnCloseSeconds, takeOverDownload, useBackgroundDownloads, useBackgroundOwner, usePauseOnCloseSeconds };
