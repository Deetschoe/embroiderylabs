/* ==========================================================================
   EMBROIDERY LABS - js/editor/publish.js
   The editor's side of the marketplace (js/market-api.js):
     - app.html?market=<id> opens that marketplace design in a tab of its own (like ?design=<id>);
       the address is cleaned afterwards so a reload does not open it twice
     - File > "Share to Marketplace..." (and the phone More menu): a small dialog with title, tags, who gets
       it (Free / Keys 1-5 / Show only), Public / Private and a picture of the stitches, then MarketAPI.publish
       and a toast with View
     - the demo market counts exports and saves for the activity graph (MarketAPI.note)
   Loaded after main.js, config.js and market-api.js. Uses Editor.Model / IO / View / Tools / Tabs, never
   writes the design except through IO.applyPayload (a new tab).
   ========================================================================== */
(function () {
  'use strict';
  var Editor = window.Editor, EL = window.EL, API = window.MarketAPI, R = window.MarketRules;
  if (!Editor || !Editor.Model || !Editor.IO || !EL || !API || !R) return;
  var M = Editor.Model, IO = Editor.IO, V = Editor.View, T = Editor.Tools;
  function toast(msg, opts) { return (Editor.toast || EL.toast)(msg, opts); }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

  /* ---------- open a marketplace design: app.html?market=<id> ---------- */
  function openFromMarket() {
    var m = /[?&]market=([A-Za-z0-9_-]{1,64})(?:&|$)/.exec(window.location.search || '');
    if (!m) return;
    var id = m[1];
    try { window.history.replaceState(null, '', window.location.pathname); } catch (e) { /* file:// */ }
    API.file(id).then(function (data) {
      var doc = data && typeof data === 'object' ? (data.doc && typeof data.doc === 'object' ? data.doc : data) : null;
      if (!doc || !Array.isArray(doc.objects)) throw new Error('This is not an Embroidr design.');
      if (Editor.Mockup && Editor.Mockup.isOpen()) Editor.Mockup.close();
      if (Editor.Tabs && M.doc.objects.length && !Editor.Tabs.add(null, true)) return;
      IO.applyPayload(data);
      if (T && T.current !== 'select') T.set('select');
      if (V.mode !== 'design') V.setMode('design');
      V.fit(); IO.saveNow();
      var n = M.doc.objects.length;
      toast('Opened ' + M.doc.name + ' from the Marketplace: ' + n + (n === 1 ? ' shape' : ' shapes') + '. It is yours to change.', { kind: 'ok', label: 'Marketplace', timeout: 7000 });
      if (Editor.say) Editor.say('Design opened: ' + M.doc.name);
    }).catch(function (e) {
      var why = e && e.code === 'locked' ? 'That design is locked. Unlock it in the Marketplace first.' : e && e.code === 'not-found' ? 'That design is not in the Marketplace any more.' : (e && e.message) || 'That design could not be opened.';
      toast(why, { kind: 'bad', label: 'Marketplace', timeout: 8000, action: { label: 'Marketplace', onClick: function () { window.location.href = 'market.html' + (e && e.code === 'locked' ? '?d=' + encodeURIComponent(id) : ''); } } });
    });
  }

  /* ---------- a picture of the stitches, as the market shows them ---------- */
  var libs = null;
  function loadLibs() {
    if (window.Realistic) return Promise.resolve(true);
    if (libs) return libs;
    function script(src) { return new Promise(function (res, rej) { var s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = rej; document.head.appendChild(s); }); }
    libs = script('js/realistic/core.js').then(function () { return script('js/realistic/realistic.js'); }).then(function () { return !!window.Realistic; }, function () { libs = null; return false; });
    return libs;
  }
  function toDataUrl(blob, size) {
    return new Promise(function (resolve) {
      var url = URL.createObjectURL(blob), img = new Image();
      img.onload = function () {
        var c = document.createElement('canvas'), out = null, q, s;
        for (s = size; s >= 240 && !out; s -= 120) {
          c.width = c.height = s; c.getContext('2d').drawImage(img, 0, 0, s, s);
          for (q = 0.86; q >= 0.5 && !out; q -= 0.12) {
            var d = c.toDataURL('image/webp', q);
            if (d.indexOf('data:image/webp') !== 0) d = c.toDataURL('image/png');
            if ((d.length - d.indexOf(',') - 1) * 3 / 4 <= R.MAX_THUMB_BYTES) out = d;
          }
        }
        URL.revokeObjectURL(url); resolve(out);
      };
      img.onerror = function () { URL.revokeObjectURL(url); resolve(null); };
      img.src = url;
    });
  }
  function makeThumb() {
    return Promise.all([loadLibs(), IO.fresh()]).then(function (r) {
      var result = r[1];
      if (!r[0] || !result || !result.totals || !result.totals.stitches) return { thumb: null, result: result };
      return window.Realistic.exportImage(result, { scene: 'swatch', fabric: 'twill', fabricColor: '#f3efe6', width: 480, height: 480, scale: 1, margin: 0.07 })
        .then(function (blob) { return toDataUrl(blob, 480); }, function () { return null; })
        .then(function (thumb) { return { thumb: thumb, result: result }; });
    });
  }

  /* ---------- the dialog ---------- */
  var css = [
    '.share-dlg .dialog__body{display:grid;grid-template-columns:184px minmax(0,1fr);gap:var(--s-5);align-items:start}',
    '.share-pic{display:grid;place-items:center;width:184px;aspect-ratio:1;border-radius:var(--r-0);background:#f3efe6;overflow:hidden;color:var(--ink-3);font-size:var(--fs-2);text-align:center;padding:0}',
    '.share-pic>img{width:100%;height:100%;object-fit:cover}',
    '.share-fields{display:grid;gap:var(--s-4);min-width:0}',
    '.share-fields .field>.label{color:var(--ink-2)}',
    '.share-tags{display:flex;flex-wrap:wrap;gap:6px}',
    '.share-tags>button{height:28px;padding:0 11px;border:1px solid var(--line-1);border-radius:var(--r-round);background:var(--raised);color:var(--ink-2);font:var(--w-medium) var(--fs-2)/1 var(--font-ui);cursor:pointer}',
    '.share-tags>button:hover{border-color:var(--line-2);color:var(--ink-1)}',
    '.share-tags>[aria-pressed="true"]{background:var(--ink-1);border-color:var(--ink-1);color:var(--ink-inv)}',
    '.share-row{display:flex;flex-wrap:wrap;align-items:center;gap:var(--s-2)}',
    '.share-row .seg{height:32px}',
    '.share-fields .seg{justify-self:start}',
    '.share-row .select>select{height:32px;min-width:110px}',
    '.share-soon{color:var(--ink-3);font-size:var(--fs-1)}',
    '.share-demo{color:var(--ink-3);font-size:var(--fs-1)}',
    '.share-err{color:var(--bad);font-size:var(--fs-2)}',
    '@media (max-width:720px){.share-dlg .dialog__body{grid-template-columns:minmax(0,1fr)}.share-pic{width:132px;justify-self:center}}'
  ].join('\n');
  var dlg = null, f = null, state = null, busy = false;
  function seg(name, options, onPick) {
    var g = el('div', 'seg'); g.setAttribute('role', 'group'); g.setAttribute('aria-label', name);
    options.forEach(function (o) {
      var b = el('button', null, o[1]); b.type = 'button'; b.setAttribute('data-v', o[0]);
      b.addEventListener('click', function () { onPick(o[0]); });
      g.appendChild(b);
    });
    g.paint = function (v) { for (var i = 0; i < g.children.length; i++) g.children[i].setAttribute('aria-pressed', g.children[i].getAttribute('data-v') === v ? 'true' : 'false'); };
    return g;
  }
  function field(label, control, id) {
    var w = el('div', 'field'), l = el(id ? 'label' : 'span', 'label', label); if (id) l.htmlFor = id;
    w.appendChild(l); w.appendChild(control); return w;
  }
  function build() {
    var st = document.createElement('style'); st.id = 'share-style'; st.textContent = css; document.head.appendChild(st);
    dlg = el('dialog', 'dialog share-dlg'); dlg.id = 'share'; dlg.setAttribute('aria-labelledby', 'share-title');
    var head = el('div', 'dialog__head'), title = el('span', 'label', 'Share to Marketplace'); title.id = 'share-title';
    var x = el('button', 'btn btn--ghost btn--icon'); x.type = 'button'; x.setAttribute('data-dialog-close', ''); x.setAttribute('aria-label', 'Close');
    x.innerHTML = '<svg viewBox="0 0 14 14" aria-hidden="true"><path d="M3 3l8 8M11 3l-8 8"/></svg>';   /* static markup */
    head.appendChild(title); head.appendChild(x);
    var body = el('div', 'dialog__body');
    f = {};
    f.pic = el('div', 'share-pic'); f.pic.id = 'share-pic';
    var fields = el('div', 'share-fields');
    f.title = el('input', 'input'); f.title.id = 'share-name'; f.title.maxLength = 80; f.title.autocomplete = 'off'; f.title.spellcheck = false;
    fields.appendChild(field('Title', f.title, 'share-name'));
    f.tags = el('div', 'share-tags'); f.tags.id = 'share-tags'; f.tags.setAttribute('role', 'group'); f.tags.setAttribute('aria-label', 'Tags, up to ' + R.MAX_TAGS);
    API.TAGS.forEach(function (t) {
      var b = el('button', null, t); b.type = 'button'; b.setAttribute('data-tag', t); b.setAttribute('aria-pressed', 'false');
      b.addEventListener('click', function () {
        var i = state.tags.indexOf(t);
        if (i !== -1) state.tags.splice(i, 1);
        else if (state.tags.length >= R.MAX_TAGS) { say('Up to ' + R.MAX_TAGS + ' tags.'); return; }
        else state.tags.push(t);
        paint();
      });
      f.tags.appendChild(b);
    });
    fields.appendChild(field('Tags', f.tags));
    var modeRow = el('div', 'share-row');
    f.mode = seg('Who can open it', [['free', 'Free'], ['keys', 'Keys'], ['show', 'Show only']], function (v) { state.mode = v; paint(); });
    f.mode.id = 'share-mode';
    var priceWrap = el('span', 'select'); f.price = el('select'); f.price.id = 'share-price'; f.price.setAttribute('aria-label', 'Keys to unlock');
    for (var k = R.PRICE_KEYS_MIN; k <= R.PRICE_KEYS_MAX; k++) { var o = el('option', null, k + (k === 1 ? ' key' : ' keys')); o.value = String(k); f.price.appendChild(o); }
    f.price.addEventListener('change', function () { state.priceKeys = +f.price.value; });
    priceWrap.appendChild(f.price); f.priceWrap = priceWrap;
    modeRow.appendChild(f.mode); modeRow.appendChild(priceWrap);
    var modeBox = el('div', 'stack'); modeBox.style.setProperty('--gap', '6px');
    modeBox.appendChild(modeRow); f.modeNote = el('span', 'share-soon'); modeBox.appendChild(f.modeNote);
    modeBox.appendChild(el('span', 'share-soon', 'Selling for money — coming soon'));
    fields.appendChild(field('Who can open it', modeBox));
    f.vis = seg('Who can see it', [['public', 'Public'], ['private', 'Private']], function (v) { state.visibility = v; paint(); });
    f.vis.id = 'share-vis';
    fields.appendChild(field('Who can see it', f.vis));
    f.err = el('p', 'share-err'); f.err.setAttribute('role', 'status'); f.err.hidden = true;
    fields.appendChild(f.err);
    if (API.demo) fields.appendChild(el('p', 'share-demo', 'Demo — saved on this device until sign-in is switched on.'));
    body.appendChild(f.pic); body.appendChild(fields);
    var foot = el('div', 'dialog__foot');
    var cancel = el('button', 'btn', 'Cancel'); cancel.type = 'button'; cancel.setAttribute('data-dialog-close', '');
    f.go = el('button', 'btn btn--primary', 'Publish'); f.go.type = 'button'; f.go.id = 'share-publish';
    f.go.addEventListener('click', publish);
    foot.appendChild(cancel); foot.appendChild(f.go);
    dlg.appendChild(head); dlg.appendChild(body); dlg.appendChild(foot);
    dlg.addEventListener('keydown', function (e) { if (e.key === 'Enter' && e.target === f.title) { e.preventDefault(); publish(); } });
    document.body.appendChild(dlg);
  }
  function say(text) { f.err.textContent = text || ''; f.err.hidden = !text; }
  function paint() {
    f.mode.paint(state.mode); f.vis.paint(state.visibility);
    f.priceWrap.hidden = state.mode !== 'keys'; f.price.value = String(state.priceKeys);
    f.modeNote.textContent = state.mode === 'free' ? 'Anyone can open it and make it theirs.' : state.mode === 'keys' ? 'People unlock it with keys. You get a key each time.' : 'People see the stitches. The file stays yours.';
    Array.prototype.forEach.call(f.tags.children, function (b) { b.setAttribute('aria-pressed', state.tags.indexOf(b.getAttribute('data-tag')) !== -1 ? 'true' : 'false'); });
    f.go.disabled = busy;
  }
  function open() {
    if (T && T.cancel) T.cancel();
    if (!M.doc.objects.length) { toast('Draw something first, then share it.', { kind: 'bad', label: 'Share' }); return; }
    if (!dlg) build();
    var name = String(M.doc.name || '').trim();
    state = { tags: [], mode: 'free', priceKeys: 2, visibility: 'public', thumb: null, stats: null, job: null };
    f.title.value = name && name !== 'untitled' ? name.charAt(0).toUpperCase() + name.slice(1) : '';
    say(''); busy = false; paint();
    f.pic.textContent = 'Making a preview';
    var mine = state;
    mine.job = makeThumb().then(function (r) {
      if (state !== mine) return;
      var res = r.result;
      if (res && res.totals && res.bounds) mine.stats = { stitches: res.totals.stitches, colors: res.totals.colors, width: +res.bounds.width.toFixed(1), height: +res.bounds.height.toFixed(1) };
      mine.thumb = r.thumb;
      f.pic.textContent = '';
      if (r.thumb) { var img = el('img'); img.src = r.thumb; img.alt = 'Preview of the stitches'; f.pic.appendChild(img); }
      else f.pic.textContent = 'No preview';
    }, function () { if (state === mine) f.pic.textContent = 'No preview'; });
    EL.dialog.open(dlg);
    f.title.focus(); f.title.select();
  }
  function publish() {
    if (busy) return;
    var title = f.title.value.replace(/\s+/g, ' ').trim();
    if (!title) { say('Give it a title.'); f.title.focus(); return; }
    var mine = state; busy = true; paint(); say('');
    f.go.textContent = 'Publishing';
    Promise.resolve(mine.job).then(function () {
      var payload = IO.payload();
      return API.publish({ title: title, description: '', tags: mine.tags.slice(), mode: mine.mode, priceKeys: mine.mode === 'keys' ? mine.priceKeys : 0, visibility: mine.visibility, payload: payload, thumb: mine.thumb, stats: mine.stats });
    }).then(function (item) {
      busy = false; f.go.textContent = 'Publish';
      EL.dialog.close(dlg);
      var where = item.visibility === 'public' ? 'It is in the Marketplace now.' : 'It is private: only you see it.';
      toast(item.title + ' is shared. ' + where, { kind: 'ok', label: 'Shared', timeout: 9000, action: { label: 'View', onClick: function () { window.open('market.html?d=' + encodeURIComponent(item.id), '_blank', 'noopener'); } } });
      if (Editor.say) Editor.say('Shared to the Marketplace');
      Editor.emit && Editor.emit('published', item);
    }, function (e) {
      busy = false; f.go.textContent = 'Publish'; paint();
      say(e && e.code === 'auth' ? 'Sign in first (top right), then share.' : (e && e.message) || 'It could not be shared. Try again.');
      if (e && e.code === 'auth' && window.EL_ACCOUNT && window.EL_ACCOUNT.openSignIn) window.EL_ACCOUNT.openSignIn('Sign in to share your design.');
    });
  }

  /* ---------- wiring ---------- */
  document.addEventListener('click', function (e) {
    var t = e.target instanceof Element ? e.target.closest('[data-file="share"], [data-action="share"]') : null;
    if (t) open();
    if (e.target instanceof Element && e.target.closest('[data-action="market"]')) window.location.href = 'market.html';
    var s =e.target instanceof Element ? e.target.closest('[data-file="save"], [data-action="save"]') : null;
    if (s && M.doc.objects.length) API.note('save');
  });
  if (Editor.on) Editor.on('exported', function () { API.note('export'); });
  Editor.Share = { open: open };
  try { openFromMarket(); } catch (e) { if (window.console) console.error('Embroidr: marketplace link failed', e); }
})();
