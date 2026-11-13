// Peel-WASM kütüphane API'si. Hedef modül yalnızca sahte import'larla, Node'da izin modeliyle yalıtılmış alt
// süreçte, tarayıcıda Web Worker'da çalıştırılır.
//   import { peel, deobfuscate, analyze } from 'peel-wasm';
//   const r = await peel(bytes);   // r.bytes (wasm), r.text (WAT), r.pseudo (sözde C), r.report
import { deobfuscate as runPipeline } from './core/pipeline.js';
import { analyze as runAnalyze } from './core/analyze.js';
import { PASSES } from './core/registry.js';

let shared = null;

export async function createSandbox() {
  if (typeof process !== 'undefined' && process.versions?.node) {
    const path = './sandbox/node-host.js';
    const { createNodeSandbox } = await import(/* @vite-ignore */ path);
    return createNodeSandbox();
  }
  const path = './sandbox/web-host.js';
  const { createWebSandbox } = await import(/* @vite-ignore */ path);
  return createWebSandbox();
}

async function sandboxOf(option) {
  if (option && typeof option === 'object') return option;
  shared ??= createSandbox();
  return shared;
}

/** Paylaşılan sandbox'ı kapatır (Node'da alt süreç; süreç sonlanabilsin diye) */
export async function close() {
  if (!shared) return;
  const s = await shared;
  shared = null;
  s.close?.();
}

/**
 * Girdi: .wasm baytları (Uint8Array), WAT metni ya da wasm gömülü JS yükleyici metni (string veya bayt).
 * Dönüş: { bytes, text, pseudo, stats, events, verified, input, trace, facts, ms } ya da { error }
 */
export async function deobfuscate(input, { sandbox, ...options } = {}) {
  return runPipeline(input, { ...options, sandbox: await sandboxOf(sandbox) });
}

/** deobfuscate + analiz raporu (report) */
export async function peel(input, { sandbox, lang = 'tr', ...options } = {}) {
  const r = await runPipeline(input, { ...options, sandbox: await sandboxOf(sandbox) }).catch((e) => ({ error: e.message }));
  if (r.error) return { ...r, report: runAnalyze({ input: r.input ?? null, lang }) };
  return { ...r, report: runAnalyze({ input: r.input, facts: r.facts, trace: r.trace, events: r.events, stats: r.stats, notes: r.notes, verified: r.verified, lang }) };
}

export const analyze = runAnalyze;
export const passes = () => PASSES.map(({ id }) => ({ id }));
