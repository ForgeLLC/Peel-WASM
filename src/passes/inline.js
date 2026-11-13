// Fonksiyon bölme (function splitting) geri alma: bir fonksiyonun gövdesi, her biri yalnızca bir yerden çağrılan
// küçük parçalara bölünmüşse parçalar çağrıldıkları yere geri yerleştirilir (binaryen inlining). Normal bir
// derleyici çıktısı da tek çağrılan fonksiyonlar içerir; yapıyı boş yere değiştirmemek için pass yalnızca parçaların
// modülde belirgin bir oran tuttuğu durumda çalışır.
import { withModule, emit, moduleInfo, walk, countExprs } from '../core/ir.js';

export const id = 'inline';

/** Tek yerden çağrılan, dışa açık olmayan, tabloda bulunmayan, döngüsüz küçük fonksiyonlar */
export function fragments(B, m) {
  const info = moduleInfo(B, m);
  const calls = new Map();
  const loops = new Set();
  for (const f of info.funcs) {
    if (f.base) continue;
    walk(B, f.body, (e, i) => {
      if (i.kind === 'Call') calls.set(i.target, (calls.get(i.target) ?? 0) + (i.target === f.name ? 2 : 1));
      if (i.kind === 'Loop') loops.add(f.name);
    });
  }
  const pinned = new Set([...info.exports.filter((e) => e.kind === 'function').map((e) => e.value), ...info.elems.flatMap((s) => s.data), info.start]);
  const defined = info.funcs.filter((f) => !f.base);
  const frags = defined.filter((f) => calls.get(f.name) === 1 && !pinned.has(f.name) && !loops.has(f.name) && countExprs(B, f.body) < 120);
  return { frags, defined };
}

export function run(bytes, ctx) {
  const { B } = ctx;
  return withModule(B, bytes, (m) => {
    const { frags, defined } = fragments(B, m);
    if (frags.length < 3 || frags.length / defined.length < 0.3 || defined.length > 4000) return null;
    const saved = [B.getOptimizeLevel(), B.getShrinkLevel(), B.getAlwaysInlineMaxSize(), B.getFlexibleInlineMaxSize(), B.getOneCallerInlineMaxSize(), B.getAllowInliningFunctionsWithLoops()];
    try {
      B.setOptimizeLevel(2);
      B.setShrinkLevel(0);
      B.setAlwaysInlineMaxSize(2);
      B.setFlexibleInlineMaxSize(0);
      B.setOneCallerInlineMaxSize(1000);
      B.setAllowInliningFunctionsWithLoops(false);
      m.runPasses(['inlining', 'remove-unused-module-elements', 'merge-blocks', 'remove-unused-names', 'vacuum']);
    } finally {
      B.setOptimizeLevel(saved[0]);
      B.setShrinkLevel(saved[1]);
      B.setAlwaysInlineMaxSize(saved[2]);
      B.setFlexibleInlineMaxSize(saved[3]);
      B.setOneCallerInlineMaxSize(saved[4]);
      B.setAllowInliningFunctionsWithLoops(saved[5]);
    }
    const after = moduleInfo(B, m).funcs.filter((f) => !f.base).length;
    ctx.bump('inline', Math.max(0, defined.length - after));
    return emit(B, m);
  });
}
