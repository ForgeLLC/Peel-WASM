// Analiz raporu. Arayüz, CLI ve kütüphane bu biçimi kullanır; alanlar eklenebilir, var olanlar değişmez.
//
// Report = {
//   detection:  [{ id, name, kind: 'toolchain'|'technique'|'packer'|'malware', confidence (0-1), evidence: string[] }]
//   protection: null | { product, version, decodable: false, notes: string[] }   VM tabanlı koruma: yalnızca tanınır
//   threat:     { score (0-100), level: 'none'|'low'|'medium'|'high'|'critical', classes: [{ id, title, weight, evidence }] }
//   behaviour:  { network: [{ api, target }], commands: [{ api, command }], files: [{ api, path }], other: [{ api, args }],
//                 loads: number, stdout: string, calls: [{ export, result }] }
//               sandbox'ta GERÇEKTEN çağrılan import'lar ve argümanları (sahte import'lar; hiçbiri gerçek işlem yapmadı)
//   iocs:       { urls, domains, ips, emails, discordWebhooks, telegram, downloads, pools, wallets, benign: string[] }
//   metrics:    { inputKind, inBytes, outBytes, functionsIn, functionsOut, exprsIn, exprsOut, layers, rounds, rollbacks,
//                 toolchain, verified }
//   layers:     [{ kind, size, at? }]   JS yükleyiciden / veriden / çalışma anından çıkarılan modüller
//   summary:    string
//   lang:       'tr'|'en'
// }
import { miner, toolchains, techniques, packers, protection as findProtection } from '../report/detect.js';
import { threat as assessThreat } from '../report/threat.js';
import { iocs as findIocs } from '../report/iocs.js';
import { summarize } from '../report/summary.js';

const NET = /(?:fetch|xhr|http|socket|websocket|ws_|send|connect|request|url|open_?url|navigator\.sendBeacon)/i;
const CMD = /(?:eval|run_?script|exec|system|spawn|popen|Function)/i;
const FILE = /^wasi_snapshot_preview1\.(?:path_|fd_(?:read|pread|pwrite|seek|readdir|filestat|prestat))|(?:fopen|open_?file|read_?file|write_?file|unlink|remove)/i;
const URLISH = /\b(?:https?|wss?|stratum\+(?:tcp|ssl)):\/\//i;

/** Sandbox kaydı (fx: [api, args, dizgeler]) → davranış grupları */
export function behaviourOf(run) {
  const b = { network: [], commands: [], files: [], other: [], loads: run?.loads?.length ?? 0, stdout: run?.stdout ?? '', calls: (run?.calls ?? []).map((c) => ({ export: c.export, result: c.result })) };
  for (const [api, args = [], strs = []] of run?.fx ?? []) {
    if (api === 'wasi_snapshot_preview1.fd_write' || api.startsWith('__peel.')) continue;
    const url = strs.find((s) => URLISH.test(s));
    const first = strs[0] ?? args.join(', ');
    if (NET.test(api) || url) b.network.push({ api, target: url ?? first });
    else if (CMD.test(api)) b.commands.push({ api, command: first });
    else if (FILE.test(api)) b.files.push({ api, path: first });
    else b.other.push({ api, args: [...args, ...strs.map((s) => JSON.stringify(s))] });
  }
  return b;
}

/**
 * @param {{ input, facts: { in, out }, trace?, events?, stats?, notes?, verified?, lang? }} o
 */
export function analyze({ input = null, facts = {}, trace = {}, events = [], stats = {}, notes = {}, verified = false, lang = 'tr' }) {
  lang = lang === 'en' ? 'en' : 'tr';
  const fin = facts.in ?? null;
  const fout = facts.out ?? fin;
  const run = trace?.first?.ok ? trace.first : null;
  const behaviour = behaviourOf(run);
  const tc = toolchains(fin, lang);
  const tech = techniques(fin, stats, notes, lang);
  const pk = packers(input, fin, run?.loads, lang);
  const mn = miner(fin, lang);
  const detection = [...(mn ? [mn] : []), ...pk, ...tech, ...tc];
  const texts = [
    ...(fin?.strings ?? []),
    ...(fout?.strings ?? []),
    input?.text && input.kind === 'js-loader' ? input.text : '',
    ...(run?.fx ?? []).flatMap(([, , strs = []]) => strs),
    behaviour.stdout,
  ];
  const iocs = findIocs(texts, behaviour.network.map((n) => n.target));
  const report = {
    detection,
    protection: findProtection(fin, tech, lang),
    threat: assessThreat({ facts: fin, loaderText: input?.kind === 'js-loader' ? input.text : null, behaviour, iocs, detection }, lang),
    behaviour,
    iocs,
    metrics: {
      inputKind: input?.kind ?? 'wasm',
      inBytes: fin?.size ?? 0,
      outBytes: fout?.size ?? 0,
      functionsIn: fin?.funcs ?? 0,
      functionsOut: fout?.funcs ?? 0,
      exprsIn: fin?.exprs ?? 0,
      exprsOut: fout?.exprs ?? 0,
      layers: (input?.layers?.length ?? 0) + (fin?.embedded?.length ?? 0) + (run?.loads?.length ?? 0),
      rounds: Math.max(0, ...events.map((e) => e.round ?? 0)),
      rollbacks: events.filter((e) => e.state === 'fail').length,
      toolchain: tc[0]?.name ?? null,
      verified: Boolean(verified),
    },
    layers: [
      ...(input?.layers ?? []).map((l) => ({ kind: l.kind, size: l.size, at: l.at })),
      ...(fin?.embedded ?? []).map((e) => ({ kind: 'data', size: e.size, at: e.at })),
      ...(run?.loads ?? []).map((l) => ({ kind: `runtime:${l.api}`, size: l.size })),
    ],
    lang,
    summary: '',
  };
  report.summary = summarize(report, lang);
  return report;
}
