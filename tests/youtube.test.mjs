// "Videos" on a game's page (app/state/youtube.js and the helper's LNC1 request in app/native/companion_daemon.c):
// the search made from the game's name, which YouTube app is chosen (never the official one), the search file
// written whole then renamed, and the helper launching only an allowed title. Run: npm test
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = process.env.JL_REPO || fileURLToPath(new URL('..', import.meta.url));
const yt = await import(pathToFileURL(path.join(repo, 'app/state/youtube.js')).href);
const bytes = (text) => Buffer.byteLength(text, 'utf8');

// A file system of paths to text that records what was done to it, in order.
function memoryFs(paths = []) {
  const files = new Map(paths.map((p) => [p, '']));
  const log = [];
  return {
    files, log,
    exists: (p) => files.has(p),
    writeFile(p, text, options) { log.push(['write', p, options?.sync === true]); files.set(p, String(text)); },
    readFile(p) { if (!files.has(p)) throw new Error(`ENOENT ${p}`); return files.get(p); },
    rename(from, to) { log.push(['rename', from, to]); if (!files.has(from)) throw new Error(`ENOENT ${from}`); files.set(to, files.get(from)); files.delete(from); },
    chmod(p, mode) { log.push(['chmod', p, mode]); },
    mkdir() {},
    remove(p) { log.push(['remove', p]); files.delete(p); },
  };
}

test('the search is the game\'s clean name and the kind', () => {
  assert.equal(yt.searchText('Marvel\'s Spider-Man 2', 'gameplay'), 'Marvel\'s Spider-Man 2 gameplay');
  assert.equal(yt.searchText('ASTRO BOT', 'trailer'), 'ASTRO BOT trailer');
  assert.equal(yt.searchText('  Gran   Turismo™ 7®\n\r\t', 'gameplay'), 'Gran Turismo 7 gameplay');
  assert.equal(yt.searchText('Pokémon © Edition', 'gameplay'), 'Pokémon Edition gameplay');
  assert.equal(yt.searchText('Game', 'something else'), 'Game gameplay', 'an unknown kind is gameplay');
  assert.equal(yt.searchText('', 'gameplay'), '');
  assert.equal(yt.searchText('™ \n', 'gameplay'), '', 'nothing left of the name');
  assert.equal(yt.searchText(undefined), '');
  assert.ok(!/[\r\n]/.test(yt.searchText('A\r\nB')), 'one line');
  assert.equal(yt.searchText('A\uD800B'), 'A B gameplay', 'a lone surrogate is dropped');
});

test('the search is at most 200 bytes and never cuts a character', () => {
  for (const unit of ['a', 'é', '漢', '😀', 'aé漢😀']) {
    for (let count = 1; count < 260; count += 7) {
      const text = yt.searchText(unit.repeat(count), 'trailer');
      assert.ok(bytes(text) <= 200, `${unit} x${count}: ${bytes(text)} bytes`);
      assert.ok(text.endsWith(' trailer'), 'the kind is kept');
      assert.ok(!text.includes('�') && Buffer.from(text, 'utf8').toString('utf8') === text, 'whole characters');
      if (bytes(unit.repeat(count)) + 8 <= 200) assert.equal(text, `${unit.repeat(count)} trailer`, 'a short name is not cut');
    }
  }
  assert.equal(yt.fitUtf8('aé漢', 3), 'aé');
  assert.equal(yt.fitUtf8('aé漢', 5), 'aé');
  assert.equal(yt.fitUtf8('aé漢', 6), 'aé漢');
  assert.equal(yt.fitUtf8('😀', 3), '');
  assert.equal(yt.utf8Length('aé漢😀'), 1 + 2 + 3 + 4);
});

