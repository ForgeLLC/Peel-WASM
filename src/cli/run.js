// peel-wasm komut satırı: tarayıcıdakiyle aynı motor; hedef modül Node'da izin modeliyle yalıtılmış alt süreçte,
// yalnızca sahte import'larla çalışır.
import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve, basename } from 'node:path';
import { peel, passes } from '../index.js';
import { createNodeSandbox } from '../sandbox/node-host.js';
import { reportText } from '../report/text.js';
import { parseArgs, UsageError } from './args.js';

export const EXIT = { OK: 0, ERROR: 1, USAGE: 2, THREAT: 4 };
export const MAX_INPUT = 64 * 1024 * 1024;
const LEVELS = ['none', 'low', 'medium', 'high', 'critical'];
const INPUT_FILE = /\.(?:wasm|wat|wast|js|mjs|cjs|html?|b64|txt)$/i;
const FORMATS = ['wasm', 'wat', 'c'];

const SPEC = {
  out: { alias: 'o', type: 'string' },
  wat: { type: 'string' },
  c: { type: 'string' },
  'out-dir': { alias: 'd', type: 'string' },
  format: { alias: 'f', type: 'string' },
  report: { alias: 'r', type: 'string' },
  json: { type: 'bool' },
  lang: { type: 'string' },
  only: { type: 'list' },
  'fail-on': { type: 'string' },
  quiet: { alias: 'q', type: 'bool' },
  help: { alias: 'h', type: 'bool' },
};

const HELP = {
  tr: `peel-wasm <dosya|dizin|-> [seçenekler]

WebAssembly modülünü (.wasm, .wat ya da wasm gömülü bir JS yükleyicisi) sandbox'ta yalnızca sahte import'larla
çalıştırarak gizlemeyi geri alır ve analiz raporu üretir. Her dönüşüm davranış karşılaştırmasıyla doğrulanır.

  -o, --out <dosya>        çözülmüş modülü yaz (biçim uzantıdan: .wasm | .wat | .c; tek girdi)
      --wat <dosya>        WAT metnini de yaz
      --c <dosya>          sözde C çıktısını da yaz
  -f, --format <biçim>     stdout ve -d için biçim: wat (varsayılan) | c | wasm
  -d, --out-dir <dizin>    çıktıları dizine yaz (<ad>.peeled.<biçim>; dizin girdisinde yapı korunur)
  -r, --report <hedef>     rapor: json | text (stdout'a, kod yazılmaz) ya da dosya yolu (.txt ise metin, değilse JSON;
                           dizin girdisinde JSON dizi)
      --json               --report json ile aynı
      --only <pass,...>    yalnızca bu geçişler (${passes().map((p) => p.id).join(', ')})
      --lang tr|en         rapor dili (varsayılan tr)
      --fail-on <düzey>    tehdit düzeyi bu eşiğe ulaşırsa çıkış kodu 4: low | medium | high | critical
  -q, --quiet              ilerleme ve özet yazma
  -h, --help               bu yardım

Çıkış kodları: 0 tamam, 1 hata, 2 kullanım hatası, 4 --fail-on eşiğine ulaşıldı (hatadan önceliklidir).
VM tabanlı korumalar (kendi bayt kodu yorumlayıcısı) tanınır ama çözülmez.`,
  en: `peel-wasm <file|dir|-> [options]

Undoes WebAssembly obfuscation (.wasm, .wat or a JS loader with embedded wasm) by running the module in a sandbox
with fake imports only, and produces an analysis report. Every transform is verified by comparing behaviour.

  -o, --out <file>         write the decoded module (format from the extension: .wasm | .wat | .c; single input)
      --wat <file>         also write the WAT text
      --c <file>           also write the pseudo-C output
  -f, --format <fmt>       format for stdout and -d: wat (default) | c | wasm
  -d, --out-dir <dir>      write outputs to a directory (<name>.peeled.<fmt>; directory input keeps its structure)
  -r, --report <target>    report: json | text (to stdout, no code) or a file path (.txt gives text, anything else JSON;
                           a JSON array for directory input)
      --json               same as --report json
      --only <pass,...>    run only these passes (${passes().map((p) => p.id).join(', ')})
      --lang tr|en         report language (default tr)
      --fail-on <level>    exit with code 4 when the threat level reaches: low | medium | high | critical
  -q, --quiet              no progress or summary output
  -h, --help               this help

Exit codes: 0 ok, 1 error, 2 usage error, 4 --fail-on threshold reached (takes precedence over errors).
VM-based protections (a custom bytecode interpreter) are identified but not decoded.`,
};

async function readBytes(path) {
  if (path === '-') {
    const chunks = [];
    let n = 0;
    for await (const c of process.stdin) {
      n += c.length;
      if (n > MAX_INPUT) throw new Error('Girdi çok büyük');
      chunks.push(c);
    }
    return new Uint8Array(Buffer.concat(chunks));
  }
  const s = await stat(path);
  if (!s.isFile()) throw new Error(`Dosya değil: ${path}`);
  if (s.size > MAX_INPUT) throw new Error(`Dosya çok büyük: ${path}`);
  return new Uint8Array(await readFile(path));
}

/** Dizindeki girdi dosyaları (özyinelemeli, sembolik bağlar izlenmez), sıralı */
async function listInputs(root) {
  const out = [];
  const walkDir = async (dir) => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules' && !e.name.startsWith('.')) await walkDir(p); } else if (e.isFile() && INPUT_FILE.test(e.name)) out.push(p);
    }
  };
  await walkDir(root);
  return out;
}

