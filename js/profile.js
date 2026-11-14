/* ==========================================================================
   EMBROIDERY LABS - js/profile.js (profile.html, also served as /u/<handle>)
   A member: avatar, name, handle, joined, stats, badges, a year of activity (53 x 7 cells, like GitHub)
   and their designs. On your own profile: Public / Private tabs, and per design its visibility, its mode
   (Free / Keys 1-5 / Show only; selling for money is not built yet), its title and Delete (asked in place).
   Needs js/market.js (MarketUI) and js/market-api.js.
   ========================================================================== */
(function () {
  'use strict';
  var API = window.MarketAPI, UI = window.MarketUI, EL = window.EL, R = window.MarketRules;
  var box = document.getElementById('pf');
  if (!API || !UI || !EL || !R || !box) return;
  var el = UI.el, icon = UI.icon, num = UI.num;
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var BADGE_ICON = { 'first-design': 'needle', 'first-star': 'star', 'stars-100': 'star', 'stars-1000': 'star', 'stars-10000': 'sun', 'streak-7': 'flame', 'first-unlock': 'key', popular: 'heart', 'early-member': 'sprout', 'free-sewout': 'gift' };

  function wantedHandle() {
    var m = /^\/u\/([A-Za-z0-9-]{1,24})\/?$/.exec(window.location.pathname);
    if (m) return m[1].toLowerCase();
    var u = new URLSearchParams(window.location.search).get('u');
    return u && /^[A-Za-z0-9-]{1,24}$/.test(u) ? u.toLowerCase() : null;
  }
  function parseDay(s) { var p = String(s || '').split('-'); return p.length === 3 ? new Date(+p[0], +p[1] - 1, +p[2]) : null; }
  function ymd(d) { return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }
  function dayWords(d) { return DAYS[d.getDay()] + ', ' + MONTHS[d.getMonth()] + ' ' + d.getDate(); }
  function joinedWords(s) { var d = parseDay(String(s || '').slice(0, 10)); return d ? 'Joined ' + MONTHS[d.getMonth()] + ' ' + d.getFullYear() : ''; }

  /* ---------- activity graph: 53 weeks x 7 days, the last column is this week ---------- */
  function graph(activity) {
    var counts = {}, total = 0, max = 0;
    (activity || []).forEach(function (a) { var n = Math.max(0, a.count | 0); if (!n || !a.date) return; counts[a.date] = (counts[a.date] || 0) + n; });
    var today = new Date(); today.setHours(12, 0, 0, 0);
    var end = new Date(today); end.setDate(end.getDate() + (6 - end.getDay()));
    var start = new Date(end); start.setDate(start.getDate() - 370);
    var CELL = 11, STEP = 14, LEFT = 30, TOP = 18, COLS = 53;
    var W = LEFT + COLS * STEP, H = TOP + 7 * STEP;
    var NS = 'http://www.w3.org/2000/svg', svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H); svg.setAttribute('role', 'img');
    var days = [], i, d;
    for (i = 0; i < COLS * 7; i++) { d = new Date(start); d.setDate(start.getDate() + i); days.push(d); var c = d <= today ? counts[ymd(d)] || 0 : 0; total += c; if (c > max) max = c; }
    function level(n) { return !n ? 0 : Math.max(1, Math.min(4, Math.ceil(n / max * 4))); }
    var g = document.createElementNS(NS, 'g');
    days.forEach(function (day, k) {
      var r = document.createElementNS(NS, 'rect'), col = Math.floor(k / 7), row = k % 7, future = day > today, n = future ? 0 : counts[ymd(day)] || 0;
      r.setAttribute('x', LEFT + col * STEP); r.setAttribute('y', TOP + row * STEP); r.setAttribute('width', CELL); r.setAttribute('height', CELL);
      r.setAttribute('class', future ? 'af' : 'a' + level(n));
      if (!future) { r.setAttribute('data-d', ymd(day)); r.setAttribute('data-n', n); }
      g.appendChild(r);
    });
    svg.appendChild(g);
    var lastLabel = -3;
    for (var col = 0; col < COLS; col++) {
      var first = days[col * 7], prev = col ? days[(col - 1) * 7] : null;
      if (prev && first.getMonth() === prev.getMonth()) continue;
      if (!prev && first.getDate() > 7) continue;          /* a half month at the left edge gets no label */
      if (col - lastLabel < 3) continue;
      var t = document.createElementNS(NS, 'text'); t.setAttribute('x', LEFT + col * STEP); t.setAttribute('y', 10); t.textContent = MONTHS[first.getMonth()];
      svg.appendChild(t); lastLabel = col;
    }
    [1, 3, 5].forEach(function (row) {
      var t = document.createElementNS(NS, 'text'); t.setAttribute('x', 0); t.setAttribute('y', TOP + row * STEP + 9); t.textContent = DAYS[row]; svg.appendChild(t);
    });
    svg.setAttribute('aria-label', num(total) + (total === 1 ? ' thing' : ' things') + ' done in the last year');
    function show(e) {
      var t = e.target; if (!t || !t.getAttribute || !t.getAttribute('data-d')) { UI.tip(null); return; }
      var n = +t.getAttribute('data-n'), day = parseDay(t.getAttribute('data-d')), b = t.getBoundingClientRect();
      UI.tip((n ? num(n) + (n === 1 ? ' thing' : ' things') : 'Nothing') + ' on ' + dayWords(day), b.left + b.width / 2, b.top);
    }
    svg.addEventListener('pointerover', show); svg.addEventListener('pointerdown', show);
    svg.addEventListener('pointerleave', function () { UI.tip(null); });

    var wrap = el('div', 'graph'), scroll = el('div', 'graph__scroll'); scroll.appendChild(svg); wrap.appendChild(scroll);
    var foot = el('div', 'graph__foot');
    foot.appendChild(el('span', null, num(total) + (total === 1 ? ' thing' : ' things') + ' in the last year: saves, shares, exports and stars given'));
    var legend = el('span', 'graph__legend'); legend.appendChild(el('span', null, 'Less'));
    for (i = 0; i < 5; i++) { var sw = el('i'); sw.style.background = 'var(--act-' + i + ')'; legend.appendChild(sw); }
    legend.appendChild(el('span', null, 'More')); foot.appendChild(legend); wrap.appendChild(foot);
    setTimeout(function () { scroll.scrollLeft = scroll.scrollWidth; }, 0);    /* the recent weeks first on a phone */
    return wrap;
  }

  /* ---------- badges ---------- */
  function badges(list, self) {
    var got = {}, row = el('div', 'badges');
    (list || []).forEach(function (b) { if (b && b.id) got[b.id] = b; });
    R.BADGES.forEach(function (b0) {
      var b = R.badge(b0.id) || b0;
      var have = got[b.id];
      if (!have && !self) return;
      var chip = el('span', 'badge' + (have ? '' : ' is-off')), ico = el('span', 'badge__ico');
      ico.appendChild(icon(BADGE_ICON[b.id] || 'star')); chip.appendChild(ico); chip.appendChild(el('span', null, b.label));
      var when = have && have.earnedAt ? parseDay(String(have.earnedAt).slice(0, 10)) : null;
      var words = have ? b.what + (when ? ' · ' + MONTHS[when.getMonth()] + ' ' + when.getDate() + ', ' + when.getFullYear() : '') : 'Not yet: ' + b.what.charAt(0).toLowerCase() + b.what.slice(1);
      chip.tabIndex = 0; chip.setAttribute('aria-label', b.label + '. ' + words); chip.setAttribute('data-tip', words);
      function on() { var r = chip.getBoundingClientRect(); UI.tip(words, r.left + r.width / 2, r.top); }
      chip.addEventListener('pointerenter', on); chip.addEventListener('focus', on);
      chip.addEventListener('pointerleave', function () { UI.tip(null); }); chip.addEventListener('blur', function () { UI.tip(null); });
      row.appendChild(chip);
    });
    if (!row.children.length) row.appendChild(el('span', 'muted', 'No badges yet.'));
    return row;
  }

  /* ---------- someone else's designs: cards like the market ---------- */
  function cards(items) {
    var ul = el('ul', 'mk-grid');
    items.forEach(function (item) {
      var li = el('li', 'mk-card'), pic = el('a', 'mk-card__pic'); pic.href = 'market.html?d=' + encodeURIComponent(item.id);
      pic.setAttribute('aria-label', item.title + ', ' + UI.modeWords(item) + '. Details');
      if (item.thumb && UI.safeImg(item.thumb)) { var img = el('img'); img.src = item.thumb; img.alt = ''; img.loading = 'lazy'; pic.appendChild(img); }
      var chip = UI.modeChip(item); chip.classList.add('mk-card__chip'); pic.appendChild(chip);
      var row = el('div', 'mk-card__row'), t = el('a', 'mk-card__title', item.title); t.href = pic.href; t.tabIndex = -1; t.style.textDecoration = 'none';
      row.appendChild(t); row.appendChild(UI.starButton(item));
      li.appendChild(pic); li.appendChild(row); ul.appendChild(li);
    });
    return ul;
  }

  /* ---------- your own designs: one row each, changed in place ---------- */
  var MODE_OPTIONS = [['free', 'Free'], ['keys-1', 'Keys: 1'], ['keys-2', 'Keys: 2'], ['keys-3', 'Keys: 3'], ['keys-4', 'Keys: 4'], ['keys-5', 'Keys: 5'], ['show', 'Show only'], ['sell', 'Sell — coming soon']];
  function modeValue(item) { return item.mode === 'keys' ? 'keys-' + item.priceKeys : item.mode; }
  function ownRow(item, view) {
    var row = el('div', 'pf-row'); row.setAttribute('data-id', item.id);
    var pic = el('a', 'pf-row__pic'); pic.href = 'market.html?d=' + encodeURIComponent(item.id); pic.setAttribute('aria-label', item.title + ': details');
    if (item.thumb && UI.safeImg(item.thumb)) { var img = el('img'); img.src = item.thumb; img.alt = ''; img.loading = 'lazy'; pic.appendChild(img); }
    var tbox = el('div', 'pf-row__title'), input = el('input', 'input'); input.value = item.title; input.maxLength = 80; input.setAttribute('aria-label', 'Title'); input.spellcheck = false;
    function saveTitle() {
      var v = input.value.replace(/\s+/g, ' ').trim();
      if (!v) { input.value = item.title; return; }
      if (v === item.title) return;
      API.update(item.id, { title: v }).then(function (it) { item.title = it.title; input.value = it.title; EL.toast('Title saved.', { kind: 'ok', label: 'Saved', timeout: 2500 }); }, function (e) { input.value = item.title; UI.say(e, 'Title'); });
    }
    input.addEventListener('change', saveTitle);
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); input.blur(); } else if (e.key === 'Escape') { input.value = item.title; input.blur(); } });
    var meta = el('div', 'pf-row__meta'), st = el('span', 'num'); st.textContent = '★ ' + num(item.stars); meta.appendChild(st);
    meta.appendChild(el('span', null, UI.modeWords(item)));
    tbox.appendChild(input); tbox.appendChild(meta);

    var vis = el('div', 'seg pf-row__vis'); vis.setAttribute('role', 'group'); vis.setAttribute('aria-label', 'Who can see it');
    [['public', 'Public'], ['private', 'Private']].forEach(function (v) {
      var b = el('button', null, v[1]); b.type = 'button'; b.setAttribute('data-vis', v[0]); b.setAttribute('aria-pressed', item.visibility === v[0] ? 'true' : 'false');
      b.addEventListener('click', function () {
        if (item.visibility === v[0]) return;
        API.update(item.id, { visibility: v[0] }).then(function (it) {
          item.visibility = it.visibility;
          EL.toast(it.visibility === 'public' ? item.title + ' is public now.' : item.title + ' is private now. Only you see it.', { kind: 'ok', label: 'Saved', timeout: 3500 });
          view.render();
        }, function (e) { UI.say(e, 'Visibility'); });
      });
      vis.appendChild(b);
    });

    var modeWrap = el('div', 'pf-row__mode'), sel = el('span', 'select'), select = el('select'); select.setAttribute('aria-label', 'How others get it');
    MODE_OPTIONS.forEach(function (o) { var op = el('option', null, o[1]); op.value = o[0]; if (o[0] === 'sell') op.disabled = true; select.appendChild(op); });
    select.value = modeValue(item);
    select.addEventListener('change', function () {
      var v = select.value, patch = v.indexOf('keys-') === 0 ? { mode: 'keys', priceKeys: +v.slice(5) } : { mode: v };
      API.update(item.id, patch).then(function (it) {
        item.mode = it.mode; item.priceKeys = it.priceKeys; meta.lastChild.textContent = UI.modeWords(item);
        EL.toast('Now ' + UI.modeWords(item) + '.', { kind: 'ok', label: 'Saved', timeout: 2500 });
      }, function (e) { select.value = modeValue(item); UI.say(e, 'Mode'); });
    });
    sel.appendChild(select); modeWrap.appendChild(sel);

    var open = el('a', 'btn btn--ghost pf-row__open', 'Open'); open.href = 'app.html?market=' + encodeURIComponent(item.id);
    var del = el('div', 'pf-row__del');
    function askDelete() {
      del.textContent = '';
      del.appendChild(el('span', 'pf-row__ask', 'Delete it?'));
      var yes = el('button', 'btn btn--danger', 'Delete'); yes.type = 'button';
      var no = el('button', 'btn', 'Keep'); no.type = 'button';
      yes.addEventListener('click', function () {
        yes.disabled = no.disabled = true;
        API.remove(item.id).then(function () {
          view.drop(item.id);
          EL.toast(item.title + ' was deleted.', { label: 'Deleted', timeout: 3500 });
        }, function (e) { yes.disabled = no.disabled = false; UI.say(e, 'Delete'); });
      });
      no.addEventListener('click', function () { plain(); var b = del.querySelector('button'); if (b) b.focus(); });
      del.appendChild(yes); del.appendChild(no); no.focus();
    }
    function plain() {
      del.textContent = '';
      var b = el('button', 'btn btn--ghost btn--danger', 'Delete'); b.type = 'button'; b.setAttribute('aria-label', 'Delete ' + item.title);
      b.addEventListener('click', askDelete); del.appendChild(b);
    }
    plain();
    row.appendChild(pic); row.appendChild(tbox); row.appendChild(vis); row.appendChild(modeWrap); row.appendChild(open); row.appendChild(del);
    return row;
  }
  function ownDesigns(items) {
    var wrap = el('div'), tab = 'public';
    var head = el('div', 'pf-sec__head'), tabs = el('div', 'tabs pf-tabs'); tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', 'Your designs');
    var body = el('div', 'pf-rows'); body.id = 'pf-rows'; body.setAttribute('role', 'tabpanel');
    var view = {
      render: function () {
        tabs.textContent = '';
        [['public', 'Public'], ['private', 'Private']].forEach(function (t) {
          var n = items.filter(function (i) { return i.visibility === t[0]; }).length;
          var b = el('button', null, t[1]); b.type = 'button'; b.setAttribute('role', 'tab'); b.setAttribute('data-tab', t[0]);
          b.setAttribute('aria-selected', tab === t[0] ? 'true' : 'false'); b.appendChild(el('span', 'num', String(n)));
          b.addEventListener('click', function () { tab = t[0]; view.render(); });
          tabs.appendChild(b);
        });
        body.textContent = '';
        var list = items.filter(function (i) { return i.visibility === tab; });
        if (!list.length) {
          var e = el('div', 'pf-empty');
          e.appendChild(document.createTextNode(tab === 'public' ? 'Nothing public yet. ' : 'Nothing private. '));
          var a = el('a', null, 'Share a design from Embroidr'); a.href = 'app.html'; e.appendChild(a);
          body.appendChild(e);
        } else list.forEach(function (it) { body.appendChild(ownRow(it, view)); });
        sellNote.hidden = !items.length;
      },
      drop: function (id) { items = items.filter(function (i) { return i.id !== id; }); view.render(); }
    };
    head.appendChild(tabs);
    var sellNote = el('span', 'pf-sell', 'Selling for money — coming soon');
    head.appendChild(sellNote);
    wrap.appendChild(head); wrap.appendChild(body);
    view.render();
    return wrap;
  }

  /* ---------- your name and handle ---------- */
  function editMe(user, whoBox, done) {
    var form = el('form', 'pf-handle');
    var name = el('input', 'input'); name.value = user.name || ''; name.maxLength = 60; name.setAttribute('aria-label', 'Name'); name.style.width = '200px';
    var hu = el('div', 'input-unit'), at = el('span', null, '@'), handle = el('input'); handle.value = user.handle; handle.maxLength = 24; handle.setAttribute('aria-label', 'Handle'); handle.spellcheck = false; handle.autocapitalize = 'off';
    hu.appendChild(at); hu.appendChild(handle);
    var save = el('button', 'btn btn--primary', 'Save'); save.type = 'submit';
    var cancel = el('button', 'btn', 'Cancel'); cancel.type = 'button';
    var msg = el('span', 'field__error'); msg.setAttribute('role', 'status');
    form.appendChild(name); form.appendChild(hu); form.appendChild(save); form.appendChild(cancel); form.appendChild(msg);
    cancel.addEventListener('click', function () { done(null); });
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var h = handle.value.trim().toLowerCase();
      if (!R.validHandle(h)) { msg.textContent = '3 to 24 letters, digits or dashes.'; handle.focus(); return; }
      var patch = {}; if (h !== user.handle) patch.handle = h; if (name.value.trim() && name.value.trim() !== user.name) patch.name = name.value.trim();
      if (!Object.keys(patch).length) { done(null); return; }
      save.disabled = true;
      API.updateMe(patch).then(function (me) { done(me); }, function (err) { save.disabled = false; msg.textContent = (err && err.message) || 'Could not save.'; });
    });
    whoBox.appendChild(form); name.focus();
  }

  /* ---------- the page ---------- */
  function render(user, me) {
    var self = !!(me && me.handle && me.handle === user.handle);
    document.title = (user.name || '@' + user.handle) + ' - Embroidr';
    box.textContent = ''; box.removeAttribute('aria-busy');
    if (API.demo) { var demo = el('p', 'mk-demo', 'Demo — saved on this device until sign-in is switched on.'); demo.style.marginTop = '0'; demo.style.marginBottom = 'var(--s-4)'; box.appendChild(demo); }

    var head = el('section', 'pf-head'); head.setAttribute('aria-label', 'Member');
    head.appendChild(UI.avatar(user));
    var who = el('div', 'pf-who'), h1 = el('h1', null, user.name || '@' + user.handle); h1.id = 'pf-name'; who.appendChild(h1);
    var line = el('p'); line.appendChild(document.createTextNode('@' + user.handle + (user.joined ? ' · ' + joinedWords(user.joined) : '')));
    if (self) {
      var edit = el('button', 'btn btn--ghost', 'Edit'); edit.type = 'button'; edit.style.height = '24px'; edit.style.marginLeft = '6px'; edit.id = 'pf-edit';
      edit.addEventListener('click', function () {
        line.hidden = true;
        editMe(user, who, function (changed) {
          if (!changed) { var f = who.querySelector('form'); if (f) f.remove(); line.hidden = false; return; }
          EL.toast('Saved.', { kind: 'ok', label: 'Profile', timeout: 2500 });
          var url = UI.profileUrl(changed.handle);
          try { window.history.replaceState(null, '', url); } catch (e) { /* file:// */ }
          start(changed.handle);
        });
      });
      line.appendChild(edit);
    }
    who.appendChild(line); head.appendChild(who);
    var stats = el('div', 'pf-stats');
    function stat(v, words) { var d = el('div'); d.appendChild(el('b', null, v)); d.appendChild(el('span', null, words)); stats.appendChild(d); return d; }
    var publicCount = user.designs.filter(function (d) { return d.visibility === 'public'; }).length;
    stat(num(self ? user.designs.length : publicCount), (self ? user.designs.length : publicCount) === 1 ? 'design' : 'designs');
    stat(num(user.starsReceived), user.starsReceived === 1 ? 'star' : 'stars');
    head.appendChild(stats);
    box.appendChild(head);

    if (self) {
      var wsec = el('section', 'wallet'); wsec.setAttribute('aria-label', 'Your stars and keys'); wsec.hidden = true; box.appendChild(wsec);
      API.wallet().then(function (w) { UI.wallet(wsec, w, null); }, function () { /* signed out */ });
    }

    function section(title, aside, content, id) {
      var s = el('section', 'pf-sec'); if (id) s.id = id;
      var h = el('div', 'pf-sec__head'); h.appendChild(el('h2', null, title)); if (aside) h.appendChild(el('span', 'muted', aside));
      s.appendChild(h); s.appendChild(content); box.appendChild(s); return s;
    }
    var earned = (user.badges || []).length;
    section('Badges', self ? earned + ' of ' + R.BADGES.length : null, badges(user.badges, self), 'pf-badges');
    section('Activity', null, graph(user.activity), 'pf-activity');
    if (self) {
      var s = el('section', 'pf-sec'); s.id = 'pf-designs'; var h2 = el('h2', 'visually-hidden', 'Your designs'); s.appendChild(h2);
      s.appendChild(ownDesigns(user.designs.slice())); box.appendChild(s);
    } else {
      var pub = user.designs.filter(function (d) { return d.visibility === 'public'; });
      var content = pub.length ? cards(pub) : el('div', 'pf-empty', 'No public designs yet.');
      section('Designs', null, content, 'pf-designs');
    }
  }
  function problem(text, link) {
    box.textContent = ''; box.removeAttribute('aria-busy');
    var e = el('div', 'pf-empty'); e.appendChild(document.createTextNode(text + ' '));
    if (link) { var a = el('a', null, link[0]); a.href = link[1]; e.appendChild(a); }
    box.appendChild(e);
  }
  function start(handle) {
    var meP = API.me();
    (handle ? Promise.resolve(handle) : meP.then(function (me) { return me && me.handle; })).then(function (h) {
      if (!h) { problem('Sign in from the editor to see your profile.', ['Open Embroidr', 'app.html']); return; }
      return Promise.all([API.user(h), meP]).then(function (r) { render(r[0], r[1]); }, function (e) {
        problem(e && e.code === 'not-found' ? (e.message || 'Nobody by that name here.') : 'This profile could not be loaded.', ['Back to the marketplace', 'market.html']);
      });
    });
  }
  /* profile.html has <base href="/"> (for /u/<handle>), so "#main" would point at the home page */
  var skip = document.querySelector('a.skip[href="#main"]');
  if (skip) skip.addEventListener('click', function (e) {
    var m = document.getElementById('main'); if (!m) return;
    e.preventDefault(); if (!m.hasAttribute('tabindex')) m.setAttribute('tabindex', '-1'); m.focus(); m.scrollIntoView();
  });
  window.ProfilePage = { reload: function () { start(wantedHandle()); } };
  start(wantedHandle());
})();
