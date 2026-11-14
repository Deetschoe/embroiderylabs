/* ==========================================================================
   EMBROIDERY LABS - js/market-api.js
   One door to the marketplace, the same method names for both backends:

     MarketAPI.list({ sort: 'new'|'top', tag, q, cursor })  -> { items: [Item], next }
     MarketAPI.get(id)            -> Item
     MarketAPI.file(id)           -> the .embroidr JSON (rejects code 'locked' when it may not be opened)
     MarketAPI.publish(body)      -> Item      body: { title, description, tags, mode, priceKeys, visibility,
                                                       payload, thumb, stats? }
     MarketAPI.update(id, patch)  -> Item
     MarketAPI.remove(id)         -> { ok: true }
     MarketAPI.star(id) / unstar(id) -> { stars, starred }
     MarketAPI.unlock(id)         -> { unlocked: true, keys }  (rejects code 'not-enough-keys', status 402)
     MarketAPI.user(handle)       -> { handle, name, avatar, joined, starsReceived, badges, activity, designs }
     MarketAPI.wallet()           -> { starsReceived, keys, keysEarned, keysSpent, discountPct, freeSewout, progressTo10k }
     MarketAPI.updateMe({ handle?, name? })
     MarketAPI.me()               -> { handle, name, avatar } or null (signed out)
     MarketAPI.note(kind)         -> counts a 'save' / 'export' for the activity graph (demo only; the server
                                     counts its own)
     MarketAPI.demo               -> true when there is no server (EL_CONFIG.apiBase is null)

   Every failure rejects with an Error that has .status and .code ('auth', 'locked', 'not-enough-keys',
   'not-found', 'forbidden', 'bad-request', 'too-large', 'storage', 'network').

   apiBase set   -> the server (server/, cookie session, JSON).
   apiBase null  -> a DEMO backend kept in this browser (localStorage 'el-market-demo-v1'), seeded from
                    designs/index.json: the starter designs belong to the house account 'embroidr' (all free,
                    except two that cost keys and one that is show only), the visitor is 'you'.
   Needs js/market-rules.js (window.MarketRules) and, for apiBase, js/config.js. No DOM.
   ========================================================================== */
