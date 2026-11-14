/* ==========================================================================
   EMBROIDERY LABS - js/editor/model.js
   The document (in millimetres), the selection, the defaults for the next
   shape, and the undo history. No DOM. Everything that changes the document
   goes through Model.commit() or a Model.begin() / Model.end() pair, so every
   change is undoable, redrawn, re-stitched and autosaved by the listeners.

   Events (Editor.on):
     'change'     the document changed            { reason }
     'selection'  the selection changed
     'defaults'   the next-shape defaults changed
     'history'    undo / redo availability changed
     'units'      the display unit changed (inches / millimetres); the document does not
     'prefs'      a view preference changed (show grid)
   ========================================================================== */
(function () {
  'use strict';
  var Editor = window.Editor = window.Editor || {};
  var G = Editor.Geom;

  /* ---------- tiny event bus ------------------------------------------------ */
  var listeners = {};
  Editor.on = function (name, fn) { (listeners[name] = listeners[name] || []).push(fn); };
  Editor.emit = function (name, data) {
    var list = listeners[name]; if (!list) return;
    for (var i = 0; i < list.length; i++) list[i](data);
  };

  /* ---------- display units and view preferences ------------------------------
     The document is always millimetres (so are the stitch settings: that is how
     machines and thread charts state them). Units only change how SIZES are
     shown: hoop, design size, rulers, cursor position. Inches are the default. */
  var MM_PER_IN = 25.4, PREFS_KEY = 'el-editor-prefs-v1';
  var prefs = { units: 'in', grid: false, hoop: { w: 130, h: 180 } };   /* new designs start on the 5 x 7 in hoop until another is picked */
  try {
    var stored = JSON.parse(window.localStorage.getItem(PREFS_KEY) || 'null');
    if (stored && (stored.units === 'in' || stored.units === 'mm')) prefs.units = stored.units;
    if (stored && typeof stored.grid === 'boolean') prefs.grid = stored.grid;
    if (stored && stored.hoop && isFinite(stored.hoop.w) && isFinite(stored.hoop.h) && stored.hoop.w >= 10 && stored.hoop.h >= 10 && stored.hoop.w <= 1000 && stored.hoop.h <= 1000) prefs.hoop = { w: +stored.hoop.w, h: +stored.hoop.h };
  } catch (e) { /* private mode or damaged entry: keep the defaults */ }
  function savePrefs() { try { window.localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch (e) { /* not saved, still works */ } }
  function trim(text) { return text.indexOf('.') < 0 ? text : text.replace(/0+$/, '').replace(/\.$/, ''); }
  var U = Editor.Units = {
    MM_PER_IN: MM_PER_IN,
    get: function () { return prefs.units; },
    set: function (mode) {
      if ((mode !== 'in' && mode !== 'mm') || mode === prefs.units) return false;
      prefs.units = mode; savePrefs(); Editor.emit('units'); return true;
    },
    toggle: function () { return U.set(prefs.units === 'in' ? 'mm' : 'in'); },
    label: function () { return prefs.units; },
    word: function () { return prefs.units === 'in' ? 'inches' : 'millimetres'; },
    /* one length as a number string in the display unit: 2 decimals for inches, 1 for mm */
    num: function (mm) { return prefs.units === 'in' ? (mm / MM_PER_IN).toFixed(2) : mm.toFixed(1); },
    /* the same without padding zeros: "4" not "4.00" */
    short: function (mm) { return trim(U.num(mm)); },
    size: function (w, h) { return U.num(w) + ' x ' + U.num(h); },
    sizeShort: function (w, h) { return U.short(w) + ' x ' + U.short(h); },
    text: function (mm) { return U.short(mm) + ' ' + prefs.units; }
  };
  Editor.Prefs = {
    grid: function () { return prefs.grid; },
    setGrid: function (on) { on = !!on; if (on === prefs.grid) return; prefs.grid = on; savePrefs(); Editor.emit('prefs'); },
    /* the hoop picked last: what the next new design gets */
    hoop: function () { return { w: prefs.hoop.w, h: prefs.hoop.h }; },
    setHoop: function (w, h) { prefs.hoop = { w: w, h: h }; savePrefs(); }
  };

  /* ---------- constants ----------------------------------------------------- */
  var ENG = window.Engine || {};
  var D = ENG.DEFAULTS || { fill: { spacing: 0.4, stitchLength: 3, angle: 0 }, line: { type: 'running', width: 3 } };
  var L = ENG.LIMITS || { coord: 2000, fillSpacing: [0.2, 2], fillStitchLength: [1, 7], satinWidth: [1, 12] };
  var HISTORY_MAX = 200;
  var COALESCE_MS = 1200;
  var NAME_MAX = 60;
  var MAX_OBJECTS = 2000;
  var MAX_POINTS = 20000;

  var HOOPS = [[100, 100], [130, 180], [160, 260], [200, 200], [200, 300], [240, 360], [272, 408]];
  var TYPE_NAMES = { rect: 'Rectangle', ellipse: 'Ellipse', line: 'Line', polygon: 'Polygon', pen: 'Stroke', path: 'Shape' };
  var PAINTS = { fill: 1, line: 1, both: 1 };
  var LINE_TYPES = { running: 1, bean: 1, satin: 1, raw: 1 };   /* raw = stitches opened from a machine file, sewn point for point */
  /* Fill patterns: the engine's own list, so the panel can never offer one it does not sew. */
  var PATTERNS = ENG.FILL_PATTERNS || { smooth: { label: 'Smooth' } };
  function isPattern(v) { return typeof v === 'string' && Object.prototype.hasOwnProperty.call(PATTERNS, v); }
  /* Stitch styles for the fill: the engine's own list when it has one (Engine.FILL_STYLES), else the two
     this editor knows. 'tatami' is the plain fill; 'lineart' sews thin lines along their middle. An engine
     without line art sews an unknown style as the plain fill, so the choice is always safe to offer. */
  var FILL_STYLES = ENG.FILL_STYLES && typeof ENG.FILL_STYLES === 'object' && ENG.FILL_STYLES.tatami ? ENG.FILL_STYLES
    : { tatami: { label: 'Fill' }, lineart: { label: 'Line art' } };
  function isFillStyle(v) { return typeof v === 'string' && Object.prototype.hasOwnProperty.call(FILL_STYLES, v); }
  var LINE_DETAILS = { fine: 1, normal: 1, bold: 1 };
  function isDetail(v) { return typeof v === 'string' && Object.prototype.hasOwnProperty.call(LINE_DETAILS, v); }
  /* Ranges of the per-object stitch settings: the engine's own limits. */
  var RANGES = {
    lineWidth: [L.satinWidth[0], L.satinWidth[1]],
    spacing: [L.fillSpacing[0], L.fillSpacing[1]],
    stitchLen: [L.fillStitchLength[0], L.fillStitchLength[1]],
    angle: [0, 175]
  };

  var M = Editor.Model = {
    HOOPS: HOOPS, RANGES: RANGES, TYPE_NAMES: TYPE_NAMES, PATTERNS: PATTERNS, FILL_STYLES: FILL_STYLES, LINE_DETAILS: LINE_DETAILS, MAX_OBJECTS: MAX_OBJECTS, MAX_POINTS: MAX_POINTS,
    /* groups: [{ id, name }]. Editor-only: a member carries `group: id`, members always sit next to each
       other in `objects`, and the engine never sees any of it (M.toEngine copies named fields only). */
    doc: { name: 'untitled', hoop: { w: D.hoop ? D.hoop.width : 100, h: D.hoop ? D.hoop.height : 100 }, objects: [], groups: [] },
    /* Style the next drawn shape gets. Edited by the panel when nothing is selected. */
    defaults: { color: '#3157e0', paint: 'fill', lineType: D.line.type || 'running', lineWidth: D.line.width || 3, spacing: D.fill.spacing, stitchLen: D.fill.stitchLength, angle: D.fill.angle || 0, pattern: 'smooth', fillStyle: 'tatami', lineDetail: 'normal' },
    selection: [],          /* object ids, in the order they were picked */
    clipboard: null
  };

  /* ---------- ids and names -------------------------------------------------- */
  var idSeq = 0;
  function uid() { return 'o' + Date.now().toString(36) + (idSeq++).toString(36) + Math.floor(Math.random() * 1296).toString(36); }
  function nextName(type) {
    var base = TYPE_NAMES[type] || 'Shape', max = 0, re = new RegExp('^' + base + ' (\\d+)$');
    M.doc.objects.forEach(function (o) { var m = re.exec(o.name); if (m) max = Math.max(max, parseInt(m[1], 10)); });
    return base + ' ' + (max + 1);
  }
  function cleanName(v, fallback) {
    var s = String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
    return s || fallback;
  }
  M.cleanName = cleanName;

  /* ---------- lookups --------------------------------------------------------- */
  M.get = function (id) { var o = M.doc.objects; for (var i = 0; i < o.length; i++) if (o[i].id === id) return o[i]; return null; };
  M.indexOf = function (id) { var o = M.doc.objects; for (var i = 0; i < o.length; i++) if (o[i].id === id) return i; return -1; };
  M.isSelected = function (id) { return M.selection.indexOf(id) !== -1; };
  /* Selected objects in sewing order */
  M.selected = function () { return M.doc.objects.filter(function (o) { return M.selection.indexOf(o.id) !== -1; }); };
  /* What the engine will really do: an open shape can only be a line. */
  M.paintOf = function (o) { return G.isClosed(o) ? o.paint : 'line'; };
  /* Which stitch glyph stands for the object: 'fill' | 'satin' | 'running' */
  M.glyphOf = function (o) { var p = M.paintOf(o); return p !== 'line' ? 'fill' : (o.lineType === 'satin' ? 'satin' : 'running'); };

  /* ---------- selection -------------------------------------------------------- */
  function sameList(a, b) { if (a.length !== b.length) return false; for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; }
  M.select = function (ids) {
    var next = [];
    (ids || []).forEach(function (id) { if (M.get(id) && next.indexOf(id) === -1) next.push(id); });
    if (sameList(next, M.selection)) return;
    M.selection = next;
    Editor.emit('selection');
  };
  M.toggle = function (id) {
    var i = M.selection.indexOf(id), next = M.selection.slice();
    if (i === -1) next.push(id); else next.splice(i, 1);
    M.select(next);
  };

  /* ---------- history ------------------------------------------------------------
     Snapshot based: an entry holds the document before and after as JSON strings.
     A drawing is small (a few KB), so 200 entries cost little and undo can never
     drift out of step with what was done. */
  var hist = [], pos = 0, txn = null;
  function takeSnap() { return JSON.stringify({ hoop: M.doc.hoop, objects: M.doc.objects, groups: M.doc.groups || [] }); }
  var snap = takeSnap();
  function restore(s) {
    var d = JSON.parse(s);
    M.doc.hoop = d.hoop; M.doc.objects = d.objects; M.doc.groups = d.groups || []; snap = s;
  }
  function pruneSelection() { M.selection = M.selection.filter(function (id) { return !!M.get(id); }); }
  function push(entry) {
    hist.length = pos;
    hist.push(entry); pos = hist.length;
    if (hist.length > HISTORY_MAX) { hist.splice(0, hist.length - HISTORY_MAX); pos = hist.length; }
  }
  function changed(reason) { Editor.emit('change', { reason: reason }); Editor.emit('selection'); Editor.emit('history'); }

  /* Run `fn` (which edits M.doc and may edit M.selection) as one undo step.
     opts.key: steps with the same key made within about a second merge into one
     (slider scrubbing, colour picking, arrow-key nudging). Returns true if the
     document changed. */
  M.commit = function (label, fn, opts) {
    if (txn) { fn(); M.touch(); return true; }
    var before = snap, selBefore = M.selection.slice();
    fn();
    normalizeGroups();
    pruneSelection();
    var after = takeSnap();
    if (after === before) { if (!sameList(selBefore, M.selection)) Editor.emit('selection'); return false; }
    snap = after;
    var key = opts && opts.key, now = Date.now(), top = hist[pos - 1];
    if (key && top && pos === hist.length && top.key === key && now - top.t < COALESCE_MS) {
      top.after = after; top.selAfter = M.selection.slice(); top.t = now;
    } else {
      push({ label: label, before: before, after: after, selBefore: selBefore, selAfter: M.selection.slice(), key: key || null, t: now });
    }
    changed(label);
    return true;
  };
  /* A drag: begin(), edit M.doc freely and call touch() to redraw, then end(label)
     records ONE undo step, or cancel() puts everything back. */
  M.begin = function () { if (!txn) txn = { before: snap, selBefore: M.selection.slice() }; };
  M.inTransaction = function () { return !!txn; };
  M.touch = function () { Editor.emit('change', { reason: 'live' }); };
  M.end = function (label) {
    if (!txn) return false;
    var t = txn; txn = null;
    normalizeGroups();
    pruneSelection();
    var after = takeSnap();
    if (after === t.before) { Editor.emit('selection'); return false; }
    snap = after;
    push({ label: label, before: t.before, after: after, selBefore: t.selBefore, selAfter: M.selection.slice(), key: null, t: Date.now() });
    changed(label);
    return true;
  };
  M.cancel = function () {
    if (!txn) return;
    var t = txn; txn = null;
    restore(t.before); M.selection = t.selBefore;
    changed('cancel');
  };
  /* Stop merging into the newest step: called when a slider or colour picker is
     let go, so the next scrub of the same control is its own undo step. */
  M.seal = function () { if (pos > 0) hist[pos - 1].key = null; };
  M.canUndo = function () { return pos > 0; };
  M.canRedo = function () { return pos < hist.length; };
  M.undoLabel = function () { return pos > 0 ? hist[pos - 1].label : ''; };
  M.redoLabel = function () { return pos < hist.length ? hist[pos].label : ''; };
  M.historySize = function () { return hist.length; };
  M.undo = function () {
    if (txn || pos === 0) return null;
    var e = hist[--pos];
    restore(e.before); M.selection = e.selBefore.slice(); pruneSelection();
    changed('undo');
    return e.label;
  };
  M.redo = function () {
    if (txn || pos >= hist.length) return null;
    var e = hist[pos++];
    restore(e.after); M.selection = e.selAfter.slice(); pruneSelection();
    changed('redo');
    return e.label;
  };

  /* ---------- making objects --------------------------------------------------- */
  /* geom: { type, ...geometry fields }. Style comes from the defaults. */
  M.make = function (geom) {
    var d = M.defaults;
    var o = { id: uid(), name: nextName(geom.type), type: geom.type };
    G.copyGeom(o, geom);
    G.transform(o, 0, 0, 1, 1, 0, 0);                       /* rounds to 1/100 mm */
    o.color = d.color; o.paint = G.isClosed(o) ? d.paint : 'line';
    o.lineType = d.lineType; o.lineWidth = d.lineWidth; o.spacing = d.spacing; o.stitchLen = d.stitchLen; o.angle = d.angle;
    o.pattern = isPattern(d.pattern) ? d.pattern : 'smooth';
    o.fillStyle = isFillStyle(d.fillStyle) ? d.fillStyle : 'tatami';
    o.lineDetail = isDetail(d.lineDetail) ? d.lineDetail : 'normal';
    return o;
  };
  /* Every style key an object carries (what a piece of it inherits). */
  /* `underlay` is only ever stored as false (set by Turn into stitches for photo fills); missing means the engine default. */
  var STYLE_KEYS = ['color', 'paint', 'lineType', 'lineWidth', 'spacing', 'stitchLen', 'angle', 'pattern', 'fillStyle', 'lineDetail', 'underlay'];
  M.STYLE_KEYS = STYLE_KEYS;
  /* A new object with geometry `geom` and every style field of `o` (the pieces of a cut). */
  M.piece = function (o, geom, name) {
    var n = { id: uid(), name: cleanName(name, o.name), type: geom.type };
    G.copyGeom(n, geom);
    STYLE_KEYS.forEach(function (k) { if (o[k] !== undefined) n[k] = o[k]; });
    if (o.group) n.group = o.group;                          /* a piece stays in the group of its shape */
    if (!G.isClosed(n)) n.paint = 'line';
    return n;
  };
  /* A piece left over when part of a line was erased: an open stroke with the style of the original. */
  M.strokePiece = function (o, pts) {
    var n = { id: uid(), name: o.name, type: 'pen', pts: pts.map(function (p) { return [G.r2(p[0]), G.r2(p[1])]; }), closed: false };
    ['color', 'lineType', 'lineWidth', 'spacing', 'stitchLen', 'angle', 'pattern', 'fillStyle', 'lineDetail', 'underlay'].forEach(function (k) { if (o[k] !== undefined) n[k] = o[k]; });
    if (o.group) n.group = o.group;
    n.paint = 'line';
    return n;
  };
  M.add = function (geom, label) {
    var o = M.make(geom);
    M.commit(label || ('Draw ' + TYPE_NAMES[o.type].toLowerCase()), function () { M.doc.objects.push(o); M.selection = [o.id]; });
    return o;
  };

  /* Add several ready-made shapes as ONE undo step (SVG import, the example design).
     list: [{ geom, style }] where style may hold color, paint, lineType, lineWidth,
     spacing, stitchLen, angle and name; anything missing or invalid falls back to
     the defaults. Returns the new objects ([] when there is no room for them). */
  M.addMany = function (list, label) {
    var made = [], names = {};
    if (!list || !list.length || M.doc.objects.length + list.length > MAX_OBJECTS) return made;
    list.forEach(function (item) {
      var o = M.make(item.geom), st = item.style || {}, base = TYPE_NAMES[o.type] || 'Shape';
      /* M.make numbers from the document, which does not hold the earlier items of this list yet */
      var m = /^(.*) (\d+)$/.exec(o.name), n = m ? parseInt(m[2], 10) : 1;
      names[base] = Math.max(names[base] || 0, n - 1) + 1;
      o.name = st.name ? cleanName(st.name, base + ' ' + names[base]) : base + ' ' + names[base];
      STYLE_KEYS.forEach(function (k) {
        if (st[k] == null) return;
        var v = validProp(k, st[k]); if (v !== null) o[k] = v;
      });
      if (!G.isClosed(o)) o.paint = 'line';
      made.push(o);
    });
    M.commit(label || 'Add shapes', function () {
      made.forEach(function (o) { M.doc.objects.push(o); });
      M.selection = made.map(function (o) { return o.id; });
    });
    return made;
  };

  /* ---------- edits -------------------------------------------------------------- */
  M.remove = function (ids, label) {
    if (!ids || !ids.length) return false;
    return M.commit(label || 'Delete', function () {
      M.doc.objects = M.doc.objects.filter(function (o) { return ids.indexOf(o.id) === -1; });
      M.selection = M.selection.filter(function (id) { return ids.indexOf(id) === -1; });
    });
  };
  M.clear = function () {
    return M.commit('Clear design', function () { M.doc.objects = []; M.selection = []; });
  };
  M.rename = function (id, name) {
    var o = M.get(id); if (!o) return false;
    var n = cleanName(name, o.name);
    return M.commit('Rename', function () { o.name = n; });
  };
  /* Set one style property on objects. Values are validated here, so no caller
     can put a bad number or colour into the document. */
  function validProp(key, value) {
    if (key === 'color') return G.hex(value);
    if (key === 'paint') return PAINTS[value] ? value : null;
    if (key === 'lineType') return LINE_TYPES[value] ? value : null;
    if (key === 'pattern') return isPattern(value) ? value : null;
    if (key === 'fillStyle') return isFillStyle(value) ? value : null;
    if (key === 'lineDetail') return isDetail(value) ? value : null;
    if (key === 'underlay') return value === false ? false : null;
    if (RANGES[key]) { var v = Number(value); if (!isFinite(v)) return null; return G.r2(G.clamp(v, RANGES[key][0], RANGES[key][1])); }
    return null;
  }
  M.validProp = validProp;
  M.setProp = function (ids, key, value, coalesce) {
    var v = validProp(key, value); if (v === null) return false;
    return M.commit('Change ' + PROP_LABELS[key], function () {
      ids.forEach(function (id) {
        var o = M.get(id); if (!o) return;
        if (key === 'paint' && !G.isClosed(o)) {
          /* a straight line stays a line; a freehand stroke asked to fill is closed first */
          if (o.type !== 'pen' || v === 'line' || o.pts.length < 3) return;
          o.closed = true;
        }
        o[key] = v;
      });
    }, coalesce ? { key: 'prop:' + key + ':' + ids.join(',') } : null);
  };
  var PROP_LABELS = { color: 'thread', paint: 'paint', lineType: 'line type', lineWidth: 'line width', spacing: 'density', stitchLen: 'stitch length', angle: 'fill angle', pattern: 'fill pattern', fillStyle: 'stitch style', lineDetail: 'line detail', underlay: 'underlay' };
  M.setDefault = function (key, value) {
    var v = validProp(key, value); if (v === null || M.defaults[key] === v) return false;
    M.defaults[key] = v;
    Editor.emit('defaults');
    return true;
  };

  M.nudge = function (dx, dy) {
    var sel = M.selected(); if (!sel.length) return false;
    return M.commit('Move', function () { sel.forEach(function (o) { G.translate(o, dx, dy); }); }, { key: 'nudge:' + M.selection.join(',') });
  };

  function cloneObj(o) { var c = JSON.parse(JSON.stringify(o)); c.id = uid(); return c; }
  /* Copies of shapes: a group that was copied whole becomes a new group of the copies ("Logo copy");
     a copy of only some members of a group is a loose shape. */
  function copyGroups(list, groups) {
    var whole = Object.create(null), made = Object.create(null);
    Object.keys(groups).forEach(function (gid) {
      var all = groups[gid].n, had = list.filter(function (o) { return o.group === gid; }).length;
      if (had && had === all) whole[gid] = true;
    });
    return function (src, c) {
      delete c.group;
      if (!src.group || !whole[src.group]) return;
      if (!made[src.group]) {
        made[src.group] = { id: gid(), name: cleanName(groups[src.group].name + ' copy', groups[src.group].name) };
        M.doc.groups.push(made[src.group]);
      }
      c.group = made[src.group].id;
    };
  }
  function groupInfo(list) {
    var out = Object.create(null);
    list.forEach(function (o) {
      var g = o.group && M.group(o.group);
      if (g && !out[g.id]) out[g.id] = { name: g.name, n: M.members(g.id).length };
    });
    return out;
  }
  M.copy = function () {
    var sel = M.selected(); if (!sel.length) return 0;
    M.clipboard = { json: JSON.stringify(sel), groups: groupInfo(sel), n: 0 };
    return sel.length;
  };
  /* Each paste lands 5 mm further down-right, so copies never hide each other. */
  M.paste = function () {
    if (!M.clipboard) return 0;
    var list = JSON.parse(M.clipboard.json), step = ++M.clipboard.n * 5, made = [];
    if (M.doc.objects.length + list.length > MAX_OBJECTS) return 0;
    M.commit('Paste', function () {
      var regroup = copyGroups(list, M.clipboard.groups || {});
      list.forEach(function (src) {
        var c = cloneObj(src); c.name = cleanName(src.name + ' copy', src.name);
        regroup(src, c);
        G.translate(c, step, step);
        M.doc.objects.push(c); made.push(c.id);
      });
      M.selection = made;
    });
    return made.length;
  };
  M.duplicate = function () {
    var sel = M.selected(), made = [];
    if (!sel.length || M.doc.objects.length + sel.length > MAX_OBJECTS) return 0;
    M.commit('Duplicate', function () {
      var regroup = copyGroups(sel, groupInfo(sel));
      sel.forEach(function (src) {
        var c = cloneObj(src); c.name = cleanName(src.name + ' copy', src.name);
        regroup(src, c);
        G.translate(c, 5, 5);
        M.doc.objects.push(c); made.push(c.id);
      });
      M.selection = made;
    });
    return made.length;
  };

  /* ---------- groups ------------------------------------------------------------------
     Like Figma's groups, one level deep. A group is a name and the shapes that carry its id; they
     are always sewn one after the other. Selecting a group selects its shapes, so moving, resizing,
     recolouring and deleting work on all of them. Groups are for the editor only: the engine gets
     the same flat list of shapes as without them. */
  function gid() { return 'g' + uid().slice(1); }
  M.groups = function () { return M.doc.groups || []; };
  M.group = function (id) { var g = M.groups(); for (var i = 0; i < g.length; i++) if (g[i].id === id) return g[i]; return null; };
  M.groupOf = function (objId) { var o = M.get(objId); return o && o.group ? M.group(o.group) : null; };
  /* ids of a group's shapes, in sewing order */
  M.members = function (groupId) { return M.doc.objects.filter(function (o) { return o.group === groupId; }).map(function (o) { return o.id; }); };
  /* What a click on a shape picks: its whole group, or the shape itself when it is loose. */
  M.unitOf = function (objId) { var g = M.groupOf(objId); return g ? M.members(g.id) : (M.get(objId) ? [objId] : []); };
  /* The group whose shapes are exactly the selection, or null. */
  M.selectedGroup = function () {
    var sel = M.selection; if (!sel.length) return null;
    var g = M.groupOf(sel[0]); if (!g) return null;
    var n = 0, inSel = Object.create(null), i;
    for (i = 0; i < sel.length; i++) inSel[sel[i]] = true;
    var objs = M.doc.objects;
    for (i = 0; i < objs.length; i++) if (objs[i].group === g.id) { if (!inSel[objs[i].id]) return null; n++; }
    return n === sel.length ? g : null;
  };
  /* Every selected shape belongs to group g, but not all of g is selected (inside the group, like a
     double-click in Figma). */
  M.insideGroup = function () {
    var sel = M.selection; if (!sel.length) return null;
    var g = M.groupOf(sel[0]); if (!g) return null;
    for (var i = 1; i < sel.length; i++) { var o = M.get(sel[i]); if (!o || o.group !== g.id) return null; }
    return M.members(g.id).length > sel.length ? g : null;
  };
  function nextGroupName() {
    var max = 0;
    M.groups().forEach(function (g) { var m = /^Group (\d+)$/.exec(g.name); if (m) max = Math.max(max, parseInt(m[1], 10)); });
    return 'Group ' + (max + 1);
  }
  /* Keep the group rules after any edit: no member of a missing group, no empty group, and the
     shapes of a group next to each other (gathered at the first one). A list that already follows
     the rules is left exactly as it is, so the sewing order never moves on its own. */
  function normalizeGroups() {
    var groups = M.doc.groups, objs = M.doc.objects, known = Object.create(null), used = Object.create(null), i;
    if (!Array.isArray(groups)) groups = M.doc.groups = [];
    for (i = 0; i < groups.length; i++) known[groups[i].id] = true;
    for (i = 0; i < objs.length; i++) {
      var g = objs[i].group;
      if (g !== undefined && !known[g]) delete objs[i].group;
      else if (g !== undefined) used[g] = true;
    }
    if (groups.some(function (gr) { return !used[gr.id]; })) M.doc.groups = groups.filter(function (gr) { return used[gr.id]; });
    /* contiguous? */
    var seen = Object.create(null), prev = null, split = false;
    for (i = 0; i < objs.length && !split; i++) {
      var k = objs[i].group || null;
      if (k && k !== prev && seen[k]) split = true;
      if (k) seen[k] = true;
      prev = k;
    }
    if (!split) return;
    var out = [], done = Object.create(null);
    objs.forEach(function (o) {
      if (!o.group) { out.push(o); return; }
      if (done[o.group]) return;
      done[o.group] = true;
      objs.forEach(function (m) { if (m.group === o.group) out.push(m); });
    });
    M.doc.objects = out;
  }
  M.normalizeGroups = normalizeGroups;

  /* Group the shapes `ids` (and the rest of any group they come from stays where it was). The group
     is sewn where the last of them was sewn, so shapes that already follow each other keep their
     order exactly. One undo step. Returns the new group or null. */
  M.groupShapes = function (ids, name) {
    var pick = M.doc.objects.filter(function (o) { return (ids || []).indexOf(o.id) !== -1; });
    if (!pick.length) return null;
    var first = pick[0].group;
    if (first && pick.every(function (o) { return o.group === first; }) && M.members(first).length === pick.length) return null;   /* already exactly a group */
    var g = { id: gid(), name: cleanName(name, nextGroupName()) };
    M.commit('Group', function () {
      var a = M.doc.objects, picked = {}, lastIdx = -1, i;
      pick.forEach(function (o) { picked[o.id] = true; });
      for (i = 0; i < a.length; i++) if (picked[a[i].id]) lastIdx = i;
      var rest = [], at = 0;
      for (i = 0; i < a.length; i++) { if (picked[a[i].id]) continue; rest.push(a[i]); if (i < lastIdx) at = rest.length; }
      /* never land inside another group: go after its last shape */
      while (at > 0 && at < rest.length && rest[at].group && rest[at].group === rest[at - 1].group) at++;
      pick.forEach(function (o) { o.group = g.id; });
      M.doc.groups.push(g);
      M.doc.objects = rest.slice(0, at).concat(pick, rest.slice(at));
      M.selection = pick.map(function (o) { return o.id; });
    });
    return M.group(g.id) ? g : null;
  };
  /* Ungroup every group that holds one of `ids`; its shapes stay where they are and become the
     selection. Returns how many groups were taken apart. */
  M.ungroup = function (ids) {
    var gone = Object.create(null), n = 0, freed = [];
    (ids || []).forEach(function (id) { var g = M.groupOf(id); if (g && !gone[g.id]) { gone[g.id] = true; n++; } });
    if (!n) return 0;
    M.commit(n === 1 ? 'Ungroup' : 'Ungroup ' + n + ' groups', function () {
      M.doc.objects.forEach(function (o) { if (o.group && gone[o.group]) { delete o.group; freed.push(o.id); } });
      M.doc.groups = M.doc.groups.filter(function (g) { return !gone[g.id]; });
      M.selection = freed;
    });
    return n;
  };
  M.renameGroup = function (id, name) {
    var g = M.group(id); if (!g) return false;
    var n = cleanName(name, g.name);
    return M.commit('Rename', function () { g.name = n; });
  };
  /* Move the shapes `ids` (kept in their order) so they are sewn just before `beforeId` (null: last).
     groupId: the group they join, null to make them loose, undefined to keep their groups (dragging a
     whole group). A loose shape is never dropped inside a group: it goes after that group. */
  M.place = function (ids, beforeId, groupId, label) {
    var a = M.doc.objects, set = {}, moving = a.filter(function (o) { return ids.indexOf(o.id) !== -1; });
    if (!moving.length || (beforeId && ids.indexOf(beforeId) !== -1)) return false;
    if (groupId && !M.group(groupId)) return false;
    moving.forEach(function (o) { set[o.id] = true; });
    return M.commit(label || 'Reorder', function () {
      var rest = M.doc.objects.filter(function (o) { return !set[o.id]; }), at = rest.length, i;
      if (beforeId) for (i = 0; i < rest.length; i++) if (rest[i].id === beforeId) { at = i; break; }
      if (groupId !== undefined) moving.forEach(function (o) { if (groupId) o.group = groupId; else delete o.group; });
      var joins = groupId !== undefined ? groupId : null;
      while (at > 0 && at < rest.length && rest[at].group && rest[at].group === rest[at - 1].group && rest[at].group !== joins) at++;
      M.doc.objects = rest.slice(0, at).concat(moving, rest.slice(at));
    });
  };

  /* Sewing order. dir +1 = sewn later (drawn on top), -1 = sewn earlier.
     A whole group (or a loose shape) steps past the next group or loose shape as one block; shapes
     picked inside a group step within that group only. */
  function stepList(a, isSel, dir) {
    var i, t;
    if (dir > 0) { for (i = a.length - 2; i >= 0; i--) if (isSel(a[i]) && !isSel(a[i + 1])) { t = a[i]; a[i] = a[i + 1]; a[i + 1] = t; } }
    else { for (i = 1; i < a.length; i++) if (isSel(a[i]) && !isSel(a[i - 1])) { t = a[i]; a[i] = a[i - 1]; a[i - 1] = t; } }
    return a;
  }
  M.reorder = function (ids, dir) {
    return M.commit(dir > 0 ? 'Sew later' : 'Sew earlier', function () {
      var units = [], byGroup = Object.create(null);
      M.doc.objects.forEach(function (o) {
        if (o.group && byGroup[o.group]) { byGroup[o.group].list.push(o); return; }
        var u = { list: [o], group: o.group || null };
        if (o.group) byGroup[o.group] = u;
        units.push(u);
      });
      function picked(o) { return ids.indexOf(o.id) !== -1; }
      units.forEach(function (u) {
        var n = u.list.filter(picked).length;
        u.whole = n > 0 && (!u.group || n === u.list.length);
        if (n && !u.whole) u.list = stepList(u.list, picked, dir);
      });
      stepList(units, function (u) { return u.whole; }, dir);
      M.doc.objects = [].concat.apply([], units.map(function (u) { return u.list; }));
    });
  };
  /* Move one object so that it ends up at `index` in the list (drag in the panel). */
  M.moveTo = function (id, index) {
    var from = M.indexOf(id); if (from === -1) return false;
    return M.commit('Reorder', function () {
      var a = M.doc.objects, o = a.splice(from, 1)[0];
      a.splice(G.clamp(index, 0, a.length), 0, o);
    });
  };

  /* A new hoop keeps the design where it was relative to the hoop centre. */
  M.setHoop = function (w, h) {
    w = Number(w); h = Number(h);
    if (!isFinite(w) || !isFinite(h) || w < 10 || h < 10 || w > 1000 || h > 1000) return false;
    var dx = (w - M.doc.hoop.w) / 2, dy = (h - M.doc.hoop.h) / 2;
    return M.commit('Change hoop', function () {
      M.doc.hoop = { w: w, h: h };
      M.doc.objects.forEach(function (o) { G.translate(o, dx, dy); });
    });
  };
  /* An empty, untitled design on the hoop that was picked last (a new tab, the very first visit). */
  M.blank = function () { return { name: 'untitled', hoop: Editor.Prefs.hoop(), objects: [] }; };
  M.setName = function (name) {
    var n = cleanName(name, 'untitled');
    if (n === M.doc.name) return false;
    M.doc.name = n;
    Editor.emit('change', { reason: 'name' });
    return true;
  };

  /* ---------- engine input ------------------------------------------------------- */
  /* doc: a stored design (another tab's); without it, the design on the hoop. */
  M.toEngine = function (doc) {
    doc = doc && doc.hoop && Array.isArray(doc.objects) ? doc : M.doc;
    return {
      name: doc.name,
      hoop: { width: doc.hoop.w, height: doc.hoop.h },
      objects: doc.objects.map(function (o) {
        var e = {
          id: o.id, color: o.color, paint: M.paintOf(o),
          fill: { spacing: o.spacing, stitchLength: o.stitchLen, angle: o.angle, pattern: o.pattern || 'smooth' },
          line: { type: o.lineType, stitchLength: o.stitchLen, width: o.lineWidth, spacing: o.spacing }
        };
        /* Only line art adds keys: a plain fill gives exactly the engine input it always did. */
        if (o.fillStyle === 'lineart') {
          e.fill.style = 'lineart';
          e.fill.lineart = { detail: isDetail(o.lineDetail) ? o.lineDetail : 'normal' };
        }
        if (o.underlay === false) e.fill.underlay = false;   /* photo fills from Turn into stitches */
        switch (o.type) {
          case 'rect': e.type = 'rect'; e.x = o.x; e.y = o.y; e.width = o.w; e.height = o.h; break;
          case 'ellipse': e.type = 'ellipse'; e.cx = o.cx; e.cy = o.cy; e.rx = o.rx; e.ry = o.ry; break;
          case 'line': e.type = 'line'; e.x1 = o.x1; e.y1 = o.y1; e.x2 = o.x2; e.y2 = o.y2; break;
          case 'polygon': e.type = 'polygon'; e.points = o.pts; break;
          case 'path': e.type = 'path'; e.rings = o.rings; e.fillRule = o.fillRule === 'evenodd' ? 'evenodd' : 'nonzero'; break;
          default: e.type = 'polyline'; e.points = o.pts; e.closed = !!o.closed;
        }
        return e;
      })
    };
  };

  /* ---------- save / load ---------------------------------------------------------- */
  M.serialize = function () {
    var out = { name: M.doc.name, hoop: { w: M.doc.hoop.w, h: M.doc.hoop.h }, objects: M.doc.objects, defaults: M.defaults };
    /* only a design with groups has the key, so a design without them is stored exactly as before */
    if (M.groups().length) out.groups = M.groups().map(function (g) { return { id: g.id, name: g.name }; });
    return out;
  };
  function num(v) { var n = Number(v); return typeof v === 'number' && isFinite(n) && Math.abs(n) <= L.coord ? G.r2(n) : null; }
  function pos0(v) { var n = num(v); return n !== null && n > 0 ? n : null; }
  function styleInto(o, r, base) {
    o.color = G.hex(r.color) || base.color;
    o.paint = PAINTS[r.paint] ? r.paint : base.paint;
    o.lineType = LINE_TYPES[r.lineType] ? r.lineType : base.lineType;
    o.pattern = isPattern(r.pattern) ? r.pattern : (isPattern(base.pattern) ? base.pattern : 'smooth');
    /* designs saved before stitch styles existed have neither key: plain fill, normal detail */
    o.fillStyle = isFillStyle(r.fillStyle) ? r.fillStyle : (isFillStyle(base.fillStyle) ? base.fillStyle : 'tatami');
    o.lineDetail = isDetail(r.lineDetail) ? r.lineDetail : (isDetail(base.lineDetail) ? base.lineDetail : 'normal');
    if (r.underlay === false) o.underlay = false;
    ['lineWidth', 'spacing', 'stitchLen', 'angle'].forEach(function (k) {
      var v = typeof r[k] === 'number' ? validProp(k, r[k]) : null;
      o[k] = v === null ? base[k] : v;
    });
  }
  /* Rebuild one stored object from untrusted data, or return null. */
  function cleanObject(r, base, seen, groups) {
    if (!r || typeof r !== 'object' || !TYPE_NAMES[r.type]) return null;
    var o = { id: typeof r.id === 'string' && /^[\w-]{1,40}$/.test(r.id) && !seen[r.id] ? r.id : uid(), name: cleanName(r.name, TYPE_NAMES[r.type]), type: r.type };
    var a, b, c, d, pts, i, p, x, y;
    switch (r.type) {
      case 'rect':
        a = num(r.x); b = num(r.y); c = pos0(r.w); d = pos0(r.h);
        if (a === null || b === null || c === null || d === null) return null;
        o.x = a; o.y = b; o.w = c; o.h = d; break;
      case 'ellipse':
        a = num(r.cx); b = num(r.cy); c = pos0(r.rx); d = pos0(r.ry);
        if (a === null || b === null || c === null || d === null) return null;
        o.cx = a; o.cy = b; o.rx = c; o.ry = d; break;
      case 'line':
        a = num(r.x1); b = num(r.y1); c = num(r.x2); d = num(r.y2);
        if (a === null || b === null || c === null || d === null) return null;
        o.x1 = a; o.y1 = b; o.x2 = c; o.y2 = d; break;
      case 'path':
        if (!Array.isArray(r.rings) || r.rings.length > 2000) return null;
        var rings = [], total = 0;
        for (i = 0; i < r.rings.length; i++) {
          if (!Array.isArray(r.rings[i])) continue;
          pts = [];
          for (a = 0; a < r.rings[i].length; a++) {
            p = r.rings[i][a]; if (!Array.isArray(p)) continue;
            x = num(p[0]); y = num(p[1]);
            if (x !== null && y !== null) pts.push([x, y]);
          }
          total += pts.length;
          if (pts.length >= 3) rings.push(pts);
        }
        if (!rings.length || total > MAX_POINTS) return null;
        o.rings = rings; o.fillRule = r.fillRule === 'evenodd' ? 'evenodd' : 'nonzero';
        break;
      default:
        if (!Array.isArray(r.pts) || r.pts.length > MAX_POINTS) return null;
        pts = [];
        for (i = 0; i < r.pts.length; i++) {
          p = r.pts[i]; if (!Array.isArray(p)) continue;
          x = num(p[0]); y = num(p[1]);
          if (x !== null && y !== null) pts.push([x, y]);
        }
        if (pts.length < (r.type === 'polygon' ? 3 : 2)) return null;
        o.pts = pts; if (r.type === 'pen') o.closed = r.closed === true;
    }
    styleInto(o, r, base);
    if (!G.isClosed(o)) o.paint = 'line';
    if (typeof r.group === 'string' && groups && groups[r.group]) o.group = r.group;
    seen[o.id] = true;
    return o;
  }
  /* Replace the document with stored data. Never throws; anything that does not
     make sense is dropped. Returns the number of objects dropped. Clears history. */
  M.load = function (data) {
    var dropped = 0, objects = [], seen = {}, groups = [], known = Object.create(null);
    var base = { color: '#3157e0', paint: 'fill', lineType: 'running', lineWidth: D.line.width || 3, spacing: D.fill.spacing, stitchLen: D.fill.stitchLength, angle: 0 };
    var hoop = { w: 100, h: 100 }, name = 'untitled', defaults = {};
    try {
      if (data && typeof data === 'object') {
        name = cleanName(data.name, 'untitled');
        if (data.hoop && typeof data.hoop === 'object') {
          var w = Number(data.hoop.w), h = Number(data.hoop.h);
          if (isFinite(w) && isFinite(h) && w >= 10 && h >= 10 && w <= 1000 && h <= 1000) hoop = { w: w, h: h };
        }
        styleInto(defaults, data.defaults && typeof data.defaults === 'object' ? data.defaults : {}, base);
        /* groups came with file version 2; a file without them simply has none */
        if (Array.isArray(data.groups)) {
          data.groups.slice(0, MAX_OBJECTS).forEach(function (g) {
            if (!g || typeof g !== 'object' || typeof g.id !== 'string' || !/^[\w-]{1,40}$/.test(g.id) || (g.id in {}) || known[g.id]) return;   /* not '__proto__', 'constructor', ... */
            known[g.id] = true;
            groups.push({ id: g.id, name: cleanName(g.name, 'Group') });
          });
        }
        if (Array.isArray(data.objects)) {
          data.objects.slice(0, MAX_OBJECTS).forEach(function (r) {
            var o = null;
            try { o = cleanObject(r, base, seen, known); } catch (e) { o = null; }
            if (o) objects.push(o); else dropped++;
          });
          dropped += Math.max(0, data.objects.length - MAX_OBJECTS);
        }
      }
    } catch (e) { objects = []; groups = []; }
    if (!defaults.color) styleInto(defaults, {}, base);
    M.doc = { name: name, hoop: hoop, objects: objects, groups: groups };
    normalizeGroups();                                      /* drops empty groups, gathers scattered members */
    M.defaults = defaults;
    M.selection = []; hist = []; pos = 0; txn = null; snap = takeSnap();
    Editor.emit('defaults');
    changed('load');
    return dropped;
  };
})();
