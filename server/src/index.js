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
// Marketplace (src/market.js, src/users.js, rules in src/economy.js):
//   GET    /api/market?sort=new|top&tag=&q=&cursor=      { items, next }
//   POST   /api/market             { title, description, tags, mode, priceKeys, visibility, payload, thumb }
//   GET    /api/market/:id                               Item
//   PATCH  /api/market/:id         { title?, description?, tags?, mode?, priceKeys?, visibility? }   owner
//   DELETE /api/market/:id                               owner
//   GET    /api/market/:id/file                          the .embroidr JSON, or 403 locked
//   GET    /api/market/:id/thumb                         the picture
//   POST   /api/market/:id/star    DELETE ...            { stars, starred }
//   POST   /api/market/:id/unlock                        { unlocked, keys } or 402 not-enough-keys
//   GET    /api/users/:handle                            profile, badges, activity, designs
//   GET    /api/me/wallet                                stars, keys, discount, free sew-out
//   PATCH  /api/me                 { handle?, name? }
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
import * as Market from './market.js';
import * as Users from './users.js';

export const LIMITS = {
  auth: 8 * 1024,
  small: 4 * 1024,
  export: 4 * 1024 * 1024,             // a traced picture can be a few hundred thousand points
  project: Projects.MAX_PROJECT_BYTES + 64 * 1024,
  webhook: 256 * 1024,
  market: Market.MAX_PAYLOAD_BYTES + 320 * 1024,     // the .embroidr JSON plus a 200 KB picture as base64
};

function db(env) {
  if (!env.DB) throw new HttpError(500, 'not_configured', 'The server has no database bound (DB).');
  return env.DB;
}

async function userFor(request, env, deps) {
  const uid = await readSession(request, env, deps.now());
  if (!uid) return null;
  return await db(env).prepare('SELECT id, email, name, picture, stripe_customer_id, handle, display_name, created_at FROM users WHERE id = ?').bind(uid).first();
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
    user: { email: user.email, name: user.name, picture: user.picture, handle: user.handle || null },
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
  const user = await D.prepare('SELECT id, email, name, picture, stripe_customer_id, handle, display_name, created_at FROM users WHERE google_sub = ?').bind(g.sub).first();
  await Users.ensureHandle(D, user);
  const cookie = await signSession(env, user.id, now);
  return json(Object.assign({ signedIn: true }, await account(env, user, now)), 200, { 'Set-Cookie': sessionCookie(cookie) });
}

async function me(request, env, deps) {
  const user = await userFor(request, env, deps);
  const base = { googleClientId: env.GOOGLE_CLIENT_ID || null, plans: plansInfo(), payments: !!(env.STRIPE_SECRET_KEY && env.STRIPE_PRICE_HOBBY && env.STRIPE_PRICE_PRO) };
  if (!user) return json(Object.assign({ signedIn: false }, base));
  await Users.ensureHandle(db(env), user);
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
  await Users.recordEvent(D, user.id, 'export', now);
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
  if (m === 'PUT') {
    const saved = await Projects.put(D, user.id, id, await readJson(request, LIMITS.project), deps.now());
    await Users.recordEvent(D, user.id, 'save', deps.now());
    return json(saved);
  }
  if (m === 'DELETE') { await Projects.remove(D, user.id, id); return json({ deleted: true }); }
  throw new HttpError(405, 'method', 'Not allowed.');
}

// ---------------------------------------------------------------- marketplace

async function marketUser(request, env, deps) {
  const u = await requireUser(request, env, deps);
  await Users.ensureHandle(db(env), u);
  return u;
}
async function viewerId(request, env, deps) {
  const uid = await readSession(request, env, deps.now());
  return uid || '';
}
function decodeSeg(s, what) {
  try { return decodeURIComponent(s); } catch (e) { throw new HttpError(404, 'not_found', 'That ' + what + ' is not here.'); }
}

