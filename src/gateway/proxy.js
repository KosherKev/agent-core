import { priceKey } from './prices.js';

const MAX_BODY = 8 * 1024 * 1024;

/**
 * Read a response body without ever holding more than `maxBytes`: chunks are counted as they arrive, and at the limit the stream is
 * cancelled and null is returned. A response without a readable stream is read whole and then measured (only a test double does that).
 */
async function readCapped(res, maxBytes) {
  const reader = res.body?.getReader?.();
  if (!reader) { const t = await res.text(); return Buffer.byteLength(t) > maxBytes ? null : t; }
  const chunks = []; let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) { try { await reader.cancel(); } catch { /* already closed */ } return null; }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export class ProxyError extends Error {
  constructor(code, message) { super(message); this.name = 'ProxyError'; this.code = code; }
}

/**
 * Make one provider request on behalf of a run. The key comes from the gateway's own credential store and is used only in the
 * Authorization header of this one request; it is never returned, logged or put in an error.
 * Returns { json, status, networkError }: json is the parsed body (or null), status the HTTP status (0 on a network error).
 */
export async function callProvider({ config, credentials, provider, model, messages, maxTokens, send = globalThis.fetch, timeoutMs = 120_000, maxBytes = MAX_BODY }) {
  const p = config.providers[provider];
  if (!p) throw new ProxyError('provider', 'unknown provider; refusing');
  const key = credentials.get(provider);
  if (!key) throw new ProxyError('credential', 'no credential for this provider; refusing');
  const body = { model, messages, max_tokens: maxTokens, usage: { include: true } };
  let res; let text;
  try {
    res = await send(`${p.base_url}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
    const declared = Number(res.headers?.get?.('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) { try { await res.body?.cancel?.(); } catch { /* already closed */ } return { json: null, status: res.status, networkError: true, tooLarge: true }; }
    text = await readCapped(res, maxBytes);
  } catch { return { json: null, status: 0, networkError: true }; }
  if (text === null) return { json: null, status: res.status, networkError: true, tooLarge: true };
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON body */ }
  return { json, status: res.status, ok: res.ok, networkError: false, text: json === null ? text.slice(0, 200) : undefined };
}

export { priceKey };
