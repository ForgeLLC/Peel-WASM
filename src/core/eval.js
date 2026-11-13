// i32 ifade değerlendirici: yalnızca yan etkisiz aritmetik/bit işlemleri, local.get ve global.get yaprakları.
// Opak koşul çözücü ve br_table dağıtıcısı çözümlemesi kullanır. Kod üretmez (CSP: eval/Function yok), kapanış
// ağacı derler. Desteklenmeyen işlem → null (çağıran dönüşüm yapmaz).
import { info } from './ir.js';

const OPS = {
  AddInt32: (a, b) => (a + b) | 0,
  SubInt32: (a, b) => (a - b) | 0,
  MulInt32: (a, b) => Math.imul(a, b),
  AndInt32: (a, b) => a & b,
  OrInt32: (a, b) => a | b,
  XorInt32: (a, b) => a ^ b,
  ShlInt32: (a, b) => a << (b & 31),
  ShrUInt32: (a, b) => (a >>> (b & 31)) | 0,
  ShrSInt32: (a, b) => a >> (b & 31),
  RotLInt32: (a, b) => { const s = b & 31; return ((a << s) | (a >>> ((32 - s) & 31))) | 0; },
  RotRInt32: (a, b) => { const s = b & 31; return ((a >>> s) | (a << ((32 - s) & 31))) | 0; },
  EqInt32: (a, b) => (a === b ? 1 : 0),
  NeInt32: (a, b) => (a !== b ? 1 : 0),
  LtSInt32: (a, b) => (a < b ? 1 : 0),
  LtUInt32: (a, b) => ((a >>> 0) < (b >>> 0) ? 1 : 0),
  LeSInt32: (a, b) => (a <= b ? 1 : 0),
  LeUInt32: (a, b) => ((a >>> 0) <= (b >>> 0) ? 1 : 0),
  GtSInt32: (a, b) => (a > b ? 1 : 0),
  GtUInt32: (a, b) => ((a >>> 0) > (b >>> 0) ? 1 : 0),
  GeSInt32: (a, b) => (a >= b ? 1 : 0),
  GeUInt32: (a, b) => ((a >>> 0) >= (b >>> 0) ? 1 : 0),
  // bölen sabit ve sıfırdan farklı olmalı (tuzak yok); rem_s/div_s için -1 de dışlanır (taşma tuzağı)
  RemUInt32: (a, b) => ((a >>> 0) % (b >>> 0)) | 0,
  RemSInt32: (a, b) => (a % b) | 0,
  DivUInt32: (a, b) => ((a >>> 0) / (b >>> 0)) | 0,
  DivSInt32: (a, b) => (a / b) | 0,
};
const UNARY = {
  EqZInt32: (a) => (a === 0 ? 1 : 0),
  PopcntInt32: (a) => { let n = 0; for (let x = a >>> 0; x; x &= x - 1) n++; return n; },
  ClzInt32: (a) => Math.clz32(a),
  ExtendS8Int32: (a) => (a << 24) >> 24,
  ExtendS16Int32: (a) => (a << 16) >> 16,
};
const DIVS = new Set(['RemUInt32', 'RemSInt32', 'DivUInt32', 'DivSInt32']);

// ikili ve tekli işlem kodları binaryen'de ayrı numaralanır (ikisi de 0'dan başlar): ayrı tablolar
let opNames = null;
function opName(B, op, unary) {
  if (!opNames) {
    opNames = { bin: new Map(), un: new Map() };
    for (const k of Object.keys(OPS)) if (B[k] !== undefined) opNames.bin.set(B[k], k);
    for (const k of Object.keys(UNARY)) if (B[k] !== undefined) opNames.un.set(B[k], k);
  }
  return (unary ? opNames.un : opNames.bin).get(op) ?? null;
}

const leafKey = (i) => (i.kind === 'LocalGet' ? `l${i.index}` : `g${i.name}`);

