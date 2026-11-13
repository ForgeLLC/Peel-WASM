// Opak koşul çözücüsü (core/eval.js): sabit olduğu kanıtlananlar ve kanıtlanmaması gerekenler.
import assert from 'node:assert/strict';
import { loadBinaryen, readModule, watToWasm, functions, walk } from '../src/core/ir.js';
import { provenConstant } from '../src/core/eval.js';

const B = await loadBinaryen();

/** (param $x i32) (param $y i32) gövdesinde tek bir if koşulunu değerlendirir */
function prove(cond) {
  const bytes = watToWasm(B, `(module (memory 1) (func (param $x i32) (param $y i32) (if ${cond} (then (nop)))))`);
  const m = readModule(B, bytes);
  try {
    let c = null;
    walk(B, functions(B, m)[0].body, (e, i) => { if (i.kind === 'If') c = i.condition; });
    return provenConstant(B, c);
  } finally { m.dispose(); }
}

const X = '(local.get $x)';
const Y = '(local.get $y)';
// her zaman doğru / yanlış (kanıtlanmalı)
assert.equal(prove(`(i32.eqz (i32.and (i32.mul ${X} (i32.add ${X} (i32.const 1))) (i32.const 1)))`), 1, 'x(x+1) çifttir');
assert.equal(prove(`(i32.eq (i32.rem_u (i32.mul ${X} (i32.sub ${X} (i32.const 1))) (i32.const 2)) (i32.const 1))`), 0, 'x(x-1) mod 2 = 1 olamaz');
assert.equal(prove(`(i32.eqz (i32.rem_s (i32.add (i32.mul ${X} ${X}) ${X}) (i32.const 2)))`), 1, 'x²+x çift (rem_s)');
assert.equal(prove(`(i32.eq (i32.sub (i32.mul (i32.const 7) (i32.mul ${Y} ${Y})) (i32.const 1)) (i32.mul ${X} ${X}))`), 0, '7y²-1 ≠ x² (mod 8)');
assert.equal(prove(`(i32.ne (i32.or ${X} (i32.const 1)) (i32.const 0))`), 1, '(x|1) ≠ 0');
assert.equal(prove(`(i32.ne (i32.and (i32.mul ${X} ${X}) (i32.const 3)) (i32.const 2))`), 1, 'x² mod 4 ≠ 2');
assert.equal(prove(`(i32.and ${X} (i32.const 0))`), 0, 'x & 0');
// değişken (kanıtlanmamalı)
assert.equal(prove(`(i32.gt_s ${X} (i32.const 5))`), null);
assert.equal(prove(`(i32.eqz (i32.and ${X} (i32.const 1)))`), null);
assert.equal(prove(`(i32.eq (i32.mul ${X} ${X}) (i32.const 4))`), null, 'x² = 4 bazı x için doğru');
assert.equal(prove(`(i32.eq ${X} ${Y})`), null);
assert.equal(prove(`(i32.lt_u (i32.shr_u ${X} (i32.const 1)) (i32.const 100))`), null, 'üst bitlere bağlı');
// desteklenmeyen (yan etkili / bellek) yapraklar kanıtlanmaz
assert.equal(prove('(i32.eqz (i32.and (i32.load (i32.const 0)) (i32.const 0)))'), null);
console.log('eval: ok');
