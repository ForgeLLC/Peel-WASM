// Opak koşullar: değeri her girdi için aynı olan ama derleyicinin katlayamadığı koşullar (ör. x*(x+1) her zaman
// çift, 7y²-1 ≠ x²). core/eval.js'in provenConstant'ı koşulun sabitliğini tüm düşük-bit atamalarıyla kanıtlar;
// kanıtlanan koşul sabitle değişir, ölü dal aynı pass içinde binaryen ile silinir.
import { withModule, emit, functions, walk } from '../core/ir.js';
import { provenConstant, compile } from '../core/eval.js';

export const id = 'opaque';
const CLEAN = ['precompute', 'remove-unused-brs', 'dce', 'vacuum', 'merge-blocks', 'remove-unused-names'];

export function run(bytes, ctx) {
  const { B } = ctx;
  return withModule(B, bytes, (m) => {
    let n = 0;
    for (const f of functions(B, m)) {
      if (f.base) continue;
      const sites = [];
      walk(B, f.body, (e, i) => {
        if ((i.kind === 'If' || i.kind === 'Select' || (i.kind === 'Break' && i.condition)) && i.condition) sites.push([e, i.kind, i.condition]);
      });
      let changed = 0;
      for (const [e, kind, cond] of sites) {
        const c = compile(B, cond);
        if (!c || !c.vars.length) continue; // yapraksız sabitler fold'un işi
        const v = provenConstant(B, cond);
        if (v === null) continue;
        const cls = kind === 'If' ? B.If : kind === 'Select' ? B.Select : B.Break;
        cls.setCondition(e, m.i32.const(v));
        changed++;
      }
      if (changed) {
        m.runPassesOnFunction(f.name, CLEAN);
        n += changed;
      }
    }
    if (!n) return null;
    ctx.bump('opaque', n);
    return emit(B, m);
  });
}
