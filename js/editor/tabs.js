/* ==========================================================================
   EMBROIDERY LABS - js/editor/tabs.js
   Several designs side by side, one tab each. Creates Editor.Tabs.

   The design on the hoop is still autosaved by io.js exactly as before. This
   module keeps a copy of EVERY open design in localStorage['el-editor-tabs-v1']
   and swaps them through Model.load when a tab is picked, so every field of a
   stored tab is checked on the way back in. Undo history belongs to the design
   on the hoop and starts fresh when another tab is picked.

   Events (Editor.on):  'tabs'  the list or the active tab changed
   ========================================================================== */
(function () {
  'use strict';
  var Editor = window.Editor = window.Editor || {};
  var M = Editor.Model, V = Editor.View, IO = Editor.IO;
  var KEY = 'el-editor-tabs-v1', MAX_TABS = 12;
  var Tabs = Editor.Tabs = { list: [], active: null, MAX: MAX_TABS };
  var el = {};

  function uid() { return 't' + Date.now().toString(36) + Math.floor(Math.random() * 46656).toString(36); }
  function toast(msg, opts) { if (window.EL) window.EL.toast(msg, opts); }
  function find(id) { for (var i = 0; i < Tabs.list.length; i++) if (Tabs.list[i].id === id) return Tabs.list[i]; return null; }
  function current() { return find(Tabs.active); }
  function shapesOf(tab) { var d = tab && tab.data && tab.data.doc; return d && Array.isArray(d.objects) ? d.objects.length : 0; }

  /* keep the active tab's copy equal to what is on the hoop */
  function stash() {
    var t = current(); if (!t) return;
    t.data = IO.payload(); t.name = M.doc.name;
  }
  function persist() {
    var ok = !!(window.EL && window.EL.store.set(KEY, { v: 1, active: Tabs.active, tabs: Tabs.list.map(function (t) { return { id: t.id, name: t.name, data: t.data }; }) }));
    if (!ok && !Tabs.warned) { Tabs.warned = true; toast('This device is out of room for all the open designs. Save the ones you need with File > Save.', { kind: 'bad', label: 'Tabs', timeout: 9000 }); }
    return ok;
  }
  function freshView() {
    if (Editor.Tools) { Editor.Tools.cancel(); if (Editor.Tools.current !== 'select') Editor.Tools.set('select'); }
    if (V.mode !== 'design') V.setMode('design');
    V.fit();
  }
  function show(tab) {
    Tabs.active = tab.id;
    IO.applyPayload(tab.data || null);
    freshView(); IO.saveNow();
    stash(); persist(); render(); Editor.emit('tabs');
  }

  Tabs.current = current;
  Tabs.shapes = shapesOf;
  Tabs.pick = function (id) {
    var t = find(id); if (!t) return false;
    if (id === Tabs.active) { Editor.emit('tabs'); return true; }
    if (Editor.Tools) Editor.Tools.cancel();
    IO.saveNow(); stash();
    show(t);
    Editor.say('Design ' + t.name);
    return true;
  };
  /* A new empty design, or one made from a stored payload (a design file). */
  Tabs.add = function (data, quiet) {
    if (Tabs.list.length >= MAX_TABS) { toast('That is ' + MAX_TABS + ' designs open. Close one first.', { kind: 'bad', label: 'Tabs' }); return null; }
    if (Editor.Tools) Editor.Tools.cancel();
    IO.saveNow(); stash();
    var t = { id: uid(), name: 'untitled', data: data || { doc: M.blank() } };
    Tabs.list.push(t);
    show(t);
    if (!quiet) Editor.say('New design');
    return t;
  };
  Tabs.close = function (id) {
    var t = find(id); if (!t) return Promise.resolve(false);
    if (id === Tabs.active) stash();
    var ask = shapesOf(t) > 0
      ? window.EL.confirm('Close "' + t.name + '"? It is removed from this device. Save it first (File > Save) if you want to keep it.', { title: 'Close design', confirmLabel: 'Close', cancelLabel: 'Keep it', danger: true })
      : Promise.resolve(true);
    return ask.then(function (yes) {
      if (!yes) return false;
      var i = Tabs.list.indexOf(t); Tabs.list.splice(i, 1);
      if (!Tabs.list.length) { var n = { id: uid(), name: 'untitled', data: { doc: M.blank() } }; Tabs.list.push(n); show(n); return true; }
      if (id === Tabs.active) show(Tabs.list[Math.min(i, Tabs.list.length - 1)]);
      else { persist(); render(); Editor.emit('tabs'); }
      return true;
    });
  };
  /* Every open design, for the mockup: the active one straight from the hoop. */
  Tabs.designs = function () {
    stash();
    return Tabs.list.map(function (t) { return { id: t.id, name: t.name, doc: t.data && t.data.doc, shapes: shapesOf(t), active: t.id === Tabs.active }; });
  };

  function render() {
    if (!el.strip) return;
    var frag = document.createDocumentFragment();
    Tabs.list.forEach(function (t) {
      var b = document.createElement('div');
      b.className = 'dtab'; b.setAttribute('role', 'tab'); b.tabIndex = t.id === Tabs.active ? 0 : -1;
      b.setAttribute('aria-selected', t.id === Tabs.active && !(Editor.Mockup && Editor.Mockup.isOpen()) ? 'true' : 'false');
      b.setAttribute('data-tab', t.id);
      var name = document.createElement('span'); name.className = 'dtab__name'; name.textContent = t.name || 'untitled';
      var x = document.createElement('button'); x.type = 'button'; x.className = 'dtab__x'; x.setAttribute('aria-label', 'Close ' + (t.name || 'untitled')); x.setAttribute('data-close', t.id);
      x.innerHTML = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3 3l6 6M9 3l-6 6"/></svg>';
      b.appendChild(name); b.appendChild(x);
      frag.appendChild(b);
    });
    el.strip.textContent = ''; el.strip.appendChild(frag);
    if (el.add) el.add.disabled = Tabs.list.length >= MAX_TABS;
  }
  Tabs.render = render;

  Tabs.init = function () {
    el.strip = document.getElementById('dtabs'); el.add = document.getElementById('dtab-add');
    var stored = null;
    try { stored = window.EL.store.get(KEY, null); } catch (e) { stored = null; }
    if (stored && stored.v === 1 && Array.isArray(stored.tabs) && stored.tabs.length) {
      Tabs.list = stored.tabs.slice(0, MAX_TABS).filter(function (t) { return t && typeof t.id === 'string'; }).map(function (t) {
        return { id: t.id, name: typeof t.name === 'string' ? t.name.slice(0, 60) : 'untitled', data: t.data && typeof t.data === 'object' ? t.data : null };
      });
      Tabs.active = find(stored.active) ? stored.active : (Tabs.list[0] && Tabs.list[0].id);
    }
    if (!Tabs.list.length) { Tabs.list = [{ id: uid(), name: M.doc.name, data: null }]; Tabs.active = Tabs.list[0].id; }
    stash();                                  /* the hoop was already restored by io.js: that is the active tab */
    persist(); render();

    if (el.strip) {
      el.strip.addEventListener('click', function (e) {
        var x = e.target.closest ? e.target.closest('[data-close]') : null;
        if (x) { e.stopPropagation(); Tabs.close(x.getAttribute('data-close')); return; }
        var t = e.target.closest ? e.target.closest('[data-tab]') : null;
        if (!t) return;
        if (Editor.Mockup && Editor.Mockup.isOpen()) Editor.Mockup.close();
        Tabs.pick(t.getAttribute('data-tab'));
      });
      el.strip.addEventListener('keydown', function (e) {
        var t = e.target.closest ? e.target.closest('[data-tab]') : null; if (!t) return;
        var i = Tabs.list.indexOf(find(t.getAttribute('data-tab')));
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); t.click(); }
        else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
          e.preventDefault(); e.stopPropagation();
          var n = Tabs.list[(i + (e.key === 'ArrowRight' ? 1 : Tabs.list.length - 1)) % Tabs.list.length];
          Tabs.pick(n.id); var b = el.strip.querySelector('[data-tab="' + n.id + '"]'); if (b) b.focus();
        }
      });
    }
    if (el.add) el.add.addEventListener('click', function () { if (Editor.Mockup && Editor.Mockup.isOpen()) Editor.Mockup.close(); Tabs.add(); });

    var timer = 0;
    function sync() { stash(); persist(); var t = current(), b = t && el.strip && el.strip.querySelector('[data-tab="' + t.id + '"] .dtab__name'); if (b && b.textContent !== t.name) b.textContent = t.name || 'untitled'; }
    Editor.on('saved', function () { if (IO.saveState === 'saved') { clearTimeout(timer); timer = setTimeout(sync, 60); } });
    Editor.on('change', function (e) { if (e && e.reason === 'name') { var t = current(), b = t && el.strip && el.strip.querySelector('[data-tab="' + t.id + '"] .dtab__name'); if (b) b.textContent = M.doc.name || 'untitled'; } });
    window.addEventListener('pagehide', function () { try { sync(); } catch (e) { /* leaving anyway */ } });
  };
})();
