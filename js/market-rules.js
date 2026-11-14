/* ==========================================================================
   EMBROIDERY LABS - js/market-rules.js
   The marketplace economy, read-only, for the browser. The one source of truth
   is server/src/economy.js; these numbers must stay the same as there.
   (This copy was written by the marketplace web package. If the server package
   ships its own js/market-rules.js, keep that one: the constants are equal.)

   window.MarketRules (also module.exports in node)
   ========================================================================== */
(function (root, factory) {
  var R = factory();
  if (typeof module === 'object' && module.exports) module.exports = R;
  else root.MarketRules = R;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var R = {
    STARS_PER_KEY: 10,            /* 1 key per 10 stars received (lifetime, floor) */
    KEYS_PER_DISCOUNT_STEP: 10,   /* every 10 keys ... */
    DISCOUNT_STEP_PCT: 5,         /* ... take 5 % off a sew-out ... */
    DISCOUNT_MAX_PCT: 50,         /* ... up to 50 % */
    SEWOUT_STARS: 10000,          /* lifetime stars received for a free sew-out */
    SEWOUT_WINNERS: 5,            /* only the first five */
    PRICE_KEYS_MIN: 1,
    PRICE_KEYS_MAX: 5,
    POPULAR_STARS: 50,            /* a design with this many stars makes its owner "popular" */
    EARLY_MEMBERS: 100,           /* the first 100 users */
    STREAK_DAYS: 7,
    ACTIVITY_DAYS: 365,
    MAX_PAYLOAD_BYTES: 1000000,   /* the .embroidr JSON, like saved projects */
    MAX_THUMB_BYTES: 200 * 1024,  /* data:image/webp or png */
    MAX_TAGS: 5,
    MODES: ['free', 'keys', 'show'],
    VISIBILITIES: ['public', 'private'],
    ACTIVITY_KINDS: ['save', 'publish', 'export', 'star-given'],
    BADGES: [
      { id: 'first-design', label: 'First design', what: 'Published a design' },
      { id: 'first-star', label: 'First star', what: 'Got a star from someone' },
      { id: 'stars-100', label: '100 stars', what: '100 stars received' },
      { id: 'stars-1000', label: '1,000 stars', what: '1,000 stars received' },
      { id: 'stars-10000', label: '10,000 stars', what: '10,000 stars received' },
      { id: 'streak-7', label: '7-day streak', what: 'Active 7 days in a row' },
      { id: 'first-unlock', label: 'First unlock', what: 'Unlocked a design with keys' },
      { id: 'popular', label: 'Popular', what: 'A design with 50 stars' },
      { id: 'early-member', label: 'Early member', what: 'One of the first 100 members' },
      { id: 'free-sewout', label: 'Free sew-out', what: 'One of the first 5 to 10,000 stars' }
    ]
  };

  /* keysEarned = floor(starsReceived / 10) + unlocksOfYourDesigns; keys = keysEarned - keysSpent */
  R.keysEarned = function (starsReceived, unlocksOfYourDesigns) {
    return Math.floor(Math.max(0, starsReceived | 0) / R.STARS_PER_KEY) + Math.max(0, unlocksOfYourDesigns | 0);
  };
  R.keys = function (keysEarned, keysSpent) { return Math.max(0, (keysEarned | 0) - (keysSpent | 0)); };
  /* discountPct = min(50, 5 * floor(keys / 10)) */
  R.discountPct = function (keys) {
    return Math.min(R.DISCOUNT_MAX_PCT, R.DISCOUNT_STEP_PCT * Math.floor(Math.max(0, keys | 0) / R.KEYS_PER_DISCOUNT_STEP));
  };
  /* 0..1 of the way to 10,000 stars */
  R.progressTo10k = function (starsReceived) { return Math.max(0, Math.min(1, (starsReceived || 0) / R.SEWOUT_STARS)); };
  R.badge = function (id) {
    for (var i = 0; i < R.BADGES.length; i++) if (R.BADGES[i].id === id) return R.BADGES[i];
    return null;
  };
  R.validMode = function (m) { return R.MODES.indexOf(m) !== -1; };
  R.validPrice = function (n) { return n === (n | 0) && n >= R.PRICE_KEYS_MIN && n <= R.PRICE_KEYS_MAX; };
  R.validHandle = function (h) { return typeof h === 'string' && /^[a-z0-9-]{3,24}$/.test(h); };
  return R;
});
