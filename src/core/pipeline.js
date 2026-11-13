// Çözme hattı: girdi çözümleme (wasm / wat / JS yükleyici) → binaryen ile normalleştirme → davranış temeli →
// değişiklik durana kadar pass turları → çıktı (wasm, WAT, sözde C). Her pass'ten sonra modül WebAssembly.validate
// ile denetlenir ve sandbox'ta çalıştırılıp başlangıç sonucu, dışa açık fonksiyonların dönüş değerleri/tuzakları,
// kaydedilen import çağrıları (argümanlarıyla), bellek özeti ve dışa açık global'ler temelle karşılaştırılır;
// fark varsa geri alınır.
import { PASSES } from './registry.js';
import { loadBinaryen, readModule, emit, watToWasm } from './ir.js';
import { extractModule } from './input.js';
import { instrument } from './instrument.js';
import { pseudoC } from './pseudo.js';
import { fnv1a } from './wasm-bin.js';
import { scan } from './scan.js';

const MAX_ROUNDS = 8;
const MAX_SNAPSHOT_TEXT = 2_000_000;

const snapshotOf = (r) => JSON.stringify({
  ok: Boolean(r.ok),
  start: r.startError ?? null,
  calls: (r.calls ?? []).map((c) => `${c.export}=${c.result}`),
  fx: r.fx ?? [],
  mem: r.memHash ?? null,
  globals: r.globals ?? null,
});

const safeValidate = (bytes) => { try { return WebAssembly.validate(bytes); } catch { return false; } };

/**
 * @param {Uint8Array|string} input
 * @param {{ sandbox, only?: string[], onLog?, onPass?, onSnapshot?, signal?, B? }} o
 */
