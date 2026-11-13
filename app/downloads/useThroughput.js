// ../pub-game-store/native/downloads/useThroughput.js
// reconstructed from the esbuild bundle in eboot.bin

import { useEffect, useState } from 'react';
import { createThroughput } from './rates.js';
import { subscribe2 } from './useQueue.js';
import { paced } from '../state/power.js';

  // glibren.45: a sample a second as before; the chart is redrawn with them every 5 s at rest and every 2 s with
  // "Economizar energia" (state/power.js paced), without losing any.

  var SAMPLES = 60;
  var EMPTY = { network: [], disk: [] };
  function useThroughput(id) {
    const [history, setHistory] = (0, useState)(EMPTY);
    (0, useEffect)(() => {
      const measure = createThroughput();
      let kept = EMPTY;
      const pace = paced(setHistory, 0);
      const stop = subscribe2((jobs) => {
        const job2 = jobs.find((item) => item.id === id);
        const sample = job2 && measure(job2, Date.now());
        if (!sample) return;
        kept = {
          network: [...kept.network, sample.network].slice(-SAMPLES),
          disk: [...kept.disk, sample.disk].slice(-SAMPLES)
        };
        pace.feed(kept);
      });
      return () => {
        pace.stop();
        stop?.();
      };
    }, [id]);
    return history;
  }

export { SAMPLES, useThroughput };
