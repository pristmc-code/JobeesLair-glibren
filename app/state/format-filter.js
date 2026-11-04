// The source list's format filter (glibren fork): which kinds of link it shows, the same for every game,
// kept in settings.json (linkFormats) beside the other settings.
//   kinds    the groups shown (state/link-formats.js FORMAT_GROUP: image, pkg, archive); none or all: every one
//   unknown  whether a link of no known format shows too (on unless turned off)
// It only hides rows; their order, the recommended source and the download queue's failover stay as they were.
// The selected source is never hidden, and a game the filter would empty says so (SourcePicker.jsx).

import { useEffect, useState } from 'react';
import { GROUPS, effectiveFormat, groupOf } from './link-formats.js';
import { loadList, saveList } from './saved.js';

  var SETTINGS = "settings.json";
  var DEFAULT = { kinds: [], unknown: true };
  /** A saved filter as the app uses it: known kinds only, in GROUPS order; all of them is the same as none. */
  function normalizeFilter(saved) {
    const kinds = GROUPS.filter((kind) => Array.isArray(saved?.kinds) && saved.kinds.includes(kind));
    return { kinds: kinds.length === GROUPS.length ? [] : kinds, unknown: saved?.unknown !== false };
  }
  var allKinds = (filter) => !filter.kinds.length;
  /** "All": every kind again (the unknown switch stays as it is). */
  var showAllKinds = (filter) => ({ ...filter, kinds: [] });
  /** A kind's chip pressed: from "All" it is the only one; otherwise it joins or leaves; none left is "All". */
  function toggleKind(filter, kind) {
    if (!GROUPS.includes(kind)) return filter;
    const kinds = allKinds(filter) ? [kind] : filter.kinds.includes(kind) ? filter.kinds.filter((each) => each !== kind) : [...filter.kinds, kind];
    return normalizeFilter({ ...filter, kinds });
  }
  var toggleUnknown = (filter) => ({ ...filter, unknown: !filter.unknown });
  var isFiltering = (filter) => !allKinds(filter) || !filter.unknown;
  /** Whether a link of `group` (null: unknown) shows. */
  var passes = (filter, group) => group ? allKinds(filter) || filter.kinds.includes(group) : filter.unknown;
  // The groups of the source list the filter applies to: what can be downloaded, add-ons and backports. Links
  // that cannot be (unavailable) are listed apart and never filtered.
  var FILTERED = /* @__PURE__ */ new Set(["direct", "page", "torrent", "browser", "dlc", "backport"]);
  /**
   * `sections` (game/sources.js sourceSections) with the rows `filter` leaves out taken away: { sections, hidden,
   * shown }. `selected` (the chosen source's index) always stays. `recordOf` reads the saved formats.
   */
  function filterSections(sections, filter, { selected = -1, recordOf } = {}) {
    let hidden = 0;
    let shown = 0;
    const result = sections.map((section) => {
      if (!FILTERED.has(section.group)) return section;
      const items = section.items.filter(({ release, index }) => {
        const keep = index === selected || passes(filter, groupOf(effectiveFormat(release, recordOf).format));
        if (keep) shown++;
        else hidden++;
        return keep;
      });
      return items.length === section.items.length ? section : { ...section, items };
    }).filter((section) => section.items.length);
    return { sections: result, hidden, shown };
  }
  var filter = null;
  var listeners = /* @__PURE__ */ new Set();
  function formatFilter() {
    if (!filter) filter = normalizeFilter(loadList(SETTINGS, "settings").linkFormats);
    return filter;
  }
  /** Saves `next` (the default removes the key) and tells every open source list. */
  function setFormatFilter(next) {
    filter = normalizeFilter(next);
    const { linkFormats: _old, ...settings } = loadList(SETTINGS, "settings");
    saveList(SETTINGS, "settings", isFiltering(filter) ? { ...settings, linkFormats: filter } : settings);
    for (const listener of [...listeners]) listener(filter);
  }
  function useFormatFilter() {
    const [value, setValue] = (0, useState)(formatFilter);
    (0, useEffect)(() => {
      listeners.add(setValue);
      setValue(formatFilter());
      return () => listeners.delete(setValue);
    }, []);
    return value;
  }

export { DEFAULT as DEFAULT_FORMAT_FILTER, filterSections, formatFilter, isFiltering, normalizeFilter, passes, setFormatFilter, showAllKinds, toggleKind, toggleUnknown, useFormatFilter };
