// Sandbox motoru: hedef wasm modülü YALNIZCA kayıt tutan sahte import'larla örneklenir. Modülün dış dünyaya tek
// kapısı import'larıdır; burada hiçbiri gerçek bir işlem yapmaz (ağ, dosya, komut yok), çağrı ve argümanları
// kaydedilir. Belleğe yazan birkaç WASI/Emscripten taklidi (fd_write, random_get, clock_time_get, memcpy) modülün
// çalışmayı sürdürebilmesi için deterministik değerler yazar. Yakıt: hat modüle __peel.fuel import'u ekler
// (core/instrument.js); bütçe bitince bu çağrı FuelOut fırlatır. Sonsuz döngüye karşı son katman bekçidir.
// Tarayıcı Web Worker'ı ve Node alt süreci aynı motoru kullanır; motor saat ve rastgelelik kullanmaz.

const MAX_FX = 2000;
const MAX_STR = 400;
const MAX_LOAD = 16 * 1024 * 1024;
const MAX_HASH = 256 * 1024 * 1024;

class FuelOut extends Error {}
class Exit extends Error { constructor(code) { super(`exit(${code})`); this.code = code; } }

const zeroOf = (t) => (t === 'i64' ? 0n : 0);
const show = (v) => (typeof v === 'bigint' ? `${v}n` : Object.is(v, -0) ? '-0' : String(v));
const argOf = (t, v) => (t === 'i64' ? BigInt(v) : t === 'f32' || t === 'f64' ? Number(v) : Number(v) | 0);

function fnv1a(bytes) {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i], 0x01000193);
  return (h >>> 0).toString(16).padStart(8, '0');
}

const latin = (bytes) => { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return s; };
const printable = (s) => s.length >= 3 && /^[\x20-\x7e\t\r\n]+$/.test(s);

