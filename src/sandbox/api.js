// Bekçili sandbox'a istemci API'si (Node ve tarayıcı ortak).
export const RUN_TIMEOUT_MS = 10_000;

export function sandboxApi(send) {
  return {
    /**
     * @param {{ wasm: Uint8Array, imports: object[], calls: object[], fuel?: number, dumpMemory?: boolean, timeoutMs?: number }} req
     */
    async run({ timeoutMs = RUN_TIMEOUT_MS, ...req }) {
      const r = await send({ type: 'run', ...req, deadlineMs: timeoutMs });
      return r;
    },
    /** Yalıtım öz-denetimi (Node alt süreci: izin modeli durumu) */
    selftest: () => send({ type: 'selftest', deadlineMs: RUN_TIMEOUT_MS }),
  };
}
