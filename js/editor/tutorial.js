/* ==========================================================================
   EMBROIDERY LABS - js/editor/tutorial.js
   The first-visit tutorial. Creates Editor.Tutorial.

   On a first visit (no localStorage['el-tutorial-v1']) and when the page was
   not opened with ?design=, main.js calls Editor.Tutorial.boot(): a tab named
   "Tutorial" opens with a small flower, and a tips card (bottom left of the
   canvas) walks through seven steps. Each step points at one control with a
   soft pulsing ring and moves on by itself when the editor bus reports that
   the step was done (or with Next). Back, Skip, Esc. Finishing or skipping
   stores el-tutorial-v1 = 'done'. Help > Tutorial (and the More menu on a
   phone) opens it again: Editor.Tutorial.open().

   Tests that do not want it: localStorage.setItem('el-tutorial-v1', 'done')
   before app.html loads.
   ========================================================================== */
(function () {
  'use strict';
  var Editor = window.Editor = window.Editor || {};
  var KEY = 'el-tutorial-v1';
  var Tut = Editor.Tutorial = { KEY: KEY };

  function $(id) { return document.getElementById(id); }
  function M() { return Editor.Model; }
  function V() { return Editor.View; }
  function mockOpen() { return !!(Editor.Mockup && Editor.Mockup.isOpen()); }

  function seen() { try { return localStorage.getItem(KEY) === 'done'; } catch (e) { return true; } }   /* no storage: never nag */
  function markSeen() { try { localStorage.setItem(KEY, 'done'); } catch (e) { /* private mode */ } }

  /* ---------- the starter design: a flower, eight shapes, three threads ----------------------- */
  function flower(hoop) {
    var cx = hoop.w / 2, s = Math.min(hoop.w, hoop.h * 0.8) / 100, cy = hoop.h / 2 - 12 * s, objs = [], i, k;
    function r2(v) { return Math.round(v * 100) / 100; }
    function petal(a) {
      var pts = [], d = 18.5 * s, rx = 10.5 * s, ry = 7 * s, px = cx + Math.cos(a) * d, py = cy + Math.sin(a) * d;
      for (k = 0; k < 36; k++) {
        var t = k / 36 * Math.PI * 2, x = Math.cos(t) * rx, y = Math.sin(t) * ry;
        pts.push([r2(px + x * Math.cos(a) - y * Math.sin(a)), r2(py + x * Math.sin(a) + y * Math.cos(a))]);
      }
      return pts;
    }
    for (i = 0; i < 5; i++) objs.push({ id: 'tut-petal-' + (i + 1), name: 'Petal ' + (i + 1), type: 'polygon', pts: petal(-Math.PI / 2 + i * Math.PI * 2 / 5), color: '#E48AA0', paint: 'fill' });
    objs.unshift({ id: 'tut-stem', name: 'Stem', type: 'line', x1: r2(cx), y1: r2(cy + 18 * s), x2: r2(cx), y2: r2(cy + 52 * s), color: '#5E9A6E', paint: 'line', lineType: 'satin', lineWidth: 2.5 });
    var leaf = [], lx = cx + 9 * s, ly = cy + 40 * s, la = -0.6;
    for (k = 0; k < 30; k++) {
      var t = k / 30 * Math.PI * 2, x = Math.cos(t) * 9 * s, y = Math.sin(t) * 4 * s;
      leaf.push([r2(lx + x * Math.cos(la) - y * Math.sin(la)), r2(ly + x * Math.sin(la) + y * Math.cos(la))]);
    }
    objs.splice(1, 0, { id: 'tut-leaf', name: 'Leaf', type: 'polygon', pts: leaf, color: '#5E9A6E', paint: 'fill' });
    objs.push({ id: 'tut-middle', name: 'Middle', type: 'ellipse', cx: r2(cx), cy: r2(cy), rx: r2(9 * s), ry: r2(9 * s), color: '#E2B23E', paint: 'fill' });
    return { name: 'Tutorial', hoop: { w: hoop.w, h: hoop.h }, objects: objs };
  }

  /* Open the Tutorial tab: back to it when it is still open, else a new one (or the empty first tab). */
  function openTab() {
    var Tabs = Editor.Tabs, IO = Editor.IO, model = M();
    if (mockOpen()) Editor.Mockup.close();
    if (Tabs) {
      var mine = Tabs.list.filter(function (t) { return t.name === 'Tutorial'; })[0];
      if (mine) { Tabs.pick(mine.id); return; }
    }
    var data = { doc: flower(model.blank().hoop) };
    if (model.doc.objects.length || model.doc.name !== 'untitled') {
      if (Tabs) Tabs.add(data, true);            /* work on the hoop is never replaced: no tabs, no flower */
      return;
    }
    IO.applyPayload(data);
    if (Editor.Tools) { Editor.Tools.cancel(); if (Editor.Tools.current !== 'select') Editor.Tools.set('select'); }
    if (V().mode !== 'design') V().setMode('design');
    V().fit(); IO.saveNow();
    if (Tabs) { Tabs.designs(); Tabs.render(); }
  }

  /* ---------- the steps ------------------------------------------------------------------------ */
  function first(list) {
    for (var i = 0; i < list.length; i++) {
      var n = typeof list[i] === 'string' ? document.querySelector(list[i]) : list[i];
      if (n && visible(n)) return n;
    }
    return null;
  }
  function visible(n) {
    if (!n.getClientRects().length) return false;
    var r = n.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    if (r.bottom <= 0 || r.right <= 0 || r.top >= window.innerHeight || r.left >= window.innerWidth) return false;
    var cs = getComputedStyle(n);
    return cs.visibility !== 'hidden';
  }
  function threadWell() { var c = $('shape-color'); return c ? c.closest('.thread-well') : null; }
  function inSheet(node) {
    /* phone: a panel control is only pointed at while the sheet is open, otherwise the Settings button */
    return node && visible(node) && !(V().isPhone && V().isPhone() && Editor.sheet && Editor.sheet.get() === 'peek') ? node : null;
  }

  var STEPS = [
    { text: 'Pick the pen (P) and draw on the hoop.', phone: 'Pick the pen and draw on the hoop.',
      target: function () { return first(['.rail [data-tool="pen"]', '.dock [data-tool="pen"]']); },
      done: function (ev, d) { return ev === 'change' && d && /^Draw /.test(d.reason || ''); } },
    { text: 'Select a petal, then pick a new thread colour.',
      target: function () { return inSheet(threadWell()) || first(['#sheet-open']); },
      done: function (ev, d) { return ev === 'change' && d && d.reason === 'Change thread'; } },
    { text: 'In Stitch, set Style to Line art or Line type to Satin.',
      target: function () { return inSheet($('fill-style')) || first(['#sheet-open']); },
      done: function (ev, d) { return ev === 'change' && d && (d.reason === 'Change stitch style' || d.reason === 'Change line type'); } },
    { text: 'Open Stitch-out and press play.',
      target: function () { return V().mode === 'stitch' && !mockOpen() ? first(['#play-toggle']) : first(['#view-stitch', '.view__mode [data-view="stitch"]']); },
      done: function (ev) { return ev === 'play' && Editor.playback && Editor.playback.playing(); } },
    { text: 'Open Mockup and drag your design into place.',
      target: function () { return mockOpen() ? first(['#mock-stage']) : first(['#view-mockup', '.view__mode [data-view="mockup"]', '#btn-mockup']); },
      done: function (ev) { return ev === 'mockdrag'; } },
    { text: 'Export .PES for your machine. It fits Brother hoops.',
      target: function () { return first(['#btn-export']); },
      done: function (ev) { return ev === 'exported'; } },
    { text: 'File > Save keeps your work to open again later.',
      target: function () { return first(['#btn-file', '#btn-more']); },
      done: function (ev) { return ev === 'project-saved'; } }
  ];
  Tut.STEPS = STEPS.length;

  /* ---------- card + ring ---------------------------------------------------------------------- */
  var el = {}, isOpen = false, index = 0, raf = 0, lastTarget = null, finishing = false;

  function build() {
    if (el.card) return;
    var card = el.card = document.createElement('section');
    card.className = 'tut'; card.id = 'tutorial'; card.hidden = true;
    card.setAttribute('role', 'dialog'); card.setAttribute('aria-modal', 'false'); card.setAttribute('aria-labelledby', 'tut-count');
    card.innerHTML =
      '<div class="tut__head"><span class="label" id="tut-count"></span>' +
      '<button class="btn btn--ghost tut__skip" type="button" data-tut="skip">Skip</button></div>' +
      '<p class="tut__text" id="tut-text" aria-live="polite"></p>' +
      '<div class="tut__dots" aria-hidden="true"></div>' +
      '<div class="tut__foot"><button class="btn btn--ghost" type="button" data-tut="back">Back</button>' +
      '<button class="btn btn--primary" type="button" data-tut="next">Next</button></div>';
    var dots = card.querySelector('.tut__dots');
    for (var i = 0; i < STEPS.length; i++) dots.appendChild(document.createElement('i'));
    el.count = card.querySelector('#tut-count'); el.text = card.querySelector('#tut-text');
    el.back = card.querySelector('[data-tut="back"]'); el.next = card.querySelector('[data-tut="next"]');
    el.dots = dots.children;
    card.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('[data-tut]') : null; if (!b) return;
      var what = b.getAttribute('data-tut');
      if (what === 'skip') Tut.close(true);
      else if (what === 'back') go(index - 1);
      else if (what === 'next') { if (index >= STEPS.length - 1) Tut.close(true); else go(index + 1); }
    });
    el.ring = document.createElement('div'); el.ring.className = 'tut-ring'; el.ring.hidden = true; el.ring.setAttribute('aria-hidden', 'true');
    var host = $('app') || document.body;
    host.appendChild(el.ring); host.appendChild(card);
  }

  /* a phone has no keyboard: its copy leaves out the key hints */
  function text(i) { var s = STEPS[i]; return s.phone && V().isPhone && V().isPhone() ? s.phone : s.text; }
  /* place() runs every frame: only touch the DOM when a value really changed */
  function put(style, prop, value) { if (style[prop] !== value) style[prop] = value; }
  function render() {
    if (!el.card) return;
    el.count.textContent = (index + 1) + ' of ' + STEPS.length;
    el.text.textContent = text(index);
    el.back.disabled = index === 0;
    el.next.textContent = index === STEPS.length - 1 ? 'Done' : 'Next';
    for (var i = 0; i < el.dots.length; i++) el.dots[i].className = i < index ? 'is-done' : i === index ? 'is-now' : '';
    lastTarget = null;
    place();
  }
  function go(i) {
    finishing = false;
    index = Math.max(0, Math.min(STEPS.length - 1, i));
    el.card.classList.remove('is-step'); void el.card.offsetWidth; el.card.classList.add('is-step');
    render();
    if (Editor.say) Editor.say('Tutorial step ' + (index + 1) + ' of ' + STEPS.length + ': ' + text(index));
  }

  /* bottom left of whatever is showing (the hoop view or the mockup stage), above the phone sheet */
  function anchor() {
    var stage = mockOpen() ? $('mock-stage') : V().el && V().el.view;
    if (!stage || !stage.getClientRects().length) stage = $('main');
    var r = stage.getBoundingClientRect(), bottom = r.bottom;
    var sheet = $('sheet');
    if (!mockOpen() && sheet && V().isPhone && V().isPhone()) { var sr = sheet.getBoundingClientRect(); if (sr.height) bottom = Math.min(bottom, sr.top); }
    return { left: r.left, right: r.right, bottom: bottom, top: r.top };
  }
  function place() {
    if (!isOpen) return;
    var a = anchor(), gap = 12, w = Math.max(220, Math.min(300, a.right - a.left - 2 * gap));
    var s = el.card.style, left = Math.max(8, a.left + gap), bottom = a.bottom;
    w = Math.min(w, window.innerWidth - 16);
    /* never over the zoom buttons: on a narrow stage they share the bottom edge, so the card sits above them */
    var huds = document.querySelectorAll('.hud'), i;
    for (i = 0; i < huds.length; i++) {
      if (!visible(huds[i])) continue;
      var h = huds[i].getBoundingClientRect();
      if (h.left < left + w + 8 && h.right > left && h.bottom > a.bottom - 160 && h.top < a.bottom) bottom = Math.min(bottom, h.top - 4);
    }
    put(s, 'left', left + 'px');
    put(s, 'width', w + 'px');
    put(s, 'bottom', Math.max(8, window.innerHeight - bottom + gap) + 'px');
    var app = $('app'), h = el.card.offsetHeight + 'px';
    if (app && app.style.getPropertyValue('--tut-h') !== h) app.style.setProperty('--tut-h', h);
    if (!finishing && el.text.textContent !== text(index)) el.text.textContent = text(index);
    var t = finishing ? null : STEPS[index].target();
    if (t && t !== el.card && !el.card.contains(t)) {
      var r = t.getBoundingClientRect(), pad = t.id === 'mock-stage' ? -10 : 3, ring = el.ring.style;
      put(ring, 'left', (r.left - pad) + 'px'); put(ring, 'top', (r.top - pad) + 'px');
      put(ring, 'width', (r.width + 2 * pad) + 'px'); put(ring, 'height', (r.height + 2 * pad) + 'px');
      if (el.ring.hidden) el.ring.hidden = false;
      if (el.ring.classList.contains('tut-ring--wide') !== r.width > 200) el.ring.classList.toggle('tut-ring--wide', r.width > 200);
    } else if (!el.ring.hidden) el.ring.hidden = true;
    lastTarget = t;
  }
  function loop() { raf = 0; if (!isOpen) return; place(); raf = requestAnimationFrame(loop); }

  /* the bus says something happened: when it was this step's action, move on */
  function heard(ev, data) {
    if (!isOpen || !STEPS[index].done(ev, data)) return;
    if (index >= STEPS.length - 1) {
      markSeen(); finishing = true;
      el.text.textContent = 'All set. Have fun stitching!';
      el.ring.hidden = true;
      setTimeout(function () { if (isOpen && index === STEPS.length - 1) Tut.close(true); }, 1600);
      return;
    }
    var at = index;
    el.card.classList.add('is-done');
    setTimeout(function () { el.card.classList.remove('is-done'); if (isOpen && index === at) go(at + 1); }, 450);
  }

  /* ---------- public ------------------------------------------------------------------------------ */
  Tut.isOpen = function () { return isOpen; };
  Tut.step = function () { return isOpen ? index : -1; };
  Tut.open = function (opts) {
    build();
    if (window.EL && window.EL.dialog) { var d = document.querySelector('dialog[open]'); if (d) window.EL.dialog.close(d); }
    if (!opts || opts.tab !== false) openTab();
    isOpen = true; index = 0;
    el.card.hidden = false;
    var app = $('app'); if (app) app.classList.add('is-tut');
    go(0);
    if (!raf) raf = requestAnimationFrame(loop);
    return true;
  };
  Tut.close = function (remember) {
    if (!isOpen) return;
    isOpen = false;
    if (remember !== false) markSeen();
    el.card.hidden = true; el.ring.hidden = true;
    var app = $('app'); if (app) { app.classList.remove('is-tut'); app.style.removeProperty('--tut-h'); }
    if (raf) cancelAnimationFrame(raf); raf = 0;
    if (Editor.say) Editor.say('Tutorial closed');
  };
  Tut.next = function () { if (isOpen) { if (index >= STEPS.length - 1) Tut.close(true); else go(index + 1); } };
  Tut.back = function () { if (isOpen) go(index - 1); };
  Tut.seen = seen;

  /* Called once by main.js after the editor is up. `linked`: the page was opened with ?design=. */
  Tut.boot = function (opts) {
    build();
    ['change', 'play', 'exported', 'project-saved'].forEach(function (name) { Editor.on(name, function (d) { heard(name, d); }); });
    /* the mockup has no bus event for a drag: a press on its stage that moves counts */
    var down = null;
    document.addEventListener('pointerdown', function (e) {
      var st = $('mock-stage'); down = isOpen && mockOpen() && st && st.contains(e.target) && !(e.target.closest && e.target.closest('button, .hud')) ? { x: e.clientX, y: e.clientY } : null;
    }, true);
    document.addEventListener('pointerup', function (e) {
      if (down && Math.abs(e.clientX - down.x) + Math.abs(e.clientY - down.y) > 6) heard('mockdrag');
      down = null;
    }, true);
    /* Esc closes it, unless something else is using Esc right now (a menu, a dialog, a shape being drawn) */
    document.addEventListener('keydown', function (e) {
      if (!isOpen || e.key !== 'Escape' || e.defaultPrevented) return;
      if (document.querySelector('dialog[open], .menu:not([hidden])')) return;
      var more = $('more'); if (more && !more.hidden) return;
      if (Editor.Tools && Editor.Tools.busy && Editor.Tools.busy()) return;
      e.preventDefault(); e.stopPropagation();
      Tut.close(true);
    }, true);
    document.addEventListener('click', function (e) {
      var b = e.target instanceof Element ? e.target.closest('[data-tutorial-open]') : null;
      if (b) { e.preventDefault(); Tut.open(); }
    });
    if (!seen() && !(opts && opts.linked)) Tut.open();
  };
})();
