// ../pub-game-store/native/downloads/useQueue.js
// reconstructed from the esbuild bundle in eboot.bin

import { useEffect, useState } from 'react';
import { downloadQueue } from '../state/downloads.js';
import { shapeOf } from './shape.js';
import { paced } from '../state/power.js';

  function subscribe2(listener) {
    try {
      return downloadQueue().subscribe(listener);
    } catch {
      return void 0;
    }
  }
  var fractionOf = (progress) => progress?.total ? Math.min(1, progress.written / progress.total) : 0;
  // Redraws only when a job's shape changes (downloads/shape.js): what is shown besides progress.
  function useJobs() {
    const [state, setState] = (0, useState)({ jobs: [], shape: "", error: "" });
    (0, useEffect)(() => {
      let last = "";
      try {
        return downloadQueue().subscribe((jobs) => {
          const shape = jobs.map(shapeOf).join("\n");
          if (shape === last) return;
          last = shape;
          setState({ jobs, shape, error: "" });
        });
      } catch (failure) {
        setState({ jobs: [], shape: "", error: failure.message });
        return void 0;
      }
    }, []);
    return state;
  }
  // glibren.45: redrawn as it comes in use, every 5 s at rest and every 2 s with "Economizar energia" (state/power.js).
  function useProgress(id) {
    const [progress, setProgress] = (0, useState)(null);
    (0, useEffect)(() => {
      let last = null;
      const pace = paced(setProgress, 0);
      const stop = subscribe2((jobs) => {
        const job2 = jobs.find((item) => item.id === id);
        if (!job2 || last && last.written === job2.written && last.total === job2.total && last.bytesPerSecond === (job2.bytesPerSecond || 0)) return;
        last = { written: job2.written, total: job2.total, bytesPerSecond: job2.bytesPerSecond || 0 };
        pace.feed(last);
      });
      return () => {
        pace.stop();
        stop?.();
      };
    }, [id]);
    return progress;
  }

export { fractionOf, shapeOf, subscribe2, useJobs, useProgress };
