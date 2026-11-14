// EmbroideryLabs API: a Cloudflare Worker with a D1 database.
//
//   POST   /api/auth/google        { credential }        Google ID token -> session cookie
//   POST   /api/auth/logout                              clears the cookie
//   GET    /api/me                                       who is signed in, plan, exports used / left
//   POST   /api/export             { design, format }    the machine file, counted against the plan
//   POST   /api/billing/checkout   { plan }              Stripe Checkout URL (hobby | pro)
//   POST   /api/billing/portal                           Stripe customer portal URL
//   POST   /api/stripe/webhook                           Stripe events (signature checked)
//   GET    /api/projects                                 saved canvases (no data)
//   GET    /api/projects/:id                             one canvas with its data
//   PUT    /api/projects/:id       { name, data }        create or replace
//   DELETE /api/projects/:id
//   GET    /api/health                                   what is configured (no secrets)
//
// Secrets (wrangler secret put): GOOGLE_CLIENT_ID, SESSION_SECRET, STRIPE_SECRET_KEY,
// STRIPE_WEBHOOK_SECRET, STRIPE_PRICE_HOBBY, STRIPE_PRICE_PRO. Plain vars (wrangler.toml): SITE_ORIGIN, SITE_URL.

import { HttpError, json, errorResponse, preflight, corsHeaders, originAllowed, readJson, readText, randomId } from './http.js';
import { signSession, readSession, sessionCookie, clearCookie } from './session.js';
import { verifyGoogleIdToken } from './google.js';
import { PLANS, currentPlan, usage, reserveExport, finishExport, startAttempt, endAttempt } from './plans.js';
import { createCheckout, createPortal, verifyStripeSignature, handleEvent } from './stripe.js';
import { FORMAT_IDS, checkDesign, generate, exportFile } from './exporter.js';
import * as Projects from './projects.js';

export const LIMITS = {
  auth: 8 * 1024,
  small: 4 * 1024,
  export: 4 * 1024 * 1024,             // a traced picture can be a few hundred thousand points
  project: Projects.MAX_PROJECT_BYTES + 64 * 1024,
  webhook: 256 * 1024,
};

function db(env) {
  if (!env.DB) throw new HttpError(500, 'not_configured', 'The server has no database bound (DB).');
  return env.DB;
}

async function userFor(request, env, deps) {
  const uid = await readSession(request, env, deps.now());
  if (!uid) return null;
  return await db(env).prepare('SELECT id, email, name, picture, stripe_customer_id FROM users WHERE id = ?').bind(uid).first();
}
async function requireUser(request, env, deps) {
  const u = await userFor(request, env, deps);
  if (!u) throw new HttpError(401, 'signed_out', 'Sign in to do that.');
  return u;
}

async function account(env, user, nowMs) {
  const { plan, subscription } = await currentPlan(db(env), user.id);
  const u = await usage(db(env), user.id, plan, nowMs);
  return {
    user: { email: user.email, name: user.name, picture: user.picture },
    plan,
    planLabel: PLANS[plan].label,
    exports: u,
    billing: {
      customer: !!user.stripe_customer_id,
      status: subscription ? subscription.status : null,
      periodEnd: subscription ? subscription.current_period_end : null,
      cancelAtPeriodEnd: subscription ? !!subscription.cancel_at_period_end : false,
    },
  };
}

function plansInfo() {
  return Object.values(PLANS).map(p => ({ id: p.id, label: p.label, price: p.price, limit: p.limit, per: p.per }));
}

function quotaMessage(plan, u) {
  if (plan === 'free') return 'You have used your ' + PLANS.free.limit + ' free exports. Pick a plan to keep exporting.';
  const d = new Date(u.resetsAt);
  const when = d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' });
  return 'You have used this month\'s ' + PLANS[plan].limit + ' exports. They come back on ' + when + ', or go Pro for unlimited.';
}

// ---------------------------------------------------------------- handlers

async function authGoogle(request, env, deps) {
  const body = await readJson(request, LIMITS.auth);
  const g = await verifyGoogleIdToken(body && body.credential, env, deps);
  const now = deps.now();
  const D = db(env);
  await D.prepare(
    'INSERT INTO users (id, google_sub, email, name, picture, created_at, last_login_at) VALUES (?, ?, ?, ?, ?, ?, ?) ' +
    'ON CONFLICT(google_sub) DO UPDATE SET email = excluded.email, name = excluded.name, picture = excluded.picture, last_login_at = excluded.last_login_at'
  ).bind(randomId(16), g.sub, g.email, g.name, g.picture, now, now).run();
  const user = await D.prepare('SELECT id, email, name, picture, stripe_customer_id FROM users WHERE google_sub = ?').bind(g.sub).first();
  const cookie = await signSession(env, user.id, now);
  return json(Object.assign({ signedIn: true }, await account(env, user, now)), 200, { 'Set-Cookie': sessionCookie(cookie) });
}

