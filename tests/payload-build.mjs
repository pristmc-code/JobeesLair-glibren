// glibren.51: compilacao dos binarios de teste (payload e harnesses) fora das pastas /tmp/jl-*.
//
// A limpeza de payloads orfaos de outras rodadas (pacote.sh e comandos de limpeza manuais) procura processos que citam
// /tmp/jl-*/bgdl. Com o "-o /tmp/jl-*/bgdl", o compilador (e o ld) citava esse caminho e morria no meio: a compilacao
// "falhava", o teste virava "pulado (did not compile)" e ninguem percebia. Agora o compilador escreve numa pasta
// propria (payload-cc-*, sem "jl-" nem "bgdl" no caminho) e o binario pronto e movido para o lugar no fim.
//
// E so a falta do ambiente (sem compilador, sem os cabecalhos das bibliotecas) pula um teste. Qualquer outro motivo
// (erro de compilacao, aviso com -Werror, compilador morto por sinal) e FALHA: veja buildSkip e assertBuilt.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const HEADERS_MISSING = /curl\/curl\.h|openssl\/evp\.h|archive\.h|cannot find -l/;

const place = (out, binary) => {
  try {
    renameSync(out, binary);
  } catch (error) {
    if (error.code !== 'EXDEV') throw error;
    copyFileSync(out, binary);
    chmodSync(binary, 0o755);
  }
};

// O motivo de uma compilacao que nao deu certo, com o sinal quando o compilador foi morto (stderr vazio).
const explain = (result) => {
  if (result.status === 0) return result;
  const killed = result.signal ? `\n(o compilador foi encerrado pelo sinal ${result.signal})` : '';
  return { ...result, stderr: `${result.stderr || ''}${killed}` };
};

// spawnSync(compiler, [...args, '-o', binary]) sem citar o binario final na linha de comando.
export function compileTo(binary, compiler, args) {
  const work = mkdtempSync(path.join(os.tmpdir(), 'payload-cc-'));
  const out = path.join(work, 'out');
  try {
    const result = spawnSync(compiler, [...args, '-o', out], { encoding: 'utf8' });
    if (result.status === 0) place(out, binary);
    return explain(result);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// O mesmo, assincrono (varias variantes compilando em paralelo). Resolve { code, err, signal }.
export function compileToAsync(binary, compiler, args) {
  const work = mkdtempSync(path.join(os.tmpdir(), 'payload-cc-'));
  const out = path.join(work, 'out');
  return new Promise((resolve) => {
    const child = spawn(compiler, [...args, '-o', out], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('error', (error) => { err += String(error); });
    child.on('close', (code, signal) => {
      try {
        if (code === 0) place(out, binary);
      } catch (error) {
        err += String(error);
        code = 1;
      }
      rmSync(work, { recursive: true, force: true });
      if (signal) err += `\n(o compilador foi encerrado pelo sinal ${signal})`;
      resolve({ code, err, signal });
    });
  });
}

// O "skip" de um arquivo de teste: so a falta do ambiente. Uma compilacao que falhou por outro motivo NAO pula.
export function buildSkip(compiler, built, headers = HEADERS_MISSING, label = 'no libcurl/OpenSSL/libarchive headers') {
  if (!compiler) return 'no C compiler';
  if (built && built.status !== 0 && headers.test(built.stderr || '')) return label;
  return false;
}

// Para o primeiro teste de cada arquivo: falha (nao pula) quando o binario nao foi gerado.
export function assertBuilt(built) {
  assert.ok(built, 'o binario de teste nao foi compilado');
  assert.equal(built.status, 0, `o binario de teste nao compilou (o teste falha em vez de pular):\n${built.stderr || ''}`);
}
