# Changelog

What changed in each version of Jobee'sLair. Each release on
[GitHub](https://github.com/JVK3R/JobeesLair/releases) carries the full notes, the files and their
SHA-256 checksums.

## Unreleased

- **glibren.65** (fork): glibren full-screen store (`/app`) on the PS5 browser. Download payload 1.37.9.
  - Covers no longer use `loading="lazy"` (the store already decides when to ask for each one): the PS5's WebKit lost
    track of them after scrolling back up and they vanished for good.
  - The store opened without full screen measured its grid as 0 px and showed no games; it now measures again.
  - The store sends its own measurements to the payload every 15 s when they change (`POST /api/teste/gravar`, only
    saves `teste-resultados.txt`), with a new line of what the grid shows right now, so a diagnostic sent from the
    phone carries them.
- **glibren.64** (fork): covers in the glibren full-screen store (`/app`) on the PS5 go straight to the payload.
  Download payload 1.37.8.
  - Sony cover addresses were tried directly first; the console's DNS blocks Sony and the request could hang up to
    8 s before falling back to the payload, so covers already in the phone's cover bank never showed if the list was
    scrolled meanwhile, and vanished when scrolling back. On the PS5 they now come from the payload at once.
- **glibren.63** (fork): covers no longer vanish when scrolling back in the glibren full-screen store (`/app`).
  Download payload 1.37.7.
  - The store's virtual list rebuilds rows that come back into view; each cover started over (Sony address first,
    then the payload, 2 at a time) and a request whose row had left the screen could hold its slot forever. A cover
    already shown now reuses the address that worked (browser cache), a request that left the screen or took over
    15 s frees its slot, and 6 covers are asked of the payload at once.
- **glibren.62** (fork): covers that stopped showing on the PS5 TV app and in the glibren full-screen store.
  Download payload 1.37.6.
  - The payload's phone/app port served 4 connections at once and closed every extra one right away: the store
    (`/app`) and the TV ask for dozens of covers together, so many came back broken. Extra connections now wait their
    turn (up to 4 s) and up to 12 are served at once.
  - TV app image loader: a refused connection to the payload (127.0.0.1:34201) was taken for a DNS block; the address
    it then pinned kept the port ("127.0.0.1:34201:80:...") and every later picture failed with "Malformed option
    provided in a setopt" until the app was reopened. Local addresses are never rerouted now, and a pin keeps the
    host's own port.
- **glibren.61** (fork): the TorBox key kept on the PS5, so the download payload works without opening the Jobe.
  Download payload 1.37.5.
  - The payload keeps the TorBox/AllDebrid key the app hands it (POST /secret) in `/data/JobeesLair/bg/debrid-keys.json`
    (mode 0600, only the key) and reads it back when it starts. After a reboot, new requests from the phone, expired
    TorBox links and the TorBox Library no longer wait for "the Jobe" to open once.
  - Removing or changing the key in the Jobe's Settings reaches the running payload at once: an empty key removes that
    service from the file, and the file is deleted when no key is left. The key never goes to the payload log.
- **glibren.60** (fork): fixes from the first PS5 diagnostics and the cover bank filled by the phone. Download payload 1.37.4; phone app
  JobeControle 0.3-teste.
  - A TorBox download paused in the app before it reached the payload no longer stays "Waiting for the Jobe" when
    resumed with the app closed: it goes to the payload with its link age and the payload asks TorBox for a new link.
  - No DNS / no connection in the middle of a download: the whole job waits (1 s, 2 s, 4 s... 32 s) instead of each
    range retrying alone (13,500 log lines in 10 s after rest mode); after 10 rounds it goes back to the queue. At
    most 20 failure lines per minute per job in the payload log, the rest summed up in one line.
  - A direct link that is gone (404/410, or Archive.org 401/403: a restricted or removed item) fails as "Source
    unavailable: ... choose another source" instead of "Waiting for the Jobe" (Another World).
  - "Delete from TorBox and download again" on the download card (TV) when TorBox holds a broken copy or refuses the
    link: it deletes the item from your TorBox account (the key in Settings) and starts over with a new request.
  - Turning the console off with nothing running no longer shows the crash notice at the next start (only
    interrupted downloads/conversions or a fatal signal in the payload do).
  - Diagnostics: the app sends its versions and the Memory sample to the payload when it opens and every 10 min, so a
    report asked from the phone no longer says `"app": null`; each file is sent again up to 3 times (no answer, 409,
    429, 5xx); the app log goes with the date of its last write (its lines only have the time).
  - Memory meter: logs the 20-minute floor when it rises (memory really held), apart from garbage waiting for the
    collector (the peak alone grew on the Downloads screen without proving a leak).
  - A game image renamed by glibren is followed (same size, where ShadowMount has the title) instead of "is gone" at
    every check; the catalog build log no longer shows "0 ms" times the console clock cannot measure.
  - .7z extraction on several cores: unencrypted .7z with plain LZMA2 folders (7-Zip's default) is extracted by
    7-Zip 26.06's Lzma2DecMt (public domain, `app/native/lzma/`) in up to 7 threads (cores - 1, limited by memory,
    `BGDL_7Z_MEM_MB` 1536), with read-ahead and writing in their own threads, CRC per file and per block, and
    `.7z.001` volumes. Out of memory midway it retries with 1 thread, then libarchive; LZMA/BCJ/AES/encrypted headers
    still go through libarchive. Non-ASCII names inside a .7z are no longer lost. Not tested on the PS5.
  - **Cover bank filled by the phone (NOT tested on a phone, an emulator or the PS5 yet).** JobeControle 0.3-teste
    (`JobeControle.apk`, installs over 0.2 with the same signature): with the app open and on Wi-Fi, it asks the
    payload which covers are missing, downloads them natively over the PHONE's internet (including
    image.api.playstation.com, which the PS5 never contacts and a web page cannot read: no CORS), shrinks them to at
    most 440 px JPEG and sends them to the payload. Up to 300 per round, one every 0.6 s, again after 15 min. Gear >
    "Cover bank": switch (on by default), "Covers: N sent, M missing", "Send now". Off Wi-Fi nothing is downloaded.
  - Payload (`bg_covers_bank.c`): paired-device routes `GET /api/capas/estado`, `GET /api/capas/lista`,
    `POST /api/capas/enviar` (PNG/JPEG/WebP checked by the bytes, catalog ids only, up to 512 KiB),
    `POST /api/capas/falhou` (24 h off), `POST /api/capas/apagar`. Bank in `/data/JobeesLair/capas-banco`, capped at
    192 MiB / 8000 files / 1 GiB free (answers 507 "full"; nothing is deleted by itself). `/app/capa` uses the bank
    first and marks missing covers as "requested" so the phone fetches them first. TV: PS5 covers from
    image.api.playstation.com come from the payload (`/app/capa?u=`, only from disk: bank, icon0, cache); PS4 covers
    unchanged. With an older payload the phone app says so and does nothing.
- **glibren.59** (fork): YouTube player fixes from the PS5 reports of 14/11. Download payload unchanged; built-in
  YouTube service 0.2.3.
  - Seek no longer "breaks" the quality: an error right after a seek, a stall or a decoder error reopens the SAME
    quality at the same position (new decoder), then gets new links, and only then goes down a quality in the same
    format. VP9 never comes in by itself any more (it flickers on the PS5); it stays in the R2 list.
  - Progressive seek: a tap moves 10 s; holding speeds up (10 s -> 30 s -> 1 min -> 2 min), the bar shows the target
    time and the player seeks once, after you let go (taps in a row add up). D-pad left/right and L1/R1.
  - The player never sits still without a message: a stall (20 s without moving) or a video that does not start
    (45 s) is reopened; when nothing works it says why (stalled, server refused, decoder refused...).
  - H.264 hardware decoder (ps5-react): after an error or a seek it resumes only at an IDR and puts the SPS/PPS ahead
    of the first picture. YouTube's older encoder (official trailers) marks many non-IDR I frames as keyframes, and
    the decoder got slices without parameter sets until the next IDR ("video decode failed (h264, sceVideodec2)").
  - Built-in tube-service 0.2.3: the signed-in account plays again (the media check read the TV link before its `n`
    transform and always got 403, "upstream_media"); `account_media_refused` has its own message.
- **glibren.58** (fork): fixes from the real PS5 (downloads and the web /app). Download payload 1.37.3 (`BG_API` stays 37).
  - A download paused in Jobee'sLair, with the app then closed, resumes from `/app` (or the phone page) on the
    payload alone. The app's queue sent the paused item without its request when it would not hand it over (a TorBox
    link older than 2.5 h) and the payload swapped its real, parked job for a "waiting for Jobe" marker that never
    started. Now the payload keeps the job of the same queue item, renews the TorBox link itself and downloads it; when
    the app opens again it takes the finished download as done.
  - `/app`: choosing the source is clear. "Choose the source" sits right under the title, each source an option with
    its host, label and tags (kind, format, size, parts, works with Jobe closed or open, needs the PS5 browser, via
    TorBox); the chosen one is highlighted and Download says "Download from <host>". Touch, the PS5 cursor and D-pad+X
    work; O closes the game page again in the PS5 browser.
  - "That source is no longer listed" (Outer Wilds): the source went to the app only by its position in the list.
    Each link now carries the release id (payload catalogue and store-games.json), the request is matched by that id
    and the app finds the source by it; a source that really disappeared says to pick another one.
  - `/app`: a game whose request was cancelled or refused no longer stays "In the queue" (the page kept the old mark).
    The payload's answer wins on the game page, and going back to the store after acting in Downloads checks the
    pages already loaded again. A store request that failed (source gone, TorBox could not fetch it) suggests picking
    another source on the game's page.
  - A download already finished whose extraction was cut when the app closed no longer comes back as a download (its
    archive had already moved to BACKUP, so it was downloaded again over the network and refused). With the whole file
    on the drive, a PS5 game now shows "downloaded, the extraction stopped": Try again converts it, "Extract without
    converting" extracts it; anything else extracts again by itself. Deleting the card (X) never touches BACKUP.
  - Extraction progress everywhere (TV Downloads, phone page, `/app`): "Extracting from the .7z", GB extracted of the
    total, %, speed, time left and "limited by the processor" (7z/xz/lzma decompress on one core). The payload reports
    new fields in `GET /convert` and `/api/status` (`extracted`, `extractTotal`, `extractPercent`,
    `extractBytesPerSecond`, `extractEtaSeconds`, `extractFormat`, `limitedBy`, `target`); `written`/`total` also
    follow the extraction for older pages. On the phone page the game's name in Converting wraps instead of being cut,
    and the old failed card of the same game goes away while its new conversion runs.
- **glibren.57** (fork): minimal opening. Download payload unchanged (1.37.2, `BG_API` 37).
  - New "Minimal opening" switch (Settings > Appearance), on by default, also for people updating (a settings file
    without the key counts as on). The app opens with only the JL logo and a spinning ring until the store is ready,
    then the store: no intro telemetry lines, no terms dialog with a countdown, no vortex.
  - Nothing pops over the store any more: the terms are accepted once, silently, and stay readable in Settings > About
    (legal notice); "What changed in version X" is a row in Settings > About (marked "New" until opened); a console
    crash is a yellow mark on the "Send diagnostics" row with the time and activity, kept until "See details" is
    pressed; the automatic reports question is not asked (no answer = off, the switch stays in About); the update
    offer is the dot on the island's update button and the row in About; the announcements bar is gone (its notes,
    including the stalled Orbit list warning, are in About).
  - The ring never freezes: while the logo shows, the catalogue is built at the normal frame pace (parts of up to
    ~25 ms) instead of the hurried one (up to 49 ms) that held the old notice's OK button.
  - Turning the switch off brings back the old opening (intro, terms, vortex, notices over the store) from the next
    launch.
