// CLI uçtan uca: dosya ve dizin girdisi, çıktı biçimleri, rapor, --fail-on, kullanım hataları.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeFixture } from './fixture-codec.js';

const bin = fileURLToPath(new URL('../bin/peel-wasm.js', import.meta.url));
const run = (...args) => spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', timeout: 120_000 });
const fixture = (name) => {
  const fx = JSON.parse(decodeFixture(readFileSync(new URL(`./fixtures/${name}.json.x`, import.meta.url), 'utf8')).toString('utf8'));
  return fx.kind === 'wasm' ? Buffer.from(fx.input, 'base64') : Buffer.from(fx.input);
};

const dir = mkdtempSync(join(tmpdir(), 'peel-wasm-cli-'));
try {
  const cff = join(dir, 'cff.wasm');
  writeFileSync(cff, fixture('cff-calc'));
  // stdout'a WAT; -o .wasm + --c; JSON rapor dosyası
  const a = run(cff, '-q');
  assert.equal(a.status, 0, a.stderr);
  assert.match(a.stdout, /^\(module/);
  assert.ok(!a.stdout.includes('br_table'));
  const out = join(dir, 'out.wasm');
  const c = join(dir, 'out.c');
  const rep = join(dir, 'rep.json');
  const b = run(cff, '-o', out, '--c', c, '-r', rep, '--lang', 'en');
  assert.equal(b.status, 0, b.stderr);
  assert.ok(WebAssembly.validate(readFileSync(out)));
  assert.match(readFileSync(c, 'utf8'), /int calc\(int x\)/);
  const json = JSON.parse(readFileSync(rep, 'utf8'));
  assert.equal(json.verified, true);
  assert.ok(json.report.detection.some((d) => d.id === 'cff'));
  assert.match(json.report.summary, /Techniques/);
  assert.match(b.stderr, /\[none 0\/100\]/);

  // dizin girdisi: yapı korunur, rapor dizisi; --fail-on madenci yüzünden 4 döner
  const tree = join(dir, 'tree');
  mkdirSync(join(tree, 'sub'), { recursive: true });
  writeFileSync(join(tree, 'clean.wasm'), fixture('clean'));
  writeFileSync(join(tree, 'sub', 'm.wasm'), fixture('miner-like'));
  writeFileSync(join(tree, 'notes.md'), 'yok sayılır');
  const outDir = join(dir, 'outdir');
  const d = run(tree, '-d', outDir, '-f', 'c', '--json', '--fail-on', 'high', '-q');
  assert.equal(d.status, 4, d.stderr);
  const arr = JSON.parse(d.stdout);
  assert.deepEqual(arr.map((e) => e.file), ['clean.wasm', 'sub/m.wasm']);
  assert.ok(existsSync(join(outDir, 'sub', 'm.peeled.c')));
  assert.equal(arr[1].report.threat.classes[0].id, 'cryptojacking');

  // JS yükleyici stdin'den; metin rapor
  const js = spawnSync(process.execPath, [bin, '-', '-r', 'text'], { input: fixture('js-loader'), encoding: 'utf8', timeout: 120_000 });
  assert.equal(js.status, 0, js.stderr);
  assert.match(js.stdout, /JS yükleyici/);

  // hatalar
  assert.equal(run('--nope').status, 2);
  assert.equal(run(cff, '-f', 'pdf').status, 2);
  assert.equal(run(cff, '--only', 'nosuch').status, 2);
  const bad = join(dir, 'bad.txt');
  writeFileSync(bad, 'wasm yok');
  const e = run(bad, '-q');
  assert.equal(e.status, 1);
  assert.match(run('--help', '--lang', 'en').stdout, /peel-wasm <file\|dir\|->/);
  console.log('cli: ok');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
