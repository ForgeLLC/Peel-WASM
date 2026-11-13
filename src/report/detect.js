// Tespit: araç zinciri (Emscripten, Rust/wasm-bindgen, Go, TinyGo, AssemblyScript, .NET, clang/wasi-sdk),
// gizleme teknikleri (pass istatistikleri + statik olgular), paketleyiciler (JS yükleyici, gömülü modül),
// kripto madenci imzaları (CryptoNight, RandomX) ve VM tabanlı koruma. Şüpheli dizgeler parçalı yazılır.
import { t, pick, rx, snippet } from './text.js';

// Keccak-f[1600] tur sabitleri (SHA-3 ve CryptoNight'ın ilk/son adımı)
const KECCAK = [...new Set(['8082', '800000000000808a', '8000000080008000', '808b', '80000001', '8000000080008081', '8000000000008009', '8a', '88',
  '80008009', '8000000a', '8000808b', '800000000000008b', '8000000000008089', '8000000000008003', '8000000000008002', '8000000000000080',
  '800a', '800000008000000a', '8000000080008081', '8000000000008080', '80000001', '8000000080008008'])];
// AES S-kutusunun ilk 16 baytı ve T-tablosu (Te0) ilk sözcüğü
const AES_SBOX = [0x63, 0x7c, 0x77, 0x7b, 0xf2, 0x6b, 0x6f, 0xc5, 0x30, 0x01, 0x67, 0x2b, 0xfe, 0xd7, 0xab, 0x76];
const AES_TE0 = 0xc66363a5;
const BLAKE2B_IV = '6a09e667f3bcc908';
const SKEIN_PARITY = '1bd11bdaa9fc1a22';
const GROESTL_T0 = 'c6a597f4a5f432c6';
// CryptoNight karalama alanı maskeleri (2 MB, lite 1 MB, heavy 4 MB) ve boyutları
const CN_MASKS = new Map([[0x1ffff0, 'CryptoNight'], [0xffff0, 'CryptoNight-Lite'], [0x3ffff0, 'CryptoNight-Heavy']]);
const MINER_STR = rx(['crypto', 'night|coin', 'hive|crypto', '-?loot|web', 'miner', 'pool|deep', 'miner|mon', 'ero|\\bxmr\\b|stratum\\+|random', 'x\\b|cn[_/]hash|hash_cn|jse', 'coin|mine', 'r\\.start'], 'i');
const RANDOMX = rx(['Random', 'X'], '');

const has = (bytes, pat) => {
  outer: for (let i = 0; i + pat.length <= bytes.length; i++) {
    for (let j = 0; j < pat.length; j++) if (bytes[i + j] !== pat[j]) continue outer;
    return true;
  }
  return false;
};
const le32 = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, v >>> 24];
const le64hex = (h) => { const v = BigInt(`0x${h}`); return Array.from({ length: 8 }, (_, i) => Number((v >> BigInt(8 * i)) & 0xffn)); };

