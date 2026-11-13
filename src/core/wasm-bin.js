// Ham wasm ikili biçimi yardımcıları (binaryen gerektirmez): bölüm listesi, LEB128, özel bölümler ("name",
// "producers"), ad bölümünün yeniden yazılması ve gömülü modül araması. Tarayıcıda ve Node'da aynı çalışır.

export const MAGIC = [0x00, 0x61, 0x73, 0x6d];
export const isWasm = (b) => b?.length >= 8 && b[0] === 0 && b[1] === 0x61 && b[2] === 0x73 && b[3] === 0x6d && b[4] === 1 && b[5] === 0 && b[6] === 0 && b[7] === 0;

export function readU32(b, pos) {
  let result = 0;
  let shift = 0;
  for (let i = 0; i < 5; i++) {
    if (pos >= b.length) throw new Error('LEB128 taşması');
    const byte = b[pos++];
    result |= (byte & 0x7f) << shift;
    if (!(byte & 0x80)) return [result >>> 0, pos];
    shift += 7;
  }
  throw new Error('LEB128 çok uzun');
}

export function u32(n) {
  const out = [];
  do {
    let byte = n & 0x7f;
    n >>>= 7;
    if (n) byte |= 0x80;
    out.push(byte);
  } while (n);
  return out;
}

const enc = new TextEncoder();
const dec = new TextDecoder('utf-8', { fatal: false });
const str = (s) => { const b = enc.encode(s); return [...u32(b.length), ...b]; };

/** Bölümler: [{ id, start (gövde başı), end, name? (özel bölüm adı), payload: [start, end) }] */
export function sections(b) {
  if (!isWasm(b)) throw new Error('wasm başlığı yok');
  const out = [];
  let pos = 8;
  while (pos < b.length) {
    const id = b[pos];
    const [size, body] = readU32(b, pos + 1);
    const end = body + size;
    if (end > b.length) throw new Error(`bölüm ${id} dosya sonunu aşıyor`);
    const s = { id, head: pos, start: body, end };
    if (id === 0) {
      const [len, p] = readU32(b, body);
      s.name = dec.decode(b.subarray(p, p + len));
      s.payload = [p + len, end];
    } else s.payload = [body, end];
    out.push(s);
    pos = end;
  }
  return out;
}

const readName = (b, pos) => {
  const [len, p] = readU32(b, pos);
  return [dec.decode(b.subarray(p, p + len)), p + len];
};

/** "name" bölümü: { module, functions: Map<idx, ad>, locals: Map<fidx, Map<idx, ad>>, globals: Map<idx, ad> } */
export function readNames(b) {
  const s = sections(b).find((x) => x.id === 0 && x.name === 'name');
  const names = { module: null, functions: new Map(), locals: new Map(), globals: new Map(), raw: new Map() };
  if (!s) return names;
  let pos = s.payload[0];
  const end = s.payload[1];
  const nameMap = (p, into) => {
    let count;
    [count, p] = readU32(b, p);
    for (let i = 0; i < count; i++) {
      let idx; let name;
      [idx, p] = readU32(b, p);
      [name, p] = readName(b, p);
      into.set(idx, name);
    }
    return p;
  };
  while (pos < end) {
    const kind = b[pos];
    const [size, body] = readU32(b, pos + 1);
    const subEnd = body + size;
    names.raw.set(kind, b.subarray(body, subEnd));
    if (kind === 0) [names.module] = readName(b, body);
    else if (kind === 1) nameMap(body, names.functions);
    else if (kind === 2) {
      let p = body;
      let count;
      [count, p] = readU32(b, p);
      for (let i = 0; i < count; i++) {
        let fidx;
        [fidx, p] = readU32(b, p);
        const m = new Map();
        p = nameMap(p, m);
        names.locals.set(fidx, m);
      }
    } else if (kind === 7) nameMap(body, names.globals);
    pos = subEnd;
  }
  return names;
}

function nameMapBytes(map) {
  const entries = [...map].sort((a, b) => a[0] - b[0]);
  return [...u32(entries.length), ...entries.flatMap(([i, n]) => [...u32(i), ...str(n)])];
}
const sub = (kind, bytes) => [kind, ...u32(bytes.length), ...bytes];

