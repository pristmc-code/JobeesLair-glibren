// A download started from the phone companion: the same release, drive and fallbacks the game page's
// Download button would pick, through the same queue checks (duplicates, an existing file, the 32-job
// limit, free space). 0.5.4: the phone may pick the source (`source`, its index in the game's list); the others stay
// fallbacks, best first. Also 0.5.4: one a debrid service can take goes through it (`debrid`; the best source does on
// its own when it needs the browser or is a torrent, as on the console), and one that needs the browser is queued
// too: it waits for its page, which the phone opens on the console or on itself (then hands the file link over).
// glibren (item 2): `root` forces the drive (a Loja completa request the payload already started with Jobee'sLair closed:
// the same drive as the payload's, so the queue finds its partial and follows its job).

import { spaceNeeded } from '../game/releases.js';
import { describeSource, fallbacks, preferredRelease } from '../game/sources.js';
import { debridSource, debridSupports, serviceName } from '../state/debrid.js';
import { downloadQueue, freeBytes, storageRoots } from '../state/downloads.js';
import { linkHealth } from '../state/links.js';
import { MARGIN2 } from '../state/space.js';

  // Whether `release` can go through the debrid service set up now (only one the app cannot fetch on its own).
  var throughDebrid = (release) => ["browser", "torrent"].includes(describeSource(release).group) && debridSupports(release);
  // glibren.55: `preferDebrid` (pedido do celular/da /app com uma fonte escolhida): uma fonte que precisa do navegador
  // ou um torrent que o TorBox/AllDebrid aceita vai por ele, como no automatico: quem pediu nao esta na TV para tocar em
  // baixar na pagina do site.
  // .58: a fonte escolhida que esta Jobe nao lista mais (o texto vai ao celular e a /app): sugere escolher outra.
  var SOURCE_GONE = "That source is no longer listed for this game. Choose another source on the game's page.";
  // .58: `release` = o id da fonte escolhida (release.id, vindo do payload): vale ele, nao a posicao `source` (o catalogo
  // do payload e o daqui podem ter os links em outra ordem). Sem o id, a posicao (payload antigo, pagina do celular).
  function pickedIndex(releases, source, release) {
    if (release) {
      const found = releases.findIndex((item) => item?.id === release);
      if (found < 0) throw new Error(SOURCE_GONE);
      return found;
    }
    if (source !== null && !(source >= 0 && source < releases.length)) throw new Error(SOURCE_GONE);
    return source;
  }
  function startRemoteDownload(game, source = null, { debrid = null, root = null, preferDebrid = false, release: releaseId = null } = {}) {
    // With what is known of their links: a dead one is never picked or fallen back to (state/links.js).
    const releases = linkHealth().overlay(Array.isArray(game?.releases) ? game.releases : []);
    if (!releases.length) throw new Error("This game has no download source.");
    source = pickedIndex(releases, source, releaseId);
    const selected = source ?? preferredRelease(releases);
    const picked = releases[selected];
    const { group, host } = describeSource(picked);
    if (group === "unavailable") throw new Error(picked.unavailableReason || "Its sources are unavailable.");
    const viaDebrid = debrid ?? ((source === null || preferDebrid) && throughDebrid(picked));
    if (viaDebrid && !throughDebrid(picked)) throw new Error("No debrid service set up on the console takes this source.");
    if (group === "torrent" && !viaDebrid) throw new Error("A torrent needs TorBox or AllDebrid: add a key under Settings.");
    const release = viaDebrid ? debridSource(picked) : picked;
    const roots = storageRoots();
    if (!roots.length) throw new Error("No drive to download to.");
    // The first drive with room for it, as the game page picks; the queue still checks the space itself.
    const forced = root ? roots.indexOf(root) : -1;
    const index = forced >= 0 ? forced : Math.max(0, roots.findIndex((drive) => {
      const need = spaceNeeded(release, drive);
      return !need || (freeBytes(drive) ?? 0) >= need + MARGIN2;
    }));
    const id = downloadQueue().enqueue(game, release, roots[index], fallbacks(releases, selected));
    return { id, source: host, root: roots[index], debrid: viaDebrid ? serviceName(release.debrid.service) : null, browser: group === "browser" && !viaDebrid };
  }

export { SOURCE_GONE, pickedIndex, startRemoteDownload, throughDebrid };