test('ytps5 first, then YouTube Max\'d, else none; never the official app', () => {
  const both = memoryFs(['/data/homebrew/PPSA99350/eboot.bin', '/data/homebrew/PPSA99991/eboot.bin']);
  assert.equal(yt.findVideoApp(both).titleId, 'PPSA99350');
  assert.equal(yt.findVideoApp(both).folder, '/data/homebrew/PPSA99350');
  const maxd = memoryFs(['/data/homebrew/PPSA99991/eboot.bin']);
  assert.equal(yt.findVideoApp(maxd).titleId, 'PPSA99991');
  // Its system entry and its folder (no eboot.bin seen) counts; the entry alone does not, there is no folder to write to.
  assert.equal(yt.findVideoApp(memoryFs(['/user/appmeta/PPSA99991', '/data/homebrew/PPSA99991'])).titleId, 'PPSA99991');
  assert.equal(yt.findVideoApp(memoryFs(['/user/appmeta/PPSA99350'])), null);
  // The official app installed (any region) is never chosen, even if a list names it.
  const official = memoryFs(['/data/homebrew/PPSA01650/eboot.bin', '/user/appmeta/PPSA01650', '/user/appmeta/PPSA01651', '/user/appmeta/PPSA01652']);
  assert.equal(yt.findVideoApp(official), null);
  assert.equal(yt.findVideoApp(official, [{ titleId: 'PPSA01650', name: 'YouTube' }]), null);
  assert.equal(yt.findVideoApp(memoryFs([])), null);
  assert.deepEqual(yt.VIDEO_APPS.map((app) => app.titleId), ['PPSA99350', 'PPSA99991']);
  const throwing = { exists() { throw new Error('EPERM'); } };
  assert.equal(yt.findVideoApp(throwing), null, 'a refused look is "not installed"');
});

test('the search file is written whole as .tmp, then renamed into place', () => {
  const fs = memoryFs(['/data/homebrew/PPSA99350/eboot.bin']);
  const app = yt.findVideoApp(fs);
  const at = yt.writeSearch(fs, app, 'ASTRO BOT gameplay');
  assert.equal(at, '/data/homebrew/PPSA99350/glibren_busca.txt');
  assert.deepEqual(fs.log, [
    ['write', '/data/homebrew/PPSA99350/glibren_busca.txt.tmp', true],
    ['chmod', '/data/homebrew/PPSA99350/glibren_busca.txt.tmp', 0o666],
    ['rename', '/data/homebrew/PPSA99350/glibren_busca.txt.tmp', '/data/homebrew/PPSA99350/glibren_busca.txt'],
  ]);
  assert.equal(fs.files.get(at), 'ASTRO BOT gameplay', 'no new line');
  assert.ok(!fs.files.has(`${at}.tmp`));
});

test('openVideos: writes the search, then sends LNC1 to the helper; says why when it cannot', () => {
  const sent = [];
  const payloads = { send: (file, options) => (sent.push([file, options]), { ok: true }) };
  const fs = memoryFs(['/data/homebrew/PPSA99991/eboot.bin', '/pl/launch.txt']);
  const result = yt.openVideos({ fs, payloads, name: 'Returnal™', kind: 'trailer', payloadDir: '/pl' });
  assert.equal(result.ok, true);
  assert.equal(result.text, 'Returnal trailer');
  assert.equal(fs.files.get('/data/homebrew/PPSA99991/glibren_busca.txt'), 'Returnal trailer');
  assert.ok(!fs.files.has('/pl/launch.txt'), 'the last answer is cleared first');
  assert.deepEqual(sent, [['/app0/companion-daemon.elf', { request: 'LNC1\nPPSA99991\n/pl\n', answer: false }]]);
  const writeBefore = fs.log.findIndex((entry) => entry[0] === 'rename');
  assert.ok(writeBefore >= 0, 'the search is in place before the launch is asked');

  assert.deepEqual(yt.openVideos({ fs: memoryFs([]), payloads, name: 'X', payloadDir: '/pl' }), { ok: false, reason: 'missing', error: '' });
  assert.equal(yt.openVideos({ fs: memoryFs(['/data/homebrew/PPSA99350/eboot.bin']), payloads, name: '', payloadDir: '/pl' }).reason, 'name');
  const readOnly = { ...memoryFs(['/data/homebrew/PPSA99350/eboot.bin']), writeFile() { throw new Error('EACCES'); } };
  const write = yt.openVideos({ fs: readOnly, payloads, name: 'X', payloadDir: '/pl' });
  assert.deepEqual([write.reason, write.error], ['write', 'EACCES']);
  const noLoader = yt.openVideos({ fs: memoryFs(['/data/homebrew/PPSA99350/eboot.bin']), payloads: { send: () => ({ ok: false, error: 'connect: refused' }) }, name: 'X', payloadDir: '/pl' });
  assert.deepEqual([noLoader.reason, noLoader.error], ['send', 'connect: refused']);
  assert.equal(yt.openVideos({ fs: memoryFs(['/data/homebrew/PPSA99350/eboot.bin']), payloads: null, name: 'X', payloadDir: '/pl' }).reason, 'send');
});

