// Stripe: webhook signatures, plan changes from events, Checkout and the portal.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, stripeSub, stripeSign, HAVE_SQLITE } from './helpers.mjs';
import { verifyStripeSignature, formEncode } from '../src/stripe.js';

const opts = { skip: !HAVE_SQLITE && 'node:sqlite is not available' };
const WHSEC = 'whsec_test_abc';

test('webhook signature: valid, wrong secret, changed body, old and future timestamps, several v1 values', async () => {
  const now = Date.UTC(2026, 0, 15, 12);
  const t = Math.floor(now / 1000);
  const body = '{"id":"evt_1","type":"ping"}';
  assert.equal(await verifyStripeSignature(body, stripeSign(body, WHSEC, t), WHSEC, now), true);
  assert.equal(await verifyStripeSignature(body, stripeSign(body, 'whsec_other', t), WHSEC, now), false, 'wrong secret');
  assert.equal(await verifyStripeSignature(body + ' ', stripeSign(body, WHSEC, t), WHSEC, now), false, 'body changed');
  assert.equal(await verifyStripeSignature(body, stripeSign(body, WHSEC, t - 301), WHSEC, now), false, 'older than 5 minutes');
  assert.equal(await verifyStripeSignature(body, stripeSign(body, WHSEC, t + 301), WHSEC, now), false, 'from the future');
  assert.equal(await verifyStripeSignature(body, stripeSign(body, WHSEC, t - 299), WHSEC, now), true, 'inside the tolerance');
  const good = stripeSign(body, WHSEC, t).split(',v1=')[1];
  assert.equal(await verifyStripeSignature(body, 't=' + t + ',v1=deadbeef,v1=' + good + ',v0=zzz', WHSEC, now), true, 'one of several v1 values matches (secret rotation)');
  assert.equal(await verifyStripeSignature(body, 'v1=' + good, WHSEC, now), false, 'no timestamp');
  assert.equal(await verifyStripeSignature(body, '', WHSEC, now), false);
  assert.equal(await verifyStripeSignature(body, stripeSign(body, WHSEC, t), '', now), false, 'no secret configured');
});

