// glibren.55: a validacao do link capturado no navegador (app/state/browser-links.js validateCapturedLink). PS5 real
// (Stray, AkiraBox, 13/11/2026): "browser-capture refused ... Http.request: response exceeds maxBytes" (o servidor
// ignorou o Range e mandou o arquivo inteiro) e "Captured file failed validation or expired". Run: npm test
import test from 'node:test';
import assert from 'node:assert/strict';

const { validateCapturedLink } = await import('../app/state/browser-links.js');
const LINK = 'https://s3.akirabox.com/files/PPSA02100.exfat?token=abc';
const meta = { anchor: 'PPSA02100', sizeBytes: 7.9e9 };
const SIZE = 7_912_345_678;
// Um Http falso: cada pedido passa por `answer(method, options)`; registra os pedidos.
const fake = (answer) => {
  const asked = [];
  return { asked, async request(url, options = {}) {
    asked.push(options.method);
    return answer(options.method, options);
  } };
};
const ok = (status, headers, body = '') => ({ status, ok: status >= 200 && status < 300, url: LINK, headers, text: async () => body });

test('206 com 1 byte: valido (como antes)', async () => {
  const http = fake(() => ok(206, { 'content-range': `bytes 0-0/${SIZE}`, 'content-length': '1', 'content-type': 'application/octet-stream' }, 'x'));
  assert.equal((await validateCapturedLink(http, LINK, meta)).expectedBytes, SIZE);
});

test('servidor que ignora o Range: o GET estoura o maxBytes e o HEAD valida pelos cabecalhos', async () => {
  const http = fake((method) => {
    if (method === 'GET') throw new Error('Http.request: response exceeds maxBytes');
    return ok(200, { 'content-length': String(SIZE), 'content-type': 'application/octet-stream' });
  });
  const result = await validateCapturedLink(http, LINK, meta);
  assert.equal(result.expectedBytes, SIZE);
  assert.deepEqual(http.asked, ['GET', 'HEAD']);
});

test('200 com o tamanho do arquivo (Range ignorado, corpo cortado pelo motor): valido', async () => {
  const http = fake(() => ok(200, { 'content-length': String(SIZE), 'content-type': 'application/octet-stream' }));
  assert.equal((await validateCapturedLink(http, LINK, meta)).expectedBytes, SIZE);
});

test('206 sem Content-Length (em pedacos) e corpo binario que nao vem como texto: valido pelo Content-Range', async () => {
  const http = fake(() => ok(206, { 'content-range': `bytes 0-0/${SIZE}`, 'content-type': 'application/octet-stream' }, ''));
  assert.equal((await validateCapturedLink(http, LINK, meta)).expectedBytes, SIZE);
});

test('continua recusando: pagina HTML, 206 de mais de 1 byte, 403 vencido, 206 sem Content-Range', async () => {
  for (const answer of [
    () => ok(200, { 'content-type': 'text/html', 'content-length': '5000' }, '<html>'),
    () => ok(206, { 'content-range': `bytes 0-99/${SIZE}`, 'content-length': '100', 'content-type': 'application/octet-stream' }),
    () => ok(403, { 'content-type': 'application/octet-stream', 'content-length': '10' }),
    () => ok(206, { 'content-length': '1', 'content-type': 'application/octet-stream' }, 'x'),
  ]) {
    await assert.rejects(validateCapturedLink(fake(answer), LINK, meta), /failed validation or expired/);
  }
  // Outro erro do transporte (nao o tamanho) nao vira HEAD.
  const http = fake(() => { throw new Error('Http.request: timeout'); });
  await assert.rejects(validateCapturedLink(http, LINK, meta), /timeout/);
  assert.deepEqual(http.asked, ['GET']);
});
