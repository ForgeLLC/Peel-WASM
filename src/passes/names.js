// Ad kurtarma: ad bölümü olmayan (ya da adları silinmiş) modülde fonksiyon ve global'ler dışa aktarım ve import
// adlarından, başlangıç fonksiyonundan ve gölge yığın göstergesi kalıbından adlandırılır. Adlar wasm "name" özel
// bölümüne yazılır (core/wasm-bin.js); kod değişmez, davranış etkilenmez. Anlamlı bir adı olan öğeye dokunulmaz.
import { withModule, moduleInfo, walk, info as infoOf, renameBinary, indexOrder } from '../core/ir.js';

export const id = 'names';

// binaryen'in ad bölümü olmayan modüllere verdiği adlar ve yaygın anlamsız adlar
const GENERIC = /^(?:\d+|fimport\$\d+|gimport\$\d+|global\$\d+|f\d+|func\d+|fn\d+|function\d+|g\d+|_?[a-z]{1,2}\d*|[A-Za-z]{1,2}\$?\d+|\$?[a-zA-Z_$][\w$]{0,1})$/;
const ident = (s) => s.replace(/[^\w.$-]/g, '_').slice(0, 64) || '_';

export function generic(name) {
  return GENERIC.test(name);
}

/** Global, fonksiyon girişlerinde global.get → i32.sub → global.set kalıbıyla kullanılıyorsa yığın göstergesidir */
function stackPointer(B, info) {
  const counts = new Map();
  for (const f of info.funcs) {
    if (f.base) continue;
    walk(B, f.body, (e, i) => {
      if (i.kind !== 'GlobalSet') return true;
      const v = infoOf(B, i.value);
      const inner = v.kind === 'LocalSet' && v.isTee ? infoOf(B, v.value) : v;
      if (inner.kind === 'Binary' && inner.op === B.SubInt32) {
        const l = infoOf(B, inner.left);
        if (l.kind === 'GlobalGet' && l.name === i.name) counts.set(i.name, (counts.get(i.name) ?? 0) + 1);
      }
      return true;
    });
  }
  const best = [...counts].sort((a, b) => b[1] - a[1])[0];
  return best && best[1] >= 2 ? best[0] : null;
}

export function run(bytes, ctx) {
  const { B } = ctx;
  const renames = withModule(B, bytes, (m) => {
    const info = moduleInfo(B, m);
    const taken = new Set([...info.funcs.map((f) => f.name), ...info.globals.map((g) => g.name)]);
    const functions = new Map();
    const globals = new Map();
    const give = (map, old, want) => {
      if (map.has(old) || !generic(old)) return;
      let n = ident(want);
      for (let k = 2; taken.has(n); k++) n = `${ident(want)}_${k}`;
      taken.add(n);
      map.set(old, n);
    };
    for (const e of info.exports) {
      if (e.kind === 'function') give(functions, e.value, e.name);
      if (e.kind === 'global') give(globals, e.value, e.name);
    }
    for (const f of info.funcs) if (f.base) give(functions, f.name, f.base);
    for (const g of info.globals) if (g.base) give(globals, g.name, g.base);
    if (info.start) give(functions, info.start, 'start');
    const sp = stackPointer(B, info);
    if (sp) give(globals, sp, '__stack_pointer');
    return { renames: { functions, globals }, order: indexOrder(info) };
  });
  const r = renameBinary(bytes, renames.renames, renames.order);
  if (!r.changed) return null;
  ctx.bump('names', r.changed);
  return r.bytes;
}
