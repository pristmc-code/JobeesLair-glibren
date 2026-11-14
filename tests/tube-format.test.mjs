// glibren.55: o formato do YouTube (H.264 / VP9 / automatico). Defeito do PS5 real (glibren.53): depois de escolher VP9
// no R2, voltar para H.264 nao ficava: um erro do player no H.264 (o log do console tem "video decode failed (h264,
// sceVideodec2)" no meio do video) ia para a proxima da lista, que e o VP9 da mesma altura, e o VP9 engasgava.
// Aqui: o automatico escolhe H.264; trocar H.264 <-> VP9 <-> automatico em qualquer ordem vale e fica guardado; o erro
// desce no mesmo formato; o aviso das qualidades VP9. Run: npm test
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.__stubFiles = new Map();
const { playableChoices, defaultChoice, fallbackChoice, choiceNote, codecFamily, TUBE_CODECS } = await import('../app/state/tube-service.js');
const settings = await import('../app/state/tube-settings.js');
const { tubeCodec, setTubeCodec, forgetTubeCodec, TUBE_CODEC_CHOICES } = settings;

const BASE = 'http://127.0.0.1:34210/media/s';
// As escolhas como o tube-service 0.2.2 as devolve (js/resolve.js createPlayback: a mais alta primeiro, H.264 antes de
// VP9 na mesma altura; rotulo "<altura>p <fps> fps <VIDEO> / <AUDIO>[ <HDR>]"), de formatos reais do YouTube:
// itag 299/298/136 (avc1, H.264), 303/302/247/308/315 (vp09.00, VP9 perfil 0), 337 (vp09.02, VP9 perfil 2 = HDR).
const service = [
  { label: '2160p 60 fps VP9 / OPUS HDR10', video_codec: 'vp9', height: 2160, fps: 60, video_range: 'HDR10', itag: 337 },
  { label: '2160p 60 fps VP9 / OPUS', video_codec: 'vp9', height: 2160, fps: 60, video_range: 'SDR', itag: 315 },
  { label: '1440p 60 fps VP9 / OPUS', video_codec: 'vp9', height: 1440, fps: 60, video_range: 'SDR', itag: 308 },
  { label: '1080p 60 fps H264 / AAC', video_codec: 'h264', height: 1080, fps: 60, video_range: 'SDR', itag: 299 },
  { label: '1080p 60 fps VP9 / OPUS', video_codec: 'vp9', height: 1080, fps: 60, video_range: 'SDR', itag: 303 },
  { label: '1080p 60 fps VP9 / OPUS HDR10', video_codec: 'vp9', height: 1080, fps: 60, video_range: 'HDR10', itag: 335 },
  { label: '720p 60 fps H264 / AAC', video_codec: 'h264', height: 720, fps: 60, video_range: 'SDR', itag: 298 },
  { label: '720p 60 fps VP9 / OPUS', video_codec: 'vp9', height: 720, fps: 60, video_range: 'SDR', itag: 302 },
  { label: '720p 30 fps H264 / AAC', video_codec: 'h264', height: 720, fps: 30, video_range: 'SDR', itag: 136 },
  { label: '480p 30 fps AV1 / OPUS', video_codec: 'av1', height: 480, fps: 30, video_range: 'SDR', itag: 397 }
].map((choice, index) => ({ ...choice, container: 'dash', url: `${BASE}/d${index}.mpd`, hls_url: `${BASE}/v${index}.m3u8` }));
const list = playableChoices(service);
const labelOf = (index) => list[index]?.label;
const at = (label) => list.findIndex((choice) => choice.label === label);

test('playableChoices: VP9 HDR acima de 1080p some (vai pelo processador, que nao abre mais de 1080p); AV1 nao toca', () => {
  assert.deepEqual(list.map((choice) => choice.label), [
    '2160p 60 fps VP9 / OPUS', '1440p 60 fps VP9 / OPUS', '1080p 60 fps H264 / AAC', '1080p 60 fps VP9 / OPUS',
    '1080p 60 fps VP9 / OPUS HDR10', '720p 60 fps H264 / AAC', '720p 60 fps VP9 / OPUS', '720p 30 fps H264 / AAC'
  ]);
  assert.equal(list[2].family, 'h264');
  assert.equal(list[4].hdr, true);
  assert.equal(codecFamily('avc'), 'h264');
  assert.deepEqual(TUBE_CODECS, TUBE_CODEC_CHOICES);
});

test('automatico: escolhe H.264, mesmo com a qualidade padrao em 1440p ou 4K', () => {
  assert.equal(labelOf(defaultChoice(list)), '1080p 60 fps H264 / AAC');
  assert.equal(labelOf(defaultChoice(list, 1080, 'auto')), '1080p 60 fps H264 / AAC');
  assert.equal(labelOf(defaultChoice(list, 1440, 'auto')), '1080p 60 fps H264 / AAC');
  assert.equal(labelOf(defaultChoice(list, 2160, 'auto')), '1080p 60 fps H264 / AAC');
  assert.equal(labelOf(defaultChoice(list, 720, 'auto')), '720p 60 fps H264 / AAC');
  // Sem nenhum H.264 (alguns videos so tem VP9): a melhor de qualquer formato, SDR antes de HDR.
  const onlyVp9 = list.filter((choice) => choice.family === 'vp9');
  assert.equal(onlyVp9[defaultChoice(onlyVp9, 1080, 'auto')].label, '1080p 60 fps VP9 / OPUS');
});

