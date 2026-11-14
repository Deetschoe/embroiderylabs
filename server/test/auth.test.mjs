// Google sign-in: token verification, the session cookie, /api/me, sign-out.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, makeGoogleKey, CLIENT_ID, HAVE_SQLITE } from './helpers.mjs';

const opts = { skip: !HAVE_SQLITE && 'node:sqlite is not available' };

test('a valid Google ID token signs in, creates the user and sets a safe session cookie', opts, async () => {
  const app = await makeApp();
  const { res, body, setCookie, cookie } = await app.signIn();
  assert.equal(res.status, 200);
  assert.equal(body.signedIn, true);
  assert.equal(body.user.email, 'ann@example.com');
  assert.equal(body.plan, 'free');
  assert.deepEqual([body.exports.used, body.exports.limit, body.exports.left], [0, 3, 3]);
  assert.match(setCookie, /^el_session=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+;/);
  for (const flag of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/']) assert.ok(setCookie.includes(flag), 'cookie has ' + flag);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'https://embroiderylabs.com');
  assert.equal(res.headers.get('Access-Control-Allow-Credentials'), 'true');

  const me = await (await app.request('GET', '/api/me', { cookie })).json();
  assert.equal(me.signedIn, true);
  assert.equal(me.user.name, 'Ann Example');
  assert.equal(me.googleClientId, CLIENT_ID);

  // the second sign-in finds the same user and updates the name
  await app.signIn({ name: 'Ann B' });
  assert.equal(app.db.get('SELECT COUNT(*) AS n FROM users').n, 1);
  assert.equal(app.db.get('SELECT name FROM users').name, 'Ann B');
});

test('wrong audience, wrong issuer, expired and badly signed tokens are refused', opts, async () => {
  const app = await makeApp();
  const post = async credential => app.request('POST', '/api/auth/google', { body: { credential } });

  let r = await post(await app.token({ aud: 'someone-else.apps.googleusercontent.com' }));
  assert.equal(r.status, 401, 'wrong aud');
  r = await post(await app.token({ iss: 'https://evil.example.com' }));
  assert.equal(r.status, 401, 'wrong iss');
  const now = Math.floor(app.clock.t / 1000);
  r = await post(await app.token({ iat: now - 7200, exp: now - 3600 }));
  assert.equal(r.status, 401, 'expired');
  assert.match((await r.json()).message, /expired/);

  // signed by another key that claims Google's key id
  const forger = await makeGoogleKey('k1');
  r = await post(await app.token({}, forger));
  assert.equal(r.status, 401, 'bad signature');

  // a valid token with one character of the payload changed
  const good = await app.token();
  const [h, p, s] = good.split('.');
  const claims = JSON.parse(Buffer.from(p, 'base64url'));
  claims.email = 'mallory@example.com';
  r = await post([h, Buffer.from(JSON.stringify(claims)).toString('base64url'), s].join('.'));
  assert.equal(r.status, 401, 'tampered payload');

  // alg none, garbage, missing
  r = await post([Buffer.from('{"alg":"none","kid":"k1"}').toString('base64url'), p, ''].join('.'));
  assert.equal(r.status, 401, 'alg none');
  r = await post('not-a-token');
  assert.equal(r.status, 401);
  r = await app.request('POST', '/api/auth/google', { body: {} });
  assert.equal(r.status, 401);

  r = await post(await app.token({ email_verified: false }));
  assert.equal(r.status, 403, 'unverified email');
  assert.equal(app.db.get('SELECT COUNT(*) AS n FROM users').n, 0, 'no user was created by any bad token');
});

test('Google keys are cached, and fetched again when an unknown key id shows up', opts, async () => {
  const app = await makeApp();
  await app.signIn(); await app.signIn();
  const jwksCalls = () => app.calls.filter(c => c.url.includes('oauth2/v3/certs')).length;
  assert.equal(jwksCalls(), 1, 'one fetch for two sign-ins');
  const k2 = await makeGoogleKey('k2');
  app.jwks = [app.google.jwk, k2.jwk];             // Google rotated in a new key
  const r = await app.request('POST', '/api/auth/google', { body: { credential: await app.token({}, k2) } });
  assert.equal(r.status, 200);
  assert.equal(jwksCalls(), 2);
});

test('the session cookie: forged, tampered and expired cookies count as signed out; sign-out clears it', opts, async () => {
  const app = await makeApp();
  const { cookie } = await app.signIn();
  const [name, value] = cookie.split('=');
  const [payload, sig] = value.split('.');

  const meWith = async c => (await app.request('GET', '/api/me', { cookie: c })).json();
  assert.equal((await meWith(cookie)).signedIn, true);
  const other = Buffer.from(JSON.stringify({ uid: 'someone', iat: 1, exp: 9999999999 })).toString('base64url');
  assert.equal((await meWith(name + '=' + other + '.' + sig)).signedIn, false, 'payload swapped');
  assert.equal((await meWith(name + '=' + payload + '.' + sig.slice(0, -2) + 'AA')).signedIn, false, 'signature changed');
  assert.equal((await meWith('el_session=garbage')).signedIn, false);

  app.clock.t += 31 * 86400 * 1000;
  assert.equal((await meWith(cookie)).signedIn, false, 'expired after 30 days');

  const out = await app.request('POST', '/api/auth/logout', { cookie });
  assert.match(out.headers.get('Set-Cookie'), /el_session=;.*Max-Age=0/);
});

test('state-changing requests need the site origin; CORS only answers the site', opts, async () => {
  const app = await makeApp();
  let r = await app.request('POST', '/api/auth/google', { origin: 'https://evil.example.com', body: { credential: await app.token() } });
  assert.equal(r.status, 403);
  assert.equal(r.headers.get('Access-Control-Allow-Origin'), null);
  r = await app.request('POST', '/api/auth/google', { origin: null, body: { credential: await app.token() } });
  assert.equal(r.status, 403, 'no Origin header');
  r = await app.request('OPTIONS', '/api/export', { headers: { 'Access-Control-Request-Method': 'POST' } });
  assert.equal(r.status, 204);
  assert.equal(r.headers.get('Access-Control-Allow-Origin'), 'https://embroiderylabs.com');
  r = await app.request('OPTIONS', '/api/export', { origin: 'https://evil.example.com' });
  assert.equal(r.status, 403);
  r = await app.request('GET', '/api/me', { origin: 'https://www.embroiderylabs.com' });
  assert.equal(r.headers.get('Access-Control-Allow-Origin'), 'https://www.embroiderylabs.com');
  // text/plain bodies (a "simple" cross-site form post) are refused
  r = await app.request('POST', '/api/auth/google', { raw: '{}', headers: { 'Content-Type': 'text/plain' } });
  assert.equal(r.status, 415);
});

test('a missing secret gives a clear 500, not a crash', opts, async () => {
  const app = await makeApp({ env: { SESSION_SECRET: 'short' } });
  const r = await app.request('POST', '/api/auth/google', { body: { credential: await app.token() } });
  assert.equal(r.status, 500);
  assert.equal((await r.json()).error, 'not_configured');
  const h = await (await app.request('GET', '/api/health')).json();
  assert.equal(h.sessions, false);
  assert.equal(h.google, true);
});
