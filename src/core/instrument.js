// Sandbox çalıştırması için hazırlık: modülün bir KOPYASINA yakıt sayacı eklenir ve çağrı planı çıkarılır.
//   - __peel.fuel import'u ve dışa açık, değiştirilebilir __peel_fuel global'i eklenir; her fonksiyon girişinde ve
//     her döngü turunda sayaç bir azalır, sıfırın altına inince __peel.fuel çağrılır (sandbox FuelOut fırlatır).
//   - Çağrı planı: dışa açık her sayısal fonksiyon birkaç sabit argüman vektörüyle çağrılır; önce başlatıcılar.
// Davranış karşılaştırması her iki tarafta aynı enstrümantasyonla yapılır, yani yakıt eklemenin kendisi farkı etkilemez.
import { readModule, emit, moduleInfo, walk } from './ir.js';

export const FUEL = 5_000_000;
const INIT_EXPORTS = ['_initialize', '__wasm_call_ctors', '_emscripten_stack_init', 'emscripten_stack_init'];
const NUMERIC = new Set(['i32', 'i64', 'f32', 'f64']);
const MAX_EXPORTS = 48;

const VECTORS = [
  (t) => (t === 'i64' ? '0' : 0),
  (t, i) => (t === 'i64' ? String(i + 1) : t[0] === 'f' ? i + 1.5 : i + 1),
  (t, i) => (t === 'i64' ? String(1000 + 37 * i) : t[0] === 'f' ? -2.25 * (i + 1) : 100 + 7 * i),
];

/** Dışa açık fonksiyonlar için çağrı planı */
export function callPlan(info) {
  const funcs = new Map(info.funcs.map((f) => [f.name, f]));
  const exps = info.exports.filter((e) => e.kind === 'function' && e.name !== '__peel_fuel')
    .map((e) => ({ ...e, f: funcs.get(e.value) }))
    .filter((e) => e.f && e.f.params.every((p) => NUMERIC.has(p)) && e.f.results.every((r) => NUMERIC.has(r)));
  const init = INIT_EXPORTS.map((n) => exps.find((e) => e.name === n)).filter(Boolean);
  const rest = exps.filter((e) => !INIT_EXPORTS.includes(e.name)).sort((a, b) => (a.name < b.name ? -1 : 1)).slice(0, MAX_EXPORTS);
  const calls = init.map((e) => ({ export: e.name, args: [], types: [] }));
  for (const e of rest) {
    const n = e.f.params.length ? VECTORS.length : 1;
    for (let v = 0; v < n; v++) calls.push({ export: e.name, args: e.f.params.map((t, i) => VECTORS[v](t, i)), types: e.f.params });
  }
  return calls;
}

/** Import listesi (sandbox'ın sahte nesneleri için tür bilgisiyle) */
export function importList(B, m, info) {
  const out = [];
  for (const f of info.funcs) if (f.base) out.push({ kind: 'function', module: f.module, name: f.base, params: f.params, results: f.results });
  if (info.memory?.module) out.push({ kind: 'memory', module: info.memory.module, name: info.memory.base, initial: info.memory.initial, maximum: info.memory.max, shared: info.memory.shared });
  for (const t of info.tables) if (t.module) out.push({ kind: 'table', module: t.module, name: t.base, initial: t.initial, maximum: t.max });
  for (const g of info.globals) if (g.module) out.push({ kind: 'global', module: g.module, name: g.base, type: g.type, mutable: g.mutable });
  return out;
}

/** bytes → { wasm (yakıtlı kopya), imports, calls, info } */
export function instrument(B, bytes, { fuel = FUEL } = {}) {
  const m = readModule(B, bytes);
  try {
    const info = moduleInfo(B, m);
    const calls = callPlan(info);
    const out = '__peel$fuel_out';
    const g = '__peel$fuel';
    m.addFunctionImport(out, '__peel', 'fuel', B.none, B.none);
    m.addGlobal(g, B.i32, true, m.i32.const(fuel));
    m.addGlobalExport(g, '__peel_fuel');
    const tick = () => m.block(null, [
      m.global.set(g, m.i32.sub(m.global.get(g, B.i32), m.i32.const(1))),
      m.if(m.i32.lt_s(m.global.get(g, B.i32), m.i32.const(0)), m.call(out, [], B.none)),
    ], B.none);
    for (const f of info.funcs) {
      if (f.base) continue;
      const loops = [];
      walk(B, f.body, (e, i) => { if (i.kind === 'Loop') loops.push(e); });
      for (const l of loops) {
        const body = B.Loop.getBody(l);
        B.Loop.setBody(l, m.block(null, [tick(), body], B.getExpressionType(body)));
      }
      B.Function.setBody(f.ref, m.block(null, [tick(), f.body], B.getExpressionType(f.body)));
    }
    const wasm = emit(B, m);
    const imports = importList(B, m, moduleInfo(B, m));
    return { wasm, imports, calls, info };
  } finally {
    m.dispose();
  }
}