/** Ad bölümünü verilen adlarla yeniden yazar (diğer alt bölümler korunur). Davranışı etkilemez. */
export function writeNames(b, names) {
  const parts = [];
  if (names.module) parts.push(...sub(0, str(names.module)));
  if (names.functions.size) parts.push(...sub(1, nameMapBytes(names.functions)));
  if (names.locals.size) {
    const entries = [...names.locals].sort((a, c) => a[0] - c[0]);
    parts.push(...sub(2, [...u32(entries.length), ...entries.flatMap(([f, m]) => [...u32(f), ...nameMapBytes(m)])]));
  }
  for (const [kind, raw] of [...names.raw].sort((a, c) => a[0] - c[0])) {
    if (kind === 0 || kind === 1 || kind === 2 || kind === 7) continue;
    if (kind < 7) parts.push(...sub(kind, [...raw]));
  }
  if (names.globals.size) parts.push(...sub(7, nameMapBytes(names.globals)));
  for (const [kind, raw] of [...names.raw].sort((a, c) => a[0] - c[0])) if (kind > 7) parts.push(...sub(kind, [...raw]));
  const payload = [...str('name'), ...parts];
  const section = [0, ...u32(payload.length), ...payload];
  const keep = sections(b).filter((s) => !(s.id === 0 && s.name === 'name'));
  const out = [...b.subarray(0, 8)];
  for (const s of keep) out.push(...b.subarray(s.head, s.end));
  // ad bölümü veri bölümünden sonra gelir (araçlar sonda bekler)
  out.push(...section);
  return new Uint8Array(out);
}

/** "producers" bölümü: { language: [[ad, sürüm]], 'processed-by': [...], sdk: [...] } */
export function readProducers(b) {
  const s = sections(b).find((x) => x.id === 0 && x.name === 'producers');
  if (!s) return null;
  const out = {};
  let p = s.payload[0];
  let fields;
  [fields, p] = readU32(b, p);
  for (let i = 0; i < fields; i++) {
    let field; let count;
    [field, p] = readName(b, p);
    [count, p] = readU32(b, p);
    out[field] = [];
    for (let j = 0; j < count; j++) {
      let n; let v;
      [n, p] = readName(b, p);
      [v, p] = readName(b, p);
      out[field].push([n, v]);
    }
  }
  return out;
}

export const customSections = (b) => sections(b).filter((s) => s.id === 0).map((s) => ({ name: s.name, size: s.end - s.start }));

/** Bayt dizisinde gömülü wasm modülleri (\0asm + sürüm 1); bulunan her başlangıç ofseti */
export function findEmbedded(bytes, from = 1) {
  const out = [];
  for (let i = from; i + 8 <= bytes.length; i++) {
    if (bytes[i] === 0 && bytes[i + 1] === 0x61 && bytes[i + 2] === 0x73 && bytes[i + 3] === 0x6d && bytes[i + 4] === 1 && !bytes[i + 5] && !bytes[i + 6] && !bytes[i + 7]) out.push(i);
  }
  return out;
}

// Bölümlerin zorunlu sırası (özel bölüm 0 her yerde olabilir): datacount (12) koddan (10) önce, tag (13) bellekten sonra gelir
const ORDER = { 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 13: 6, 6: 7, 7: 8, 8: 9, 9: 10, 12: 11, 10: 12, 11: 13 };

/** Gömülü modülün uzunluğu: bölüm başlıkları geçerli ve sıralı olduğu sürece ilerlenir */
export function embeddedLength(bytes, at) {
  let pos = at + 8;
  let last = pos;
  let prev = 0;
  while (pos < bytes.length) {
    const id = bytes[pos];
    if (id !== 0 && (!ORDER[id] || ORDER[id] <= prev)) break;
    let size; let body;
    try { [size, body] = readU32(bytes, pos + 1); } catch { break; }
    if (body + size > bytes.length) break;
    if (id) prev = ORDER[id];
    pos = body + size;
    last = pos;
  }
  return last - at;
}

/** FNV-1a 32 bit (bellek ve bayt karşılaştırması için; kriptografik değil) */
export function fnv1a(bytes) {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i], 0x01000193);
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Yazdırılabilir ASCII dizgeler (en az min karakter) */
export function strings(bytes, min = 4, limit = 20000) {
  const out = [];
  let cur = '';
  for (let i = 0; i < bytes.length && out.length < limit; i++) {
    const c = bytes[i];
    if (c >= 0x20 && c < 0x7f) cur += String.fromCharCode(c);
    else {
      if (cur.length >= min) out.push(cur);
      cur = '';
    }
  }
  if (cur.length >= min && out.length < limit) out.push(cur);
  return out;
}

/** Shannon entropisi (bit/bayt) */
export function entropy(bytes) {
  if (!bytes.length) return 0;
  const n = new Array(256).fill(0);
  for (const b of bytes) n[b]++;
  let e = 0;
  for (const c of n) if (c) { const p = c / bytes.length; e -= p * Math.log2(p); }
  return e;
}