test('VP9 escolhido: a melhor VP9 ate a qualidade padrao; H.264 escolhido: a melhor H.264', () => {
  assert.equal(labelOf(defaultChoice(list, 1080, 'vp9')), '1080p 60 fps VP9 / OPUS', 'SDR antes do HDR');
  assert.equal(labelOf(defaultChoice(list, 2160, 'vp9')), '2160p 60 fps VP9 / OPUS');
  assert.equal(labelOf(defaultChoice(list, 2160, 'h264')), '1080p 60 fps H264 / AAC');
  // Um formato que o video nao tem vale como automatico.
  const noVp9 = list.filter((choice) => choice.family === 'h264');
  assert.equal(noVp9[defaultChoice(noVp9, 1080, 'vp9')].label, '1080p 60 fps H264 / AAC');
});

test('trocar H.264 <-> VP9 <-> automatico em qualquer ordem: cada troca vale e fica guardada (settings.json)', () => {
  const expected = { auto: '1080p 60 fps H264 / AAC', h264: '1080p 60 fps H264 / AAC', vp9: '1080p 60 fps VP9 / OPUS' };
  const orders = [['auto', 'h264', 'vp9'], ['auto', 'vp9', 'h264'], ['h264', 'auto', 'vp9'], ['h264', 'vp9', 'auto'], ['vp9', 'auto', 'h264'], ['vp9', 'h264', 'auto']];
  for (const order of orders) {
    for (const codec of [...order, ...order.slice().reverse(), 'vp9', 'h264', 'vp9', 'auto']) {
      setTubeCodec(codec);
      assert.equal(tubeCodec(), codec, `${order}: ${codec}`);
      // O app reaberto le do arquivo.
      forgetTubeCodec();
      assert.equal(tubeCodec(), codec, `${order}: ${codec} guardado`);
      assert.equal(JSON.parse(globalThis.__stubFiles.get([...globalThis.__stubFiles.keys()].find((key) => key.endsWith('/settings.json')))).tubeCodec, codec);
      // O proximo video abre no formato guardado.
      assert.equal(labelOf(defaultChoice(list, 1080, tubeCodec())), expected[codec], `${order}: ${codec} no proximo video`);
    }
  }
  setTubeCodec('hevc');
  assert.equal(tubeCodec(), 'auto', 'um valor fora da lista nao entra');
  globalThis.__stubFiles.clear();
  forgetTubeCodec();
  assert.equal(tubeCodec(), 'auto', 'padrao: automatico');
});

test('erro do player: desce no mesmo formato (o H.264 nao vira VP9 sozinho), depois os outros, sem repetir', () => {
  const h1080 = at('1080p 60 fps H264 / AAC');
  // Antes (glibren.53): a proxima da lista, o VP9 da mesma altura.
  assert.equal(labelOf(h1080 + 1), '1080p 60 fps VP9 / OPUS');
  const tried = new Set([labelOf(h1080)]);
  let next = fallbackChoice(list, h1080, tried);
  assert.equal(labelOf(next), '720p 60 fps H264 / AAC');
  tried.add(labelOf(next));
  next = fallbackChoice(list, next, tried);
  assert.equal(labelOf(next), '720p 30 fps H264 / AAC');
  tried.add(labelOf(next));
  // glibren.59: sem mais H.264 o VP9 NAO entra sozinho (pisca no PS5): -1, o player diz o erro; VP9 so pelo R2.
  assert.equal(fallbackChoice(list, next, tried), -1, 'sem mais H.264: nada (VP9 so manual)');
  // VP9 escolhido que falha: desce no VP9.
  assert.equal(labelOf(fallbackChoice(list, at('1440p 60 fps VP9 / OPUS'), new Set(['1440p 60 fps VP9 / OPUS']))), '1080p 60 fps VP9 / OPUS');
  // Tudo tentado: -1 (o player diz o erro).
  assert.equal(fallbackChoice(list, 0, new Set(list.map((choice) => choice.label))), -1);
  assert.equal(fallbackChoice([], 0), -1);
});

test('aviso no R2: VP9 com H.264 na mesma altura, VP9 so, VP9 HDR pelo processador; H.264 sem aviso', () => {
  assert.equal(choiceNote(list, at('1080p 60 fps H264 / AAC')), '');
  assert.equal(choiceNote(list, at('1080p 60 fps VP9 / OPUS')), 'vp9');
  assert.equal(choiceNote(list, at('1440p 60 fps VP9 / OPUS')), 'vp9only');
  assert.equal(choiceNote(list, at('2160p 60 fps VP9 / OPUS')), 'vp9only');
  assert.equal(choiceNote(list, at('1080p 60 fps VP9 / OPUS HDR10')), 'cpu');
  assert.equal(choiceNote(list, 99), '');
});
