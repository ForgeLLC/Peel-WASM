// Raporun tek paragraflık özeti (tr | en); yalnızca bulunan bulgulara dayanır.

const LEVEL = {
  tr: { none: 'yok', low: 'düşük', medium: 'orta', high: 'yüksek', critical: 'kritik' },
  en: { none: 'none', low: 'low', medium: 'medium', high: 'high', critical: 'critical' },
};
const KIND = {
  tr: { wasm: 'wasm ikilisi', wat: 'WAT metni', 'js-loader': 'JS yükleyicisi', base64: 'base64 metin' },
  en: { wasm: 'wasm binary', wat: 'WAT text', 'js-loader': 'JS loader', base64: 'base64 text' },
};

const list = (xs, en) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} ${en ? 'and' : 've'} ${xs.at(-1)}`);

export function summarize(r, lang = 'tr') {
  const en = lang === 'en';
  const parts = [];
  const pct = (c) => (en ? `${Math.round(c * 100)}%` : `%${Math.round(c * 100)}`);
  const of = (kind) => r.detection.filter((d) => d.kind === kind);
  const m = r.metrics;

  const tc = of('toolchain');
  const kind = KIND[en ? 'en' : 'tr'][m.inputKind] ?? m.inputKind;
  parts.push(en
    ? `Input: ${kind}, ${m.functionsIn} function(s)${tc.length ? `, built with ${list(tc.slice(0, 2).map((d) => `${d.name} (${pct(d.confidence)})`), en)}` : ''}.`
    : `Girdi: ${kind}, ${m.functionsIn} fonksiyon${tc.length ? `; araç zinciri ${list(tc.slice(0, 2).map((d) => `${d.name} (${pct(d.confidence)})`), en)}` : ''}.`);
  if (r.protection) {
    parts.push(en
      ? `${r.protection.product} was detected; the protected bytecode is intentionally not decoded.`
      : `${r.protection.product} tespit edildi; korunan bayt kodu bilinçli olarak çözülmez.`);
  }
  if (of('packer').length) parts.push(en ? `Packing: ${list(of('packer').map((d) => d.name), en)}.` : `Paketleme: ${list(of('packer').map((d) => d.name), en)}.`);
  if (of('technique').length) parts.push(en ? `Techniques: ${list(of('technique').map((d) => d.name), en)}.` : `Kullanılan teknikler: ${list(of('technique').map((d) => d.name), en)}.`);
  if (m.exprsIn && m.exprsOut !== m.exprsIn) {
    parts.push(en
      ? `The module went from ${m.functionsIn} to ${m.functionsOut} function(s) and from ${m.exprsIn} to ${m.exprsOut} expression(s); every transform was verified against the original behaviour in the sandbox.`
      : `Modül ${m.functionsIn} fonksiyondan ${m.functionsOut} fonksiyona, ${m.exprsIn} ifadeden ${m.exprsOut} ifadeye indi; her dönüşüm sandbox'ta özgün davranışla karşılaştırılarak doğrulandı.`);
  }
  const th = r.threat;
  const lv = LEVEL[en ? 'en' : 'tr'][th.level];
  if (th.classes.length) {
    const cls = th.classes.slice(0, 5).map((c) => c.title);
    parts.push(en ? `Threat level ${lv} (${th.score}/100): ${list(cls, en)}.` : `Tehdit düzeyi ${lv} (${th.score}/100): ${list(cls, en)}.`);
  } else {
    parts.push(en ? 'No dangerous behaviour or miner signature was found (threat level none).' : 'Tehlikeli bir davranış ya da madenci imzası bulunmadı (tehdit düzeyi yok).');
  }
  const b = r.behaviour;
  const calls = b.network.length + b.commands.length + b.files.length + b.other.length;
  if (calls) {
    parts.push(en
      ? `In the sandbox the module made ${calls} import call(s) (${b.network.length} network, ${b.commands.length} code/command); all imports were fakes that only record.`
      : `Sandbox'ta modül ${calls} import çağrısı yaptı (${b.network.length} ağ, ${b.commands.length} kod/komut); tüm import'lar yalnızca kayıt tutan taklitlerdi.`);
  }
  const io = r.iocs;
  const counts = [
    [io.urls, 'URL', 'URL(s)'], [io.domains, 'alan adı', 'domain(s)'], [io.ips, 'IP', 'IP(s)'], [io.emails, 'e-posta', 'e-mail(s)'],
    [io.pools, 'madencilik havuzu', 'mining pool(s)'], [io.wallets, 'cüzdan', 'wallet(s)'],
    [io.discordWebhooks, 'Discord webhook', 'Discord webhook(s)'], [io.telegram, 'Telegram', 'Telegram'],
  ].filter(([xs]) => xs?.length).map(([xs, tr, e]) => `${xs.length} ${en ? e : tr}`);
  if (counts.length) parts.push(en ? `IOCs: ${list(counts, en)}.` : `IOC: ${list(counts, en)}.`);
  return parts.join(' ');
}
