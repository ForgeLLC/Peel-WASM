// Girdi çözümleme: .wasm ikilisi, .wat metni ya da wasm'ı gömülü taşıyan bir JS yükleyicisi (base64 dizge,
// data: URL, bayt dizisi, \x kaçışlı dizge, onaltılık dizge). Bulunan her gömülü modül bir "katman" olarak
// kaydedilir; çözülecek modül en büyük geçerli olandır.
import { isWasm, embeddedLength } from './wasm-bin.js';

const td = new TextDecoder('utf-8', { fatal: false });

function fromBase64(s) {
  const clean = s.replace(/[^A-Za-z0-9+/=_-]/g, '').replace(/-/g, '+').replace(/_/g, '/');
  const body = clean.replace(/=+$/, '');
  const pad = body + '='.repeat((4 - (body.length % 4)) % 4);
  if (typeof atob === 'function') {
    const bin = atob(pad);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return new Uint8Array(Buffer.from(pad, 'base64'));
}

const trim = (bytes) => {
  if (!isWasm(bytes)) return null;
  const n = embeddedLength(bytes, 0);
  return n > 8 ? bytes.slice(0, n) : null;
};

// base64: "AGFzbQEAAAA" = \0asm\1\0\0\0; dizge birleştirmeleri ("…" + "…"), satır sonları ve \n kaçışları atlanır
const B64 = /AGFzbQEAAAA(?:[A-Za-z0-9+/=]|["']\s*\+\s*["']|\\n|\\r|\s)*/g;
const B64URL = /AGFzbQEAAAA(?:[A-Za-z0-9_=-])*/g;
// sayı dizisi: 0,97,115,109,1,0,0,0 ya da 0x00,0x61,0x73,0x6d,…
const ARR = /(?:\b0x0*0|\b0)\s*,\s*(?:0x61|97)\s*,\s*(?:0x73|115)\s*,\s*(?:0x6d|0x6D|109)\s*,[\s\d,xXa-fA-F]*/g;
const XESC = /(?:\\x00|\\0)\\x61\\x73\\x6d(?:\\x[0-9a-fA-F]{2}|\\[0-7]{1,3}|[\x20-\x21\x23-\x26\x28-\x5b\x5d-\x7e])*/g;
const HEX = /\b0061736d01000000(?:[0-9a-fA-F]{2})*/g;

function candidates(text) {
  const out = [];
  const push = (kind, at, decode) => {
    try {
      const b = trim(decode());
      if (b) out.push({ kind, at, bytes: b });
    } catch { /* bozuk aday */ }
  };
  // dizge birleştirmeleri ("AGFz" + "bQ…") önce kaldırılır: sihirli önek bile bölünmüş olabilir
  const joined = text.replace(/(["'`])\s*\+\s*(["'`])/g, '');
  for (const m of joined.matchAll(B64)) push(joined.slice(Math.max(0, m.index - 40), m.index).includes('data:') ? 'data-url' : 'base64', m.index, () => fromBase64(m[0].replace(/["']\s*\+\s*["']|\\n|\\r|\s/g, '')));
  for (const m of text.matchAll(B64URL)) if (/[_-]/.test(m[0])) push('base64url', m.index, () => fromBase64(m[0]));
  for (const m of text.matchAll(ARR)) push('byte-array', m.index, () => Uint8Array.from(m[0].split(',').map((x) => x.trim()).filter(Boolean).map((x) => Number(x) & 0xff)));
  for (const m of text.matchAll(XESC)) {
    push('escaped-string', m.index, () => {
      const bytes = [];
      const s = m[0];
      for (let i = 0; i < s.length;) {
        if (s[i] === '\\' && s[i + 1] === 'x') { bytes.push(parseInt(s.slice(i + 2, i + 4), 16)); i += 4; } else if (s[i] === '\\') {
          const oct = /^[0-7]{1,3}/.exec(s.slice(i + 1))[0];
          bytes.push(parseInt(oct, 8) & 0xff);
          i += 1 + oct.length;
        } else { bytes.push(s.charCodeAt(i)); i++; }
      }
      return Uint8Array.from(bytes);
    });
  }
  for (const m of text.matchAll(HEX)) push('hex', m.index, () => Uint8Array.from(m[0].match(/../g).map((h) => parseInt(h, 16))));
  return out;
}

const looksWat = (text) => /^\s*(?:(?:;;[^\n]*\n|\(;[\s\S]*?;\))\s*)*\(\s*module\b/.test(text);

/**
 * @param {Uint8Array|string} input
 * @param {{ watToWasm: (text: string) => Uint8Array }} tools
 * @returns {{ bytes: Uint8Array, kind: string, text: string|null, layers: object[] } | { error: string }}
 */
export function extractModule(input, { watToWasm }) {
  const raw = typeof input === 'string' ? null : input;
  if (raw && isWasm(raw)) return { bytes: raw, kind: 'wasm', text: null, layers: [] };
  const text = typeof input === 'string' ? input : td.decode(raw);
  if (looksWat(text)) {
    try {
      return { bytes: watToWasm(text), kind: 'wat', text, layers: [] };
    } catch (e) {
      return { error: `WAT ayrıştırılamadı: ${String(e?.message ?? e).split('\n')[0]}` };
    }
  }
  const found = candidates(text);
  if (!found.length) {
    if (/^\s*[A-Za-z0-9+/=\s]+$/.test(text) && text.trim().length > 16) {
      try {
        const b = trim(fromBase64(text));
        if (b) return { bytes: b, kind: 'base64', text: null, layers: [{ kind: 'base64', at: 0, size: b.length }] };
      } catch { /* düz metin */ }
    }
    return { error: 'Girdide wasm modülü bulunamadı (.wasm ikilisi, .wat metni ya da wasm gömülü bir JS yükleyicisi beklenir)' };
  }
  const uniq = [];
  for (const f of found) if (!uniq.some((u) => u.bytes.length === f.bytes.length && u.bytes.every((b, i) => b === f.bytes[i]))) uniq.push(f);
  uniq.sort((a, b) => b.bytes.length - a.bytes.length || a.at - b.at);
  return {
    bytes: uniq[0].bytes,
    kind: 'js-loader',
    text,
    layers: uniq.map((u) => ({ kind: u.kind, at: u.at, size: u.bytes.length })),
    others: uniq.slice(1).map((u) => u.bytes),
  };
}
