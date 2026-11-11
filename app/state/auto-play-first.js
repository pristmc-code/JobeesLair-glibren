// glibren.32: "Play the first video automatically" (off by default). Kept in settings.json (autoPlayFirstVideo)
// beside the other settings. On, the Trailer and Gameplay buttons of a game's Videos sheet ask the video app to
// play the first result at once (the "auto=1" line of glibren_busca.txt, state/youtube.js) instead of listing them.
// Read each time a video is opened, so a change applies to the next one; YouTube inside Jobee'sLair uses it too.

import { useEffect, useState } from 'react';
import { loadList, saveList } from './saved.js';

  var SETTINGS = "settings.json";
  var value = null;
  var listeners = /* @__PURE__ */ new Set();
  function autoPlayFirst() {
    if (value === null) value = loadList(SETTINGS, "settings").autoPlayFirstVideo === true;
    return value;
  }
  function setAutoPlayFirst(on) {
    value = Boolean(on);
    saveList(SETTINGS, "settings", { ...loadList(SETTINGS, "settings"), autoPlayFirstVideo: value });
    for (const listener of listeners) listener(value);
  }
  function useAutoPlayFirst() {
    const [on, setOn] = useState(autoPlayFirst);
    useEffect(() => {
      listeners.add(setOn);
      return () => {
        listeners.delete(setOn);
      };
    }, []);
    return on;
  }

export { autoPlayFirst, setAutoPlayFirst, useAutoPlayFirst };
