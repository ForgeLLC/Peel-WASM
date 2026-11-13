// Şifreli veri bölümleri: modül veri bölümlerini şifreli taşıyıp başlangıç (start) fonksiyonunda çözüyorsa, modül
// sandbox'ta örneklenir ve başlangıçtan hemen sonraki bellek görüntüsü alınır. Görüntü yeni veri bölümleri olarak
// yazılır ve başlangıç fonksiyonu kaldırılır; çözücü fonksiyon başka yerden çağrılmıyorsa dead pass'i siler.
// Koşullar (aksi hâlde dokunulmaz): bellek modülün kendisinde tanımlı (import değil), pasif veri bölümü yok,
// başlangıçtan ulaşılan kod yalnızca belleğe yazar (global yazma, import çağrısı, dolaylı çağrı, memory.init/data.drop,
// tablo yazma yok) ve başlangıç tuzaksız biter. Sonuç her zaman davranış karşılaştırmasıyla doğrulanır.
import { withModule, emit, moduleInfo, walk } from '../core/ir.js';
import { entropy } from '../core/wasm-bin.js';

export const id = 'data';
export const needsSandbox = true;

const FORBIDDEN = new Set(['GlobalSet', 'CallIndirect', 'MemoryInit', 'DataDrop', 'TableSet', 'TableGrow', 'Other']);
const PAGE = 65536;

function startIsPure(B, info) {
  const byName = new Map(info.funcs.map((f) => [f.name, f]));
  const seen = new Set();
  const todo = [info.start];
  while (todo.length) {
    const name = todo.pop();
    if (seen.has(name)) continue;
    seen.add(name);
    const f = byName.get(name);
    if (!f || f.base) return false;
    let ok = true;
    walk(B, f.body, (e, i) => {
      if (!ok) return false;
      if (FORBIDDEN.has(i.kind)) ok = false;
      else if (i.kind === 'Call') {
        if (byName.get(i.target)?.base) ok = false;
        else todo.push(i.target);
      }
      return ok;
    });
    if (!ok) return false;
  }
  return true;
}

/** Görüntüdeki sıfır olmayan bölgeler; aradaki 16 bayttan kısa sıfır boşlukları birleştirilir */
function runs(img) {
  const out = [];
  let i = 0;
  while (i < img.length) {
    while (i < img.length && !img[i]) i++;
    if (i >= img.length) break;
    const start = i;
    let end = i;
    while (i < img.length) {
      if (img[i]) { end = ++i; continue; }
      let z = i;
      while (z < img.length && !img[z] && z - i < 16) z++;
      if (z >= img.length || z - i >= 16) break;
      i = z;
    }
    out.push([start, end]);
    i = end;
  }
  return out;
}

export async function run(bytes, ctx) {
  const { B } = ctx;
  const plan = withModule(B, bytes, (m) => {
    const info = moduleInfo(B, m);
    if (!info.start || !info.memory || info.memory.module) return null;
    if (info.segments.some((s) => s.passive || typeof s.offset !== 'number')) return null;
    if (!startIsPure(B, info)) return null;
    return { info: { memory: info.memory, segments: info.segments.map((s) => ({ offset: s.offset, data: new Uint8Array(s.data) })), exports: info.exports } };
  });
  if (!plan) return null;
  const r = await ctx.execute(bytes, { calls: [], dumpMemory: true });
  if (!r?.ok || r.startError || !r.memory) return null;
  const after = r.memory;
  const before = new Uint8Array(after.length);
  for (const s of plan.info.segments) before.set(s.data.subarray(0, Math.max(0, before.length - s.offset)), s.offset);
  let changed = 0;
  for (let i = 0; i < after.length; i++) if (after[i] !== before[i]) changed++;
  if (!changed) return null;
  // açılan veri: değişen baytların içindeki yazdırılabilir dizgeler raporda gösterilir
  const segs = runs(after).map(([s, e]) => ({ offset: s, data: after.slice(s, e) }));
  const inEntropy = entropy(Uint8Array.from(plan.info.segments.flatMap((s) => [...s.data])));
  const outEntropy = entropy(Uint8Array.from(segs.flatMap((s) => [...s.data])));
  return withModule(B, bytes, (m) => {
    const mem = plan.info.memory;
    const exp = plan.info.exports.find((e) => e.kind === 'memory');
    const pages = Math.max(mem.initial, Math.ceil(after.length / PAGE));
    m.setMemory(pages, mem.max ?? -1, null, segs.map((s) => ({ offset: m.i32.const(s.offset), data: s.data, passive: false })), mem.shared, mem.is64, exp?.value ?? '0');
    m.setStart(0);
    ctx.bump('data', changed);
    ctx.note('data', { changed, inEntropy: Number(inEntropy.toFixed(2)), outEntropy: Number(outEntropy.toFixed(2)) });
    return emit(B, m);
  });
}
