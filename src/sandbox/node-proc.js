// Yalıtılmış alt süreç: node --permission ile başlatılır (ağ, alt süreç, worker, dosya yazma kapalı; okuma
// yalnızca sandbox dizini). Hedef wasm burada yalnızca sahte import'larla örneklenir (engine.js).
import path from 'node:path';
import { runModule } from './engine.js';

process.on('message', ({ id, ...msg }) => {
  let result;
  try {
    if (msg.type === 'run') result = runModule(msg);
    // yalıtım öz-denetimi (testler): izin modelinin gerçekten etkin olduğu
    else if (msg.type === 'selftest') {
      const p = process.permission;
      result = { ok: true, permission: Boolean(p), fsReadRoot: p?.has('fs.read', path.parse(process.cwd()).root) ?? true, fsWrite: p?.has('fs.write') ?? true, child: p?.has('child') ?? true, worker: p?.has('worker') ?? true, net: p?.has('net') ?? true };
    } else result = { ok: false, error: `bilinmeyen istek: ${msg.type}` };
  } catch (err) {
    result = { ok: false, error: String(err?.message ?? err).split('\n').slice(0, 3).join(' | ') };
  }
  process.send({ id, ...result });
});
process.send({ ready: true });
