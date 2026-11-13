// binaryen.js (Apache-2.0) üzerinden IR yardımcıları: yükleme, modül okuma/yazma, ifade gezgini, modül özeti.
// binaryen ilk kullanımda dinamik içe aktarılır (~15 MB, wasm gömülü). Modüller binaryen yığınında yaşar: her
// readModule'ün dispose() ile serbest bırakılması gerekir (withModule bunu yapar).
import { readNames, writeNames } from './wasm-bin.js';

let loading = null;
export const loadBinaryen = () => (loading ??= import('binaryen').then((m) => m.default ?? m));

// Tarayıcı motorlarının desteklediği özellikler. Features.All kullanılmaz: binaryen o zaman deneysel kodlamalar
// (ör. CompactImports: aynı modül adlı import'ları gruplayan yeni biçim) yazar ve çıktı WebAssembly.validate'ten geçmez.
export const engineFeatures = (B) => ['Atomics', 'MutableGlobals', 'NontrappingFPToInt', 'SIMD128', 'BulkMemory', 'SignExt',
  'ExceptionHandling', 'TailCall', 'ReferenceTypes', 'Multivalue', 'GC', 'Memory64', 'RelaxedSIMD', 'ExtendedConst',
  'MultiMemory', 'BulkMemoryOpt'].reduce((f, k) => f | (B.Features[k] ?? 0), 0);

/** bytes → binaryen Module (motor özellikleri açık; ad bölümü korunur) */
export function readModule(B, bytes) {
  B.setDebugInfo(true);
  const m = B.readBinary(bytes);
  m.setFeatures(engineFeatures(B));
  return m;
}

export function emit(B, m) {
  B.setDebugInfo(true);
  return m.emitBinary();
}

export function withModule(B, bytes, fn) {
  const m = readModule(B, bytes);
  try { return fn(m); } finally { m.dispose(); }
}

/** WAT metnini wasm ikiliye çevirir; hata metni binaryen'in ayrıştırıcı iletisidir */
export function watToWasm(B, text) {
  const m = B.parseText(text);
  try {
    m.setFeatures(engineFeatures(B));
    if (!m.validate()) throw new Error('WAT doğrulanamadı');
    return emit(B, m);
  } finally { m.dispose(); }
}

export function toWat(B, bytes) {
  return withModule(B, bytes, (m) => m.emitText());
}

// ── ifade gezgini ──
// Her ifade türü için alt ifade alanları (binaryen ExpressionInfo). Listede olmayan türlerin (SIMD, GC, istisna…)
// alt ifadeleri gezilmez: bunlar "bilinmeyen" sayılır ve dönüşüm yapan pass'ler o fonksiyonu atlar.
const FIELDS = {
  Block: ['children'], If: ['condition', 'ifTrue', 'ifFalse'], Loop: ['body'], Break: ['condition', 'value'],
  Switch: ['condition', 'value'], Call: ['operands'], CallIndirect: ['target', 'operands'], LocalGet: [],
  LocalSet: ['value'], GlobalGet: [], GlobalSet: ['value'], Load: ['ptr'], Store: ['ptr', 'value'], Const: [],
  Unary: ['value'], Binary: ['left', 'right'], Select: ['ifTrue', 'ifFalse', 'condition'], Drop: ['value'],
  Return: ['value'], MemorySize: [], MemoryGrow: ['delta'], Nop: [], Unreachable: [], AtomicRMW: ['ptr', 'value'],
  AtomicCmpxchg: ['ptr', 'expected', 'replacement'], AtomicWait: ['ptr', 'expected', 'timeout'], AtomicNotify: ['ptr', 'notifyCount'],
  AtomicFence: [], MemoryInit: ['dest', 'offset', 'size'], DataDrop: [], MemoryCopy: ['dest', 'source', 'size'],
  MemoryFill: ['dest', 'value', 'size'], RefFunc: [], RefNull: [], RefIsNull: ['value'], TableGet: ['index'],
  TableSet: ['index', 'value'], TableSize: [], TableGrow: ['value', 'delta'],
};

let idNames = null;
export function kindOf(B, id) {
  if (!idNames) {
    idNames = new Map();
    for (const k of Object.keys(FIELDS)) if (B[`${k}Id`] !== undefined) idNames.set(B[`${k}Id`], k);
  }
  return idNames.get(id) ?? 'Other';
}

/** { kind, ...info } */
export function info(B, expr) {
  let i;
  // alanı olmayan bazı türler (unreachable, nop…) için binaryen.js'te sarmalayıcı sınıf yok: getExpressionInfo atar
  try { i = B.getExpressionInfo(expr); } catch { i = { id: B.getExpressionId(expr), type: B.getExpressionType(expr) }; }
  i.kind = kindOf(B, i.id);
  return i;
}

