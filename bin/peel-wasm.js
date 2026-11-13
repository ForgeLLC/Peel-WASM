#!/usr/bin/env node
// Peel-WASM komut satırı. Kullanım: peel-wasm <dosya|dizin|-> [-o çıktı.wasm] [--wat f] [--c f] [-d dizin] [-r json|text|rapor.json] (peel-wasm --help)
import { runCli, EXIT } from '../src/cli/run.js';
import { UsageError } from '../src/cli/args.js';

try {
  process.exitCode = await runCli(process.argv.slice(2));
} catch (e) {
  if (e instanceof UsageError) {
    console.error(e.message);
    process.exitCode = EXIT.USAGE;
  } else {
    console.error(`Hata: ${e.message}`);
    process.exitCode = EXIT.ERROR;
  }
}
