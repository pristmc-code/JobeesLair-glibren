// "Videos" on a game's page: a homebrew YouTube app opened on a search for the game ("<name> gameplay" or
// "<name> trailer"). The search goes to the app as a file in its own folder, glibren_busca.txt (UTF-8, one line, at
// most 200 bytes; glibren.31: then a second line, voltar=<TITLEID>, the title the app opens again when the player
// leaves it: the PS5 has one app in front, so opening the video app closes Jobee'sLair; ytps5 and older builds read only
// the first line), written as .tmp and renamed into place; the app reads it when it opens (and about every second
// while it is open), deletes it and shows the results. glibren.31: the PS5 has one app in front, so the app is opened by
// the background payload once Jobee'sLair has closed (POST /switch, see openVideos); the companion helper's "LNC1"
// launch (launchRequest, launchAnswer) is no longer used for it.
// Only the homebrew apps below, in this order; the official YouTube app (PPSA01650-2) never: on consoles that use it
// as their exploit's entry, opening it would run that instead. Plain functions over `fs` and `payloads`, so the
// tests run them under Node (tests/youtube.test.mjs).

// The modified builds that read glibren_busca.txt: https://github.com/pristmc-code/ps5-glibren-releases
export const VIDEO_APPS = Object.freeze([
  Object.freeze({ titleId: "PPSA99350", name: "ytps5" }),
  Object.freeze({ titleId: "PPSA99991", name: "YouTube Max'd" })
]);
export const OFFICIAL_YOUTUBE = Object.freeze(["PPSA01650", "PPSA01651", "PPSA01652"]);
export const SEARCH_FILE = "glibren_busca.txt";
export const MAX_SEARCH_BYTES = 200;
export const LAUNCH_FILE = "launch.txt";
export const HELPER = "/app0/companion-daemon.elf";
export const KINDS = Object.freeze(["gameplay", "trailer"]);
// glibren.31: the second line of SEARCH_FILE (the search stays within MAX_SEARCH_BYTES; this line is apart from it).
export const RETURN_KEY = "voltar";
const TITLE_ID_FORM = /^[A-Z]{4}\d{5}$/;

export const appFolder = (titleId) => `/data/homebrew/${titleId}`;

const bytesOf = (codePoint) => codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4;
// Marks a store name carries ("Game™", "Game®") that only get in a search's way.
const DROPPED = new Set([0x2122, 0x00ae, 0x00a9]);

// The game's name as one clean line: no control characters (new lines included), no lone surrogates, no ™ ® ©,
// spaces collapsed.
export function cleanName(name) {
  let out = "";
  for (const char of String(name ?? "")) {
    const code = char.codePointAt(0);
    if (code < 0x20 || code === 0x7f || (code >= 0x80 && code < 0xa0) || (code >= 0xd800 && code <= 0xdfff) || DROPPED.has(code)) {
      out += " ";
      continue;
    }
    out += char;
  }
  return out.replace(/\s+/g, " ").trim();
}

// `text` cut to at most `max` UTF-8 bytes, never inside a character.
export function fitUtf8(text, max) {
  let out = "", used = 0;
  for (const char of text) {
    const size = bytesOf(char.codePointAt(0));
    if (used + size > max) break;
    out += char;
    used += size;
  }
  return out;
}

export const utf8Length = (text) => {
  let used = 0;
  for (const char of text) used += bytesOf(char.codePointAt(0));
  return used;
};

