// glibren.15: o updater.elf (ps5-react/native/ps5/payloads/updater.c) no PC, pelo teste do ps5-react
// (tools/test_updater.py): compila com gcc e clang (-Wall -Wextra -Werror) e roda contra um ShadowMount+ de
// mentira. Inclui a reabertura depois da troca: espera o titulo pronto no games/info, tenta de novo quando o
// console recusa, e sem conseguir avisa o jogador para abrir o app pela tela inicial.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../ps5-react/tools/test_updater.py', import.meta.url));
const has = (tool) => spawnSync(tool, ['--version'], { stdio: 'ignore' }).status === 0;
const missing = ['python3', 'gcc', 'clang'].filter((tool) => !has(tool));

test('updater.elf: troca, volta e reabertura que espera o ShadowMount+', { skip: missing.length ? `sem ${missing.join(', ')}` : false, timeout: 180000 }, () => {
  const run = spawnSync('python3', [script], { encoding: 'utf8', timeout: 170000 });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout, /^PASS: updater payload;.*relaunch waits for ShadowMount\+, retries and the open-it-yourself notice/m);
});
