// Rest mode and the downloads: when the console comes back from rest mode with the app open, the app's
// process was frozen meanwhile (its clock kept going), the network comes back a while after it, and a download
// that was running finds its connections dead and fails. This notices the wake (a tick that comes much later
// than it was due), writes how long the console slept to the debug log, and gives each download that was
// running before it and fails on a network error after it a few more tries by itself, while the network comes
// back (there is no "network up" event to wait on: a try that finds no network fails at once, and the next one
// is a while later).
// Nothing here keeps the console awake: that is Power.keepAwake, which the download queue turns on while it has
// work (state/download-queue.js; ps5-react docs/HARDWARE.md lists it as not yet seen working on a console).

  // A failure after a wake that is the network's, not the server's or the file's (libcurl's messages, through
  // the engine: ps5-react native/shared/network.cpp).
  var NETWORK_ERROR = /resolve host|connect to server|Timeout was reached|timed out|receiving data|sending data|SSL connect|returned nothing|partial file|Connection reset|network/i;
  var BUSY_STATES = ["queued", "resolving", "connecting", "downloading", "verifying", "pausing"];
  function createRestWake({
    queue,
    now = () => Date.now(),
    every = (fn, ms) => setInterval(fn, ms),
    stopEvery = (id) => clearInterval(id),
    later = (fn, ms) => setTimeout(fn, ms),
    log = (line) => console.log(line),
    // How often the clock is read, and how much later than due a tick must come to be a sleep.
    tickMs = 5e3,
    sleepMs = 6e4,
    // After a wake, the downloads that were running are watched this long, and tried again this long after
    // each failure (the network takes from seconds to a minute or two to come back).
    watchMs = 20 * 6e4,
    retryMs = [20e3, 60e3, 120e3, 300e3]
  }) {
    let last = now();
    let jobs = [];
    // Downloads that were running before the last wake: id -> { until, tries }.
    const watched = /* @__PURE__ */ new Map();
    const timers = /* @__PURE__ */ new Set();
    let wakes = 0;
    function retry(job) {
      const entry = watched.get(job.id);
      if (!entry || entry.pending || now() > entry.until) return;
      if (entry.tries >= retryMs.length) {
        log(`[rest] ${job.id}: still failing after ${entry.tries} tries since the wake; it waits for you (${job.error})`);
        watched.delete(job.id);
        return;
      }
      const wait = retryMs[entry.tries++];
      entry.pending = true;
      log(`[rest] ${job.id}: failed after the wake (${job.error}); trying again in ${Math.round(wait / 1e3)} s (try ${entry.tries} of ${retryMs.length})`);
      const timer = later(() => {
        timers.delete(timer);
        entry.pending = false;
        const current = jobs.find((candidate) => candidate.id === job.id);
        if (!current || current.state !== "failed") return;
        try {
          queue.resume(job.id);
        } catch (error) {
          log(`[rest] ${job.id}: not resumed: ${error.message}`);
        }
      }, wait);
      timer?.unref?.();
      timers.add(timer);
    }
    function look(list) {
      jobs = list;
      for (const job of list) {
        const entry = watched.get(job.id);
        if (!entry) continue;
        if (now() > entry.until) watched.delete(job.id);
        else if (job.state === "failed" && NETWORK_ERROR.test(job.error || "")) retry(job);
        else if (["installed", "completed", "done", "attention"].includes(job.state)) watched.delete(job.id);
      }
    }
    function woke(slept) {
      wakes++;
      const running = jobs.filter((job) => BUSY_STATES.includes(job.state));
      log(`[rest] back from rest mode after ${Math.round(slept / 1e3)} s asleep; ${running.length ? `watching ${running.map((job) => job.id).join(", ")}` : "no download was running"}`);
      for (const job of running) watched.set(job.id, { until: now() + watchMs, tries: 0, pending: false });
      look(jobs);
    }
    const unsubscribe = queue.subscribe(look);
    const ticker = every(() => {
      const at = now();
      const gap = at - last - tickMs;
      last = at;
      if (gap >= sleepMs) woke(gap);
    }, tickMs);
    ticker?.unref?.();
    return {
      stop() {
        unsubscribe?.();
        stopEvery(ticker);
        for (const timer of timers) clearTimeout(timer);
        timers.clear();
      },
      /** For the tests: wakes seen and the downloads watched now. */
      get state() {
        return { wakes, watched: [...watched.keys()] };
      }
    };
  }

export { NETWORK_ERROR, createRestWake };
