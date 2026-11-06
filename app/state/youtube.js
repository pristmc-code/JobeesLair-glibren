// "Videos" on a game's page: a homebrew YouTube app opened on a search for the game ("<name> gameplay" or
// "<name> trailer"). The search goes to the app as a file in its own folder, glibren_busca.txt (UTF-8, one line, at
// most 200 bytes), written as .tmp and renamed into place; the app reads it when it opens (and about every second
// while it is open), deletes it and shows the results. The app is then opened by the companion's helper
// (native/companion_daemon.c, request "LNC1"), sent to the payload loader as the closed-app helper is: the helper
// launches it without closing anything and writes how it went to launch.txt in the payload folder.
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

export const launchRequest = (titleId, payloadDir) => `LNC1\n${titleId}\n${payloadDir}\n`;

// The search written and the helper sent: { ok: true, app, text } (launch.txt says how the launch went a moment
// later), or { ok: false, reason: 'missing' | 'name' | 'write' | 'send', error }.
export function openVideos({ fs, payloads, name, kind = "gameplay", payloadDir, helper = HELPER }) {
  const app = findVideoApp(fs);
  if (!app) return { ok: false, reason: "missing", error: "" };
  const text = searchText(name, kind);
  if (!text) return { ok: false, reason: "name", error: "" };
  try {
    writeSearch(fs, app, text);
  } catch (error) {
    return { ok: false, reason: "write", error: error?.message ?? String(error), app };
  }
  if (!payloads) return { ok: false, reason: "send", error: "no payload loader here", app };
  try {
    try {
      fs.mkdir(payloadDir, { recursive: true });
    } catch {
    }
    try {
      fs.remove(`${payloadDir}/${LAUNCH_FILE}`);
    } catch {
    }
    const result = payloads.send(helper, { request: launchRequest(app.titleId, payloadDir), answer: false });
    if (!result?.ok) return { ok: false, reason: "send", error: result?.error ?? "", app };
  } catch (error) {
    return { ok: false, reason: "send", error: error?.message ?? String(error), app };
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
