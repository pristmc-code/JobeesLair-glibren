// glibren.57 (abertura minima, app/state/opening.js): com a chave "Abertura minima" ligada (o padrao, tambem para quem
// atualiza: a chave ausente no settings.json vale ligada) a Jobe abre so com o logo e o anel girando ate a loja; nenhum
// dialogo (termos, novidades, queda, pergunta dos relatorios, oferta de atualizacao) e nenhuma faixa de recados. A ordem
// das camadas ate a loja: opening -> store+opening -> store. Desligada, volta a abertura antiga (splash, termos, vortice).
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const repo = process.env.JL_REPO || fileURLToPath(new URL('..', import.meta.url));
const load = (rel) => import(pathToFileURL(path.join(repo, rel)).href);
globalThis.__stubFiles = new Map();
const opening = await load('app/state/opening.js');
const { loadList, saveList } = await load('app/state/saved.js');

const settings = () => loadList('settings.json', 'settings');
function freshSettings(values) {
  globalThis.__stubFiles.clear();
  if (values) saveList('settings.json', 'settings', values);
  opening.resetOpening();
}

test('quem atualiza (settings.json sem a chave) ja cai na abertura minima', () => {
  freshSettings({ language: 'pt-BR', crashSeen: '1', theme: 'dark' });
  assert.equal(settings().minimalOpening, undefined, 'a chave nao existe no settings.json antigo');
  assert.equal(opening.minimalOpening(), true);
  freshSettings(null);
  assert.equal(opening.minimalOpening(), true, 'sem settings.json nenhum tambem');
});

test('chave ligada: nenhum dialogo, nenhum "OK (10)", nenhuma faixa; o que saiu fica em Configuracoes > Sobre', () => {
  freshSettings({});
  const plan = opening.openingPlan();
  assert.deepEqual(plan, { intro: 'mark', terms: 'silent', reveal: false, whatsNew: 'settings', crash: 'settings', autoReportAsk: 'off', announcementBar: 'settings', updateOffer: 'badge' });
  assert.ok(!Object.values(plan).includes('modal'), 'nada abre por cima');
  assert.ok(!Object.values(plan).includes('every-launch'), 'os termos nao aparecem');
  assert.notEqual(plan.announcementBar, 'bar');
  // Termos: aceitos em silencio uma vez; nunca mais perguntados.
  assert.equal(opening.termsAccepted(), false);
  assert.equal(opening.acceptTerms('silently, minimal opening'), true);
  assert.equal(opening.termsAccepted(), true);
  assert.equal(settings().termsAccepted, true);
  assert.equal(opening.acceptTerms('again'), false);
  assert.equal(opening.openingPlan().terms, false);
});

test('a ordem ate a loja: so o logo -> loja montada embaixo do logo -> so a loja (sem termos, splash nem vortice)', () => {
  const steps = [
    opening.bootLayers({ minimal: true, booted: false, curtain: true }),
    opening.bootLayers({ minimal: true, booted: true, curtain: true }),
    opening.bootLayers({ minimal: true, booted: true, curtain: false })
  ];
  assert.deepEqual(steps, [['opening'], ['store', 'opening'], ['store']]);
  for (const layers of steps) for (const name of ['terms', 'splash', 'reveal']) assert.ok(!layers.includes(name), `${name} nao aparece`);
  // O logo antes e depois de a loja montar e a mesma camada (index.jsx usa a mesma chave: nao recomeca).
  assert.equal(steps[0].at(-1), steps[1].at(-1));
});

test('chave desligada: volta a abertura antiga (splash, termos a cada abertura, vortice, avisos por cima)', () => {
  freshSettings({ termsAccepted: true });
  opening.setMinimalOpening(false);
  assert.equal(settings().minimalOpening, false, 'gravada no settings.json');
  opening.resetOpening();
  assert.equal(opening.minimalOpening(), false, 'lida de novo na proxima abertura');
  assert.deepEqual(opening.openingPlan(), { intro: 'splash', terms: 'every-launch', reveal: true, whatsNew: 'modal', crash: 'modal', autoReportAsk: 'modal', announcementBar: 'bar', updateOffer: 'modal' });
  assert.deepEqual(opening.bootLayers({ minimal: false, booted: false, curtain: true }), ['splash']);
  assert.deepEqual(opening.bootLayers({ minimal: false, booted: false, curtain: true, introLeaving: true }), ['terms', 'splash']);
  assert.deepEqual(opening.bootLayers({ minimal: false, booted: false, curtain: true, introDone: true }), ['terms']);
  assert.deepEqual(opening.bootLayers({ minimal: false, booted: true, curtain: true, introDone: true }), ['store', 'reveal']);
  assert.deepEqual(opening.bootLayers({ minimal: false, booted: true, curtain: false, introDone: true }), ['store']);
  opening.setMinimalOpening(true);
  assert.equal(settings().minimalOpening, true);
  freshSettings({});
});

test('com a chave ligada, novidades, queda e oferta de atualizacao nao abrem sozinhas (o codigo pergunta a chave)', async () => {
  const fs = await import('node:fs');
  const read = (rel) => fs.readFileSync(path.join(repo, rel), 'utf8');
  assert.match(read('app/ui/WhatsNew.jsx'), /minimalOpening\(\) \|\| !shouldShowWhatsNew\(\)/);
  assert.match(read('app/ui/CrashNotice.jsx'), /const crash = minimal \? null : pending/);
  assert.match(read('app/state/update.js'), /if \(minimalOpening\(\)\) \{/);
  assert.match(read('app/state/bug-report.js'), /minimalOpening\(\)\) return;/);
  assert.match(read('app/index.jsx'), /immersive \|\| minimal \? null : jsx\(AnnouncementBar/);
  // O anel nao pode congelar: na abertura minima o catalogo nao e apressado (quadros de ate ~25 ms, state/frame-pace.js).
  const boot = read('app/index.jsx');
  assert.ok(!/setTimeout\(hurryCatalog/.test(boot), 'nada de hurryCatalog por tempo na abertura minima');
});
