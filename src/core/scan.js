// Statik tarama: modülden rapor için olgular çıkarılır (import/export, bölümler, dizgeler, sabitler, dağıtıcı ve
// yorumlayıcı döngüleri). Kod çalıştırılmaz. Çok büyük modüllerde ifade gezintisi bir bütçeyle sınırlanır.
import { readModule, moduleInfo, walk, info as infoOf } from './ir.js';
import { readProducers, customSections, readNames, strings, entropy, findEmbedded, embeddedLength, sections } from './wasm-bin.js';

const EXPR_BUDGET = 1_500_000;
const hex64 = (v) => ((BigInt(v.high >>> 0) << 32n) | BigInt(v.low >>> 0)).toString(16);

export function scan(B, bytes) {
  const facts = {
    size: bytes.length,
    imports: [], exports: [], funcs: 0, exprs: 0, partial: false,
    memory: null, segments: [], strings: [], custom: [], producers: null, names: 0,
    i32: new Set(), i64: new Set(), constOps: 0, dispatchers: 0, interpLoops: 0, maxTable: 0,
    start: null, embedded: [], dataBytes: new Uint8Array(0),
  };
  try {
    facts.custom = customSections(bytes);
    facts.producers = readProducers(bytes);
    facts.names = readNames(bytes).functions.size;
  } catch { /* bozuk özel bölüm: yok sayılır */ }
  const m = readModule(B, bytes);
  try {
    const mi = moduleInfo(B, m);
    facts.start = mi.start;
    facts.memory = mi.memory ? { initial: mi.memory.initial, max: mi.memory.max ?? null, imported: Boolean(mi.memory.module) } : null;
    for (const f of mi.funcs) if (f.base) facts.imports.push({ kind: 'function', module: f.module, name: f.base, params: f.params.length });
    for (const g of mi.globals) if (g.base) facts.imports.push({ kind: 'global', module: g.module, name: g.base });
    if (mi.memory?.module) facts.imports.push({ kind: 'memory', module: mi.memory.module, name: mi.memory.base });
    for (const t of mi.tables) if (t.module) facts.imports.push({ kind: 'table', module: t.module, name: t.base });
    facts.exports = mi.exports.map((e) => ({ name: e.name, kind: e.kind }));
    const parts = [];
    for (const s of mi.segments) {
      const d = new Uint8Array(s.data);
      parts.push(d);
      facts.segments.push({ offset: typeof s.offset === 'number' ? s.offset : null, size: d.length, entropy: Number(entropy(d).toFixed(2)), passive: s.passive });
    }
    // bölümler arasına 0 baytı: komşu bölümlerin dizgeleri birleşmesin
    const total = parts.reduce((n, p) => n + p.length + 1, 0);
    facts.dataBytes = new Uint8Array(total);
    let at = 0;
    for (const p of parts) { facts.dataBytes.set(p, at); at += p.length + 1; }
    facts.strings = strings(facts.dataBytes, 5, 4000);
    for (const off of findEmbedded(facts.dataBytes, 0)) facts.embedded.push({ at: off, size: embeddedLength(facts.dataBytes, off) });

    let budget = EXPR_BUDGET;
    for (const f of mi.funcs) {
      if (f.base) continue;
      facts.funcs++;
      if (budget <= 0) { facts.partial = true; continue; }
      const loops = [];
      walk(B, f.body, (e, i) => {
        if (--budget <= 0) return false;
        facts.exprs++;
        if (i.kind === 'Const') {
          if (i.type === B.i32) facts.i32.add(i.value >>> 0);
          else if (i.type === B.i64 && typeof i.value === 'object') facts.i64.add(hex64(i.value));
        } else if (i.kind === 'Binary') {
          if (infoOf(B, i.left).kind === 'Const' && infoOf(B, i.right).kind === 'Const') facts.constOps++;
        } else if (i.kind === 'Loop') loops.push(i);
        return true;
      });
      for (const l of loops) {
        // döngü gövdesinin en içteki ilk ifadesi br_table mı?
        let cur = l.body;
        let depth = 0;
        let sw = null;
        while (cur && depth < 4096) {
          const i = infoOf(B, cur);
          if (i.kind === 'Block' && i.children.length) { cur = i.children[0]; depth++; continue; }
          if (i.kind === 'Switch') sw = i;
          break;
        }
        if (!sw) continue;
        facts.maxTable = Math.max(facts.maxTable, sw.names.length);
        let load = false;
        let local = false;
        walk(B, sw.condition, (e, i) => { if (i.kind === 'Load') load = true; if (i.kind === 'LocalGet') local = true; });
        // bayt kodu yorumlayıcısı: işlem kodu bellekten okunur ve çok sayıda hedef vardır
        if (load && sw.names.length >= 24) facts.interpLoops++;
        else if (local && !load && depth >= 2) facts.dispatchers++;
      }
    }
  } finally {
    m.dispose();
  }
  return facts;
}

/** Ham ikilide bölüm boyutları (kod/veri oranı için) */
export function sectionSizes(bytes) {
  try {
    const by = {};
    for (const s of sections(bytes)) by[s.id] = (by[s.id] ?? 0) + (s.end - s.start);
    return by;
  } catch { return {}; }
}
