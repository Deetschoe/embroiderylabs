// Plans and export counting.
//   Free   3 machine-file exports in total (exports made on Free)
//   Hobby  100 exports per calendar month (UTC), $9.99/month
//   Pro    unlimited, $22.99/month
// Drawing, preview and mockups never count: only POST /api/export does.

export const PLANS = {
  free:  { id: 'free',  label: 'Free',  price: 0,    limit: 3,    per: 'total' },
  hobby: { id: 'hobby', label: 'Hobby', price: 9.99, limit: 100,  per: 'month' },
  pro:   { id: 'pro',   label: 'Pro',   price: 22.99, limit: null, per: 'month' },
};
const RANK = { free: 0, hobby: 1, pro: 2 };
// Stripe statuses that still give the paid plan (past_due: Stripe is retrying the card).
export const PAID_STATUSES = ['active', 'trialing', 'past_due'];

export function monthKey(nowMs) {
  const d = new Date(nowMs);
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
}
export function nextMonthStart(nowMs) {
  const d = new Date(nowMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

export function planForPrice(env, priceId) {
  if (priceId && priceId === env.STRIPE_PRICE_HOBBY) return 'hobby';
  if (priceId && priceId === env.STRIPE_PRICE_PRO) return 'pro';
  return 'unknown';
}

// -> { plan, subscription | null }
export async function currentPlan(db, userId) {
  const { results } = await db.prepare(
    "SELECT id, plan, status, current_period_end, cancel_at_period_end FROM subscriptions WHERE user_id = ? AND status IN ('active','trialing','past_due')"
  ).bind(userId).all();
  let best = null;
  for (const s of results || []) {
    if (!PLANS[s.plan]) continue;
    if (!best || RANK[s.plan] > RANK[best.plan]) best = s;
  }
  return { plan: best ? best.plan : 'free', subscription: best };
}

// The WHERE clause and binds that select the exports counting against a plan's limit.
function scope(plan, userId, nowMs) {
  if (PLANS[plan].per === 'total') return { where: "user_id = ? AND plan = 'free' AND status = 'ok'", binds: [userId] };
  return { where: "user_id = ? AND month = ? AND plan != 'free' AND status = 'ok'", binds: [userId, monthKey(nowMs)] };
}

export async function usage(db, userId, plan, nowMs) {
  const p = PLANS[plan];
  const s = scope(plan, userId, nowMs);
  const row = await db.prepare('SELECT COUNT(*) AS n FROM export_log WHERE ' + s.where).bind(...s.binds).first();
  const used = row ? Number(row.n) : 0;
  return {
    used,
    limit: p.limit,
    left: p.limit === null ? null : Math.max(0, p.limit - used),
    per: p.per,
    resetsAt: p.per === 'month' && p.limit !== null ? nextMonthStart(nowMs) : null,
  };
}

// Take one export from the quota in a single SQL statement, so two exports at the same moment
// cannot both take the last one. -> row id, or null when the quota is used up.
export async function reserveExport(db, userId, plan, format, nowMs) {
  const p = PLANS[plan];
  const month = monthKey(nowMs);
  let res;
  if (p.limit === null) {
    res = await db.prepare(
      "INSERT INTO export_log (user_id, month, plan, format, status, created_at) VALUES (?, ?, ?, ?, 'ok', ?)"
    ).bind(userId, month, plan, format, nowMs).run();
  } else {
    const s = scope(plan, userId, nowMs);
    res = await db.prepare(
      "INSERT INTO export_log (user_id, month, plan, format, status, created_at) SELECT ?, ?, ?, ?, 'ok', ? " +
      'WHERE (SELECT COUNT(*) FROM export_log WHERE ' + s.where + ') < ?'
    ).bind(userId, month, plan, format, nowMs, ...s.binds, p.limit).run();
  }
  if (!res.meta || !res.meta.changes) return null;
  return res.meta.last_row_id;
}

// A cap on how often one account may start an export, counted in the database (a Worker has no
// shared memory). The engine runs BEFORE the quota is taken, so without this an account could
// keep the server busy with designs it never pays an export for. Each start writes an 'attempt'
// row; a finished export removes it again (its 'ok' row counts instead), a refused or abandoned one
// keeps it as 'refused' / 'attempt' (never counted against the plan). -> row id, or null when over the cap.
export const RATE = { perWindow: 20, windowMs: 60 * 1000 };
export async function startAttempt(db, userId, plan, format, nowMs) {
  // Old attempt rows are only needed for the window: clear this user's stale ones as we go.
  await db.prepare("DELETE FROM export_log WHERE user_id = ? AND status IN ('attempt','refused') AND created_at < ?")
    .bind(userId, nowMs - 24 * 3600 * 1000).run();
  const res = await db.prepare(
    "INSERT INTO export_log (user_id, month, plan, format, status, created_at) SELECT ?, ?, ?, ?, 'attempt', ? " +
    'WHERE (SELECT COUNT(*) FROM export_log WHERE user_id = ? AND created_at > ?) < ?'
  ).bind(userId, monthKey(nowMs), plan, format, nowMs, userId, nowMs - RATE.windowMs, RATE.perWindow).run();
  if (!res.meta || !res.meta.changes) return null;
  return res.meta.last_row_id;
}
export async function endAttempt(db, id, refused) {
  if (id == null) return;
  if (refused) await db.prepare("UPDATE export_log SET status = 'refused' WHERE id = ?").bind(id).run();
  else await db.prepare('DELETE FROM export_log WHERE id = ?').bind(id).run();
}

export async function finishExport(db, id, ok, stitches, bytes) {
  await db.prepare('UPDATE export_log SET status = ?, stitches = ?, bytes = ? WHERE id = ?')
    .bind(ok ? 'ok' : 'failed', stitches || 0, bytes || 0, id).run();
}
