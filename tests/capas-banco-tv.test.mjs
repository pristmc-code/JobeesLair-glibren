// Banco de capas pelo celular: no PS5 a TV pede as capas da Sony ao payload (127.0.0.1:34201/app/capa?u=,
// app/native/bg_covers_bank.c), que nunca fala com a Sony; o resto carrega como veio. O PS4 continua no online.
import test from 'node:test';
import assert from 'node:assert/strict';
import { payloadRoute } from '../app/state/picture-route.js';

test('PS5: as capas de image.api.playstation.com vao ao payload local, a URL inteira e codificada; o resto como veio', () => {
  const cover = 'https://image.api.playstation.com/vulcan/ap/rnd/202107/0800/rJE5OUnACX4Y6LxdgTQoCd8d.png?w=440&thumb=false';
  assert.equal(payloadRoute(cover), `http://127.0.0.1:34201/app/capa?u=${encodeURIComponent(cover)}`);
  assert.equal(new URL(payloadRoute(cover)).searchParams.get('u'), cover);
  for (const other of ['https://poseidon.dl.playstation.net/cdn/UP0001/CUSA00001_00/a.png', 'https://cdn.prosperopatches.com/x.webp', 'https://archive.org/download/x/cover.jpg',
    'http://image.api.playstation.com/x.png', 'https://image.api.playstation.com.example.com/x.png'])
    assert.equal(payloadRoute(other), null, other);
});
