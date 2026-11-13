// glibren.45 (tests/catalog-paced.test.mjs): what the catalog looks like the moment its modules have loaded, before any
// timer runs (static imports: nothing else runs in between).
import { isCatalogReady, FACETS } from '../app/state/catalog.js';
import { games } from '../app/data/catalog-index.js';

const format = FACETS.find((facet) => facet.key === 'format');
globalThis.__catalogFormatFacet = format;
globalThis.__catalogAtLoad = { ready: isCatalogReady(), games: games.length, formatOptions: format.options.length, facets: FACETS.length };
