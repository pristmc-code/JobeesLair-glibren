// ../pub-game-store/native/game/releases.js
// reconstructed from the esbuild bundle in eboot.bin

import { t } from '../i18n/core.js';
import { downloadQueue, driveName } from '../state/downloads.js';
import { formatBytes } from '../state/size.js';
import { MARGIN2, stillNeeded } from '../state/space.js';
import { DownloadFormats } from '@ps5-react/core';

  function spaceNeeded(release, root2) {
    if (!release?.sizeBytes) return 0;
    let artifact2;
    try {
      artifact2 = release.parts ? void 0 : DownloadFormats.artifact(release, root2);
    } catch {
      artifact2 = void 0;
    }
    return stillNeeded({ release, artifact: artifact2, total: release.sizeBytes, written: 0 });
  }
  var canDownload = (game) => game.hasDownloads ?? (game.releases || []).some((release) => release.url || release.manifestUrl || release.browserUrl);
  // glibren.76: os links da ficha: os dos catalogos mostrados (game.releases) e, no fim, o de um download deste jogo que ja
  // esta na fila e veio de um catalogo escondido depois (game.allReleases, state/catalog.js): o botao continua com o job.
  function withQueued(game, jobs = null) {
    const shown = game?.releases || [];
    const all = game?.allReleases;
    if (!Array.isArray(all) || all === shown || all.length === shown.length) return shown;
    let list = jobs;
    if (!list) {
      try {
        list = downloadQueue().snapshot();
      } catch {
        list = [];
      }
    }
    const ids = new Set(list.filter((job) => job.gameId === game.id).map((job) => String(job.requestedId ?? job.release?.id ?? "").replace(/~(?:torbox|alldebrid)$/, "")));
    if (!ids.size) return shown;
    const have = new Set(shown.map((release) => release.id));
    const extra = all.filter((release) => ids.has(release.id) && !have.has(release.id));
    return extra.length ? [...shown, ...extra] : shown;
  }
  function spaceAdvice(roots, free, storage, need) {
    const other = roots.findIndex((root2, i) => i !== storage && free[i] >= need + MARGIN2);
    if (other >= 0) return t("download.space.otherDrive", { drive: driveName(roots[other]), size: formatBytes(free[other]) });
    return t("download.space.free", { size: formatBytes(need + MARGIN2 - free[storage]), drive: driveName(roots[storage]) });
  }

export { canDownload, spaceAdvice, spaceNeeded, withQueued };
