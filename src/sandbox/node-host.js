// Node (CLI ve testler) için bekçili sandbox: hedef wasm ayrı, yalıtılmış bir alt süreçte çalışır (node --permission;
// yalnızca sandbox dizinini okuma izni; ağ, alt süreç, worker, dosya yazma kapalı). Kilitlenen süreç bekçi
// tarafından öldürülüp yeniden başlatılır.
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { sandboxApi } from './api.js';
import { createWatchdog } from './watchdog.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PROC = path.join(here, 'node-proc.js');

export function createNodeSandbox() {
  const dog = createWatchdog({
    spawn() {
      const child = fork(PROC, [], {
        execArgv: ['--permission', `--allow-fs-read=${here}${path.sep}*`, '--max-old-space-size=1024'],
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        serialization: 'advanced',
      });
      let onErr = () => {};
      let stderr = '';
      child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000); });
      child.on('error', (e) => onErr(e?.message ?? String(e)));
      child.on('exit', (code) => { if (code !== 0 && code !== null) onErr(`sandbox süreci çıktı (${code}): ${stderr.trim().split('\n').pop() ?? ''}`); });
      return {
        post: (m) => child.send(m),
        onMessage: (cb) => child.on('message', (m) => { if (!m?.ready) cb(m); }),
        onError: (cb) => { onErr = cb; },
        terminate: () => { onErr = () => {}; child.kill(); },
        ref: () => { child.ref(); child.channel?.ref(); },
        unref: () => { child.unref(); child.channel?.unref(); },
      };
    },
  });
  return { ...sandboxApi(dog.send), kill: (reason) => dog.kill(reason), close: () => dog.terminate() };
}
