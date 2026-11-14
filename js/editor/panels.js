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
    var u = { paint: true, lineType: true, lineWidth: true, spacing: true, stitchLen: true, angle: true, pattern: true, fillStyle: true, lineDetail: M.defaults.fillStyle === 'lineart' };
    if (!sel.length) return u;
    u = { paint: false, lineType: false, lineWidth: false, spacing: false, stitchLen: false, angle: false, pattern: false, fillStyle: false, lineDetail: false };
    sel.forEach(function (o) {
      var p = M.paintOf(o), line = p !== 'fill', fill = p !== 'line', satin = line && o.lineType === 'satin';
      if (canFill(o)) u.paint = true;
      if (line) u.lineType = true;
      if (satin) u.lineWidth = true;
      if (fill || satin) u.spacing = true;
      if (fill || (line && !satin && o.lineType !== 'raw')) u.stitchLen = true;   /* imported stitches keep their own points */
      if (fill) { u.angle = true; u.pattern = true; u.fillStyle = true; if (o.fillStyle === 'lineart') u.lineDetail = true; }
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

    /* Stitch style (Fill / Line art) and, only for line art, its Detail */
    var fs = current('fillStyle');
    el.styleBtns.forEach(function (b) { b.setAttribute('aria-pressed', !fs.mixed && (fs.value || 'tatami') === b.getAttribute('data-fill-style') ? 'true' : 'false'); });
    setOff(el.styleBtns[0].closest('.prop'), !use.fillStyle, 'Only used by fills.', el.styleBtns);
    el.detailRow.hidden = !use.lineDetail;
    if (use.lineDetail) {
      var det = current('lineDetail'), lineArt = sel.filter(function (o) { return o.fillStyle === 'lineart'; });
      if (sel.length && lineArt.length !== sel.length) det = { value: lineArt[0].lineDetail, mixed: lineArt.some(function (o) { return o.lineDetail !== lineArt[0].lineDetail; }) };
      el.detailBtns.forEach(function (b) { b.setAttribute('aria-pressed', !det.mixed && (det.value || 'normal') === b.getAttribute('data-line-detail') ? 'true' : 'false'); });
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
    el.styleBtns = Array.prototype.slice.call(document.querySelectorAll('[data-fill-style]'));
    el.detailBtns = Array.prototype.slice.call(document.querySelectorAll('[data-line-detail]'));
    el.detailRow = $('line-detail-row');
    el.styleBtns.forEach(function (b) {
      var k = b.getAttribute('data-fill-style');
      if (!M.FILL_STYLES[k]) { b.hidden = true; return; }
      b.addEventListener('click', function () { apply('fillStyle', k); say(k === 'lineart' ? 'Stitch style line art' : 'Stitch style fill'); });
    });
    el.detailBtns.forEach(function (b) {
      b.addEventListener('click', function () {
        var k = b.getAttribute('data-line-detail');
        /* only the line-art shapes of the selection have a detail to change */
        var ids = M.selected().filter(function (o) { return o.fillStyle === 'lineart'; }).map(function (o) { return o.id; });
        if (ids.length) M.setProp(ids, 'lineDetail', k);
        M.setDefault('lineDetail', k);
        say('Line art detail ' + k);
      });
    });
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
     One row per shape, in sewing order. A group is a row of its own (caret, name, the stitches of
     all its shapes, ungroup) with its shapes indented under it; a click on it selects its shapes,
     dragging it moves them as one block, and shapes can be dragged in and out of it.
     ========================================================================= */
  var counts = {};          /* object id -> stitches, from the newest engine result */
  var notes = {};           /* object id -> [engine messages] */
  var anchor = null;        /* id a Shift-click range starts from */
  var drag = null;
  var renaming = null;
  var collapsed = {};       /* group id -> true while its shapes are folded away (view only, not saved) */
  var isMac = /mac|iphone|ipad|ipod/i.test((navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '');
  var MOD = isMac ? '⌘' : 'Ctrl+', SHIFT_MOD = isMac ? '⇧⌘' : 'Ctrl+Shift+';
  var GROUP_ICON = 'M2.5 2.5h5v5h-5zM8.5 8.5h5v5h-5zM1 1h14v14H1z';
  var UNGROUP_ICON = 'M2 2h5v5H2zM9 9h5v5H9z';

  function rows() { return Array.prototype.slice.call(el.list.children); }
  function rowOf(id) { var r = rows(); for (var i = 0; i < r.length; i++) if (r[i]._id === id) return r[i]; return null; }
  function groupRowOf(gid) { var r = rows(); for (var i = 0; i < r.length; i++) if (r[i]._gid === gid) return r[i]; return null; }
  function rowFrom(node) { while (node && node !== el.list) { if (node._id || node._gid) return node; node = node.parentNode; } return null; }
  /* what a row stands for: the shapes it selects */
  function rowIds(row) { return row._gid ? M.members(row._gid) : [row._id]; }

  function buildRow(o, i, child) {
    var row = document.createElement('div');
    row.className = 'layer' + (child ? ' layer--child' : ''); row.setAttribute('role', 'option'); row.tabIndex = -1; row._id = o.id;
    if (child) row._in = o.group;
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
  function buildGroupRow(g) {
    var row = document.createElement('div'), open = !collapsed[g.id];
    row.className = 'layer layer--group'; row.setAttribute('role', 'option'); row.tabIndex = -1; row._gid = g.id;
    row.setAttribute('aria-expanded', open ? 'true' : 'false');
    var caret = document.createElement('button');
    caret.type = 'button'; caret.className = 'layer__caret'; caret.tabIndex = -1;
    caret.setAttribute('aria-label', (open ? 'Fold ' : 'Unfold ') + g.name);
    caret.appendChild(svg(open ? 'M3 4.5 6 7.5 9 4.5' : 'M4.5 3 7.5 6 4.5 9', '0 0 12 12'));
    var un = document.createElement('button');
    un.type = 'button'; un.className = 'layer__del layer__ungroup'; un.tabIndex = -1;
    un.setAttribute('aria-label', 'Ungroup ' + g.name); un.title = 'Ungroup';
    un.appendChild(svg(UNGROUP_ICON, '0 0 16 16'));
    row.appendChild(caret);
    row.appendChild(svg(GROUP_ICON, '0 0 16 16', 'glyph glyph--group'));
    row.appendChild(span('name', g.name));
    row.appendChild(span('num count'));
    row.appendChild(un);
    return row;
  }
  function nameCell(row) { return row.querySelector('.name'); }
  function countCell(row) { return row.querySelector('.count'); }
  function fillCount(row, o) {
    var cell = countCell(row), flag = V.flags[o.id], n = counts[o.id];
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
  /* a group's row: the stitches of all its shapes, and the worst flag among them */
  function fillGroupCount(row, g) {
    var ids = M.members(g.id), total = 0, known = false, flag = null, cell = countCell(row);
    ids.forEach(function (id) {
      if (counts[id] != null) { total += counts[id]; known = true; }
      var f = V.flags[id]; if (f === 'error' || (f && !flag)) flag = f;
    });
    var text = known ? num(total) : '', sig = (flag || '') + '|' + text + '|' + g.name + '|' + ids.length + '|' + !!collapsed[g.id];
    if (cell._sig === sig) return;
    cell._sig = sig; cell.textContent = '';
    if (flag) { var fl = span('flag' + (flag === 'error' ? ' flag--error' : ''), '!'); fl.setAttribute('aria-hidden', 'true'); cell.appendChild(fl); }
    cell.appendChild(document.createTextNode(text));
    row.setAttribute('aria-label', 'Group ' + g.name + ', ' + ids.length + (ids.length === 1 ? ' shape' : ' shapes') + (known ? ', ' + num(total) + ' stitches' : '') + (collapsed[g.id] ? ', folded' : ''));
  }
  function updateCounts() {
    rows().forEach(function (row) {
      if (row._gid) { var g = M.group(row._gid); if (g) fillGroupCount(row, g); return; }
      var o = M.get(row._id); if (o) fillCount(row, o);
    });
  }
  function allSelected(ids) { return ids.length > 0 && ids.every(function (id) { return M.isSelected(id); }); }
  function syncSelection() {
    var list = rows(), tab = null;
    list.forEach(function (row) {
      var on = row._gid ? allSelected(M.members(row._gid)) : M.isSelected(row._id);
      row.setAttribute('aria-selected', on ? 'true' : 'false');
      row.tabIndex = -1;
      if (on && !tab) tab = row;
    });
    /* the shapes of a picked group are shown as part of it, a little lighter */
    list.forEach(function (row) { if (row._in) row.classList.toggle('is-in-picked', allSelected(M.members(row._in))); });
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
    renderGroupButton();
  }
  /* The header button groups the selection, or ungroups it when the selection is a group. */
  function groupMode() {
    if (!M.selection.length) return null;
    if (M.selectedGroup()) return 'ungroup';
    return 'group';
  }
  function renderGroupButton() {
    var b = el.groupBtn; if (!b) return;
    var mode = groupMode(), un = mode === 'ungroup';
    b.disabled = !mode;
    b.setAttribute('aria-label', un ? 'Ungroup' : 'Group selection');
    b.setAttribute('data-tip', un ? 'Ungroup' : 'Group');
    b.setAttribute('data-key', un ? SHIFT_MOD + 'G' : MOD + 'G');
    var p = b.querySelector('path'); if (p) p.setAttribute('d', un ? UNGROUP_ICON : GROUP_ICON);
  }
  function renderLayers() {
    if (renaming) endRename(false);
    var objs = M.doc.objects, active = document.activeElement;
    var focused = active && el.list.contains(active) ? rowFrom(active) : null;
    var focusId = focused ? (focused._id || null) : null, focusGid = focused ? (focused._gid || null) : null;
    el.list.textContent = '';
    var shown = {};
    objs.forEach(function (o, i) {
      var g = o.group ? M.group(o.group) : null;
      if (g && !shown[g.id]) { shown[g.id] = true; el.list.appendChild(buildGroupRow(g)); }
      if (g && collapsed[g.id]) return;
      el.list.appendChild(buildRow(o, i, !!g));
    });
    el.list.hidden = !objs.length;
    el.empty.hidden = !!objs.length;
    el.total.textContent = String(objs.length);
    el.count.textContent = String(objs.length);
    syncSelection(); updateCounts();
    var r = focusGid ? groupRowOf(focusGid) : focusId ? rowOf(focusId) : null;
    if (!r && focusId) { var go = M.get(focusId); if (go && go.group) r = groupRowOf(go.group); }   /* folded away: its group */
    if (r) r.focus({ preventScroll: true });
  }
  function setCollapsed(gid, yes) {
    if (!!collapsed[gid] === !!yes) return;
    if (yes) collapsed[gid] = true; else delete collapsed[gid];
    var g = M.group(gid);
    renderLayers();
    var row = groupRowOf(gid); if (row) row.focus({ preventScroll: true });
    if (g) say(g.name + (yes ? ' folded' : ' unfolded'));
  }

  /* ---------- group / ungroup (header button, Cmd/Ctrl+G, Shift+Cmd/Ctrl+G, the right-click menu) */
  function groupSelection() {
    var ids = M.selection.slice();
    if (!ids.length) { say('Select shapes to group'); return null; }
    var g = M.groupShapes(ids);
    if (g) { delete collapsed[g.id]; say(g.name + ': ' + M.members(g.id).length + ' shapes grouped'); }
    return g;
  }
  function ungroupSelection() {
    var n = M.ungroup(M.selection.slice());
    if (n) say(n === 1 ? 'Ungrouped' : n + ' groups ungrouped');
    return n;
  }
  P.groupSelection = groupSelection;
  P.ungroupSelection = ungroupSelection;
  P.groupMode = groupMode;
  P.setCollapsed = setCollapsed;

  /* ---------- rename in place ------------------------------------------------ */
  function startRename(id, isGroup) {
    var row = isGroup ? groupRowOf(id) : rowOf(id), o = isGroup ? M.group(id) : M.get(id);
    if (!row && !isGroup && o && o.group && collapsed[o.group]) { setCollapsed(o.group, false); row = rowOf(id); }
    if (!row || !o) return;
    if (renaming) endRename(true);
    var input = document.createElement('input');
    input.type = 'text'; input.className = 'layer__rename'; input.maxLength = 60; input.value = o.name;
    input.setAttribute('aria-label', 'Name of ' + o.name); input.autocomplete = 'off'; input.spellcheck = false;
    nameCell(row).setAttribute('data-editing', '');
    row.appendChild(input);
    renaming = { id: id, group: !!isGroup, input: input, row: row };
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
    nameCell(r.row).removeAttribute('data-editing');
    var changed = commit && (r.group ? M.renameGroup(r.id, value) : M.rename(r.id, value));   /* rebuilds the list when the name changed */
    if (changed) say('Renamed to ' + (r.group ? M.group(r.id) : M.get(r.id)).name);
    if (had && !fromBlur) { var row = r.group ? groupRowOf(r.id) : rowOf(r.id); if (row) row.focus({ preventScroll: true }); }
  }

  /* ---------- pointer: select, drag to reorder ---------------------------------- */
  function clearDrop() {
    rows().forEach(function (r) { r.classList.remove('is-drop-before', 'is-drop-after', 'is-drop-in', 'is-dragging'); });
    el.list.classList.remove('is-sorting');
  }
  function selectRange(a, b) {
    var i = M.indexOf(a), j = M.indexOf(b); if (i === -1 || j === -1) return M.select(M.unitOf(b));
    var lo = Math.min(i, j), hi = Math.max(i, j), ids = [];
    for (var k = lo; k <= hi; k++) ids.push(M.doc.objects[k].id);
    M.select(ids);
  }
  function onDown(e) {
    var row = rowFrom(e.target); if (!row || e.button !== 0) return;
    if (e.target.closest && e.target.closest('.layer__del, .layer__rename, .layer__caret')) return;
    var ids = rowIds(row); if (!ids.length) return;
    var key = row._gid ? ids[0] : row._id, mod = e.metaKey || e.ctrlKey, was = allSelected(ids);
    if (e.shiftKey && anchor && M.get(anchor)) selectRange(anchor, row._gid ? ids[ids.length - 1] : key);
    else if (mod) {
      var rest = M.selection.filter(function (id) { return ids.indexOf(id) === -1; });
      M.select(was ? rest : rest.concat(ids)); anchor = key;
    } else { if (!was) M.select(ids); anchor = key; }
    drag = { ids: ids, gid: row._gid || null, row: row, y: e.clientY, pid: e.pointerId, moved: false, target: null,
      collapse: was && !e.shiftKey && !mod && M.selection.length > ids.length, touch: e.pointerType === 'touch' };
    /* touch scrolls the list instead (touch-action: pan-y); reorder with the arrow buttons */
    if (!drag.touch) { try { row.setPointerCapture(e.pointerId); } catch (x) { /* older browsers */ } }
  }
  /* the shape sewn right after `id`, leaving out the shapes being moved (null: none) */
  function nextAfter(id, moving) {
    var a = M.doc.objects, i = M.indexOf(id);
    for (i = i + 1; i < a.length; i++) if (moving.indexOf(a[i].id) === -1) return a[i].id;
    return null;
  }
  function firstNotMoving(ids, moving) { for (var i = 0; i < ids.length; i++) if (moving.indexOf(ids[i]) === -1) return ids[i]; return null; }
  function lastRowOfGroup(list, gid) { var last = null; list.forEach(function (r) { if (r._gid === gid || r._in === gid) last = r; }); return last; }
  /* Where a drop at clientY lands: { before: id | null, group: id | null (loose) | undefined (keep),
     mark: the row the line is drawn on, at: 'before' | 'after', inside: drawn indented } */
  function dropTarget(clientY) {
    var list = rows().filter(function (r) { return !(drag.gid && (r._gid === drag.gid || r._in === drag.gid)); });
    if (!list.length) return null;
    var moving = drag.ids, i, r = null, box = null;
    for (i = 0; i < list.length; i++) {
      box = list[i].getBoundingClientRect();
      if (clientY < box.bottom) { r = list[i]; break; }
    }
    if (!r) return { before: null, group: drag.gid ? undefined : null, mark: list[list.length - 1], at: 'after' };   /* below every row: sewn last */
    var gid = r._gid || r._in || null, upper = clientY < box.top + box.height / 2, mem;
    if (drag.gid) {
      /* a group moves past whole groups and loose shapes only */
      if (gid) {
        var head = groupRowOf(gid), tail = lastRowOfGroup(list, gid);
        var top = head.getBoundingClientRect().top, bottom = tail.getBoundingClientRect().bottom;
        mem = M.members(gid);
        if (clientY < (top + bottom) / 2) return { before: mem[0], group: undefined, mark: head, at: 'before' };
        return { before: nextAfter(mem[mem.length - 1], moving), group: undefined, mark: tail, at: 'after' };
      }
      if (upper) return { before: r._id, group: undefined, mark: r, at: 'before' };
      return { before: nextAfter(r._id, moving), group: undefined, mark: r, at: 'after' };
    }
    if (r._gid) {
      mem = M.members(r._gid);
      var first = firstNotMoving(mem, moving);
      if (upper || !first) return { before: first || nextAfter(mem[mem.length - 1], moving), group: null, mark: r, at: 'before' };   /* before the group, loose */
      if (collapsed[r._gid]) return { before: nextAfter(mem[mem.length - 1], moving), group: null, mark: r, at: 'after' };
      return { before: first, group: r._gid, mark: r, at: 'after', inside: true };                                                     /* first in the group */
    }
    if (r._in) {
      if (upper) return { before: r._id, group: r._in, mark: r, at: 'before', inside: true };
      return { before: nextAfter(r._id, moving), group: r._in, mark: r, at: 'after', inside: true };
    }
    if (upper) return { before: r._id, group: null, mark: r, at: 'before' };
    return { before: nextAfter(r._id, moving), group: null, mark: r, at: 'after' };
  }
  function onMove(e) {
    if (!drag || e.pointerId !== drag.pid || drag.touch) return;
    if (!drag.moved) {
      if (Math.abs(e.clientY - drag.y) < 5 || M.doc.objects.length < 2) return;
      drag.moved = true;
      rows().forEach(function (r) { if (r === drag.row || (drag.gid && r._in === drag.gid)) r.classList.add('is-dragging'); });
      el.list.classList.add('is-sorting');
    }
    var t = dropTarget(e.clientY);
    rows().forEach(function (r2) { r2.classList.remove('is-drop-before', 'is-drop-after', 'is-drop-in'); });
    drag.target = t;
    if (!t) return;
    t.mark.classList.add(t.at === 'before' ? 'is-drop-before' : 'is-drop-after');
    if (t.inside) t.mark.classList.add('is-drop-in');
  }
  /* nothing would change: same group, and already sewn right before t.before */
  function sameSpot(ids, t) {
    var a = M.doc.objects, first = M.indexOf(ids[0]), last = M.indexOf(ids[ids.length - 1]);
    var o = M.get(ids[0]), same = t.group === undefined || (t.group || null) === (o.group || null);
    var after = last + 1 < a.length ? a[last + 1].id : null;
    return same && last - first + 1 === ids.length && after === t.before;
  }
  function onUp(e) {
    if (!drag || e.pointerId !== drag.pid) return;
    var d = drag; drag = null;
    if (d.moved) {
      clearDrop();
      var t = d.target;
      if (t && !sameSpot(d.ids, t)) {
        var o = M.get(d.ids[0]), was = o && o.group;
        var label = t.group && t.group !== was ? 'Move into group' : (t.group === null && was ? 'Move out of group' : 'Reorder');
        if (M.place(d.ids, t.before, t.group, label)) {
          var g = d.gid && M.group(d.gid);
          if (g) say(g.name + ' moved in the sewing order');
          else if (o) say(o.name + (label === 'Move into group' ? ' moved into ' + M.group(t.group).name : label === 'Move out of group' ? ' moved out of its group' : ' is now number ' + (M.indexOf(o.id) + 1) + ' of ' + M.doc.objects.length + ' in the sewing order'));
        }
      }
    } else if (d.collapse) M.select(d.ids);
  }
  function onCancel(e) {
    if (!drag || (e.pointerId != null && e.pointerId !== drag.pid)) return;
    drag = null; clearDrop();
  }

  /* ---------- keyboard ------------------------------------------------------------ */
  function reorderSelection(dir) {
    var ids = M.selection.slice(); if (!ids.length) return false;
    var g = M.selectedGroup();
    if (!M.reorder(ids, dir)) return false;
    var o = M.get(ids[0]);
    say(g ? g.name + ' moved ' + (dir > 0 ? 'later' : 'earlier') : ids.length === 1 && o ? o.name + ' is now number ' + (M.indexOf(o.id) + 1) + ' of ' + M.doc.objects.length : 'Moved ' + ids.length + ' shapes ' + (dir > 0 ? 'later' : 'earlier'));
    return true;
  }
  P.reorderSelection = reorderSelection;

  function pickRow(row, add) {
    var ids = rowIds(row);
    if (add) M.select(M.selection.concat(ids.filter(function (id) { return !M.isSelected(id); })));
    else { M.select(ids); anchor = ids[0]; }
  }
  function onKey(e) {
    var row = rowFrom(e.target); if (!row || e.target !== row) return;
    var list = rows(), i = list.indexOf(row), key = e.key, next = null, gid = row._gid || null;
    if (key === 'ArrowDown' || key === 'ArrowUp') {
      e.preventDefault();
      var dir = key === 'ArrowDown' ? 1 : -1;
      if (e.altKey) { if (!allSelected(rowIds(row))) pickRow(row); reorderSelection(dir); return; }
      next = list[i + dir];
    } else if (gid && (key === 'ArrowLeft' || key === 'ArrowRight')) { e.preventDefault(); setCollapsed(gid, key === 'ArrowLeft'); return; }
    else if (row._in && key === 'ArrowLeft') { e.preventDefault(); next = groupRowOf(row._in); }
    else if (key === 'Home') { e.preventDefault(); next = list[0]; }
    else if (key === 'End') { e.preventDefault(); next = list[list.length - 1]; }
    else if (key === 'Enter' || key === 'F2') { e.preventDefault(); startRename(gid || row._id, !!gid); return; }
    else if (key === ' ') {
      e.preventDefault();
      var own = rowIds(row);
      if (e.metaKey || e.ctrlKey) { if (allSelected(own)) M.select(M.selection.filter(function (id) { return own.indexOf(id) === -1; })); else pickRow(row, true); }
      else pickRow(row);
      anchor = own[0]; return;
    } else if (key === 'Delete' || key === 'Backspace') {
      e.preventDefault();
      var ids = allSelected(rowIds(row)) ? M.selection.slice() : rowIds(row);
      if (M.remove(ids, ids.length > 1 ? 'Delete ' + ids.length + ' shapes' : 'Delete')) {
        say(ids.length > 1 ? ids.length + ' shapes deleted' : 'Shape deleted');
        var left = rows(), f = left[Math.min(i, left.length - 1)];
        if (f) f.focus({ preventScroll: true }); else V.el.canvas.focus({ preventScroll: true });
      }
      return;
    } else return;
    if (next) {
      pickRow(next, e.shiftKey);
      next.focus(); if (next.scrollIntoView) next.scrollIntoView({ block: 'nearest' });
    }
  }

  function initLayers() {
    el.list = $('layers-list'); el.empty = $('layers-empty'); el.total = $('layer-total'); el.count = $('layer-count');
    el.up = $('layer-up'); el.down = $('layer-down');
    /* the Group button sits with the sewing-order buttons (made here, so the page markup stays as it is) */
    el.groupBtn = $('layer-group');
    if (!el.groupBtn && el.up && el.up.parentNode) {
      var gb = document.createElement('button');
      gb.className = 'mini'; gb.type = 'button'; gb.id = 'layer-group'; gb.disabled = true;
      gb.setAttribute('data-tip-pos', 'left');
      gb.appendChild(svg(GROUP_ICON, '0 0 16 16'));
      el.up.parentNode.insertBefore(gb, el.up);
      el.groupBtn = gb;
    }
    if (el.groupBtn) el.groupBtn.addEventListener('click', function () { if (groupMode() === 'ungroup') ungroupSelection(); else groupSelection(); });
    el.list.addEventListener('pointerdown', onDown);
    el.list.addEventListener('pointermove', onMove);
    el.list.addEventListener('pointerup', onUp);
    el.list.addEventListener('pointercancel', onCancel);
    el.list.addEventListener('lostpointercapture', function (e) { if (drag && drag.moved) onCancel(e); });
    el.list.addEventListener('keydown', onKey);
    el.list.addEventListener('dblclick', function (e) {
      var row = rowFrom(e.target);
      if (row && !(e.target.closest && e.target.closest('.layer__del, .layer__caret'))) startRename(row._gid || row._id, !!row._gid);
    });
    el.list.addEventListener('click', function (e) {
      var caret = e.target.closest ? e.target.closest('.layer__caret') : null;
      if (caret) { var cr = rowFrom(caret); if (cr && cr._gid) setCollapsed(cr._gid, !collapsed[cr._gid]); return; }
      var del = e.target.closest ? e.target.closest('.layer__del') : null, row = del && rowFrom(del);
      if (!row) return;
      if (row._gid) { var g = M.group(row._gid), gname = g ? g.name : 'Group'; if (M.ungroup(M.members(row._gid))) say(gname + ' ungrouped'); return; }
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
