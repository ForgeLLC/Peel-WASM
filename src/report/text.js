// Rapor modüllerinin ortak yardımcıları: kanıt kesitleri, dil seçimi, düz metin rapor. Tarayıcıda da çalışır.

export const t = (tr, en = tr) => ({ tr, en });
export const pick = (o, lang) => (lang === 'en' ? o.en : o.tr);

/** Antivirüs imzalarına takılmasın diye şüpheli dizgeler kaynakta parçalı yazılır: rx(['crypto', 'night']) */
export const rx = (parts, flags = '') => new RegExp(parts.join(''), flags);

export const WHERE = {
  imports: t('import', 'import'),
  exports: t('export', 'export'),
  data: t('veri bölümü', 'data segment'),
  code: t('kod sabitleri', 'code constants'),
  custom: t('özel bölüm', 'custom section'),
  loader: t('JS yükleyici', 'JS loader'),
  output: t('çözülmüş modül', 'decoded module'),
  behaviour: t('davranış', 'behaviour'),
  passes: t('dönüşümler', 'transforms'),
};

/** Kanıt için tek satırlık, kısaltılmış kesit */
export function snippet(s, max = 120) {
  const one = String(s).replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

const LEVEL = {
  tr: { none: 'yok', low: 'düşük', medium: 'orta', high: 'yüksek', critical: 'kritik' },
  en: { none: 'none', low: 'low', medium: 'medium', high: 'high', critical: 'critical' },
};

/** CLI için okunabilir düz metin rapor */
export function reportText(r, lang = r?.lang ?? 'tr') {
  const en = lang === 'en';
  const L = (tr, e) => (en ? e : tr);
  const pct = (c) => (en ? `${Math.round(c * 100)}%` : `%${Math.round(c * 100)}`);
  const lines = [];
  lines.push(`${L('Özet', 'Summary')}: ${r.summary}`);
  lines.push(`${L('Tehdit', 'Threat')}: ${LEVEL[en ? 'en' : 'tr'][r.threat.level]} (${r.threat.score}/100)`);
  for (const c of r.threat.classes) {
    lines.push(`  - ${c.title}`);
    for (const e of c.evidence) lines.push(`      ${e}`);
  }
  if (r.protection) {
    const p = r.protection;
    lines.push(`${L('Koruma', 'Protection')}: ${p.product} (${L('çözülmez', 'not decoded')})`);
    for (const n of p.notes) lines.push(`  - ${n}`);
  }
  if (r.detection.length) {
    lines.push(`${L('Tespitler', 'Detections')}:`);
    for (const d of r.detection) {
      lines.push(`  - ${d.name}${d.version ? ` ${d.version}` : ''} [${d.kind}] ${pct(d.confidence)}`);
      for (const e of d.evidence) lines.push(`      ${e}`);
    }
  }
  const b = r.behaviour;
  const acts = [...b.network.map((n) => `${n.api}(${n.target})`), ...b.commands.map((c) => `${c.api}(${c.command})`), ...b.files.map((f) => `${f.api}(${f.path})`), ...b.other.map((o) => `${o.api}(${o.args.join(', ')})`)];
  if (acts.length) {
    lines.push(`${L('Sandbox davranışı (sahte import\'lar; hiçbiri gerçekten yapılmadı)', 'Sandbox behaviour (fake imports; nothing was actually performed)')}:`);
    for (const a of acts.slice(0, 40)) lines.push(`  - ${snippet(a, 160)}`);
  }
  if (b.stdout) lines.push(`${L('Konsol çıktısı', 'Console output')}: ${snippet(b.stdout, 300)}`);
  const io = r.iocs;
  const keys = ['urls', 'domains', 'ips', 'emails', 'discordWebhooks', 'telegram', 'downloads', 'pools', 'wallets', 'benign'];
  if (keys.some((k) => io[k]?.length)) {
    lines.push('IOC:');
    for (const k of keys) if (io[k]?.length) lines.push(`  ${k}: ${io[k].join(', ')}`);
  }
  const m = r.metrics;
  lines.push(`${L('Ölçüler', 'Metrics')}: ${m.inBytes} → ${m.outBytes} ${L('bayt', 'bytes')}, ${L('fonksiyon', 'functions')} ${m.functionsIn} → ${m.functionsOut}, ${L('ifade', 'expressions')} ${m.exprsIn} → ${m.exprsOut}, ${L('tur', 'rounds')} ${m.rounds}, ${L('geri alınan', 'rolled back')} ${m.rollbacks}${m.toolchain ? `, ${m.toolchain}` : ''}`);
  return `${lines.join('\n')}\n`;
}
