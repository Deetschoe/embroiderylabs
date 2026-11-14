// Marketplace economy: the one source of truth for stars, keys, the sew-out discount, the top-5 free
// sew-out, badges and the activity graph. Pure functions, no database.
// js/market-rules.js is a read-only copy for the browser (window.MarketRules) so the site shows the
// same numbers; test/market.test.mjs checks the two agree.
//
//   keysEarned  = floor(starsReceived / 10) + unlocksOfYourDesigns
//   keys        = keysEarned - keysSpent            (never below 0)
//   discountPct = min(50, 5 * floor(keys / 10))     "x% off your next sew-out"
//   first 5 people whose lifetime stars received reach 10,000 get one free sew-out
//
// starsReceived counts every (person, design) star ever given to your designs once, for good:
// an unstar takes the star off the design but not off your lifetime total, so keys you have earned
// (and maybe spent) are never taken back.

export const RULES = Object.freeze({
  starsPerKey: 10,
  priceKeysMin: 1,
  priceKeysMax: 5,
  discountStepKeys: 10,
  discountStepPct: 5,
  discountMaxPct: 50,
  sewoutStars: 10000,
  sewoutSlots: 5,
  popularStars: 50,
  earlyMembers: 100,
  streakDays: 7,
  activityDays: 365,
});

export const MODES = Object.freeze(['free', 'keys', 'show']);
export const VISIBILITIES = Object.freeze(['public', 'private']);
export const EVENT_KINDS = Object.freeze(['save', 'publish', 'export', 'star-given']);

// In the order a profile shows them.
export const BADGES = Object.freeze([
  { id: 'first-design', label: 'First design' },
  { id: 'first-star', label: 'First star' },
  { id: 'stars-100', label: '100 stars' },
  { id: 'stars-1000', label: '1,000 stars' },
  { id: 'stars-10000', label: '10,000 stars' },
  { id: 'streak-7', label: '7-day streak' },
  { id: 'first-unlock', label: 'First unlock' },
  { id: 'popular', label: 'Popular' },
  { id: 'early-member', label: 'Early member' },
  { id: 'free-sewout', label: 'Free sew-out' },
]);

function n0(v) { v = Math.floor(Number(v) || 0); return v > 0 ? v : 0; }

export function keysEarned(starsReceived, unlocksOfYourDesigns) {
  return Math.floor(n0(starsReceived) / RULES.starsPerKey) + n0(unlocksOfYourDesigns);
}
export function keysLeft(earned, spent) {
  return Math.max(0, n0(earned) - n0(spent));
}
export function discountPct(keys) {
  return Math.min(RULES.discountMaxPct, RULES.discountStepPct * Math.floor(n0(keys) / RULES.discountStepKeys));
}
// 0..1, for a progress bar towards the 10,000-star free sew-out.
export function progressTo10k(starsReceived) {
  return Math.min(1, n0(starsReceived) / RULES.sewoutStars);
}
export function validPrice(p) {
  return Number.isInteger(p) && p >= RULES.priceKeysMin && p <= RULES.priceKeysMax;
}

// facts = { starsReceived, unlocksOfYourDesigns, keysSpent, claimRank (1..5 | null), claimsTaken }
export function wallet(facts) {
  const f = facts || {};
  const earned = keysEarned(f.starsReceived, f.unlocksOfYourDesigns);
  const keys = keysLeft(earned, f.keysSpent);
  const rank = f.claimRank >= 1 && f.claimRank <= RULES.sewoutSlots ? Math.floor(f.claimRank) : null;
  return {
    starsReceived: n0(f.starsReceived),
    keys,
    keysEarned: earned,
    keysSpent: n0(f.keysSpent),
    discountPct: discountPct(keys),
    freeSewout: { eligible: rank !== null, rank, slotsLeft: Math.max(0, RULES.sewoutSlots - n0(f.claimsTaken)) },
    progressTo10k: progressTo10k(f.starsReceived),
  };
}

// ---- days (UTC, 'YYYY-MM-DD')
const DAY_MS = 86400000;
export function dayKey(ms) { return new Date(ms).toISOString().slice(0, 10); }
function dayMs(key) { return Date.parse(key + 'T00:00:00Z'); }

// The day on which the first run of `len` consecutive active days was completed, or null.
// days: day keys with activity, any order, repeats allowed.
export function streakDay(days, len) {
  len = len || RULES.streakDays;
  const sorted = Array.from(new Set(days || [])).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  let run = 0, prev = null;
  for (const d of sorted) {
    const t = dayMs(d);
    run = prev !== null && t - prev === DAY_MS ? run + 1 : 1;
    prev = t;
    if (run >= len) return d;
  }
  return null;
}

// counts: { 'YYYY-MM-DD': n } -> [{ date, count }] for the last `days` days, oldest first, ending today.
export function activitySeries(counts, nowMs, days) {
  days = days || RULES.activityDays;
  const today = dayMs(dayKey(nowMs));
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const date = dayKey(today - i * DAY_MS);
    out.push({ date, count: n0(counts && counts[date]) });
  }
  return out;
}

// facts: the time (ms) each badge was earned, or null/undefined when not (yet):
//   { firstDesignAt, firstStarAt, star100At, star1000At, star10000At, streakDay ('YYYY-MM-DD'),
//     firstUnlockAt, popularAt, earlyMember (bool), joinedAt, sewoutAt }
// -> [{ id, label, earnedAt }] earned ones only, in BADGES order.
export function badges(facts) {
  const f = facts || {};
  const at = {
    'first-design': f.firstDesignAt,
    'first-star': f.firstStarAt,
    'stars-100': f.star100At,
    'stars-1000': f.star1000At,
    'stars-10000': f.star10000At,
    'streak-7': f.streakDay ? dayMs(f.streakDay) : null,
    'first-unlock': f.firstUnlockAt,
    'popular': f.popularAt,
    'early-member': f.earlyMember ? (f.joinedAt || 0) : null,
    'free-sewout': f.sewoutAt,
  };
  const out = [];
  for (const b of BADGES) {
    const t = at[b.id];
    if (t === null || t === undefined || !Number.isFinite(Number(t))) continue;
    out.push({ id: b.id, label: b.label, earnedAt: Number(t) });
  }
  return out;
}
