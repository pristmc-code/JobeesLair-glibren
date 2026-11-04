// The source list's format filter (glibren fork): which kinds of link it shows, the same for every game,
// kept in settings.json (linkFormats) beside the other settings.
//   kinds    the groups shown (state/link-formats.js FORMAT_GROUP: image, pkg, archive); none or all: every one
//   unknown  whether a link of no known format shows too (on unless turned off)
//   images   glibren: with images shown, which image types (state/link-formats.js IMAGE_TYPES: exfat, ffpkg,
//            ffpfs, FFPFSC going with FFPFS); none or all: every one
//   debridOnly  glibren: only the links the debrid service (TorBox, AllDebrid) fetches (state/debrid-choice.js);
//            nothing without a key
// It only hides rows; their order, the recommended source and the download queue's failover stay as they were.
// The selected source is never hidden, and a game the filter would empty says so (SourcePicker.jsx).

import { useEffect, useState } from 'react';
import { GROUPS, IMAGE_TYPES, effectiveFormat, groupOf, imageTypeOf } from './link-formats.js';
import { loadList, saveList } from './saved.js';

  var SETTINGS = "settings.json";
  var DEFAULT = { kinds: [], unknown: true };
  /** A saved filter as the app uses it: known kinds only, in GROUPS order; all of them is the same as none. */
  function normalizeFilter(saved) {
    const kinds = GROUPS.filter((kind) => Array.isArray(saved?.kinds) && saved.kinds.includes(kind));
    const images = IMAGE_TYPES.filter((type) => Array.isArray(saved?.images) && saved.images.includes(type));
    const filter = { kinds: kinds.length === GROUPS.length ? [] : kinds, unknown: saved?.unknown !== false };
    // Image types only when some are picked (a filter saved before them reads as it did).
    if (images.length && images.length < IMAGE_TYPES.length) filter.images = images;
    if (saved?.debridOnly === true) filter.debridOnly = true;
    return filter;
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
  /** An image type's chip pressed (exFAT, FFPKG, FFPFS): from "every type" it is the only one; none left is every one. */
  function toggleImageType(filter, type) {
    if (!IMAGE_TYPES.includes(type)) return filter;
    const images = filter.images?.length ? filter.images.includes(type) ? filter.images.filter((each) => each !== type) : [...filter.images, type] : [type];
    return normalizeFilter({ ...filter, images });
  }
  /** Whether the image types can be picked: images are among what shows (the chips appear then). */
  var imagesShown = (filter) => allKinds(filter) || filter.kinds.includes("image");
  var isFiltering = (filter) => !allKinds(filter) || !filter.unknown || imagesShown(filter) && Boolean(filter.images?.length) || Boolean(filter.debridOnly);
  /** "TorBox only" pressed. */
  var toggleDebridOnly = (filter) => normalizeFilter({ ...filter, debridOnly: !filter.debridOnly });
  /** Whether a link of `group` (null: unknown) shows; `format` (exfat, ffpkg…) for an image's type. */
  function passes(filter, group, format = null) {
    if (!group) return filter.unknown;
    if (!(allKinds(filter) || filter.kinds.includes(group))) return false;
    return group !== "image" || !filter.images?.length || filter.images.includes(imageTypeOf(format));
  }
  // The groups of the source list the filter applies to: what can be downloaded, add-ons and backports. Links
  // that cannot be (unavailable) are listed apart and never filtered.
  var FILTERED = /* @__PURE__ */ new Set(["direct", "page", "torrent", "browser", "dlc", "backport"]);
  /**
   * `sections` (game/sources.js sourceSections) with the rows `filter` leaves out taken away: { sections, hidden,
   * shown, viaDebrid }. `selected` (the chosen source's index) always stays. `recordOf` reads the saved formats.
   * `debrid` (release -> boolean): with "TorBox only" on, the links the service fetches; `viaDebrid` counts those
   * shown, so a game with none can say so.
   */
  function filterSections(sections, filter, { selected = -1, recordOf, debrid = null } = {}) {
    let hidden = 0;
    let shown = 0;
    let viaDebrid = 0;
    const result = sections.map((section) => {
      if (!FILTERED.has(section.group)) return section;
      const items = section.items.filter(({ release, index }) => {
        const format = effectiveFormat(release, recordOf).format;
        const fetched = !debrid || debrid(release);
        const keep = index === selected || passes(filter, groupOf(format), format) && fetched;
        if (keep && debrid && fetched) viaDebrid++;
        if (keep) shown++;
        else hidden++;
        return keep;
      });
      return items.length === section.items.length ? section : { ...section, items };
    }).filter((section) => section.items.length);
    return { sections: result, hidden, shown, viaDebrid };
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

export { DEFAULT as DEFAULT_FORMAT_FILTER, filterSections, formatFilter, imagesShown, isFiltering, normalizeFilter, passes, setFormatFilter, showAllKinds, toggleDebridOnly, toggleImageType, toggleKind, toggleUnknown, useFormatFilter };