(function () {
  'use strict';
  var R = window.MarketRules;
  if (!R) { if (window.console) console.error('market-api.js needs js/market-rules.js first'); return; }

  function base() {
    var cfg = window.EL_CONFIG || {};
    return typeof cfg.apiBase === 'string' && cfg.apiBase ? cfg.apiBase.replace(/\/+$/, '') : null;
  }
  function fail(status, code, message) {
    var e = new Error(message || code); e.status = status; e.code = code; return e;
  }
  var MESSAGES = {
    auth: 'Sign in to do that.',
    locked: 'This design is locked.',
    'not-enough-keys': 'Not enough keys yet.',
    'not-found': 'That design is not here any more.',
    forbidden: 'Only the owner can do that.',
    'too-large': 'That design is too big to share (over 1 MB).',
    storage: 'This browser has no room left to keep it.',
    network: 'Could not reach the server. Try again in a moment.'
  };
  function err(status, code, message) { return fail(status, code, message || MESSAGES[code] || 'Something went wrong.'); }

  /* ---------- tags people can pick -------------------------------------------------- */
  var TAGS = ['people', 'anime', 'flowers', 'bugs', 'animals', 'nature', 'food', 'text', 'patches', 'cute', 'retro', 'logos'];
  var TAG_FROM_SEED = { portrait: 'people', flower: 'flowers', insect: 'bugs' };
  function cleanTags(list) {
    var out = [];
    (Array.isArray(list) ? list : []).forEach(function (t) {
      t = String(t || '').toLowerCase().trim().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').slice(0, 24);
      if (t && out.indexOf(t) === -1 && out.length < R.MAX_TAGS) out.push(t);
    });
    return out;
  }

  /* ======================================================================
     SERVER
     ====================================================================== */
  function call(method, path, body) {
    var init = { method: method, credentials: 'include', headers: {} };
    if (body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
    return fetch(base() + path, init).then(null, function () { throw err(0, 'network'); }).then(function (r) {
      return r.text().then(function (t) {
        var data = null; try { data = t ? JSON.parse(t) : null; } catch (e) { data = null; }
        if (!r.ok) {
          var code = data && typeof data.error === 'string' ? data.error.replace(/_/g, '-') : '';
          if (r.status === 401 || code === 'signed-out') code = 'auth';
          else if (r.status === 404) code = code || 'not-found';
          else if (r.status === 413) code = 'too-large';
          else if (r.status === 402 && !code) code = 'not-enough-keys';
          else if (r.status === 403 && !code) code = 'forbidden';
          else if (!code) code = 'bad-request';
          throw err(r.status, code, data && typeof data.message === 'string' ? data.message : null);
        }
        return data;
      });
    });
  }
  function absThumb(item) {
    if (item && typeof item.thumb === 'string' && item.thumb.charAt(0) === '/' && item.thumb.charAt(1) !== '/') item.thumb = base() + item.thumb;
    if (item && item.owner && typeof item.owner.avatar === 'string' && item.owner.avatar.charAt(0) === '/' && item.owner.avatar.charAt(1) !== '/') item.owner.avatar = base() + item.owner.avatar;
    return item;
  }
  function qs(o) {
    var parts = [];
    Object.keys(o).forEach(function (k) { if (o[k] != null && o[k] !== '') parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(o[k])); });
    return parts.length ? '?' + parts.join('&') : '';
  }
  var server = {
    list: function (o) {
      o = o || {};
      return call('GET', '/api/market' + qs({ sort: o.sort === 'top' ? 'top' : 'new', tag: o.tag || '', q: o.q || '', cursor: o.cursor || '' })).then(function (d) {
        return { items: (d && Array.isArray(d.items) ? d.items : []).map(absThumb), next: d ? d.next || null : null };
      });
    },
    get: function (id) { return call('GET', '/api/market/' + encodeURIComponent(id)).then(absThumb); },
    file: function (id) { return call('GET', '/api/market/' + encodeURIComponent(id) + '/file'); },
    publish: function (b) { return call('POST', '/api/market', b).then(absThumb); },
    update: function (id, p) { return call('PATCH', '/api/market/' + encodeURIComponent(id), p).then(absThumb); },
    remove: function (id) { return call('DELETE', '/api/market/' + encodeURIComponent(id)).then(function (d) { return d || { ok: true }; }); },
    star: function (id) { return call('POST', '/api/market/' + encodeURIComponent(id) + '/star'); },
    unstar: function (id) { return call('DELETE', '/api/market/' + encodeURIComponent(id) + '/star'); },
    unlock: function (id) { return call('POST', '/api/market/' + encodeURIComponent(id) + '/unlock'); },
    user: function (h) {
      return call('GET', '/api/users/' + encodeURIComponent(h)).then(function (u) { if (u && Array.isArray(u.designs)) u.designs.forEach(absThumb); return u; });
    },
    wallet: function () { return call('GET', '/api/me/wallet'); },
    updateMe: function (p) { return call('PATCH', '/api/me', p); },
    me: function () {
      return call('GET', '/api/me').then(function (d) {
        if (!d || !d.signedIn) return null;
        var u = d.user || {};
        return { handle: u.handle || d.handle || null, name: u.name || '', avatar: u.avatar || u.picture || null };
      }, function () { return null; });
    },
    note: function () { return Promise.resolve(false); }
  };

  /* ======================================================================
     DEMO: everything in this browser
     ====================================================================== */
  var KEY = 'el-market-demo-v1', FILE_KEY = KEY + ':file:', PAGE = 24, DAY = 86400000;
  var memory = null, memoryFiles = {};          /* when localStorage is off: this page only */
  function lsGet(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { window.localStorage.setItem(k, v); return true; } catch (e) { return false; } }
  function lsDel(k) { try { window.localStorage.removeItem(k); } catch (e) { /* off */ } }
  function ymd(t) { var d = new Date(t); return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }
  function iso(t) { return new Date(t).toISOString(); }
  function rng(seed) { var s = seed >>> 0 || 1; return function () { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

  /* A small design of the visitor's own, so stars (and so keys) can be tried at once. */
  function starPatch() {
    var cx = 65, cy = 90, pts = [], disc = [], i, a;
    for (i = 0; i < 10; i++) { a = -Math.PI / 2 + i * Math.PI / 5; pts.push([+(cx + Math.cos(a) * (i % 2 ? 13 : 30)).toFixed(2), +(cy + Math.sin(a) * (i % 2 ? 13 : 30)).toFixed(2)]); }
    for (i = 0; i < 72; i++) { a = i / 72 * Math.PI * 2; disc.push([+(cx + Math.cos(a) * 40).toFixed(2), +(cy + Math.sin(a) * 40).toFixed(2)]); }
    var style = { lineType: 'running', lineWidth: 3, spacing: 0.4, stitchLen: 3, angle: 45, pattern: 'smooth' };
    function obj(o) { var k; for (k in style) if (!(k in o)) o[k] = style[k]; return o; }
    return {
      v: 1, app: 'embroidr', savedAt: 0,
      doc: { name: 'Star patch', hoop: { w: 130, h: 180 }, objects: [
        obj({ id: 'p1', name: 'Patch', type: 'polygon', pts: disc, color: '#8fb3a0', paint: 'fill' }),
        obj({ id: 'p2', name: 'Star', type: 'polygon', pts: pts, color: '#e3b85c', paint: 'fill', angle: 0 }),
        obj({ id: 'p3', name: 'Edge', type: 'ellipse', cx: cx, cy: cy, rx: 40, ry: 40, color: '#4e7396', paint: 'line', lineType: 'satin', lineWidth: 3 })
      ] },
      view: { fabric: { mode: 'light', color: '#ffffff' } }
    };
  }
  function starPatchThumb() {
    var star = [], disc = '', i, a;
    for (i = 0; i < 10; i++) { a = -Math.PI / 2 + i * Math.PI / 5; star.push((160 + Math.cos(a) * (i % 2 ? 46 : 104)).toFixed(1) + ',' + (160 + Math.sin(a) * (i % 2 ? 46 : 104)).toFixed(1)); }
    disc = '<circle cx="160" cy="160" r="136" fill="#8fb3a0"/><circle cx="160" cy="160" r="136" fill="url(#r)"/>';
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 320">' +
      '<defs><pattern id="r" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="5" height="2" fill="#000" fill-opacity=".07"/></pattern>' +
      '<pattern id="s" width="4" height="4" patternUnits="userSpaceOnUse"><rect width="4" height="1.6" fill="#fff" fill-opacity=".18"/></pattern></defs>' +
      '<rect width="320" height="320" fill="#f3efe6"/>' + disc +
      '<polygon points="' + star.join(' ') + '" fill="#e3b85c"/><polygon points="' + star.join(' ') + '" fill="url(#s)"/>' +
      '<circle cx="160" cy="160" r="136" fill="none" stroke="#4e7396" stroke-width="10"/></svg>';
    return 'data:image/svg+xml,' + encodeURIComponent(svg);
  }

  var SEED_MODES = { butterfly: { mode: 'keys', priceKeys: 2 }, lotus: { mode: 'keys', priceKeys: 3 }, 'smiling-man': { mode: 'show', priceKeys: 0 } };
  var SEED_STARS = { 'smiling-man': 214, 'anime-girl': 1188, 'anime-boy': 846, sunflower: 402, 'cherry-blossom': 377, lotus: 129, butterfly: 268, dragonfly: 61, ladybug: 153, bee: 92 };
  function seed(index) {
    var now = Date.now(), r = rng(7);
    var users = [
      { id: 'u-house', handle: 'embroidr', name: 'Embroidr', avatar: null, joined: ymd(now - 300 * DAY), rank: 1 },
      { id: 'u-mira', handle: 'mira', name: 'Mira', avatar: null, joined: ymd(now - 210 * DAY), rank: 2 },
      { id: 'u-kenji', handle: 'kenji', name: 'Kenji', avatar: null, joined: ymd(now - 160 * DAY), rank: 3 },
      { id: 'u-you', handle: 'you', name: 'You', avatar: null, joined: ymd(now - 40 * DAY), rank: 4 }
    ];
    var s = { v: 1, me: 'u-you', users: users, designs: [], stars: {}, unlocks: {}, spent: {}, retired: {}, activity: {}, sewout: [] };
    var list = index && Array.isArray(index.designs) ? index.designs : [];
    list.forEach(function (d, i) {
      if (!d || !/^[a-z0-9-]+$/.test(d.id) || typeof d.title !== 'string') return;
      var m = SEED_MODES[d.id] || { mode: 'free', priceKeys: 0 };
      var t = now - (list.length - i) * 2.6 * DAY - 9 * DAY;
      s.designs.push({
        id: d.id, title: d.title, description: '', tags: cleanTags((d.tags || []).map(function (x) { return TAG_FROM_SEED[x] || x; })),
        mode: m.mode, priceKeys: m.priceKeys, visibility: 'public', owner: 'u-house',
        thumb: d.thumb || null, file: d.file || ('designs/' + d.id + '.embroidr'),
        stats: { stitches: d.stitches, colors: d.colors, width: d.width, height: d.height },
        seedStars: SEED_STARS[d.id] || 20, createdAt: iso(t), updatedAt: iso(t)
      });
    });
    var t2 = now - 5 * DAY;
    s.designs.push({
      id: 'star-patch', title: 'Star patch', description: '', tags: ['patches', 'cute'], mode: 'free', priceKeys: 0, visibility: 'public', owner: 'u-you',
      thumb: starPatchThumb(), file: null, stats: { stitches: 5310, colors: 3, width: 83, height: 83 }, seedStars: 22, createdAt: iso(t2), updatedAt: iso(t2)
    });
    memoryFiles['star-patch'] = starPatch();
    s.stars = { 'anime-girl': ['u-you', 'u-mira'], sunflower: ['u-you', 'u-kenji'], 'star-patch': ['u-mira', 'u-kenji'], bee: ['u-mira'] };
    /* activity: the house account sews most days, the visitor a little lately */
    function act(uid, days, chance, peak) {
      var a = s.activity[uid] = {};
      for (var k = 0; k < days; k++) if (r() < chance) a[ymd(now - k * DAY)] = 1 + Math.floor(r() * r() * peak);
    }
    act('u-house', 300, 0.55, 9); act('u-mira', 200, 0.3, 5); act('u-kenji', 150, 0.2, 4); act('u-you', 40, 0.35, 5);
    s.activity['u-you'][ymd(now - 5 * DAY)] = (s.activity['u-you'][ymd(now - 5 * DAY)] || 0) + 1;   /* the star patch */
    return s;
  }

  var ready = null;
  function load() {
    if (memory) return Promise.resolve(memory);
    var raw = lsGet(KEY), s = null;
    if (raw) { try { s = JSON.parse(raw); } catch (e) { s = null; } }
    if (s && s.v === 1 && Array.isArray(s.designs) && Array.isArray(s.users)) return Promise.resolve(s);
    if (!ready) {
      ready = (window.fetch ? fetch('designs/index.json', { cache: 'no-cache' }).then(function (r) { if (!r.ok) throw new Error('no index'); return r.json(); }).then(null, function () { return null; }) : Promise.resolve(null))
        .then(function (index) {
          var raw2 = lsGet(KEY);                         /* another tab may have seeded meanwhile */
          if (raw2) { try { var s2 = JSON.parse(raw2); if (s2 && s2.v === 1) { ready = null; return s2; } } catch (e) { /* reseed */ } }
          var fresh = seed(index);
          if (!save(fresh)) memory = fresh;
          else if (memoryFiles['star-patch']) lsSet(FILE_KEY + 'star-patch', JSON.stringify(memoryFiles['star-patch']));
          ready = null;
          return fresh;
        });
    }
    return ready;
  }
  function save(s) {
    if (memory) { memory = s; return true; }
    return lsSet(KEY, JSON.stringify(s));
  }
  function commit(s) { if (!save(s)) throw err(507, 'storage'); return s; }

  function userById(s, id) { for (var i = 0; i < s.users.length; i++) if (s.users[i].id === id) return s.users[i]; return null; }
  function userByHandle(s, h) { h = String(h || '').toLowerCase(); for (var i = 0; i < s.users.length; i++) if (s.users[i].handle === h) return s.users[i]; return null; }
  function designById(s, id) { for (var i = 0; i < s.designs.length; i++) if (s.designs[i].id === id) return s.designs[i]; return null; }
  function starsOf(s, d) { return (d.seedStars || 0) + ((s.stars[d.id] || []).length); }
  function starsReceived(s, uid) {
    var n = s.retired[uid] || 0;
    s.designs.forEach(function (d) { if (d.owner === uid) n += starsOf(s, d); });
    return n;
  }
  function unlocksOfDesigns(s, uid) {
    var n = 0;
    Object.keys(s.unlocks).forEach(function (who) { (s.unlocks[who] || []).forEach(function (id) { var d = designById(s, id); if (d && d.owner === uid) n++; }); });
    return n + ((s.retiredUnlocks || {})[uid] || 0);
  }
  function walletOf(s, uid) {
    var stars = starsReceived(s, uid), earned = R.keysEarned(stars, unlocksOfDesigns(s, uid)), spent = s.spent[uid] || 0, keys = R.keys(earned, spent);
    var rank = s.sewout.indexOf(uid);
    return {
      starsReceived: stars, keys: keys, keysEarned: earned, keysSpent: spent, discountPct: R.discountPct(keys),
      freeSewout: { eligible: rank !== -1 || s.sewout.length < R.SEWOUT_WINNERS, rank: rank === -1 ? null : rank + 1 },
      progressTo10k: R.progressTo10k(stars)
    };
  }
  function isUnlocked(s, d, uid) {
    if (d.owner === uid) return true;
    if (d.mode === 'free') return true;
    if (d.mode === 'show') return false;
    return (s.unlocks[uid] || []).indexOf(d.id) !== -1;
  }
  function toItem(s, d) {
    var o = userById(s, d.owner) || { handle: 'unknown', name: 'Unknown', avatar: null };
    return {
      id: d.id, title: d.title, description: d.description || '', tags: d.tags.slice(), mode: d.mode, priceKeys: d.mode === 'keys' ? d.priceKeys : 0,
      visibility: d.visibility, owner: { handle: o.handle, name: o.name, avatar: o.avatar },
      thumb: d.thumb, stars: starsOf(s, d), starred: (s.stars[d.id] || []).indexOf(s.me) !== -1,
      unlocked: isUnlocked(s, d, s.me), mine: d.owner === s.me, createdAt: d.createdAt, updatedAt: d.updatedAt,
      stats: d.stats || null
    };
  }
  function visible(s, d) { return d.visibility === 'public' || d.owner === s.me; }
  function bump(s, uid, kind) {
    if (R.ACTIVITY_KINDS.indexOf(kind) === -1) return;
    var a = s.activity[uid] || (s.activity[uid] = {}), k = ymd(Date.now());
    a[k] = (a[k] || 0) + 1;
  }
  function claimSewout(s, uid) {
    if (s.sewout.indexOf(uid) === -1 && s.sewout.length < R.SEWOUT_WINNERS && starsReceived(s, uid) >= R.SEWOUT_STARS) s.sewout.push(uid);
  }
  function streak(a) {
    var best = 0, run = 0, now = Date.now();
    for (var k = R.ACTIVITY_DAYS; k >= 0; k--) { if (a[ymd(now - k * DAY)]) { run++; if (run > best) best = run; } else run = 0; }
    return best;
  }
  function badgesOf(s, u) {
    var out = [], stars = starsReceived(s, u.id), own = s.designs.filter(function (d) { return d.owner === u.id; });
    function add(id, when) { var b = R.badge(id); if (b) out.push({ id: id, label: b.label, earnedAt: when || null }); }
    var first = own.map(function (d) { return d.createdAt; }).sort()[0];
    if (own.length) add('first-design', first);
    if (stars >= 1) add('first-star');
    if (stars >= 100) add('stars-100');
    if (stars >= 1000) add('stars-1000');
    if (stars >= 10000) add('stars-10000');
    if (streak(s.activity[u.id] || {}) >= R.STREAK_DAYS) add('streak-7');
    if ((s.unlocks[u.id] || []).length) add('first-unlock');
    if (own.some(function (d) { return starsOf(s, d) >= R.POPULAR_STARS; })) add('popular');
    if ((u.rank || 1e9) <= R.EARLY_MEMBERS) add('early-member', u.joined);
    if (s.sewout.indexOf(u.id) !== -1) add('free-sewout');
    return out;
  }
  function payloadBytes(text) { try { return new Blob([text]).size; } catch (e) { return text.length * 2; } }
  function checkPayload(p) {
    var doc = p && typeof p === 'object' ? (p.doc && typeof p.doc === 'object' ? p.doc : p) : null;
    if (!doc || !Array.isArray(doc.objects) || !doc.objects.length) throw err(400, 'bad-request', 'There is nothing on the hoop to share yet.');
    var text = JSON.stringify(p);
    if (payloadBytes(text) > R.MAX_PAYLOAD_BYTES) throw err(413, 'too-large');
    return text;
  }
  function checkThumb(t) {
    if (t == null || t === '') return null;
    if (typeof t !== 'string' || !/^data:image\/(webp|png);base64,[A-Za-z0-9+/=]+$/.test(t)) throw err(400, 'bad-request', 'The preview picture must be a WebP or PNG.');
    if (Math.floor((t.length - t.indexOf(',') - 1) * 3 / 4) > R.MAX_THUMB_BYTES) throw err(413, 'too-large', 'The preview picture is too big.');
    return t;
  }
  function checkFields(p, d) {
    if (p.title !== undefined) { var t = String(p.title || '').replace(/\s+/g, ' ').trim().slice(0, 80); if (!t) throw err(400, 'bad-request', 'Give it a title.'); d.title = t; }
    if (p.description !== undefined) d.description = String(p.description || '').trim().slice(0, 500);
    if (p.tags !== undefined) d.tags = cleanTags(p.tags);
    if (p.mode !== undefined) { if (!R.validMode(p.mode)) throw err(400, 'bad-request', 'Pick Free, Keys or Show only.'); d.mode = p.mode; }
    if (p.priceKeys !== undefined || p.mode !== undefined) {
      var n = p.priceKeys !== undefined ? Number(p.priceKeys) : d.priceKeys;
      if (d.mode === 'keys') { if (!R.validPrice(n)) throw err(400, 'bad-request', 'Keys can be 1 to 5.'); d.priceKeys = n; } else d.priceKeys = 0;
    }
    if (p.visibility !== undefined) { if (R.VISIBILITIES.indexOf(p.visibility) === -1) throw err(400, 'bad-request', 'Pick Public or Private.'); d.visibility = p.visibility; }
  }
  function mine(s, id) {
    var d = designById(s, id);
    if (!d || !visible(s, d)) throw err(404, 'not-found');
    if (d.owner !== s.me) throw err(403, 'forbidden');
    return d;
  }
  function readFile(d) {
    if (d.file) return fetch(d.file, { cache: 'no-cache' }).then(function (r) { if (!r.ok) throw err(404, 'not-found'); return r.json(); });
    var raw = memoryFiles[d.id] ? null : lsGet(FILE_KEY + d.id);
    if (memoryFiles[d.id]) return Promise.resolve(JSON.parse(JSON.stringify(memoryFiles[d.id])));
    if (!raw) return Promise.reject(err(404, 'not-found', 'The file of this design is not on this device.'));
    try { return Promise.resolve(JSON.parse(raw)); } catch (e) { return Promise.reject(err(404, 'not-found')); }
  }
  function run(fn) { return load().then(function (s) { return fn(s); }); }

  var demo = {
    list: function (o) {
      o = o || {};
      return run(function (s) {
        var q = String(o.q || '').toLowerCase().trim(), tag = String(o.tag || '').toLowerCase();
        var items = s.designs.filter(function (d) {
          if (d.visibility !== 'public') return false;
          if (tag && d.tags.indexOf(tag) === -1) return false;
          if (!q) return true;
          var owner = userById(s, d.owner) || {};
          return (d.title + ' ' + d.tags.join(' ') + ' ' + (owner.handle || '') + ' ' + (owner.name || '')).toLowerCase().indexOf(q) !== -1;
        }).map(function (d) { return toItem(s, d); });
        items.sort(o.sort === 'top'
          ? function (a, b) { return b.stars - a.stars || (b.createdAt < a.createdAt ? -1 : 1); }
          : function (a, b) { return a.createdAt === b.createdAt ? 0 : b.createdAt < a.createdAt ? -1 : 1; });
        var at = Math.max(0, parseInt(o.cursor, 10) || 0);
        return { items: items.slice(at, at + PAGE), next: at + PAGE < items.length ? String(at + PAGE) : null };
      });
    },
    get: function (id) {
      return run(function (s) { var d = designById(s, id); if (!d || !visible(s, d)) throw err(404, 'not-found'); return toItem(s, d); });
    },
    file: function (id) {
      return run(function (s) {
        var d = designById(s, id);
        if (!d || !visible(s, d)) throw err(404, 'not-found');
        if (!isUnlocked(s, d, s.me)) throw err(403, 'locked', d.mode === 'show' ? 'This design is show only.' : 'Unlock this design first.');
        return readFile(d);
      });
    },
    publish: function (b) {
      b = b || {};
      return run(function (s) {
        var text = checkPayload(b.payload), now = Date.now();
        var d = { id: 'd' + now.toString(36) + Math.floor(Math.random() * 1e6).toString(36), title: '', description: '', tags: [], mode: 'free', priceKeys: 0, visibility: 'public', owner: s.me, thumb: checkThumb(b.thumb), file: null, stats: null, seedStars: 0, createdAt: iso(now), updatedAt: iso(now) };
        checkFields({ title: b.title, description: b.description || '', tags: b.tags || [], mode: b.mode || 'free', priceKeys: b.priceKeys, visibility: b.visibility || 'public' }, d);
        if (b.stats && typeof b.stats === 'object') d.stats = { stitches: +b.stats.stitches || 0, colors: +b.stats.colors || 0, width: +b.stats.width || 0, height: +b.stats.height || 0 };
        if (memory) memoryFiles[d.id] = JSON.parse(text);
        else if (!lsSet(FILE_KEY + d.id, text)) throw err(507, 'storage');
        s.designs.push(d); bump(s, s.me, 'publish');
        if (!save(s)) { lsDel(FILE_KEY + d.id); throw err(507, 'storage'); }
        return toItem(s, d);
      });
    },
    update: function (id, p) {
      return run(function (s) {
        var d = mine(s, id);
        checkFields(p || {}, d); d.updatedAt = iso(Date.now());
        commit(s); return toItem(s, d);
      });
    },
    remove: function (id) {
      return run(function (s) {
        var d = mine(s, id);
        s.retired[d.owner] = (s.retired[d.owner] || 0) + starsOf(s, d);      /* stars received stay received */
        var u = 0; Object.keys(s.unlocks).forEach(function (who) { var l = s.unlocks[who], i = l.indexOf(id); if (i !== -1) { l.splice(i, 1); u++; } });
        s.retiredUnlocks = s.retiredUnlocks || {}; s.retiredUnlocks[d.owner] = (s.retiredUnlocks[d.owner] || 0) + u;
        s.designs = s.designs.filter(function (x) { return x !== d; }); delete s.stars[id];
        commit(s); lsDel(FILE_KEY + id); delete memoryFiles[id];
        return { ok: true };
      });
    },
    star: function (id) {
      return run(function (s) {
        var d = designById(s, id);
        if (!d || d.visibility !== 'public') throw err(404, 'not-found');
        if (d.owner === s.me) throw err(400, 'own-design', 'You cannot star your own design.');
        var l = s.stars[id] || (s.stars[id] = []);
        if (l.indexOf(s.me) === -1) { l.push(s.me); bump(s, s.me, 'star-given'); claimSewout(s, d.owner); commit(s); }
        return { stars: starsOf(s, d), starred: true };
      });
    },
    unstar: function (id) {
      return run(function (s) {
        var d = designById(s, id);
        if (!d) throw err(404, 'not-found');
        var l = s.stars[id] || [], i = l.indexOf(s.me);
        if (i !== -1) { l.splice(i, 1); commit(s); }
        return { stars: starsOf(s, d), starred: false };
      });
    },
    unlock: function (id) {
      return run(function (s) {
        var d = designById(s, id);
        if (!d || !visible(s, d)) throw err(404, 'not-found');
        if (d.mode === 'show' && d.owner !== s.me) throw err(403, 'locked', 'This design is show only.');
        var w = walletOf(s, s.me);
        if (isUnlocked(s, d, s.me)) return { unlocked: true, keys: w.keys };
        if (w.keys < d.priceKeys) { var e = err(402, 'not-enough-keys', 'You need ' + d.priceKeys + (d.priceKeys === 1 ? ' key' : ' keys') + ' and have ' + w.keys + '.'); e.need = d.priceKeys; e.have = w.keys; throw e; }
        (s.unlocks[s.me] || (s.unlocks[s.me] = [])).push(d.id);
        s.spent[s.me] = (s.spent[s.me] || 0) + d.priceKeys;
        commit(s);
        return { unlocked: true, keys: walletOf(s, s.me).keys };
      });
    },
    user: function (handle) {
      return run(function (s) {
        var u = userByHandle(s, handle); if (!u) throw err(404, 'not-found', 'There is nobody called @' + String(handle || '').slice(0, 24) + ' here.');
        var a = s.activity[u.id] || {}, now = Date.now(), act = [];
        for (var k = R.ACTIVITY_DAYS - 1; k >= 0; k--) { var day = ymd(now - k * DAY); if (a[day]) act.push({ date: day, count: a[day] }); }
        var self = u.id === s.me;
        return {
          handle: u.handle, name: u.name, avatar: u.avatar, joined: u.joined, starsReceived: starsReceived(s, u.id),
          badges: badgesOf(s, u), activity: act,
          designs: s.designs.filter(function (d) { return d.owner === u.id && (self || d.visibility === 'public'); })
            .sort(function (x, y) { return x.createdAt < y.createdAt ? 1 : -1; }).map(function (d) { return toItem(s, d); })
        };
      });
    },
    wallet: function () { return run(function (s) { return walletOf(s, s.me); }); },
    updateMe: function (p) {
      p = p || {};
      return run(function (s) {
        var u = userById(s, s.me);
        if (p.handle !== undefined) {
          var h = String(p.handle || '').toLowerCase().trim();
          if (!R.validHandle(h)) throw err(400, 'bad-request', 'A handle is 3 to 24 letters, digits or dashes.');
          var other = userByHandle(s, h); if (other && other !== u) throw err(409, 'taken', 'That handle is taken.');
          u.handle = h;
        }
        if (p.name !== undefined) { var n = String(p.name || '').trim().slice(0, 60); if (n) u.name = n; }
        commit(s);
        return { handle: u.handle, name: u.name, avatar: u.avatar };
      });
    },
    me: function () { return run(function (s) { var u = userById(s, s.me); return { handle: u.handle, name: u.name, avatar: u.avatar }; }); },
    note: function (kind) {
      if (!lsGet(KEY)) return Promise.resolve(false);           /* no demo market yet: nothing to count */
      return run(function (s) { bump(s, s.me, kind); return save(s); });
    }
  };

  /* ---------- the public object: picks the backend on every call ---------- */
  var api = { TAGS: TAGS, rules: R, cleanTags: cleanTags, DEMO_KEY: KEY };
  ['list', 'get', 'file', 'publish', 'update', 'remove', 'star', 'unstar', 'unlock', 'user', 'wallet', 'updateMe', 'me', 'note'].forEach(function (name) {
    api[name] = function () {
      var impl = base() ? server : demo, args = arguments;
      try { return Promise.resolve(impl[name].apply(null, args)); } catch (e) { return Promise.reject(e); }
    };
  });
  Object.defineProperty(api, 'demo', { enumerable: true, get: function () { return !base(); } });
  /* demo only: forget everything (used by tests and by "Start over") */
  api.resetDemo = function () {
    var keys = [];
    try { for (var i = 0; i < window.localStorage.length; i++) { var k = window.localStorage.key(i); if (k && k.indexOf(KEY) === 0) keys.push(k); } } catch (e) { /* off */ }
    keys.forEach(lsDel); memory = null; memoryFiles = {}; ready = null;
  };
  window.MarketAPI = api;
})();
