// Girdi çıkarma (core/input.js) ve ikili yardımcılar (core/wasm-bin.js).
import assert from 'node:assert/strict';
import { loadBinaryen, watToWasm, readModule, emit, renameBinary, indexOrder, moduleInfo } from '../src/core/ir.js';
import { extractModule } from '../src/core/input.js';
import { readNames, writeNames, readU32, u32, findEmbedded, embeddedLength, isWasm } from '../src/core/wasm-bin.js';

const B = await loadBinaryen();
const tools = { watToWasm: (t) => watToWasm(B, t) };
const wasm = watToWasm(B, '(module (func (export "f") (result i32) (i32.const 42)))');
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

// LEB128
for (const n of [0, 1, 127, 128, 300, 65535, 2 ** 31, 2 ** 32 - 1]) assert.equal(readU32(Uint8Array.from(u32(n)), 0)[0], n);

// ham ikili, WAT, base64, data URL, bayt dizisi, \x dizgesi, onaltılık dizge
assert.equal(extractModule(wasm, tools).kind, 'wasm');
assert.ok(isWasm(extractModule(';; yorum\n(module (func))', tools).bytes));
assert.equal(extractModule('(module (func (unknown)))', tools).error?.startsWith('WAT'), true);
const b64 = Buffer.from(wasm).toString('base64');
const cases = {
  base64: `const w = "${b64.slice(0, 10)}" + "${b64.slice(10)}";`,
  'data-url': `fetch("data:application/wasm;base64,${b64}")`,
  'byte-array': `new Uint8Array([${[...wasm].join(', ')}])`,
  'escaped-string': `const s = "${[...wasm].map((b) => `\\x${b.toString(16).padStart(2, '0')}`).join('')}";`,
  hex: `const h = '${Buffer.from(wasm).toString('hex')}';`,
};
for (const [kind, text] of Object.entries(cases)) {
  const r = extractModule(text, tools);
  assert.equal(r.kind, 'js-loader', kind);
  assert.equal(r.layers[0].kind, kind);
  assert.ok(same(r.bytes, wasm), `${kind}: baytlar aynı olmalı`);
}
// iki gömülü modül: büyük olan seçilir, ikisi de katman
const big = watToWasm(B, '(module (func (export "g") (param i32) (result i32) (i32.mul (local.get 0) (i32.const 3))))');
const two = extractModule(`a("${b64}"); b("${Buffer.from(big).toString('base64')}");`, tools);
assert.equal(two.layers.length, 2);
assert.ok(same(two.bytes, big));
assert.ok(extractModule('merhaba dünya', tools).error);

// gömülü modül arama ve uzunluk
const blob = new Uint8Array([1, 2, 3, ...wasm, 9, 9]);
assert.deepEqual(findEmbedded(blob), [3]);
assert.equal(embeddedLength(blob, 3), wasm.length);

// ad bölümü yazma: dizin ↔ ad eşlemesi import'lar önce
const src = watToWasm(B, '(module (import "env" "p" (func (param i32))) (func (export "x") (param i32) (call 0 (local.get 0))))');
const m = readModule(B, src);
let order;
let names;
try {
  const info = moduleInfo(B, m);
  order = indexOrder(info);
  names = new Map([[order.functions[1], 'renamed'], [order.functions[0], 'imp']]);
} finally { m.dispose(); }
const r = renameBinary(src, { functions: names, globals: new Map() }, order);
assert.equal(r.changed, 2);
assert.deepEqual([...readNames(r.bytes).functions.values()].sort(), ['imp', 'renamed']);
const m2 = readModule(B, r.bytes);
try {
  const text = m2.emitText();
  assert.match(text, /\(export "x" \(func \$renamed\)\)/);
  assert.match(text, /\(call \$imp/);
  assert.ok(WebAssembly.validate(emit(B, m2)));
} finally { m2.dispose(); }
// writeNames diğer bölümleri bozmaz
const again = writeNames(r.bytes, readNames(r.bytes));
assert.ok(WebAssembly.validate(again));
console.log('input: ok');
