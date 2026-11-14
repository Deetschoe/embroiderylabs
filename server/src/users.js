// People in the marketplace: handles, display names, activity events, wallet and badge facts.

import { HttpError } from './http.js';
import * as Economy from './economy.js';

export const HANDLE_RE = /^[a-z0-9](?:[a-z0-9-]{1,22})[a-z0-9]$/;      // 3..24, no leading/trailing '-'
// Names that would be confusing as someone's page.
const RESERVED = new Set(['you', 'me', 'embroidr', 'embroiderylabs', 'admin', 'api', 'help', 'support',
  'market', 'designs', 'new', 'top', 'settings', 'account', 'login', 'logout', 'signin', 'null', 'undefined']);
export const MAX_NAME = 60;

export function validHandle(h) {
  return typeof h === 'string' && HANDLE_RE.test(h) && !/--/.test(h) && !RESERVED.has(h);
}

// 'Zoë O'Brien' -> 'zoe-obrien'. Always 3..18 characters so a suffix still fits in 24.
export function slugify(name) {
  let s = String(name || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 18).replace(/-+$/, '');
  if (s.length < 3 || RESERVED.has(s)) s = (s ? s + '-' : '') + 'maker';
  return s.slice(0, 18).replace(/-+$/, '');
}

function suffix(rand) {
  const a = 'abcdefghijkmnpqrstuvwxyz23456789';
  const b = new Uint8Array(4);
  (rand || (x => crypto.getRandomValues(x)))(b);
  let s = '';
  for (const v of b) s += a[v % a.length];
  return s;
}

function isUnique(e) { return /UNIQUE|constraint/i.test(String(e && e.message || e)); }

// Give the user a handle if they have none yet: their slugged Google name, or that plus a random
// suffix when it is taken. -> handle
export async function ensureHandle(db, user) {
  if (user.handle) return user.handle;
  const base = slugify(user.name || (user.email || '').split('@')[0]);
  for (let i = 0; i < 8; i++) {
    const h = i === 0 ? base : base + '-' + suffix();
    try {
      const r = await db.prepare('UPDATE users SET handle = ? WHERE id = ? AND handle IS NULL').bind(h, user.id).run();
      if (r.meta && r.meta.changes) { user.handle = h; return h; }
      const now = await db.prepare('SELECT handle FROM users WHERE id = ?').bind(user.id).first();
      if (now && now.handle) { user.handle = now.handle; return now.handle; }      // set at the same moment
    } catch (e) {
      if (!isUnique(e)) throw e;
    }
  }
  throw new HttpError(500, 'handle', 'Could not pick a name for your page. Try again.');
}

function cleanName(s) {
  return String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
}
export function shownName(u) { return (u.display_name || u.name || '').trim() || u.handle || ''; }

// PATCH /api/me { handle?, name? } -> { handle, name }
export async function updateMe(db, user, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'bad_request', 'Send { handle, name }.');
  const sets = [], binds = [];
  if (body.handle !== undefined) {
    const h = typeof body.handle === 'string' ? body.handle.trim().toLowerCase() : '';
    if (!validHandle(h)) throw new HttpError(400, 'bad_handle', 'Use 3 to 24 letters, numbers or dashes.');
    sets.push('handle = ?'); binds.push(h);
  }
  if (body.name !== undefined) {
    if (typeof body.name !== 'string') throw new HttpError(400, 'bad_name', 'The name must be text.');
    sets.push('display_name = ?'); binds.push(cleanName(body.name) || null);
  }
  if (sets.length) {
    try {
      await db.prepare('UPDATE users SET ' + sets.join(', ') + ' WHERE id = ?').bind(...binds, user.id).run();
    } catch (e) {
      if (isUnique(e)) throw new HttpError(409, 'handle_taken', 'That name is taken.');
      throw e;
    }
  }
  const u = await db.prepare('SELECT id, handle, name, display_name, picture FROM users WHERE id = ?').bind(user.id).first();
  return { handle: u.handle, name: shownName(u), avatar: u.picture || '' };
}

// ---------------------------------------------------------------- activity

export function eventStmt(db, userId, kind, nowMs) {
  if (!Economy.EVENT_KINDS.includes(kind)) throw new Error('unknown event ' + kind);
  return db.prepare('INSERT INTO events (user_id, kind, day, n) VALUES (?, ?, ?, 1) ON CONFLICT(user_id, kind, day) DO UPDATE SET n = n + 1')
    .bind(userId, kind, Economy.dayKey(nowMs));
}
// Activity is a nice-to-have: a failure here never fails the save or export it belongs to.
export async function recordEvent(db, userId, kind, nowMs) {
  try { await eventStmt(db, userId, kind, nowMs).run(); } catch (e) { console.error('event', kind, e && e.message); }
}

async function activity(db, userId, nowMs) {
  const from = Economy.dayKey(nowMs - (Economy.RULES.activityDays - 1) * 86400000);
  const { results } = await db.prepare('SELECT day, SUM(n) AS n FROM events WHERE user_id = ? AND day >= ? GROUP BY day')
    .bind(userId, from).all();
  const counts = {};
  for (const r of results || []) counts[r.day] = Number(r.n);
  return Economy.activitySeries(counts, nowMs);
}

