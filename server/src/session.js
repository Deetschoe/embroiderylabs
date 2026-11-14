// Session cookie: base64url(JSON {uid, iat, exp}) + "." + base64url(HMAC-SHA256(SESSION_SECRET, payload)).
// Stateless: nothing is stored per session. Sign-out clears the cookie in that browser.

import { b64urlEncode, b64urlDecode, hmacSha256, parseCookies, safeEqual, utf8, HttpError } from './http.js';

export const COOKIE = 'el_session';
export const SESSION_DAYS = 30;

function secretOf(env) {
  const s = env.SESSION_SECRET;
  if (typeof s !== 'string' || s.length < 32) throw new HttpError(500, 'not_configured', 'The server is missing SESSION_SECRET (at least 32 characters).');
  return s;
}

export async function signSession(env, uid, nowMs) {
  const iat = Math.floor(nowMs / 1000);
  const payload = b64urlEncode(utf8(JSON.stringify({ uid, iat, exp: iat + SESSION_DAYS * 86400 })));
  const sig = b64urlEncode(await hmacSha256(secretOf(env), payload));
  return payload + '.' + sig;
}

// -> uid or null
export async function readSession(request, env, nowMs) {
  const raw = parseCookies(request)[COOKIE];
  if (!raw || raw.length > 1024) return null;
  const dot = raw.indexOf('.');
  if (dot < 1) return null;
  const payload = raw.slice(0, dot), sig = raw.slice(dot + 1);
  const want = b64urlEncode(await hmacSha256(secretOf(env), payload));
  if (!safeEqual(sig, want)) return null;
  let data;
  try { data = JSON.parse(new TextDecoder().decode(b64urlDecode(payload))); } catch (e) { return null; }
  if (!data || typeof data.uid !== 'string' || typeof data.exp !== 'number') return null;
  if (data.exp * 1000 <= nowMs) return null;
  return data.uid;
}

export function sessionCookie(value) {
  return COOKIE + '=' + value + '; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=' + SESSION_DAYS * 86400;
}
export function clearCookie() {
  return COOKIE + '=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0';
}
