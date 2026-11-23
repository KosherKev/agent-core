const KEY_SHAPE = /sk-or-[A-Za-z0-9_-]{8,}/g;
const BEARER = /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;

/** Build a string redactor that removes the exact secret and common key shapes. */
export function makeRedactor(secret) {
  return (text) => {
    let s = String(text);
    if (secret && secret.length >= 4) s = s.split(secret).join('[REDACTED]');
    return s.replace(KEY_SHAPE, '[REDACTED]').replace(BEARER, 'Bearer [REDACTED]');
  };
}

/** Return a fresh Error whose message and stack have the secret removed. */
export function redactError(err, redact) {
  const e = new Error(redact(err && err.message ? err.message : String(err)));
  e.name = err && err.name ? err.name : 'Error';
  e.stack = redact(err && err.stack ? err.stack : `${e.name}: ${e.message}`);
  return e;
}
