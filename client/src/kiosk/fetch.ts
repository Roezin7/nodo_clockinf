export const KIOSK_TIMEOUT_MS = {
  ingest: 4_000,
  self: 5_000,
  heartbeat: 5_000,
  enrollment: 10_000,
  sync: 15_000,
  photo: 15_000,
} as const;

export class KioskFetchTimeoutError extends Error {
  constructor(public timeoutMs: number) {
    super(`La solicitud del kiosco excedió ${timeoutMs} ms`);
    this.name = 'KioskFetchTimeoutError';
  }
}

/** Fetch acotado: una conexión colgada se convierte en estado offline recuperable. */
export async function kioskFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  let timedOut = false;
  const externalSignal = init.signal;
  const forwardAbort = () => controller.abort(externalSignal?.reason);
  if (externalSignal?.aborted) forwardAbort();
  else externalSignal?.addEventListener('abort', forwardAbort, { once: true });

  let response: Response | null = null;
  let timer = 0;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
      // Un mock/polyfill puede no enlazar AbortSignal con su body. El race
      // garantiza el deadline; cancel es limpieza best-effort si no está locked.
      void response?.body?.cancel().catch(() => {});
      reject(new KioskFetchTimeoutError(timeoutMs));
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      (async () => {
        response = await fetch(input, { ...init, signal: controller.signal });
        // fetch() resuelve al recibir headers; consumir el body aquí mantiene
        // el mismo deadline frente a JSON que se queda a medias.
        const body = await response.arrayBuffer();
        const bodyAllowed = ![204, 205, 304].includes(response.status);
        return new Response(bodyAllowed ? body : null, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      })(),
      deadline,
    ]);
  } catch (error) {
    if (error instanceof KioskFetchTimeoutError) throw error;
    if (timedOut) throw new KioskFetchTimeoutError(timeoutMs);
    throw error;
  } finally {
    window.clearTimeout(timer);
    externalSignal?.removeEventListener('abort', forwardAbort);
  }
}