/**
 * İfadeyi derler. Dönüş: { fn(values: number[]) → i32, vars: string[], tree } ya da null.
 * tree: { op, args } düğümleri (talep analizi için).
 */
export function compile(B, expr, { leaves = true } = {}) {
  const vars = [];
  const indexOf = (k) => { let i = vars.indexOf(k); if (i < 0) { i = vars.length; vars.push(k); } return i; };
  function build(e) {
    const i = info(B, e);
    if (i.type !== B.i32) return null;
    if (i.kind === 'Const') { const v = i.value | 0; return { op: 'const', value: v, fn: () => v }; }
    if (i.kind === 'LocalGet' || i.kind === 'GlobalGet') {
      if (!leaves) return null;
      const k = leafKey(i);
      const idx = indexOf(k);
      return { op: 'leaf', key: k, fn: (vals) => vals[idx] };
    }
    if (i.kind === 'Unary') {
      const name = opName(B, i.op, true);
      if (!name) return null;
      const a = build(i.value);
      if (!a) return null;
      const f = UNARY[name];
      return { op: name, args: [a], fn: (vals) => f(a.fn(vals)) };
    }
    if (i.kind === 'Binary') {
      const name = opName(B, i.op, false);
      if (!name) return null;
      const a = build(i.left);
      const b = build(i.right);
      if (!a || !b) return null;
      if (DIVS.has(name) && (b.op !== 'const' || b.value === 0 || (b.value === -1 && name.includes('S')))) return null;
      const f = OPS[name];
      return { op: name, args: [a, b], fn: (vals) => f(a.fn(vals), b.fn(vals)) };
    }
    return null;
  }
  const tree = build(expr);
  return tree ? { fn: tree.fn, vars, tree } : null;
}

const ALL = 0xffffffff | 0;
const hb = (mask) => 32 - Math.clz32(mask);
const low = (n) => (n >= 32 ? ALL : ((1 << n) - 1) | 0);
const pow2 = (v) => v > 0 && (v & (v - 1)) === 0;

/** Talep edilen bitler: yapraklar → maske. Sonuç yalnızca bu bitlere bağlıdır. */
function demand(node, mask, out) {
  if (!mask) return;
  switch (node.op) {
    case 'const': return;
    case 'leaf': out.set(node.key, (out.get(node.key) ?? 0) | mask); return;
    case 'AddInt32': case 'SubInt32': case 'MulInt32': {
      const m = low(hb(mask >>> 0));
      demand(node.args[0], m, out); demand(node.args[1], m, out); return;
    }
    case 'ShlInt32': {
      const [a, b] = node.args;
      if (b.op !== 'const') break;
      demand(a, low(Math.max(0, hb(mask >>> 0) - (b.value & 31))), out); return;
    }
    case 'AndInt32': case 'OrInt32': {
      const [a, b] = node.args;
      const isAnd = node.op === 'AndInt32';
      if (b.op === 'const') { demand(a, isAnd ? mask & b.value : mask & ~b.value, out); return; }
      if (a.op === 'const') { demand(b, isAnd ? mask & a.value : mask & ~a.value, out); return; }
      demand(a, mask, out); demand(b, mask, out); return;
    }
    case 'XorInt32': demand(node.args[0], mask, out); demand(node.args[1], mask, out); return;
    case 'RemUInt32': {
      const [a, b] = node.args;
      if (pow2(b.value >>> 0)) { demand(a, mask & ((b.value - 1) | 0), out); return; }
      break;
    }
    case 'EqZInt32': return demandZero(node.args[0], out);
    case 'EqInt32': case 'NeInt32': {
      const [a, b] = node.args;
      if (b.op === 'const' && b.value === 0) return demandZero(a, out);
      if (a.op === 'const' && a.value === 0) return demandZero(b, out);
      break;
    }
    default: break;
  }
  for (const a of node.args ?? []) demand(a, ALL, out);
}

