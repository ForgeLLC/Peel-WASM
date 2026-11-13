// Sabit katlama ve sabit kodlama çözümü (binaryen): sabit ifadeler hesaplanır (xor/add ile kodlanmış sabitler),
// değişmeyen global'lerin değerleri kullanım yerlerine yayılır, gereksiz bloklar ve local'ler toplanır.
import { withModule, emit, functions, countExprs } from '../core/ir.js';

export const id = 'fold';
const PASSES = ['precompute-propagate', 'optimize-instructions', 'simplify-globals-optimizing', 'precompute-propagate',
  'remove-unused-brs', 'merge-blocks', 'simplify-locals-notee-nostructure', 'vacuum', 'reorder-locals', 'remove-unused-names'];

export const total = (B, m) => functions(B, m).reduce((n, f) => n + (f.base ? 0 : countExprs(B, f.body)), 0);

export function run(bytes, ctx) {
  const { B } = ctx;
  return withModule(B, bytes, (m) => {
    const before = total(B, m);
    m.runPasses(PASSES);
    ctx.bump('fold', Math.max(0, before - total(B, m)));
    return emit(B, m);
  });
}