async function me(request, env, deps) {
  const user = await userFor(request, env, deps);
  const base = { googleClientId: env.GOOGLE_CLIENT_ID || null, plans: plansInfo(), payments: !!(env.STRIPE_SECRET_KEY && env.STRIPE_PRICE_HOBBY && env.STRIPE_PRICE_PRO) };
  if (!user) return json(Object.assign({ signedIn: false }, base));
  return json(Object.assign({ signedIn: true }, base, await account(env, user, deps.now())));
}

async function doExport(request, env, deps) {
  const user = await requireUser(request, env, deps);
  const body = await readJson(request, LIMITS.export);
  const format = String(body && body.format != null ? body.format : 'pes').toLowerCase();
  if (!FORMAT_IDS.includes(format)) throw new HttpError(400, 'bad_format', 'Pick one of: ' + FORMAT_IDS.join(', ') + '.');
  const design = body && body.design;
  const why = checkDesign(design);
  if (why) throw new HttpError(400, 'bad_design', why);

  const D = db(env);
  const { plan } = await currentPlan(D, user.id);
  const before = await usage(D, user.id, plan, deps.now());
  if (before.left === 0) throw new HttpError(402, 'quota', quotaMessage(plan, before), { plan, used: before.used, limit: before.limit });

  const attempt = await startAttempt(D, user.id, plan, format, deps.now());
  if (attempt == null) throw new HttpError(429, 'slow_down', 'That is a lot of exports in a minute. Wait a moment and try again.');

  // The stitches first: a design the engine refuses does not use up an export.
  let result;
  try { result = generate(design); } catch (e) { await endAttempt(D, attempt, true); throw e; }
  if (!result.canExport) {
    await endAttempt(D, attempt, true);
    const e = (result.warnings || []).filter(w => w.severity === 'error')[0];
    throw new HttpError(422, 'cannot_export', e ? e.message : 'This design cannot be exported.');
  }
  const now = deps.now();
  const id = await reserveExport(D, user.id, plan, format, now);
  await endAttempt(D, attempt, false);
  if (id == null) {
    const u = await usage(D, user.id, plan, now);
    throw new HttpError(402, 'quota', quotaMessage(plan, u), { plan, used: u.used, limit: u.limit });
  }
  let file;
  try {
    file = exportFile(result, format, design.name);
    if (!file || !file.bytes || !file.bytes.length) throw new Error('empty file');
  } catch (e) {
    await finishExport(D, id, false, 0, 0);
    throw new HttpError(422, 'cannot_export', e && e.code && e.message ? e.message : 'The file could not be made. Your export was not counted.');
  }
  await finishExport(D, id, true, file.stitches, file.bytes.length);
  const after = await usage(D, user.id, plan, now);
  const h = new Headers();
  h.set('Content-Type', file.mime || 'application/octet-stream');
  h.set('Content-Disposition', 'attachment; filename="' + String(file.filename).replace(/[^\x20-\x7e]|"/g, '_') + '"; filename*=UTF-8\'\'' + encodeURIComponent(file.filename));
  h.set('X-EL-Filename', encodeURIComponent(file.filename));
  h.set('X-EL-Stitches', String(file.stitches));
  h.set('X-EL-Exports-Left', after.left === null ? 'unlimited' : String(after.left));
  h.set('X-EL-Plan', plan);
  h.set('Cache-Control', 'no-store');
  return new Response(file.bytes, { status: 200, headers: h });
}

async function checkout(request, env, deps) {
  const user = await requireUser(request, env, deps);
  const body = await readJson(request, LIMITS.small);
  const plan = body && body.plan;
  if (plan !== 'hobby' && plan !== 'pro') throw new HttpError(400, 'bad_plan', 'Pick Hobby or Pro.');
  const { plan: now } = await currentPlan(db(env), user.id);
  if (now === plan || now === 'pro') throw new HttpError(400, 'same_plan', 'You already have ' + PLANS[now].label + '.');
  // A paying customer changes plan in the portal, so they never end up with two subscriptions.
  if (now !== 'free') return json({ url: await createPortal(env, deps, user), portal: true });
  return json({ url: await createCheckout(env, deps, user, plan) });
}

async function portal(request, env, deps) {
  const user = await requireUser(request, env, deps);
  return json({ url: await createPortal(env, deps, user) });
}

async function webhook(request, env, deps) {
  const raw = await readText(request, LIMITS.webhook);
  const ok = await verifyStripeSignature(raw, request.headers.get('Stripe-Signature'), env.STRIPE_WEBHOOK_SECRET, deps.now());
  if (!ok) throw new HttpError(400, 'bad_signature', 'Signature check failed.');
  let event;
  try { event = JSON.parse(raw); } catch (e) { throw new HttpError(400, 'bad_json', 'Not JSON.'); }
  if (!event || typeof event.id !== 'string' || typeof event.type !== 'string') throw new HttpError(400, 'bad_event', 'Not an event.');
  const D = db(env);
  const seen = await D.prepare('SELECT id FROM stripe_events WHERE id = ?').bind(event.id).first();
  if (seen) return json({ received: true, duplicate: true });
  const note = await handleEvent(D, env, deps, event);       // throws -> 500 -> Stripe retries later
  await D.prepare('INSERT OR IGNORE INTO stripe_events (id, type, received_at) VALUES (?, ?, ?)').bind(event.id, event.type, deps.now()).run();
  return json({ received: true, note });
}

async function projects(request, env, deps, id) {
  const user = await requireUser(request, env, deps);
  const D = db(env);
  const m = request.method;
  if (!id) {
    if (m === 'GET') return json({ projects: await Projects.list(D, user.id), max: Projects.MAX_PROJECTS });
    throw new HttpError(405, 'method', 'Not allowed.');
  }
  if (m === 'GET') return json(await Projects.get(D, user.id, id));
  if (m === 'PUT') return json(await Projects.put(D, user.id, id, await readJson(request, LIMITS.project), deps.now()));
  if (m === 'DELETE') { await Projects.remove(D, user.id, id); return json({ deleted: true }); }
  throw new HttpError(405, 'method', 'Not allowed.');
}

function health(env) {
  return json({
    ok: true,
    database: !!env.DB,
    google: !!env.GOOGLE_CLIENT_ID,
    sessions: typeof env.SESSION_SECRET === 'string' && env.SESSION_SECRET.length >= 32,
    payments: !!(env.STRIPE_SECRET_KEY && env.STRIPE_PRICE_HOBBY && env.STRIPE_PRICE_PRO),
    webhook: !!env.STRIPE_WEBHOOK_SECRET,
    origins: String(env.SITE_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean),
  });
}

// ---------------------------------------------------------------- router

async function route(request, env, deps) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '');
  const m = request.method;
  if (path === '/api/health' && m === 'GET') return health(env);
  if (path === '/api/me' && m === 'GET') return me(request, env, deps);
  if (m !== 'GET' && !originAllowed(request, env)) throw new HttpError(403, 'bad_origin', 'Requests are only accepted from the EmbroideryLabs site.');
  if (path === '/api/auth/google' && m === 'POST') return authGoogle(request, env, deps);
  if (path === '/api/auth/logout' && m === 'POST') return json({ signedIn: false }, 200, { 'Set-Cookie': clearCookie() });
  if (path === '/api/export' && m === 'POST') return doExport(request, env, deps);
  if (path === '/api/billing/checkout' && m === 'POST') return checkout(request, env, deps);
  if (path === '/api/billing/portal' && m === 'POST') return portal(request, env, deps);
  if (path === '/api/projects') return projects(request, env, deps, null);
  const pm = /^\/api\/projects\/([^/]+)$/.exec(path);
  if (pm) {
    let id;
    try { id = decodeURIComponent(pm[1]); } catch (e) { throw new HttpError(400, 'bad_id', 'That is not a design id.'); }
    return projects(request, env, deps, id);
  }
  throw new HttpError(404, 'not_found', 'No such endpoint.');
}

export async function handle(request, env, deps) {
  deps = Object.assign({ now: () => Date.now(), fetch: (input, init) => fetch(input, init) }, deps || {});
  const path = new URL(request.url).pathname.replace(/\/+$/, '');
  // Stripe calls this one from its servers: no CORS, no cookie, the signature is the check.
  if (path === '/api/stripe/webhook') {
    if (request.method !== 'POST') return json({ error: 'method' }, 405);
    try { return await webhook(request, env, deps); } catch (e) {
      if (!(e instanceof HttpError)) console.error('webhook', e && e.stack || e);
      return errorResponse(e);
    }
  }
  if (request.method === 'OPTIONS') return preflight(request, env);
  let res;
  try { res = await route(request, env, deps); } catch (e) {
    if (!(e instanceof HttpError) || e.status >= 500) console.error(request.method, path, e && e.stack || e);
    res = errorResponse(e);
  }
  corsHeaders(request, env).forEach((v, k) => res.headers.set(k, v));
  return res;
}

export default {
  fetch(request, env) { return handle(request, env); },
};
