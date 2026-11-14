/* ==========================================================================
   EMBROIDERY LABS - js/account.js
   Accounts, plans and saved designs. OFF unless js/config.js sets apiBase.

   apiBase null (the default): this file does nothing at all. Exports are
   made in the browser and stay free, exactly as before.

   apiBase set (server/README.md):
     - "Sign in" in the top bar (Google Identity Services, loaded only then)
     - an account menu: plan, exports left, Upgrade, Manage billing,
       Save to my account, My designs, Sign out
     - window.EL_ACCOUNT.export: io.js hands the machine-file export to the
       server, which checks the plan and counts the export. Drawing, preview
       and mockups stay in the browser and free.
   ========================================================================== */
(function () {
  'use strict';
  var cfg = window.EL_CONFIG || {};
  var API = typeof cfg.apiBase === 'string' && cfg.apiBase ? cfg.apiBase.replace(/\/+$/, '') : null;
  if (!API) return;
  var Editor = window.Editor, EL = window.EL;
  if (!Editor || !EL) return;
  var M = Editor.Model, IO = Editor.IO;

  var GIS_SRC = 'https://accounts.google.com/gsi/client';
  var IDS_KEY = 'el-cloud-ids';           /* tab id -> saved design id, so Save updates the same design */
  var state = { loaded: false, signedIn: false, me: null };
  var slot = document.getElementById('account-slot');
  var pendingExport = null;               /* the format to export once signed in */
  var menuOpen = false;

  function toast(msg, opts) { return (Editor.toast || EL.toast)(msg, opts); }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function money(n) { return '$' + Number(n).toFixed(2); }

  /* ---------- styles: tokens only (css/base.css) -------------------------------------- */
  var css = [
    '.acct{position:relative;display:inline-flex;flex:none}',
    '.acct[hidden]{display:none}',
    '.acct__btn{gap:6px;padding:0 6px 0 4px}',
    '.acct__face{display:inline-grid;place-items:center;width:22px;height:22px;border-radius:50%;background:var(--sunken);color:var(--ink-2);font-size:var(--fs-1);font-weight:var(--w-semi);overflow:hidden;flex:none}',
    '.acct__face img{width:100%;height:100%;object-fit:cover}',
    '.acct__left{font-size:var(--fs-1);color:var(--ink-3);font-variant-numeric:tabular-nums;white-space:nowrap}',
    '.acct .menu{min-width:260px}',
    '.acct__head{display:grid;gap:2px;padding:8px 8px 10px;border-bottom:1px solid var(--line-1);margin-bottom:4px}',
    '.acct__name{font-weight:var(--w-semi);font-size:var(--fs-2);color:var(--ink-1);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.acct__mail{font-size:var(--fs-1);color:var(--ink-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.acct__plan{display:flex;justify-content:space-between;gap:8px;margin-top:8px;font-size:var(--fs-1);color:var(--ink-2)}',
    '.acct__meter{height:4px;border-radius:var(--r-round);background:var(--sunken);overflow:hidden;margin-top:4px}',
    '.acct__meter>i{display:block;height:100%;background:var(--signal);border-radius:inherit}',
    '.acct__sep{height:1px;background:var(--line-1);margin:4px 0}',
    '.acct-dlg .dialog__body{display:grid;gap:var(--s-3)}',
    '.acct-dlg p{margin:0;color:var(--ink-2);font-size:var(--fs-3);line-height:var(--lh-3)}',
    '.acct-gis{min-height:44px;display:flex;align-items:center;justify-content:center}',
    '.acct-plans{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:var(--s-2)}',
    '.acct-plan{display:grid;gap:4px;align-content:start;padding:var(--s-3);border:1px solid var(--line-1);border-radius:var(--r-1);background:var(--panel)}',
    '.acct-plan.is-current{border-color:var(--signal)}',
    '.acct-plan__name{font-weight:var(--w-semi);color:var(--ink-1)}',
    '.acct-plan__price{font-size:var(--fs-5);line-height:var(--lh-5);color:var(--ink-1);font-variant-numeric:tabular-nums}',
    '.acct-plan__price small{font-size:var(--fs-1);color:var(--ink-3)}',
    '.acct-plan__what{font-size:var(--fs-2);color:var(--ink-2)}',
    '.acct-plan .btn{margin-top:var(--s-2)}',
    '.acct-list{display:grid;gap:2px}',
    '.acct-row{display:flex;align-items:center;gap:var(--s-2);min-height:var(--row-h);padding:4px 4px 4px var(--s-2);border-radius:var(--r-1)}',
    '.acct-row:hover{background:var(--hover)}',
    '.acct-row__name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:var(--w-semi);font-size:var(--fs-2)}',
    '.acct-row__when{font-size:var(--fs-1);color:var(--ink-3);white-space:nowrap}',
    '.acct-empty{color:var(--ink-3);font-size:var(--fs-2);padding:var(--s-2)}',
    '@media (max-width: 700px){.acct__left{display:none}.acct .menu{position:fixed;left:var(--s-2);right:var(--s-2);top:calc(var(--bar-h) + 4px)}}'
  ].join('\n');
  var style = document.createElement('style'); style.id = 'acct-style'; style.textContent = css; document.head.appendChild(style);

  /* ---------- talking to the server ------------------------------------------------------ */
  function api(path, opts) {
    opts = opts || {};
    var init = { method: opts.method || 'GET', credentials: 'include', headers: {} };
    if (opts.body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(opts.body); }
    return fetch(API + path, init).then(null, function () {
      throw new Error('Could not reach the EmbroideryLabs server. Check your connection and try again.');
    });
  }
  function readJson(r) { return r.json().then(null, function () { return {}; }); }
  function apiJson(path, opts) {
    return api(path, opts).then(function (r) {
      return readJson(r).then(function (b) {
        if (r.status === 401) setSignedOut();
        if (!r.ok) { var e = new Error(b.message || 'Something went wrong. Try again.'); e.status = r.status; e.body = b; throw e; }
        return b;
      });
    });
  }

  function refresh() {
    return apiJson('/api/me').then(function (b) {
      state.loaded = true; state.me = b; state.signedIn = !!b.signedIn;
      render();
      if (!state.signedIn) loadGis();
      return b;
    }, function (err) {
      state.loaded = true;
      render();
      throw err;
    });
  }
  function setSignedOut() {
    if (!state.signedIn) return;
    state.signedIn = false;
    if (state.me) { state.me.signedIn = false; state.me.user = null; }
    render(); loadGis();
  }

  /* ---------- Google Identity Services ----------------------------------------------------- */
  var gis = null;   /* Promise of window.google.accounts.id */
  function clientId() { return cfg.googleClientId || (state.me && state.me.googleClientId) || null; }
  function loadGis() {
    if (gis) return gis;
    gis = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = GIS_SRC; s.async = true; s.defer = true;
      s.onload = function () {
        var id = window.google && window.google.accounts && window.google.accounts.id;
        if (!id || !clientId()) { reject(new Error('Google sign-in is not set up.')); return; }
        id.initialize({ client_id: clientId(), callback: onCredential, ux_mode: 'popup', auto_select: false, cancel_on_tap_outside: true, itp_support: true });
        resolve(id);
      };
      s.onerror = function () { reject(new Error('Google sign-in could not load. Check your connection or content blockers.')); };
      document.head.appendChild(s);
    });
    gis.then(null, function () { gis = null; });
    return gis;
  }
  function onCredential(resp) {
    if (!resp || !resp.credential) return;
    apiJson('/api/auth/google', { method: 'POST', body: { credential: resp.credential } }).then(function (b) {
      state.me = Object.assign({}, state.me || {}, b); state.signedIn = true;
      closeDialog();
      render();
      toast('Signed in as ' + (b.user && (b.user.name || b.user.email)) + '. ' + leftText(), { kind: 'ok', label: 'Account' });
      if (pendingExport) { var f = pendingExport; pendingExport = null; IO.exportFile(f); }
    }, function (err) { toast(err.message, { kind: 'bad', label: 'Sign in' }); });
  }

  /* ---------- words ---------------------------------------------------------------------------- */
  function plan(id) { var list = (state.me && state.me.plans) || []; for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i]; return null; }
  function leftText() {
    var x = state.me && state.me.exports; if (!x) return '';
    if (x.limit === null) return 'Unlimited exports.';
    var n = x.left;
    return n + (n === 1 ? ' export' : ' exports') + ' left' + (x.per === 'month' ? ' this month.' : '.');
  }
  function shortLeft() {
    var x = state.me && state.me.exports; if (!x) return '';
    return x.limit === null ? 'Unlimited' : x.left + ' left';
  }
  function ago(ms) {
    var s = Math.max(0, (Date.now() - ms) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    if (s < 86400) return Math.round(s / 3600) + ' h ago';
    var d = Math.round(s / 86400); return d === 1 ? 'yesterday' : d < 30 ? d + ' days ago' : new Date(ms).toLocaleDateString();
  }

  /* ---------- top bar: button and menu ---------------------------------------------------------- */
  function render() {
    if (!slot) return;
    slot.hidden = false;
    slot.textContent = '';
    menuOpen = false;
    if (!state.loaded) return;
    if (!state.signedIn) {
      var b = el('button', 'btn btn--ghost', 'Sign in');
      b.type = 'button'; b.id = 'acct-signin';
      b.addEventListener('click', function () { openSignIn(); });
      slot.appendChild(b);
      return;
    }
    var me = state.me, u = me.user || {};
    var btn = el('button', 'btn btn--ghost acct__btn');
    btn.type = 'button'; btn.id = 'acct-btn';
    btn.setAttribute('aria-haspopup', 'menu'); btn.setAttribute('aria-expanded', 'false'); btn.setAttribute('aria-controls', 'acct-menu');
    btn.setAttribute('aria-label', 'Account: ' + (u.name || u.email) + ', ' + (me.planLabel || '') + ', ' + leftText());
    var face = el('span', 'acct__face');
    if (u.picture) { var img = document.createElement('img'); img.alt = ''; img.referrerPolicy = 'no-referrer'; img.src = u.picture; img.onerror = function () { face.textContent = initial(u); }; face.appendChild(img); }
    else face.textContent = initial(u);
    btn.appendChild(face);
    btn.appendChild(el('span', 'acct__left', shortLeft()));
    slot.appendChild(btn);

    var menu = el('div', 'menu'); menu.id = 'acct-menu'; menu.setAttribute('role', 'menu'); menu.setAttribute('aria-label', 'Account'); menu.hidden = true;
    var head = el('div', 'acct__head');
    head.appendChild(el('span', 'acct__name', u.name || u.email));
    if (u.name) head.appendChild(el('span', 'acct__mail', u.email));
    var x = me.exports || {};
    var pl = el('div', 'acct__plan');
    pl.appendChild(el('span', null, (me.planLabel || 'Free') + ' plan' + (me.billing && me.billing.cancelAtPeriodEnd ? ', ends soon' : '')));
    pl.appendChild(el('span', 'num', x.limit === null ? 'Unlimited exports' : x.left + ' of ' + x.limit + ' exports left'));
    head.appendChild(pl);
    if (x.limit !== null && x.limit) {
      var meter = el('div', 'acct__meter'), fill = el('i');
      fill.style.width = Math.round(100 * Math.min(1, x.left / x.limit)) + '%';
      meter.appendChild(fill); head.appendChild(meter);
    }
    menu.appendChild(head);

    var hobby = plan('hobby'), pro = plan('pro');
    if (me.plan === 'free' && hobby) menu.appendChild(item('Upgrade to Hobby', money(hobby.price) + '/mo', hobby.limit + ' exports a month.', function () { upgrade('hobby'); }));
    if (me.plan !== 'pro' && pro) menu.appendChild(item(me.plan === 'free' ? 'Upgrade to Pro' : 'Switch to Pro', money(pro.price) + '/mo', 'Unlimited exports.', function () { upgrade('pro'); }));
    if (me.billing && me.billing.customer) menu.appendChild(item('Manage billing', '', 'Change plan, card or cancel.', manageBilling));
    menu.appendChild(el('div', 'acct__sep'));
    menu.appendChild(item('Save to my account', '', 'Keep this design in your account.', saveCloud));
    menu.appendChild(item('My designs…', '', 'Open a design you saved.', openDesigns));
    menu.appendChild(el('div', 'acct__sep'));
    menu.appendChild(item('Sign out', '', '', signOut));
    slot.appendChild(menu);

    btn.addEventListener('click', function () { if (menuOpen) closeMenu(false); else openMenu(); });
    menu.addEventListener('keydown', function (e) {
      var items = Array.prototype.slice.call(menu.querySelectorAll('button')), i = items.indexOf(document.activeElement), k = e.key;
      if (k === 'ArrowDown' || k === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); items[(i + (k === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus(); }
      else if (k === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenu(true); }
      else if (k === 'Tab') closeMenu(false);
    });
  }
  function initial(u) { return String(u.name || u.email || '?').trim().charAt(0).toUpperCase() || '?'; }
  function item(label, num, note, fn) {
    var b = el('button'); b.type = 'button'; b.setAttribute('role', 'menuitem'); b.tabIndex = -1;
    b.appendChild(el('span', null, label));
    if (num) b.appendChild(el('span', 'num', num));
    if (note) b.appendChild(el('small', null, note));
    b.addEventListener('click', function () { closeMenu(false); fn(); });
    return b;
  }
  function openMenu() {
    var menu = document.getElementById('acct-menu'), btn = document.getElementById('acct-btn'); if (!menu) return;
    menuOpen = true; menu.hidden = false; btn.setAttribute('aria-expanded', 'true');
    var first = menu.querySelector('button'); if (first) first.focus();
  }
  function closeMenu(focusBack) {
    var menu = document.getElementById('acct-menu'), btn = document.getElementById('acct-btn');
    menuOpen = false;
    if (menu) menu.hidden = true;
    if (btn) { btn.setAttribute('aria-expanded', 'false'); if (focusBack) btn.focus(); }
  }
  document.addEventListener('pointerdown', function (e) { if (menuOpen && slot && !slot.contains(e.target)) closeMenu(false); }, true);

  /* ---------- dialogs ------------------------------------------------------------------------------ */
  var dlg = null;
  function closeDialog() { if (dlg) EL.dialog.close(dlg); }
  function dialog(title, build, foot) {
    closeDialog();
    var d = el('dialog', 'dialog acct-dlg'); d.id = 'acct-dialog'; d.setAttribute('aria-labelledby', 'acct-dialog-title');
    var head = el('div', 'dialog__head'), t = el('span', 'label', title); t.id = 'acct-dialog-title';
    var x = el('button', 'btn btn--ghost btn--icon'); x.type = 'button'; x.setAttribute('aria-label', 'Close');
    x.innerHTML = '<svg viewBox="0 0 14 14" aria-hidden="true"><path d="M3 3l8 8M11 3l-8 8"/></svg>';
    x.addEventListener('click', function () { EL.dialog.close(d); });
    head.appendChild(t); head.appendChild(x);
    var body = el('div', 'dialog__body');
    build(body);
    d.appendChild(head); d.appendChild(body);
    if (foot) { var f = el('div', 'dialog__foot'); foot(f); d.appendChild(f); }
    d.addEventListener('close', function () { if (dlg === d) dlg = null; d.remove(); });
    d.addEventListener('click', function (e) { if (e.target === d) EL.dialog.close(d); });
    document.body.appendChild(d);
    dlg = d;
    EL.dialog.open(d);
    return d;
  }

  function planCards(box, current) {
    var wrap = el('div', 'acct-plans');
    ((state.me && state.me.plans) || []).forEach(function (p) {
      var card = el('div', 'acct-plan' + (p.id === current ? ' is-current' : ''));
      card.appendChild(el('span', 'acct-plan__name', p.label));
      var price = el('span', 'acct-plan__price', p.price ? money(p.price) : '$0');
      if (p.price) price.appendChild(el('small', null, ' /month'));
      card.appendChild(price);
      card.appendChild(el('span', 'acct-plan__what', p.limit === null ? 'Unlimited exports' : p.per === 'total' ? p.limit + ' exports to try it' : p.limit + ' exports a month'));
      if (p.id === current) card.appendChild(el('span', 'field__hint', 'Your plan'));
      else if (p.price && state.signedIn && current !== 'pro') {
        var b = el('button', p.id === 'hobby' ? 'btn btn--primary' : 'btn', 'Choose ' + p.label);
        b.type = 'button'; b.setAttribute('data-plan', p.id);
        b.addEventListener('click', function () { upgrade(p.id); });
        card.appendChild(b);
      }
      wrap.appendChild(card);
    });
    box.appendChild(wrap);
  }

  function openSignIn(reason) {
    dialog('Sign in', function (body) {
      body.appendChild(el('p', null, reason || 'Sign in with Google to export machine files and keep your designs in your account.'));
      var g = el('div', 'acct-gis'); g.id = 'acct-gis';
      g.appendChild(el('span', 'field__hint', 'Loading Google sign-in…'));
      body.appendChild(g);
      if (state.me && state.me.plans) planCards(body, null);
      body.appendChild(el('span', 'field__hint', 'Drawing, stitch preview and mockups stay free without an account. To make a machine file, your design is sent to our server. We keep your name, email, your saved designs and a count of your exports.'));
      loadGis().then(function (id) {
        if (!document.body.contains(g)) return;
        g.textContent = '';
        id.renderButton(g, { type: 'standard', theme: 'outline', size: 'large', text: 'signin_with', shape: 'pill', logo_alignment: 'left' });
      }, function (err) { g.textContent = ''; g.appendChild(el('span', 'field__hint', err.message)); });
    });
  }

  function openPlans(message) {
    var current = state.me && state.me.plan;
    dialog('Pick a plan', function (body) {
      body.appendChild(el('p', null, message || 'More exports when you need them.'));
      planCards(body, current);
      body.appendChild(el('span', 'field__hint', 'Paid by card through Stripe. Cancel any time in Manage billing.'));
    });
  }

  function openDesigns() {
    var d = dialog('My designs', function (body) {
      body.appendChild(el('div', 'acct-empty', 'Loading…'));
    });
    var body = d.querySelector('.dialog__body');
    apiJson('/api/projects').then(function (b) {
      body.textContent = '';
      var list = b.projects || [];
      if (!list.length) { body.appendChild(el('div', 'acct-empty', 'Nothing saved yet. Use Save to my account in this menu.')); return; }
      var box = el('div', 'acct-list');
      list.forEach(function (p) {
        var row = el('div', 'acct-row');
        row.appendChild(el('span', 'acct-row__name', p.name));
        row.appendChild(el('span', 'acct-row__when', ago(p.updatedAt)));
        var open = el('button', 'btn', 'Open'); open.type = 'button';
        open.addEventListener('click', function () { openCloud(p.id); });
        var del = el('button', 'btn btn--ghost', 'Delete'); del.type = 'button';
        del.addEventListener('click', function () {
          EL.confirm('Delete "' + p.name + '" from your account? This cannot be undone.', { title: 'Delete design', confirmLabel: 'Delete', cancelLabel: 'Keep', danger: true }).then(function (yes) {
            if (!yes) return;
            apiJson('/api/projects/' + encodeURIComponent(p.id), { method: 'DELETE' }).then(function () {
              forgetId(p.id); row.remove();
              toast('Deleted "' + p.name + '".', { label: 'My designs' });
            }, function (err) { toast(err.message, { kind: 'bad', label: 'My designs' }); });
          });
        });
        row.appendChild(open); row.appendChild(del);
        box.appendChild(row);
      });
      body.appendChild(box);
      body.appendChild(el('span', 'field__hint', list.length + ' of ' + (b.max || 200) + ' designs.'));
    }, function (err) { body.textContent = ''; body.appendChild(el('div', 'acct-empty', err.message)); });
  }

  /* ---------- saved designs ------------------------------------------------------------------------- */
  function ids() { var v = EL.store.get(IDS_KEY, {}); return v && typeof v === 'object' ? v : {}; }
  function tabKey() { return (Editor.Tabs && Editor.Tabs.active) || 'single'; }
  function newId() {
    var b = new Uint8Array(12); window.crypto.getRandomValues(b);
    return 'd_' + Array.prototype.map.call(b, function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
  }
  function forgetId(pid) { var m = ids(); Object.keys(m).forEach(function (k) { if (m[k] === pid) delete m[k]; }); EL.store.set(IDS_KEY, m); }
  function saveCloud() {
    if (!M.doc.objects.length) { toast('Nothing to save yet. Draw a shape first.', { kind: 'bad', label: 'Save' }); return; }
    var m = ids(), key = tabKey(), pid = m[key] || newId();
    apiJson('/api/projects/' + encodeURIComponent(pid), { method: 'PUT', body: { name: M.doc.name, data: IO.payload() } }).then(function (b) {
      m[key] = pid; EL.store.set(IDS_KEY, m);
      toast((b.created ? 'Saved "' : 'Updated "') + b.name + '" in your account.', { kind: 'ok', label: 'Saved' });
    }, function (err) {
      if (err.status === 409) { delete m[key]; EL.store.set(IDS_KEY, m); }
      toast(err.message, { kind: 'bad', label: 'Save' });
    });
  }
  function openCloud(pid) {
    apiJson('/api/projects/' + encodeURIComponent(pid)).then(function (p) {
      if (!p.data) throw new Error('That design could not be read.');
      closeDialog();
      var tab = Editor.Tabs ? Editor.Tabs.add(p.data, true) : null;
      if (Editor.Tabs && !tab) return;              /* too many tabs: Tabs said so */
      if (!Editor.Tabs) IO.applyPayload(p.data);
      var m = ids(); m[tabKey()] = pid; EL.store.set(IDS_KEY, m);
      toast('Opened "' + p.name + '".', { label: 'My designs' });
    }).then(null, function (err) { toast(err.message, { kind: 'bad', label: 'My designs' }); });
  }

  /* ---------- billing and sign-out ------------------------------------------------------------------- */
  function upgrade(planId) {
    if (!state.signedIn) { openSignIn('Sign in first, then pick your plan.'); return; }
    if (state.me && state.me.payments === false) { toast('Plans are not open yet. Check back soon.', { label: 'Plans' }); return; }
    try { IO.saveNow(); } catch (e) { /* the design is autosaved anyway */ }
    apiJson('/api/billing/checkout', { method: 'POST', body: { plan: planId } }).then(function (b) {
      if (b.url) window.location.assign(b.url);
    }, function (err) { toast(err.message, { kind: 'bad', label: 'Plans' }); });
  }
  function manageBilling() {
    try { IO.saveNow(); } catch (e) { /* autosaved anyway */ }
    apiJson('/api/billing/portal', { method: 'POST' }).then(function (b) {
      if (b.url) window.location.assign(b.url);
    }, function (err) { toast(err.message, { kind: 'bad', label: 'Billing' }); });
  }
  function signOut() {
    apiJson('/api/auth/logout', { method: 'POST' }).then(function () {
      state.signedIn = false; if (state.me) state.me.user = null;
      try { if (window.google && window.google.accounts) window.google.accounts.id.disableAutoSelect(); } catch (e) { /* not loaded */ }
      render(); loadGis();
      toast('Signed out.', { label: 'Account' });
    }, function (err) { toast(err.message, { kind: 'bad', label: 'Account' }); });
  }

  /* ---------- the export hook (js/editor/io.js) ------------------------------------------------------- */
  function header(r, name) { try { return r.headers.get(name); } catch (e) { return null; } }
  function exportViaServer(ctx) {
    var ready = state.loaded ? Promise.resolve() : refresh().then(null, function () {});
    return ready.then(function () {
      if (!state.signedIn) {
        pendingExport = ctx.format;
        openSignIn('Sign in to export your file. Free accounts get ' + ((plan('free') || {}).limit || 3) + ' machine files, no card needed.');
        return null;
      }
      return api('/api/export', { method: 'POST', body: { design: ctx.design, format: ctx.format } }).then(function (r) {
        if (r.ok) {
          return r.arrayBuffer().then(function (buf) {
            var fname = header(r, 'X-EL-Filename');
            var left = header(r, 'X-EL-Exports-Left');
            if (state.me && state.me.exports && left != null) {
              state.me.exports.left = left === 'unlimited' ? null : Number(left);
              if (left !== 'unlimited') state.me.exports.used = state.me.exports.limit - state.me.exports.left;
              render();
            }
            if (left === '1' || left === '0') setTimeout(function () { toast(left === '0' ? 'That was your last export on this plan.' : '1 export left on this plan.', { label: 'Account', action: { label: 'See plans', onClick: function () { openPlans(); } } }); }, 400);
            return {
              filename: fname ? decodeURIComponent(fname) : (ctx.name || 'design') + '.' + ctx.format,
              bytes: new Uint8Array(buf),
              mime: header(r, 'Content-Type') || 'application/octet-stream',
              format: ctx.format,
              stitches: Number(header(r, 'X-EL-Stitches')) || 0
            };
          });
        }
        return readJson(r).then(function (b) {
          if (r.status === 401) {
            setSignedOut(); pendingExport = ctx.format;
            openSignIn('Your sign-in has expired. Sign in again to export.');
            return null;
          }
          if (r.status === 402) {
            if (state.me && state.me.exports) { state.me.exports.left = 0; render(); }
            openPlans(b.message);
            return null;
          }
          throw new Error(b.message || 'Export failed. Try again.');
        });
      });
    });
  }

  window.EL_ACCOUNT = {
    export: exportViaServer,
    refresh: refresh,
    state: function () { return JSON.parse(JSON.stringify(state)); },
    openPlans: openPlans,
    openSignIn: openSignIn
  };

  /* honest copy now that machine files are made online */
  var note = document.getElementById('sew-note');
  if (note) note.textContent = 'Machine files are made on our server with the same engine, checked against a reference library, not test-sewn. Sew a test on scrap fabric first.';
  Array.prototype.forEach.call(document.querySelectorAll('.status .dro'), function (d) {
    var l = d.querySelector('.label'), n = d.querySelector('.num');
    if (l && n && l.textContent === 'Local' && n.textContent === 'No upload') { l.textContent = 'Export'; n.textContent = 'Online'; }
  });

  /* ---------- start ------------------------------------------------------------------------------------ */
  var q = null;
  try { q = new URLSearchParams(window.location.search).get('checkout'); } catch (e) { q = null; }
  if (q) { try { var u = new URL(window.location.href); u.searchParams.delete('checkout'); window.history.replaceState(null, '', u.pathname + u.search + u.hash); } catch (e) { /* keep the URL */ } }
  render();
  refresh().then(function () {
    if (q === 'done') {
      /* Stripe tells the server by webhook, which can take a few seconds */
      var tries = 0;
      (function poll() {
        if (state.me && state.me.plan && state.me.plan !== 'free') { toast('Thank you. You are on ' + state.me.planLabel + ' now. ' + leftText(), { kind: 'ok', label: 'Plan', timeout: 8000 }); return; }
        if (++tries > 6) { toast('Payment received. Your plan shows up here in a minute.', { label: 'Plan', timeout: 8000 }); return; }
        setTimeout(function () { refresh().then(poll, poll); }, 2000);
      })();
    }
  }, function () {
    if (slot) { slot.textContent = ''; slot.hidden = true; }
    window.EL_ACCOUNT.export = function () { throw new Error('The EmbroideryLabs server cannot be reached right now, so files cannot be exported. Try again in a minute.'); };
    /* try again later: the server may just be waking up */
    setTimeout(function () { refresh().then(function () { window.EL_ACCOUNT.export = exportViaServer; }, function () {}); }, 15000);
  });
})();