export function runModule(msg) {
  const fx = [];
  const loads = [];
  const loadHashes = new Set();
  let stdout = '';
  let memory = null;
  const mem = () => (memory ? new Uint8Array(memory.buffer) : null);

  // (ptr, len) çifti ya da C dizgesi gibi görünen i32 argümanlardan okunabilir dizgeler; \0asm ile başlayan
  // bölgeler gömülü modül olarak yakalanır
  function stringsOf(api, args) {
    const m = mem();
    if (!m) return [];
    const out = [];
    for (let i = 0; i < args.length; i++) {
      const p = args[i];
      if (typeof p !== 'number' || p <= 0 || p >= m.length) continue;
      const len = args[i + 1];
      if (typeof len === 'number' && len >= 8 && p + len <= m.length && m[p] === 0 && m[p + 1] === 0x61 && m[p + 2] === 0x73 && m[p + 3] === 0x6d && len <= MAX_LOAD) {
        const bytes = m.slice(p, p + len);
        const h = fnv1a(bytes);
        if (!loadHashes.has(h)) { loadHashes.add(h); loads.push({ api, size: len, bytes }); }
        continue;
      }
      if (typeof len === 'number' && len > 0 && len <= 4096 && p + len <= m.length) {
        const s = latin(m.subarray(p, p + len));
        if (printable(s)) { out.push(s.slice(0, MAX_STR)); continue; }
      }
      let e = p;
      while (e < m.length && e - p < MAX_STR && m[e] >= 0x20 && m[e] < 0x7f) e++;
      if (e - p >= 4 && m[e] === 0) out.push(latin(m.subarray(p, e)));
    }
    return out;
  }

  const record = (api, args, strs = null) => {
    if (fx.length >= MAX_FX) return;
    fx.push([api, args.map(show), strs ?? stringsOf(api, args)]);
  };

  // deterministik WASI / Emscripten taklitleri (yalnızca belleğe yazar)
  const view = () => new DataView(memory.buffer);
  const SPECIAL = {
    'wasi_snapshot_preview1.fd_write': (fd, iovs, n, written) => {
      let text = '';
      let total = 0;
      if (memory) {
        const dv = view();
        for (let i = 0; i < n && i < 64; i++) {
          const p = dv.getUint32(iovs + i * 8, true);
          const l = dv.getUint32(iovs + i * 8 + 4, true);
          text += latin(new Uint8Array(memory.buffer, p, Math.min(l, 65536)));
          total += l;
        }
        dv.setUint32(written, total, true);
      }
      if (fd === 1 || fd === 2) stdout = (stdout + text).slice(-65536);
      record('wasi_snapshot_preview1.fd_write', [fd, iovs, n, written], [text.slice(0, MAX_STR)]);
      return 0;
    },
    'wasi_snapshot_preview1.proc_exit': (code) => { record('wasi_snapshot_preview1.proc_exit', [code], []); throw new Exit(code); },
    'wasi_snapshot_preview1.random_get': (buf, len) => {
      if (memory) { const m = mem(); for (let i = 0; i < len && buf + i < m.length; i++) m[buf + i] = (Math.imul(i, 1103515245) + 12345) >>> 16 & 0xff; }
      record('wasi_snapshot_preview1.random_get', [buf, len], []);
      return 0;
    },
    'wasi_snapshot_preview1.clock_time_get': (id, prec, out) => {
      if (memory) view().setBigUint64(out, 1704067200000000000n, true);
      record('wasi_snapshot_preview1.clock_time_get', [id, prec, out], []);
      return 0;
    },
  };
  const memcpy = (dest, src, num) => { if (memory) { const m = mem(); m.copyWithin(dest, src, src + num); } return dest; };
  SPECIAL['env.emscripten_memcpy_big'] = memcpy;
  SPECIAL['env.emscripten_memcpy_js'] = memcpy;
  SPECIAL['env._emscripten_memcpy_js'] = memcpy;

  const imports = {};
  for (const imp of msg.imports ?? []) {
    const ns = (imports[imp.module] ??= {});
    const api = `${imp.module}.${imp.name}`;
    if (imp.kind === 'function') {
      if (imp.module === '__peel' && imp.name === 'fuel') { ns[imp.name] = () => { throw new FuelOut('fuel'); }; continue; }
      const special = SPECIAL[api];
      const result = imp.results?.length === 1 ? zeroOf(imp.results[0]) : imp.results?.length > 1 ? imp.results.map(zeroOf) : undefined;
      ns[imp.name] = special ? (...a) => special(...a) : (...args) => { record(api, args); return result; };
    } else if (imp.kind === 'memory') {
      memory = new WebAssembly.Memory({ initial: imp.initial ?? 1, maximum: Math.min(imp.maximum ?? 4096, 4096), shared: Boolean(imp.shared) });
      ns[imp.name] = memory;
    } else if (imp.kind === 'table') {
      ns[imp.name] = new WebAssembly.Table({ element: 'anyfunc', initial: imp.initial ?? 0, maximum: imp.maximum });
    } else if (imp.kind === 'global') {
      ns[imp.name] = new WebAssembly.Global({ value: imp.type, mutable: Boolean(imp.mutable) }, zeroOf(imp.type));
    }
  }

  let mod;
  try {
    mod = new WebAssembly.Module(msg.wasm);
  } catch (e) {
    return { ok: false, error: `derlenemedi: ${e.message}` };
  }
  const classify = (e) => (e instanceof FuelOut ? 'fuel'
    : e instanceof Exit ? e.message
      : e instanceof RangeError ? 'stack'
        : e instanceof WebAssembly.RuntimeError ? `trap: ${e.message}`
          : `error: ${e?.message ?? e}`);

  let instance = null;
  let startError = null;
  try {
    instance = new WebAssembly.Instance(mod, imports);
  } catch (e) {
    if (e instanceof WebAssembly.LinkError) return { ok: false, error: `bağlanamadı: ${e.message}` };
    startError = classify(e);
  }
  const exports = instance?.exports ?? {};
  for (const v of Object.values(exports)) if (!memory && v instanceof WebAssembly.Memory) memory = v;
  const fuel = exports.__peel_fuel instanceof WebAssembly.Global ? exports.__peel_fuel : null;
  const snapshot = msg.dumpMemory && memory ? mem().slice(0, MAX_HASH) : null;

  const calls = [];
  if (instance) {
    for (const c of msg.calls ?? []) {
      const fn = exports[c.export];
      if (typeof fn !== 'function') { calls.push({ export: c.export, result: 'missing', fx: fx.length }); continue; }
      if (fuel) fuel.value = msg.fuel ?? 5_000_000;
      let result;
      try {
        const r = fn(...(c.args ?? []).map((v, i) => argOf(c.types?.[i], v)));
        result = Array.isArray(r) ? r.map(show).join(',') : r === undefined ? 'void' : show(r);
      } catch (e) {
        result = classify(e);
      }
      calls.push({ export: c.export, result, fx: fx.length });
    }
  }
  const globals = {};
  for (const [k, v] of Object.entries(exports)) if (v instanceof WebAssembly.Global && k !== '__peel_fuel') globals[k] = show(v.value);
  const m = mem();
  return {
    ok: true,
    startError,
    calls,
    fx,
    loads,
    stdout,
    globals,
    memSize: m?.length ?? 0,
    memHash: m ? fnv1a(m.length > MAX_HASH ? m.subarray(0, MAX_HASH) : m) : null,
    memory: snapshot,
  };
}
