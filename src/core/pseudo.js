// wasm-decompile benzeri sözde C çıktısı (okuma kolaylığı için; derlenebilir C değildir). binaryen IR'ı gezilir:
// bloklar etiketli { }, döngüler `loop L { }`, br → `break L` / `continue L`, bellek erişimi *(tür*)(adres).
// Tanınmayan ifadeler binaryen'in WAT gösterimiyle /* */ içinde yazılır.
import { info, functions, moduleInfo } from './ir.js';

const CT = { i32: 'int', i64: 'long', f32: 'float', f64: 'double', v128: 'v128', funcref: 'funcref', externref: 'externref', ref: 'ref' };
const INT_BIN = { Add: '+', Sub: '-', Mul: '*', DivS: '/', DivU: '/u', RemS: '%', RemU: '%u', And: '&', Or: '|', Xor: '^', Shl: '<<', ShrS: '>>', ShrU: '>>>', Eq: '==', Ne: '!=', LtS: '<', LtU: '<u', LeS: '<=', LeU: '<=u', GtS: '>', GtU: '>u', GeS: '>=', GeU: '>=u', RotL: 'rotl', RotR: 'rotr' };
const FLT_BIN = { Add: '+', Sub: '-', Mul: '*', Div: '/', Eq: '==', Ne: '!=', Lt: '<', Le: '<=', Gt: '>', Ge: '>=', Min: 'min', Max: 'max', CopySign: 'copysign' };
const SUFFIX = ['Int32', 'Int64', 'Float32', 'Float64'];
const MAX_FUNCS = 3000;
const MAX_CHARS = 6_000_000;

let tables = null;
function opTables(B) {
  if (tables) return tables;
  const bin = new Map();
  for (const sfx of SUFFIX) for (const [k, sym] of Object.entries(sfx.startsWith('Int') ? INT_BIN : FLT_BIN)) if (B[k + sfx] !== undefined) bin.set(B[k + sfx], sym);
  const binNames = new Set(SUFFIX.flatMap((s) => Object.keys(s.startsWith('Int') ? INT_BIN : FLT_BIN).map((k) => k + s)));
  const un = new Map();
  for (const k of Object.getOwnPropertyNames(B)) {
    if (!/^[A-Z][A-Za-z0-9]+(?:Int32|Int64|Float32|Float64)$/.test(k) || binNames.has(k) || typeof B[k] !== 'number') continue;
    if (/^(?:Type|Literal|Expression|External|Side|Features)/.test(k)) continue;
    if (!un.has(B[k])) un.set(B[k], k.replace(/Int32$/, '_i32').replace(/Int64$/, '_i64').replace(/Float32$/, '_f32').replace(/Float64$/, '_f64').replace(/^./, (c) => c.toLowerCase()));
  }
  tables = { bin, un };
  return tables;
}

const MEMT = (i, isStore) => {
  const signed = isStore ? '' : i.isSigned ? '' : 'u';
  if (i.type === null) return '?';
  return `${{ 1: `${signed}char`, 2: `${signed}short`, 4: 'int', 8: 'long' }[i.bytes] ?? 'int'}`;
};

