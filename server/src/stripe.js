// Stripe over its REST API with fetch (no SDK): Checkout, the customer portal, and webhooks.

import { HttpError, hmacSha256, hex, safeEqual } from './http.js';
import { planForPrice } from './plans.js';

const API = 'https://api.stripe.com/v1/';
export const TOLERANCE_S = 300;          // a webhook older than 5 minutes is refused (replay protection)

function secret(env) {
  if (!env.STRIPE_SECRET_KEY) throw new HttpError(500, 'not_configured', 'Payments are not set up on the server yet.');
  return env.STRIPE_SECRET_KEY;
}

// Stripe wants form encoding with brackets for nested fields: line_items[0][price]=...
export function formEncode(obj, prefix, out) {
  out = out || [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? prefix + '[' + k + ']' : k;
    if (typeof v === 'object') formEncode(v, key, out);
    else out.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(v)));
  }
  return out.join('&');
}

async function call(env, deps, method, path, params) {
  const init = { method, headers: { Authorization: 'Bearer ' + secret(env), 'Stripe-Version': '2024-06-20' } };
  if (params) { init.headers['Content-Type'] = 'application/x-www-form-urlencoded'; init.body = formEncode(params); }
  const res = await deps.fetch(API + path, init);
  let body = null;
  try { body = await res.json(); } catch (e) { body = null; }
  if (!res.ok) {
    // The detail goes to the Worker log, not to the visitor (it can name prices, customers or keys).
    const msg = body && body.error && body.error.message ? body.error.message : 'HTTP ' + res.status;
    console.error('stripe', method, path, res.status, String(msg).slice(0, 300));
    throw new HttpError(502, 'stripe_error', 'Payments are not available right now. Try again in a few minutes.');
  }
  return body;
}

export async function createCheckout(env, deps, user, plan) {
  const price = plan === 'hobby' ? env.STRIPE_PRICE_HOBBY : plan === 'pro' ? env.STRIPE_PRICE_PRO : null;
  if (!price) throw new HttpError(500, 'not_configured', 'That plan is not set up on the server yet.');
  const site = String(env.SITE_URL || '').replace(/\/+$/, '');
  const params = {
    mode: 'subscription',
    'line_items': { 0: { price, quantity: 1 } },
    success_url: site + '/app.html?checkout=done',
    cancel_url: site + '/app.html?checkout=cancelled',
    client_reference_id: user.id,
    allow_promotion_codes: 'true',
    metadata: { user_id: user.id, plan },
    subscription_data: { metadata: { user_id: user.id, plan } },
  };
  if (user.stripe_customer_id) params.customer = user.stripe_customer_id;
  else params.customer_email = user.email;
  const s = await call(env, deps, 'POST', 'checkout/sessions', params);
  return s.url;
}

export async function createPortal(env, deps, user) {
  if (!user.stripe_customer_id) throw new HttpError(400, 'no_billing', 'There is no billing to manage yet.');
  const site = String(env.SITE_URL || '').replace(/\/+$/, '');
  const s = await call(env, deps, 'POST', 'billing_portal/sessions', { customer: user.stripe_customer_id, return_url: site + '/app.html' });
  return s.url;
}

// Stripe-Signature: t=<seconds>,v1=<hex hmac>[,v1=...]. Signed text: "<t>.<raw body>".
export async function verifyStripeSignature(rawBody, header, whsec, nowMs) {
  if (!whsec || typeof header !== 'string') return false;
  let t = null; const sigs = [];
  for (const part of header.split(',')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim(), v = part.slice(i + 1).trim();
    if (k === 't') t = v; else if (k === 'v1') sigs.push(v);
  }
  if (!t || !/^\d{1,12}$/.test(t) || !sigs.length) return false;
  if (Math.abs(Math.floor(nowMs / 1000) - Number(t)) > TOLERANCE_S) return false;
  const want = hex(await hmacSha256(whsec, t + '.' + rawBody));
  return sigs.some(s => safeEqual(s, want));
}

