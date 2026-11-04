// glibren: "TorBox only" (state/format-filter.js debridOnly, the source list's chip): the links the active debrid
// service (TorBox or AllDebrid) fetches, and the best of them for the download button: one TorBox holds already
// ("TorBox Instant") first, then one whose format the filter wants (an exFAT image, say), then the app's own
// ranking (game/sources.js sourceOrder). Without a key the setting does nothing.

import { activeService, debridSupports, heldByTorBox } from './debrid.js';
import { passes } from './format-filter.js';
import { effectiveFormat, groupOf } from './link-formats.js';
import { isBackport, isDlc, sourceOrder } from '../game/sources.js';

  /** Whether "TorBox only" applies: set, and a debrid key there to use. */
  var debridOnlyOn = (filter) => Boolean(filter?.debridOnly) && Boolean(activeService());
  /** A source the debrid service fetches for the game itself (not an add-on or backport, not found gone). */
  function viaDebridUsable(release) {
    return Boolean(release) && !release.unavailableReason && release.linkHealth?.status !== "dead" && !isDlc(release) && !isBackport(release) && debridSupports(release);
  }
  /** The best of `releases` through the debrid service under `filter`, or -1 when none. */
  function bestDebridIndex(releases, filter, recordOf = () => null) {
    const order = sourceOrder(releases || []).filter((index) => viaDebridUsable(releases[index]));
    if (!order.length) return -1;
    const fits = (index) => {
      const format = effectiveFormat(releases[index], recordOf).format;
      return passes(filter, groupOf(format), format);
    };
    const score = (index) => (heldByTorBox(releases[index]) === true ? 2 : 0) + (fits(index) ? 1 : 0);
    return order.reduce((best, index) => score(index) > score(best) ? index : best, order[0]);
  }

export { bestDebridIndex, debridOnlyOn, viaDebridUsable };
