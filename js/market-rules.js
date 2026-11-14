/* ==========================================================================
   EMBROIDR - js/market-rules.js
   The marketplace economy for the browser: window.MarketRules (read only).
   A copy of server/src/economy.js, which is the source of truth. Change both
   together: server/test/market.test.mjs checks they give the same answers.

     keysEarned  = floor(starsReceived / 10) + unlocksOfYourDesigns
     keys        = keysEarned - keysSpent            (never below 0)
     discountPct = min(50, 5 * floor(keys / 10))     "x% off your next sew-out"
     first 5 people whose lifetime stars received reach 10,000 get one free sew-out
   ========================================================================== */
(function (root) {
  'use strict';

  var RULES = Object.freeze({
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
    activityDays: 365
  });

  var MODES = Object.freeze(['free', 'keys', 'show']);
  var VISIBILITIES = Object.freeze(['public', 'private']);
  var EVENT_KINDS = Object.freeze(['save', 'publish', 'export', 'star-given']);

  var BADGES = Object.freeze([
    { id: 'first-design', label: 'First design' },
    { id: 'first-star', label: 'First star' },
    { id: 'stars-100', label: '100 stars' },
    { id: 'stars-1000', label: '1,000 stars' },
    { id: 'stars-10000', label: '10,000 stars' },
    { id: 'streak-7', label: '7-day streak' },
    { id: 'first-unlock', label: 'First unlock' },
    { id: 'popular', label: 'Popular' },
    { id: 'early-member', label: 'Early member' },
    { id: 'free-sewout', label: 'Free sew-out' }
  ]);

  function n0(v) { v = Math.floor(Number(v) || 0); return v > 0 ? v : 0; }

  function keysEarned(starsReceived, unlocksOfYourDesigns) {
    return Math.floor(n0(starsReceived) / RULES.starsPerKey) + n0(unlocksOfYourDesigns);
  }
  function keysLeft(earned, spent) {
    return Math.max(0, n0(earned) - n0(spent));
  }
  function discountPct(keys) {
    return Math.min(RULES.discountMaxPct, RULES.discountStepPct * Math.floor(n0(keys) / RULES.discountStepKeys));
  }
  function progressTo10k(starsReceived) {
    return Math.min(1, n0(starsReceived) / RULES.sewoutStars);
  }
  function validPrice(p) {
    return Number.isInteger(p) && p >= RULES.priceKeysMin && p <= RULES.priceKeysMax;
  }

  function wallet(facts) {
    var f = facts || {};
    var earned = keysEarned(f.starsReceived, f.unlocksOfYourDesigns);
    var keys = keysLeft(earned, f.keysSpent);
    var rank = f.claimRank >= 1 && f.claimRank <= RULES.sewoutSlots ? Math.floor(f.claimRank) : null;
    return {
      starsReceived: n0(f.starsReceived),
      keys: keys,
      keysEarned: earned,
      keysSpent: n0(f.keysSpent),
      discountPct: discountPct(keys),
      freeSewout: { eligible: rank !== null, rank: rank, slotsLeft: Math.max(0, RULES.sewoutSlots - n0(f.claimsTaken)) },
      progressTo10k: progressTo10k(f.starsReceived)
    };
  }

  var DAY_MS = 86400000;
  function dayKey(ms) { return new Date(ms).toISOString().slice(0, 10); }
  function dayMs(key) { return Date.parse(key + 'T00:00:00Z'); }

  function streakDay(days, len) {
    len = len || RULES.streakDays;
    var seen = {}, sorted = [];
    (days || []).forEach(function (d) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(d) && !seen[d]) { seen[d] = 1; sorted.push(d); }
    });
    sorted.sort();
    var run = 0, prev = null;
    for (var i = 0; i < sorted.length; i++) {
      var t = dayMs(sorted[i]);
      run = prev !== null && t - prev === DAY_MS ? run + 1 : 1;
      prev = t;
      if (run >= len) return sorted[i];
    }
    return null;
  }

  function activitySeries(counts, nowMs, days) {
    days = days || RULES.activityDays;
    var today = dayMs(dayKey(nowMs));
    var out = [];
    for (var i = days - 1; i >= 0; i--) {
      var date = dayKey(today - i * DAY_MS);
      out.push({ date: date, count: n0(counts && counts[date]) });
    }
    return out;
  }

  function badges(facts) {
    var f = facts || {};
    var at = {
      'first-design': f.firstDesignAt,
      'first-star': f.firstStarAt,
      'stars-100': f.star100At,
      'stars-1000': f.star1000At,
      'stars-10000': f.star10000At,
      'streak-7': f.streakDay ? dayMs(f.streakDay) : null,
      'first-unlock': f.firstUnlockAt,
      'popular': f.popularAt,
      'early-member': f.earlyMember ? (f.joinedAt || 0) : null,
      'free-sewout': f.sewoutAt
    };
    var out = [];
    BADGES.forEach(function (b) {
      var t = at[b.id];
      if (t === null || t === undefined || !isFinite(Number(t))) return;
      out.push({ id: b.id, label: b.label, earnedAt: Number(t) });
    });
    return out;
  }

  var api = Object.freeze({
    RULES: RULES, MODES: MODES, VISIBILITIES: VISIBILITIES, EVENT_KINDS: EVENT_KINDS, BADGES: BADGES,
    keysEarned: keysEarned, keysLeft: keysLeft, discountPct: discountPct, progressTo10k: progressTo10k,
    validPrice: validPrice, wallet: wallet, dayKey: dayKey, streakDay: streakDay,
    activitySeries: activitySeries, badges: badges
  });
  root.MarketRules = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : this);
