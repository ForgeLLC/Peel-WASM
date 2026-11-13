// Ölü kod: ulaşılamayan dallar ve ifadeler (dce), hiçbir yerden çağrılmayan fonksiyonlar, global'ler ve import'lar
// (dışa açık olanlar, başlangıç fonksiyonu ve tablo girdileri kökler sayılır).
import { withModule, emit, functions } from '../core/ir.js';
import { total } from './fold.js';

export const id = 'dead';
const PASSES = ['dce', 'remove-unused-brs', 'vacuum', 'remove-unused-module-elements', 'remove-unused-names', 'merge-blocks', 'vacuum'];

export function run(bytes, ctx) {
  const { B } = ctx;
  return withModule(B, bytes, (m) => {
    const fn = functions(B, m).filter((f) => !f.base).length;
    const ex = total(B, m);
    m.runPasses(PASSES);
    ctx.bump('deadFunctions', Math.max(0, fn - functions(B, m).filter((f) => !f.base).length));
    ctx.bump('dead', Math.max(0, ex - total(B, m)));
    return emit(B, m);
  });
}
