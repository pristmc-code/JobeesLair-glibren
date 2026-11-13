// Fase 4: a grade da loja (browse/Catalog.jsx) e a da tela Procurar (search/index.jsx) pelas paginas do catalogo do payload
// (state/catalog-remote.js). Uma pagina (PAGE jogos) por vez, a proxima quando a lista chega ao fim; os cartoes ja vistos
// ficam no array da grade (~1 KB cada, nada do catalogo inteiro). Os Favoritos: as cartas deles (/cards), filtradas e
// ordenadas aqui com as regras do app (state/catalog.js filterList/sortGames/oneEach). null = caminho local (modo remoto
// desligado; o payload falhou no meio: a loja passa a ser montada aqui e a grade volta sozinha ao caminho de antes).
import { useCallback, useEffect, useRef, useState } from 'react';
import { filterList, oneEach, sortGames } from '../state/catalog.js';
import { onRemoteCatalog, remoteCatalog, remoteCatalogOn } from '../state/catalog-remote.js';

  /** Se as grades vem do payload agora. */
  var remoteGrids = () => remoteCatalogOn();
  /** Os Favoritos (`wishlist`) com os filtros, a busca e a ordem da vista, das cartas do payload. null = desligado. */
  async function favoriteGames({ filters, query, sort, wishlist, everyCopy }) {
    const cards = await remoteCatalog().cards(wishlist);
    if (!cards) return null;
    // na ordem do catalogo antes (as ordens do app sao estaveis: o empate fica na ordem da loja), como a montagem local
    const list = sortGames(filterList([...cards].sort((a, b) => a.pos - b.pos), { filters, query, wishlist }), sort);
    return everyCopy ? list : oneEach(list);
  }
  /**
   * { games, total, loading, more() } da vista, ou null quando a vista nao vem do payload. `route`: "" (a grade da loja,
   * GET /api/catalog: um por jogo sem plataforma nem busca) ou "search" (a tela Procurar, GET /api/catalog/search: todas
   * as copias, a busca do match.js).
   */
  function useRemoteGrid({ filters, query = "", sort, wishlist = [], route = "" }) {
    // A loja pode cair para o caminho local no meio: desenha de novo quando muda.
    const [, setFlip] = useState(0);
    useEffect(() => onRemoteCatalog(() => setFlip((n) => n + 1)), []);
    const wanted = remoteGrids();
    const [grid, setGrid] = useState(null);
    const asking = useRef(false);
    const favorites = Boolean(filters?.wishlist);
    const view = { filters, query, sort };
    const signature = JSON.stringify([route, filters, query, sort, favorites ? wishlist : 0]);
    useEffect(() => {
      if (!wanted) return void 0;
      let live = true;
      asking.current = true;
      const everyCopy = route === "search" || Boolean(filters.platform?.length || query.trim());
      const first = favorites ? favoriteGames({ filters, query, sort, wishlist, everyCopy }).then((list) => list && { games: list, total: list.length }) : remoteCatalog().page(view, 0, route);
      first.then((answer) => {
        if (!live) return;
        asking.current = false;
        if (answer) setGrid({ signature, games: answer.games, total: answer.total });
      });
      return () => {
        live = false;
      };
    }, [wanted, signature]);
    const more = useCallback(() => {
      if (favorites || asking.current || !grid || grid.signature !== signature || grid.games.length >= grid.total) return;
      asking.current = true;
      remoteCatalog().page(view, grid.games.length, route).then((next) => {
        asking.current = false;
        if (!next) return;
        setGrid((now) => now && now.signature === signature ? { ...now, games: now.games.concat(next.games) } : now);
      });
    }, [grid, signature]);
    if (!wanted) return null;
    const mine = grid?.signature === signature;
    return { games: mine ? grid.games : [], total: mine ? grid.total : 0, loading: !mine, more };
  }

export { favoriteGames, remoteGrids, useRemoteGrid };
