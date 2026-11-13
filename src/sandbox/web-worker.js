// Web Worker tarafı: hedef wasm bu worker'da sahte import'larla örneklenir (engine.js). Sonsuz döngüde ana
// thread'deki bekçi worker'ı sonlandırır.
//
// Yalıtım worker düzeyindedir:
//  1. CSP: worker betiğinin yanıt başlığı (dev/preview: vite.config.js ara katmanı, üretim: public/_headers)
//     default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'
//  2. JS kilidi: ilk iletiden önce ağ API'leri, eval/Function kurucuları, dizge zamanlayıcıları ve iç içe worker
//     kaldırılır. Worker hiçbir dosya indirmez; hedef modülün baytları iletiyle gelir. Başlık veremeyen barındırmada
//     tek katman budur; durum ana thread'e 'env' iletisiyle bildirilir.
import { runModule } from './engine.js';

// CSP sınaması: bu betiğin kendi yanıtı yeniden (aynı köken) okunur ve başlıkta connect-src 'self' aranır
const cspProbe = fetch(self.location.href, { method: 'HEAD', cache: 'no-store' })
  .then((r) => /(^|;)\s*connect-src 'self'\s*(;|$)/.test(r.headers.get('content-security-policy') ?? ''), () => false);

// Kaldırılan genel adlar: ağ, kod üretme, iç içe worker, kalıcı depolama
const BLOCKED = [
  'fetch', 'fetchLater', 'XMLHttpRequest', 'WebSocket', 'WebSocketStream', 'EventSource', 'WebTransport',
  'importScripts', 'Worker', 'SharedWorker', 'caches', 'BroadcastChannel', 'indexedDB',
];
const denied = () => { throw new EvalError('Peel sandbox: kod üretimi kapalı'); };

function lockdown() {
  const ctorProtos = [
    Function.prototype,
    Object.getPrototypeOf(async function () {}),
    Object.getPrototypeOf(function* () {}),
    Object.getPrototypeOf(async function* () {}),
  ];
  for (const name of BLOCKED) {
    for (let o = self; o; o = Object.getPrototypeOf(o)) {
      if (Object.prototype.hasOwnProperty.call(o, name)) {
        Object.defineProperty(o, name, { value: undefined, writable: false, configurable: false });
      }
    }
  }
  const BlockedFunction = function Function() { denied(); };
  BlockedFunction.prototype = Function.prototype;
  const freeze = (o, k, value) => Object.defineProperty(o, k, { value, writable: false, configurable: false });
  freeze(self, 'eval', denied);
  freeze(self, 'Function', BlockedFunction);
  for (const proto of ctorProtos) freeze(proto, 'constructor', BlockedFunction);
  for (const name of ['setTimeout', 'setInterval']) {
    const real = self[name];
    Object.defineProperty(self, name, {
      value: (fn, ...rest) => (typeof fn === 'function' ? real(fn, ...rest) : 0),
      writable: false,
      configurable: false,
    });
  }
}

let ready = null;
const init = () => (ready ??= cspProbe.then((csp) => {
  lockdown();
  self.postMessage({ type: 'env', csp, locked: true });
}));

self.addEventListener('message', async ({ data }) => {
  const { id, ...msg } = data ?? {};
  await init();
  let result;
  try {
    result = msg.type === 'run' ? runModule(msg) : { ok: false, error: `bilinmeyen istek: ${msg.type}` };
  } catch (err) {
    result = { ok: false, error: String(err?.message ?? err).split('\n').filter(Boolean).slice(-3).join(' | ') };
  }
  // bellek görüntüsü kopyalanmadan aktarılır
  self.postMessage({ id, ...result }, result.memory ? [result.memory.buffer] : []);
});