async function writeOut(path, data) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, data);
}

const formatOf = (path) => (/\.wasm$/i.test(path) ? 'wasm' : /\.c$/i.test(path) ? 'c' : 'wat');
const dataOf = (r, fmt) => (fmt === 'wasm' ? r.bytes : fmt === 'c' ? r.pseudo : r.text);
const levelOf = (entry) => entry.report?.threat?.level ?? 'none';
const textOf = (entries, isDir, lang) => entries.map((e) => `${isDir ? `== ${e.file} ==\n` : ''}${e.error ? `${lang === 'en' ? 'Error' : 'Hata'}: ${e.error}\n` : ''}${e.report ? reportText(e.report, lang) : ''}`).join('\n');

export async function runCli(argv) {
  const { opts, positional } = parseArgs(argv, SPEC);
  const lang = opts.lang === undefined ? 'tr' : opts.lang;
  if (lang !== 'tr' && lang !== 'en') throw new UsageError(`--lang tr ya da en olmalı: ${lang}`);
  if (opts.help) { console.log(HELP[lang]); return EXIT.OK; }
  if (positional.length !== 1) throw new UsageError(`${HELP[lang]}\n\nTek bir girdi gerekli (dosya, dizin ya da -).`);
  if (opts['fail-on'] !== undefined && !LEVELS.slice(1).includes(opts['fail-on'])) throw new UsageError('--fail-on şunlardan biri olmalı: low, medium, high, critical');
  const format = opts.format ?? 'wat';
  if (!FORMATS.includes(format)) throw new UsageError(`--format şunlardan biri olmalı: ${FORMATS.join(', ')}`);
  const ids = passes().map((p) => p.id);
  const only = opts.only.flatMap((x) => x.split(',')).map((x) => x.trim()).filter(Boolean);
  const unknown = only.filter((x) => !ids.includes(x));
  if (unknown.length) throw new UsageError(`Bilinmeyen geçiş: ${unknown.join(', ')} (geçerli: ${ids.join(', ')})`);
  const stdoutReport = opts.json ? 'json' : ['json', 'text'].includes(opts.report) ? opts.report : null;
  const reportFile = opts.report !== undefined && !['json', 'text'].includes(opts.report) ? opts.report : null;

  const target = positional[0];
  const isDir = target !== '-' && (await stat(target).catch(() => null))?.isDirectory();
  if (isDir && (opts.out || opts.wat || opts.c)) throw new UsageError('Dizin girdisinde -o/--wat/--c yerine -d kullanın');
  const log = (m) => { if (!opts.quiet) process.stderr.write(`${m}\n`); };
  const options = { lang, ...(only.length ? { only } : {}) };

  const sandbox = createNodeSandbox();
  const entries = [];
  try {
    const files = isDir ? await listInputs(target) : [target];
    if (isDir && !files.length) log(lang === 'en' ? 'No input files found.' : 'Girdi dosyası bulunamadı.');
    for (const file of files) {
      const name = file === '-' ? '-' : isDir ? relative(target, file).split('\\').join('/') : file;
      const entry = { file: name, ok: false };
      entries.push(entry);
      let bytes;
      try {
        bytes = await readBytes(file);
      } catch (e) {
        entry.error = e.message;
        log(`${name}: ${e.message}`);
        continue;
      }
      const r = await peel(bytes, { sandbox, ...options });
      Object.assign(entry, { ok: !r.error, error: r.error, verified: Boolean(r.verified), ms: r.ms ?? 0, stats: r.stats ?? {}, report: r.report });
      if (!r.error) {
        if (opts['out-dir']) {
          const rel = isDir ? relative(target, file) : file === '-' ? 'stdin' : basename(file);
          const dest = resolve(opts['out-dir'], `${rel.replace(/\.[^./\\]+$/, '')}.peeled.${format}`);
          if (relative(resolve(opts['out-dir']), dest).startsWith('..')) throw new Error(`Çıktı dizini dışına yazma: ${rel}`);
          await writeOut(dest, dataOf(r, format));
        }
        if (opts.out) await writeOut(opts.out, dataOf(r, formatOf(opts.out)));
        if (opts.wat) await writeOut(opts.wat, r.text);
        if (opts.c) await writeOut(opts.c, r.pseudo);
        if (!isDir && !opts.out && !opts['out-dir'] && !stdoutReport) {
          if (format === 'wasm' && process.stdout.isTTY) throw new UsageError('İkili wasm terminale yazılmaz: -o dosya.wasm kullanın');
          process.stdout.write(dataOf(r, format));
        }
      }
      const th = r.report.threat;
      log(`${isDir ? `${name}: ` : ''}[${th.level} ${th.score}/100]${r.error ? ` ${r.error};` : ''} ${r.report.summary}`);
    }
  } finally {
    sandbox.close();
  }

  const payload = isDir ? entries : entries[0];
  const json = `${JSON.stringify(payload, null, 2)}\n`;
  if (reportFile) await writeOut(reportFile, /\.txt$/i.test(reportFile) ? textOf(entries, isDir, lang) : json);
  if (stdoutReport === 'json') process.stdout.write(json);
  else if (stdoutReport === 'text') process.stdout.write(textOf(entries, isDir, lang));

  const failOn = opts['fail-on'];
  if (failOn && entries.some((e) => LEVELS.indexOf(levelOf(e)) >= LEVELS.indexOf(failOn))) return EXIT.THREAT;
  return entries.some((e) => !e.ok) ? EXIT.ERROR : EXIT.OK;
}
