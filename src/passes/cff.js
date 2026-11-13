// Kontrol akışı düzleştirme (control-flow flattening) geri alma. Düzleştirilmiş fonksiyonda temel bloklar bir durum
// değişkeniyle seçilir:
//
//   (local.set $s (i32.const K0))
//   (loop $L
//     (block $cN … (block $c1 (block $c0 (br_table $c0 $c1 … $default (f (local.get $s))))
//        durum 0 kodu  (local.set $s K) (br $L))
//        durum 1 kodu  (local.set $s (select Ka Kb koşul)) (br $L))
//        …))
//
// Pass dağıtıcıyı çözümler: her durum için kodu ve sonraki durumu (sabit, select/if ile koşullu, düşerek bir sonraki
// durum, return/dış bloğa çıkış) bulur, bu grafı binaryen'in Relooper'ıyla yeniden yapılandırılmış if/loop koduna
// çevirir. Durum değişkeni yalnızca dağıtıcıda kullanılıyorsa dönüşüm yapılır; aksi hâlde fonksiyon olduğu gibi kalır.
import { withModule, emit, functions, info, walk, children } from '../core/ir.js';
import { compile, compileOf, constI32 } from '../core/eval.js';

export const id = 'cff';
const CLEAN = ['remove-unused-brs', 'merge-blocks', 'remove-unused-names', 'vacuum', 'simplify-locals-notee-nostructure', 'remove-unused-brs', 'merge-blocks', 'vacuum', 'reorder-locals'];

const refsLocal = (B, root, idx) => {
  let n = 0;
  walk(B, root, (e, i) => { if ((i.kind === 'LocalGet' || i.kind === 'LocalSet') && i.index === idx) n++; });
  return n;
};
const usesLabel = (B, root, labels) => {
  let hit = false;
  walk(B, root, (e, i) => {
    if (hit) return false;
    if (i.kind === 'Break' && labels.has(i.name)) hit = true;
    if (i.kind === 'Switch' && [...i.names, i.defaultName].some((n) => labels.has(n))) hit = true;
    return !hit;
  });
  return hit;
};

// tanılama: globalThis.__PEEL_DEBUG açıkken reddedilen dağıtıcının nedeni yazılır
/** Kökten hedefe ifade zinciri: [[ref, info], …] (son öğe hedef) */
function ancestors(B, root, target) {
  const path = [];
  const dfs = (e) => {
    const i = info(B, e);
    path.push([e, i]);
    if (e === target) return true;
    for (const c of children(i)) if (dfs(c)) return true;
    path.pop();
    return false;
  };
  return dfs(root) ? path : null;
}

const why = (n) => { if (globalThis.__PEEL_DEBUG) console.log(`cff: red ${n}`); return false; };

/** Döngünün dağıtıcı yapısı: { sIndex, indexFn, names, defaultName, path (dıştan içe bloklar) } ya da null */
function dispatcher(B, loop) {
  const L = info(B, loop);
  if (!L.name) return null;
  const path = [];
  let cur = L.body;
  for (;;) {
    const i = info(B, cur);
    if (i.kind === 'Block') {
      if (!i.children.length || (i.type !== B.none && i.type !== B.unreachable)) return null;
      path.push({ ref: cur, info: i });
      cur = i.children[0];
      continue;
    }
    if (i.kind !== 'Switch' || i.value) return null;
    const c = compile(B, i.condition);
    if (!c || c.vars.length !== 1 || !c.vars[0].startsWith('l')) return null;
    const sIndex = Number(c.vars[0].slice(1));
    return { loopName: L.name, sIndex, indexFn: compileOf(B, i.condition, sIndex), names: i.names, defaultName: i.defaultName, path, switchRef: cur };
  }
}

/**
 * @returns {boolean} dönüşüm yapıldı mı
 */
