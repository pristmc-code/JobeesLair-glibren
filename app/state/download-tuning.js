// How hard the download engine pulls from each host: the most ranges it keeps in flight (`connections`, 1-64) and
// how large each range is (`rangeBytes`), in this one table. The engine's adaptive window (AIMD, ps5-react
// docs/NETWORKING.md) still runs under these numbers: it starts at up to 8 connections, halves on HTTP 429/5xx/408
// or a broken connection, and grows while the host keeps up. A cap here only bounds how far it climbs.
//
// The host is the one the bytes come from: the resolved file link (a debrid service's CDN, a host's download
// server), not the catalog's page. The values below are conservative starting points, not measurements made on a
// console: change them here when a host is seen cutting connections (many retries, 429/503 in the log).
//
// A partial download keeps the range size it started with: the engine's resume checkpoint is tied to it (a
// different size refuses the partial), so `rangeFor` never changes it for a file that already has bytes.

var MiB = 1024 ** 2;

/** What every host not in the table gets: 64 ranges of 16 MiB (what the app always used for a single file). */
var DEFAULT_TUNING = Object.freeze({ connections: 64, rangeBytes: 16 * MiB });

/**
 * Per host, by domain (a subdomain matches too). Only what differs from the default needs to be given.
 * - archive.org: the Internet Archive's download nodes answer 503/429 under many parallel ranges from one address.
 * - mediafire.com, github.com and its objects host: one file is served by one node that throttles long before 64.
 * MODIFIED (glibren.8): the fixed TorBox entry of glibren.7 ({ hosts: ["tb-cdn.cx"], connections: 8 }) and the
 * grouping of its nodes (hostGroup) are gone: with it the downloads got much slower ("the connection limiter broke
 * the downloads"). TorBox is back to the default, and the connections of any download (running or queued) can now
 * be set by hand, live, from the phone page / the Jobe Controle APK (bg_downloader.c, POST /api/jobs/<id>/connections).
 */
var HOST_TUNING = Object.freeze([
  { hosts: ["archive.org"], connections: 8 },
  { hosts: ["mediafire.com"], connections: 16 },
  { hosts: ["github.com", "githubusercontent.com"], connections: 16 }
]);

var hostOf = (url) => {
  const match = /^https?:\/\/([^/?#:]+)/i.exec(String(url || ""));
  return match ? match[1].toLowerCase() : "";
};
var matches = (host, domain) => host === domain || host.endsWith(`.${domain}`);
var clamp = (value, low, high, fallback) => Number.isInteger(value) && value >= low && value <= high ? value : fallback;

/** { connections, rangeBytes } for a download from `url`, from `table` (HOST_TUNING) over `fallback` (DEFAULT_TUNING). */
function tuningFor(url, table = HOST_TUNING, fallback = DEFAULT_TUNING) {
  const host = hostOf(url);
  const entry = host ? table.find((item) => item.hosts.some((domain) => matches(host, domain))) : null;
  return {
    connections: clamp(entry?.connections, 1, 64, fallback.connections),
    rangeBytes: clamp(entry?.rangeBytes, 1 * MiB, 256 * MiB, fallback.rangeBytes)
  };
}

/**
 * The range size for one file: the one it was started with when it already has bytes (`holder.rangeBytes`, saved
 * with the job; `legacy` for a partial an earlier build started, null meaning the engine's own default), else the
 * table's, which is then recorded in `holder` for its resume. `started`: whether a partial of it is on disk.
 * Returns the bytes, or null for the engine's default.
 */
function rangeFor(holder, tuned, started, legacy) {
  if (started && holder.rangeBytes !== void 0) return holder.rangeBytes;
  if (started) return holder.rangeBytes = legacy ?? null;
  return holder.rangeBytes = tuned.rangeBytes;
}

export { DEFAULT_TUNING, HOST_TUNING, hostOf, rangeFor, tuningFor };
