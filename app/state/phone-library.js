// glibren: os pedidos da Biblioteca TorBox feitos no celular (pagina do payload bg-downloader, porta 34201, POST
// /api/library/add) entram na fila do app como um arquivo do "Procurar no TorBox" (torbox-search.js downloadFile): uma
// fonte TorBox pelo hash do torrent, que o resolvedor da fila pede ao TorBox (createtorrent + requestdl) e que o payload
// baixa em segundo plano como os outros. O disco: o padrao de Configuracoes > Downloads (last-drive.js), como na tela do
// "Procurar no TorBox". Quem le os pedidos no payload e os devolve (forget/refuse) e background-downloads.js.

import { defaultDrive, startingDrive } from './last-drive.js';
import { downloadFile } from './torbox-search.js';
import { brokenFile } from './torbox-library.js';
import { formatFromName } from './link-formats.js';

  // O hash de um torrent: 40 hex (v1) ou 32 letras base32.
  var HASH = /^(?:[0-9a-f]{40}|[a-z2-7]{32})$/i;
  var CODE = /^(PPSA|CUSA)\d{5}$/i;

  /** O jogo do pedido: o do catalogo pelo codigo, quando ele o tem; senao um com o titulo e o codigo da lista. */
  function libraryGame(request, getGame) {
    const code = CODE.test(String(request?.code || "")) ? String(request.code).toUpperCase() : "";
    let known = null;
    try {
      known = code && typeof getGame === "function" ? getGame(code) : null;
    } catch {
    }
    if (known?.id) return known;
    const title = String(request?.title || code || "TorBox").slice(0, 200);
    return { id: code || `torbox-${String(request?.hash || "").slice(0, 12).toLowerCase()}`, titleId: code || void 0, title, releases: [] };
  }

  /**
   * A linha do "Procurar no TorBox" que o pedido e, conforme de onde vem o arquivo (files[].via na lista):
   *   - "torrent": o torrent pelo infohash (`hash`), um arquivo dele (pelo nome, que o resolvedor procura) ou o torrent
   *     inteiro como um zip (`whole`, ou sem arquivo escolhido);
   *   - "account": um item ja na conta TorBox (`item` {kind, id} e `fileId`), ou ele inteiro como um zip;
   *   - "webdl": um link do catalogo que o TorBox guarda (`release` = a fonte do jogo no catalogo; `hash` e o MD5 do
   *     link, que so o app conhece): precisa do jogo do catalogo (`game`).
   */
  function libraryFile(request, game) {
    const title = String(request.title || "");
    const size = Math.max(0, Number(request.size) || 0);
    const whole = Boolean(request.whole || !request.file);
    const name = String(request.file || "");
    const via = String(request.via || "torrent");
    // glibren.13: um arquivo de jogo minusculo no TorBox e uma copia quebrada (uma pagina de erro): nao vai para a fila.
    if (!whole && brokenFile({ size, format: formatFromName(name) })) throw new Error(`TorBox has a broken copy of this file (${size} B): it is a web page, not the game. Delete it in TorBox and add it again.`);
    if (via === "account") {
      const kind = request.item?.kind === "webdl" ? "webdl" : "torrent";
      const id = String(request.item?.id ?? "");
      if (!/^\d+$/.test(id)) throw new Error("This TorBox list entry has no account item.");
      if (whole) return { origin: "account", kind, id, fileId: "all", name: title || `torbox-${id}`, size, whole: true, count: 0, ready: true };
      return { origin: "account", kind, id, fileId: String(request.fileId ?? ""), name, size, ready: true };
    }
    if (via === "webdl") {
      const release = (game?.releases || []).find((item) => item?.id === request.release);
      if (!release) throw new Error("This game's link is not in the catalog on this console. Open the game in Jobee'sLair.");
      // glibren.16: um conjunto em partes (o id "set-..." do catalogo): a fila baixa todas as partes pelo TorBox
      // (torbox-search.js releaseFor -> debridSource), como o botao do TorBox da ficha do jogo.
      if (Array.isArray(release.parts) && release.parts.length) {
        if (release.unavailableReason) throw new Error(release.unavailableReason);
        const first = release.parts[0]?.sources?.[0];
        return { origin: "catalog", link: first?.browserUrl || first?.url || "", release, fileId: "parts", name: name || release.label || title, size, host: release.provider || "", parts: release.parts.length };
      }
      return { origin: "catalog", link: release.browserUrl || release.url, release, fileId: request.fileId || 0, name: name || release.filename || title, size: size || release.sizeBytes || 0, host: release.provider || "" };
    }
    const hash = String(request.hash || "").toLowerCase();
    if (!HASH.test(hash)) throw new Error("This TorBox list entry has no torrent hash.");
    const link = `magnet:?xt=urn:btih:${hash}`;
    if (whole) return { origin: "list", link, fileId: "all", name: title || hash, size, title, whole: true, count: 0 };
    // O id do arquivo so separa um arquivo do outro do mesmo torrent (o TorBox e consultado pelo nome).
    const fileId = name.replace(/^.*[\\/]/, "").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(-48) || "file";
    return { origin: "list", link, fileId, name, size, title };
  }

  /**
   * Poe o pedido `request` (como o payload o mostra no GET /jobs: { id, hash, file, whole, via, release, item, fileId,
   * code, platform, title, size }) na fila `queue`: -> o id do job (o mesmo de antes quando ja estava na fila). Lanca o
   * que a fila disser (sem espaco, arquivo ja existe...), que vai ao celular como o motivo.
   */
  function queueLibraryRequest(request, { queue, roots, getGame } = {}) {
    if (!queue || typeof queue.enqueue !== "function") throw new Error("The download queue is not ready.");
    const game = libraryGame(request, getGame);
    const file = libraryFile(request, game);
    return downloadFile(queue, game, file, libraryRoot(roots));
  }
  /**
   * glibren.18: o disco onde um pedido do celular baixa: o padrao das Configuracoes > Downloads, senao o que a tela do
   * "Procurar no TorBox" escolheria. O mesmo vai ao payload ("autoRoot", POST /config), que comeca o pedido sozinho com
   * a Jobee'sLair fechada.
   */
  function libraryRoot(roots) {
    const drives = Array.isArray(roots) && roots.length ? roots : ["/data"];
    const chosen = defaultDrive();
    return chosen && drives.includes(chosen) ? chosen : drives[startingDrive(drives, () => true)] ?? drives[0];
  }

  /**
   * glibren (item 2): um pedido da Loja completa do celular (POST /api/store/add no payload; o GET /jobs o mostra com
   * "library": { store: "<id do jogo>", source, autoStarted }). Vai a fila como o Baixar da ficha (start =
   * companion/remote-download.js startRemoteDownload): o jogo da loja deste console; a fonte que o payload ja comecou
   * (source >= 0, com a Jobee'sLair fechada) e o disco padrao dele, para a fila achar a parcial e acompanhar o job; sem
   * fonte (o marcador), a Jobe escolhe como na ficha. -> o id do job na fila.
   */
  function queueStoreRequest(request, { start, getGame, roots } = {}) {
    if (typeof start !== "function") throw new Error("The download queue is not ready.");
    const id = CODE.test(String(request?.store || "")) ? String(request.store).toUpperCase() : "";
    let game = null;
    try {
      game = id && typeof getGame === "function" ? getGame(id) : null;
    } catch {
    }
    if (!game) throw new Error("This game is not in the store on this console. Open it in Jobee'sLair.");
    const source = Number.isInteger(request.source) && request.source >= 0 ? request.source : null;
    // glibren.55: uma fonte escolhida na /app (marcador com `source`) vai pelo TorBox quando ele aceita (preferDebrid).
    const options = request.autoStarted && source !== null ? { root: libraryRoot(roots) } : source !== null ? { preferDebrid: true } : {};
    return start(game, source, options).id;
  }

export { libraryFile, libraryGame, libraryRoot, queueLibraryRequest, queueStoreRequest };
