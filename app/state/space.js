// ../pub-game-store/native/state/space.js
// reconstructed from the esbuild bundle in eboot.bin

import { formatBytes } from './size.js';

  var MARGIN2 = 16 * 1024 ** 2;
  var extracts = (job2) => Boolean(job2.release?.parts) || job2.artifact?.nextAction === "extraction-required";
  function stillNeeded(job2) {
    if (job2.state === "installing") return 0;
    // Downloaded, waiting for its turn to be extracted (download-queue.js's extraction lane): it will write about its
    // archive's size again (the size it unpacks to is known only once it starts).
    if (job2.state === "extracting" && job2.phase === "queued") return Math.max(0, job2.total ?? job2.release?.sizeBytes ?? 0);
    // glibren.12: one converted to .exfat writes the image too (about its size again): archives already counted twice,
    // a PS5 package now too. A conversion running needs what it has still to write.
    if (job2.state === "converting") return Math.max(0, (job2.total ?? job2.release?.sizeBytes ?? 0) - (job2.written || 0));
    const factor = (extracts(job2) || job2.convertPlanned) && job2.state !== "extracting" ? 2 : 1;
    return Math.max(0, (job2.total ?? job2.release?.sizeBytes ?? 0) * factor - job2.written);
  }
  var SHOWN = 3;
  function spaceShortfall(root2, need, free, pending2) {
    const holders = pending2.map((job2) => ({ title: job2.title, bytes: stillNeeded(job2) })).filter((job2) => job2.bytes > 0).sort((a, b) => b.bytes - a.bytes);
    const reserved = holders.reduce((sum, job2) => sum + job2.bytes, 0);
    const left = Math.max(0, free - reserved);
    if (left >= need + MARGIN2) return "";
    const message = `Not enough space on ${root2}: needs ${formatBytes(need)}, ${formatBytes(left)} free`;
    if (!reserved) return message;
    const named2 = holders.slice(0, SHOWN).map((job2) => `${job2.title} (${formatBytes(job2.bytes)})`);
    if (holders.length > SHOWN) named2.push(`+${holders.length - SHOWN}`);
    return `${message} after queued downloads: ${named2.join(", ")}`;
  }

export { MARGIN2, spaceShortfall, stillNeeded };
