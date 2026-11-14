/* ==========================================================================
   EMBROIDERY LABS - js/market.js
   window.MarketUI: small pieces both market.html and profile.html use (avatar, mode chip, star button,
   wallet, error words), and the market page itself when #mk-grid is on the page:
   sort New / Top, tag chips, search, a grid of cards, the detail sheet (?d=<id>), unlock with keys.
   Needs js/site.js (EL), js/market-rules.js, js/market-api.js. All text goes in with textContent.
   ========================================================================== */
(function () {
  'use strict';
  var API = window.MarketAPI, EL = window.EL, R = window.MarketRules;
  if (!API || !EL || !R) return;

  /* ---------- tiny DOM helpers ---------- */
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  var SVGNS = 'http://www.w3.org/2000/svg';
  var ICONS = {   /* static shapes, 16 x 16 */
    star: [['path', { d: 'M8 1.9l1.85 3.8 4.15.6-3 2.95.7 4.15L8 11.45 4.3 13.4 5 9.25 2 6.3l4.15-.6z' }]],
    key: [['circle', { cx: 5, cy: 8, r: 2.8 }], ['path', { d: 'M7.8 8h6.4M12 8v2.4M14.2 8v1.8' }]],
    eye: [['path', { d: 'M1.5 8S4 3.6 8 3.6 14.5 8 14.5 8 12 12.4 8 12.4 1.5 8 1.5 8z' }], ['circle', { cx: 8, cy: 8, r: 2 }]],
    lock: [['rect', { x: 3.5, y: 7, width: 9, height: 6.5, rx: 1.5 }], ['path', { d: 'M5.5 7V5a2.5 2.5 0 0 1 5 0v2' }]],
    open: [['path', { d: 'M5.5 7V5a2.5 2.5 0 0 1 4.9-.7' }], ['rect', { x: 3.5, y: 7, width: 9, height: 6.5, rx: 1.5 }]],
    pen: [['path', { d: 'M3 13l.8-3.2L11 2.6 13.4 5 6.2 12.2z' }]],
    heart: [['path', { d: 'M8 13.5S2.5 10.2 2.5 6.3A2.8 2.8 0 0 1 8 5a2.8 2.8 0 0 1 5.5 1.3C13.5 10.2 8 13.5 8 13.5z' }]],
    flame: [['path', { d: 'M8 14c-2.5 0-4-1.7-4-3.8C4 7.5 7 6.5 7 2.5c2.5 1.5 5 4.2 5 7.7C12 12.3 10.5 14 8 14z' }]],
    sun: [['circle', { cx: 8, cy: 8, r: 3 }], ['path', { d: 'M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1' }]],
    gift: [['rect', { x: 2.5, y: 6, width: 11, height: 7.5, rx: 1 }], ['path', { d: 'M2 6h12M8 6v7.5M8 6C6 6 4.5 5 5 3.6S8 4 8 6zm0 0c2 0 3.5-1 3-2.4S8 4 8 6z' }]],
    needle: [['path', { d: 'M3 13 12.5 3.5M11 3.2l1.8 1.8' }], ['circle', { cx: 12.3, cy: 3.7, r: 1.1 }]],
    sprout: [['path', { d: 'M8 14V8M8 8C8 5 6 3.5 3 3.5 3 6.5 5 8 8 8zm0 0c0-2.5 1.8-4 4.5-4 0 2.7-1.8 4-4.5 4z' }]]
  };
  function icon(name) {
    var s = document.createElementNS(SVGNS, 'svg'); s.setAttribute('viewBox', '0 0 16 16'); s.setAttribute('aria-hidden', 'true');
    (ICONS[name] || []).forEach(function (p) {
      var n = document.createElementNS(SVGNS, p[0]); Object.keys(p[1]).forEach(function (k) { n.setAttribute(k, p[1][k]); }); s.appendChild(n);
    });
    return s;
  }
  function num(n) { return Number(n || 0).toLocaleString('en-US'); }
  function inches(mm) { return (Number(mm || 0) / 25.4).toFixed(1); }
  function hash(s) { var h = 0; s = String(s || ''); for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); }
  function profileUrl(handle) { return 'profile.html?u=' + encodeURIComponent(handle); }
  function safeImg(url) { return typeof url === 'string' && /^(https:\/\/|data:image\/(webp|png|jpeg|svg\+xml)[;,]|designs\/|\/)/.test(url); }

  function avatar(person, size) {
    person = person || {};
    var a = el('span', 'avatar avatar--' + (hash(person.handle) % 5));
    if (size) { a.style.width = a.style.height = size + 'px'; }
    if (person.avatar && safeImg(person.avatar)) {
      var img = el('img'); img.src = person.avatar; img.alt = ''; img.referrerPolicy = 'no-referrer'; img.loading = 'lazy'; a.appendChild(img);
    } else a.textContent = String(person.name || person.handle || '?').trim().charAt(0) || '?';
    a.setAttribute('aria-hidden', 'true');
    return a;
  }
  function ownerLink(owner) {
    var a = el('a', 'owner'); a.href = profileUrl(owner.handle);
    a.appendChild(avatar(owner)); a.appendChild(el('span', null, '@' + owner.handle));
    return a;
  }
  function modeChip(item) {
    var c = el('span', 'chip');
    if (item.mode === 'keys') {
      c.classList.add('chip--keys'); c.appendChild(icon(item.unlocked && !item.mine ? 'open' : 'key'));
      c.appendChild(document.createTextNode(item.unlocked && !item.mine ? 'Unlocked' : String(item.priceKeys)));
      c.title = item.unlocked && !item.mine ? 'Unlocked: yours to open' : 'Unlocks for ' + item.priceKeys + (item.priceKeys === 1 ? ' key' : ' keys');
    } else if (item.mode === 'show') { c.classList.add('chip--show'); c.appendChild(icon('eye')); c.appendChild(document.createTextNode('Show only')); }
    else c.textContent = 'Free';
    return c;
  }
  function modeWords(item) {
    return item.mode === 'keys' ? item.priceKeys + (item.priceKeys === 1 ? ' key' : ' keys') : item.mode === 'show' ? 'show only' : 'free';
  }

  /* ---------- errors in plain words ---------- */
  function say(e, label) {
    var code = e && e.code;
    if (code === 'auth') {
      EL.toast('Sign in first. You can sign in from the editor.', { label: label || 'Sign in', timeout: 7000, action: { label: 'Open Embroidr', onClick: function () { window.location.href = 'app.html'; } } });
      return;
    }
    EL.toast((e && e.message) || 'Something went wrong.', { kind: 'bad', label: label || 'Marketplace' });
  }

  /* ---------- the star button: one per place an item shows; all of them stay in step ---------- */
  var busyStar = {};
  function paintStar(b, stars, starred) {
    b.setAttribute('aria-pressed', starred ? 'true' : 'false');
    b.lastChild.textContent = num(stars);
    b.setAttribute('aria-label', (starred ? 'Starred' : 'Star') + ', ' + num(stars) + (stars === 1 ? ' star' : ' stars'));
  }
  function starAll(id, stars, starred) {
    var list = document.querySelectorAll('.star[data-id]');
    for (var i = 0; i < list.length; i++) if (list[i].getAttribute('data-id') === id) paintStar(list[i], stars, starred);
    document.dispatchEvent(new CustomEvent('market:star', { detail: { id: id, stars: stars, starred: starred } }));
  }
  function starButton(item) {
    var b = el('button', 'star'); b.type = 'button'; b.setAttribute('data-id', item.id);
    b.appendChild(icon('star')); b.appendChild(el('span', 'num'));
    paintStar(b, item.stars, item.starred);
    if (item.mine) { b.disabled = true; b.title = 'Your design'; b.setAttribute('aria-label', num(item.stars) + ' stars on your design'); return b; }
    b.addEventListener('click', function (e) {
      e.stopPropagation();
      if (busyStar[item.id]) return;
      var was = b.getAttribute('aria-pressed') === 'true', count = parseInt(b.lastChild.textContent.replace(/,/g, ''), 10) || 0;
      busyStar[item.id] = true;
      starAll(item.id, Math.max(0, count + (was ? -1 : 1)), !was);          /* at once; the answer corrects it */
      (was ? API.unstar(item.id) : API.star(item.id)).then(function (r) {
        item.stars = r.stars; item.starred = r.starred; starAll(item.id, r.stars, r.starred);
      }, function (err) { starAll(item.id, count, was); say(err, 'Star'); }).then(function () { busyStar[item.id] = false; });
    });
    return b;
  }

  /* ---------- wallet strip ---------- */
  function wallet(box, w, me) {
    box.textContent = '';
    function stat(cls, ico, value, words) {
      var d = el('div', 'wallet__stat ' + cls), b = el('b');
      if (ico) b.appendChild(icon(ico));
      b.appendChild(el('span', 'num', value)); d.appendChild(b); d.appendChild(el('span', null, words)); return d;
    }
    box.appendChild(stat('wallet__stat--stars', 'star', num(w.starsReceived), 'stars received'));
    box.appendChild(stat('wallet__stat--keys', 'key', num(w.keys), w.keys === 1 ? 'key' : 'keys'));
    box.appendChild(stat('wallet__stat--off', null, (w.discountPct || 0) + '%', 'off your next sew-out'));
    var goal = el('div', 'wallet__goal'), top = el('div', 'wallet__goal-top'), fs = w.freeSewout || {};
    top.appendChild(el('span', null, fs.rank ? 'You won a free sew-out. You were number ' + fs.rank + '.' : fs.eligible === false ? 'All five free sew-outs are taken.' : 'First 5 to 10,000 stars get their design sewn free'));
    top.appendChild(el('span', 'num', num(Math.min(w.starsReceived, R.SEWOUT_STARS)) + ' / ' + num(R.SEWOUT_STARS)));
    var bar = el('div', 'bar'), fill = el('i'); fill.style.width = (R.progressTo10k(w.starsReceived) * 100).toFixed(2) + '%';
    bar.appendChild(fill); bar.setAttribute('role', 'progressbar'); bar.setAttribute('aria-label', 'Stars toward 10,000');
    bar.setAttribute('aria-valuemin', '0'); bar.setAttribute('aria-valuemax', String(R.SEWOUT_STARS)); bar.setAttribute('aria-valuenow', String(Math.min(w.starsReceived, R.SEWOUT_STARS)));
    goal.appendChild(top); goal.appendChild(bar);
    var nextOff = R.KEYS_PER_DISCOUNT_STEP - (w.keys % R.KEYS_PER_DISCOUNT_STEP);
    goal.appendChild(el('span', 'wallet__note', '1 key for every 10 stars. ' + (w.discountPct >= R.DISCOUNT_MAX_PCT ? 'You have the biggest discount.' : nextOff + ' more ' + (nextOff === 1 ? 'key' : 'keys') + ' for ' + (w.discountPct + R.DISCOUNT_STEP_PCT) + '% off.')));
    box.appendChild(goal);
    if (me && me.handle) { var a = el('a', 'btn wallet__go', 'Your profile'); a.href = profileUrl(me.handle); box.appendChild(a); }
    box.hidden = false;
  }

  /* one floating tooltip for the page (badges, graph cells) */
  var tipEl = null;
  function tip(text, x, y) {
    if (!tipEl) {
      tipEl = el('div', 'tip-float'); tipEl.setAttribute('role', 'tooltip'); document.body.appendChild(tipEl);
      window.addEventListener('scroll', function () { tipEl.hidden = true; }, { passive: true, capture: true });
    }
    if (text == null) { tipEl.hidden = true; return; }
    tipEl.textContent = text; tipEl.hidden = false;
    var w = tipEl.offsetWidth, h = tipEl.offsetHeight;
    tipEl.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, x - w / 2)) + 'px';
    tipEl.style.top = Math.max(8, y - h - 10) + 'px';
  }

  window.MarketUI = { el: el, icon: icon, num: num, inches: inches, avatar: avatar, ownerLink: ownerLink, modeChip: modeChip, modeWords: modeWords, starButton: starButton, wallet: wallet, say: say, tip: tip, profileUrl: profileUrl, safeImg: safeImg };

  /* ======================================================================
     The market page
     ====================================================================== */
  var grid = document.getElementById('mk-grid');
  if (!grid) return;
  var params = new URLSearchParams(window.location.search);
  var state = { sort: params.get('sort') === 'top' ? 'top' : 'new', tag: (params.get('tag') || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 24), q: (params.get('q') || '').slice(0, 60), next: null, items: {}, me: null, seq: 0 };
  var more = document.getElementById('mk-more'), empty = document.getElementById('mk-empty'), qInput = document.getElementById('mk-q');
  var sheet = document.getElementById('mk-sheet'), sheetBody = document.getElementById('mk-sheet-body'), sheetLabel = document.getElementById('mk-sheet-label');
  var walletBox = document.getElementById('wallet');

  function syncUrl(extra) {
    var p = new URLSearchParams();
    if (state.sort !== 'new') p.set('sort', state.sort);
    if (state.tag) p.set('tag', state.tag);
    if (state.q) p.set('q', state.q);
    if (extra) p.set('d', extra);
    var s = p.toString();
    try { window.history.replaceState(null, '', window.location.pathname + (s ? '?' + s : '')); } catch (e) { /* file:// */ }
  }

  function card(item) {
    state.items[item.id] = item;
    var li = el('li', 'mk-card'); li.setAttribute('data-id', item.id);
    var pic = el('button', 'mk-card__pic'); pic.type = 'button'; pic.setAttribute('aria-label', item.title + ', by @' + item.owner.handle + ', ' + modeWords(item) + '. Details');
    if (item.thumb && safeImg(item.thumb)) { var img = el('img'); img.src = item.thumb; img.alt = ''; img.loading = 'lazy'; img.decoding = 'async'; pic.appendChild(img); }
    var chip = modeChip(item); chip.classList.add('mk-card__chip'); pic.appendChild(chip);
    pic.addEventListener('click', function () { openSheet(item.id); });
    var row = el('div', 'mk-card__row'), title = el('button', 'mk-card__title', item.title); title.type = 'button'; title.tabIndex = -1;
    title.addEventListener('click', function () { openSheet(item.id); });
    row.appendChild(title); row.appendChild(starButton(item));
    li.appendChild(pic); li.appendChild(row); li.appendChild(ownerLink(item.owner));
    return li;
  }
  function skeleton() { grid.textContent = ''; for (var i = 0; i < 8; i++) { var li = el('li', 'mk-skel'); li.setAttribute('aria-hidden', 'true'); grid.appendChild(li); } }
  function load(reset) {
    var seq = ++state.seq;
    if (reset) { state.next = null; skeleton(); empty.hidden = true; more.hidden = true; }
    more.disabled = true;
    return API.list({ sort: state.sort, tag: state.tag, q: state.q, cursor: reset ? null : state.next }).then(function (r) {
      if (seq !== state.seq) return;
      if (reset) grid.textContent = '';
      var frag = document.createDocumentFragment();
      r.items.forEach(function (it) { frag.appendChild(card(it)); });
      grid.appendChild(frag);
      state.next = r.next; more.hidden = !r.next; more.disabled = false;
      empty.hidden = grid.children.length > 0;
      empty.textContent = state.q || state.tag ? 'No designs match that yet.' : 'Nothing here yet.';
    }, function (e) {
      if (seq !== state.seq) return;
      grid.textContent = ''; empty.hidden = false; empty.textContent = 'The marketplace could not be loaded. ' + ((e && e.message) || '');
    });
  }

  /* sort, tags, search */
  var sortBtns = document.querySelectorAll('[data-sort]');
  function paintSort() { for (var i = 0; i < sortBtns.length; i++) sortBtns[i].setAttribute('aria-pressed', sortBtns[i].getAttribute('data-sort') === state.sort ? 'true' : 'false'); }
  Array.prototype.forEach.call(sortBtns, function (b) {
    b.addEventListener('click', function () { var s = b.getAttribute('data-sort'); if (s === state.sort) return; state.sort = s; paintSort(); syncUrl(); load(true); });
  });
  var tagBox = document.getElementById('mk-tags');
  function paintTags() {
    tagBox.textContent = '';
    var list = [''].concat(API.TAGS);
    if (state.tag && list.indexOf(state.tag) === -1) list.push(state.tag);
    list.forEach(function (t) {
      var b = el('button', null, t ? t.charAt(0).toUpperCase() + t.slice(1) : 'All'); b.type = 'button';
      b.setAttribute('aria-pressed', t === state.tag ? 'true' : 'false');
      b.addEventListener('click', function () { if (state.tag === t) return; state.tag = t; paintTags(); syncUrl(); load(true); });
      tagBox.appendChild(b);
    });
  }
  function setTag(t) { state.tag = t; paintTags(); syncUrl(); load(true); }
  var qTimer = 0;
  qInput.value = state.q;
  qInput.addEventListener('input', function () {
    clearTimeout(qTimer);
    qTimer = setTimeout(function () { var v = qInput.value.trim().slice(0, 60); if (v === state.q) return; state.q = v; syncUrl(); load(true); }, 220);
  });
  more.addEventListener('click', function () { load(false); });

  /* ---------- detail sheet ---------- */
  var sheetId = null;
  function refreshWallet() {
    if (!API.demo && !(state.me && state.me.handle)) { walletBox.hidden = true; return Promise.resolve(null); }
    return API.wallet().then(function (w) { wallet(walletBox, w, state.me); return w; }, function () { walletBox.hidden = true; return null; });
  }
  function stats(item) {
    var box = el('div', 'mk-stats'), s = item.stats;
    function cell(v, words) { var d = el('div'); d.appendChild(el('b', null, v)); d.appendChild(el('span', null, words)); box.appendChild(d); }
    if (!s || !s.stitches) return null;
    cell(num(s.stitches), 'stitches'); cell(String(s.colors || 0), (s.colors === 1 ? 'colour' : 'colours'));
    cell(inches(s.width) + ' x ' + inches(s.height), 'inches');
    return box;
  }
  function renderSheet(item, msg) {
    sheetId = item.id; state.items[item.id] = item;
    sheetLabel.textContent = item.title;
    sheetBody.textContent = '';
    var pic = el('div', 'mk-sheet__pic');
    if (item.thumb && safeImg(item.thumb)) { var img = el('img'); img.src = item.thumb; img.alt = item.title + ', stitch preview'; pic.appendChild(img); }
    var side = el('div', 'mk-sheet__side');
    var head = el('div', 'stack'); head.style.setProperty('--gap', '8px');
    var h = el('h2', 'mk-sheet__title', item.title); h.id = 'mk-sheet-title'; head.appendChild(h);
    head.appendChild(ownerLink(item.owner));
    side.appendChild(head);
    var row = el('div', 'row'); row.appendChild(modeChip(item)); row.appendChild(starButton(item)); side.appendChild(row);
    if (item.description) side.appendChild(el('p', 'mk-sheet__desc', item.description));
    var st = stats(item); if (st) side.appendChild(st);
    if (item.tags && item.tags.length) {
      var tags = el('div', 'mk-tags');
      item.tags.forEach(function (t) { var a = el('a', null, '#' + t); a.href = 'market.html?tag=' + encodeURIComponent(t); a.addEventListener('click', function (e) { e.preventDefault(); EL.dialog.close(sheet); setTag(t); }); tags.appendChild(a); });
      side.appendChild(tags);
    }
    var actions = el('div', 'mk-actions');
    if (item.unlocked || item.mine) {
      var open = el('a', 'btn btn--primary', 'Open in Embroidr'); open.href = 'app.html?market=' + encodeURIComponent(item.id); open.id = 'mk-open'; actions.appendChild(open);
    } else if (item.mode === 'keys') {
      var un = el('button', 'btn btn--primary'); un.type = 'button'; un.id = 'mk-unlock';
      un.appendChild(icon('key')); un.appendChild(document.createTextNode('Unlock for ' + item.priceKeys + (item.priceKeys === 1 ? ' key' : ' keys')));
      un.addEventListener('click', function () { unlock(item, un); });
      actions.appendChild(un);
    }
    if (item.mine) { var ed = el('a', 'btn', 'Change on your profile'); ed.href = profileUrl(item.owner.handle); actions.appendChild(ed); }
    if (actions.children.length) side.appendChild(actions);
    var note = el('p', 'mk-msg'); note.id = 'mk-msg'; note.setAttribute('role', 'status');
    if (msg) { note.className = 'mk-msg mk-msg--warn'; note.textContent = msg; }
    else if (item.mode === 'show' && !item.mine) note.textContent = 'Show only. The owner keeps the file; enjoy the stitches.';
    else if (item.mode === 'keys' && !item.unlocked) note.textContent = 'Unlock once, open it forever. Keys come from stars: 1 key for every 10 stars your designs get.';
    else if (item.mine) note.textContent = 'Your design. It is ' + (item.visibility === 'public' ? 'public' : 'private') + ' and ' + modeWords(item) + '.';
    else note.textContent = 'Open it in Embroidr and make it yours.';
    side.appendChild(note);
    sheetBody.appendChild(pic); sheetBody.appendChild(side);
  }
  function unlock(item, btn) {
    btn.disabled = true;
    API.unlock(item.id).then(function (r) {
      item.unlocked = true; renderSheet(item);
      replaceCard(item);
      EL.toast('Unlocked. It is yours to open any time. ' + r.keys + (r.keys === 1 ? ' key' : ' keys') + ' left.', { kind: 'ok', label: 'Unlocked', timeout: 6000 });
      refreshWallet();
      var o = document.getElementById('mk-open'); if (o) o.focus();
    }, function (e) {
      btn.disabled = false;
      if (e && e.code === 'not-enough-keys') {
        var need = e.need || item.priceKeys;
        refreshWallet().then(function (w) {
          var have = e.have != null ? e.have : w ? w.keys : 0;
          renderSheet(item, 'Not enough keys yet: this one needs ' + need + ' and you have ' + have + '. Share your own designs; every 10 stars they get give you a key.');
        });
      } else if (e && e.code === 'auth') { renderSheet(item, 'Sign in to unlock designs. You can sign in from the editor.'); say(e, 'Unlock'); }
      else say(e, 'Unlock');
    });
  }
  function replaceCard(item) {
    var old = grid.querySelector('.mk-card[data-id="' + (window.CSS && CSS.escape ? CSS.escape(item.id) : item.id) + '"]');
    if (old) old.parentNode.replaceChild(card(item), old);
  }
  function openSheet(id) {
    var cached = state.items[id];
    if (cached) renderSheet(cached);
    else { sheetBody.textContent = ''; sheetLabel.textContent = 'Design'; sheetBody.appendChild(el('p', 'muted', 'Loading')); }
    EL.dialog.open(sheet); syncUrl(id);
    API.get(id).then(function (item) { if (sheet.open && (!sheetId || sheetId === id || !cached)) renderSheet(item); }, function (e) {
      if (!cached) { sheetBody.textContent = ''; sheetBody.appendChild(el('p', 'mk-msg mk-msg--warn', (e && e.message) || 'That design could not be found.')); }
    });
  }
  sheet.addEventListener('close', function () { sheetId = null; syncUrl(); });

  /* ---------- start ---------- */
  document.getElementById('mk-demo').hidden = !API.demo;
  paintSort(); paintTags();
  var first = load(true);
  API.me().then(function (me) { state.me = me; return refreshWallet(); });
  var d = params.get('d');
  if (d && /^[A-Za-z0-9_-]{1,64}$/.test(d)) first.then(function () { openSheet(d); });
  window.MarketPage = { reload: function () { return load(true); }, open: openSheet, wallet: refreshWallet };
})();