/** Kripto madenci imzaları */
export function miner(facts, lang) {
  if (!facts) return null;
  const ev = [];
  let score = 0;
  let variant = null;
  const keccakCode = KECCAK.filter((k) => facts.i64.has(k)).length;
  const keccakData = KECCAK.slice(1, 8).filter((k) => has(facts.dataBytes, le64hex(k))).length;
  if (keccakCode >= 6 || keccakData >= 4) { score += 0.25; ev.push(pick(t(`Keccak tur sabitleri (${keccakCode} kodda, ${keccakData} veride)`, `Keccak round constants (${keccakCode} in code, ${keccakData} in data)`), lang)); }
  if (has(facts.dataBytes, AES_SBOX) || has(facts.dataBytes, le32(AES_TE0)) || facts.i32.has(AES_TE0)) { score += 0.2; ev.push(pick(t('AES S-kutusu / T-tablosu', 'AES S-box / T-table'), lang)); }
  for (const [mask, name] of CN_MASKS) {
    if (facts.i32.has(mask)) { score += 0.35; variant = name; ev.push(pick(t(`${name} karalama alanı maskesi 0x${mask.toString(16)}`, `${name} scratchpad mask 0x${mask.toString(16)}`), lang)); break; }
  }
  const extra = [[BLAKE2B_IV, 'Blake2b/SHA-512 IV'], [SKEIN_PARITY, 'Skein'], [GROESTL_T0, 'Groestl']].filter(([k]) => facts.i64.has(k) || has(facts.dataBytes, le64hex(k)));
  if (extra.length) { score += 0.05 * extra.length; ev.push(`${pick(t('ek özet sabitleri', 'extra hash constants'), lang)}: ${extra.map((x) => x[1]).join(', ')}`); }
  const names = [...facts.imports.map((i) => `${i.module}.${i.name}`), ...facts.exports.map((e) => e.name)];
  const strs = [...facts.strings, ...names, ...facts.custom.map((c) => c.name)];
  const hit = strs.find((s) => MINER_STR.test(s));
  if (hit) { score += 0.3; ev.push(`${pick(t('dizge', 'string'), lang)}: ${snippet(hit, 60)}`); }
  const rnd = strs.find((s) => RANDOMX.test(s));
  if (rnd) { score += 0.4; variant = 'RandomX'; ev.push(`${pick(t('dizge', 'string'), lang)}: ${snippet(rnd, 60)}`); }
  if (score < 0.5) return null;
  return {
    id: 'miner',
    name: pick(t(`Kripto para madencisi${variant ? ` (${variant})` : ''}`, `Cryptocurrency miner${variant ? ` (${variant})` : ''}`), lang),
    kind: 'malware',
    confidence: Math.min(0.99, Number(score.toFixed(2))),
    evidence: ev,
  };
}

const imp = (facts) => facts.imports.map((i) => `${i.module}.${i.name}`);
const exp = (facts) => facts.exports.map((e) => e.name);

