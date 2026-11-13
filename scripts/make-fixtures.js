// Test fixture'larını üretir: zararsız WAT modülleri burada elle gizlenir (düzleştirme, opak koşul, sabit kodlama,
// şifreli veri, bölme, ölü kod, ad silme, JS yükleyici, gömülü modül) ve binaryen ile wasm'a çevrilir. Her fixture
// { name, kind, input (base64), expect } JSON'udur; diskte XOR + base64 (.json.x) saklanır, çünkü madenci imzası ve
// yükleyici örnekleri antivirüs imzalarına benzeyebilir. Şüpheli dizgeler burada da parçalı yazılır.
//   node scripts/make-fixtures.js
import { writeFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { loadBinaryen, engineFeatures } from '../src/core/ir.js';
import { encodeFixture } from '../test/fixture-codec.js';

const B = await loadBinaryen();
const out = new URL('../test/fixtures/', import.meta.url);
mkdirSync(out, { recursive: true });
for (const f of readdirSync(out)) if (f.endsWith('.json.x')) rmSync(new URL(f, out));

/** WAT → wasm; names: false → ad bölümü yazılmaz (silinmiş adlar) */
function compile(wat, { names = true } = {}) {
  const m = B.parseText(wat);
  try {
    m.setFeatures(engineFeatures(B));
    if (!m.validate()) throw new Error('fixture doğrulanamadı');
    B.setDebugInfo(names);
    return m.emitBinary();
  } finally {
    m.dispose();
    B.setDebugInfo(true);
  }
}
const watStr = (bytes) => `"${[...bytes].map((b) => `\\${b.toString(16).padStart(2, '0')}`).join('')}"`;
const ascii = (s) => new TextEncoder().encode(s);
const xor = (bytes, k) => bytes.map((b, i) => b ^ ((k + i * 7) & 0xff));
const b64 = (bytes) => Buffer.from(bytes).toString('base64');

function save(name, input, expect, kind = 'wasm') {
  const json = JSON.stringify({ name, kind, input: kind === 'wasm' ? b64(input) : input, expect }, null, 1);
  writeFileSync(new URL(`${name}.json.x`, out), encodeFixture(Buffer.from(json)));
  console.log(`${name}: ${kind === 'wasm' ? input.length : input.length} ${kind === 'wasm' ? 'B' : 'karakter'}`);
}

// ── 1. düzleştirme + opak koşul + sabit kodlama + başlangıçta çözülen şifreli veri ──
const SECRET = ascii('Hello from Peel');
const ENC = xor(SECRET, 0x5a);
const cffWat = `(module
 (import "env" "log" (func $log (param i32 i32)))
 (memory (export "memory") 1)
 (data (i32.const 256) ${watStr(ENC)})
 (func $decrypt (local $i i32)
  (loop $l
   (i32.store8 (i32.add (i32.const 256) (local.get $i))
    (i32.xor (i32.load8_u (i32.add (i32.const 256) (local.get $i)))
     (i32.and (i32.add (i32.const 0x5a) (i32.mul (local.get $i) (i32.const 7))) (i32.const 255))))
   (local.set $i (i32.add (local.get $i) (i32.const 1)))
   (br_if $l (i32.lt_u (local.get $i) (i32.const ${SECRET.length})))))
 (start $decrypt)
 (func $calc (export "calc") (param $x i32) (result i32) (local $s i32) (local $r i32)
  (local.set $s (i32.const 0x2b))
  (block $exit
   (loop $d
    (block $c3 (block $c2 (block $c1 (block $c0
       (br_table $c0 $c1 $c2 $c3 $exit (i32.xor (local.get $s) (i32.const 0x2b))))
      (local.set $r (i32.mul (local.get $x) (i32.xor (i32.const 0x1234) (i32.const 0x1237))))
      (if (i32.eq (i32.and (i32.mul (local.get $x) (i32.add (local.get $x) (i32.const 1))) (i32.const 1)) (i32.const 1))
       (then (local.set $r (i32.const 0xdead))))
      (local.set $s (select (i32.const 0x2a) (i32.const 0x29) (i32.gt_s (local.get $r) (i32.const 10))))
      (br $d))
     (local.set $r (i32.add (local.get $r) (i32.xor (i32.const 0x5500) (i32.const 0x5564))))
     (call $log (i32.const 256) (i32.const ${SECRET.length}))
     (local.set $s (i32.const 0x29))
     (br $d))
    (local.set $r (i32.sub (local.get $r) (i32.const 1)))
    (local.set $s (i32.const 0x28))
    (br $d))
   (local.set $r (i32.shl (local.get $r) (i32.const 1)))
   (br $exit)))
  (local.get $r))
 (func $sum (export "sum") (param $n i32) (result i32) (local $s i32) (local $i i32) (local $acc i32)
  (local.set $s (i32.const 0))
  (block $out
   (loop $d
    (block $c2 (block $c1 (block $c0
       (br_table $c0 $c1 $c2 $out (local.get $s)))
      (local.set $i (i32.const 0))
      (local.set $acc (i32.const 0))
      (local.set $s (i32.const 1))
      (br $d))
     (local.set $s (select (i32.const 2) (i32.const 3) (i32.lt_s (local.get $i) (local.get $n))))
     (br $d))
    (local.set $acc (i32.add (local.get $acc) (local.get $i)))
    (local.set $i (i32.add (local.get $i) (i32.const 1)))
    (if (i32.ne (i32.or (local.get $i) (i32.const 1)) (i32.const 0))
     (then (local.set $s (i32.const 1)) (br $d))
     (else (local.set $s (i32.const 3)) (br $d)))))
  (local.get $acc)))`;
save('cff-calc', compile(cffWat), {
  verified: true, stats: { cff: 2, opaque: 1, data: 1 },
  contains: ['Hello from Peel', '(loop'], gone: ['br_table', '$decrypt', '(start'],
  detect: ['cff', 'opaque', 'data', 'consts'], threatMax: 'none',
});

// ── 2. fonksiyon bölme ──
const splitWat = `(module
 (func $main (export "mix") (param $a i32) (param $b i32) (result i32) (call $p1 (local.get $a) (local.get $b)))
 (func $p1 (param $a i32) (param $b i32) (result i32) (call $p2 (i32.add (local.get $a) (local.get $b)) (local.get $b)))
 (func $p2 (param $a i32) (param $b i32) (result i32) (call $p3 (i32.mul (local.get $a) (i32.const 3)) (local.get $b)))
 (func $p3 (param $a i32) (param $b i32) (result i32) (call $p4 (i32.xor (local.get $a) (local.get $b)) (local.get $b)))
 (func $p4 (param $a i32) (param $b i32) (result i32) (call $p5 (i32.rotl (local.get $a) (i32.const 5)) (local.get $b)))
 (func $p5 (param $a i32) (param $b i32) (result i32) (i32.sub (local.get $a) (local.get $b))))`;
save('split', compile(splitWat), { verified: true, stats: { inline: 3 }, functionsOut: 1, detect: ['split'] });

// ── 3. ölü kod + global'le kodlanmış sabitler ──
const deadWat = `(module
 (global $k1 i32 (i32.const 0x1234))
 (global $k2 i32 (i32.const 0x7777))
 (func $junk1 (param i32) (result i32) (i32.mul (local.get 0) (i32.const 31)))
 (func $junk2 (param i32) (result i32) (i32.add (call $junk1 (local.get 0)) (i32.const 17)))
 (func $junk3 (result i32) (call $junk2 (i32.const 5)))
 (func $junk4 (param i32) (drop (call $junk3)))
 (func $area (export "area") (param $w i32) (param $h i32) (result i32) (local $t i32)
  (if (i32.eqz (i32.const 1)) (then (local.set $t (call $junk2 (local.get $w))) (local.set $t (call $junk1 (local.get $t)))))
  (local.set $t (i32.mul (local.get $w) (local.get $h)))
  (if (i32.and (i32.const 0) (local.get $h)) (then (local.set $t (i32.const 0))))
  (i32.add (local.get $t) (i32.xor (global.get $k1) (global.get $k1)))))`;
save('dead-consts', compile(deadWat), { verified: true, stats: { deadFunctions: 4 }, gone: ['$junk1', '$junk4', '$k1'], functionsOut: 1, detect: ['dead'] });

// ── 4. ad bölümü silinmiş modül ──
const namesWat = `(module
 (import "env" "print" (func $print (param i32)))
 (func $a (export "add") (param i32 i32) (result i32) (call $print (local.get 0)) (i32.add (local.get 0) (local.get 1)))
 (func $b (export "sub") (param i32 i32) (result i32) (i32.sub (local.get 0) (local.get 1)))
 (func $c (export "scale") (param i32) (result i32) (call $b (call $a (local.get 0) (local.get 0)) (i32.const 1))))`;
const stripped = compile(namesWat, { names: false });
save('names', stripped, { verified: true, stats: { names: 3 }, contains: ['(func $add', '(func $sub', '(func $scale', '$print', '(export "add" (func $add))', '(export "scale" (func $scale))', '(call $sub'] });

// ── 5. JS yükleyici (base64 gömülü wasm) ──
const loaderJs = `// derlenmiş paket
const url = 'https://cdn.example-loader.test/runtime.js';
async function boot() {
  const bin = Uint8Array.from(atob("${b64(stripped).slice(0, 40)}" +
    "${b64(stripped).slice(40)}"), (c) => c.charCodeAt(0));
  const { instance } = await WebAssembly.instantiate(bin, { env: { print: console.log } });
  return instance.exports.add(2, 3);
}
boot();
`;
save('js-loader', loaderJs, { verified: true, kind: 'js-loader', detect: ['js-loader'], contains: ['(func $add'], iocs: { domains: ['cdn.example-loader.test'] } }, 'text');

// ── 6. madenci imzası (zararsız: yalnızca sabitler ve kısa bir döngü) ──
const KEC = ['0x0000000000008082', '0x800000000000808a', '0x8000000080008000', '0x000000000000808b', '0x0000000080000001',
  '0x8000000080008081', '0x8000000000008009', '0x000000008000000a', '0x000000008000808b', '0x800000000000008b'];
const SBOX = [0x63, 0x7c, 0x77, 0x7b, 0xf2, 0x6b, 0x6f, 0xc5, 0x30, 0x01, 0x67, 0x2b, 0xfe, 0xd7, 0xab, 0x76, 0xca, 0x82, 0xc9, 0x7d];
const POOL = ascii(['strat', 'um+tcp://pool.example-mining.test:3333'].join(''));
const WALLET = ascii(`4A${'1'.repeat(93)}`);
const hashName = ['crypto', 'night', '_hash'].join('');
const minerWat = `(module
 (memory (export "memory") 32)
 (data (i32.const 1024) ${watStr(SBOX)})
 (data (i32.const 2048) ${watStr(POOL)})
 (data (i32.const 3072) ${watStr(WALLET)})
 (func $keccak (param $x i64) (result i64)
  ${KEC.map((k) => `(local.set $x (i64.xor (i64.rotl (local.get $x) (i64.const 1)) (i64.const ${k})))`).join('\n  ')}
  (local.get $x))
 (func $h (export "${hashName}") (param $seed i32) (result i32) (local $i i32) (local $a i32)
  (local.set $a (local.get $seed))
  (loop $l
   (local.set $a (i32.and (i32.add (i32.mul (local.get $a) (i32.const 33)) (i32.load8_u (i32.add (i32.const 1024) (i32.and (local.get $i) (i32.const 15))))) (i32.const 0x1ffff0)))
   (i32.store (local.get $a) (i32.wrap_i64 (call $keccak (i64.extend_i32_u (local.get $a)))))
   (local.set $i (i32.add (local.get $i) (i32.const 1)))
   (br_if $l (i32.lt_u (local.get $i) (i32.const 64))))
  (local.get $a)))`;
save('miner-like', compile(minerWat), { verified: true, detect: ['miner'], threatMin: 'high', threatClass: 'cryptojacking', iocs: { pools: 1, wallets: 1 } });

// ── 7. Emscripten benzeri WASI "hello" ──
const HELLO = ascii('hello world\n');
const emWat = `(module
 (import "wasi_snapshot_preview1" "fd_write" (func $fd_write (param i32 i32 i32 i32) (result i32)))
 (import "env" "emscripten_resize_heap" (func $resize (param i32) (result i32)))
 (memory (export "memory") 2)
 (global $sp (mut i32) (i32.const 65536))
 (data (i32.const 512) ${watStr(HELLO)})
 (func $ctors (export "__wasm_call_ctors"))
 (func $save (export "stackSave") (result i32) (global.get $sp))
 (func $main (export "_start") (local $p i32)
  (global.set $sp (local.tee $p (i32.sub (global.get $sp) (i32.const 16))))
  (i32.store (local.get $p) (i32.const 512))
  (i32.store offset=4 (local.get $p) (i32.const ${HELLO.length}))
  (drop (call $fd_write (i32.const 1) (local.get $p) (i32.const 1) (i32.add (local.get $p) (i32.const 8))))
  (global.set $sp (i32.add (local.get $p) (i32.const 16)))))`;
save('emscripten-hello', compile(emWat, { names: false }), { verified: true, toolchain: 'emscripten', stdout: 'hello world', threatMax: 'none' });

// ── 8. ağ isteği deneyen modül (sahte import yalnızca kaydeder) ──
const BEACON = ascii('https://collect.example-tracker.test/beacon?id=7');
const netWat = `(module
 (import "env" "fetch_url" (func $fetch (param i32 i32) (result i32)))
 (memory (export "memory") 1)
 (data (i32.const 128) ${watStr(xor(BEACON, 0x33))})
 (func $beacon (export "beacon") (result i32) (local $i i32)
  (loop $l
   (i32.store8 offset=1024 (local.get $i) (i32.xor (i32.load8_u offset=128 (local.get $i)) (i32.and (i32.add (i32.const 0x33) (i32.mul (local.get $i) (i32.const 7))) (i32.const 255))))
   (local.set $i (i32.add (local.get $i) (i32.const 1)))
   (br_if $l (i32.lt_u (local.get $i) (i32.const ${BEACON.length}))))
  (call $fetch (i32.const 1024) (i32.const ${BEACON.length}))))`;
save('network', compile(netWat), { verified: true, network: 'collect.example-tracker.test', threatClass: 'network', iocs: { domains: ['collect.example-tracker.test'] } });

// ── 9. bayt kodu yorumlayıcısı + gizleme (VM koruması: yalnızca tanınır) ──
const PROG = [1, 5, 1, 7, 2, 3, 0];
const ops = Array.from({ length: 32 }, (_, i) => `$o${i}`);
const vmWat = `(module
 (memory (export "memory") 1)
 (data (i32.const 64) ${watStr(PROG)})
 (func $run (export "run") (param $arg i32) (result i32) (local $pc i32) (local $acc i32)
  (local.set $pc (i32.const 64))
  (local.set $acc (i32.xor (local.get $arg) (i32.xor (i32.const 0x1111) (i32.const 0x1111))))
  (block $halt
   (loop $next
    ${[...ops].reverse().map((o) => `(block ${o}`).join(' ')}
      (br_table ${ops.join(' ')} $halt (i32.load8_u (local.get $pc))))
    ${ops.map((o, i) => {
    const body = i === 0 ? '(br $halt)'
      : i === 1 ? '(local.set $acc (i32.add (local.get $acc) (i32.load8_u offset=1 (local.get $pc)))) (local.set $pc (i32.add (local.get $pc) (i32.const 2))) (br $next)'
        : i === 2 ? '(local.set $acc (i32.mul (local.get $acc) (i32.load8_u offset=1 (local.get $pc)))) (local.set $pc (i32.add (local.get $pc) (i32.const 2))) (br $next)'
          : '(if (i32.eq (i32.and (i32.mul (local.get $acc) (i32.add (local.get $acc) (i32.const 1))) (i32.const 1)) (i32.const 1)) (then (local.set $acc (i32.const 0)))) (local.set $pc (i32.add (local.get $pc) (i32.const 1))) (br $next)';
    return i === ops.length - 1 ? body : `${body})`;
  }).join('\n    ')}
   ))
  (local.get $acc)))`;
save('vm-interp', compile(vmWat), { verified: true, protection: true, detect: ['interp'] });

// ── 10. sonsuz döngülü dışa açık fonksiyon (yakıt) ──
const fuelWat = `(module
 (func $ok (export "ok") (param $x i32) (result i32)
  (if (result i32) (i32.eqz (i32.and (i32.mul (local.get $x) (i32.sub (local.get $x) (i32.const 1))) (i32.const 1)))
   (then (i32.const 42)) (else (i32.const 7))))
 (func $spin (export "spin") (loop $l (br $l))))`;
save('fuel', compile(fuelWat), { verified: true, stats: { opaque: 1 }, contains: ['(i32.const 42)'], gone: ['(i32.const 7)'] });

// ── 11. gömülü ikinci aşama modül ──
const nestWat = `(module
 (import "env" "instantiate" (func $inst (param i32 i32) (result i32)))
 (memory (export "memory") 1)
 (data (i32.const 4096) ${watStr(stripped)})
 (func $boot (export "boot") (result i32) (call $inst (i32.const 4096) (i32.const ${stripped.length}))))`;
save('nested', compile(nestWat), { verified: true, detect: ['embedded'], loads: 1, threatClass: 'embedded-module' });

// ── 12. Rust / wasm-bindgen benzeri ──
const RUSTSTR = ascii('/rustc/90b35a6239c3d8bdabc530a6a0816f7ff89a0aaf/library/core/src/panicking.rs');
const rustWat = `(module
 (import "wbg" "__wbindgen_throw" (func $throw (param i32 i32)))
 (memory (export "memory") 1)
 (data (i32.const 1024) ${watStr(RUSTSTR)})
 (func $malloc (export "__wbindgen_malloc") (param i32 i32) (result i32) (i32.const 2048))
 (func $greet (export "greet") (param $n i32) (result i32)
  (if (i32.gt_u (local.get $n) (i32.const 1000)) (then (call $throw (i32.const 1024) (i32.const ${RUSTSTR.length}))))
  (i32.add (local.get $n) (i32.const 1))))`;
save('rust-like', compile(rustWat), { verified: true, toolchain: 'rust', threatMax: 'none' });

// ── 13. gizlenmemiş temiz modül (yanlış pozitif denetimi) ──
const cleanWat = `(module
 (func $fact (export "fact") (param $n i32) (result i32) (local $r i32)
  (local.set $r (i32.const 1))
  (block $done (loop $l
   (br_if $done (i32.le_s (local.get $n) (i32.const 1)))
   (local.set $r (i32.mul (local.get $r) (local.get $n)))
   (local.set $n (i32.sub (local.get $n) (i32.const 1)))
   (br $l)))
  (local.get $r)))`;
save('clean', compile(cleanWat), { verified: true, noTechniques: true, threatMax: 'none', contains: ['(func $fact'] });

// ── 14. iki değişkenli opak koşullar: 7y²-1 ≠ x², (x|1) ≠ 0 ──
const op2Wat = `(module
 (func $f (export "f") (param $x i32) (param $y i32) (result i32) (local $r i32)
  (local.set $r (i32.add (local.get $x) (local.get $y)))
  (if (i32.eq (i32.sub (i32.mul (i32.const 7) (i32.mul (local.get $y) (local.get $y))) (i32.const 1)) (i32.mul (local.get $x) (local.get $x)))
   (then (local.set $r (i32.const -1))))
  (if (i32.ne (i32.or (local.get $x) (i32.const 1)) (i32.const 0))
   (then (local.set $r (i32.mul (local.get $r) (i32.const 2))))
   (else (local.set $r (i32.const -2))))
  (local.get $r)))`;
save('opaque2', compile(op2Wat), { verified: true, stats: { opaque: 2 }, gone: ['(i32.const -1)', '(i32.const -2)'] });