// ---------------------------------------------------------------- wallet

// The numbers the wallet is made of, read in one go. Lifetime stars received count star_marks.
export const WALLET_SQL =
  'SELECT (SELECT COUNT(*) FROM star_marks WHERE owner_id = ?1) AS stars_received,' +
  ' (SELECT COUNT(*) FROM unlocks WHERE owner_id = ?1) AS unlocks_of_yours,' +
  ' (SELECT COALESCE(SUM(price_keys), 0) FROM unlocks WHERE user_id = ?1) AS keys_spent,' +
  ' (SELECT rank FROM sewout_claims WHERE user_id = ?1) AS claim_rank,' +
  ' (SELECT claimed_at FROM sewout_claims WHERE user_id = ?1) AS claimed_at,' +
  ' (SELECT COUNT(*) FROM sewout_claims) AS claims_taken';

export async function walletFacts(db, userId) {
  const r = await db.prepare(WALLET_SQL).bind(userId).first();
  return {
    starsReceived: Number(r.stars_received) || 0,
    unlocksOfYourDesigns: Number(r.unlocks_of_yours) || 0,
    keysSpent: Number(r.keys_spent) || 0,
    claimRank: r.claim_rank == null ? null : Number(r.claim_rank),
    claimedAt: r.claimed_at == null ? null : Number(r.claimed_at),
    claimsTaken: Number(r.claims_taken) || 0,
  };
}

export async function wallet(db, userId) {
  return Economy.wallet(await walletFacts(db, userId));
}

// ---------------------------------------------------------------- badges

async function nthMark(db, column, value, n) {
  const r = await db.prepare('SELECT created_at FROM star_marks WHERE ' + column + ' = ? ORDER BY created_at, user_id LIMIT 1 OFFSET ?')
    .bind(value, n - 1).first();
  return r ? Number(r.created_at) : null;
}

async function badgesFor(db, u, facts) {
  const R = Economy.RULES;
  const s = facts.starsReceived;
  const first = await db.prepare(
    'SELECT (SELECT MIN(created_at) FROM market_items WHERE user_id = ?1) AS first_design,' +
    ' (SELECT MIN(created_at) FROM unlocks WHERE user_id = ?1) AS first_unlock,' +
    ' (SELECT COUNT(*) FROM users WHERE created_at < ?2 OR (created_at = ?2 AND id < ?1)) AS joined_before'
  ).bind(u.id, u.created_at).first();
  let firstDesignAt = first.first_design == null ? null : Number(first.first_design);
  if (firstDesignAt == null) {
    const p = await db.prepare("SELECT MIN(day) AS d FROM events WHERE user_id = ? AND kind = 'publish'").bind(u.id).first();
    if (p && p.d) firstDesignAt = Date.parse(p.d + 'T00:00:00Z');
  }
  // Popular: the moment one of their designs got its 50th star (lifetime stars on that design).
  let popularAt = null;
  const { results: pops } = await db.prepare(
    'SELECT item_id FROM star_marks WHERE owner_id = ? GROUP BY item_id HAVING COUNT(*) >= ? LIMIT 20'
  ).bind(u.id, R.popularStars).all();
  for (const p of pops || []) {
    const t = await nthMark(db, 'item_id', p.item_id, R.popularStars);
    if (t != null && (popularAt == null || t < popularAt)) popularAt = t;
  }
  const { results: days } = await db.prepare('SELECT DISTINCT day FROM events WHERE user_id = ? ORDER BY day').bind(u.id).all();
  return Economy.badges({
    firstDesignAt,
    firstStarAt: s >= 1 ? await nthMark(db, 'owner_id', u.id, 1) : null,
    star100At: s >= 100 ? await nthMark(db, 'owner_id', u.id, 100) : null,
    star1000At: s >= 1000 ? await nthMark(db, 'owner_id', u.id, 1000) : null,
    star10000At: s >= 10000 ? await nthMark(db, 'owner_id', u.id, 10000) : null,
    streakDay: Economy.streakDay((days || []).map(d => d.day)),
    firstUnlockAt: first.first_unlock == null ? null : Number(first.first_unlock),
    popularAt,
    earlyMember: Number(first.joined_before) < R.earlyMembers,
    joinedAt: Number(u.created_at),
    sewoutAt: facts.claimedAt,
  });
}

// ---------------------------------------------------------------- profile

export async function byHandle(db, handle) {
  const h = String(handle || '').toLowerCase();
  if (!/^[a-z0-9-]{1,24}$/.test(h)) return null;
  return await db.prepare('SELECT id, handle, name, display_name, picture, created_at FROM users WHERE handle = ?').bind(h).first();
}

// -> the profile without its designs (the caller adds them).
export async function profile(db, u, nowMs) {
  const facts = await walletFacts(db, u.id);
  return {
    handle: u.handle,
    name: shownName(u),
    avatar: u.picture || '',
    joined: Number(u.created_at),
    starsReceived: facts.starsReceived,
    badges: await badgesFor(db, u, facts),
    activity: await activity(db, u.id, nowMs),
  };
}
