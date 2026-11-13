// ../pub-game-store/native/ui/Skeleton.jsx
// reconstructed from the esbuild bundle in eboot.bin

import { jsx } from 'react/jsx-runtime';
import { View, motion } from '@ps5-react/core';
import { colors, radius } from './colors.js';
import { usePower } from '../state/power.js';

  var BLOCK = { backgroundColor: colors.surface2, borderRadius: radius.sm };
  var pulse = {
    initial: { opacity: 1 },
    animate: { opacity: 0.5 },
    transition: { type: "tween", duration: 0.9, ease: "easeInOut", repeat: Infinity, repeatType: "reverse" }
  };
  // glibren.45: still at rest and with "Economizar energia" (state/power.js): a logo that never arrives pulsed for good.
  function Skeleton({ style, pulse: pulsing = false }) {
    const { quiet } = usePower();
    if (!pulsing || quiet) return /* @__PURE__ */ (0, jsx)(View, { style: [BLOCK, style] });
    return /* @__PURE__ */ (0, jsx)(motion.View, { ...pulse, style: [BLOCK, style] });
  }

export { Skeleton };
