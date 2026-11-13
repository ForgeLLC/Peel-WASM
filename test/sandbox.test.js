// Sandbox öz-denetimi: izin modeli, sahte import kaydı, yakıt, bekçi.
import assert from 'node:assert/strict';
import { createNodeSandbox } from '../src/sandbox/node-host.js';
import { loadBinaryen, watToWasm } from '../src/core/ir.js';
import { instrument } from '../src/core/instrument.js';

const B = await loadBinaryen();
const sb = createNodeSandbox();
const prepare = (wat) => instrument(B, watToWasm(B, wat));
const send = (ins, extra = {}) => sb.run({ wasm: ins.wasm, imports: ins.imports, calls: ins.calls, ...extra });

try {
  // 1. alt süreçte izin modeli etkin: dosya sistemi kökü okunamaz, yazma / alt süreç / worker / ağ kapalı
  const st = await sb.selftest();
  assert.deepEqual({ ...st }, { ok: true, permission: true, fsReadRoot: false, fsWrite: false, child: false, worker: false, net: false });

  // 2. import çağrıları argümanlarıyla ve bellekten okunan dizgeyle kaydedilir; i64 dönüşlü import 0n döner
  const net = prepare(`(module
   (import "env" "send" (func $send (param i32 i32) (result i64)))
   (memory (export "memory") 1)
   (data (i32.const 32) "https://evil.example.test/x")
   (func (export "go") (result i64) (call $send (i32.const 32) (i32.const 27))))`);
  const r = await send(net);
  assert.ok(r.ok, r.error);
  assert.deepEqual(r.fx[0], ['env.send', ['32', '27'], ['https://evil.example.test/x']]);
  assert.equal(r.calls[0].result, '0n');

  // 3. yakıt: sonsuz döngü 'fuel' ile kesilir, sonraki çağrılar çalışır
  const spin = prepare('(module (func (export "a") (loop $l (br $l))) (func (export "b") (result i32) (i32.const 5)))');
  const s = await send(spin);
  assert.deepEqual(s.calls.map((c) => c.result), ['fuel', '5']);

  // 4. bekçi: yakıtsız sonsuz döngü (başlangıçta) süreç öldürülerek kesilir; sandbox sonra yine çalışır
  const raw = watToWasm(B, '(module (func $s (loop $l (br $l))) (start $s))');
  const hang = await sb.run({ wasm: raw, imports: [], calls: [], timeoutMs: 1500 });
  assert.equal(hang.timedOut, true);
  const after = await send(prepare('(module (func (export "x") (result i32) (i32.const 1)))'));
  assert.equal(after.calls[0].result, '1');

  // 5. WASI taklitleri: fd_write konsola yazar, proc_exit çağrıyı sonlandırır, random_get deterministiktir
  const wasi = prepare(`(module
   (import "wasi_snapshot_preview1" "fd_write" (func $w (param i32 i32 i32 i32) (result i32)))
   (import "wasi_snapshot_preview1" "proc_exit" (func $exit (param i32)))
   (import "wasi_snapshot_preview1" "random_get" (func $rnd (param i32 i32) (result i32)))
   (memory (export "memory") 1)
   (data (i32.const 100) "hi\\n")
   (func (export "_start")
    (i32.store (i32.const 0) (i32.const 100)) (i32.store (i32.const 4) (i32.const 3))
    (drop (call $w (i32.const 1) (i32.const 0) (i32.const 1) (i32.const 8)))
    (drop (call $rnd (i32.const 200) (i32.const 8)))
    (call $exit (i32.const 3))))`);
  const w1 = await send(wasi);
  const w2 = await send(wasi);
  assert.equal(w1.stdout, 'hi\n');
  assert.equal(w1.calls[0].result, 'exit(3)');
  assert.equal(w1.memHash, w2.memHash);

  // 6. gömülü modül: (ptr, len) \0asm ile başlıyorsa yakalanır
  const inner = watToWasm(B, '(module (func (export "i")))');
  const hex = [...inner].map((b) => `\\${b.toString(16).padStart(2, '0')}`).join('');
  const nest = prepare(`(module (import "env" "load" (func $l (param i32 i32))) (memory (export "m") 1)
   (data (i32.const 64) "${hex}") (func (export "boot") (call $l (i32.const 64) (i32.const ${inner.length}))))`);
  const n = await send(nest);
  assert.equal(n.loads.length, 1);
  assert.equal(n.loads[0].size, inner.length);

  console.log('sandbox: ok');
} finally {
  sb.close();
}
