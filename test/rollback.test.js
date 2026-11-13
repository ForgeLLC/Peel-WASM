// Davranış doğrulaması: davranışı değiştiren bir dönüşüm geri alınmalı, değiştirmeyen kabul edilmeli.
import assert from 'node:assert/strict';
import { PASSES } from '../src/core/registry.js';
import { deobfuscate } from '../src/core/pipeline.js';
import { createNodeSandbox } from '../src/sandbox/node-host.js';
import { withModule, emit, functions, walk } from '../src/core/ir.js';

// sabit 41'i 42 yapan "hatalı" pass: dönüş değeri değişir
const evil = {
  id: 'evil',
  run(bytes, { B }) {
    return withModule(B, bytes, (m) => {
      let hit = false;
      for (const f of functions(B, m)) {
        if (f.base) continue;
        walk(B, f.body, (e, i) => { if (i.kind === 'Const' && i.value === 41) { B.Const.setValueI32(e, 42); hit = true; } });
      }
      return hit ? emit(B, m) : null;
    });
  },
};
// import çağrısının argümanını değiştiren pass: dönüş değeri aynı, kaydedilen yan etki farklı
const sneaky = {
  id: 'sneaky',
  run(bytes, { B }) {
    return withModule(B, bytes, (m) => {
      let hit = false;
      for (const f of functions(B, m)) {
        if (f.base) continue;
        walk(B, f.body, (e, i) => { if (i.kind === 'Const' && i.value === 7) { B.Const.setValueI32(e, 8); hit = true; } });
      }
      return hit ? emit(B, m) : null;
    });
  },
};
PASSES.unshift(evil, sneaky);

const sb = createNodeSandbox();
try {
  const wat = `(module (import "env" "log" (func $log (param i32)))
    (func (export "f") (result i32) (call $log (i32.const 7)) (i32.const 41)))`;
  const r = await deobfuscate(wat, { sandbox: sb });
  assert.ok(r.verified);
  const ev = r.events.filter((e) => e.id === 'evil' || e.id === 'sneaky');
  assert.ok(ev.length >= 2 && ev.every((e) => e.state === 'fail' && e.reason === 'davranış'), JSON.stringify(ev));
  assert.match(r.text, /i32\.const 41/);
  assert.match(r.text, /i32\.const 7/);
  console.log('rollback: ok');
} finally {
  sb.close();
  PASSES.splice(0, 2);
}
