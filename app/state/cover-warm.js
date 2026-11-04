// The order in which the launch warms the covers (Image.warm fills the disk cache in the background, in order).
// Every game's cover is still warmed, as before; the first covers of each Discover row and the catalog grid's
// first rows go first, row by row, so what the first screens show is in the cache before the rest of the
// catalog (it used to go by relevance alone, and a row's later cards or Top Rated waited on hundreds of others).

import { Image } from '@ps5-react/core';

  // The covers of each row that go first: a 1920-wide row shows about ten portrait cards.
  var ROW_FIRST = 10;
  var rows = [];
  var coverOf = (game) => game?.art?.cover;
  /** A Discover row (or the grid's first games), noted as its module loads; warmAtStart puts its first covers first. */
  function noteRow(list, first = ROW_FIRST) {
    rows.push({ list, first });
  }
  /** The launch's order: the first covers of every noted row (each row's first card first), then `all` in order. */
  function warmOrder(all) {
    const urls = [];
    const longest = Math.max(0, ...rows.map((row) => Math.min(row.first, row.list.length)));
    for (let at = 0; at < longest; at++) for (const row of rows) if (at < row.first) urls.push(coverOf(row.list[at]));
    for (const game of all) urls.push(coverOf(game));
    return [...new Set(urls.filter(Boolean))];
  }
  /** Hands every cover of `all` to the disk cache, the rows' first ones first. Returns how many and how many lead. */
  function warmAtStart(all) {
    const urls = warmOrder(all);
    const lead = warmOrder([]).length;
    Image.warm(urls);
    return { count: urls.length, lead };
  }

export { ROW_FIRST, noteRow, warmAtStart, warmOrder };