// ---- events -> subscriptions table

function periodEnd(sub) {
  const s = sub.current_period_end || (sub.items && sub.items.data && sub.items.data[0] && sub.items.data[0].current_period_end);
  return typeof s === 'number' ? s * 1000 : null;
}
function priceOf(sub) {
  const it = sub.items && sub.items.data && sub.items.data[0];
  return it && it.price && it.price.id ? it.price.id : '';
}

async function findUser(db, sub) {
  const uid = sub.metadata && sub.metadata.user_id;
  if (uid) { const u = await db.prepare('SELECT id FROM users WHERE id = ?').bind(uid).first(); if (u) return u.id; }
  const cust = typeof sub.customer === 'string' ? sub.customer : sub.customer && sub.customer.id;
  if (cust) { const u = await db.prepare('SELECT id FROM users WHERE stripe_customer_id = ?').bind(cust).first(); if (u) return u.id; }
  return null;
}

export async function saveSubscription(db, env, sub, userId, eventCreated, nowMs, deleted) {
  const price = priceOf(sub);
  const status = deleted ? 'canceled' : String(sub.status || 'incomplete');
  // Upsert, but never let an older event overwrite a newer one (Stripe does not promise the order).
  await db.prepare(
    'INSERT INTO subscriptions (id, user_id, plan, status, price_id, current_period_end, cancel_at_period_end, event_created, updated_at) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
    'ON CONFLICT(id) DO UPDATE SET user_id = excluded.user_id, plan = excluded.plan, status = excluded.status, price_id = excluded.price_id, ' +
    'current_period_end = excluded.current_period_end, cancel_at_period_end = excluded.cancel_at_period_end, ' +
    'event_created = excluded.event_created, updated_at = excluded.updated_at ' +
    'WHERE excluded.event_created >= subscriptions.event_created'
  ).bind(sub.id, userId, planForPrice(env, price), status, price, periodEnd(sub), sub.cancel_at_period_end ? 1 : 0, eventCreated || 0, nowMs).run();
}

// -> short text for the log / reply
export async function handleEvent(db, env, deps, event) {
  const nowMs = deps.now();
  const obj = event.data && event.data.object;
  if (!obj) return 'no object';
  switch (event.type) {
    case 'checkout.session.completed': {
      if (obj.mode !== 'subscription') return 'not a subscription';
      const uid = obj.client_reference_id || (obj.metadata && obj.metadata.user_id);
      const user = uid ? await db.prepare('SELECT id FROM users WHERE id = ?').bind(uid).first() : null;
      if (!user) return 'unknown user';
      const cust = typeof obj.customer === 'string' ? obj.customer : obj.customer && obj.customer.id;
      if (cust) await db.prepare('UPDATE users SET stripe_customer_id = ? WHERE id = ?').bind(cust, user.id).run();
      const subId = typeof obj.subscription === 'string' ? obj.subscription : obj.subscription && obj.subscription.id;
      if (!subId) return 'no subscription';
      // The session does not carry the price or the status: ask Stripe for the subscription itself.
      const sub = await call(env, deps, 'GET', 'subscriptions/' + encodeURIComponent(subId));
      await saveSubscription(db, env, sub, user.id, event.created, nowMs, false);
      return 'subscription ' + sub.status;
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const uid = await findUser(db, obj);
      if (!uid) return 'unknown user';
      const cust = typeof obj.customer === 'string' ? obj.customer : obj.customer && obj.customer.id;
      if (cust) await db.prepare('UPDATE users SET stripe_customer_id = ? WHERE id = ? AND stripe_customer_id IS NULL').bind(cust, uid).run();
      await saveSubscription(db, env, obj, uid, event.created, nowMs, event.type === 'customer.subscription.deleted');
      return 'subscription saved';
    }
    default:
      return 'ignored';
  }
}
