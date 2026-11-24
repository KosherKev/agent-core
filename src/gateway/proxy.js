import { priceKey } from './prices.js';

const MAX_BODY = 4 * 1024 * 1024;

export class ProxyError extends Error {
  constructor(code, message) { super(message); this.name = 'ProxyError'; this.code = code; }
}

/**
 * Make one provider request on behalf of a run. The key comes from the gateway's own credential store and is used only in the
 * Authorization header of this one request; it is never returned, logged or put in an error.
 * Returns { json, status, networkError }: json is the parsed body (or null), status the HTTP status (0 on a network error).
 */
export async function callProvider({ config, credentials, provider, model, messages, maxTokens, fetchFn = globalThis.fetch, timeoutMs = 120_000 }) {
  const p = config.providers[provider];
  if (!p) throw new ProxyError('provider', 'unknown provider; refusing');
  const key = credentials.get(provider);
  if (!key) throw new ProxyError('credential', 'no credential for this provider; refusing');
  const body = { model, messages, max_tokens: maxTokens, usage: { include: true } };
  let res; let text;
  try {
    res = await fetchFn(`${p.base_url}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
    text = await res.text();
  } catch { return { json: null, status: 0, networkError: true }; }
  if (text.length > MAX_BODY) return { json: null, status: res.status, networkError: true };
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON body */ }
  return { json, status: res.status, ok: res.ok, networkError: false, text: json === null ? text.slice(0, 200) : undefined };
}

export { priceKey };