test('launchAnswer reads what the helper wrote', () => {
  const answer = (text) => {
    const fs = memoryFs([]);
    fs.files.set('/pl/launch.txt', text);
    return yt.launchAnswer(fs, '/pl');
  };
  assert.deepEqual(answer('launched\n'), { state: 'launched', code: '' });
  assert.deepEqual(answer('running\n'), { state: 'running', code: '' });
  assert.deepEqual(answer('failed 0x80940005\n'), { state: 'failed', code: '0x80940005' });
  assert.deepEqual(answer('refused\n'), { state: 'refused', code: '' });
  assert.deepEqual(answer('garbage'), { state: 'none', code: '' });
  assert.deepEqual(yt.launchAnswer(memoryFs([]), '/pl'), { state: 'none', code: '' });
});

// The helper itself, built for the desktop (-DCOMPANION_HOST_TEST, where a launch writes the title to
// $COMPANION_TEST_RUNNING).
const compiler = process.platform === 'win32' ? null : ['cc', 'gcc', 'clang'].find((name) => spawnSync(name, ['--version']).status === 0);
const dir = mkdtempSync(path.join(os.tmpdir(), 'jl-videos-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const binary = path.join(dir, 'companion-daemon');
let built = null;
const build = () => built ??= spawnSync(compiler, ['-std=gnu11', '-O2', '-Wall', '-Wextra', '-Werror', '-DCOMPANION_HOST_TEST', '-o', binary, path.join(repo, 'app/native/companion_daemon.c')], { encoding: 'utf8' });
const run = (request, env = {}) => spawnSync(binary, [], { input: request, encoding: 'utf8', timeout: 10000, env: { ...process.env, COMPANION_TEST_CONTROL: '1', ...env } });

test('the helper launches ytps5 or YouTube Max\'d and nothing else (LNC1)', { skip: compiler ? false : 'no C compiler' }, () => {
  assert.equal(build().status, 0, build().stderr);
  const running = path.join(dir, 'running');
  for (const title of ['PPSA99350', 'PPSA99991']) {
    rmSync(running, { force: true });
    rmSync(path.join(dir, 'launch.txt'), { force: true });
    const out = run(yt.launchRequest(title, dir), { COMPANION_TEST_RUNNING: running });
    assert.equal(out.status, 0, out.stderr);
    assert.equal(out.stdout, 'launched\n');
    assert.equal(readFileSync(path.join(dir, 'launch.txt'), 'utf8'), 'launched\n');
    assert.equal(readFileSync(running, 'utf8'), title, 'that very title');
  }
  for (const title of ['PPSA01650', 'PPSA01651', 'PPSA01652', 'PPSA99471', 'CUSA00001', '../x']) {
    rmSync(running, { force: true });
    const out = run(yt.launchRequest(title, dir), { COMPANION_TEST_RUNNING: running });
    assert.equal(out.status, 1);
    assert.equal(out.stdout, 'refused\n', title);
    assert.ok(!existsSync(running), `${title} is never launched`);
  }
  // No way to launch (here: no $COMPANION_TEST_RUNNING) and not running: the failure is said.
  const failed = run(yt.launchRequest('PPSA99350', dir), { COMPANION_TEST_RUNNING: '' });
  assert.match(failed.stdout, /^failed 0x[0-9a-f]{8}\n$/);
  assert.equal(readFileSync(path.join(dir, 'launch.txt'), 'utf8'), failed.stdout);
  // A bad folder is refused before anything is launched.
  assert.equal(run('LNC1\nPPSA99350\nrelative/dir\n', { COMPANION_TEST_RUNNING: running }).status, 1);
});