// glibren.9: a YouTube video's id (11 letters, digits, - and _) from the id itself or from a youtube.com/watch?v=,
// youtu.be/, /embed/, /shorts/ or /live/ address; null for anything else. The phone page (TorBox library) plays these.
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
export function youtubeId(value) {
  const text = typeof value === "string" ? value.trim() : typeof value?.id === "string" ? value.id.trim() : typeof value?.url === "string" ? value.url.trim() : "";
  if (VIDEO_ID.test(text)) return text;
  const match = /^https?:\/\/(?:www\.|m\.)?(?:youtube(?:-nocookie)?\.com\/(?:watch\?(?:[^#]*&)?v=|embed\/|shorts\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{11})(?:[?&#/]|$)/i.exec(text);
  return match ? match[1] : null;
}

// "<name> gameplay" (or trailer), at most MAX_SEARCH_BYTES: a long name is cut, the kind is kept. "" without a name.
export function searchText(name, kind = "gameplay") {
  const suffix = ` ${KINDS.includes(kind) ? kind : "gameplay"}`;
  const clean = cleanName(name);
  if (!clean) return "";
  return `${fitUtf8(clean, MAX_SEARCH_BYTES - utf8Length(suffix)).trim()}${suffix}`;
}

const exists = (fs, path) => {
  try {
    return fs.exists(path);
  } catch {
    return false;
  }
};

// The first of VIDEO_APPS installed (its eboot.bin in /data/homebrew/<id>, or its system entry with that folder
// there), or null. Never the official app, whatever the list holds.
export function findVideoApp(fs, apps = VIDEO_APPS) {
  for (const app of apps) {
    if (OFFICIAL_YOUTUBE.includes(app.titleId)) continue;
    const folder = appFolder(app.titleId);
    if (exists(fs, `${folder}/eboot.bin`) || (exists(fs, `/user/appmeta/${app.titleId}`) && exists(fs, folder))) return { ...app, folder };
  }
  return null;
}

// Puts `text` in the app's folder as SEARCH_FILE: written whole to .tmp first, then renamed, so the app never reads
// half a line. Readable and removable by the app whoever owns it (chmod, best effort). Throws when it can't.
export function writeSearch(fs, app, text) {
  const path = `${app.folder}/${SEARCH_FILE}`;
  const temp = `${path}.tmp`;
  fs.writeFile(temp, text, { sync: true });
  try {
    if (typeof fs.chmod === "function") fs.chmod(temp, 0o666);
  } catch {
  }
  fs.rename(temp, path);
  return path;
}

// What SEARCH_FILE holds: the search, then "voltar=<returnTo>" when returnTo is a title ID (else the search alone).
export function searchFileText(text, returnTo) {
  return typeof returnTo === "string" && TITLE_ID_FORM.test(returnTo) ? `${text}\n${RETURN_KEY}=${returnTo}` : text;
}

// The companion helper's request (native/companion_daemon.c "LNC1"). glibren.31: no longer sent for Videos: a launch
// with Jobee'sLair in front was refused (0x80940011, 0x80940031 in the logs of 11/11/2026) and the console went down
// minutes after one of those tries. Kept for the helper's own test.
export const launchRequest = (titleId, payloadDir) => `LNC1\n${titleId}\n${payloadDir}\n`;

// glibren.31: the switch. The search goes to the app's folder (with voltar=<returnTo> as its second line), the screen
// open now is saved (`beforeSwitch`), the background payload is asked to open the video app once this one has closed
// (`switchApp(to, from)`, POST /switch: it waits for `from` to close, then ~15 s, then launches `to`), and this app
// closes (`leave()`). Resolves to { ok: true, app, text } once leave() was called, or { ok: false, reason:
// 'missing' | 'name' | 'write' | 'switch', error, app? }: nothing closes then, the search file and the saved screen are
// taken back (`afterFailure`), and the sheet says why.
export async function openVideos({ fs, name, kind = "gameplay", returnTo = null, switchApp = null, leave = null, beforeSwitch = null, afterFailure = null }) {
  const app = findVideoApp(fs);
  if (!app) return { ok: false, reason: "missing", error: "" };
  const text = searchText(name, kind);
  if (!text) return { ok: false, reason: "name", error: "" };
  let path;
  try {
    path = writeSearch(fs, app, searchFileText(text, returnTo));
  } catch (error) {
    return { ok: false, reason: "write", error: error?.message ?? String(error), app };
  }
  const undo = (error) => {
    // A search left behind would come up (and send the player back here) the next time the app is opened by hand.
    try {
      fs.remove(path);
    } catch {
    }
    try {
      afterFailure?.();
    } catch {
    }
    return { ok: false, reason: "switch", error, app };
  };
  try {
    beforeSwitch?.(app);
  } catch {
  }
  if (typeof switchApp !== "function") return undo("no background payload here");
  let answer;
  try {
    answer = await switchApp(app.titleId, returnTo);
  } catch (error) {
    return undo(error?.message ?? String(error));
  }
  if (!answer?.ok) return undo(answer?.error ?? "");
  try {
    await leave?.();
  } catch {
  }
  return { ok: true, app, text };
}

// What the helper wrote: { state: 'launched' | 'running' | 'failed' | 'refused' | 'none', code }.
export function launchAnswer(fs, payloadDir) {
  let line = "";
  try {
    const path = `${payloadDir}/${LAUNCH_FILE}`;
    if (fs.exists(path)) line = String(fs.readFile(path)).trim().split("\n")[0];
  } catch {
  }
  const failed = /^failed (0x[0-9a-f]+)$/i.exec(line);
  if (failed) return { state: "failed", code: failed[1] };
  return { state: ["launched", "running", "refused"].includes(line) ? line : "none", code: "" };
}
