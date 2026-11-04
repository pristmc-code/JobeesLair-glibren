// Mirrors: other links to the very same file, handed to the download engine with the one being downloaded, so its
// ranges are spread over several servers (ps5-react docs/NETWORKING.md, `mirrors`: up to 4).
//
// Only links that need nothing resolved are taken: a direct file link (download-sources.js kind "direct"), never a
// host page, a debrid service's, a torrent, a split manifest or one the console's browser must pass. Those need a
// resolution of their own (and a browser one cannot run while a file downloads).
//
// When it is the same file, from the catalog's word:
// - the file being downloaded has a SHA-256: only a link listed with that same SHA-256. The engine accepts a mirror of
//   the right size when a SHA-256 is given and checks the whole file only at the end, so a same-sized but different
//   file would spoil ranges that a retry would keep; an equal checksum rules that out.
// - it has none: a link listed with the same size in bytes and the same file name. The engine then keeps a mirror only
//   when its strong ETag equals the primary's (the same file on the same storage), and drops it otherwise, so a link
//   that only looks the same costs one probe and nothing else.
// A mirror that fails a range is dropped by the engine and the range retried on the primary link.

import { sourceKind, webURL } from './download-sources.js';

var MAX_MIRRORS = 4;
var checksum = (value) => typeof value === "string" && /^[0-9a-f]{64}$/i.test(value) ? value.toLowerCase() : null;
var fileName = (source) => {
  const named = typeof source?.filename === "string" ? source.filename : "";
  if (named) return named.toLowerCase();
  const path = String(source?.url || "").replace(/[?#].*$/, "");
  try {
    return decodeURIComponent(path.slice(path.lastIndexOf("/") + 1)).toLowerCase();
  } catch {
    return path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  }
};
var size = (value) => Number.isSafeInteger(value) && value > 0 ? value : null;

/** The link of `source` when it is a plain direct file link the engine can fetch as it is, else null. */
function directLink(source) {
  if (!source || source.parts || source.debrid || source.manifestUrl || source.browserUrl || source.requiresBrowser || source.unavailableReason) return null;
  try {
    return sourceKind(source) === "direct" ? webURL(source.url).url : null;
  } catch {
    return null;
  }
}

/** Whether `candidate` is, by the catalog's word, the file `primary` names (see the rules above). */
function sameFile(primary, candidate) {
  const sha = checksum(primary.sha256);
  if (sha) return checksum(candidate.sha256) === sha;
  if (checksum(candidate.sha256)) return false;
  const bytes = size(primary.sizeBytes);
  return Boolean(bytes) && size(candidate.sizeBytes) === bytes && Boolean(fileName(primary)) && fileName(primary) === fileName(candidate);
}

/**
 * Up to four mirror links for a download: `primary` the catalog entry being downloaded (a release, or a set part's
 * source), `options` the engine options it resolved to (its url, sha256, expectedBytes, pieces), `candidates` the
 * other catalog entries that may hold the same file (the game's other sources). Returns [] when none qualifies, or
 * when the download cannot take mirrors (a split manifest, a debrid repack whose checksum no listing gives).
 */
function mirrorsFor(primary, options, candidates = []) {
  if (!primary || !options?.url || options.pieces || options.repacked) return [];
  const expected = size(options.expectedBytes);
  const identity = { ...primary, sha256: options.sha256 ?? primary.sha256, sizeBytes: expected ?? primary.sizeBytes };
  const seen = new Set([options.url, primary.url, primary.browserUrl].filter(Boolean));
  const found = [];
  for (const candidate of candidates) {
    if (found.length >= MAX_MIRRORS) break;
    const link = directLink(candidate);
    if (!link || seen.has(link) || !sameFile(identity, candidate)) continue;
    if (expected && size(candidate.sizeBytes) && size(candidate.sizeBytes) !== expected) continue;
    seen.add(link);
    found.push(link);
  }
  return found;
}

export { MAX_MIRRORS, directLink, mirrorsFor, sameFile };
