// Light motion on the PS4: its CPU draws every frame slower than the PS5's, so there every animation is a short
// ease-out (the runtime's setLightMotion), and the launch screen and the game page drop their longer moves.
// Importing this turns it on; index.jsx does that before anything animates.
// glibren.45: and on the PS5 with "Economizar energia" on (state/power.js): the same short moves, no vortex at launch.
// Turned on or off in Settings, the short moves follow at once; the launch's, at the next launch.

import { setLightMotion } from '@ps5-react/core';
import { PS4 } from '../state/ps4.js';
import { energySaverOn } from '../state/power.js';

  var LIGHT = PS4 || energySaverOn();
  setLightMotion(LIGHT);

export { LIGHT };
