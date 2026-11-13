// Tehdit analizi: statik olgular (import/export adları, veri dizgeleri, JS yükleyici metni) ve sandbox'ın kaydettiği
// import çağrıları aynı kurallardan geçer. Kod hangi biçimde gizlenmiş olursa olsun çalışma anında denenen çağrı
// kanıttır. Şüpheli dizgeler kaynakta parçalı yazılır (antivirüs imzalarına takılmasın).
import { pick, rx, snippet, t, WHERE } from './text.js';

export const CLASSES = {
  cryptojacking: t('Tarayıcıda kripto para madenciliği (cryptojacking)', 'In-browser cryptocurrency mining (cryptojacking)'),
  'dynamic-code': t('Dinamik kod çalıştırma (eval / betik çalıştırma)', 'Dynamic code execution (eval / run script)'),
  network: t('Ağ erişimi', 'Network access'),
  exfiltration: t('Veri sızdırma (Discord/Telegram)', 'Data exfiltration (Discord/Telegram)'),
  'embedded-module': t('Gömülü ikinci aşama modül yükleme', 'Embedded second-stage module loading'),
  'command-exec': t('Komut / süreç çalıştırma', 'Command / process execution'),
};

const EVAL = rx(['\\b(?:eval|emscripten_run_', 'script(?:_int|_string)?|new\\s+Function|Function\\s*\\(|execScript|setTimeout\\s*\\(\\s*["\'`])'], 'i');
const NET = /\b(?:fetch|XMLHttpRequest|WebSocket|websocket|xhr|http_?(?:get|post|request)|send_?request|socket|connect)\b/i;
const CMD = rx(['\\b(?:system|popen|exec[lv]?p?e?|spawn|child_', 'process|CreateProcess|ShellExecute|WinExec)\\b'], 'i');
const HOOK = rx(['discord(?:app)?\\.com/api/(?:v\\d+/)?', 'webhooks/'], 'i');
const TG = rx(['api\\.telegram\\.org/', 'bot'], 'i');
const URL_RE = /\b(?:https?|wss?):\/\/[^\s'"<>]+/i;

/**
 * @param {{ facts, loaderText, behaviour, iocs, detection }} o
 */
export function threat({ facts, loaderText, behaviour, iocs, detection }, lang = 'tr') {
  const findings = [];
  const W = (k) => pick(WHERE[k], lang);
  const add = (cls, weight, ev) => findings.push({ cls, weight, ev });

  const m = detection.find((d) => d.id === 'miner');
  if (m) add('cryptojacking', Math.round(60 + 30 * m.confidence), `${m.name}: ${m.evidence.slice(0, 3).join(' · ')}`);
  for (const p of (iocs.pools ?? []).slice(0, 3)) add('cryptojacking', 70, `stratum: ${snippet(p, 80)}`);
  for (const w of (iocs.wallets ?? []).slice(0, 2)) add('cryptojacking', 55, `Monero: ${snippet(w, 24)}`);

  const imports = (facts?.imports ?? []).map((i) => `${i.module}.${i.name}`);
  for (const n of imports) {
    if (EVAL.test(n)) add('dynamic-code', 35, `${W('imports')}: ${n}`);
    else if (CMD.test(n)) add('command-exec', 40, `${W('imports')}: ${n}`);
    else if (NET.test(n)) add('network', 20, `${W('imports')}: ${n}`);
  }
  if (loaderText) {
    const e = loaderText.match(EVAL);
    if (e) add('dynamic-code', 30, `${W('loader')}: ${snippet(e[0], 60)}`);
  }
  for (const s of (facts?.strings ?? []).slice(0, 4000)) {
    if (HOOK.test(s) || TG.test(s)) add('exfiltration', 50, `${W('data')}: ${snippet(s, 80)}`);
  }

  const bw = W('behaviour');
  for (const n of behaviour.network.slice(0, 4)) add('network', URL_RE.test(n.target) ? 45 : 25, `${bw}: ${n.api}(${snippet(n.target, 80)})`);
  for (const c of behaviour.commands.slice(0, 4)) add(EVAL.test(c.api) ? 'dynamic-code' : 'command-exec', 50, `${bw}: ${c.api}(${snippet(c.command, 80)})`);
  for (const n of behaviour.network) if (HOOK.test(n.target) || TG.test(n.target)) add('exfiltration', 60, `${bw}: ${n.api}(${snippet(n.target, 80)})`);
  if (behaviour.loads) add('embedded-module', 30, `${bw}: ${behaviour.loads}`);
  if (facts?.embedded?.length) add('embedded-module', 20, `${W('data')}: ${facts.embedded.map((e) => `${e.size} B`).join(', ')}`);

  const byClass = new Map();
  for (const f of findings) {
    const c = byClass.get(f.cls) ?? { id: f.cls, title: pick(CLASSES[f.cls], lang), weight: 0, evidence: [] };
    c.weight = Math.max(c.weight, f.weight);
    if (c.evidence.length < 6 && !c.evidence.includes(f.ev)) c.evidence.push(f.ev);
    byClass.set(f.cls, c);
  }
  const classes = [...byClass.values()].sort((a, b) => b.weight - a.weight);
  // en güçlü sınıf tam, diğerleri yarım ağırlıkla
  const score = Math.min(100, Math.round(classes.reduce((s, c, i) => s + (i === 0 ? c.weight : c.weight / 2), 0)));
  const level = score === 0 ? 'none' : score < 20 ? 'low' : score < 45 ? 'medium' : score < 70 ? 'high' : 'critical';
  return { score, level, classes };
}