export function pseudoC(B, m) {
  const { bin, un } = opTables(B);
  const mi = moduleInfo(B, m);
  const exportsOf = new Map();
  for (const e of mi.exports) if (e.kind === 'function') exportsOf.set(e.value, [...(exportsOf.get(e.value) ?? []), e.name]);
  const out = [];
  let size = 0;
  const push = (s) => { out.push(s); size += s.length + 1; };
  push('// PEEL · sözde C / pseudo-C (okuma amaçlı / for reading only)');
  for (const f of mi.funcs) if (f.base) push(`extern ${f.results.length ? f.results.map((r) => CT[r]).join(', ') : 'void'} ${f.name}(${f.params.map((p) => CT[p]).join(', ')}); // import "${f.module}" "${f.base}"`);
  for (const g of mi.globals) push(`${g.mutable ? '' : 'const '}${CT[g.type] ?? g.type} ${g.name};${g.module ? ` // import "${g.module}" "${g.base}"` : ''}`);
  if (mi.memory) push(`// memory: ${mi.memory.initial} page(s)${mi.memory.max ? `, max ${mi.memory.max}` : ''}${mi.memory.module ? ` (import "${mi.memory.module}" "${mi.memory.base}")` : ''}`);
  if (mi.start) push(`// start: ${mi.start}`);
  push('');

  const funcs = functions(B, m).filter((f) => !f.base);
  for (const f of funcs.slice(0, MAX_FUNCS)) {
    if (size > MAX_CHARS) { push(`// … ${funcs.length - out.length} fonksiyon daha (çıktı sınırı)`); break; }
    const nLocals = B.Function.getNumLocals(f.ref);
    const lname = (idx) => {
      const n = B.Function.hasLocalName(f.ref, idx) ? B.Function.getLocalName(f.ref, idx) : null;
      return n && !/^\d+$/.test(n) ? n.replace(/[^\w$]/g, '_') : idx < f.params.length ? `p${idx}` : `l${idx}`;
    };
    const loops = new Set();
    let depth = 1;
    const ind = () => '  '.repeat(depth);
    const lines = [];

    const expr = (e) => {
      const i = info(B, e);
      switch (i.kind) {
        case 'Const': {
          if (i.type === B.i64) {
            const v = i.value;
            return typeof v === 'object' ? `${(BigInt(v.high >>> 0) << 32n | BigInt(v.low >>> 0)) & 0xffffffffffffffffn}L` : `${v}L`;
          }
          if (i.type === B.f32 || i.type === B.f64) return Number.isInteger(i.value) ? `${i.value}.0` : String(i.value);
          if (i.type === B.i32) return Math.abs(i.value) > 4096 ? `0x${(i.value >>> 0).toString(16)}` : String(i.value);
          return `/* ${B.emitText(e).trim()} */`;
        }
        case 'LocalGet': return lname(i.index);
        case 'LocalSet': return `(${lname(i.index)} = ${expr(i.value)})`;
        case 'GlobalGet': return i.name;
        case 'Load': return `*(${MEMT(i, false)}*)(${expr(i.ptr)}${i.offset ? ` + ${i.offset}` : ''})`;
        case 'Binary': {
          const sym = bin.get(i.op);
          if (sym && /^[a-z]/.test(sym)) return `${sym}(${expr(i.left)}, ${expr(i.right)})`;
          return sym ? `(${expr(i.left)} ${sym} ${expr(i.right)})` : `binop${i.op}(${expr(i.left)}, ${expr(i.right)})`;
        }
        case 'Unary': {
          const n = un.get(i.op) ?? `unop${i.op}`;
          if (n === 'eqZ_i32' || n === 'eqZ_i64') return `!${expr(i.value)}`;
          return `${n}(${expr(i.value)})`;
        }
        case 'Select': return `(${expr(i.condition)} ? ${expr(i.ifTrue)} : ${expr(i.ifFalse)})`;
        case 'Call': return `${i.target}(${i.operands.map(expr).join(', ')})`;
        case 'CallIndirect': return `(*table[${expr(i.target)}])(${i.operands.map(expr).join(', ')})`;
        case 'MemorySize': return 'memory_size()';
        case 'MemoryGrow': return `memory_grow(${expr(i.delta)})`;
        case 'If': return i.ifFalse ? `(${expr(i.condition)} ? ${expr(i.ifTrue)} : ${expr(i.ifFalse)})` : `if_${expr(i.condition)}`;
        case 'Block': {
          if (!i.name && i.children.length === 1) return expr(i.children[0]);
          // değer döndüren blok: deyimleri yaz, son ifadeyi döndür
          for (const c of i.children.slice(0, -1)) stmt(c);
          if (i.name) lines.push(`${ind()}// ${i.name}: (değerli blok sonu)`);
          return i.children.length ? expr(i.children.at(-1)) : '0';
        }
        default: return `/* ${B.emitText(e).replace(/\s+/g, ' ').trim().slice(0, 200)} */`;
      }
    };

    function stmt(e) {
      const i = info(B, e);
      switch (i.kind) {
        case 'Nop': return;
        case 'Block': {
          if (!i.name) { for (const c of i.children) stmt(c); return; }
          lines.push(`${ind()}${i.name}: {`);
          depth++;
          for (const c of i.children) stmt(c);
          depth--;
          lines.push(`${ind()}}`);
          return;
        }
        case 'Loop': {
          loops.add(i.name);
          lines.push(`${ind()}loop ${i.name || ''} {`);
          depth++;
          stmt(i.body);
          depth--;
          lines.push(`${ind()}}`);
          return;
        }
        case 'If': {
          lines.push(`${ind()}if (${expr(i.condition)}) {`);
          depth++; stmt(i.ifTrue); depth--;
          if (i.ifFalse) { lines.push(`${ind()}} else {`); depth++; stmt(i.ifFalse); depth--; }
          lines.push(`${ind()}}`);
          return;
        }
        case 'Break': {
          const kw = loops.has(i.name) ? 'continue' : 'break';
          const val = i.value ? ` /* = ${expr(i.value)} */` : '';
          if (i.condition) lines.push(`${ind()}if (${expr(i.condition)}) ${kw} ${i.name};${val}`);
          else lines.push(`${ind()}${kw} ${i.name};${val}`);
          return;
        }
        case 'Switch': {
          lines.push(`${ind()}switch (${expr(i.condition)}) {`);
          i.names.forEach((n, k) => lines.push(`${ind()}  case ${k}: ${loops.has(n) ? 'continue' : 'break'} ${n};`));
          lines.push(`${ind()}  default: ${loops.has(i.defaultName) ? 'continue' : 'break'} ${i.defaultName};`);
          lines.push(`${ind()}}`);
          return;
        }
        case 'LocalSet': lines.push(`${ind()}${lname(i.index)} = ${expr(i.value)};`); return;
        case 'GlobalSet': lines.push(`${ind()}${i.name} = ${expr(i.value)};`); return;
        case 'Store': lines.push(`${ind()}*(${MEMT(i, true)}*)(${expr(i.ptr)}${i.offset ? ` + ${i.offset}` : ''}) = ${expr(i.value)};`); return;
        case 'Drop': lines.push(`${ind()}${expr(i.value)};`); return;
        case 'Return': lines.push(`${ind()}return${i.value ? ` ${expr(i.value)}` : ''};`); return;
        case 'Unreachable': lines.push(`${ind()}unreachable();`); return;
        case 'MemoryCopy': lines.push(`${ind()}memcpy(${expr(i.dest)}, ${expr(i.source)}, ${expr(i.size)});`); return;
        case 'MemoryFill': lines.push(`${ind()}memset(${expr(i.dest)}, ${expr(i.value)}, ${expr(i.size)});`); return;
        default: {
          const v = expr(e);
          lines.push(i.type !== B.none && i.type !== B.unreachable && f.results.length ? `${ind()}return ${v};` : `${ind()}${v};`);
        }
      }
    }

    const ex = exportsOf.get(f.name);
    const params = f.params.map((t, k) => `${CT[t]} ${lname(k)}`).join(', ');
    const head = `${ex ? `// export ${ex.map((x) => `"${x}"`).join(', ')}\n` : ''}${f.results.length ? f.results.map((r) => CT[r]).join(', ') : 'void'} ${f.name}(${params}) {`;
    const vars = [];
    for (let k = f.params.length; k < nLocals; k++) vars.push(`${CT[f.vars[k - f.params.length]] ?? 'int'} ${lname(k)};`);
    try {
      const bt = B.getExpressionType(f.body);
      if (f.results.length && bt !== B.none && bt !== B.unreachable) {
        const v = expr(f.body);
        lines.push(`${ind()}return ${v};`);
      } else stmt(f.body);
    } catch (err) {
      lines.push(`${ind()}/* sözde C üretilemedi: ${err.message} */`);
    }
    push(head);
    for (const v of vars) push(`  ${v}`);
    for (const l of lines) push(l);
    push('}');
    push('');
  }
  return out.join('\n');
}
