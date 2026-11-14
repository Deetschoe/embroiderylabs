// Small HTTP helpers: JSON replies, CORS for the site origin only, bodies read with a size cap.

export class HttpError extends Error {
  constructor(status, code, message, extra) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra || null;
  }
}

// The origins allowed to call the API with cookies: SITE_ORIGIN, comma separated.
export function allowedOrigins(env) {
  return String(env.SITE_ORIGIN || '')
    .split(',')
    .map(s => s.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}

export function originAllowed(request, env) {
  const origin = request.headers.get('Origin');
  return !!origin && allowedOrigins(env).includes(origin);
}

export function corsHeaders(request, env) {
  const h = new Headers();
  const origin = request.headers.get('Origin');
  if (origin && allowedOrigins(env).includes(origin)) {
    h.set('Access-Control-Allow-Origin', origin);
    h.set('Access-Control-Allow-Credentials', 'true');
    h.set('Access-Control-Expose-Headers', 'Content-Disposition, X-EL-Filename, X-EL-Stitches, X-EL-Exports-Left, X-EL-Plan');
  }
  h.set('Vary', 'Origin');
  return h;
}

export function preflight(request, env) {
  const h = corsHeaders(request, env);
  if (!h.has('Access-Control-Allow-Origin')) return new Response(null, { status: 403, headers: h });
  h.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  h.set('Access-Control-Allow-Headers', 'Content-Type');
  h.set('Access-Control-Max-Age', '600');
  return new Response(null, { status: 204, headers: h });
}

export function json(data, status, headers) {
  const h = new Headers(headers || {});
  h.set('Content-Type', 'application/json; charset=utf-8');
  h.set('Cache-Control', 'no-store');
  return new Response(JSON.stringify(data), { status: status || 200, headers: h });
}

export function errorResponse(err) {
  if (err instanceof HttpError) {
    return json(Object.assign({ error: err.code, message: err.message }, err.extra || {}), err.status);
  }
  return json({ error: 'server_error', message: 'Something went wrong on our side. Try again in a minute.' }, 500);
}

// Read the body as text, refusing anything over maxBytes (before and while reading).
export async function readText(request, maxBytes) {
  const declared = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new HttpError(413, 'too_large', 'That is too much data for one request.');
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch (e) { /* already closed */ }
      throw new HttpError(413, 'too_large', 'That is too much data for one request.');
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { all.set(c, at); at += c.byteLength; }
  return new TextDecoder().decode(all);
}

export async function readJson(request, maxBytes) {
  const type = request.headers.get('Content-Type') || '';
  if (!/^application\/json\b/i.test(type)) throw new HttpError(415, 'bad_type', 'Send JSON.');
  const text = await readText(request, maxBytes);
  try { return JSON.parse(text); } catch (e) { throw new HttpError(400, 'bad_json', 'The request is not valid JSON.'); }
}

export function parseCookies(request) {
  const out = {};
  const raw = request.headers.get('Cookie') || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k && !(k in out)) out[k] = part.slice(i + 1).trim();
  }
  return out;
}

// ---- base64url and bytes, shared by sessions, Google and Stripe code
export function b64urlEncode(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function b64urlDecode(str) {
  if (typeof str !== 'string' || !/^[A-Za-z0-9_-]*$/.test(str)) throw new Error('bad base64url');
  const pad = str.length % 4 === 2 ? '==' : str.length % 4 === 3 ? '=' : str.length % 4 === 1 ? null : '';
  if (pad === null) throw new Error('bad base64url');
  const bin = atob(str.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
export function utf8(s) { return new TextEncoder().encode(s); }
export function hex(bytes) { return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join(''); }
// Compare two strings without returning early on the first difference.
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
export async function hmacSha256(secret, message) {
  const key = await crypto.subtle.importKey('raw', utf8(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, utf8(message)));
}
export function randomId(bytes) {
  const b = new Uint8Array(bytes || 16);
  crypto.getRandomValues(b);
  return b64urlEncode(b);
}
