// Test helpers: a local D1 on node:sqlite, a Google key pair and ID tokens, Stripe signatures,
// a recording fetch mock, and a small client for the Worker's handle().

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHmac } from 'node:crypto';
import { handle } from '../src/index.js';
import { resetJwksCache, JWKS_URL } from '../src/google.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SERVER = path.resolve(HERE, '..');
export const REPO = path.resolve(SERVER, '..');

// ---------------------------------------------------------------- D1 on sqlite
let sqlite = null;
try { sqlite = await import('node:sqlite'); } catch (e) { sqlite = null; }
export const HAVE_SQLITE = !!sqlite;

class Stmt {
  constructor(db, sql, args) { this.db = db; this.sql = sql; this.args = args || []; }
  bind(...args) { return new Stmt(this.db, this.sql, args); }
  _prep() { return this.db.prepare(this.sql); }
  async first(col) {
    const row = this._prep().get(...this.args);
    if (!row) return null;
    const plain = Object.assign({}, row);
    return col ? plain[col] : plain;
  }
  async all() { return { success: true, results: this._prep().all(...this.args).map(r => Object.assign({}, r)), meta: {} }; }
  async run() { return this._runSync(); }
  _runSync() {
    const r = this._prep().run(...this.args);
    return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }
}
export class FakeD1 {
  constructor() {
    if (!sqlite) throw new Error('node:sqlite is not available in this Node version (needs Node 22.13+)');
    this.db = new sqlite.DatabaseSync(':memory:');
    this.db.exec('PRAGMA foreign_keys = ON');
    const dir = path.join(SERVER, 'migrations');
    for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) this.db.exec(fs.readFileSync(path.join(dir, f), 'utf8'));
  }
  prepare(sql) { return new Stmt(this.db, sql); }
  async batch(stmts) {
    // Like D1: one transaction, and nothing else runs in between (no await inside), so batches
    // started at the same moment by concurrent requests are serialized.
    this.db.exec('BEGIN');
    try { const out = []; for (const s of stmts) out.push(s._runSync()); this.db.exec('COMMIT'); return out; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  async exec(sql) { this.db.exec(sql); return { count: 1 }; }
  // test-only shortcuts
  get(sql, ...a) { const r = this.db.prepare(sql).get(...a); return r ? Object.assign({}, r) : null; }
  run(sql, ...a) { return this.db.prepare(sql).run(...a); }
}

// ---------------------------------------------------------------- base64url / JWT
export function b64url(buf) { return Buffer.from(buf).toString('base64url'); }

export async function makeGoogleKey(kid) {
  const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  return { kid, privateKey: pair.privateKey, jwk: { kty: 'RSA', n: jwk.n, e: jwk.e, kid, alg: 'RS256', use: 'sig' } };
}
export async function signJwt(key, claims, header) {
  const h = b64url(JSON.stringify(Object.assign({ alg: 'RS256', kid: key.kid, typ: 'JWT' }, header || {})));
  const p = b64url(JSON.stringify(claims));
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key.privateKey, new TextEncoder().encode(h + '.' + p));
  return h + '.' + p + '.' + b64url(new Uint8Array(sig));
}

// ---------------------------------------------------------------- Stripe signature
export function stripeSign(body, secret, t) {
  return 't=' + t + ',v1=' + createHmac('sha256', secret).update(t + '.' + body).digest('hex');
}

// ---------------------------------------------------------------- the app under test
export const ORIGIN = 'https://embroiderylabs.com';
export const CLIENT_ID = 'test-client.apps.googleusercontent.com';

export function baseEnv(db) {
  return {
    DB: db,
    GOOGLE_CLIENT_ID: CLIENT_ID,
    SESSION_SECRET: 'x'.repeat(48),
    STRIPE_SECRET_KEY: 'sk_test_123',
    STRIPE_WEBHOOK_SECRET: 'whsec_test_abc',
    STRIPE_PRICE_HOBBY: 'price_hobby',
    STRIPE_PRICE_PRO: 'price_pro',
    SITE_ORIGIN: ORIGIN + ',https://www.embroiderylabs.com',
    SITE_URL: ORIGIN,
  };
}

// Everything a test needs: db, env, a clock, a fetch mock with routes, Google keys, request helpers.
export async function makeApp(opts) {
  opts = opts || {};
  resetJwksCache();
  const db = new FakeD1();
  const env = Object.assign(baseEnv(db), opts.env || {});
  const clock = { t: opts.now || Date.UTC(2026, 0, 15, 12, 0, 0) };
  const google = await makeGoogleKey('k1');
  const calls = [];
  const routes = [];
  const fetchMock = async (input, init) => {
    const url = String(input && input.url ? input.url : input);
    calls.push({ url, init: init || {} });
    if (url === JWKS_URL) return new Response(JSON.stringify({ keys: app.jwks }), { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=20000' } });
    for (const r of routes) if (r.test(url, init || {})) return r.reply(url, init || {});
    return new Response(JSON.stringify({ error: { message: 'no mock for ' + url } }), { status: 404 });
  };
  const deps = { now: () => clock.t, fetch: fetchMock };
  const app = {
    db, env, clock, google, calls, routes, deps,
    jwks: [google.jwk],
    async request(method, p, o) {
      o = o || {};
      const headers = new Headers(o.headers || {});
      if (o.origin !== null) headers.set('Origin', o.origin || ORIGIN);
      if (o.cookie) headers.set('Cookie', o.cookie);
      let body;
      if (o.raw !== undefined) body = o.raw;
      else if (o.body !== undefined) { body = JSON.stringify(o.body); if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json'); }
      return handle(new Request('https://api.embroiderylabs.com' + p, { method, headers, body }), env, deps);
    },
    token(claims, key) {
      const now = Math.floor(clock.t / 1000);
      return signJwt(key || google, Object.assign({
        iss: 'https://accounts.google.com', aud: CLIENT_ID, sub: '1001', email: 'ann@example.com', email_verified: true,
        name: 'Ann Example', picture: 'https://lh3.googleusercontent.com/a/x', iat: now, exp: now + 3600,
      }, claims || {}));
    },
    // sign in, -> { cookie, body, res }
    async signIn(claims) {
      const res = await app.request('POST', '/api/auth/google', { body: { credential: await app.token(claims) } });
      const body = await res.json();
      const set = res.headers.get('Set-Cookie') || '';
      return { res, body, setCookie: set, cookie: set.split(';')[0] };
    },
    userId(sub) { const r = db.get('SELECT id FROM users WHERE google_sub = ?', sub || '1001'); return r && r.id; },
    async webhook(event, o) {
      o = o || {};
      const raw = JSON.stringify(event);
      const t = o.t != null ? o.t : Math.floor(clock.t / 1000);
      const sig = o.signature != null ? o.signature : stripeSign(raw, o.secret || env.STRIPE_WEBHOOK_SECRET, t);
      return app.request('POST', '/api/stripe/webhook', { origin: null, raw: o.rawBody != null ? o.rawBody : raw, headers: { 'Stripe-Signature': sig, 'Content-Type': 'application/json' } });
    },
  };
  return app;
}

// A subscription object as Stripe sends it (API 2024-06-20).
export function stripeSub(o) {
  return Object.assign({
    id: 'sub_1', object: 'subscription', customer: 'cus_1', status: 'active', cancel_at_period_end: false,
    current_period_end: 1800000000, metadata: {},
    items: { object: 'list', data: [{ id: 'si_1', price: { id: 'price_hobby' } }] },
  }, o || {});
}