- **glibren.56** (fork): fixes from the real PS5 (Jobe .55). Download payload 1.37.2 (`BG_API` stays 37).
  - Full Jobe on the web (/app) in the PS5 browser: the X button arrives as a key press (13) and as a cursor click.
    The key press came first, took the focus (none: "move down", the small jump the owner saw) and the real click
    was then thrown away as an echo, so clicking a game did nothing. Now whoever moved last decides: after the cursor
    moved, the cursor click opens what is under it (the key press only waits for it, 250 ms, then acts on the focus);
    after the D-pad, X acts on the focused item and the cursor click that comes with it is the echo. Cursor movement
    is measured by position, not only `movementX`. Grid clicks go through one listener, so a row redrawn between
    press and release still opens its game.
  - Filters and the choices in Settings are a button plus a list of their own instead of the native `<select>`, whose
    popup does not open in the PS5 browser: D-pad, X, O (closes without changing), cursor, touch and mouse.
  - Covers in the PS5 browser: `GET /app/capa?id=` in the payload (installed game's icon0.png, disk cache, the
    catalogue's non-Sony alternatives, then prosperopatches.com (PS5) / orbispatches.com (PS4) by Title ID, as glibren
    does for its icons; downloaded by the payload, never by the browser). Nothing from Sony is ever fetched (the
    console's DNS blocks it on purpose). Counts per source in the page measurements and the diagnostics.
  - Diagnostics: the page measurements file is checked with `stat()` (`access()` used the real uid and failed with
    EACCES on the PS5) and `info.json` is uploaded first.
  - The payload running on the console is replaced by this app's when its VERSION is older (same API), only while it
    is idle and once per opening; .55 kept payload 1.37.0 running. The result of the payload's self-update check is
    written to the log.
- **glibren.55** (fork): fixes from the real PS5 (Jobe .53/.54). Download payload 1.37.1 (`BG_API` stays 37).
  - YouTube format: after picking VP9 in the quality list (R2), going back to H.264 did not stick. An H.264 hardware
    decode error in the middle of a video ("video decode failed (h264, sceVideodec2)") made the player jump to the next
    quality in the list, the VP9 of the same height, and VP9 stuttered. The format is now a saved setting (`tubeCodec`:
    automatic, H.264 or VP9); automatic prefers H.264; on an error the player steps down in the same format and says
    which quality it opened; VP9 rows carry a warning, VP9 HDR above 1080p is hidden, a video decoded by the processor
    says so. ps5-react: a decode error once pictures are flowing resets the hardware decoder and resumes at the next
    keyframe (up to 3 times a minute) instead of ending the video.
  - Full Jobe on the web (/app): every source on the game page can be picked (touch, controller, keyboard), the picked
    one is highlighted and "Download" sends it (`POST /api/store/add {id, link, ref}`; the payload checks the link
    belongs to the game, 400 `link` otherwise). "Automatic (recommended)" stays the default and is the TV's choice.
    Sources that need the PS5 browser are marked, and the answer says so (`browser`): open Jobe on the TV to finish.
    A source picked on the phone goes through TorBox/AllDebrid when the service takes it.
  - Browser capture: a server that ignores the one-byte Range (AkiraBox, Stray) no longer fails with "response exceeds
    maxBytes" or "failed validation": the link is checked by its headers (HEAD), a 206 without Content-Length counts.
  - Downloads (Alan Wake 2, 100 GB from TorBox): a partial file of another job at the same destination is adopted when
    it is the same file (size and a content sample) or restarted from zero by itself, never stuck; a renewed TorBox or
    AllDebrid link (another CDN node, another ETag) resumes by the service's item, file and size; HTTP 429 holds the
    whole job for Retry-After; "Restart from zero" button with confirmation on the TV, the phone page and /app
    (`POST /jobs/<id>/restart`, `POST /api/jobs/<id>/restart`), offered instead of "Retry" when the file changed on the
    server or the checkpoint does not match.
  - Archives holding a ready image (Alan Wake 2 as `.exfat.7z`): the payload's extraction failed on the PS5 with
    "write: Could not stat .../BACKUP/_temp/<id>/PPSA02572.exfat" (libarchive's SECURE_SYMLINKS lstat of every path
    piece; dropped: no symlink is ever written there). The image inside is now just moved to `homebrew/<code>.exfat`
    (or `.ffpfs`), with no re-conversion. "Use without converting" on an archive reads "Extract without converting".
  - Texts in the 14 languages.
- Tests: `tube-format`, `capture-validate`, new cases in `bg-store`, `bg-downloader`, `phone-library`, `bg-app-page`
  (Playwright: picking a source on the game page), render of the R2 list and of the download card.
- **glibren.54** (fork): the TV store asks the download payload for its pages (Phase 4 of the Orbit model). On the PS5,
  when the payload's catalog is up (`BG_API` 37), Jobe no longer builds the whole catalog in its own memory: the store
  grid and Search come page by page (48 games at a time, a few pages kept), the filter counts, the Discover rows
  (carousel with art and summary, Featured, Recent, Top, New this week, Ready, Popular, Overdrive CDN, Popular genres),
  the game page (links, page, art, editions, related) and the games the app already knows by code (download queue,
  recently viewed, favorites: `GET /api/catalog/cards`) all come from the payload (`state/catalog-remote.js`,
  `state/remote-store.js`). Favorites are filtered and sorted in the app over their cards, with the app's own rules.
- Fallback, transparent: payload not answering, older than 37, catalog over its memory cap (503) or not ready in 4 s,
  any error later, the TorBox store chosen, or opening the TorBox Library or the catalog list in Settings: the store is
  built in the app as before (and rebuilt in place if the payload goes away while it is open). In payload mode the app
  does not download its own copies of the feeds nor rewrite `store-index.json` (the payload does both).
- Memory (qjs peak, same data): store open 14.5 MB -> 6.8 MB (the code's own floor), with the Orbit list 17.9 -> 6.8
  MB; 48 game pages opened (16 kept) 8.8 MB.
- Fixes from the first real console diagnostics (13/11): the Phase 3 catalog never built on the PS5 because
  `data/formats.js` and `data/ratings.js` were not in the image (the copy for the payload failed with "No such file");
  they are now in the `resources` of both `app.json` files, the copy carries on without them if missing, a test checks
  the resources and `pacote.sh` checks the mounted image. The app read a faked firmware (13.090.001 on a 12.00 console)
  from its own process: the payload now reads the real one from the kernel (like glibren), writes
  `/data/JobeesLair/bg/firmware` and reports it in `/health`; the app uses it for the compatibility notes, the "ready"
  rule and the catalog config, and logs both (`firmware=12.00 appSees=13.090.001`).
- Download payload 1.37.0 (`BG_API` 37): `GET /api/catalog/cards?ids=`, cards with metacritic, providers, platforms,
  features, work, recommendations and catalog position; the home rows with art (carousel, Featured), the carousel
  summary and the genre rail. `BG_MIN_APP_API` stays 33 (only additions).
- Tests: `tests/fase4-tela.test.mjs` (the TV client against the real payload vs the app's own build: grid of every
  query page by page, filter counts, Search, home rows, genres, 60 game pages, cards, favorites in the 5 sorts; PS5 and
  firmware 9.60), `tests/remote-store.test.mjs` (opening and every fallback), `tests/catalog-remote.test.mjs`.
- **glibren.53** (fork): the full Jobe on the web (Phase 8), a new page served by the download payload at
  `http://<PS5 IP>:34201/app`, next to the phone page (which gains an "Open the full Jobe" link under its header). Store
  as a cover grid with search, filters and sort (virtual list, pages of 100 from `/api/store`), game page with sources and
  Download, live downloads, and real Settings over `GET/POST /api/settings` (Phase 7: preferences editable with the
  payload's checks, keys shown only as "configured ✓ …last4"). Layouts for phone (portrait and landscape), PC and the
  PS5 browser (1540x700 with its frame, 1920x1080 full screen, 1232x560 at 125% zoom); controller (PS5 browser keys and
  Gamepad API, with the cursor click echo handled) and keyboard, visible focus; device pairing for actions. All 14 Jobe
  languages (`tools/web-app/textos.mjs` reuses the app's and the phone page's translations; Arabic and Urdu right to
  left). On the PS5, "⛶ Full screen" asks glibren 0.9.20+ (same console, port 8765) to apply ps5-web-browser-fullscreen
  through the payload (`GET/POST /api/app/telacheia`, paired device or the PS5 itself) and reopens `/app` where it was;
  without glibren the button is hidden. Download payload 1.36.1; `BG_API` stays 36: the app's local API did not change
  (only the payload's own page routes).
- Tests: `tests/bg-app-page.test.mjs` (route, Host, real pairing flow, glibren bridge against a fake glibren, texts in
  14 languages, Playwright against a fake API in 8 sizes with controller and keyboard).
- **glibren.52** (fork): the store catalog is built inside the download payload (Phase 3, C core in
  `app/native/bg_catalog*.c`). A thread builds it from the bundled catalog (copied by the app to
  `/data/JobeesLair/catalog/bundled` with `FileSystem.copyAsync` on each new version, `state/catalog-payload.js`), the live
  catalog, the player's feeds (web with mirrors and ETag, Pegasus `packages`, files on the PS5) and the Orbit list, and
  swaps it under a lock when any of them changes. The payload downloads the live catalog and the web feeds itself
  (lists-home, If-None-Match, 8 MiB cap, never in quiet mode). Same rules as the app: sorts with QuickJS's
  `localeCompare` (NFC, code points; full Unicode lower case and NFC/NFD tables generated from qjs 0.15), filters and
  counts, the home rows, related games, the Search screen's accent-free match, links in Jobe's order, hidden catalogs,
  PS4 mode and the console's firmware. New local API: `GET /api/catalog`, `/options`, `/search`, `/home`, `/related`,
  `/game`, `/sources`, `/status`, `POST /api/catalog/rebuild|refresh`. The phone page's store (`/api/store`) now comes
  from it; without it (no copy, or over the 32 MiB memory cap) it falls back to the app's `store-index.json`. The known
  codes of the Orbit list are the union of the app's and the payload's. `/teste` gains section 6 (catalog build time,
  memory and query times on the console). `BG_API`/`PAYLOAD_API` 36, payload 1.36.0 (`BG_MIN_APP_API` stays 33: the
  local API only gained routes). The TV still builds its own store until Phase 4.
- Tests: app x payload parity on a fixture in the repository (`tools/fase3/parity.mjs`, `tests/fase3-nucleo.test.mjs`:
  36 queries, filter counts, search, home rows, 60 game pages, the phone store's "solo"; PS5, 9.60 firmware, PS4 and a
  hidden list; again under ASan + UBSan), `tests/bg-catalog.test.mjs`, `tests/catalog-payload.test.mjs`,
  `tests/catalog-text.test.mjs` (against Node and qjs).
- **glibren.51** (fork): Jobe's settings live in the download payload (Phase 7, `app/native/bg_settings.c`). The
  payload keeps `<bg>/settings.json` (`{schema, rev, store, migratedFrom, values}`, written with `.part` + fsync +
  rename + fsync of the folder; a leftover `.part` is dropped on read), validated key by key (`SETTING_SPECS`: type and
  limits). With no file it imports the app's old `settings.json` once, leaving out secrets and invalid values. The app
  (`state/settings-sync.js`) sends each change (`POST /settings`, pending changes kept in `settings-sync.json`) and
  adopts the payload's when `settingsRev` in `/health` moves; keys coming from the phone page go through the same
  setters as the Settings screen (`state/settings-apply.js`). The phone page reads and changes the preferences through
  `GET/POST /api/settings` (`monitor_allowed`); speed, simultaneous downloads, pause on close and conversion take effect
  at once. Secrets never leave where they are (TorBox/AllDebrid keys, the diagnostics GitHub key, the YouTube account,
  the companion and page PINs): the payload only tells "set" (and, to a paired device or the PS5 itself, the last
  characters of a key). Without the payload, or with an older one, everything stays in the app's `settings.json` as
  before. `BG_API`/`PAYLOAD_API` 35, payload 1.35.0 (`BG_MIN_APP_API` stays 33: the app's local API only gained routes).
- Tests: `tests/bg-settings.test.mjs` (8, real payload: migration, secrets, validation, power loss mid-write) and
  `tests/settings-sync.test.mjs` (6). Test binaries are now built in their own folder (`tests/payload-build.mjs`): the
  orphan-payload cleanup used to kill the compiler writing to `/tmp/jl-*/bgdl`, and the whole file showed as "skipped".
  Only a missing compiler or missing headers skip now; any other build failure fails every test of the file at once.
  The TorBox pace test (`torbox-library-payload`) counts by window instead of every single gap (flaky under load).
- **glibren.50** (fork): per-device pairing for the phone page (Orbit model, `app/native/bg_pair.c`). A phone, PC or
  the JobeControle app asks for a code once; the PS5 shows a 6-digit code in a notification (in the player's language,
  `pairText` in POST /config) and on Jobe's screen (`ui/PairCodeNotice.jsx`, reads GET /pair every 3 s without taking
  the focus); the device types it and gets a token only it holds (64 hex, `X-Session` or `Authorization: Bearer`).
  `/data/JobeesLair/bg/devices.json` (0600) keeps only the SHA-256, the name and the date. Constant-time checks, 5
  tries, then a growing lock (30 s up to 15 min), a code lasts 2 min, at most one request every 10 s; the code and the
  token never go to the log. 127.0.0.1 stays exempt only without an `Origin` from another site. Every page route that
  changes something or shows sensitive data goes through `monitor_allowed` (list in `bg_pair.c`), including the .49
  payload update/revert. The old single PIN keeps working until it is turned off ("Accept the old PIN" in Settings >
  Downloads or on the page); turning it off drops its sessions at once. "Paired devices" in Settings > Downloads and on
  the page, with Remove (the token stops working at once). 14 languages. `BG_API`/`PAYLOAD_API` 34, payload 1.34.0
  (`BG_MIN_APP_API` stays 33: the app's local API only gained routes).
- Tests: `tests/bg-pairing.test.mjs` (9) and `tests/render/pairing.mjs`; `tests/bg-self-update.test.mjs` derives every
  version and API from the source (no fixed 1.33.x), so the next `BG_VERSION` bump does not break it. Flaky under a
  loaded machine: the background-downloads checkpoint tests now wait for the condition on the monotonic clock (no fixed
  250/400 ms), and the link-health integration deadline is 1 s instead of 100 ms.
- **glibren.49** (fork): the download payload updates itself, signed, without a new Jobe image (phase 2 of the Orbit
  model). `app/native/bg_self.c`: releases tagged `bg-downloader-<version>` (never latest) carry `bg-downloader.elf`,
  `bg-downloader.json` (version, `api`, `minAppApi`, size, SHA-256) and `bg-downloader.json.sig` (Ed25519 of
  `jobe-bg-signature-v1\n` + the exact manifest, the glibren key). The payload looks for a newer one when the app opens
  (at most every 6 h) or from the phone page, checks the signature and the SHA-256, writes `.part` and renames it into
  `/data/JobeesLair/bg/`, and switches only when nothing is downloading or converting (the new one asks the old one to
  quit cleanly). On every start the payload hands over to a downloaded version only if it is newer than itself and than
  the app's built-in one, signed, intact and compatible; a version that fails to start twice is marked bad and the
  previous (or the built-in) one starts. API contract: a downloaded payload with `api` above the app's `PAYLOAD_API` is
  used only when its `minAppApi` is not above it. "Download payload" and "Back to the built-in payload" in Settings >
  About and on the phone page (PIN). `BG_API`/`PAYLOAD_API` 33, payload 1.33.0.
- Homebrew: the six darkxex apps hidden in glibren.48 (Alembic, PKG Folderizer, Trophy Manager,
  MacheteSaveGameManager, PS Play 3.0, RecompStore) are listed again; each page shows one informative line (it does not
  block anything). 14 languages.
- Tests: the payload's start waits on the monotonic clock with a 30 s limit and no payload of an earlier test survives
  it (the WSL wall clock runs ~35% slow under load; one slow start used to fail the rest of the file), and a busy port
  at start is tried again every 250 ms for 20 s instead of once every 10 s. On the PC a test payload now quits with the
  test runner (or when its folder is gone): orphans from killed runs kept retaking the tests' ports every 10 s.
- **glibren.48** (fork): the Homebrew section also lists the [PS5 Homebrew Catalog](https://github.com/darkxex/ps5-homebrew-catalog)
  by darkxex (GPL-3.0-or-later; data only, none of its code). `state/darkxex-catalog.js` reads its `catalog/v1.json`
  feed one app at a time (`json-scan.js`), keeps a copy (`homebrew-darkxex.json`) and fetches it again in the same
  refresh as the Jobe's list, at most every 30 minutes. Reservations, withdrawn apps and records without a link or
  SHA-256 are left out, and so are six tools the Jobe does not list (FPKG/dump converters, trophy unlocker, save keys,
  another store). The two lists are joined without duplicates: the same repository, or the same title ID with a
  similar name, is one entry, with the newer version (tag numbers, then date); the same title ID with another name
  keeps both and each page warns that installing one replaces the other. Cards from the catalog say "darkxex"; the
  app page names the list(s). Before installing one of its files the app checks it against the catalog's signed API
  (`manifest.json` + `manifest.sig`, Ed25519 with either of the catalog's two keys, sequence never lower, the app's
  `apps/<id>.json` by the manifest's SHA-256) and installs the signed link; the native download refuses a file whose
  SHA-256 does not match. A format the app does not install yet shows "Not supported yet". "darkxex catalog" switch
  (on by default) in Settings > Catalog feeds > Homebrew and at the bottom of the section; credits in the section,
  README and NOTICE (14 languages).
- **glibren.47** (fork): a smaller image and a test page for the console's browser. The bundled catalog's releases
  (2,114 files) and store pages (2,074 files) now ship as two pack files each, `data/packs/releases.pack` +
  `releases.idx` and `pages.pack` + `pages.idx` (`tools/catalog/data-pack.mjs`; the folders stay the source in the
  repository and `catalog-index.mjs`/`formats.mjs` rebuild the packs). The app reads one game's item at a time by its
  byte offset (`state/data-pack.js`, with a new `FileSystem.readFile(path, offset, length)` in the runtime), so the
  pack is never in memory, only its index (~45 KB each, checked once: a corrupt index refuses the pack and the game
  shows its feed links and an empty page instead of crashing). With ~170 files instead of ~4,350 in 64 KiB clusters
  and the image's slack down from 128 to 64 MiB, `JobeesLair.exfat` goes from 530 MB to under 250 MB. The packaging
  now also checks the image with `fsck.exfat` and mounts it to compare every file. The payload's phone page has a new
  `/teste` page (same PIN): full screen, the controller through the Gamepad API and the keys, the whole store
  (~2,600 games) with timing and frames per second while scrolling, the payload's memory, and whether the payload
  survived rest mode; "Copy results" and "Send diagnostics" carry the results.
- **glibren.46** (fork): the app's updates are signed (A-M1). Each release now carries `jobe-release.json` (version,
  name, size and SHA-256 of `update.zip` and `JobeesLair.exfat`) and `jobe-release.json.sig`, an Ed25519 signature
  made on the publisher's PC with the same key that already signs the glibren payload and the YouTube service
  (`jobe/ferramentas/assinar_jobe.py`, called by `publicar.sh`; the private key never leaves that PC). The update
  check (`state/updater.js` + the new `state/release-signature.js`) downloads both, checks the signature with the
  embedded public key and that the manifest is the tag's version, and offers the update only with the size and SHA-256
  of the signed manifest (which must also match GitHub's); the native download checks the file against them. A newer
  release without a valid signature is shown but never installed, by any path (the dialog, the automatic install with
  its restart, the phone's "Update Jobe" and the Settings row): the app stays on its version and Settings > Update says
  why (14 languages). From .46 on the signature is required; .45 and earlier update to .46 the old way (GitHub's
  SHA-256 only), because they do not know about it.
- **glibren.45** (fork): less CPU while the app sits open (the PS5's fan sped up with it open). Measured on the PC
  preview (same JavaScript and CPU renderer as the console; `tools/perf/idle.mjs`, which now counts the frames actually
  drawn, `shown`): idle on the store 118.8 → 0 frames drawn a second, idle on Downloads with two announcements
  103.6 → 0, the screen saver 80.7 → 8.4 (2,070 → 306 thousand pixels a frame; 0.2 with "Save energy"). After 15 s without a button press
  (always, `state/power.js`) the announcement bar keeps the note it shows and its dots stand still, the store's banner
  and the Homebrew spotlight stop turning, a pulsing placeholder and the search cursor stand still, and the Downloads
  numbers, speed charts and card progress are redrawn every 5 s (the payload's conversion list is asked for every 5 s
  too); any button brings it all back at once. The screen saver no longer drifts (it repainted the whole screen every
  frame); the slides still fade in. New "Save energy" setting (Settings > Look, off by default, 14 languages): short
  animations (the runtime's light motion, as on the PS4), no launch vortex, still charts, live screens every 2 s,
  smaller covers (300 px wide instead of 440, from the next launch) and a screen saver without fades. Launch: the
  bundled index, the feeds (or the store snapshot) and everything worked out from them are built in parts a frame at a
  time while the intro and the terms show, and the store mounts once it is done (qjs, Orbit list on, 2,639 games: the
  first launch after a feed changes went from one 2.6 s block to ~110 parts of at most ~80 ms; a usual launch from 306
  ms in one block to ~22 parts; peak heap 34.7 → 28.8 MB and 21.3 → 17.6 MB, the snapshot now read and written a game
  at a time). Found on the way: the runtime's clock (`Date.now()`, `performance.now()`) does not move inside a frame,
  so the old "give the frame back after 6 ms" in the feed refresh (8 s after launch) and the store export (20 s after)
  never did on the console; both now count steps (`state/frame-pace.js`) and fit them to how long the frames take.
- **glibren.44** (fork): less memory in the TorBox library, the YouTube account always reachable, clearer download
  cards and diagnostics sent from the phone. TorBox library: on the console the JS heap reached 50.5 of 64 MB while
  building it. The background payload now writes the account list with only the files the build uses (plus the
  PPSA/CUSA codes of all of them), the app reads it one item at a time, and a game TorBox doesn't have is kept as just
  its id, title and result; measured on the PC with the same QuickJS (Orbit list on, 2,639 games, an account with big
  folders, built twice): 50.1 → 26.2 MB. YouTube: an older service still running (0.1.x, no sign-in) is replaced by
  the newer one ready as soon as nothing uses it, a video that needs an account swaps it and tries again once, the
  "YouTube account" row never disappears (it says which service is in use and offers "Update the service now"), focus
  goes to the account row after signing in, a Google account whose age is not confirmed says so, and error codes with a
  suffix are shown whole. Downloads: one waiting on its own next try has one state (WAITING section and chip, who is
  busy, the time and a countdown, "Try now", not counted as failed); before the first byte through TorBox the card
  says "TorBox preparing the file: N%" (or that it waits for it); card texts wrap instead of being cut. Diagnostics: a
  fine-grained GitHub key pasted once on the phone page (JobeControle) lets the payload send the logs, cleaned of keys,
  tokens, cookies, temporary links and e-mails, to a private repository, even with the app closed; a .zip from the
  phone's browser as a fallback. Updates from the phone: the phone page (and JobeControle) shows the installed and the
  latest version and "Update Jobee'sLair"; the payload only keeps the request and the open app checks, downloads and
  restarts to apply it with the usual locks (never with a conversion running). "Install updates automatically" now also
  restarts by itself when nobody is using the app (in front, nothing playing or converting, no dialog, the controller
  untouched for a minute), after a 10 s notice that (O) postpones; never over another app. The startup notices that only
  have OK (terms, What's new, the crash notice) go by themselves after 10 s without a button ("OK (10)"). Payload api 31
  (the app swaps an older payload still running).
- **glibren.43** (fork): app switch by the real foreground, one TorBox pace and a sturdier YouTube service. Switching
  apps (POST /switch, used by Videos and by "Back to Jobee'sLair"): after the old app closes, the background payload
  reads the kernel message buffer (kern.msgbuf) and, when the system writes SetControllerFocus there and the focus was
  on the old app when the switch was asked, opens the new app 3 s after the focus leaves the old one instead of always
  waiting 15 s; the 15 s stay as the limit and as the wait when there is no signal (or a line that doesn't match the
  old app). An app is still never opened over another one. Idea from ps-game-state-lib by StonedModder (MIT); own
  code, the same reading as glibren 0.9.16. TorBox: the library build, the phone requests started with the app closed
  and the link renewal of downloads now share one pace (one call every 300 ms for the whole payload) and a 429 seen by
  any of them makes all of them wait; a renewal that would wait long gives up for the moment instead of holding the
  download thread. Payload api 28 (the app swaps a .42 payload still running). YouTube service 0.2.1 built in: its
  own DNS resolver (UDP, then TCP, then DNS over HTTPS with a file cache) for YouTube and Google hosts only, when the
  console's DNS fails (idea from ps5-patchdl).
- **glibren.42** (fork): Etapa 4 do plano de ação (revisões de 12/11) e a conta do YouTube. YouTube account: Settings >
  Videos signs in with a TV code (the code, the address and a QR of it; the app asks until it is confirmed, refused or
  expired), shows the connected account and Sign out; the sign-in stays only in the YouTube service on the console
  (tube-service 0.2.0, api 2, feature "account"); with an older service the rows are hidden. The player says when a
  video asks for an account (authentication_required: sign in under Settings > Videos), when the sign-in expired
  (account_expired) or the account can't see it (account_not_allowed), and shows when a video played through the
  account (signed_in_playback). The YouTube service: a downloaded version is set aside only after 3 failed starts in a
  row, and "Back to the built-in version" sets it aside at once (A6); signed links are renewed again after a minute of
  playing, up to 8 times per video (A11); the service itself no longer cuts long redirect headers (A3), drops the
  oldest of 32 sessions (R2-10), caps waiting extractions (R2-11) and bounds WebM index integers (R2-18). Downloads:
  the app takes a download back from a background payload that stopped answering only once its partial file stopped
  growing (A2); cancelling or removing an item sends the payload the new list (R2-5); the parts of a set follow the
  resolver's real size and repack mark (R2-7); a move to another drive that stopped keeps its finished copies as its
  own (moving again keeps them, Cancel deletes them) (R2-6); counting extracted files for the log stops at 2,000 (A12).
  The store export for the phone page computes its key game by game, sorts one order per frame and writes the index in
  pieces (A4). Payload: the .pkg reader rejects a folder inode outside the table (R2-1); the fallback extraction keeps
  only files and folders (no symlinks, special files or outside hardlinks) and survives non-ASCII names (R2-2, R2-3);
  "Show log" in the app gets the last 512 KiB (R2-12); the phone page answers only requests addressed to an IP or
  localhost (J6); AllDebrid and signed direct links are no longer written to jobs.json (J8); a power loss right before
  the final rename is finished on the next start (J9); a store game's details are read with one pread (J7); paths with
  control characters and deleting BACKUP/_temp or an item still being downloaded are refused (J10, R2-19).
- **glibren.41** (fork): Etapa 2 do plano de ação (revisão de 12/11) e o catálogo do usuário. The cap while a video
  plays goes to the background payload as a temporary field ("videoCap" + "videoCapSeconds" in POST /config, renewed
  every 30 s): it is never written to config.json and expires by itself when the app stops renewing (closed with the
  video open), and the saved limit is what the payload stores and compares with the phone's (A1, A5, A8). A conversion
  that was running when the console went down (unclean exit) is held as "failed: interrupted" until Convert is tapped
  again, instead of starting over in a loop (J2); a conversion whose work folder is the extraction one
  (<root>/BACKUP/_temp/<id>) survives a restart, and extraction leftovers without a live conversion are deleted (J1);
  "running" only drops at the end of the conversion loop and a finishing job keeps its destination, so neither is freed
  while still in use (J3, J4); the TorBox Library stops at the first key refusal (J5); the YouTube search text is no
  longer logged (A7). Bundled catalog: 149 working links checked from the user's catalog files (Vikingfile and
  Archive.org), 89 games gain links and 43 games are new. Tests: each payload test file gets its own block of ports
  (T1).
- **glibren.40** (fork): Settings > Videos gets "Downloads while watching": while the YouTube player is open, the
  downloads are capped at a value chosen with − / + (any whole MB/s, 5 by default; "Leave as is" turns it off). The
  lower of this cap and the saved speed limit holds, in the download engine and in the background payload (POST
  /config); the saved limit is never changed, and closing the player brings it back (state/speed-limit.js
  setVideoCap, state/tube-settings.js tubeDownloadCap).
- **glibren.39** (fork): Settings > Videos gets "Default YouTube quality" (1080p, 1440p or 4K; 1080p by default) for
  the videos played inside the app (state/tube-settings.js tubeQuality); R2 in the player still changes it, and a
  quality that fails still steps down by itself. The player's info line now says which decoder plays the video: the
  PS5's (sceVideodec2) or software (FFmpeg), from the `<Video>` status.
- **glibren.38** (fork): the TorBox Library's network part runs on the background payload (bg_library.c, API 27): it
  keeps going with the app closed, and the final save writes one file at a time (no second copy of the database; a
  lean save above 85% of the heap). The store keeps the feed and Orbit download links on disk (in groups of 40 games)
  instead of the JS heap (store + Orbit retained 15.1 -> 9.2 MB in qjs), and exports the full store to the payload:
  the phone page gets a "Full store" tab (search, filters, sort, game page, download; a "Jobe" badge marks what needs
  Jobe open to start). The YouTube service updates itself from signed `tube-service-*` releases (Ed25519, sha256,
  rollback when it does not answer; Settings > Videos), and subtitles follow Jobe's language.
- **glibren.37** (fork): memory meter (the engine's device.memory: JS heap, 64 MiB limit, and the title's heap):
  peak per screen/action in the log and in Settings > About, a warning above 85%; tools/memory/measure.mjs measures
  the scenarios in qjs. YouTube opens faster: the focused result is resolved ahead (cache of 3, 10 min) and the
  player opens at once with the thumbnail while it loads (about 2.7 s -> 1.1 s on a PC).
- **glibren.36** (fork): conversion options in Settings > Downloads (all off by default): a pause between
  conversions, a write limit (MB/s) and "Write in chunks" (fsync every N MB). The background payload (API 24) logs
  each conversion step with an fsync (disks and file systems, progress every GB, rename, ShadowMount+), and after a
  console shutdown Jobee'sLair shows once "The console shut down at HH:MM during <activity>" with the last step and
  log lines. Tests that failed under load are deterministic now.
- **glibren.35** (fork): the glibren payload's YouTube button opens Jobee'sLair straight on its YouTube screen
  (/data/JobeesLair/tube/abrir.txt: search, voltar=, auto=1; Jobee'sLair advertises it in jobe-tube.txt), and
  Circle or "Back to glibren" switches back to glibren through the background payload.
- **glibren.34** (fork): tube-service.elf (YouTube inside the app) on youtubei.js 18.3.0 (was 18.1.0): fixes for
  results without a title and the duration of very long videos; a video without the duration overlay is no longer
  taken for a live one.
- **glibren.33** (fork): YouTube inside Jobee'sLair. Trailer/Gameplay (and a search screen with filters) use a new
  on-demand payload, tube-service.elf (YouTube's built-in service from YouTube Max'd: QuickJS-NG + youtubei.js, loopback
  only), and play in the app's own player (HLS of video+audio, quality, captions, SponsorBlock); Circle goes back to the
  results. If the service does not start, the old way (YouTube Max'd/ytps5) is used. YouTube/Google names fall back to
  a public DNS (8.8.8.8, 1.1.1.1) when the console's DNS blocks them; Sony names never.
- **glibren.32** (fork): Settings > Look > "Play the first video automatically" (off by default): Trailer and
  Gameplay ask the video app to play the first result straight away, no list (`auto=1` in glibren_busca.txt; YouTube
  Max'd glibren4 reads it).
- **glibren.31** (fork): "Videos" no longer asks the console to open the video app over Jobee'sLair (it was refused,
  0x80940011, and a console shut down soon after one of those tries). Jobee'sLair now asks its background payload to
  switch (POST /switch, payload API 23) and closes; the payload waits for it to close, then opens the video app. The
  search file carries `voltar=<title>` so YouTube Max'd glibren3 can come back the same way, and Jobee'sLair reopens on
  the screen it left (return-screen.json, kept 6 hours).
- **glibren.30** (fork): an app update no longer fails when ShadowMount+ is busy and does not answer where the app's
  image is ("ShadowMount did not answer games/info"): it asks three times, then uses the path ShadowMount+ gave last
  time (or the last update's), while that file is still there, or the one JobeesLair.exfat in a drive's homebrew
  folder. The update's generic wait no longer says "Waiting for your downloads to finish" (it has not waited for them
  since glibren.22): "Getting the update ready".
- **glibren.29** (fork): asking TorBox about a game's links no longer runs the app out of memory ("Find formats" closed
  it with Orbit Store on): links are asked 10 at a time instead of 100, each answer is read one entry at a time, and
  only what is used is kept (name, size and id of the files that matter; a long backport list as a summary). The same
  goes for "Find via TorBox", TorBox Instant and the TorBox library. Measured in QuickJS with the store loaded: about
  24 MB at the peak instead of 34 MB (over the 32 MB the app has).
- **glibren.28** (fork): a game's page no longer freezes the app when its download turns into a conversion (the
  download button had no "converting" state and threw while drawing); an unknown state now shows its name, and a screen
  that fails to draw shows a notice that Back leaves instead of freezing everything. The TorBox library is written one
  game at a time (the files are byte for byte the same) and no longer runs out of memory with Orbit Store on (every save
  failed and the TorBox store kept the old list); the payload list is saved even if the library file is not, and a
  library that cannot be read (out of memory) stops the build instead of starting over and writing over it.
- **glibren.27** (fork): the app no longer runs out of memory reading its catalogs on the PS5. The live catalog (now
  actually downloaded since glibren.26) and the console's own feed files are read one game at a time from the text
  instead of as one big tree, and their caches are written in pieces (a live catalog refresh went from ~24 MB to ~6 MB
  of heap in QuickJS). The Orbit Store list carries only the links of games the app already knows (the app tells the
  payload which ones), keeping cover, background and description for the ~220 new ones: about 1.5 MB instead of
  3.3 MB; it shows from the launch after the payload rewrites it. Web feeds show the date and time of their last
  download, and so does the live catalog under "Show in the store", whose hint now reads as a description. Background
  payload API 22.
- **glibren.26** (fork): the live catalog updates on the PS5 again: since glibren.20 every web feed was asked with
  8 MiB while the console transport takes at most 4 MiB, so each request was refused ("invalid
  method/body/maxBytes/binary") and the store stopped receiving new games. The Orbit Store list weighs less (repeated
  strings kept once, the cache written in one piece, descriptions cut at 1,500 bytes; the payload rewrites the list
  at once with the new conversion) and TorBox's account is read in pages of 250 instead of all at once (the app ran out
  of memory and closed with Orbit Store on). TorBox library: a call the console never answers gives up after 90 s,
  Cancel stops at once, and a wait counts down. "Show in the store": focus stays on the switch pressed, and the
  titles counter counts only the catalogs shown. Background payload API 21.
- **glibren.25** (fork): the Orbit Store list now shows up on the PS5: the app read it from its own data folder
  (`/download0` or `/data/ps5-react/<ID>`) while the background payload writes it to `/data/JobeesLair/orbit`, so it
  stayed on "Downloading the catalog for the first time" forever and never reached the store or the TorBox library's
  sources; the line now reads "Updating" while the payload downloads. TorBox library: games that arrived after the last
  build (a list turned on later, like Orbit Store) are counted and "Check only the N new games" checks just those,
  keeping what was already checked. Settings > Catalog feeds > **Show in the store**: one switch per catalog (Jobee'sLair,
  live, each feed, Orbit Store); off, its games leave the store (full and TorBox) while the feed stays included, so one
  left on shows only its games. Convert (app and phone) always answers: "In the conversion queue (position N)",
  "Converting now", "Already in the queue" or "Already converted: <file>" (an image of the same title ID found under
  any name in a drive's `homebrew/`, e.g. renamed and already in ShadowMount, is not converted again); a finished
  conversion whose image is gone anywhere goes back to the queue. Background payload API 20.
- **Closing the app with the background payload running is gentler** (a console froze once when the app was closed
  with "keep downloading" on; the cause is not confirmed yet). When the app closes, the background payload goes
  quiet for 30 seconds (no network, no disk, nothing started, no image moved into `homebrew/`) while the system takes
  the app down, then resumes slowly (2 connections, growing again). All its downloads together now open at most 32
  connections (4 at once could open 128), the partial file is synced every 15 s instead of 5 s while the app is
  closed, the SHA-256 check yields the processor every 8 MiB, and its two servers no longer spin when the network
  stack fails. It no longer calls `sceSystemServicePowerTick` (a system call never checked outside an app):
  `"powerTick": true` in `config.json` turns it back on for a test.
- **The background payload's log tells what happened** (`/data/JobeesLair/bg/bgdl.log`, kept to 1 MiB plus
  `bgdl.log.old`): whether the previous run ended cleanly (and its last line when it did not, as after a freeze),
  the app opening and closing, the quiet time, a pulse every minute while it works (app open or closed, downloads,
  connections, speed), each download's start and end, and a fatal signal. Those lines are synced to disk at once,
  so they outlive a frozen console.
- **TorBox Instant links name their type by themselves.** When the source list opens, the links TorBox holds already
  with no format are asked of it in one call (checkcached with the file list: nothing is added to the account), so
  a VikingFile "Instant" link reads "exFAT image" without a press.
- **"Find via TorBox".** On a link TorBox takes but does not hold, "Find" can ask TorBox: a request is added to the
  account only to read the files' names, and removed right after; nothing is downloaded on the console. A link
  whose site also needs the browser offers both ways under its "Find".
- **A download through TorBox says so** on its card ("via TorBox") and on the phone page.
- **"TorBox only" in the source list's filter** (the active service's name: TorBox or AllDebrid), kept for every
  game: only the links the service fetches, the ones it holds already ("TorBox Instant") first, with the format
  and image type filters too (only exFAT through TorBox, say). The download button then starts with the best of
  them, through the service: Instant first, then the format the filter wants, then the app's own pick; a link the
  gamer picks stays. A game with none says so, with "Show all". Greyed without a key, saying what to add.
- **The exact type of a link, not only its group.** Rows say "exFAT image", "FFPKG image", "RAR archive" where the
  type is known (the catalog, a file name, a page, TorBox's names, a download's or a capture's first bytes; a UFS2
  image is told by its superblock 66 KiB in), and the catalog's ".exfat Image" pill no longer says it twice. With
  images shown, the format filter picks image types too (exFAT, FFPKG, FFPFS with FFPFSC), saved with the rest.
- **"Find" beside a link whose site needs the browser.** The console's browser opens on it, the gamer passes the
  site's check as for a download, and only the file's name or first bytes are read: nothing is downloaded. The
  format is kept as found. Only on the console (the desktop preview says so).
- **A TorBox key added later counts.** A link "Find formats" had found to need the browser is asked of TorBox again
  once a key is set, and the counts under "Find formats" are what is known now.
- **One link opens the list too** ("View download link"), with the format filter, Find formats and Find; the line
  under the download button names the chosen link's format as worked out.
- **Badges no longer sit over the size.** A row's badges wrap within its text column, beside the TorBox and Find
  buttons too.
- **The whole queue keeps downloading with the app closed.** With "keep downloading when I close the app" on, the
  downloads still waiting in the queue are handed to the background payload ahead, in the queue's order: the ones it
  can fetch alone (direct links, and TorBox once its link is asked) download one after another (or as many at once
  as "Simultaneous downloads" says) after the app closes. While the app is open nothing changes: it starts each one
  as before and the payload only follows (it starts nothing handed ahead until it has heard nothing from the app for
  about 15 seconds). Pausing, cancelling, deleting or reordering in the app sends the new queue; what left it leaves
  the payload too (its partial kept). The TorBox link of the first four waiting is asked ahead, one at a time (each
  is a request on the TorBox account and counts toward its limits); one that cannot be had yet waits for the app and
  is tried again after ten minutes. What only the app can download (a host's page, the browser, a set in parts, a
  manifest, AllDebrid) shows on the phone page as "Waiting for Jobee'sLair: starts when you open the app", with no
  buttons (cancel it in the app). Before each download it starts alone, the payload checks the drive has room (plus
  256 MiB) and otherwise stops it as "open the app"; a direct link refused as expired (401/403/410) also waits for
  the app, never tried again by itself. Reopening the app, each game follows what the payload did. Not yet tested
  on a console.
- **Follow the background downloads on your phone.** While the app is closed, the background payload serves a page
  at the console's address, port 34201, on the home network: each game's progress, speed and time left, the total
  speed and what is left. Pausing, resuming and cancelling there ask for a PIN set in Settings > Downloads ("Follow
  on your phone"); without one the page only watches. Only a salted SHA-256 of the PIN is kept and sent to the
  payload; a session lasts 12 hours and five wrong PINs block further tries for a while (30 s, doubling, at most
  15 minutes). The page never shows links, keys or paths. A pause made on the phone stays: the app shows the game
  paused when it opens instead of resuming it; a cancel there deletes the partial as a cancel in the app does.
  Settings shows the address once the payload is running, and the console tells it in a notification the first
  time a download goes to the background. Not yet tested on a console.
- **Simultaneous downloads.** Settings > Downloads has "Simultaneous downloads": 1 (as before), 2, 3 or 4 games at
  once. Raising it starts the next ones at once; lowering it stops none, it only starts no other until fewer run.
  Downloads from the same site share its connections (at least 2 each); what the other downloads on a drive still
  need counts as taken, and one that only fits once they are done waits for them ("Waiting for the other downloads
  on this drive to finish, to have room."). Only one RAR set at a time extracts while it downloads; the others
  extract after their download, in the extraction lane. The number reaches the download engine's lanes and the
  background payload, which then runs that many jobs at once with the app closed too.
- **Downloads with mirrors carry on with the app closed too.** With "keep downloading when I close the app" on,
  a download that has mirrors is handed to the background payload from its main link only (one site at a time);
  taken back by the app ("Download in the app", or the payload gone), it uses the mirrors again. With the option
  off, the app downloads from the mirrors from the start, as before.
- **Unpacking no longer holds up the queue.** A downloaded archive is unpacked beside the next download, which starts
  at once; archives still unpack one at a time, in order ("Waiting to extract…"). A download that only fits once the
  unpacking on its drive is done waits for it instead of failing.
- **Mirrors.** A file the catalog lists on several direct links (the same SHA-256, or the same size and name) is
  downloaded from up to four of them at once; the engine drops any that does not serve the same bytes.
- **Gentler on busy hosts.** How many connections a download opens is set per host in one table
  (`app/state/download-tuning.js`): fewer for archive.org, MediaFire and GitHub, 64 elsewhere as before.
- **TorBox links renewed whenever they expire,** not twice at most, and before they are 2.5 hours old; the partial
  carries on. Renewals that bring nothing back slow down and then stop, saying why.
- **TorBox still preparing a file** is asked again every 5 minutes, for about two hours, by itself; cancel stops it.
- **Network hiccups while a link is resolved** (no answer, a timeout, DNS) are tried again after 30 s, 2 and 10
  minutes before another source is tried.
- **The TorBox and AllDebrid keys are sealed** in debrid.json, with a secret kept apart from it: a copy of the data
  folder no longer carries a usable key. Someone with full access to the console can still read it.
- **A lighter catalog at launch.** The bundled catalog is no longer compiled into the app: it is read from
  `data/catalog/index.json` at launch (what the lists, search, filters and sorts use), and each game's banner, logo
  and other covers from small art files the first time they are drawn. On a PC that is 45 ms instead of 110 ms and
  about 0.5 MB less held in the script heap; nothing the store shows or sorts by changed.
- **Downloads carry on after rest mode.** When the console wakes with the app open, a download that was running
  and fails because the network is not back yet is tried again by itself (after 20 s, 1, 2 and 5 minutes), and the
  debug log says how long the console slept and when the app held rest mode off (`keepAwake on/off`, with the
  engine's answers), to check on a console that downloads keep it awake.
- **The first screens' covers first.** Every cover is still fetched into the cache after launch, but the first ten of
  each Discover row and the catalog's first rows now come before the rest (Top Rated's tenth cover was the 529th
  fetched; now it is among the first hundred).

## 0.5.7 (2026-11-08)

- **The store's catalog comes in a new format.** New games keep reaching the store between releases. 0.5.6 and
  earlier stop receiving them and keep the games they already have, so update to keep the store current.

## 0.5.6 (2026-11-06)

- **Big 7z archives unpack.** A 7z packed with 7-Zip's largest settings (an LZMA2 dictionary of 128 MiB to
  1.5 GiB) was refused with "This archive needs more memory to extract than the console app can use": 246 of
  0.5.5's 251 such reports. Its dictionary now comes from the console's direct memory instead of the app's heap of
  a few hundred MiB, and one is refused only when the console doesn't have that much free.
- **Downloads resume instead of starting over.** After the app closed mid-download, a pause, or a renewed
  expired link, a download could refuse to resume ("partial file has no matching durable checkpoint") and lose its
  progress. A partial whose size and ranges still match now resumes once its last bytes are checked against the
  server's, and a finished file on a USB drive is no longer refused after the drive is mounted again.
- **Drives known by a file of their own.** "Storage changed. Reconnect the original drive." no longer loops: each
  download folder carries a small marker, and deleting a download always works, even when its drive changed or is
  unplugged.
- **Real sizes.** An archive's space check shows what it really unpacks to, not the free space ("needs 356 GB,
  356 GB free").
- **Games with .pkg files of their own install.** Only real packages count as packages (by their header), so a
  game that ships .pkg asset files (Hades II) is no longer refused as "too many installable artifacts".
- **Make Room leaves a running unpack alone.** It no longer offered a game that was still unpacking as a leftover
  to delete.
- **Broken RAR sets, flagged for everyone.** A set its host lists short of the last volume goes to the shared
  list, as a gone link does, so other players get a working source first.
- **A download waiting on its own retry says so** on its card's status line too.
- **French numbers** show their thousands separator again.
- **Logs stay private.** Report a bug and the automatic reports now say where logs go: to Jobee'sLair, kept
  private for a week, not to Discord. After Report a bug, the card shows the report code to give in a Discord
  ticket.
- **About & credits** thanks Nick and all testers; the takedown line names this repository or a Discord ticket.
- **Support.** Support development opens Ko-fi (ko-fi.com/jvk3r), and after your fifth finished download a
  one-time thank-you says where to find it.

## 0.5.5 (2026-11-02)

- **Broken links, flagged for everyone.** When downloads find a game's link gone (HTTP 404 or 410), they tell
  api.jobees.org, and once two players have found it gone since anyone last downloaded from it, every console ranks
  that link last and says other players found the file gone; a download from it that finishes clears it. Only the
  catalog's own link is sent, with no console ID, and only with the anonymous stats on. This covers the host pages
  the console's own link check can't ask.
- **Downloads try again by themselves.** A busy or failing server (HTTP 429 or 5xx, and TorBox's own
  DOWNLOAD_SERVER_ERROR) gets two more tries, 3 and then 10 minutes later, before the download waits on you. Its
  card says so. A TorBox server error now says it was TorBox, instead of reading like a dead link.
- **Your download drive, remembered.** A game page starts on the drive your last download went to, while it is
  plugged in and has room (GitHub issue #2).
- **Archives inside archives.** A release whose archive holds another archive set (an .nfo beside .rar, .r00, …, or
  a .7z or .zip) is unpacked again from its first volume, and the game placed.
- **Expired host links.** A download waiting on its host's page opens that page from Downloads (Open host page),
  where the link is caught again; nobody is asked to type a file link any more.
- **PS5 packages that won't start.** A PS5 fake package from a source that never said it was one waits on Install
  above firmware 11.60, with the reason, instead of installing 30 GB that won't start (GitHub issue #2). Install
  still installs it.
- **Logs by themselves, if you say so.** The first time something fails, Jobee'sLair asks whether it may send its
  logs to the Jobee'sLair Discord when a download, unpack or install fails, or after a crash. Settings, About &
  credits has the switch and this console's report code, which matches a post to its logs. Reports now carry the
  engine's own log too, where a freeze shows.
- **Settings' longer hints** are no longer cut off in Hindi, Bengali and other languages.
- The anonymous stats now count each game install that worked or failed, with the step and the error code only,
  never the game or the console.

## 0.5.4 (2026-10-29)

- **The PS5 keyboard.** Searching, and typing a link or a TorBox or AllDebrid key, opens the console's own
  keyboard, in your language. Search shows its results once you finish typing. To keep the store's own keys,
  with results as you type, turn off PS5 keyboard in Settings, Look & feel. If the console's keyboard can't
  open, or the app closed while it was up twice in a row, Jobee'sLair goes back to its own keys by itself.
- **The phone companion, brought up to date.** Downloads, Homebrew installs and announcements now move on your
  phone as they happen, instead of the page asking every two seconds. The page comes in the console's language
  (Arabic and Urdu right to left) and changes with it. New on the phone: your Library with Fix it, removing a
  Homebrew app (keeping what it saved or not) and running its helper, Clear finished and Cancel all, choosing
  which source a game downloads from, and Triangle, Square, L2 and R2 on the remote. A phone that puts the page
  away stops listening, so the console stops sending to it.
- **Type on your phone instead of the controller.** Whenever the console asks you to type something (a TorBox or
  AllDebrid key, a catalog feed, a download's file link, a search), the same box shows at the top of the phone's
  page. Type or paste it there and press Send: it goes in as if typed on the console, and the PS5 keyboard closes.
  Close, or Back on the phone's remote, closes the PS5 keyboard without typing anything.
- **Settings on the phone.** Home, Settings on the phone sets your TorBox and AllDebrid keys (paste one in, test
  the connection, remove it), the download speed limit, whether parts continue by themselves, and updates (check,
  download and install, restart to apply). The phone is never shown more than a key's last four characters.
- **Pass a host's check on your phone.** A download waiting on the browser has Get the link here: open the host's
  page on your phone, pass its check, copy the link from its download button and paste it, and the console
  downloads from it. Sources that need the browser can be queued from the phone now too, and with a TorBox or
  AllDebrid key, the phone can send them through it, with no browser at all.
- **Smaller things on the phone.** A download that stopped has Other sources. A download finishing or stopping
  pops up on the phone, and the browser tab shows how far the current one is.
- **See whether a game starts for other players.** A game's Details now say on how many consoles it started, of all
  that tried it, and the same on your firmware ("Started for players: 31 of 33"), green when nearly all did and red
  when most didn't. The phone's game page says it too. The numbers come from consoles with "Share anonymous stats"
  on: each says how its latest launch of a game went (it started, or why not, and how the game was installed),
  without its ID, under a code that can't be tied to the console or to its other games. Settings, About says
  exactly what is sent.
- **Easier to see where you are.** The frame around what you're on is bolder, with a dark band that keeps it
  apart from the art under it. Homebrew's tiles showed almost no frame at all (growing the tile cut it off), and
  the Browse menu showed only a slightly lighter row: both get the full frame now. A focused game's genre line
  turns the accent color too.
- **Small corners.** Chips, tags, the search and Homebrew filters and the announcement bar have the same small
  corners as the buttons, and every focus frame follows the shape of what it frames.
- **Symbols and emoji.** Names and notes with symbols (arrows, stars, card suits) or emoji showed empty boxes.
  The app has fonts for them now.
- **Long text shown whole.** Some paragraphs stopped partway with "…": what "Share anonymous stats" sends, the
  legal notice, the credits, "Why won't it start?" and What's new, in Bengali, Hindi and Russian most of all, where
  sometimes half was missing. They're shown in full now.
- **A game that froze says so.** When a game froze and the console closed it, "Why won't it start?" showed only
  the system's error code (GPU_FAULT_SUSPENDPOINT_TIMEOUT...), which read like a failed install. It now says the
  game froze, that it installed correctly, and that another download of it from its page may run.
- **No stray "?" in Arabic and Urdu.** Homebrew app names ended in a "?" in a right-to-left language: the
  invisible mark that keeps an English name's punctuation in place was drawn as one. It draws as nothing now.
- **A 7z the console can't unpack is caught before it downloads.** Some uploaders pack a game with settings
  that need more memory to unpack than a console app can use. A RAR like that was caught in its first seconds,
  but a 7z keeps its file list at the very end, so you only heard "This archive can't be extracted on the
  console" after the whole download (128 GB, for one of you). Jobee'sLair now reads that list off the server
  before downloading, which takes a second, and moves on to the game's next source if there is one.
- **"Choose another source" instead of a Retry that can't work.** When a download stopped for a reason a retry
  can't change (an archive the console can't unpack, a password that doesn't work, a source missing parts), its
  card offered Retry, which failed again at once. The card and the game page now offer Choose another source,
  which opens the list of sources.
- **Games packed as an image inside an archive install.** When an archive held a disk image (an .exfat or
  .ffpkg), Jobee'sLair unpacked it into a folder inside homebrew, where ShadowMount doesn't look for images, so
  the game never installed and its card stayed on "Install requested". Images now go straight into homebrew,
  beside the ones you download directly, and any already stuck that way move there the next time Jobee'sLair
  opens. Thanks to qtrcipher for the detailed report.
- **exFAT games listed in "parts" install.** For about 60 games, one catalog lists a game's exFAT image as "part 1"
  and "part 2", but each part is a whole image (the same file twice, or two regions). Jobee'sLair downloaded every
  part and then failed trying to unpack them as one archive. Now part 1 is installed as the game, and the other
  parts aren't downloaded at all.
- **An archive listed as a disk image is unpacked.** A file listed as an exFAT image that was really a 7z (or
  RAR or ZIP) was handed to ShadowMount, which could only fail to mount it, and nothing said so. It's unpacked
  now, like any archive.
- **A tiny file instead of the game is refused.** When a host sent a file of a few kilobytes for a game listed
  at many gigabytes, it was treated as finished and ended as "not a game". It's refused now as "Not a game file",
  deleted, and the next source is tried if there is one.
- **Not enough room to unpack is said at the start.** As soon as unpacking learns how big the game really is,
  it checks the drive. Too little room stops it right away, saying how much is needed and how much is free,
  instead of running for hours first and throwing the work away.
- **Orbit Store's Mac download is gone from its files.** Orbit Store's list of files offered Orbit Zero's Mac app
  as if it ran on the PS5, and every install of it failed with "Archive contains an unsafe path, link or special
  file". It isn't offered anymore; the PS5 files (the app and its payload) install as before.
- **The time left while unpacking.** Unpacking showed the archive's size as the finished size, so an archive
  that unpacks bigger sat at 99% with "a few seconds left" that kept growing. It now shows the real size from
  the archive's own list (RAR, 7z and ZIP), and the time left follows the speed over the last half minute
  instead of jumping each time a file is saved.
- **No crash while many pictures load.** When a picture's saved copy turned out unreadable while lots of covers were
  loading at once, the store could close itself: it ran out of download slots. Pictures now wait their turn.
- **The stats count the phone companion.** With "Share anonymous stats" on, the five-minute ping also says
  whether the phone companion is on (and kept on while Jobee'sLair is closed), and since the last ping, how many
  minutes a phone had its page open and how many times one queued a game, installed or ran something, used the
  remote and so on. Counts only, never what. Settings, About says exactly what is sent.

## 0.5.3 (2026-10-26)

- **PS5 packages install.** Homebrew apps that ship as a PS5 package (PS5Library, ezRemote Client's package,
  Spectrum Library's) failed every time with "The file is not a PKG": the installer only knew PS4 packages.
  It installs both now. Whether a PS5 package's app starts afterward is up to the jailbreak's fpkg support.
- **Spectrum Library installs again.** Its newest release held only a 4-byte file reading "soon", and Install
  downloaded that. Jobee'sLair now passes over a release like that for the one before it (1.4.8), and refuses
  a file that small with a plain message instead of downloading it.
- **A failed Homebrew install says so.** After an install failed, the app's page kept saying "Installing" with
  a Cancel that did nothing, and its tile said Installing too, until Jobee'sLair was restarted. The page now
  says why it failed and offers Try again, and the tile says Failed.
- **Homebrew installs that were cut off install again.** Closing Jobee'sLair while an app was unpacking (RPCS3
  and RetroArch take a while) made every later try fail with "Staging belongs to another extraction". What
  the cut-off unpack left is now cleared before the next one starts. Jobee'sLair's own updates get the same
  fix.
- **Homebrew installs wait for a game to extract.** Installing a Homebrew app while a game download was being
  extracted failed with "An archive task is already running": the console extracts one archive at a time. The
  install now waits its turn and says so, and Jobee'sLair's own updates wait the same way.
- **Switching to an app's other file.** Installing an app's package after its payload (Spectrum Library has
  both) left the payload on the console, where Remove couldn't find it. It's deleted once the package is in.
- **Cancelling a download doesn't wait on a clean-up.** Right after Jobee'sLair opened, a cancelled download
  could sit on "Removing" for minutes: the console deletes one thing at a time, and the leftovers of a removed
  Homebrew app (RetroArch's 19,462 files) were being deleted first. Clean-ups now run beside your own deletes,
  never in front of them.
- **Downloads scrolls back to the top.** With an announcement up, the Downloads page opened with the first
  download's buttons below the screen, and once you moved down to a second download it never scrolled back to
  the top. The first download now shows whole, and Up from it reaches Clear finished and Cancel all, now beside
  the library band, and the top of the page.
- **Removed apps are really gone.** Closing Jobee'sLair right after removing a Homebrew app (or right after an
  update replaced an old image) could leave its files behind for good, taking up space. Whatever is left over
  is now deleted the next time Jobee'sLair opens.
- **Missing game pictures.** 26 games showed only their name where the picture goes (7 Days to Die, Alien:
  Rogue Incursion, Remnant 2, CODE VEIN II, NBA 2K21 to 2K23, Madden NFL 22 and 23...). They have their
  PlayStation Store art now, and Sonic Unleashed Recompiled's picture, whose link had died, comes from another
  copy.
- **PS5Library installs whole.** Install gave you only its agent payload; it installs the PS5Library app now,
  with the agent beside it: press Run helper after each console restart, as its author says.
- **Install errors in plain words.** A failed package install no longer shows the file's path twice and cuts
  off the error code; it says what went wrong (not a package, no ELF loader on port 9021, or the console's own
  code). The online stats get the same reason, without the path.
- **ShadowMount lets go of Jobee'sLair.** Closing Jobee'sLair and opening it again within a few seconds could
  leave ShadowMount+ holding its image ("Device busy" to every unmount, and updates that never applied) until
  ShadowMount was restarted. The console leaves Jobee'sLair's sandbox folder behind when it closes, and
  ShadowMount+ waits for that folder before it lets go; Jobee'sLair's clean-up now removes it within a second
  of the close instead of three, keeps going if the app is opened again, and clears at launch what a crash or
  an earlier close left. It also starts as the app opens, not once the store has been up for 8 seconds, so
  closing it on the intro or the startup notice is covered too.
- **The Discover carousel shows top games.** It showed the same five games every launch: it only took games
  from Archive.org, and just 7 had the art for it. It now shows five of the most popular, best rated games, a
  different five each launch and one per studio, and the Featured row under it no longer repeats them. Cross
  on a thumbnail opens that game.
- **Discover shows more games.** Featured, Ready for 13.60 and Popular now all opened with the same eight
  games. Each row now shows games the rows above it don't, and Popular now is the most played games on
  PlayStation (Rocket League, GTA V, Red Dead Redemption 2...).
- **Search the Homebrew section.** A "Search homebrew" field sits at the top of the Homebrew section (press Up
  from the spotlight). It searches the Homebrew apps alone, by name, maker or category, in your language too.
  The top menu's Search opens on Homebrew while you're in that section.
- **Back keeps your place.** Back from a Homebrew app's page goes back to the grid, the sort and the app you
  opened, not the top of the section. Back from a search result goes back to your results, with their side
  (Games or Homebrew) and filters, instead of an empty Games search with the keyboard up. A game opened from
  Quick Preview goes back to its card.
- **Homebrew updates keep your build.** Updating an app whose files are named after their version (EVO Player,
  PS5MC, Lineup) could swap in another of its builds (EVO Player's plain build for the "-pro" one) and left
  the old image next to the new one, two copies of one app for ShadowMount. An update now installs the
  build you have and removes the old image.
- **Smoother.** Pressing Continue at the start no longer freezes the screen: the rows further down Discover
  are built once the reveal is over. The catalog check at launch is skipped when nothing changed (most
  launches) and no longer stutters when something did, L1/R1 switch sections faster, and covers that arrive
  late fade in.
- **Smaller fixes.** A game page's Back link names where it goes (it said "Library" from every store section,
  and "game.back.files" from the Library). A game's and a Homebrew app's details (platform, publisher, release
  date and so on) are in your language; a game's were always in English. The empty Downloads page no longer
  covers its stats while an announcement is up. In Arabic and Urdu, the section's name at the bottom of the
  screen no longer sits on top of the button hints, and a Homebrew app's English description keeps its
  punctuation at the right end.

## 0.5.2 (2026-10-25)

- **Jobee'sLair online.** The bottom bar shows how many people are on Jobee'sLair right now, and announcements
  from Jobee'sLair sit in a bar under the top menu on every section until they're taken down; with a few up, they
  take turns, warnings first (Settings, About & credits shows them whole). To help decide what to test and fix,
  the app shares anonymous stats every five minutes while it's open: a random ID made on the console, the app's
  version, the firmware and the language, plus which Homebrew apps install or fail (without the ID). Never your
  PSN name, the console's own ID, your games or your downloads, and IP addresses aren't kept. Turn it off in
  Settings, About & credits; the count and announcements still come, with nothing sent about the console. The
  server is a Cloudflare Worker at api.jobees.org (tools/online).
- **Fix it.** A game or Homebrew app that won't start has a Fix it button: ✕ on its Library tile, in its
  Options, and in "Why won't it start?". It reads ShadowMount's log first and tells you where things stand:
  not started yet (start it once first), started fine last time (nothing to fix), or what it changed. The
  fixes are the two that used to be manual: opening the game's files so the console can run them, and its
  backport's too, and turning off the game's own fakelibs when they may be what crashes it, but only on a
  console new enough for the game. Then you start it from the home screen. If it still won't start, the next
  press turns fakelibs back on for one more try; after that it points you to "Why won't it start?".
- **Backports can run.** A backport's files are now opened when it's placed, the same as a game's, and
  backports placed by earlier builds are opened once the next time the app starts.
- **Homebrew apps and games copied over FTP say whether they start.** Their Library tiles now show Won't
  start or Played from ShadowMount's log, like the games Jobee'sLair downloaded.

- **L1 and R1 stop at Browse.** They stepped from Discover straight to Top rated, so Browse could only be
  reached with the D-pad. Browse is now a section of its own, the whole catalog A to Z (its menu still picks a
  genre), and "All games" in its menu lights Browse instead of Discover.
- **Games stay in the Library after a 33rd download.** Starting a download with 32 others in Downloads took
  every finished game out of the queue: their tiles turned into loose files, Make Room could no longer move
  them, and deleting one left its backport behind. Finished games now only leave Downloads, as ✕ does.
- **TorBox being down says so.** When TorBox answers with a page instead of its API (it did for a while on
  2026-10-25), the error now says TorBox isn't answering, instead of a bare HTTP code.
- **Sets sent through TorBox stay with TorBox.** While part 1 of a set downloaded through TorBox or AllDebrid, the
  app opened the console's browser for part 2 as if it had to pass the host's check, then took the link it caught
  there instead of the service's. Every part now comes from the service, one after another.
- **New games have their pictures.** A game the live catalog adds took its picture from the Pegasus catalogs, and
  some of those are WebP files the console can't draw (MediEvil Resurrection, Jak and Daxter, Planet Zoo), so
  their tiles stayed blank. They now get the PlayStation Store's own cover, like every other game, and its
  background on their page. This comes through the live catalog, so 0.5.1 gets it too.
- **Moving a big game says when it won't fit.** Before a move, only a game's first 20,000 files were counted,
  so a game with more could start moving to a drive without room and fail partway (the game itself stayed
  where it was). The copy counts every file before it starts, and the move now stops right away and says how
  much more room it needs.
- **The update dialog remembers that you closed it.** 0.5.1 saved which release it had offered, then
  refused to read that note back at the next launch and set it aside as "unreadable". Once a new release
  was out, its dialog would have come back at every launch, however often you closed it. Every saved file
  is now listed with its shape, and a test catches one that isn't.
- **The screen saver keeps its pictures after a download.** After a game downloaded, about two pictures in
  three failed to load for the rest of the session ("out of memory for decoded pixels") and the screen saver
  sat on black for hours. Once a picture fails, it now shows one at a time, as it already did while a game
  extracts. When a picture can't be decoded, the app also lets go of the art it was keeping for later, so
  the retry a second later has room.
- **Homebrew updates keep your saves.** Updating an app replaced its whole folder and deleted the old one,
  along with anything the app kept inside it: an emulator's saves, settings and caches. PS5X360's update from
  0.6.0 to 1.0.0 lost its Xbox 360 profile that way; only a folder the app couldn't delete kept it on the
  console. An update now puts the new version's files into the app's folder, replacing only the files the new
  version has, and leaves everything else where it is. It also stays on the drive the app is on: with the
  internal drive short of space, an update used to go to another drive as a second copy, without the saves.
  When that drive has no room, it now says so and changes nothing, and an update that can't finish puts back
  the version you had.
- **Removing a Homebrew app asks first.** When an app has saved things in its own folder, Remove (on its
  page, or ▢ on its Library tile) asks whether to keep them. Kept, they wait in homebrew-saves on the same
  drive and go back into the app's folder when you install it again, which installs it on that drive. An app
  installed before this version is kept whole, because nothing told its own files from its saves; installing
  it again brings back only the saves. Anything that can't go back in is set aside, never deleted, and if the
  app itself can't be removed, its saves go back into its folder.
- **PS5X360 updates install again.** What that earlier update left behind stopped every later one ("Existing
  extraction has no matching, valid completion receipt"). It's now moved to downloads/homebrew/kept and kept,
  and a leftover folder that won't clear can't stop an install any more.

## 0.5.1 (2026-10-22)

The release where far more of the catalog actually plays. Every game that comes down as an archive, which is
most of the catalog, was unpacked with files the console refuses to run: the game installed, showed up on the
home screen, and died with "Can't start the game or app". That is fixed for new downloads and for the games
already on your console. With it: a live catalog with real ratings and no duplicates, "13.60 Ready" on every
game page, AllDebrid and torrents, Report a bug, and updates that offer themselves. Pre Release 1 and 2 went to
the Discord the same day.

Re-released on 2026-10-23 with three fixes from the first console to take it:

- **The update installs.** "The update did not install: updater.elf did not answer" on the first console to
  take 0.5.1. The updater had answered; a system library had written a line of its own to the same socket
  first ("[SceLncUtil] … getAppStatus"), the app read that as the answer, withdrew the update, and the updater
  quit. Answers are now read line by line past such lines, for the updater and the relauncher alike.
- **A new release is offered within the hour.** The launch check reused the previous hour's "nothing new", so a
  release published since went unoffered and the dock showed nothing. An answer that found nothing is asked
  again at every launch.
- **The update dialog's progress bar stays in the dialog.** It drew its fill across the dialog and past it: the
  engine ignores transforms on elements wider than 512 px and clips nothing it moves. The fill is now a view as
  wide as the progress, for every progress bar in the app.

- **A live game catalog.** Games are now pulled from the public Pegasus catalogs (pegasus-dl.dev) and
  refreshed every three hours. A newly added game shows up the next time you open the app, with no app update
  needed. This adds about 150 games and thousands of new download links.
- Multi-part downloads from these catalogs stay grouped together, and they never save as a file called "file".
- **No more duplicate games on Browse.** The PS4 and PS5 versions of a game, and regional copies of the same
  store listing, now show as one card in every row and in the full grid. Download still asks which version you
  want, and picking PS4 or PS5 in the filters still shows that platform's copies. Search still lists every copy.
- **Top rated, for real.** Every game now has its PlayStation Store star rating (about 2,200 rated, up
  from about 100 with a Metacritic score). Top Rated sits right under Featured and ranks by stars and by how
  many people rated, so a 4.9 from 40 people doesn't beat a 4.8 from 70,000. Stars show on game cards and
  on each game's page. Ratings update with the live catalog.
- **Icons that vanished are back.** The star on every card used up the engine's 128 icon slots, so the
  button hints at the bottom, the Favorites, Downloads, Library and Settings tabs and some of the stars drew
  nothing until something scrolled away. Stars are now drawn as text and take no slot.
- **13.60 Ready, said at once.** A game's page now shows "13.60 Ready · 3 links" in green beside its rating
  (or "No 13.60 Ready links") the moment it opens, the chosen source's line leads with its tag, up to three
  other sources that run on your console sit right under it, and a plain "More download links (12)" opens the
  full list. No more opening the list to find out.
- **Updates offer themselves.** When a newer Jobee'sLair is out, the update window opens by itself at launch
  (once per release, like Prospero Store): Download and install, then Restart to apply. It comes back on its
  own once the download is ready. Close it and only the badge in the top bar stays.
- Search lists every copy of a game again (the PS4 edition had dropped out of search results in an earlier
  0.5.1 build), and a game page's "Ready" count leaves out links the check found gone.
- **Settings is calmer.** Each row shows its name and its state; what a setting does appears under it only
  while it is selected. The paragraphs about debrid, feeds, the credits and the legal notice are folded
  behind a row or gone.
- **Clear finished and Cancel all** at the top of the Downloads page. Cancel all asks for a second press.
- The Downloads page scrolls all the way back to the top again. With two rows of cards in a section it stopped
  short, leaving the library band and the telemetry cut off.
- A card's focus frame no longer blinks on every step along a row: it is solid from the first frame, and on
  the wide Featured cards it now lifts and grows with the card instead of staying put under it.
- Side sheets (sources, options, "Why won't it start?", Make room) slide out as they close instead of
  vanishing, and the hero banner crossfades to the next game instead of cutting.
- **The screen saver fills the screen again.** An earlier 0.5.1 build drew its pictures at 1280 x 720 in the
  middle of the screen. While a game extracts it shows one picture at a time, which is what the memory then
  allows.
- **The screen saver skips a picture it can't show** (a host not answering, or no memory to decode it while a
  game extracts) instead of leaving the screen black.
- **AkiraBox fixed.** Many AkiraBox links were labelled "part 1, 2, 3" when they were really separate whole
  files (Astro Bot USA: two complete RARs and an FFPKG), so the download waited for a "part 1" that didn't
  exist. Links are now grouped by their real file names.
- **Rootz downloads without the browser.** Rootz links (about 1,800 in the live catalog) now go straight to
  the file instead of opening the browser.
- **"Ready" fits your firmware.** On 11.60 or lower, PS5 fake packages start, so those games count as ready
  too, and the row and filter say "Ready for 9.60" (or whatever your console runs). On 13.60 nothing changes.
- **Cancel works while a game extracts.** Cancelling during extraction could hang on "Pausing…" forever, and
  a retry afterwards could fail with "Staging belongs to another extraction". Both are fixed.
- **Deleting a game no longer holds up your other downloads.** Downloads pause only for the moment ShadowMount
  is asked about the game, not for the minutes a big game's files take to delete. Deleting a download also
  removes its half-extracted files, which used to be left behind.
- **The screen saver no longer runs out of memory** while a game extracts.
- **Games packed beside a backport folder install.** A download holding the game folder next to a "backport"
  folder (Assassin's Creed Black Flag Resynced) stopped at "Extracted" and never reached ShadowMount. The game is
  now found and installed, and the backport is kept aside. A download already stuck there gets an Install button.
- **AllDebrid support.** Add your AllDebrid API key in Settings → Debrid providers, next to TorBox. Sources it
  supports get a download button that skips the browser. If both keys are set, TorBox is used.
- **Extracted games start.** A game folder unpacked from an archive could not be started: the home screen said
  "Can't start the game or app" with every file in place and nothing in ShadowMount's log past "sandbox ready".
  The extractor wrote files without the execute bit, and the console refuses to run an eboot.bin without it.
  Extracted files are now rwxrwxrwx like everything copied over FTP, a game folder is opened when it is put in
  place, and games installed by earlier builds are opened each time the app starts. Fakelibs had nothing to do
  with it. (Minecraft Dungeons, Assassin's Creed IV Black Flag.)
- **Jobee'sLair Homebrew, a build of its own.** The Homebrew section can be built alone (`packaging/homebrew-edition.sh`,
  `app/edition.js`): Jobee'sLair Homebrew, title PPSA99472, with its own dock (Homebrew and Settings), its own
  repository for updates and its own image, installing beside the store. Its index now lives and refreshes in
  [JVK3R/JobeesLair-Homebrew](https://github.com/JVK3R/JobeesLair-Homebrew), which every build reads.
- **Torrents through debrid.** A feed can list a magnet link as a source. With a TorBox or AllDebrid key set
  it downloads in Jobee'sLair: the service fetches the torrent, the console downloads from it at full speed,
  and "TorBox Instant" marks torrents TorBox already holds. A one-file torrent downloads as that file; a folder
  dump of many files comes as one zip through TorBox and extracts like any archive. Without a key, the Torrents
  section says what to add. See FEEDS.md.
- **New this week.** A row on Browse with the games the live catalog added in the last seven days, best rated
  first.
- **Report a bug.** Settings → About → Report a bug sends your logs to the Jobee'sLair Discord in two presses.
  They go through a small relay (tools/report-relay) that holds the channel's webhook, so no build carries it.
  Keys and passwords are blanked out.
- **Turn off fakelibs per game.** Many backported downloads bring their own fakelibs (system libraries for
  older firmware), and on a console new enough for the game they can make it crash (CE-107098-5). Open the
  game in the Library, press Options, and turn them off; it applies the next time you start it. "Why won't it
  start?" points to this when a game loaded its own fakelibs.

## 0.5.0 (2026-10-20)

The biggest Jobee'sLair update yet.

### New

- **Homebrew section.** Browse and install 200+ PS5 apps and emulators (PS5SX2, Stremio, RetroArch and more) straight from their authors' own releases. Updates show up on their own, and installed apps appear in your Library with their name and picture.
- **Helpers for emulators.** Apps that need a payload loaded first (PS5SX2, XPSemu, Ruffle, VITA5) get it installed with them. Press **Run helper** on the app's page after each console restart.
- **New phone companion.** Scan the QR code in Settings → Phone companion to watch your downloads, manage the queue, run payloads and send a log if something goes wrong, all from your phone.
- **New search.** A cover grid with Games and Homebrew tabs and a pop-up keyboard.
- **"Ready for 13.60" row and a Format filter.** Find games by folder dump, .exfat, FFPFS, backport or fPKG.
- **Downloads in parts keep going on their own.** The next part's link is grabbed while the current one downloads, and parts that need the browser open by themselves.
- **Sizes before you download**, even when the catalog doesn't list one.
- **Screen saver** after 10 minutes idle, showing how your download is going.
- **Settings is its own section**, with categories down the side.
- **A home-screen background.** Hover Jobee'sLair on the PS5 home screen to see its new art.

### Fixed

- **ShadowMount no longer says "Device busy" after you close Jobee'sLair.** It releases the app a few seconds after it closes, so refresh, unmount and delete work without reloading ShadowMount.
- The **✕** on a finished download only clears the card. It no longer uninstalls the game.
- Homebrew apps that closed straight away ("Couldn't start app or game") now start.
- Top Rated, New Releases and Favorites work from the Search page.
- A download in parts that finished but wouldn't extract ("missing parts") now says which part is a copy, and Retry re-downloads just that part.
- Settings no longer freezes when you change phone companion options.
- Pages scroll all the way back to the top.

The pre-release notes below list every change in detail.

## 0.5.0 Pre Release 4 (2026-10-19)

### Added
- **A QR code for the phone companion.** Settings → Phone companion shows the address as a QR code: point the
  phone's camera at it instead of typing an IP.
- **Report a problem from your phone.** The phone page's Home has **Share log**, **Save log** and **Copy log**:
  the console's debug log (keys, tokens and e-mail addresses already blanked out), ready to send with a bug
  report on Discord. No FTP needed.
- **The next part gets ready while one downloads.** In a download in parts, when a part starts downloading and
  the next one needs the browser, its browser opens after the 10-second countdown (Wait stops it) and its link
  is captured right away, so the set goes on to it without stopping. A link that expired by then asks for the
  browser again, as before.
- **Sizes before you download.** A source the catalog lists without a size shows the one its file link reports
  when the background link check reaches it.
- **A screen saver.** After 10 minutes without a button press, a slideshow of the most popular games'
  screenshots (from their own store pages, loaded like the store's art), the time, and how a download is going.
  Any button brings you back. Off, or shown now, in **Settings → Look & feel**.
- **"What's new in 0.5.0"**, shown once after the store first comes up.
- **A background on the PS5 home screen.** Hover Jobee'sLair there and it now shows its own art behind it (a
  4K picture, `pic0.dds`, the same kind PS5SX2 and Prospero ship), not just the icon.

### Fixed
- **The ✕ on a finished download no longer uninstalls the game.** In the Downloads list it now only clears the
  card (for installed, downloaded and failed-to-install items); the game stays in the library, where deleting
  it is done. A card still downloading, paused or failed keeps its Cancel, which deletes its partial files. The
  phone's Clear works the same way.
- **Top rated, New releases and Favorites did nothing when pressed from the Search page.** The search page's
  sort menu used the same focus name as the store's, so the header's buttons sent focus to a page that was
  closing. Leaving Search through those buttons also put back the filters you had before searching,
  undoing the Favorites button. Both fixed.
- **Homebrew apps that closed as they opened ("Couldn't start app or game"): PS5SX2, the Wii U / 3DS / DS
  emulator (PS5CEMU-HAR) and others.** ShadowMount mounted them but the console never ran them: the app
  folders were unpacked as `rw-rw-rw-`, and the console can't start an app it can't execute. Prospero and an FTP
  copy leave every file `rwxrwxrwx`; Jobee'sLair now does the same when it installs an app, and opens the
  folders of apps it installed earlier once, the next time it starts.
- **Installing a homebrew app no longer throws you down its page** when the install starts and when it
  finishes. The Install button turned into a different button each time, so focus jumped to whatever was nearest
  below; it is now the same button throughout.
- **ShadowMount said "Device busy" after Jobee'sLair closed, and wouldn't refresh, unmount or delete until it
  was reloaded.** Every launch left its sandbox folder behind with `/data` still mounted in it (three stacked
  aliases), and ShadowMount waits for that folder to go before it lets go of the title. A small helper
  (`sandbox-sweeper.elf`) now waits for the app to close, takes those aliases down and removes the empty
  folders, so ShadowMount releases Jobee'sLair a few seconds after it closes. It only unmounts aliases, only
  removes empty folders, stops if the app opens again, and logs to `/data/ps5-react/PPSA99471/logs/sandbox.log`.
- **"Device busy" in ShadowMount after installing, updating or removing a homebrew app.** Jobee'sLair renamed
  and deleted the app's folder while ShadowMount still had it mounted, leaving a stale mount that made every
  refresh and unmount answer "Device busy". ShadowMount is now asked to let go of the app first.
- **Helpers.** Apps that need a payload loaded first (PS5SX2, XPSemu, Ruffle, VITA5) now get it installed with
  them. On the app's page, **Run helper** works only once the app is on the home screen (ShadowMount has
  mounted it), it says when it was last run and to run it again after every console restart, and **Remove
  helper** deletes its file, and **Install helper** brings it back (the button used to vanish with it, leaving
  no way to run the helper again). (A helper already running can't be stopped from the app: it ends when the console
  restarts.) Apps that need other setup (PSXS5, PSP5, 5S2CD, Prospero Multi Tools, PS5CEMU-HAR) say so on
  their page.
- **Homebrew apps in the library show their name and picture** (PS5SX2, Stremio and the rest) instead of a
  file name and an empty tile. Jobee'sLair's own image is no longer listed there, so it can't be deleted by
  mistake.
- **A homebrew app deleted by hand** (FTP, the library) is no longer listed as installed.
- **On the phone, Share log and Copy log now work.** The log is fetched ahead, because a phone only shares or
  copies from the tap itself, and over a plain http address (the console's) the browser has no share sheet:
  those buttons then open the log on screen, ready to select, with a Save button.

### Changed
- **A shorter startup notice.** The terms of use that open the app are now three plain sentences (free and
  open source, hosts no games or files; download only what you own or may use; no warranty) and "By
  continuing, you agree to these terms", without the shouted headings.

## 0.5.0 Pre Release 3 (2026-10-19)

Fixes from the first beta testers, games by format, a new search and Settings, and the Homebrew list from
nexgen999's PS5 Repository List.

### Fixed
- **Getting stuck in Settings.** Turning the phone companion's switches on or off (or changing the PIN) made
  the app wait for the closed-app helper's answer, and the whole app froze, sometimes for many seconds:
  nothing moved and Circle did nothing. It no longer waits. Dialogs opened from Settings also give focus back
  to the row they came from.
- **A download in parts that finished but would not extract ("missing parts").** On a browser host, the
  link of the part before could be captured again for the next part, so one part was downloaded twice and
  another not at all. A captured file whose name says it is another part is now refused, and the capture
  keeps watching for the right one. A set that already has a copied part now names it ("Part 4 is a copy of
  part 3"): **Retry** downloads that one part again, not the whole set.
- **Pages that would not scroll back to their very top.** Going up now always shows the title or header
  above the first button, on every page.
- **The donation QR code can be scanned.** Opening it in Settings → About now scrolls the whole code into view
  and keeps it there; before, scrolling either way cut half of it off.

### Added
- **"Ready for 13.60":** a new row on Discover with every game that has a folder dump or a disk image, what
  ShadowMount+ runs on 13.60 (648 of them in the bundled catalog). **See all** opens them in the library.
- **A Format filter** in the store's filter sheet and on the search page: 13.60 Ready, .exfat Image, FFPFS
  Image, Backport, FPKG. It sorts each game's sources with the same rules as the badges on its sources.
- **Parts continue by themselves.** When a download in parts reaches a part that needs the browser, the
  browser opens for it after a 10-second countdown on its card (**Wait** stops it). Turn it off in **Settings
  → Downloads**. The card's button opens the browser for that part directly.
- **From your phone:** a part waiting on the browser has an **Open on console** button, and the phone shows
  which part is downloading.
- Download cards show the **file's format** (from the file itself once it starts) and **which part** of a set
  is downloading.

### Changed
- **Settings is a section** like Downloads and Library: the gear in the island, or L1/R1, opens it, and
  Circle goes back. Its categories are on the left (Phone companion, Downloads, Catalog feeds, Debrid,
  Look & feel, Guide, About), their settings on the right.
- **A new search page, built on the store's cover grid.** The search field with **Games | Homebrew** tabs,
  then chips for 13.60 Ready, each format and favorites, the filter sheet and the sort, then the results as
  covers. The keyboard pops up over the bottom while you type and closes when you search (R2) or press Circle,
  so the results get the whole screen; Triangle brings it back.
- **The Homebrew list comes from nexgen999's PS5 Repository List**, with his permission. A project he adds shows up
  in Jobee'sLair within hours (the list is checked every six hours instead of once a day), sorted into our
  categories. His credit is in the Homebrew section's header, its footer and the README. YouTube Max'd is the
  first new app it brought.

## 0.5.0 Pre Release 2 (2026-10-19)

The first fixes from testing Pre Release 1 on a console, and a clearer, easier interface.

### Fixed
- **Homebrew rows scroll sideways again.** Each row had grown as wide as all its apps, so there was nothing
  to scroll and the apps past the edge could not be reached.
- **An app's page in Homebrew scrolls all the way back to the top.** Going up stopped at its buttons.
- **The phone companion no longer asks for a PIN it then refuses.** When Jobee'sLair closed, the phone's page
  showed the PIN card from the closed-app helper, took the PIN, then stayed on the card. It now switches to the
  helper's page by itself, and back to the full companion when the app opens again.
- **Pictures that never appeared** in Homebrew ("the engine image registry is full" in the log). The engine
  now keeps room for them, and a picture refused that way is asked for again instead of given up.
- The closed-app helper now confirms it started (a system library's own log line came back first, in place of
  its answer).

### Changed
- **Stay signed in on your phone.** A phone that signed in stays signed in when Jobee'sLair restarts and when
  the closed-app helper takes over. Changing the PIN still signs every phone out.
- Wrong PINs on the closed-app helper no longer freeze it for everyone while it waits; three are free, then
  each try waits a little longer.
- **Homebrew has its own color** (green, or amber with the emerald theme): the island item and the pill under
  it, the section's new header, its rows, chips, buttons and focus. The store keeps the theme's color, so you
  always know which side you are on.
- **"Where you are" at the bottom left:** the bar under every store and Homebrew page starts with GAME STORE or
  HOMEBREW, in that side's color.
- **The island's icons say what they are:** focusing favorites, downloads, the library or settings shows its
  name under it.
- **Homebrew rows end with a "See all" tile**, show how many apps they hold, and "Most popular" and "Fresh
  releases" open the whole list sorted that way.
- **Sort any Homebrew grid with Square** (most popular, newest release, A–Z); **Triangle** goes back to the top.
- An app's page shows where it is (Homebrew › category), and grows to fit its buttons instead of cutting them.

## 0.5.0 Pre Release 1 (2026-10-19)

A test build of 0.5.0: the Homebrew section and a new phone companion. Not a release yet.

### Added
- **Homebrew, its own section next to the store** (the new **Homebrew** item in the top island, or
  <kbd>L1</kbd>/<kbd>R1</kbd>). 210 open-source PS5 apps, emulators, ports, players and payloads, each with its
  own icon, banner and screenshots, in 13 categories, with search. Every one installs straight from its
  author's own GitHub release; Jobee'sLair hosts none of them.
  - **Apps** (a disk image, or an app folder in a .zip) go into `homebrew/`, where ShadowMount+ puts them on
    the home screen once you close Jobee'sLair.
  - **Payloads** (.elf/.bin) are kept on the console and run through your ELF loader with **Run**.
  - **Updates:** a newer release of anything you installed shows as **Update** on its tile and as a count on
    the island's Homebrew item. Apps you installed by hand are recognised too.
  - The list refreshes itself every day from this repository, so new releases arrive without a new
    Jobee'sLair.
- **A new phone companion.** Five tabs: **Home** (the download in progress on a live ring with its speed
  graph and time left, the queue, the drives, homebrew updates with **Update all**, shortcuts on the
  console, and the catalog feeds), **Games**, **Homebrew** (browse, install, update and run homebrew from
  your phone), **Queue** and **Remote**.
- **The phone page while Jobee'sLair is closed** (experimental, off by default: **Settings → Phone companion
  → Keep it on when Jobee'sLair is closed**). A small helper answers on the same address with the same PIN:
  open Jobee'sLair from your phone, see the queue, and run installed payloads.

### Changed
- The store's Homebrew row is now a banner that opens the Homebrew section.

## 0.4.1 (2026-10-18)

**Install this one by hand:** copy the new `JobeesLair.exfat` over the old one in `homebrew/`. Updating from
inside the app can't cross this change.

### Fixed
- **Jobee'sLair can now be installed next to Overdrive.** The two shared one app ID, so the console treated
  them as the same app and only one could be installed at a time (and they wrote to the same saved queue
  file). Jobee'sLair now has its own ID.

### Update note
- Your **download list and play time carry over**. **Settings, favorites, feeds and your TorBox API key start
  fresh**, so set them up again. The old home-screen icon can be deleted.
- This is the one update that has to be done by hand. Updates install themselves again from here on.

### Changed
- A shorter README and installation guide, with new screenshots.

## 0.4.0 (2026-10-18)

A stability release: nothing new to learn, but the app is faster, fully translated and easier to debug.

### Changed
- **Every language is complete.** The 13 translations covered only the first release's screens, so about
  half the app (Library, Make Room, link health, TorBox, browser capture, updates and more) showed in
  English. All of it is translated now.
- **A new reveal after the startup notice.** Sparks spiral into the middle of the screen, the JL mark pops
  out of them with a flash, then flies into its place in the top island as the store fades in.
- **The version is always in sight:** a small tab under the logo in the top island (`v0.4.0`), not
  only in Settings.
- **Faster catalog search and filters.** A search does about a third of the work it did, the filter sheet
  about a third when you change a filter, and nothing at all when it redraws with nothing changed.
- **Faster source lists.** Ranking a game's sources does less than half the work it did, and TorBox's list of
  supported hosts is prepared once instead of on every check.

### Fixed
- When the console's browser could not be opened for a browser capture, the download stopped with only
  "needs a web browser". The real reason is now shown.

### Added
- **A debug log** at `/data/ps5-react/PPSA99058/logs/jobeeslair.log`, readable over FTP. It is kept
  small (about 1 MB at most), and API keys, tokens, email addresses and link query strings are blanked out
  before anything is written.

### For developers
- The app's tests live in `tests/` and run with `npm test` (logic) and `npm run test:render` (screens),
  needing only Node.js 22. They run on every push and pull request, and before every build.
- The tests now also check that every language has every string with the right placeholders, and that
  no app code uses JavaScript date features the console's engine lacks (the cause of a freeze at startup
  in an early 0.4.0 pre-release).
- The download queue is split into smaller modules: browser capture (`capture-flow.js`), moving games
  between drives (`queue-moves.js`) and the checks a download passes before ShadowMount+ sees it
  (`payload-checks.js`).
- Removed leftover code for hosts the app once stopped supporting, and unused strings.

## 0.3.0 (2026-10-18)

### Added
- **No typing links with the controller.** For a host only the console's browser can get past, pass its
  check and Jobee'sLair catches the file link out of the browser by itself, checks it is the game's file,
  and downloads it in the app. A file that names no game is shown to you first. Typing the link in still
  works if a capture fails.
  - **VikingFile is back**, and many games gained sources.
  - **FileKeeper** downloads with no browser step at all.
- **Learns which hosts work on your console.** Hosts that work are marked **Auto-capture** and ranked
  first; hosts that keep failing are marked **Rarely works here** and ranked last. Nothing is hidden.
- **TorBox (optional):** add your API key in Settings → Debrid providers. Sources on hosts TorBox
  supports get a **TorBox** button, and **TorBox Instant** marks files TorBox already holds.
- **Download speed limit** in Settings: no limit, 25, 10 or 5 MB/s. App updates are never limited.
- **13.60 compatibility badges** on each source (Folder Dump, .exfat Image, FFPKG, FFPFS Image,
  Backport, and **FPKG (<=11.60)** for fake packages that don't launch on 13.60).
- **Tips under the Download button** when they matter: backport files only, DLC, a label asking for newer
  firmware, or what to do on a browser host's page.

### Changed
- Link health no longer hides sources. A link that looks gone is tagged **Broken link** and ranked
  last; one that doesn't answer is tagged **Offline**.

### Fixed
- Files whose format the catalog doesn't state are routed by their header or name. A web page sent in
  place of a game fails as "Not a game file" instead of finishing as a useless `.binary`.
- "Backport files" downloads are no longer grouped into broken multi-part sets.

Thanks to MyLuxy (Overdrive) and saawant12 (Orbit Store).

## 0.2.3 (2026-10-17)

### Added
- **Link health:** a game's download links are checked in the background (one HEAD request each, only
  while no download needs the network), and **Check link health** checks them all at once.

### Fixed
- The free-space check now also works for downloads of unknown size: it runs again as soon as the
  server reports the size, and offers Make Room if it won't fit.
- In-app updates confirm they started as soon as the app opens, and a release whose files don't match
  its tag fails once instead of looping.
- Game pages are faster: "More like this" is worked out once per game.

## 0.2.1 (2026-10-16)

### Added
- **One-click updates:** Download and install, with each file checked against GitHub's SHA-256, a
  safe swap by a small updater, and an automatic rollback if the new version doesn't start.
- **Install updates automatically**, and an update badge in the top island.
- **Support development** in Settings → About (optional; nothing is locked).

### Fixed
- Settings could freeze while feeds refreshed.

## 0.2.0 (2026-10-16)

### Added
- **Library** with art, install status and play time; **Make Room** to free space on a drive;
  **moving games between drives** with verified, resumable copies.
- **Launch diagnosis** ("Won't start · See why") and ShadowMount+ health on library tiles.
- **Download checks** before ShadowMount+ sees a game, and **backports** placed in
  `homebrew/backports/<TITLE_ID>/`.

### Changed
- Delete from disk removes everything that belongs to a download, then uninstalls it from ShadowMount+.

### Fixed
- Archives holding several images track every image, base game first.

## 0.1.0 (2026-10-16)

The first release: a catalog browser and download manager for the jailbroken PS5, with catalog feeds and
mirrors, a phone companion, a live title counter and an update check.