function unflatten(B, m, f, loop, parent, idxInParent) {
  const d = dispatcher(B, loop);
  if (!d || d.path.length < 2) return why(1);
  const { sIndex, loopName, path } = d;
  if (sIndex < f.params.length || !d.indexFn) return why(2);
  // segment j: path[j]'nin (dıştan içe sırada) ilk çocuğundan sonraki kod; path[j+1]'in etiketi j'ye götürür
  const t = path.length;
  const segOf = new Map(); // etiket → segment indeksi; dış bloğun (path[0]) etiketi → 'exit'
  const caseLabels = new Set([loopName]);
  for (let j = 0; j < t; j++) {
    const name = path[j].info.name;
    if (!name) continue;
    caseLabels.add(name);
    segOf.set(name, j === 0 ? 'exit' : j - 1);
  }
  // segment k = path[k].info.children.slice(1) (k = 0..t-2 içten dışa değil: path[k] dıştaki); sıralama: içten dışa
  // yürütme sırası path[t-2], path[t-3], …, path[0] çocuklarıdır. Etiketi path[j] olan hedef path[j-1]'in kalanına gider.
  const segments = [];
  for (let k = t - 2; k >= 0; k--) segments.push({ stmts: path[k].info.children.slice(1), seg: segments.length });
  // etiket eşlemesini yürütme sırasına çevir: path[j] etiketi → segments indeksi (t-1-j)
  for (const [name, v] of segOf) if (v !== 'exit') segOf.set(name, t - 1 - (v + 1));
  // içteki blokta br_table'dan sonra gelen ölü kod yok sayılır

  const target = (k) => {
    const idx = d.indexFn(k) >>> 0;
    const label = idx < d.names.length ? d.names[idx] : d.defaultName;
    if (label === loopName) return null;
    if (segOf.has(label)) return segOf.get(label) === 'exit' ? { exit: true } : { seg: segOf.get(label) };
    return { outer: label };
  };

  // durum ataması: sabit, select(Ka, Kb, c) ya da if(c, Ka, Kb)
  const stateOf = (v) => {
    const k = constI32(B, v);
    if (k !== null) return { kind: 'goto', to: target(k) };
    const i = info(B, v);
    if (i.kind === 'Select' || i.kind === 'If') {
      const a = constI32(B, i.ifTrue);
      const b = i.ifFalse ? constI32(B, i.ifFalse) : null;
      if (a === null || b === null) return null;
      return { kind: 'cond', cond: i.condition, then: target(a), else: target(b) };
    }
    return null;
  };
  const isStateSet = (e) => { const i = info(B, e); return i.kind === 'LocalSet' && !i.isTee && i.index === sIndex ? i : null; };
  const isContinue = (e) => { const i = info(B, e); return i.kind === 'Break' && i.name === loopName && !i.condition && !i.value; };
  // if (c) { …; s = Ka; br L } else { …; s = Kb; br L }
  const armOf = (e) => {
    if (!e) return null;
    const i = info(B, e);
    const list = i.kind === 'Block' && !i.name ? i.children : [e];
    if (list.length < 2 || !isContinue(list.at(-1))) return null;
    const set = isStateSet(list.at(-2));
    const k = set ? constI32(B, set.value) : null;
    if (k === null) return null;
    return { to: target(k), code: list.slice(0, -2) };
  };

  for (const s of segments) {
    const st = s.stmts;
    const last = st.at(-1);
    s.body = st;
    s.next = { kind: 'fall' };
    if (last && isContinue(last)) {
      const set = st.length >= 2 ? isStateSet(st.at(-2)) : null;
      const nx = set ? stateOf(set.value) : null;
      if (!nx) return why(3);
      s.body = st.slice(0, -2);
      s.next = nx;
    } else if (last && info(B, last).kind === 'If') {
      const i = info(B, last);
      const a = armOf(i.ifTrue);
      const b = armOf(i.ifFalse);
      if (a && b) {
        s.body = st.slice(0, -1);
        s.next = { kind: 'cond', cond: i.condition, then: a.to, else: b.to, thenCode: a.code, elseCode: b.code };
      }
    }
    if (s.next.kind === 'fall') {
      const k = last ? info(B, last).kind : 'Nop';
      if (k === 'Return' || k === 'Unreachable' || (k === 'Break' && !info(B, last).condition)) s.next = { kind: 'none' };
      else s.next = { kind: 'goto', to: s.seg + 1 < segments.length ? { seg: s.seg + 1 } : { exit: true } };
    }
    const tos = s.next.kind === 'goto' ? [s.next.to] : s.next.kind === 'cond' ? [s.next.then, s.next.else] : [];
    if (tos.some((x) => !x)) return why(4);
    // segment kodu dağıtıcıya dokunmamalı
    const code = [...s.body, ...(s.next.thenCode ?? []), ...(s.next.elseCode ?? []), ...(s.next.cond ? [s.next.cond] : [])];
    for (const c of code) if (refsLocal(B, c, sIndex) || usesLabel(B, c, caseLabels)) return why(5);
  }

  // giriş durumu: döngüyü içeren bloklarda (içten dışa) döngüden önce gelen kardeş atama. Arada başka bir döngü
  // olmamalı (yeniden girişte durum K0 olmaz); durum değişkeni başka hiçbir yerde kullanılmamalı.
  const chain = ancestors(B, f.body, loop);
  if (!chain) return why(6);
  let init = null;
  for (let a = chain.length - 2; a >= 0 && !init; a--) {
    const [anc, ai] = chain[a];
    if (ai.kind === 'Loop') return why(6);
    if (ai.kind !== 'Block') continue;
    const at = ai.children.indexOf(chain[a + 1][0]);
    for (let k = at - 1; k >= 0; k--) {
      if (isStateSet(ai.children[k])) { init = { block: anc, at: k, set: isStateSet(ai.children[k]) }; break; }
      if (refsLocal(B, ai.children[k], sIndex)) return why(6);
    }
  }
  if (!init) return why(7);
  const k0 = constI32(B, init.set.value);
  if (k0 === null) return why(8);
  const inLoop = refsLocal(B, loop, sIndex);
  if (refsLocal(B, f.body, sIndex) !== inLoop + 1) return why(9);
  const entryTo = target(k0);
  if (!entryTo) return why(10);

  const R = new B.Relooper(m);
  const copy = (e) => m.copyExpression(e);
  const blockOf = (list) => (list.length ? m.block(null, list.map(copy), B.none) : m.nop());
  const nodes = segments.map((s) => R.addBlock(blockOf(s.body)));
  const exitNode = R.addBlock(m.nop());
  const outers = new Map();
  const nodeOf = (to) => {
    if (to.exit) return exitNode;
    if (to.outer) {
      if (!outers.has(to.outer)) outers.set(to.outer, R.addBlock(m.br(to.outer)));
      return outers.get(to.outer);
    }
    return nodes[to.seg];
  };
  for (const s of segments) {
    const from = nodes[s.seg];
    if (s.next.kind === 'goto') R.addBranch(from, nodeOf(s.next.to), 0, 0);
    else if (s.next.kind === 'cond') {
      R.addBranch(from, nodeOf(s.next.then), copy(s.next.cond), s.next.thenCode?.length ? blockOf(s.next.thenCode) : 0);
      R.addBranch(from, nodeOf(s.next.else), 0, s.next.elseCode?.length ? blockOf(s.next.elseCode) : 0);
    }
  }
  const entry = nodeOf(entryTo);
  const out = R.renderAndDispose(entry, sIndex);
  B.Block.setChildAt(parent, idxInParent, out);
  B.Block.setChildAt(init.block, init.at, m.nop());
  B.Block.finalize?.(parent);
  return true;
}

export function run(bytes, ctx) {
  const { B } = ctx;
  return withModule(B, bytes, (m) => {
    let total = 0;
    for (const f of functions(B, m)) {
      if (f.base) continue;
      const failed = new Set();
      let n = 0;
      for (let guard = 0; guard < 32; guard++) {
        const body = B.Function.getBody(f.ref);
        let hit = null;
        walk(B, body, (e, i, parent) => {
          if (hit) return false;
          if (i.kind === 'Loop' && !failed.has(e) && parent && info(B, parent).kind === 'Block') {
            const idx = children(info(B, parent)).indexOf(e);
            hit = { loop: e, parent, idx };
            return false;
          }
          return true;
        });
        if (!hit) break;
        if (unflatten(B, m, { ...f, body }, hit.loop, hit.parent, hit.idx)) n++;
        else failed.add(hit.loop);
      }
      if (n) {
        m.runPassesOnFunction(f.name, CLEAN);
        total += n;
      }
    }
    if (!total) return null;
    ctx.bump('cff', total);
    return emit(B, m);
  });
}