/** Araç zinciri */
export function toolchains(facts, lang) {
  if (!facts) return [];
  const out = [];
  const add = (id, name, ev, conf) => { if (ev.length) out.push({ id, name, kind: 'toolchain', confidence: Math.min(0.99, conf(ev.length)), evidence: ev.slice(0, 5) }); };
  const I = imp(facts);
  const E = exp(facts);
  const S = facts.strings;
  const prod = facts.producers ?? {};
  const prodOf = (re) => Object.values(prod).flat().filter(([n]) => re.test(n)).map(([n, v]) => `producers: ${n} ${v}`);

  add('emscripten', 'Emscripten', [
    ...I.filter((n) => /^env\.(?:_?emscripten_|__syscall_|invoke_|__assert_fail|_abort_js|_tzset_js|__cxa_)/.test(n)).slice(0, 3),
    ...E.filter((n) => /^(?:__wasm_call_ctors|stackSave|stackRestore|stackAlloc|_emscripten_stack_init|emscripten_stack_get_end|__errno_location|_emscripten_\w+)$/.test(n)).slice(0, 3),
    ...prodOf(/^emscripten/i),
  ], (n) => 0.45 + 0.15 * n);
  add('rust', 'Rust (rustc / wasm-bindgen)', [
    ...I.filter((n) => /__wbindgen_|__wbg_/.test(n)).slice(0, 3),
    ...E.filter((n) => /^__wbindgen_|^__rust_/.test(n)).slice(0, 2),
    ...S.filter((s) => /\/rustc\/[0-9a-f]{6,}|panicked at|library\/core\/src|\.cargo\/registry/.test(s)).slice(0, 2).map((s) => snippet(s, 60)),
    ...prodOf(/^rust/i),
  ], (n) => 0.45 + 0.15 * n);
  add('go', 'Go (gc)', [
    ...I.filter((n) => /^(?:go|gojs)\.(?:runtime\.|syscall\/js\.)/.test(n)).slice(0, 3),
    ...(E.includes('run') && E.includes('resume') && E.includes('getsp') ? ['exports: run, resume, getsp'] : []),
  ], (n) => 0.5 + 0.2 * n);
  add('tinygo', 'TinyGo', [
    ...S.filter((s) => /tinygo|\/tinygo\//i.test(s)).slice(0, 2).map((s) => snippet(s, 60)),
    ...prodOf(/tinygo/i),
  ], (n) => 0.5 + 0.2 * n);
  add('assemblyscript', 'AssemblyScript', [
    ...(I.includes('env.abort') && E.some((n) => /^__(?:new|pin|unpin|collect|rtti_base)$/.test(n)) ? ['env.abort + __new/__pin'] : []),
    ...S.filter((s) => /~lib\//.test(s)).slice(0, 2).map((s) => snippet(s, 60)),
  ], (n) => 0.5 + 0.2 * n);
  add('dotnet', '.NET (Mono / Blazor)', [
    ...I.filter((n) => /mono_wasm_|mono_|dotnet/.test(n)).slice(0, 3),
    ...S.filter((s) => /System\.Private\.CoreLib|mono_wasm/.test(s)).slice(0, 2).map((s) => snippet(s, 60)),
  ], (n) => 0.5 + 0.2 * n);
  if (!out.some((o) => ['emscripten', 'rust', 'go', 'tinygo'].includes(o.id))) {
    add('clang', 'C/C++ (clang / wasi-sdk)', [
      ...prodOf(/^clang|^C\d*$|^C\+\+/i),
      ...(I.some((n) => n.startsWith('wasi_snapshot_preview1.')) ? [I.find((n) => n.startsWith('wasi_snapshot_preview1.'))] : []),
    ], (n) => 0.35 + 0.15 * n);
  }
  return out.sort((a, b) => b.confidence - a.confidence);
}

const TECH = {
  cff: t('Kontrol akışı düzleştirme (br_table dağıtıcısı)', 'Control-flow flattening (br_table dispatcher)'),
  opaque: t('Opak koşullar', 'Opaque predicates'),
  consts: t('Sabit kodlama', 'Constant encoding'),
  dead: t('Ölü kod eklenmesi', 'Dead code insertion'),
  split: t('Fonksiyon bölme', 'Function splitting'),
  data: t('Şifreli veri bölümleri (başlangıçta çözülüyor)', 'Encrypted data segments (decrypted at start)'),
  interp: t('Bayt kodu yorumlayıcı döngüsü', 'Bytecode interpreter loop'),
  stripped: t('Ad bölümü silinmiş', 'Name section stripped'),
};

/** Gizleme teknikleri: dönüşüm istatistikleri ve girdinin statik olguları */
export function techniques(facts, stats = {}, notes = {}, lang) {
  const out = [];
  const add = (id, confidence, evidence) => out.push({ id, name: pick(TECH[id], lang), kind: 'technique', confidence, evidence });
  const L = (tr, en) => pick(t(tr, en), lang);
  if (stats.cff || facts?.dispatchers) add('cff', stats.cff ? 0.95 : 0.6, [stats.cff ? L(`${stats.cff} dağıtıcı döngüsü yapılandırılmış koda çevrildi`, `${stats.cff} dispatcher loop(s) restructured`) : L(`${facts.dispatchers} br_table dağıtıcı döngüsü (çözülemedi)`, `${facts.dispatchers} br_table dispatcher loop(s) (not decoded)`)]);
  if (stats.opaque) add('opaque', 0.95, [L(`${stats.opaque} koşul her girdi için sabit kanıtlandı ve kaldırıldı`, `${stats.opaque} condition(s) proven constant for every input and removed`)]);
  if (facts?.constOps >= 2 || stats.fold >= 20) add('consts', facts?.constOps >= 2 ? 0.75 : 0.5, [L(`${facts?.constOps ?? 0} sabit-sabit işlem (ör. i32.xor sabit sabit)`, `${facts?.constOps ?? 0} constant-constant operation(s) (e.g. i32.xor const const)`), ...(stats.fold ? [L(`${stats.fold} ifade katlandı`, `${stats.fold} expression(s) folded`)] : [])]);
  if (stats.deadFunctions >= 2 || stats.dead >= 30) add('dead', 0.6, [L(`${stats.deadFunctions ?? 0} kullanılmayan fonksiyon, ${stats.dead ?? 0} ölü ifade silindi`, `${stats.deadFunctions ?? 0} unused function(s), ${stats.dead ?? 0} dead expression(s) removed`)]);
  if (stats.inline) add('split', 0.8, [L(`${stats.inline} parça fonksiyon çağrıldığı yere geri yerleştirildi`, `${stats.inline} fragment function(s) inlined back`)]);
  if (stats.data) {
    const n = notes.data ?? {};
    add('data', 0.9, [L(`başlangıç fonksiyonu ${stats.data} bayt veriyi değiştirdi`, `the start function rewrote ${stats.data} byte(s) of data`), ...(n.inEntropy != null ? [L(`entropi ${n.inEntropy} → ${n.outEntropy} bit/bayt`, `entropy ${n.inEntropy} → ${n.outEntropy} bits/byte`)] : [])]);
  }
  if (facts?.interpLoops) add('interp', 0.4, [L(`${facts.interpLoops} döngü, bellekten okunan işlem koduyla ${facts.maxTable}+ hedefli br_table'a dallanıyor (meşru bir yorumlayıcı da olabilir)`, `${facts.interpLoops} loop(s) dispatch on an opcode read from memory into a ${facts.maxTable}+ target br_table (may be a legitimate interpreter)`)]);
  if (facts && !facts.names && out.length && !facts.producers) add('stripped', 0.3, [L('ad ve producers bölümü yok', 'no name or producers section')]);
  return out;
}

/** Paketleyiciler: JS yükleyici, gömülü modüller */
export function packers(input, facts, loads, lang) {
  const out = [];
  const L = (tr, en) => pick(t(tr, en), lang);
  if (input?.kind === 'js-loader' || input?.kind === 'base64') {
    out.push({ id: 'js-loader', name: L('JS yükleyici (gömülü wasm)', 'JS loader (embedded wasm)'), kind: 'packer', confidence: 0.95,
      evidence: input.layers.map((l) => `${l.kind}: ${l.size} B${l.at != null ? ` @${l.at}` : ''}`) });
  }
  const nested = [...(facts?.embedded ?? []).map((e) => L(`veri bölümünde ${e.size} B modül @${e.at}`, `${e.size} B module in data @${e.at}`)),
    ...(loads ?? []).map((l) => L(`${l.api} çağrısına ${l.size} B modül verildi`, `${l.size} B module passed to ${l.api}`))];
  if (nested.length) out.push({ id: 'embedded', name: L('Gömülü wasm modülü (iç katman)', 'Embedded wasm module (inner layer)'), kind: 'packer', confidence: 0.9, evidence: nested.slice(0, 6) });
  return out;
}

/** VM tabanlı koruma: yorumlayıcı döngüsü + gizleme birlikteyse yalnızca tanınır, çözülmez */
export function protection(facts, techs, lang) {
  if (!facts?.interpLoops) return null;
  const obf = techs.filter((x) => ['cff', 'opaque', 'consts', 'data'].includes(x.id));
  if (!obf.length) return null;
  return {
    product: pick(t('Sanal makine tabanlı koruma (bayt kodu yorumlayıcısı)', 'VM-based protection (bytecode interpreter)'), lang),
    version: null,
    decodable: false,
    notes: [
      pick(t('Korunan mantık, modülün kendi sanal makinesinde çalışan bayt kodudur; bu bayt kodu wasm\'a geri çevrilmez.', 'The protected logic is bytecode for the module\'s own virtual machine; that bytecode is not translated back to wasm.'), lang),
      pick(t(`Eşlik eden gizleme: ${obf.map((x) => x.name).join(', ')}`, `Accompanying obfuscation: ${obf.map((x) => x.name).join(', ')}`), lang),
    ],
  };
}
