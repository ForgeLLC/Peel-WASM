// Fixture testleri: test/fixtures/*.json.x tam hattan (sandbox + davranış doğrulaması + rapor) geçer. Fixture'lar
// diskte XOR + base64'tür (madenci imzası ve yükleyici örnekleri antivirüsü tetiklemesin), yalnızca bellekte çözülür.
// Üretim: node scripts/make-fixtures.js
//   node test/run.js              hepsi
//   node test/run.js cff          adında "cff" geçenler, log ve WAT çıktısıyla
// Beklentiler (expect):
//   verified        davranış doğrulaması yapılmış olmalı
//   stats {k: n}    pass istatistiği en az n
//   contains/gone   WAT çıktısında bulunmalı / bulunmamalı
//   detect [id]     rapor tespitlerinde bu kimlikler olmalı; noTechniques → hiç 'technique' olmamalı
//   threatMin/Max   tehdit düzeyi sınırları; threatClass → bu sınıf bulunmalı
//   toolchain, stdout, network, protection, kind, loads, functionsOut, iocs {anahtar: sayı | [değerler]}
import { readdirSync, readFileSync } from 'node:fs';
import { createNodeSandbox } from '../src/sandbox/node-host.js';
import { peel } from '../src/index.js';
import { decodeFixture } from './fixture-codec.js';

const dir = new URL('./fixtures/', import.meta.url);
const filter = process.argv[2];
const files = readdirSync(dir).filter((f) => f.endsWith('.json.x') && (!filter || f.includes(filter))).sort();
const LEVELS = ['none', 'low', 'medium', 'high', 'critical'];

const sb = createNodeSandbox();
let pass = 0;
const t0 = Date.now();
try {
  for (const f of files) {
    const fx = JSON.parse(decodeFixture(readFileSync(new URL(f, dir), 'utf8')).toString('utf8'));
    const input = fx.kind === 'wasm' ? new Uint8Array(Buffer.from(fx.input, 'base64')) : fx.input;
    const logs = [];
    const r = await peel(input, { sandbox: sb, onLog: (m, l) => logs.push(`[${l}] ${m}`) });
    const e = fx.expect;
    const rep = r.report;
    const out = r.text ?? '';
    const fails = [];
    const check = (ok, msg) => { if (!ok) fails.push(msg); };
    check(!r.error, `hata: ${r.error}`);
    if (e.verified) check(r.verified, 'davranış doğrulanamadı');
    for (const [k, n] of Object.entries(e.stats ?? {})) check((r.stats?.[k] ?? 0) >= n, `stats.${k} = ${r.stats?.[k] ?? 0} < ${n}`);
    for (const s of e.contains ?? []) check(out.includes(s), `contains yok: ${s}`);
    for (const s of e.gone ?? []) check(!out.includes(s), `gone duruyor: ${s}`);
    const ids = new Set(rep.detection.map((d) => d.id));
    for (const id of e.detect ?? []) check(ids.has(id), `tespit yok: ${id} (var: ${[...ids].join(', ')})`);
    if (e.noTechniques) check(!rep.detection.some((d) => d.kind === 'technique' || d.kind === 'malware'), `yanlış pozitif: ${rep.detection.map((d) => d.id).join(', ')}`);
    const lv = LEVELS.indexOf(rep.threat.level);
    if (e.threatMin) check(lv >= LEVELS.indexOf(e.threatMin), `tehdit ${rep.threat.level} < ${e.threatMin}`);
    if (e.threatMax) check(lv <= LEVELS.indexOf(e.threatMax), `tehdit ${rep.threat.level} > ${e.threatMax}`);
    if (e.threatClass) check(rep.threat.classes.some((c) => c.id === e.threatClass), `tehdit sınıfı yok: ${e.threatClass}`);
    if (e.toolchain) check(rep.detection.some((d) => d.kind === 'toolchain' && d.id === e.toolchain), `araç zinciri yok: ${e.toolchain}`);
    if (e.stdout) check(rep.behaviour.stdout.includes(e.stdout), `stdout yok: ${e.stdout}`);
    if (e.network) check(rep.behaviour.network.some((n) => n.target.includes(e.network)), `ağ davranışı yok: ${e.network}`);
    if (e.protection) check(Boolean(rep.protection), 'koruma tanınmadı');
    if (e.kind) check(rep.metrics.inputKind === e.kind, `girdi türü ${rep.metrics.inputKind} ≠ ${e.kind}`);
    if (e.loads) check(rep.behaviour.loads >= e.loads, `yakalanan modül ${rep.behaviour.loads} < ${e.loads}`);
    if (e.functionsOut != null) check(rep.metrics.functionsOut === e.functionsOut, `fonksiyon sayısı ${rep.metrics.functionsOut} ≠ ${e.functionsOut}`);
    for (const [k, v] of Object.entries(e.iocs ?? {})) {
      const got = rep.iocs[k] ?? [];
      if (Array.isArray(v)) for (const x of v) check(got.includes(x), `IOC ${k} yok: ${x}`);
      else check(got.length >= v, `IOC ${k}: ${got.length} < ${v}`);
    }
    if (!fails.length) pass++;
    console.log(`${fails.length ? 'FAIL' : 'ok  '} ${f} (${r.ms ?? 0} ms)${fails.length ? `\n     ${fails.join('\n     ')}` : ''}`);
    if (filter) {
      console.log(logs.join('\n'));
      console.log(out);
      console.log(rep.summary);
    }
  }
} finally {
  sb.close();
}
console.log(`\ntoplam ${Date.now() - t0}ms | ${pass}/${files.length}`);
if (pass !== files.length) process.exitCode = 1;