export async function deobfuscate(input, { sandbox, only = null, onLog = () => {}, onPass = () => {}, onSnapshot = () => {}, signal = null } = {}) {
  if (!sandbox) throw new Error('sandbox gerekli');
  const t0 = Date.now();
  const B = await loadBinaryen();
  const stats = {};
  const notes = {};
  const events = [];
  const log = (m, level = 'info') => onLog(m, level);
  const checkAbort = () => { if (signal?.aborted) throw new Error('Durduruldu'); };

  const src = extractModule(input, { watToWasm: (t) => watToWasm(B, t) });
  if (src.error) return { error: src.error, events, stats };
  if (src.kind === 'js-loader') log(`JS yükleyicisinden ${src.layers.length} gömülü modül çıkarıldı (${src.layers.map((l) => `${l.kind} ${l.size} B`).join(', ')})`, 'info');
  if (!safeValidate(src.bytes)) log('WebAssembly.validate modülü reddetti; binaryen ile okunmaya çalışılacak', 'warn');

  let code;
  try {
    const m = readModule(B, src.bytes);
    try { code = emit(B, m); } finally { m.dispose(); }
  } catch (e) {
    return { error: `Modül okunamadı: ${String(e?.message ?? e).split('\n')[0]}`, events, stats, input: src };
  }

  // sandbox: yakıtlı kopya + çağrı planı; plan temel çalıştırmadan sonra yakıtı biten ilk çağrıda kesilir
  let plan = null;
  const execute = async (bytes, extra = {}) => {
    const ins = instrument(B, bytes);
    return sandbox.run({ wasm: ins.wasm, imports: ins.imports, calls: extra.calls ?? plan ?? ins.calls, dumpMemory: Boolean(extra.dumpMemory) });
  };
  const first = await execute(src.bytes).catch((e) => ({ ok: false, error: e.message }));
  let baseline = null;
  if (!first.ok) log(`sandbox: ${first.error}`, 'warn');
  else if (first.startError === 'fuel' || first.startError === 'stack') log(`başlangıç fonksiyonu bitmedi (${first.startError}); yalnızca statik dönüşümler`, 'warn');
  else {
    const all = instrument(B, src.bytes).calls;
    const cut = first.calls.findIndex((c) => c.result === 'fuel' || c.result === 'stack');
    plan = cut >= 0 ? all.slice(0, cut) : all;
    if (cut >= 0) log(`${first.calls[cut].export}: yakıt bitti; doğrulama ilk ${cut} çağrıyla yapılır`, 'info');
    const orig = cut >= 0 ? await execute(src.bytes) : first;
    const norm = await execute(code);
    baseline = snapshotOf(orig);
    if (!orig.ok) baseline = null;
    else if (snapshotOf(norm) !== baseline) {
      log('binaryen normalleştirmesi davranışı değiştirdi; özgün modül korunuyor', 'warn');
      code = src.bytes;
    }
    log(`sandbox: ${first.calls.length} çağrı, ${first.fx.length} import çağrısı kaydedildi${first.startError ? ` (başlangıç: ${first.startError})` : ''}`, 'info');
  }
  const behaves = async (bytes) => {
    if (!baseline) return true;
    const r = await execute(bytes);
    return r.ok && snapshotOf(r) === baseline;
  };

  const ctx = {
    B,
    log,
    bump: (k, n = 1) => { if (n) stats[k] = (stats[k] ?? 0) + n; },
    note: (k, v) => { notes[k] = v; },
    execute: (bytes, extra) => (baseline ? execute(bytes, extra) : null),
  };

  const passes = PASSES.filter((p) => (!only || only.includes(p.id)) && (!p.needsSandbox || baseline));
  const seen = new Set([fnv1a(code)]);
  const snapText = (bytes) => {
    if (bytes.length > MAX_SNAPSHOT_TEXT / 4) return null;
    const m = readModule(B, bytes);
    try { return m.emitText(); } finally { m.dispose(); }
  };
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    let changed = false;
    for (const p of passes) {
      checkAbort();
      const t = Date.now();
      onPass(p.id, 'run');
      const saved = { ...stats };
      let next;
      try {
        next = await p.run(code, ctx);
      } catch (e) {
        Object.assign(stats, saved);
        for (const k of Object.keys(stats)) if (!(k in saved)) delete stats[k];
        log(`${p.id}: ${String(e?.message ?? e).split('\n')[0]}, geri alındı`, 'warn');
        events.push({ id: p.id, round, state: 'fail', reason: e.message, ms: Date.now() - t });
        onPass(p.id, 'fail');
        continue;
      }
      checkAbort();
      const rollback = (reason, msg) => {
        for (const k of Object.keys(stats)) if (!(k in saved)) delete stats[k];
        Object.assign(stats, saved);
        log(`${p.id}: ${msg}, geri alındı`, 'warn');
        events.push({ id: p.id, round, state: 'fail', reason, ms: Date.now() - t });
        onPass(p.id, 'fail');
      };
      if (!next || (next.length === code.length && fnv1a(next) === fnv1a(code) && next.every((b, i) => b === code[i]))) {
        Object.assign(stats, saved);
        events.push({ id: p.id, round, state: 'skip', ms: Date.now() - t });
        onPass(p.id, 'skip');
        continue;
      }
      if (!safeValidate(next)) { rollback('validate', 'çıktı doğrulanamadı'); continue; }
      if (!(await behaves(next))) { rollback('davranış', 'davranış değişti'); continue; }
      code = next;
      changed = true;
      events.push({ id: p.id, round, state: 'ok', ms: Date.now() - t });
      onPass(p.id, 'ok');
      const text = snapText(code);
      if (text) onSnapshot({ id: p.id, round, code: text });
    }
    const h = fnv1a(code);
    if (!changed || seen.has(h)) break;
    seen.add(h);
  }

  const m = readModule(B, code);
  let text;
  let pseudo;
  try {
    text = m.emitText();
    pseudo = pseudoC(B, m);
  } finally { m.dispose(); }
  const final = baseline ? await execute(code) : null;
  const facts = { in: scan(B, src.bytes), out: scan(B, code) };
  return {
    facts,
    bytes: code,
    text,
    pseudo,
    stats,
    notes,
    events,
    verified: Boolean(baseline),
    input: src,
    trace: { first, final },
    ms: Date.now() - t0,
  };
}
