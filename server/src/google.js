// Verify a Google ID token (from Google Identity Services) without any SDK:
// RS256 signature against Google's published keys (JWKS), then iss, aud, exp, iat and email_verified.

import { b64urlDecode, utf8, HttpError } from './http.js';

export const JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const ISSUERS = ['accounts.google.com', 'https://accounts.google.com'];
const SKEW_S = 60;                 // clock difference we accept, seconds
const MAX_TOKEN = 4096;

let cache = { keys: null, until: 0 };
export function resetJwksCache() { cache = { keys: null, until: 0 }; }

async function loadKeys(fetchFn, nowMs, force) {
  if (!force && cache.keys && nowMs < cache.until) return cache.keys;
  const res = await fetchFn(JWKS_URL);
  if (!res.ok) throw new HttpError(502, 'google_unavailable', 'Could not reach Google to check the sign-in. Try again.');
  const body = await res.json();
  if (!body || !Array.isArray(body.keys)) throw new HttpError(502, 'google_unavailable', 'Google sent an unexpected answer. Try again.');
  const m = /max-age=(\d+)/.exec(res.headers.get('Cache-Control') || '');
  const ttl = Math.min(m ? Number(m[1]) : 3600, 86400) * 1000;
  cache = { keys: body.keys, until: nowMs + ttl };
  return cache.keys;
}

function fail(message) { return new HttpError(401, 'bad_token', message || 'The Google sign-in could not be checked. Try again.'); }

// -> { sub, email, name, picture }
export async function verifyGoogleIdToken(token, env, deps) {
  const clientId = env.GOOGLE_CLIENT_ID;
  if (!clientId) throw new HttpError(500, 'not_configured', 'The server is missing GOOGLE_CLIENT_ID.');
  if (typeof token !== 'string' || token.length > MAX_TOKEN) throw fail();
  const parts = token.split('.');
  if (parts.length !== 3) throw fail();
  let header, claims;
  try {
    header = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[0])));
    claims = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[1])));
  } catch (e) { throw fail(); }
  if (!header || header.alg !== 'RS256' || typeof header.kid !== 'string') throw fail();

  const nowMs = deps.now();
  let keys = await loadKeys(deps.fetch, nowMs, false);
  let jwk = keys.find(k => k.kid === header.kid);
  if (!jwk) { keys = await loadKeys(deps.fetch, nowMs, true); jwk = keys.find(k => k.kid === header.kid); }   // Google rotated its keys
  if (!jwk || jwk.kty !== 'RSA') throw fail();

  let ok = false;
  try {
    const key = await crypto.subtle.importKey('jwk', { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlDecode(parts[2]), utf8(parts[0] + '.' + parts[1]));
  } catch (e) { ok = false; }
  if (!ok) throw fail();

  const now = Math.floor(nowMs / 1000);
  if (!ISSUERS.includes(claims.iss)) throw fail();
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(clientId)) throw fail();
  if (typeof claims.exp !== 'number' || claims.exp + SKEW_S < now) throw fail('That sign-in has expired. Sign in again.');
  if (typeof claims.iat === 'number' && claims.iat - SKEW_S > now) throw fail();
  if (typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 255) throw fail();
  if (typeof claims.email !== 'string' || claims.email_verified !== true && claims.email_verified !== 'true') {
    throw new HttpError(403, 'email_unverified', 'Your Google account needs a verified email address.');
  }
  return {
    sub: claims.sub,
    email: claims.email.slice(0, 320),
    name: typeof claims.name === 'string' ? claims.name.slice(0, 200) : '',
    picture: typeof claims.picture === 'string' && /^https:\/\//.test(claims.picture) ? claims.picture.slice(0, 500) : '',
  };
}