// x == 0 denetiminde: x = rem_s(y, 2^k) ya da rem_u ise yalnızca y'nin düşük k biti önemlidir
function demandZero(node, out) {
  if ((node.op === 'RemSInt32' || node.op === 'RemUInt32') && pow2(node.args[1].value >>> 0)) {
    demand(node.args[0], (node.args[1].value - 1) | 0, out);
    return;
  }
  demand(node, ALL, out);
}

// Düşük bitleri koruyan işlemler: sonucun düşük w biti yalnızca girdilerin düşük w bitine bağlıdır
const LBP = new Set(['const', 'leaf', 'AddInt32', 'SubInt32', 'MulInt32', 'AndInt32', 'OrInt32', 'XorInt32']);
function lowPreserving(node) {
  if (node.op === 'ShlInt32') return node.args[1].op === 'const' && lowPreserving(node.args[0]);
  if (node.op === 'RemUInt32') return pow2(node.args[1].value >>> 0) && lowPreserving(node.args[0]);
  return LBP.has(node.op) && (node.args ?? []).every(lowPreserving);
}

function* assignments(n, w) {
  const size = 1 << w;
  const vals = new Array(n).fill(0);
  const total = size ** n;
  for (let k = 0; k < total; k++) {
    let r = k;
    for (let j = 0; j < n; j++) { vals[j] = r % size; r = Math.floor(r / size); }
    yield vals;
  }
}

/**
 * Koşulun tüm girdiler için sabit olup olmadığını kanıtlar. Dönüş: 0 | 1 (her zaman yanlış/doğru) ya da null.
 * Sağlamlık: (A) sonuç yalnızca yaprakların düşük w bitine bağlıysa tüm düşük-bit atamaları denenir (tam kanıt);
 * (B) eşitlik karşılaştırmasında iki taraf düşük-bit koruyan aritmetikse ve hiçbir atamada mod 2^w eşit olmuyorsa
 * tam değerler de hiçbir zaman eşit olamaz.
 */
export function provenConstant(B, expr) {
  const c = compile(B, expr);
  if (!c || c.vars.length > 2) return null;
  const n = c.vars.length;
  if (n === 0) return c.fn([]) ? 1 : 0;
  const w = n === 1 ? 16 : 8;
  const need = new Map();
  demand(c.tree, ALL, need);
  if ([...need.values()].every((m) => (m & ~low(w)) === 0)) {
    let seen = -1;
    for (const vals of assignments(n, w)) {
      const v = c.fn(vals) ? 1 : 0;
      if (seen === -1) seen = v;
      else if (v !== seen) return null;
    }
    return seen;
  }
  // (B) a == b / a != b / eqz(a - b)
  let node = c.tree;
  let negate = false;
  if (node.op === 'EqZInt32') { node = { op: 'EqInt32', args: [node.args[0], { op: 'const', value: 0, fn: () => 0 }] }; }
  if (node.op === 'NeInt32') { negate = true; node = { ...node, op: 'EqInt32' }; }
  if (node.op !== 'EqInt32' || !node.args.every(lowPreserving)) return null;
  const mask = low(w);
  const [a, b] = node.args;
  for (const vals of assignments(n, w)) if (((a.fn(vals) ^ b.fn(vals)) & mask) === 0) return null;
  return negate ? 1 : 0;
}

/** Yaprağı yalnızca tek bir local olan ifadeyi f(x) olarak derler (dağıtıcı indeksi için) */
export function compileOf(B, expr, localIndex) {
  const c = compile(B, expr);
  if (!c) return null;
  if (c.vars.length === 0) return () => c.fn([]);
  if (c.vars.length !== 1 || c.vars[0] !== `l${localIndex}`) return null;
  return (x) => c.fn([x | 0]);
}

/** Yapraksız sabit i32 ifade değeri ya da null */
export function constI32(B, expr) {
  const c = compile(B, expr, { leaves: false });
  return c ? c.fn([]) : null;
}