export function children(i) {
  const out = [];
  for (const f of FIELDS[i.kind] ?? []) {
    const v = i[f];
    if (Array.isArray(v)) out.push(...v);
    else if (v) out.push(v);
  }
  return out;
}

/** Ön sıra gezinti; visit(expr, info, parent) false dönerse altı gezilmez */
export function walk(B, root, visit) {
  if (!root) return;
  const stack = [[root, null]];
  while (stack.length) {
    const [e, parent] = stack.pop();
    const i = info(B, e);
    if (visit(e, i, parent) === false) continue;
    const ch = children(i);
    for (let k = ch.length - 1; k >= 0; k--) stack.push([ch[k], e]);
  }
}

// ── modül özeti ──
const typeList = (B, t) => (t === B.none ? [] : B.expandType(t));
export function typeName(B, t) {
  for (const n of ['i32', 'i64', 'f32', 'f64', 'v128', 'funcref', 'externref']) if (B[n] === t) return n;
  return 'ref';
}

export function functions(B, m) {
  const out = [];
  for (let i = 0; i < m.getNumFunctions(); i++) {
    const f = B.getFunctionInfo(m.getFunctionByIndex(i));
    out.push({
      ref: m.getFunctionByIndex(i),
      name: f.name,
      module: f.module || null,
      base: f.base || null,
      params: typeList(B, f.params).map((t) => typeName(B, t)),
      results: typeList(B, f.results).map((t) => typeName(B, t)),
      vars: f.vars.map((t) => typeName(B, t)),
      body: f.body,
    });
  }
  return out;
}

export function moduleInfo(B, m) {
  const funcs = functions(B, m);
  const exports = [];
  for (let i = 0; i < m.getNumExports(); i++) {
    const e = B.getExportInfo(m.getExportByIndex(i));
    exports.push({ name: e.name, value: e.value, kind: ['function', 'table', 'memory', 'global', 'tag'][e.kind] ?? String(e.kind) });
  }
  const globals = [];
  for (let i = 0; i < m.getNumGlobals(); i++) {
    const g = B.getGlobalInfo(m.getGlobalByIndex(i));
    globals.push({ name: g.name, module: g.module || null, base: g.base || null, type: typeName(B, g.type), mutable: g.mutable, init: g.init });
  }
  const memory = m.hasMemory() ? m.getMemoryInfo() : null;
  const segments = [];
  for (let i = 0; i < m.getNumDataSegments(); i++) {
    const s = m.getDataSegmentInfo(m.getDataSegmentByIndex(i));
    segments.push(s);
  }
  const tables = [];
  for (let i = 0; i < m.getNumTables(); i++) tables.push(B.getTableInfo(m.getTableByIndex(i)));
  const elems = [];
  for (let i = 0; i < m.getNumElementSegments(); i++) elems.push(B.getElementSegmentInfo(m.getElementSegmentByIndex(i)));
  const start = m.getStart() ? B.getFunctionInfo(m.getStart()).name : null;
  return { funcs, exports, globals, memory, segments, tables, elems, start };
}

/** Sabit ofset ifadesinin değeri (i32/i64 const); değilse null */
export function constValue(B, expr) {
  if (!expr) return null;
  const i = info(B, expr);
  if (i.kind !== 'Const') return null;
  return typeof i.value === 'number' ? i.value : (i.value?.low ?? null);
}

/** Fonksiyon gövdesindeki ifade sayısı */
export function countExprs(B, root) {
  let n = 0;
  walk(B, root, () => { n++; });
  return n;
}

/**
 * Ad bölümü üzerinden fonksiyon/global adlarını değiştirir: renames = { functions: Map<eski, yeni>, globals: Map },
 * order = { functions: [ikili dizin sırasıyla iç adlar], globals: [...] }. binaryen varsayılan adları (ör. "0") ad
 * bölümüne yazmaz; dizin ↔ ad eşlemesi bu yüzden order'dan alınır (import'lar önce, sonra tanımlılar).
 */
export function renameBinary(bytes, renames, order) {
  const names = readNames(bytes);
  let changed = 0;
  for (const kind of ['functions', 'globals']) {
    const map = renames[kind];
    if (!map?.size) continue;
    order[kind].forEach((old, idx) => {
      const nu = map.get(old);
      if (nu && nu !== old) { names[kind].set(idx, nu); changed++; }
    });
  }
  return changed ? { bytes: writeNames(bytes, names), changed } : { bytes, changed: 0 };
}

/** İkili dizin sırası: import'lar önce, sonra tanımlılar (binaryen yazıcısıyla aynı) */
export function indexOrder(info) {
  return {
    functions: [...info.funcs.filter((f) => f.base), ...info.funcs.filter((f) => !f.base)].map((f) => f.name),
    globals: [...info.globals.filter((g) => g.base), ...info.globals.filter((g) => !g.base)].map((g) => g.name),
  };
}
