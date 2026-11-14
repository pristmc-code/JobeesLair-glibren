// 0.5.4: on the PS4, pictures from Sony's servers come through Jobee'sLair online's /v1/picture (tools/online): a
// jailbroken PS4's network usually blocks Sony so that it cannot update, and most covers and screenshots live there.
// glibren (banco de capas pelo celular): no PS5 o DNS do console bloqueia a Sony de proposito e o console nunca fala
// com ela; as capas de image.api.playstation.com vem do payload (127.0.0.1:34201/app/capa?u=, bg_covers_bank.c): o
// banco que o JobeControle encheu pela internet do celular, o icon0 do jogo instalado, o cache e outros sites (nunca a
// Sony). Sem nada, 404 e a TV mostra o que mostrava antes (a capa nao abria do mesmo jeito).

import { Image } from '@ps5-react/core';
import { ONLINE_URL } from './online.js';
import { PS4 } from './ps4.js';

  var SONY = /^https:\/\/(?:image\.api\.playstation\.com|poseidon\.dl\.playstation\.net)\//;
  var SONY_COVERS = /^https:\/\/image\.api\.playstation\.com\//;
  var PAYLOAD_COVERS = 'http://127.0.0.1:34201/app/capa?u=';
  var pictureRoute = (uri) => SONY.test(uri) ? `${ONLINE_URL}/v1/picture?u=${encodeURIComponent(uri)}` : null;
  var payloadRoute = (uri) => SONY_COVERS.test(uri) ? PAYLOAD_COVERS + encodeURIComponent(uri) : null;
  Image.setRouter?.(PS4 ? pictureRoute : payloadRoute);

export { pictureRoute, payloadRoute };
