/* ==========================================================================
   EMBROIDERY LABS - js/editor/panels.js
   The two side panels:
     - Properties: bound to the selection, or to the defaults for the next
       shape when nothing is selected. Hoop size and fabric colour too.
     - Sewing order: one row per object (select, rename, reorder, delete),
       the stitch read-outs, the thread sequence bar and the engine warnings.

   No text from the document ever goes through innerHTML: rows are built with
   createElement / textContent.
   ========================================================================== */
(function () {
  'use strict';
  var Editor = window.Editor, M = Editor.Model, V = Editor.View, G = Editor.Geom;
  var P = Editor.Panels = {};
  var el = {};
  var SVGNS = 'http://www.w3.org/2000/svg';
  var GLYPHS = {
    fill: 'M2 4h4M8 4h4M4 8h4M10 8h4M2 12h4M8 12h4',
    satin: 'M2 12 4 4l2 8 2-8 2 8 2-8 2 8',
    running: 'M1.5 8h3M6.5 8h3M11.5 8h3'
  };
  var LINE_NAMES = { running: 'running line', bean: 'bean line', satin: 'satin line', raw: 'imported stitches' };
  var MAX_WARNINGS = 6;

  function $(id) { return document.getElementById(id); }
  function num(n) { return window.EL.num(n); }
  function say(msg) { if (Editor.say) Editor.say(msg); }
  function span(cls, text) { var s = document.createElement('span'); if (cls) s.className = cls; if (text != null) s.textContent = text; return s; }
  function svg(d, box, cls) {
    var s = document.createElementNS(SVGNS, 'svg'), p = document.createElementNS(SVGNS, 'path');
    s.setAttribute('viewBox', box); s.setAttribute('aria-hidden', 'true'); if (cls) s.setAttribute('class', cls);
    p.setAttribute('d', d); s.appendChild(p);
    return s;
  }
  /* "fill", "fill and satin line", "running line": what the object is sewn as */
  function sewnAs(o) {
    var p = M.paintOf(o), line = LINE_NAMES[o.lineType] || 'line';
    return p === 'fill' ? 'fill' : p === 'both' ? 'fill and ' + line : line;
  }

  /* =========================================================================
     PROPERTIES
     ========================================================================= */
  var PAIRS = [
    { key: 'lineWidth', slider: 'stroke-width', number: 'stroke-width-value' },
    { key: 'spacing', slider: 'stitch-density', number: 'density-value' },
    { key: 'stitchLen', slider: 'max-stitch-length', number: 'max-stitch-value' },
    { key: 'angle', slider: 'fill-angle', number: 'fill-angle-value' }
  ];

  /* The value to show for a property: of the selection, or of the defaults. */
  function current(key) {
    var sel = M.selected();
    if (!sel.length) return { value: M.defaults[key], mixed: false };
    function read(o) { return key === 'paint' ? M.paintOf(o) : o[key]; }
    var v = read(sel[0]), mixed = false;
    for (var i = 1; i < sel.length; i++) if (read(sel[i]) !== v) mixed = true;
    return { value: v, mixed: mixed };
  }
  /* Change a property of the selection. The value also becomes the default, so
     the next shape is drawn the way the last one was left. */
  function apply(key, value, coalesce) {
    var ids = M.selection.slice();
    if (ids.length) M.setProp(ids, key, value, coalesce);
    if (!(key === 'lineType' && value === 'raw')) M.setDefault(key, value);   /* a drawn stroke is never "as imported" */
  }
  function canFill(o) { return o.type !== 'line' && !(o.type === 'pen' && !o.closed && o.pts.length < 3); }
  /* Which controls do anything for the selection (all of them for the defaults). */
  function usage(sel) {
    var u = { paint: true, lineType: true, lineWidth: true, spacing: true, stitchLen: true, angle: true, pattern: true };
    if (!sel.length) return u;
    u = { paint: false, lineType: false, lineWidth: false, spacing: false, stitchLen: false, angle: false, pattern: false };
    sel.forEach(function (o) {
      var p = M.paintOf(o), line = p !== 'fill', fill = p !== 'line', satin = line && o.lineType === 'satin';
      if (canFill(o)) u.paint = true;
      if (line) u.lineType = true;
      if (satin) u.lineWidth = true;
      if (fill || satin) u.spacing = true;
      if (fill || (line && !satin && o.lineType !== 'raw')) u.stitchLen = true;   /* imported stitches keep their own points */
      if (fill) { u.angle = true; u.pattern = true; }
    });
    return u;
  }
  function setOff(row, off, why, controls) {
    if (!row) return;
    row.classList.toggle('is-off', off);
    if (off) row.setAttribute('title', why); else row.removeAttribute('title');
    controls.forEach(function (c) { c.disabled = off; });
  }

  function renderProps() {
    var sel = M.selected(), n = sel.length;
    var who = n === 0 ? 'Next shape' : n === 1 ? sel[0].name : n + ' shapes';
    el.target.textContent = who;
    el.footSel.textContent = n === 0 ? 'None' : who;
    var use = usage(sel);

    var paint = current('paint');
    [['fill', el.fill], ['line', el.stroke], ['both', el.both]].forEach(function (p) {
      p[1].setAttribute('aria-pressed', !paint.mixed && paint.value === p[0] ? 'true' : 'false');
    });
    setOff(el.fill.closest('.prop'), !use.paint, 'A straight line can only be sewn as a line.', [el.fill, el.stroke, el.both]);

    var color = current('color');
    el.color.value = color.value;
    el.swatch.style.setProperty('--c', color.value);
    el.hex.textContent = color.mixed ? 'Mixed' : color.value.toUpperCase();

    var type = current('lineType');
    /* "As imported" is only offered for stitches that were opened from a machine file */
    var rawOpt = el.type.querySelector('option[value="raw"]'), anyRaw = sel.some(function (o) { return o.lineType === 'raw'; });
    if (anyRaw && !rawOpt) { rawOpt = document.createElement('option'); rawOpt.value = 'raw'; rawOpt.textContent = 'As imported'; el.type.appendChild(rawOpt); }
    else if (!anyRaw && rawOpt) rawOpt.remove();
    el.type.value = type.value === 'raw' && !anyRaw ? 'running' : type.value;
    setOff(el.type.closest('.prop'), !use.lineType, 'Only used when the shape has a line (Paint: Line or Both).', [el.type]);

    if (el.pattern) {
      var pat = current('pattern');
      el.pattern.value = pat.mixed ? '' : (pat.value || 'smooth');
      setOff(el.pattern.closest('.prop'), !use.pattern, 'Only used by fills.', [el.pattern]);
    }

    var why = {
      lineWidth: 'Only used by satin lines.',
      spacing: 'Only used by fills and satin lines.',
      stitchLen: 'Only used by fills, running and bean lines.',
      angle: 'Only used by fills.'
    };
    PAIRS.forEach(function (p) {
      var c = current(p.key);
      p.sliderEl.value = c.value; p.numberEl.value = c.value;
      window.EL.syncSlider(p.sliderEl);
      setOff(p.sliderEl.closest('.prop'), !use[p.key], why[p.key], [p.sliderEl, p.numberEl]);
    });
  }

  /* Hoops are sold by their inch name (4x4, 5x7 ...), so that is what the list says; the exact
     sewing field follows in the unit the visitor picked. */
  var HOOP_NAMES = { '100x100': '4 x 4 in', '130x180': '5 x 7 in', '160x260': '6 x 10 in', '200x200': '8 x 8 in', '200x300': '8 x 12 in', '240x360': '9.5 x 14 in', '272x408': '10.6 x 16 in' };
  function hoopLabel(key) {
    var m = /^(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)$/.exec(key), U = Editor.Units;
    if (!m) return key;
    var w = parseFloat(m[1]), h = parseFloat(m[2]), name = HOOP_NAMES[key];
    if (U.get() === 'in') return name || (U.sizeShort(w, h) + ' in');
    return m[1] + ' x ' + m[2] + ' mm' + (name ? ' (' + name.replace(/ x /, 'x') + ')' : '');
  }
  function renderHoop() {
    var key = M.doc.hoop.w + 'x' + M.doc.hoop.h, found = false, i;
    for (i = 0; i < el.hoop.options.length; i++) if (el.hoop.options[i].value === key) found = true;
    if (!found) {
      var opt = document.createElement('option');
      opt.value = key;
      el.hoop.appendChild(opt);
    }
    for (i = 0; i < el.hoop.options.length; i++) {
      var text = hoopLabel(el.hoop.options[i].value);
      if (el.hoop.options[i].textContent !== text) el.hoop.options[i].textContent = text;
    }
    el.hoop.value = key;
    /* Small and Big are the two quick picks; anything else, or a press on Custom, shows the fields */
    var quick = el.hoopBtns.some(function (b) { return b.getAttribute('data-hoop') === key; });
    var custom = hoopCustom || !quick;
    el.hoopBtns.forEach(function (b) {
      var k = b.getAttribute('data-hoop');
      b.setAttribute('aria-pressed', (k === 'custom' ? custom : (!custom && k === key)) ? 'true' : 'false');
    });
    if (el.hoopCustom) el.hoopCustom.hidden = !custom;
    var U = Editor.Units;
    /* nothing here runs while a number is being typed (only after it is entered), so the fields can always be set */
    if (el.hoopW) el.hoopW.value = U.short(M.doc.hoop.w);
    if (el.hoopH) el.hoopH.value = U.short(M.doc.hoop.h);
    el.hoopUnits.forEach(function (n) { n.textContent = U.label(); });
  }
  var hoopCustom = false;
  function setHoopSize(w, h) {
    w = G.r2(G.clamp(w, 10, 1000)); h = G.r2(G.clamp(h, 10, 1000));
    if (w === M.doc.hoop.w && h === M.doc.hoop.h) return false;
    if (!M.setHoop(w, h)) return false;
    Editor.Prefs.setHoop(w, h);
    say('Hoop ' + Editor.Units.short(w) + ' by ' + Editor.Units.short(h) + ' ' + Editor.Units.word());
    return true;
  }
  function renderUnits() {
    var U = Editor.Units;
    el.unitBtns.forEach(function (b) { b.setAttribute('aria-pressed', b.getAttribute('data-units') === U.get() ? 'true' : 'false'); });
    if (el.unitCorner) {
      el.unitCorner.textContent = U.label();
      el.unitCorner.setAttribute('aria-label', 'Sizes are shown in ' + U.word() + '. Switch to ' + (U.get() === 'in' ? 'millimetres' : 'inches'));
    }
    if (el.statSizeUnit) el.statSizeUnit.textContent = U.label();
    if (el.gridToggle) el.gridToggle.checked = Editor.Prefs.grid();
  }
  function renderFabric() {
    el.fabricBtns.forEach(function (b) { b.setAttribute('aria-pressed', b.getAttribute('data-fabric') === V.fabric.mode ? 'true' : 'false'); });
    el.fabricColor.value = V.fabric.color;
  }

  function initProps() {
    el.target = $('insp-target'); el.footSel = $('footer-sel');
    el.fill = $('btn-fill'); el.stroke = $('btn-stroke'); el.both = $('btn-both');
    el.color = $('shape-color'); el.swatch = $('shape-color-swatch'); el.hex = $('color-hex');
    el.type = $('stitch-type'); el.pattern = $('fill-pattern'); el.hoop = $('hoop-size'); el.hoopBtns = Array.prototype.slice.call(document.querySelectorAll('[data-hoop]')); el.hoopCustom = $('hoop-custom'); el.hoopW = $('hoop-w'); el.hoopH = $('hoop-h'); el.hoopUnits = Array.prototype.slice.call(document.querySelectorAll('[data-hoop-unit]')); el.fabricColor = $('fabric-color');
    el.fabricBtns = Array.prototype.slice.call(document.querySelectorAll('[data-fabric]'));

    el.fill.addEventListener('click', function () { apply('paint', 'fill'); });
    el.stroke.addEventListener('click', function () { apply('paint', 'line'); });
    el.both.addEventListener('click', function () { apply('paint', 'both'); });
    /* the native picker fires 'input' while the colour is dragged: one undo step */
    el.color.addEventListener('input', function () { apply('color', el.color.value, true); });
    el.color.addEventListener('change', function () { apply('color', el.color.value, true); M.seal(); });
    el.type.addEventListener('change', function () { apply('lineType', el.type.value); });
    if (el.pattern) {
      Object.keys(M.PATTERNS).forEach(function (k) {
        var opt = document.createElement('option'); opt.value = k; opt.textContent = M.PATTERNS[k].label || k; el.pattern.appendChild(opt);
      });
      el.pattern.addEventListener('change', function () { if (el.pattern.value) apply('pattern', el.pattern.value); });
    }

    PAIRS.forEach(function (p) {
      var r = M.RANGES[p.key];
      p.sliderEl = $(p.slider); p.numberEl = $(p.number);
      [p.sliderEl, p.numberEl].forEach(function (i) { i.min = r[0]; i.max = r[1]; });
      p.sliderEl.addEventListener('input', function () { p.numberEl.value = p.sliderEl.value; apply(p.key, p.sliderEl.value, true); });
      p.sliderEl.addEventListener('change', function () { M.seal(); });
      p.numberEl.addEventListener('change', function () {
        var v = M.validProp(p.key, p.numberEl.value === '' ? NaN : p.numberEl.value);
        if (v !== null) apply(p.key, v);
        renderProps();                              /* shows the value as it was clamped */
      });
    });

    el.hoop.addEventListener('change', function () {
      var m = /^(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)$/.exec(el.hoop.value);
      if (m) setHoopSize(parseFloat(m[1]), parseFloat(m[2]));
      renderHoop();
    });
    el.hoopBtns.forEach(function (b) {
      b.addEventListener('click', function () {
        var k = b.getAttribute('data-hoop'), m = /^(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)$/.exec(k);
        if (k === 'custom') { hoopCustom = true; renderHoop(); if (el.hoopW) { el.hoopW.focus(); el.hoopW.select(); } return; }
        hoopCustom = false;
        if (m) setHoopSize(parseFloat(m[1]), parseFloat(m[2]));
        renderHoop();
      });
    });
    /* width and height are typed in the unit on show; the document stays in millimetres */
    function typed() {
      var k = Editor.Units.get() === 'in' ? Editor.Units.MM_PER_IN : 1, w = parseFloat(el.hoopW.value) * k, h = parseFloat(el.hoopH.value) * k;
      if (isFinite(w) && isFinite(h) && w > 0 && h > 0) setHoopSize(w, h);
      renderHoop();
    }
    [el.hoopW, el.hoopH].forEach(function (input) {
      if (!input) return;
      input.addEventListener('change', typed);
      input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); input.blur(); } });
    });

    el.unitBtns.forEach(function (b) {
      b.addEventListener('click', function () { Editor.Units.set(b.getAttribute('data-units')); });
    });
    if (el.unitCorner) el.unitCorner.addEventListener('click', function () { Editor.Units.toggle(); });
    if (el.gridToggle) el.gridToggle.addEventListener('change', function () { Editor.Prefs.setGrid(el.gridToggle.checked); });
    Editor.on('units', function () { renderUnits(); renderHoop(); renderStats(); say('Sizes in ' + Editor.Units.word()); });
    Editor.on('prefs', renderUnits);

    el.fabricBtns.forEach(function (b) {
      b.addEventListener('click', function () {
        var mode = b.getAttribute('data-fabric');
        V.setFabric(mode, el.fabricColor.value);
        Editor.emit('fabric');
        if (mode === 'custom') {
          try { if (el.fabricColor.showPicker) el.fabricColor.showPicker(); else el.fabricColor.click(); } catch (e) { /* no picker without a user gesture */ }
        }
      });
    });
    el.fabricColor.addEventListener('input', function () { V.setFabric('custom', el.fabricColor.value); Editor.emit('fabric'); });

    /* the SVG / picture section is wired in main.js (files) and trace.js (picture controls) */

    Editor.on('fabric', renderFabric);
  }

  /* =========================================================================
     SEWING ORDER
     ========================================================================= */
  var counts = {};          /* object id -> stitches, from the newest engine result */
  var notes = {};           /* object id -> [engine messages] */
  var anchor = null;        /* id a Shift-click range starts from */
  var drag = null;
  var renaming = null;

  function rows() { return Array.prototype.slice.call(el.list.children); }
  function rowOf(id) { var r = rows(); for (var i = 0; i < r.length; i++) if (r[i]._id === id) return r[i]; return null; }
  function rowFrom(node) { while (node && node !== el.list) { if (node._id) return node; node = node.parentNode; } return null; }

  function buildRow(o, i) {
    var row = document.createElement('div');
    row.className = 'layer'; row.setAttribute('role', 'option'); row.tabIndex = -1; row._id = o.id;
    var chip = span('thread'); chip.style.setProperty('--c', o.color);
    var del = document.createElement('button');
    del.type = 'button'; del.className = 'layer__del'; del.tabIndex = -1;
    del.setAttribute('aria-label', 'Delete ' + o.name);
    del.appendChild(svg('M2.5 2.5l7 7M9.5 2.5l-7 7', '0 0 12 12'));
    row.appendChild(span('num idx', String(i + 1)));
    row.appendChild(chip);
    row.appendChild(svg(GLYPHS[M.glyphOf(o)], '0 0 16 16', 'glyph'));
    row.appendChild(span('name', o.name));
    row.appendChild(span('num count'));
    row.appendChild(del);
    return row;
  }
  function fillCount(row, o) {
    var cell = row.children[4], flag = V.flags[o.id], n = counts[o.id];
    var text = n == null ? '' : num(n), msgs = notes[o.id] || [];
    var sig = (flag || '') + '|' + text + '|' + msgs.join('|') + '|' + o.name;
    if (cell._sig === sig) return;
    cell._sig = sig;
    cell.textContent = '';
    if (flag) {
      var f = span('flag' + (flag === 'error' ? ' flag--error' : ''), '!');
      f.setAttribute('aria-hidden', 'true');
      cell.appendChild(f);
    }
    cell.appendChild(document.createTextNode(text));
    var label = o.name + ', ' + sewnAs(o) + (n == null ? '' : ', ' + num(n) + ' stitches') + (msgs.length ? '. ' + msgs.join(' ') : '');
    row.setAttribute('aria-label', label);
    if (msgs.length) row.setAttribute('title', msgs.join('\n')); else row.removeAttribute('title');
  }
  function updateCounts() {
    rows().forEach(function (row) { var o = M.get(row._id); if (o) fillCount(row, o); });
  }
  function syncSelection() {
    var list = rows(), tab = null;
    list.forEach(function (row) {
      var on = M.isSelected(row._id);
      row.setAttribute('aria-selected', on ? 'true' : 'false');
      row.tabIndex = -1;
      if (on && !tab) tab = row;
    });
    if (!tab) tab = list[0];
    if (tab) tab.tabIndex = 0;
    var objs = M.doc.objects, sel = M.selection, n = sel.length;
    /* can the selection still move up / down? */
    var up = false, down = false;
    for (var i = 0; i < objs.length; i++) {
      if (sel.indexOf(objs[i].id) === -1) continue;
      if (i > 0 && sel.indexOf(objs[i - 1].id) === -1) up = true;
      if (i < objs.length - 1 && sel.indexOf(objs[i + 1].id) === -1) down = true;
    }
    el.up.disabled = !n || !up; el.down.disabled = !n || !down;
  }
  function renderLayers() {
    if (renaming) endRename(false);
    var objs = M.doc.objects, active = document.activeElement;
    var focused = active && el.list.contains(active) ? rowFrom(active) : null;
    var focusId = focused ? focused._id : null;
    el.list.textContent = '';
    objs.forEach(function (o, i) { el.list.appendChild(buildRow(o, i)); });
    el.list.hidden = !objs.length;
    el.empty.hidden = !!objs.length;
    el.total.textContent = String(objs.length);
    el.count.textContent = String(objs.length);
    syncSelection(); updateCounts();
    if (focusId) { var r = rowOf(focusId); if (r) r.focus({ preventScroll: true }); }
  }

  /* ---------- rename in place ------------------------------------------------ */
  function startRename(id) {
    var row = rowOf(id), o = M.get(id); if (!row || !o) return;
    if (renaming) endRename(true);
    var input = document.createElement('input');
    input.type = 'text'; input.className = 'layer__rename'; input.maxLength = 60; input.value = o.name;
    input.setAttribute('aria-label', 'Name of ' + o.name); input.autocomplete = 'off'; input.spellcheck = false;
    row.children[3].setAttribute('data-editing', '');
    row.appendChild(input);
    renaming = { id: id, input: input, row: row };
    input.addEventListener('keydown', function (e) {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); endRename(true); }
      else if (e.key === 'Escape') { e.preventDefault(); endRename(false); }
    });
    input.addEventListener('blur', function () { if (renaming && renaming.input === input) endRename(true, true); });
    input.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
    input.addEventListener('dblclick', function (e) { e.stopPropagation(); });
    input.focus(); input.select();
  }
  function endRename(commit, fromBlur) {
    var r = renaming; if (!r) return;
    renaming = null;
    var value = r.input.value, had = document.activeElement === r.input;
    if (r.input.parentNode) r.input.parentNode.removeChild(r.input);
    r.row.children[3].removeAttribute('data-editing');
    var changed = commit && M.rename(r.id, value);          /* rebuilds the list when the name changed */
    if (changed) say('Renamed to ' + M.get(r.id).name);
    if (had && !fromBlur) { var row = rowOf(r.id); if (row) row.focus({ preventScroll: true }); }
  }

  /* ---------- pointer: select, drag to reorder ---------------------------------- */
  function clearDrop() {
    rows().forEach(function (r) { r.classList.remove('is-drop-before', 'is-drop-after', 'is-dragging'); });
    el.list.classList.remove('is-sorting');
  }
  function selectRange(a, b) {
    var i = M.indexOf(a), j = M.indexOf(b); if (i === -1 || j === -1) return M.select([b]);
    var lo = Math.min(i, j), hi = Math.max(i, j), ids = [];
    for (var k = lo; k <= hi; k++) ids.push(M.doc.objects[k].id);
    M.select(ids);
  }
  function onDown(e) {
    var row = rowFrom(e.target); if (!row || e.button !== 0) return;
    if (e.target.closest && e.target.closest('.layer__del, .layer__rename')) return;
    var id = row._id, was = M.isSelected(id), mod = e.metaKey || e.ctrlKey;
    if (e.shiftKey && anchor && M.get(anchor)) selectRange(anchor, id);
    else if (mod) { M.toggle(id); anchor = id; }
    else { if (!was) M.select([id]); anchor = id; }
    drag = { id: id, row: row, y: e.clientY, pid: e.pointerId, moved: false, index: -1,
      collapse: was && !e.shiftKey && !mod, touch: e.pointerType === 'touch' };
    /* touch scrolls the list instead (touch-action: pan-y); reorder with the arrow buttons */
    if (!drag.touch) { try { row.setPointerCapture(e.pointerId); } catch (x) { /* older browsers */ } }
  }
  function onMove(e) {
    if (!drag || e.pointerId !== drag.pid || drag.touch) return;
    if (!drag.moved) {
      if (Math.abs(e.clientY - drag.y) < 5 || M.doc.objects.length < 2) return;
      drag.moved = true;
      drag.row.classList.add('is-dragging'); el.list.classList.add('is-sorting');
    }
    var list = rows(), j = list.length, i;
    for (i = 0; i < list.length; i++) {
      var r = list[i].getBoundingClientRect();
      if (e.clientY < r.top + r.height / 2) { j = i; break; }
    }
    list.forEach(function (r2) { r2.classList.remove('is-drop-before', 'is-drop-after'); });
    if (j < list.length) list[j].classList.add('is-drop-before'); else list[list.length - 1].classList.add('is-drop-after');
    drag.index = j;
  }
  function onUp(e) {
    if (!drag || e.pointerId !== drag.pid) return;
    var d = drag; drag = null;
    if (d.moved) {
      clearDrop();
      var from = M.indexOf(d.id), to = d.index > from ? d.index - 1 : d.index;
      if (from !== -1 && d.index !== -1 && to !== from && M.moveTo(d.id, to)) {
        var o = M.get(d.id); say(o.name + ' is now number ' + (M.indexOf(d.id) + 1) + ' of ' + M.doc.objects.length + ' in the sewing order');
      }
    } else if (d.collapse) M.select([d.id]);
  }
  function onCancel(e) {
    if (!drag || (e.pointerId != null && e.pointerId !== drag.pid)) return;
    drag = null; clearDrop();
  }

  /* ---------- keyboard ------------------------------------------------------------ */
  function reorderSelection(dir) {
    var ids = M.selection.slice(); if (!ids.length) return false;
    if (!M.reorder(ids, dir)) return false;
    var o = M.get(ids[0]);
    say(ids.length === 1 && o ? o.name + ' is now number ' + (M.indexOf(o.id) + 1) + ' of ' + M.doc.objects.length : 'Moved ' + ids.length + ' shapes ' + (dir > 0 ? 'later' : 'earlier'));
    return true;
  }
  P.reorderSelection = reorderSelection;

  function onKey(e) {
    var row = rowFrom(e.target); if (!row || e.target !== row) return;
    var list = rows(), i = list.indexOf(row), id = row._id, key = e.key, next = null;
    if (key === 'ArrowDown' || key === 'ArrowUp') {
      e.preventDefault();
      var dir = key === 'ArrowDown' ? 1 : -1;
      if (e.altKey) { if (!M.isSelected(id)) M.select([id]); reorderSelection(dir); return; }
      next = list[i + dir];
    } else if (key === 'Home') { e.preventDefault(); next = list[0]; }
    else if (key === 'End') { e.preventDefault(); next = list[list.length - 1]; }
    else if (key === 'Enter' || key === 'F2') { e.preventDefault(); startRename(id); return; }
    else if (key === ' ') {
      e.preventDefault();
      if (e.metaKey || e.ctrlKey) M.toggle(id); else M.select([id]);
      anchor = id; return;
    } else if (key === 'Delete' || key === 'Backspace') {
      e.preventDefault();
      var ids = M.isSelected(id) ? M.selection.slice() : [id];
      if (M.remove(ids, ids.length > 1 ? 'Delete ' + ids.length + ' shapes' : 'Delete')) {
        say(ids.length > 1 ? ids.length + ' shapes deleted' : 'Shape deleted');
        var left = rows(), f = left[Math.min(i, left.length - 1)];
        if (f) f.focus({ preventScroll: true }); else V.el.canvas.focus({ preventScroll: true });
      }
      return;
    } else return;
    if (next) {
      if (e.shiftKey) { if (!M.isSelected(next._id)) M.select(M.selection.concat([next._id])); }
      else { M.select([next._id]); anchor = next._id; }
      next.focus(); if (next.scrollIntoView) next.scrollIntoView({ block: 'nearest' });
    }
  }

  function initLayers() {
    el.list = $('layers-list'); el.empty = $('layers-empty'); el.total = $('layer-total'); el.count = $('layer-count');
    el.up = $('layer-up'); el.down = $('layer-down');
    el.list.addEventListener('pointerdown', onDown);
    el.list.addEventListener('pointermove', onMove);
    el.list.addEventListener('pointerup', onUp);
    el.list.addEventListener('pointercancel', onCancel);
    el.list.addEventListener('lostpointercapture', function (e) { if (drag && drag.moved) onCancel(e); });
    el.list.addEventListener('keydown', onKey);
    el.list.addEventListener('dblclick', function (e) {
      var row = rowFrom(e.target);
      if (row && !(e.target.closest && e.target.closest('.layer__del'))) startRename(row._id);
    });
    el.list.addEventListener('click', function (e) {
      var del = e.target.closest ? e.target.closest('.layer__del') : null, row = del && rowFrom(del);
      if (!row) return;
      var o = M.get(row._id), name = o ? o.name : 'Shape';
      if (M.remove([row._id], 'Delete')) say(name + ' deleted');
    });
    el.up.addEventListener('click', function () { reorderSelection(-1); });
    el.down.addEventListener('click', function () { reorderSelection(1); });
  }

  /* =========================================================================
     STITCH READ-OUTS AND WARNINGS
     ========================================================================= */
  function setLead(node, text) {              /* the text before the <span class="unit"> */
    if (node.firstChild && node.firstChild.nodeType === 3) node.firstChild.nodeValue = text;
    else node.insertBefore(document.createTextNode(text), node.firstChild);
  }
  function clock(min) {
    var s = Math.max(0, Math.round((min || 0) * 60)), m = Math.floor(s / 60), r = s % 60;
    return m + ':' + (r < 10 ? '0' : '') + r;
  }
  var warnSig = null;
  function renderWarnings(result) {
    var list = (result && result.warnings ? result.warnings : []).filter(function (w) {
      return !(w.code === 'EMPTY_DESIGN' && !M.doc.objects.length);
    });
    var order = { error: 0, warning: 1, info: 2 };
    list = list.slice().sort(function (a, b) { return (order[a.severity] || 0) - (order[b.severity] || 0); });
    var sig = list.map(function (w) { return w.code + ':' + (w.objectId || '') + ':' + (w.objectIndexes || []).join(',') + ':' + w.message; }).join('|');
    if (sig === warnSig) return;
    warnSig = sig;
    el.warns.textContent = '';
    el.warns.hidden = !list.length;
    list.slice(0, MAX_WARNINGS).forEach(function (w) {
      var ids = [];
      if (w.objectId != null && M.get(w.objectId)) ids.push(w.objectId);
      (w.objectIndexes || []).forEach(function (i) { var o = result.objects[i]; if (o && M.get(o.id) && ids.indexOf(o.id) === -1) ids.push(o.id); });
      var row = document.createElement(ids.length ? 'button' : 'div');
      row.className = 'warn warn--' + (w.severity === 'error' ? 'error' : w.severity === 'warning' ? 'warning' : 'info');
      var flag = span('flag' + (w.severity === 'error' ? ' flag--error' : ''), w.severity === 'info' ? 'i' : '!');
      flag.setAttribute('aria-hidden', 'true');
      var text = span('');
      if (ids.length === 1) { var b = document.createElement('b'); b.textContent = M.get(ids[0]).name + ': '; text.appendChild(b); }
      text.appendChild(document.createTextNode(String(w.message)));
      row.appendChild(flag); row.appendChild(text);
      if (ids.length) {
        row.type = 'button';
        row.setAttribute('aria-label', (w.severity === 'error' ? 'Problem: ' : 'Note: ') + text.textContent + ' Select the shape.');
        row.addEventListener('click', function () { M.select(ids.filter(function (id) { return !!M.get(id); })); });
      }
      el.warns.appendChild(row);
    });
    if (list.length > MAX_WARNINGS) {
      var more = document.createElement('div'); more.className = 'warn warn--info';
      more.appendChild(span('')); more.appendChild(span('', '+ ' + (list.length - MAX_WARNINGS) + ' more notes'));
      el.warns.appendChild(more);
    }
  }
  function renderStats() {
    var IO = Editor.IO, r = IO && IO.result, t = r && r.totals, b = r && r.bounds;
    var stitches = t ? t.stitches : 0;
    el.statStitches.textContent = num(stitches);
    setLead(el.statTime, clock(t ? t.timeMin : 0));
    setLead(el.statSize, Editor.Units.size(b ? b.width : 0, b ? b.height : 0));
    el.statColors.textContent = String(t ? t.colors : 0);
    el.binds.forEach(function (n) {
      var k = n.getAttribute('data-bind');
      if (k === 'stitches') n.textContent = num(stitches);
      else if (k === 'time') n.textContent = clock(t ? t.timeMin : 0);
    });
    /* thread sequence: one block per colour stop, as wide as its share of the stitches */
    el.seq.textContent = '';
    if (r && r.threads && stitches > 0) {
      r.threads.forEach(function (th) {
        var i = document.createElement('i');
        i.style.width = Math.max(1, th.stitches / stitches * 100).toFixed(2) + '%';
        i.style.setProperty('--c', th.color);
        el.seq.appendChild(i);
      });
    }
    counts = {}; notes = {};
    if (r) {
      (r.objects || []).forEach(function (o) { if (o.id != null) counts[o.id] = o.stitches; });
      (r.warnings || []).forEach(function (w) {
        var ids = [];
        if (w.objectId != null) ids.push(w.objectId);
        (w.objectIndexes || []).forEach(function (i) { if (r.objects[i] && r.objects[i].id != null) ids.push(r.objects[i].id); });
        ids.forEach(function (id) { (notes[id] = notes[id] || []).push(String(w.message)); });
      });
    }
    updateCounts();
    renderWarnings(r);
    var label = stitches ? 'Stitch preview: ' + num(stitches) + ' stitches in ' + (t.colors) + (t.colors === 1 ? ' colour' : ' colours') : 'Stitch preview: empty';
    el.preview.setAttribute('aria-label', label);
  }

  /* =========================================================================
     START
     ========================================================================= */
  P.render = function () { renderProps(); renderUnits(); renderHoop(); renderFabric(); renderLayers(); renderStats(); };
  P.startRename = startRename;

  P.init = function () {
    el.statStitches = $('stat-stitches'); el.statTime = $('stat-time'); el.statSize = $('stat-size'); el.statColors = $('stat-colors');
    el.statSizeUnit = el.statSize ? el.statSize.querySelector('.unit') : null;
    el.unitBtns = Array.prototype.slice.call(document.querySelectorAll('[data-units]')); el.unitCorner = $('unit-corner'); el.gridToggle = $('grid-toggle');
    initProps(); initLayers();
    el.seq = $('thread-seq'); el.warns = $('warnings'); el.preview = $('preview-canvas');
    el.binds = Array.prototype.slice.call(document.querySelectorAll('[data-bind]'));

    Editor.on('change', function (e) {
      var reason = e && e.reason;
      if (reason === 'live' || reason === 'name') return;      /* a drag in progress changes no row */
      renderLayers(); renderProps(); renderHoop();
    });
    Editor.on('selection', function () { syncSelection(); renderProps(); });
    Editor.on('defaults', renderProps);
    Editor.on('stitch', renderStats);
    P.render();
  };
})();