async function market(request, env, deps, id, sub) {
  const D = db(env);
  const m = request.method;
  const base = new URL(request.url).origin;
  if (!id) {
    if (m === 'GET') return json(await Market.list(D, await viewerId(request, env, deps), new URL(request.url).searchParams, base));
    if (m === 'POST') {
      const u = await marketUser(request, env, deps);
      return json(await Market.publish(env, D, u, await readJson(request, LIMITS.market), deps.now(), base), 201);
    }
    throw new HttpError(405, 'method', 'Not allowed.');
  }
  if (!sub) {
    if (m === 'GET') return json(await Market.get(D, await viewerId(request, env, deps), id, base));
    if (m === 'PATCH') {
      const u = await marketUser(request, env, deps);
      return json(await Market.update(D, u, id, await readJson(request, LIMITS.small * 2), deps.now(), base));
    }
    if (m === 'DELETE') return json(await Market.remove(env, D, await marketUser(request, env, deps), id));
    throw new HttpError(405, 'method', 'Not allowed.');
  }
  if (sub === 'file' && m === 'GET') return Market.file(D, await viewerId(request, env, deps), id);
  if (sub === 'thumb' && m === 'GET') return Market.thumb(env, D, await viewerId(request, env, deps), id);
  if (sub === 'star' && m === 'POST') return json(await Market.star(D, await marketUser(request, env, deps), id, deps.now()));
  if (sub === 'star' && m === 'DELETE') return json(await Market.unstar(D, await marketUser(request, env, deps), id));
  if (sub === 'unlock' && m === 'POST') return json(await Market.unlock(D, await marketUser(request, env, deps), id, deps.now()));
  throw new HttpError(sub === 'file' || sub === 'thumb' || sub === 'star' || sub === 'unlock' ? 405 : 404, 'not_found', 'No such endpoint.');
}

async function userPage(request, env, deps, handle) {
  const D = db(env);
  const u = await Users.byHandle(D, handle);
  if (!u) throw new HttpError(404, 'not_found', 'Nobody has that name.');
  const viewer = await viewerId(request, env, deps);
  const p = await Users.profile(D, u, deps.now());
  p.designs = await Market.byOwner(D, viewer, u.id, new URL(request.url).origin);
  return json(p);
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
  if (path === '/api/me/wallet' && m === 'GET') return json(await Users.wallet(db(env), (await marketUser(request, env, deps)).id));
  if (path === '/api/market' && m === 'GET') return market(request, env, deps, null, null);
  const mm = /^\/api\/market\/([^/]+)(?:\/(file|thumb|star|unlock))?$/.exec(path);
  if (mm && m === 'GET') return market(request, env, deps, decodeSeg(mm[1], 'design'), mm[2] || null);
  const um = /^\/api\/users\/([^/]+)$/.exec(path);
  if (um && m === 'GET') return userPage(request, env, deps, decodeSeg(um[1], 'person'));
  if (m !== 'GET' && !originAllowed(request, env)) throw new HttpError(403, 'bad_origin', 'Requests are only accepted from the EmbroideryLabs site.');
  if (path === '/api/auth/google' && m === 'POST') return authGoogle(request, env, deps);
  if (path === '/api/auth/logout' && m === 'POST') return json({ signedIn: false }, 200, { 'Set-Cookie': clearCookie() });
  if (path === '/api/export' && m === 'POST') return doExport(request, env, deps);
  if (path === '/api/billing/checkout' && m === 'POST') return checkout(request, env, deps);
  if (path === '/api/billing/portal' && m === 'POST') return portal(request, env, deps);
  if (path === '/api/projects') return projects(request, env, deps, null);
  if (path === '/api/me' && m === 'PATCH') return json(await Users.updateMe(db(env), await marketUser(request, env, deps), await readJson(request, LIMITS.small)));
  if (path === '/api/market') return market(request, env, deps, null, null);
  if (mm) return market(request, env, deps, decodeSeg(mm[1], 'design'), mm[2] || null);
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
