// glibren.30: a atualizacao acha a imagem do app mesmo com o ShadowMount+ sem responder (state/update.js locate).
import test from 'node:test';
import assert from 'node:assert/strict';

test('the update finds the app image when ShadowMount+ does not answer', { timeout: 30_000 }, async () => {
  const core = await import('@ps5-react/core');
  const keptFiles = globalThis.__stubFiles, keptRequest = core.Http.request;
  const files = new Map();
  globalThis.__stubFiles = files;
  let asked = 0;
  try {
    const { locateOwnImage } = await import(`../app/state/update.js?locate=${Date.now()}`);
    // ShadowMount+ answers: its path is remembered.
    core.Http.request = async () => { asked++; return { ok: true, status: 200, json: async () => ({ source_type: 'image', path: '/mnt/usb0/homebrew/JobeesLair.exfat' }) }; };
    assert.equal(await locateOwnImage(), '/mnt/usb0/homebrew/JobeesLair.exfat');
    // Later it is busy and does not answer: three tries, then the remembered path, while the file is there.
    files.set('/mnt/usb0/homebrew/JobeesLair.exfat', 'x');
    asked = 0;
    core.Http.request = async () => { asked++; throw new Error('connection refused'); };
    assert.equal(await locateOwnImage(), '/mnt/usb0/homebrew/JobeesLair.exfat');
    assert.equal(asked, 3);
    // The remembered file is gone: the one JobeesLair.exfat in a drive's homebrew folder.
    files.delete('/mnt/usb0/homebrew/JobeesLair.exfat');
    files.set('/mnt/ext1/homebrew/JobeesLair.exfat', 'x');
    assert.equal(await locateOwnImage(), '/mnt/ext1/homebrew/JobeesLair.exfat');
    // Two of them: no guess, the failure stands.
    files.set('/data/homebrew/JobeesLair.exfat', 'x');
    await assert.rejects(locateOwnImage(), /connection refused/);
    // An answer that is not an image is not retried nor replaced by a guess.
    asked = 0;
    core.Http.request = async () => { asked++; return { ok: true, status: 200, json: async () => ({ source_type: 'folder', path: '/data/homebrew/JobeesLair' }) }; };
    await assert.rejects(locateOwnImage());
    assert.equal(asked, 1);
  } finally {
    globalThis.__stubFiles = keptFiles;
    core.Http.request = keptRequest;
  }
});