test('checkout.session.completed gives Hobby; updates switch to Pro; deletion falls back to Free', opts, async () => {
  const app = await makeApp();
  const { cookie } = await app.signIn();
  const uid = app.userId();
  let sub = stripeSub({ metadata: { user_id: uid } });
  app.routes.push({ test: u => u === 'https://api.stripe.com/v1/subscriptions/sub_1', reply: () => new Response(JSON.stringify(sub), { status: 200 }) });
  const t0 = Math.floor(app.clock.t / 1000);

  let r = await app.webhook({ id: 'evt_1', type: 'checkout.session.completed', created: t0, data: { object: {
    id: 'cs_1', object: 'checkout.session', mode: 'subscription', client_reference_id: uid, customer: 'cus_1', subscription: 'sub_1', metadata: { user_id: uid } } } });
  assert.equal(r.status, 200);
  const sc = app.calls.find(c => c.url.endsWith('/subscriptions/sub_1'));
  assert.equal(sc.init.headers.Authorization, 'Bearer sk_test_123', 'Stripe is asked with the secret key');
  let me = await (await app.request('GET', '/api/me', { cookie })).json();
  assert.deepEqual([me.plan, me.exports.limit, me.billing.customer], ['hobby', 100, true]);

  // upgrade to Pro
  sub = stripeSub({ metadata: { user_id: uid }, items: { data: [{ price: { id: 'price_pro' } }] } });
  r = await app.webhook({ id: 'evt_2', type: 'customer.subscription.updated', created: t0 + 10, data: { object: sub } });
  assert.equal(r.status, 200);
  me = await (await app.request('GET', '/api/me', { cookie })).json();
  assert.deepEqual([me.plan, me.exports.left], ['pro', null]);

  // an older event delivered late does not undo the upgrade
  r = await app.webhook({ id: 'evt_0', type: 'customer.subscription.updated', created: t0 + 5, data: { object: stripeSub({ metadata: { user_id: uid } }) } });
  assert.equal(r.status, 200);
  me = await (await app.request('GET', '/api/me', { cookie })).json();
  assert.equal(me.plan, 'pro', 'stale event ignored');

  // cancel at period end: still Pro, flagged
  r = await app.webhook({ id: 'evt_3', type: 'customer.subscription.updated', created: t0 + 20, data: { object: Object.assign({}, sub, { cancel_at_period_end: true }) } });
  me = await (await app.request('GET', '/api/me', { cookie })).json();
  assert.deepEqual([me.plan, me.billing.cancelAtPeriodEnd], ['pro', true]);

  // past_due keeps the plan while Stripe retries the card; unpaid does not
  await app.webhook({ id: 'evt_4', type: 'customer.subscription.updated', created: t0 + 30, data: { object: Object.assign({}, sub, { status: 'past_due' }) } });
  assert.equal((await (await app.request('GET', '/api/me', { cookie })).json()).plan, 'pro');
  await app.webhook({ id: 'evt_5', type: 'customer.subscription.updated', created: t0 + 40, data: { object: Object.assign({}, sub, { status: 'unpaid' }) } });
  assert.equal((await (await app.request('GET', '/api/me', { cookie })).json()).plan, 'free');

  // deleted: back to Free
  await app.webhook({ id: 'evt_6', type: 'customer.subscription.updated', created: t0 + 50, data: { object: sub } });
  r = await app.webhook({ id: 'evt_7', type: 'customer.subscription.deleted', created: t0 + 60, data: { object: Object.assign({}, sub, { status: 'canceled' }) } });
  assert.equal(r.status, 200);
  me = await (await app.request('GET', '/api/me', { cookie })).json();
  assert.equal(me.plan, 'free');
  assert.equal(app.db.get("SELECT status FROM subscriptions WHERE id = 'sub_1'").status, 'canceled');
});

test('the webhook refuses bad signatures, ignores repeats and finds the user by customer id', opts, async () => {
  const app = await makeApp();
  await app.signIn();
  const uid = app.userId();
  app.db.run("UPDATE users SET stripe_customer_id = 'cus_9' WHERE id = ?", uid);
  const ev = { id: 'evt_a', type: 'customer.subscription.created', created: 100, data: { object: stripeSub({ id: 'sub_9', customer: 'cus_9' }) } };

  let r = await app.webhook(ev, { secret: 'whsec_wrong' });
  assert.equal(r.status, 400);
  r = await app.webhook(ev, { t: Math.floor(app.clock.t / 1000) - 3600 });
  assert.equal(r.status, 400, 'replayed an hour later');
  r = await app.webhook(ev, { signature: '' });
  assert.equal(r.status, 400);
  assert.equal(app.db.get('SELECT COUNT(*) AS n FROM subscriptions').n, 0, 'nothing written');

  r = await app.webhook(ev);
  assert.equal(r.status, 200);
  assert.equal(app.db.get("SELECT user_id FROM subscriptions WHERE id = 'sub_9'").user_id, uid, 'found by customer id');
  r = await app.webhook(ev);
  assert.equal((await r.json()).duplicate, true, 'the same event twice is handled once');

  // events we do not use are acknowledged
  r = await app.webhook({ id: 'evt_b', type: 'invoice.paid', created: 1, data: { object: { id: 'in_1' } } });
  assert.equal(r.status, 200);
  // a webhook needs no Origin and gets no CORS headers
  assert.equal(r.headers.get('Access-Control-Allow-Origin'), null);
  // too big
  r = await app.webhook(ev, { rawBody: 'x'.repeat(300 * 1024) });
  assert.equal(r.status, 413);
});

test('when Stripe is down during checkout.session.completed the webhook fails so Stripe retries', opts, async () => {
  const app = await makeApp();
  await app.signIn();
  const uid = app.userId();
  app.routes.push({ test: u => u.includes('/subscriptions/'), reply: () => new Response('{"error":{"message":"down"}}', { status: 500 }) });
  const ev = { id: 'evt_c', type: 'checkout.session.completed', created: 1, data: { object: { mode: 'subscription', client_reference_id: uid, customer: 'cus_1', subscription: 'sub_1' } } };
  const r = await app.webhook(ev);
  assert.ok(r.status >= 500);
  assert.equal(app.db.get('SELECT COUNT(*) AS n FROM stripe_events').n, 0, 'not marked as handled');
});

test('checkout: a Checkout Session for the right price; paying customers go to the portal', opts, async () => {
  const app = await makeApp();
  const { cookie } = await app.signIn();
  const uid = app.userId();
  app.routes.push({ test: u => u === 'https://api.stripe.com/v1/checkout/sessions', reply: () => new Response(JSON.stringify({ id: 'cs_1', url: 'https://checkout.stripe.com/c/pay/cs_1' }), { status: 200 }) });
  app.routes.push({ test: u => u === 'https://api.stripe.com/v1/billing_portal/sessions', reply: () => new Response(JSON.stringify({ url: 'https://billing.stripe.com/p/session/x' }), { status: 200 }) });

  let r = await app.request('POST', '/api/billing/checkout', { body: { plan: 'hobby' } });
  assert.equal(r.status, 401, 'signed out');
  r = await app.request('POST', '/api/billing/checkout', { cookie, body: { plan: 'gold' } });
  assert.equal(r.status, 400);
  r = await app.request('POST', '/api/billing/portal', { cookie });
  assert.equal(r.status, 400, 'no billing before the first checkout');

  r = await app.request('POST', '/api/billing/checkout', { cookie, body: { plan: 'hobby' } });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).url, 'https://checkout.stripe.com/c/pay/cs_1');
  const call = app.calls.find(c => c.url.endsWith('/checkout/sessions'));
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.headers['Content-Type'], 'application/x-www-form-urlencoded');
  const form = new URLSearchParams(call.init.body);
  assert.equal(form.get('mode'), 'subscription');
  assert.equal(form.get('line_items[0][price]'), 'price_hobby');
  assert.equal(form.get('line_items[0][quantity]'), '1');
  assert.equal(form.get('client_reference_id'), uid);
  assert.equal(form.get('subscription_data[metadata][user_id]'), uid);
  assert.equal(form.get('customer_email'), 'ann@example.com');
  assert.equal(form.get('success_url'), 'https://embroiderylabs.com/app.html?checkout=done');

  // now a Hobby customer: Pro goes through the portal, Hobby again is refused
  app.db.run("UPDATE users SET stripe_customer_id = 'cus_1' WHERE id = ?", uid);
  app.db.run("INSERT INTO subscriptions (id, user_id, plan, status, price_id, updated_at) VALUES ('sub_1', ?, 'hobby', 'active', 'price_hobby', 0)", uid);
  r = await app.request('POST', '/api/billing/checkout', { cookie, body: { plan: 'hobby' } });
  assert.equal(r.status, 400);
  r = await app.request('POST', '/api/billing/checkout', { cookie, body: { plan: 'pro' } });
  const j = await r.json();
  assert.deepEqual([r.status, j.portal, j.url], [200, true, 'https://billing.stripe.com/p/session/x']);
  r = await app.request('POST', '/api/billing/portal', { cookie });
  assert.equal(r.status, 200);
  const pc = app.calls.filter(c => c.url.endsWith('/billing_portal/sessions')).pop();
  assert.equal(new URLSearchParams(pc.init.body).get('customer'), 'cus_1');
});

test('form encoding for Stripe', () => {
  assert.equal(formEncode({ a: 1, b: { c: 'x y', d: { 0: 'z' } }, n: null }), 'a=1&b%5Bc%5D=x%20y&b%5Bd%5D%5B0%5D=z');
});
