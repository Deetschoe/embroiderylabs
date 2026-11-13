/* ==========================================================================
   EMBROIDERY LABS - js/techpack.js (techpack.html only)
   Tech pack builder. Everything stays in the visitor's browser: the draft is
   autosaved to localStorage and can be exported / imported as a .json file.
   All user text reaches the page through textContent / .value, never innerHTML.
   ========================================================================== */
(function () {
  'use strict';

  var EL = window.EL;
  var doc = document;
  if (!EL || !doc.getElementById('tp-form')) return;

  var KEY = 'techpack_draft';              /* same key the old page used; old drafts are migrated on load */
  var APP = 'embroiderylabs-techpack';
  var SCHEMA = 2;
  var CM_PER_IN = 2.54;
  var SIZES = ['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL', 'OS'];
  var DEFAULT_SIZES = ['S', 'M', 'L', 'XL', '2XL'];
  var MAX_ROWS = 60;
  var IMG_TARGET = 900000;                 /* characters of data URL per image after scaling */
  var IMG_HARD = 6000000;                  /* never accept more than this from a file */
  var SVG_NS = 'http://www.w3.org/2000/svg';

  /* ---------- option lists: [stored value, label]. Stored values match the old page. ---- */
  function pairs(list) { return list.map(function (v) { return Array.isArray(v) ? v : [v, v]; }); }
  var OPTS = {
    category: pairs([['T-Shirt', 'T-shirt'], 'Hoodie', 'Crewneck', 'Sweatpants', 'Shorts', ['Tank Top', 'Tank top'], ['Long Sleeve', 'Long sleeve'], 'Jacket', 'Hat', ['Tote Bag', 'Tote bag']]),
    fit: pairs(['Regular', 'Slim', 'Oversized', 'Boxy', 'Relaxed', 'Cropped']),
    stitch: pairs([['Single Needle', 'Single needle'], ['Double Needle', 'Double needle'], 'Overlock', 'Flatlock', ['Chain Stitch', 'Chain stitch'], ['Cover Stitch', 'Cover stitch']]),
    hem: pairs(['Single fold', 'Double fold', 'Raw edge', 'Ribbed', 'Banded']),
    neck: pairs(['Ribbed crew', 'V-neck rib', 'Bound neck', 'Raw edge', 'Self-fabric binding']),
    label: pairs(['Woven', 'Printed', 'Heat transfer', 'Tear-away', 'None']),
    packaging: pairs(['Poly bag', 'Tissue wrap', 'Box', 'Hang tag', 'None']),
    location: pairs([['Front Center', 'Front centre'], ['Left Chest', 'Left chest'], ['Right Chest', 'Right chest'], ['Full Back', 'Full back'], ['Upper Back', 'Upper back'], ['Left Sleeve', 'Left sleeve'], ['Right Sleeve', 'Right sleeve'], 'Hem', 'Neck', 'Custom']),
    decoration: pairs([['Screen Print', 'Screen print'], 'DTG', 'Embroidery', 'Sublimation', ['Heat Transfer', 'Heat transfer'], ['Puff Print', 'Puff print'], ['Discharge Print', 'Discharge print']]),
    status: pairs(['Sample', 'Approved', 'Production']),
    care: pairs([['Machine Wash Cold', 'Machine wash cold'], ['Tumble Dry Low', 'Tumble dry low'], ['Do Not Bleach', 'Do not bleach'], ['Iron Low', 'Iron low'], ['Do Not Iron Decoration', 'Do not iron decoration'], ['Dry Clean', 'Dry clean'], ['Wash Inside Out', 'Wash inside out'], ['Hang Dry', 'Hang dry']])
  };
  function optLabel(group, value) {
    var list = OPTS[group];
    for (var i = 0; i < list.length; i++) if (list[i][0] === value) return list[i][1];
    return '';
  }
  function optHas(group, value) { return optLabel(group, value) !== ''; }

  /* ---------- simple fields: key = element id = key in the old draft ---------- */
  var FIELDS = {
    brandName: { max: 120 }, productName: { max: 160 }, styleNumber: { max: 60 }, season: { max: 40 },
    productCategory: { opts: 'category' }, packDate: { date: true }, designer: { max: 120 }, version: { max: 40 },
    fitType: { opts: 'fit' }, baseBlank: { max: 160 }, fabricComp: { max: 200 }, gsmWeight: { max: 12 },
    fabricColorPicker: { color: true }, fabricColorName: { max: 80 },
    stitchType: { opts: 'stitch' }, seamAllowance: { max: 60 }, hemStyle: { opts: 'hem' }, neckFinish: { opts: 'neck' },
    constructionNotes: { max: 4000 }, labelType: { opts: 'label' }, labelPlacement: { max: 200 }, countryOrigin: { max: 120 },
    packagingType: { opts: 'packaging' }, hangTagToggle: { bool: true }, hangTagDesc: { max: 400 }, packagingNotes: { max: 4000 },
    retailPrice: { max: 16 }, costUnit: { max: 16 }, moq: { max: 16 }, generalNotes: { max: 8000 }, noArtwork: { bool: true }
  };

  /* ---------- templates. Inches. Editable starting points, not factory standards. ---------- */
  function tm(name, vals, tol) {
    var values = {};
    DEFAULT_SIZES.forEach(function (s, i) { values[s] = { v: String(vals[i]), u: 'in' }; });
    return { name: name, values: values, tol: { v: String(tol), u: 'in' } };
  }
  var TEMPLATES = {
    'basic-tee': {
      label: 'basic tee',
      f: { productCategory: 'T-Shirt', baseBlank: 'Bella+Canvas 3001', fabricComp: '100% Airlume Cotton 4.2oz', gsmWeight: '142', fitType: 'Regular', stitchType: 'Double Needle', seamAllowance: '1/2 inch', hemStyle: 'Double fold', neckFinish: 'Ribbed crew', labelType: 'Tear-away', labelPlacement: 'Center back, 1 inch below neck seam', packagingType: 'Poly bag' },
      m: [tm('Body length', [28, 29, 30, 31, 32], 0.5), tm('Chest width', [18, 20, 22, 24, 26], 0.5), tm('Sleeve length', [8, 8.25, 8.5, 8.75, 9], 0.25), tm('Shoulder width', [16, 17.5, 19, 20.5, 22], 0.5)],
      care: ['Machine Wash Cold', 'Tumble Dry Low', 'Do Not Bleach', 'Do Not Iron Decoration']
    },
    'hoodie': {
      label: 'hoodie',
      f: { productCategory: 'Hoodie', baseBlank: 'Independent Trading IND4000', fabricComp: '80% Cotton / 20% Polyester Fleece 10oz', gsmWeight: '340', fitType: 'Regular', stitchType: 'Cover Stitch', seamAllowance: '5/8 inch', hemStyle: 'Ribbed', neckFinish: 'Self-fabric binding', labelType: 'Woven', labelPlacement: 'Center back neck, inside hood seam', packagingType: 'Poly bag' },
      m: [tm('Body length', [27, 28, 29, 30, 31], 0.5), tm('Chest width', [21, 23, 25, 27, 29], 0.5), tm('Sleeve length', [34, 35, 36, 37, 38], 0.5), tm('Shoulder width', [18, 19.5, 21, 22.5, 24], 0.5), tm('Hem width', [19, 21, 23, 25, 27], 0.5)],
      care: ['Machine Wash Cold', 'Tumble Dry Low', 'Do Not Bleach', 'Wash Inside Out', 'Do Not Iron Decoration']
    },
    'crewneck': {
      label: 'crewneck',
      f: { productCategory: 'Crewneck', baseBlank: 'Champion S600', fabricComp: '82% Cotton / 18% Polyester Fleece 9oz', gsmWeight: '305', fitType: 'Regular', stitchType: 'Cover Stitch', seamAllowance: '5/8 inch', hemStyle: 'Ribbed', neckFinish: 'Ribbed crew', labelType: 'Woven', labelPlacement: 'Center back, 1 inch below neck rib', packagingType: 'Poly bag' },
      m: [tm('Body length', [27, 28, 29, 30, 31], 0.5), tm('Chest width', [21, 23, 25, 27, 29], 0.5), tm('Sleeve length', [33, 34, 35, 36, 37], 0.5), tm('Shoulder width', [18, 19.5, 21, 22.5, 24], 0.5)],
      care: ['Machine Wash Cold', 'Tumble Dry Low', 'Do Not Bleach', 'Wash Inside Out']
    },
    'shorts': {
      label: 'shorts',
      f: { productCategory: 'Shorts', baseBlank: 'Cut & Sew Custom', fabricComp: '100% Nylon Ripstop 3.5oz', gsmWeight: '120', fitType: 'Regular', stitchType: 'Double Needle', seamAllowance: '1/2 inch', hemStyle: 'Double fold', neckFinish: '', labelType: 'Woven', labelPlacement: 'Center back waistband, interior', packagingType: 'Poly bag' },
      m: [tm('Waist width', [14, 15, 16, 17, 18], 0.5), tm('Outseam length', [16, 17, 18, 19, 20], 0.5), tm('Inseam length', [5, 5.5, 6, 6.5, 7], 0.25), tm('Hem width', [12, 13, 14, 15, 16], 0.5)],
      care: ['Machine Wash Cold', 'Tumble Dry Low', 'Do Not Bleach']
    }
  };

  /* ---------- flat sketches. viewBox 0 0 200 180. Paths are constants, never user data. ---- */
  var TEE = 'M70 14 30 30 8 66l24 14 12-18v104h112V62l12 18 24-14-22-36-40-16';
  var LONG = 'M70 14 34 28 10 148l20 6 14-90v102h112V64l14 90 20-6L166 28 130 14';
  var TANK = 'M74 14H60c0 30-8 44-16 50v102h112V64c-8-6-16-20-16-50h-14';
  var Z_BODY_F = { 'Neck': [82, 14, 36, 26], 'Right Chest': [52, 44, 30, 28], 'Left Chest': [118, 44, 30, 28], 'Front Center': [62, 76, 76, 58], 'Hem': [52, 140, 96, 22] };
  var Z_BODY_B = { 'Upper Back': [62, 26, 76, 26], 'Full Back': [56, 58, 88, 92] };
  function withSleeves(left, right) {
    var z = {}; Object.keys(Z_BODY_F).forEach(function (k) { z[k] = Z_BODY_F[k]; });
    z['Right Sleeve'] = left; z['Left Sleeve'] = right;      /* the wearer's right sleeve is on the viewer's left */
    return z;
  }
  var SHAPES = {
    tee: { front: [TEE + 'c-8 20-52 20-60 0z', 'M70 14c6 9 54 9 60 0'], back: [TEE + 'c-6 9-54 9-60 0z'], zf: withSleeves([8, 42, 32, 28], [160, 42, 32, 28]), zb: Z_BODY_B },
    long: { front: [LONG + 'c-8 20-52 20-60 0z', 'M70 14c6 9 54 9 60 0'], back: [LONG + 'c-6 9-54 9-60 0z'], zf: withSleeves([14, 72, 28, 36], [158, 72, 28, 36]), zb: Z_BODY_B },
    hoodie: { front: [LONG + 'c-8 20-52 20-60 0z', 'M70 14C62 0 138 0 130 14', 'M72 122h56l8 30H64z'], back: [LONG + 'c-6 9-54 9-60 0z', 'M70 14C62 0 138 0 130 14'], zf: withSleeves([14, 72, 28, 36], [158, 72, 28, 36]), zb: Z_BODY_B },
    jacket: { front: [LONG + 'c-8 20-52 20-60 0z', 'M70 14c6 9 54 9 60 0', 'M100 29v137'], back: [LONG + 'c-6 9-54 9-60 0z'], zf: withSleeves([14, 72, 28, 36], [158, 72, 28, 36]), zb: Z_BODY_B },
    tank: { front: [TANK + 'c-6 22-46 22-52 0z'], back: [TANK + 'c-6 10-46 10-52 0z'], zf: Z_BODY_F, zb: Z_BODY_B },
    shorts: { front: ['M40 36h120l10 96h-62l-8-40-8 40H30z', 'M39 48h122'], back: ['M40 36h120l10 96h-62l-8-40-8 40H30z', 'M39 48h122'], zf: { 'Front Center': [62, 52, 76, 34], 'Hem': [34, 106, 56, 22] }, zb: { 'Full Back': [62, 52, 76, 34] } },
    pants: { front: ['M48 12h104l8 156h-44L100 60 84 168H40z', 'M47 24h106'], back: ['M48 12h104l8 156h-44L100 60 84 168H40z', 'M47 24h106'], zf: { 'Front Center': [60, 28, 80, 26], 'Hem': [42, 140, 40, 24] }, zb: { 'Full Back': [60, 28, 80, 26] } },
    hat: { front: ['M40 110c0-80 120-80 120 0z', 'M40 110c-20 6-26 24-20 30 40-14 120-14 160 0 6-6 0-24-20-30'], back: ['M40 110c0-80 120-80 120 0z', 'M82 110c0-24 36-24 36 0'], zf: { 'Front Center': [70, 62, 60, 40] }, zb: { 'Full Back': [70, 56, 60, 30] } },
    tote: { front: ['M40 62h120v104H40z', 'M72 62V32c0-22 56-22 56 0v30'], back: ['M40 62h120v104H40z', 'M72 62V32c0-22 56-22 56 0v30'], zf: { 'Front Center': [58, 82, 84, 68] }, zb: { 'Full Back': [58, 82, 84, 68] } }
  };
  var SHAPE_FOR = { 'T-Shirt': 'tee', 'Hoodie': 'hoodie', 'Crewneck': 'long', 'Sweatpants': 'pants', 'Shorts': 'shorts', 'Tank Top': 'tank', 'Long Sleeve': 'long', 'Jacket': 'jacket', 'Hat': 'hat', 'Tote Bag': 'tote' };
  var ZONE_CODE = { 'Front Center': 'FC', 'Left Chest': 'LC', 'Right Chest': 'RC', 'Full Back': 'FB', 'Upper Back': 'UB', 'Left Sleeve': 'LS', 'Right Sleeve': 'RS', 'Hem': 'HEM', 'Neck': 'NK' };
  function shape() { return SHAPES[SHAPE_FOR[state.f.productCategory] || 'tee']; }

  /* ---------- small helpers ---------------------------------------------------- */
  function $(id) { return doc.getElementById(id); }
  function qsa(sel, root) { return Array.prototype.slice.call((root || doc).querySelectorAll(sel)); }
  /* h('label', { class: 'field', 'aria-label': 'x' }, [child, 'text']) - text is always a text node */
  function h(tag, attrs, kids) {
    var el = doc.createElement(tag), k;
    if (attrs) for (k in attrs) {
      if (attrs[k] == null || attrs[k] === false) continue;
      if (k === 'text') el.textContent = attrs[k];
      else if (k === 'value') el.value = attrs[k];
      else el.setAttribute(k, attrs[k] === true ? '' : attrs[k]);
    }
    add(el, kids);
    return el;
  }
  function add(el, kids) {
    if (kids == null) return el;
    if (!Array.isArray(kids)) kids = [kids];
    kids.forEach(function (c) { if (c != null && c !== false) el.appendChild(typeof c === 'string' ? doc.createTextNode(c) : c); });
    return el;
  }
  function svg(tag, attrs, kids) {
    var el = doc.createElementNS(SVG_NS, tag), k;
    if (attrs) for (k in attrs) if (attrs[k] != null) el.setAttribute(k, attrs[k]);
    if (kids) kids.forEach(function (c) { el.appendChild(c); });
    return el;
  }
  function icon(d) { return svg('svg', { viewBox: '0 0 16 16', 'aria-hidden': 'true' }, [svg('path', { d: d })]); }
  var ICON_X = 'M4 4l8 8M12 4l-8 8';
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }
  function trim(v) { return String(v == null ? '' : v).trim(); }
  function pad2(n) { return n < 10 ? '0' + n : String(n); }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  /* Local date, never toISOString(): at 23:30 in Los Angeles "today" is still today. */
  function todayLocal() { var d = new Date(); return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function showDate(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
    if (!m || +m[2] < 1 || +m[2] > 12) return '';
    return (+m[3]) + ' ' + MONTHS[+m[2] - 1] + ' ' + m[1];
  }
  function seasonList() {
    var d = new Date(), y = d.getFullYear() % 100, out = [];
    if (d.getMonth() < 6) out.push('SS' + pad2(y));
    out.push('FW' + pad2(y));
    for (var i = 1; i <= 2; i++) { out.push('SS' + pad2((y + i) % 100)); out.push('FW' + pad2((y + i) % 100)); }
    return out;
  }

  /* ---------- numbers and units --------------------------------------------------
     A quantity is { v: 'text as typed', u: 'in' | 'cm' }. It is stored exactly as it
     was entered and only converted for display, so switching units back and forth
     can never change a value. */
  function parseNum(text) {
    var s = trim(text).replace(',', '.'), m;
    if (!s) return null;
    if (/^\d*\.?\d+$/.test(s) || /^\d+\.$/.test(s)) return parseFloat(s);
    if ((m = /^(\d+)[\s-]+(\d+)\/(\d+)$/.exec(s)) && +m[3]) return +m[1] + (+m[2] / +m[3]);
    if ((m = /^(\d+)\/(\d+)$/.exec(s)) && +m[2]) return +m[1] / +m[2];
    return NaN;
  }
  /* Round half up on the decimal value: 22.5 in is 57.15 cm, which binary floats hold as 57.1499... */
  function tidy(n, digits) {
    var p = Math.pow(10, digits);
    return String((n < 0 ? -1 : 1) * Math.round(Math.abs(n) * p + 1e-9) / p);
  }
  function qNum(q, unit) {            /* numeric value in `unit`, full precision; null = empty, NaN = not a number */
    if (!q) return null;
    var n = parseNum(q.v);
    if (n == null || isNaN(n) || q.u === unit) return n;
    return q.u === 'in' ? n * CM_PER_IN : n / CM_PER_IN;
  }
  function qShow(q, unit) {           /* text for an input or the sheet */
    if (!q || trim(q.v) === '') return '';
    if (q.u === unit) return q.v;
    var n = qNum(q, unit);
    if (n == null) return '';
    if (isNaN(n)) return q.v;
    return tidy(n, unit === 'cm' ? 1 : 2);
  }
  function qBad(q) { var n = q ? parseNum(q.v) : null; return n != null && isNaN(n); }
  function qSet(q, text, unit, orig) { /* keep the original entry if the box still shows its converted value */
    if (orig && text === qShow(orig, unit)) { q.v = orig.v; q.u = orig.u; }
    else { q.v = text; q.u = unit; }
  }
  function emptyQ() { return { v: '', u: state ? state.unit : 'in' }; }
  /* Quantities and prices: "1,000" is a thousand, "12,50" is twelve and a half. null = empty, NaN = not a number. */
  function parseAmount(text, whole) {
    var s = trim(text).replace(/^\$\s*/, ''), n;
    if (!s) return null;
    if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) n = parseFloat(s.replace(/,/g, ''));
    else if (whole && /^\d{1,3}([. ]\d{3})+$/.test(s)) n = parseFloat(s.replace(/[. ]/g, ''));
    else n = /^\d*[.,]?\d+$/.test(s) || /^\d+[.,]$/.test(s) ? parseFloat(s.replace(',', '.')) : NaN;
    return whole && n % 1 !== 0 ? NaN : n;
  }
  var AMOUNTS = { gsmWeight: 'the fabric weight', moq: 'the order quantity', costUnit: 'the target cost', retailPrice: 'the retail price' };
  function amount(k) { return parseAmount(state.f[k], k === 'moq'); }
  function amountBad(k) { var n = amount(k); return n != null && isNaN(n); }

  /* ---------- state ------------------------------------------------------------- */
  var uid = 1;
  function nid() { return uid++; }
  function blank() {
    var f = {};
    Object.keys(FIELDS).forEach(function (k) { f[k] = FIELDS[k].bool ? false : ''; });
    f.version = 'v1.0';
    f.packDate = todayLocal();
    return { unit: 'in', f: f, activeSizes: DEFAULT_SIZES.slice(), gradeBase: 'M', measurements: [], placements: [], colorways: [], careLabels: [], images: {} };
  }
  var state = null;
  state = blank();

  function isBlank(s) {
    var b = blank(), k;
    for (k in s.f) if (k !== 'packDate' && k !== 'version' && s.f[k] !== b.f[k]) return false;
    return !s.measurements.length && !s.placements.length && !s.colorways.length && !s.careLabels.length && !Object.keys(s.images).length;
  }
  function activeSizes() { return SIZES.filter(function (s) { return state.activeSizes.indexOf(s) !== -1; }); }

  /* ---------- validation: turns any parsed JSON into a safe state or throws ------- */
  function str(v, max) {
    if (typeof v === 'number' && isFinite(v)) v = String(v);
    if (typeof v !== 'string') return '';
    return v.length > max ? v.slice(0, max) : v;
  }
  function qty(v) {
    if (v && typeof v === 'object') return { v: trim(str(v.v, 24)), u: v.u === 'cm' ? 'cm' : 'in' };
    return { v: trim(str(v, 24)), u: 'in' };            /* old drafts stored plain inch strings */
  }
  function arr(v) { return Array.isArray(v) ? v.slice(0, MAX_ROWS) : []; }
  var IMG_RE = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+\/=]+$/;
  function image(v) {
    var src = typeof v === 'string' ? v : (v && typeof v === 'object' ? v.src : null);
    if (typeof src !== 'string' || src.length > IMG_HARD || !IMG_RE.test(src)) return null;
    return { src: src, name: v && typeof v === 'object' ? str(v.name, 120) : '' };
  }
  function normalise(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('That file is not a tech pack.');
    var legacy = !('schema' in raw);
    if (legacy) {
      var known = ['brandName', 'productName', 'styleNumber', 'measurements', 'placements', 'colorways', 'activeSizes'];
      if (!known.some(function (k) { return k in raw; })) throw new Error('That file is not a tech pack.');
    } else {
      if (raw.app !== APP) throw new Error('That file is not a tech pack.');
      if (typeof raw.schema !== 'number' || raw.schema > SCHEMA) throw new Error('That file was made by a newer version of this page.');
    }
    var src = legacy ? raw : (raw.fields && typeof raw.fields === 'object' ? raw.fields : {});
    var s = blank();
    Object.keys(FIELDS).forEach(function (k) {
      var spec = FIELDS[k], v = src[k];
      if (spec.bool) s.f[k] = v === true;
      else if (spec.opts) s.f[k] = typeof v === 'string' && optHas(spec.opts, v) ? v : '';
      else if (spec.date) s.f[k] = typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : '';
      else if (spec.color) s.f[k] = typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) ? v.toLowerCase() : '';
      else s.f[k] = str(v, spec.max);
    });
    if (legacy && s.f.season === 'Custom') s.f.season = '';
    if (legacy && s.f.fabricColorPicker === '#ffffff' && !s.f.fabricColorName) s.f.fabricColorPicker = '';
    s.unit = raw.unit === 'cm' ? 'cm' : 'in';
    s.activeSizes = SIZES.filter(function (z) { return Array.isArray(raw.activeSizes) && raw.activeSizes.indexOf(z) !== -1; });
    s.gradeBase = SIZES.indexOf(raw.gradeBase) !== -1 ? raw.gradeBase : 'M';
    s.measurements = arr(raw.measurements).filter(function (m) { return m && typeof m === 'object'; }).map(function (m) {
      var values = {}, vsrc = m.values && typeof m.values === 'object' ? m.values : {};
      SIZES.forEach(function (z) { if (z in vsrc) { var q = qty(vsrc[z]); if (q.v !== '') values[z] = q; } });
      return { id: nid(), name: str(m.name, 80), values: values, tol: qty('tol' in m ? m.tol : m.tolerance), grade: qty(m.grade) };
    });
    s.placements = arr(raw.placements).filter(function (p) { return p && typeof p === 'object'; }).map(function (p) {
      return {
        id: nid(),
        location: optHas('location', p.location) ? p.location : 'Custom',
        decorationType: optHas('decoration', p.decorationType) ? p.decorationType : '',
        width: qty(p.width), height: qty(p.height), posFromTop: qty(p.posFromTop), posFromCenter: qty(p.posFromCenter),
        numColors: trim(str(p.numColors, 6)), colorList: str(p.colorList, 300), instructions: str(p.instructions, 4000)
      };
    });
    s.colorways = arr(raw.colorways).filter(function (c) { return c && typeof c === 'object'; }).map(function (c) {
      return {
        id: nid(), name: str(c.name, 80),
        color: typeof c.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(c.color) ? c.color.toLowerCase() : '#000000',
        threadColors: str(c.threadColors, 300),
        status: optHas('status', c.status) ? c.status : 'Sample'
      };
    });
    s.careLabels = OPTS.care.map(function (c) { return c[0]; }).filter(function (c) { return Array.isArray(raw.careLabels) && raw.careLabels.indexOf(c) !== -1; });
    var imgs = legacy ? raw.uploadedImages : raw.images;
    if (imgs && typeof imgs === 'object') {
      [['front', 'frontImage'], ['back', 'backImage'], ['detail', 'detailImage']].forEach(function (pair) {
        var im = image(imgs[pair[0]] || imgs[pair[1]]);
        if (im) s.images[pair[0]] = im;
      });
    }
    return s;
  }
  function serialise(withImages) {
    return {
      app: APP, schema: SCHEMA, savedAt: new Date().toISOString(), unit: state.unit,
      fields: clone(state.f), activeSizes: activeSizes(), gradeBase: state.gradeBase,
      measurements: state.measurements.map(function (m) { return { name: m.name, values: clone(m.values), tol: clone(m.tol), grade: clone(m.grade) }; }),
      placements: state.placements.map(function (p) { var c = clone(p); delete c.id; return c; }),
      colorways: state.colorways.map(function (c) { var o = clone(c); delete o.id; return o; }),
      careLabels: state.careLabels.slice(),
      images: withImages ? clone(state.images) : {}
    };
  }

  /* ---------- autosave ------------------------------------------------------------ */
  var saveTimer = null, saveWarned = '';
  var saveEl = $('tp-save');
  function saveStatus(text, kind) {
    if (saveEl.textContent !== text) saveEl.textContent = text;
    if (kind) saveEl.setAttribute('data-state', kind); else saveEl.removeAttribute('data-state');
  }
  function saveNow() {
    clearTimeout(saveTimer); saveTimer = null;
    if (isBlank(state)) { EL.store.remove(KEY); saveStatus('Saves as you type'); return; }
    if (EL.store.set(KEY, serialise(true))) { saveStatus('Saved on this device'); saveWarned = ''; return; }
    if (Object.keys(state.images).length && EL.store.set(KEY, serialise(false))) {
      saveStatus('Saved without images: storage is full', 'warn');
      if (saveWarned !== 'img') { saveWarned = 'img'; EL.toast('The images are too large for this browser to keep. Everything else is saved. Export a file to keep the images.', { kind: 'bad', label: 'Storage' }); }
      return;
    }
    saveStatus('Not saved: export a file', 'bad');
    if (saveWarned !== 'all') { saveWarned = 'all'; EL.toast('This browser could not save the tech pack. Export a file to keep your work.', { kind: 'bad', label: 'Storage' }); }
  }
  function scheduleSave() { clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 400); }
  window.addEventListener('pagehide', function () { if (saveTimer) saveNow(); });
  doc.addEventListener('visibilitychange', function () { if (doc.visibilityState === 'hidden' && saveTimer) saveNow(); });

  /* ---------- change pipeline ------------------------------------------------------ */
  var form = $('tp-form');
  var sheetQueued = false;
  function changed() {
    scheduleSave();
    if (sheetQueued) return;
    sheetQueued = true;
    requestAnimationFrame(flush);
  }
  function flush() {
    if (!sheetQueued) return;
    sheetQueued = false;
    renderSheet();
    renderReadiness();
  }
  /* Re-render part of the form without losing the caret: controls carry a stable data-k. */
  function keepFocus(fn) {
    var a = doc.activeElement, k = a && a.getAttribute ? a.getAttribute('data-k') : null;
    fn();
    if (k) { var el = byKey(k); if (el) el.focus(); }
  }
  function byKey(k) { return form.querySelector('[data-k="' + k.replace(/["\\]/g, '\\$&') + '"]'); }
  function focusKey(k) {
    var el = byKey(k);
    if (!el) return;
    el.focus({ preventScroll: true });
    var card = el.closest('.tp-pl, .tp-cw, tr') || el;
    if (card.scrollIntoView) card.scrollIntoView({ block: 'nearest' });
  }

  /* ---------- form: static fields ---------------------------------------------------- */
  function buildStatic() {
    qsa('select[data-opts]', form).forEach(function (sel) {
      add(sel, h('option', { value: '', text: 'Choose' }));
      OPTS[sel.getAttribute('data-opts')].forEach(function (o) { add(sel, h('option', { value: o[0], text: o[1] })); });
    });
    qsa('[data-f]', form).forEach(function (el) {
      var spec = FIELDS[el.getAttribute('data-f')];
      if (spec && spec.max && !el.hasAttribute('maxlength')) el.setAttribute('maxlength', spec.max);
    });
    seasonList().forEach(function (s) { add($('seasonSuggestions'), h('option', { value: s })); });
    SIZES.forEach(function (s) {
      add($('tp-sizes'), h('label', { class: 'check-row' }, [h('input', { class: 'check', type: 'checkbox', 'data-size': s }), h('span', { class: 'num', text: s === 'OS' ? 'One size' : s })]));
    });
    OPTS.care.forEach(function (c) {
      add($('tp-care'), h('label', { class: 'check-row' }, [h('input', { class: 'check', type: 'checkbox', 'data-care': c[0] }), h('span', { text: c[1] })]));
    });
    OPTS.location.forEach(function (o) { add($('tp-placement-loc'), h('option', { value: o[0], text: o[1] })); });
    SLOTS.forEach(buildSlot);
  }
  function fillStatic() {
    qsa('[data-f]', form).forEach(function (el) {
      var k = el.getAttribute('data-f'), v = state.f[k];
      if (el.type === 'checkbox') el.checked = !!v;
      else if (el.type === 'color') el.value = v || '#ffffff';
      else el.value = v || '';
      if (AMOUNTS[k]) markAmount(el, k);
    });
    qsa('[data-size]', form).forEach(function (el) { el.checked = state.activeSizes.indexOf(el.getAttribute('data-size')) !== -1; });
    qsa('[data-care]', form).forEach(function (el) { el.checked = state.careLabels.indexOf(el.getAttribute('data-care')) !== -1; });
    syncStatic();
  }
  function markAmount(el, k) { if (amountBad(k)) el.setAttribute('aria-invalid', 'true'); else el.removeAttribute('aria-invalid'); }
  function syncStatic() {
    qsa('[data-unit]', form).forEach(function (b) { b.setAttribute('aria-pressed', b.getAttribute('data-unit') === state.unit ? 'true' : 'false'); });
    $('hangTagDescField').hidden = !state.f.hangTagToggle;
    $('tp-art').hidden = !!state.f.noArtwork;
  }
  function onFormInput(e) {
    var t = e.target, k;
    if (!t || !t.getAttribute) return;
    if ((k = t.getAttribute('data-f'))) {
      var before = state.f[k];
      state.f[k] = t.type === 'checkbox' ? t.checked : t.value;
      if (state.f[k] === before) return;
      if (k === 'hangTagToggle' || k === 'noArtwork') syncStatic();
      if (k === 'productCategory') renderDiagram();
      if (AMOUNTS[k]) markAmount(t, k);
      changed();
    } else if ((k = t.getAttribute('data-size'))) {
      var i = state.activeSizes.indexOf(k);
      if (t.checked && i === -1) state.activeSizes.push(k);
      else if (!t.checked && i !== -1) state.activeSizes.splice(i, 1);
      else return;
      renderMeasure(); renderGrade(); changed();
    } else if ((k = t.getAttribute('data-care'))) {
      var j = state.careLabels.indexOf(k);
      if (t.checked && j === -1) state.careLabels.push(k);
      else if (!t.checked && j !== -1) state.careLabels.splice(j, 1);
      else return;
      changed();
    }
  }

  /* ---------- form: measurements ------------------------------------------------------ */
  function mName(m, i) { return trim(m.name) || 'Measurement ' + (i + 1); }
  function numInput(q, key, label, onInput) {
    var orig = { v: q.v, u: q.u };
    var el = h('input', { class: 'input num', inputmode: 'decimal', maxlength: 24, 'data-k': key, 'aria-label': label, value: qShow(q, state.unit) });
    if (qBad(q)) el.setAttribute('aria-invalid', 'true');
    el.addEventListener('input', function () {
      qSet(q, trim(el.value), state.unit, orig);
      if (qBad(q)) el.setAttribute('aria-invalid', 'true'); else el.removeAttribute('aria-invalid');
      if (onInput) onInput();
      changed();
    });
    return el;
  }
  function renderMeasure() {
    var host = $('tp-measure'), sizes = activeSizes(), u = state.unit;
    clear(host);
    if (!state.measurements.length) {
      add(host, h('div', { class: 'empty' }, [h('strong', { text: 'No measurements yet' }), h('span', { text: 'Add one below, or apply a template.' })]));
      return;
    }
    var headRow = h('tr', null, [h('th', { scope: 'col', text: 'Point of measure' })]);
    sizes.forEach(function (s) { add(headRow, h('th', { scope: 'col', class: 'n', text: s })); });
    add(headRow, [h('th', { scope: 'col', class: 'n' }, ['Tol. \u00B1']), h('th', { scope: 'col' }, [h('span', { class: 'visually-hidden', text: 'Remove' })])]);
    var body = h('tbody');
    state.measurements.forEach(function (m, i) {
      var tr = h('tr');
      var name = h('input', { class: 'input', maxlength: 80, placeholder: 'Name', 'data-k': 'm:' + m.id + ':name', 'aria-label': 'Measurement ' + (i + 1) + ' name', value: m.name });
      function relabel() {
        var nm = mName(m, i);
        qsa('[data-size-cell]', tr).forEach(function (c) { c.setAttribute('aria-label', nm + ', size ' + c.getAttribute('data-size-cell') + ', ' + state.unit); });
        var tol = tr.querySelector('[data-tol]'); if (tol) tol.setAttribute('aria-label', nm + ' tolerance, plus or minus, ' + state.unit);
        var rm = tr.querySelector('button'); if (rm) rm.setAttribute('aria-label', 'Remove ' + nm);
      }
      name.addEventListener('input', function () { m.name = name.value; relabel(); renderGradeLabels(); changed(); });
      add(tr, h('td', null, [name]));
      sizes.forEach(function (s) {
        if (!m.values[s]) m.values[s] = emptyQ();
        var inp = numInput(m.values[s], 'm:' + m.id + ':' + s, '');
        inp.setAttribute('data-size-cell', s);
        add(tr, h('td', { class: 'n' }, [inp]));
      });
      var tol = numInput(m.tol, 'm:' + m.id + ':tol', '');
      tol.setAttribute('data-tol', '');
      add(tr, h('td', { class: 'n' }, [tol]));
      var rm = h('button', { class: 'btn btn--ghost btn--icon', type: 'button', 'data-k': 'm:' + m.id + ':rm' }, [icon(ICON_X)]);
      rm.addEventListener('click', function () { removeRow(state.measurements, m, 'measurement', function () { renderMeasure(); renderGrade(); }); });
      add(tr, h('td', { class: 'tp-mtable__x' }, [rm]));
      relabel();
      add(body, tr);
    });
    var cap = h('caption', { class: 'visually-hidden', text: 'Measurements in ' + (u === 'cm' ? 'centimetres' : 'inches') });
    add(host, h('div', { class: 'table-wrap tp-mtable' }, [h('table', { class: 'table' }, [cap, h('thead', null, [headRow]), body])]));
  }
  function removeRow(list, item, noun, rerender) {
    var i = list.indexOf(item);
    if (i === -1) return;
    list.splice(i, 1);
    rerender(); changed();
    EL.toast('Removed the ' + noun + '.', { action: { label: 'Undo', onClick: function () { list.splice(Math.min(i, list.length), 0, item); rerender(); changed(); } } });
  }
  function addMeasurement() {
    var input = $('tp-measure-name');
    if (state.measurements.length >= MAX_ROWS) { EL.toast('That is the most measurements one sheet can hold.', { kind: 'bad' }); return; }
    var m = { id: nid(), name: trim(input.value).slice(0, 80), values: {}, tol: emptyQ(), grade: emptyQ() };
    state.measurements.push(m);
    input.value = '';
    renderMeasure(); renderGrade(); changed();
    focusKey('m:' + m.id + (m.name ? ':' + (activeSizes()[0] || 'tol') : ':name'));
  }

  /* ---------- form: grading helper ----------------------------------------------------- */
  function renderGrade() {
    var sel = $('tp-grade-base'), sizes = activeSizes(), host = $('tp-grade-steps');
    clear(sel);
    sizes.forEach(function (s) { add(sel, h('option', { value: s, text: s })); });
    if (sizes.indexOf(state.gradeBase) === -1) state.gradeBase = sizes.indexOf('M') !== -1 ? 'M' : (sizes[0] || 'M');
    sel.value = state.gradeBase;
    clear(host);
    state.measurements.forEach(function (m, i) {
      var inp = numInput(m.grade, 'g:' + m.id, mName(m, i) + ', step per size, ' + state.unit);
      inp.classList.remove('input', 'num');
      inp.setAttribute('placeholder', '0');
      add(host, h('label', { class: 'field' }, [
        h('span', { class: 'label', 'data-grade-label': String(i), text: mName(m, i) + ': step per size' }),
        h('span', { class: 'input-unit' }, [inp, h('span', { text: state.unit })])
      ]));
    });
    if (!state.measurements.length) add(host, h('p', { class: 'field__hint span2', text: 'Add a measurement first.' }));
    $('tp-grade-apply').disabled = !state.measurements.length || sizes.length < 2;
  }
  function renderGradeLabels() {
    qsa('[data-grade-label]', $('tp-grade-steps')).forEach(function (el) {
      var i = +el.getAttribute('data-grade-label'), m = state.measurements[i];
      if (m) el.textContent = mName(m, i) + ': step per size';
    });
  }
  function applyGrade() {
    var sizes = activeSizes(), base = state.gradeBase, bi = sizes.indexOf(base), u = state.unit;
    var plan = [], overwrites = 0, skipped = 0;
    if (bi === -1) return;
    state.measurements.forEach(function (m) {
      var step = qNum(m.grade, u), b = qNum(m.values[base], u);
      if (step == null || isNaN(step) || b == null || isNaN(b)) return;
      sizes.forEach(function (s, i) {
        if (i === bi) return;
        var val = b + (i - bi) * step;
        if (!(val > 0)) { skipped++; return; }
        var text = tidy(val, u === 'cm' ? 2 : 3), cur = m.values[s];
        if (cur && trim(cur.v) !== '' && qShow(cur, u) !== text) overwrites++;
        plan.push([m, s, text]);
      });
    });
    if (!plan.length) { EL.toast('Enter a value for size ' + base + ' and a step for at least one measurement.', { kind: 'bad', label: 'Grading' }); return; }
    function run() {
      var undo = state.measurements.map(function (m) { return clone(m.values); });
      plan.forEach(function (p) { p[0].values[p[1]] = { v: p[2], u: u }; });
      renderMeasure(); changed();
      EL.toast('Filled ' + plan.length + ' size value' + (plan.length === 1 ? '' : 's') + ' from size ' + base + '.' + (skipped ? ' ' + skipped + ' would be zero or less and were left alone.' : ''), {
        kind: 'ok', label: 'Grading',
        action: { label: 'Undo', onClick: function () { state.measurements.forEach(function (m, i) { if (undo[i]) m.values = undo[i]; }); renderMeasure(); changed(); } }
      });
    }
    if (!overwrites) { run(); return; }
    EL.confirm('This replaces ' + overwrites + ' value' + (overwrites === 1 ? '' : 's') + ' you have already entered with graded ones.', { title: 'Fill sizes from ' + base + '?', confirmLabel: 'Fill sizes', cancelLabel: 'Keep my values' })
      .then(function (yes) { if (yes) run(); });
  }

  /* ---------- form: colourways ------------------------------------------------------------ */
  function selectEl(group, value, key, blankLabel) {
    var sel = h('select', { 'data-k': key });
    if (blankLabel) add(sel, h('option', { value: '', text: blankLabel }));
    OPTS[group].forEach(function (o) { add(sel, h('option', { value: o[0], text: o[1] })); });
    sel.value = value;
    return sel;
  }
  function field(label, control, cls) { return h('label', { class: 'field' + (cls ? ' ' + cls : '') }, [h('span', { class: 'label', text: label }), control]); }
  function renderColorways() {
    var host = $('tp-colorways');
    clear(host);
    if (!state.colorways.length) {
      add(host, h('div', { class: 'empty' }, [h('strong', { text: 'No colourways yet' }), h('span', { text: 'One for each garment colour.' })]));
      return;
    }
    state.colorways.forEach(function (c, i) {
      var color = h('input', { class: 'tp-color', type: 'color', 'data-k': 'c:' + c.id + ':color', value: c.color });
      var name = h('input', { class: 'input', maxlength: 80, placeholder: 'For example Black', 'data-k': 'c:' + c.id + ':name', value: c.name });
      var thread = h('input', { class: 'input', maxlength: 300, placeholder: 'For example PMS 186 C', 'data-k': 'c:' + c.id + ':thread', value: c.threadColors });
      var status = selectEl('status', c.status, 'c:' + c.id + ':status');
      var rm = h('button', { class: 'btn btn--ghost btn--icon', type: 'button', 'data-k': 'c:' + c.id + ':rm' }, [icon(ICON_X)]);
      function relabel() { rm.setAttribute('aria-label', 'Remove colourway ' + (i + 1) + (trim(c.name) ? ', ' + trim(c.name) : '')); }
      color.addEventListener('input', function () { c.color = color.value; changed(); });
      name.addEventListener('input', function () { c.name = name.value; relabel(); changed(); });
      thread.addEventListener('input', function () { c.threadColors = thread.value; changed(); });
      status.addEventListener('change', function () { c.status = status.value; changed(); });
      rm.addEventListener('click', function () { removeRow(state.colorways, c, 'colourway', renderColorways); });
      relabel();
      add(host, h('div', { class: 'tp-cw', role: 'group', 'aria-label': 'Colourway ' + (i + 1) }, [
        field('Colour', color), field('Name', name),
        field('Status', h('span', { class: 'select' }, [status]), 'tp-cw__wide'),
        field('Thread or ink colours', thread, 'tp-cw__wide tp-cw__thread'), rm
      ]));
    });
  }
  function addColorway() {
    if (state.colorways.length >= MAX_ROWS) { EL.toast('That is the most colourways one sheet can hold.', { kind: 'bad' }); return; }
    var c = { id: nid(), name: '', color: '#000000', threadColors: '', status: 'Sample' };
    state.colorways.push(c);
    renderColorways(); changed();
    focusKey('c:' + c.id + ':name');
  }

  /* ---------- form: garment diagram and placements ------------------------------------------- */
  function sketch(paths, label) {
    var s = svg('svg', { viewBox: '0 0 200 180', role: 'img', 'aria-label': label });
    paths.forEach(function (d) { s.appendChild(svg('path', { d: d })); });
    return s;
  }
  function placementAt(loc) { for (var i = 0; i < state.placements.length; i++) if (state.placements[i].location === loc) return i; return -1; }
  function renderDiagram() {
    var host = $('tp-diagram'), sh = shape();
    var hadFocus = doc.activeElement && doc.activeElement.getAttribute && doc.activeElement.getAttribute('data-zone');
    clear(host);
    [['front', 'Front', sh.front, sh.zf], ['back', 'Back', sh.back, sh.zb]].forEach(function (v) {
      var stage = h('div', { class: 'tp-view__stage' });
      var sk = sketch(v[2], v[1] + ' of the garment'); sk.setAttribute('aria-hidden', 'true');
      add(stage, sk);
      Object.keys(v[3]).forEach(function (loc) {
        var r = v[3][loc], at = placementAt(loc), name = optLabel('location', loc);
        var b = h('button', {
          class: 'tp-zone num' + (at !== -1 ? ' is-selected' : ''), type: 'button', 'data-zone': loc, title: name,
          'aria-label': at !== -1 ? name + ': placement ' + (at + 1) + ', go to it' : 'Add a placement at ' + name.toLowerCase(),
          style: '--x:' + (r[0] / 2) + '%;--y:' + (r[1] / 1.8).toFixed(3) + '%;--w:' + (r[2] / 2) + '%;--h:' + (r[3] / 1.8).toFixed(3) + '%',
          text: at !== -1 ? pad2(at + 1) : ZONE_CODE[loc]
        });
        b.addEventListener('click', function () { addPlacement(loc, true); });
        add(stage, b);
      });
      add(host, h('figure', { class: 'tp-view', role: 'group', 'aria-label': v[1] + ' view zones' }, [stage, h('figcaption', { class: 'label', text: v[1] })]));
    });
    if (hadFocus) { var z = host.querySelector('[data-zone="' + hadFocus + '"]'); if (z) z.focus(); }
  }
  function addPlacement(loc, fromZone) {
    var at = placementAt(loc);
    if (fromZone && at !== -1) {
      focusKey('p:' + state.placements[at].id + ':decorationType');
      EL.toast(optLabel('location', loc) + ' is already placement ' + (at + 1) + '. Edit it below.');
      return;
    }
    if (state.placements.length >= MAX_ROWS) { EL.toast('That is the most placements one sheet can hold.', { kind: 'bad' }); return; }
    var p = { id: nid(), location: loc, decorationType: '', width: emptyQ(), height: emptyQ(), posFromTop: emptyQ(), posFromCenter: emptyQ(), numColors: '', colorList: '', instructions: '' };
    state.placements.push(p);
    renderPlacements(); renderDiagram(); changed();
    focusKey('p:' + p.id + ':decorationType');
  }
  function unitField(label, q, key) {
    var inp = numInput(q, key, null);
    inp.classList.remove('input', 'num');
    inp.removeAttribute('aria-label');
    return field(label, h('span', { class: 'input-unit' }, [inp, h('span', { text: state.unit })]));
  }
  function renderPlacements() {
    var host = $('tp-placements');
    clear(host);
    if (!state.placements.length) {
      add(host, h('div', { class: 'empty' }, [h('strong', { text: 'No placements yet' }), h('span', { text: 'Pick a zone above, or add one by name.' })]));
      return;
    }
    state.placements.forEach(function (p, i) {
      var k = 'p:' + p.id + ':';
      var title = h('h3', { class: 'label' });
      var rm = h('button', { class: 'btn btn--ghost btn--icon', type: 'button', 'data-k': k + 'rm' }, [icon(ICON_X)]);
      function retitle() {
        clear(title);
        add(title, [h('span', { class: 'num', text: pad2(i + 1) }), ' ', optLabel('location', p.location)]);
        rm.setAttribute('aria-label', 'Remove placement ' + (i + 1) + ', ' + optLabel('location', p.location));
      }
      var loc = selectEl('location', p.location, k + 'location');
      var deco = selectEl('decoration', p.decorationType, k + 'decorationType', 'Choose');
      var ncol = h('input', { class: 'input num', inputmode: 'numeric', maxlength: 6, placeholder: '1', 'data-k': k + 'numColors', value: p.numColors });
      var clist = h('input', { class: 'input', maxlength: 300, placeholder: 'For example PMS 186 C, PMS 280 C', 'data-k': k + 'colorList', value: p.colorList });
      var instr = h('textarea', { class: 'textarea', rows: 2, maxlength: 4000, placeholder: 'Anything the decorator needs to know', 'data-k': k + 'instructions', value: p.instructions });
      loc.addEventListener('change', function () { p.location = loc.value; retitle(); renderDiagram(); changed(); });
      deco.addEventListener('change', function () { p.decorationType = deco.value; changed(); });
      ncol.addEventListener('input', function () { p.numColors = trim(ncol.value); changed(); });
      clist.addEventListener('input', function () { p.colorList = clist.value; changed(); });
      instr.addEventListener('input', function () { p.instructions = instr.value; changed(); });
      rm.addEventListener('click', function () { removeRow(state.placements, p, 'placement', function () { renderPlacements(); renderDiagram(); }); });
      retitle();
      add(host, h('article', { class: 'plate tp-pl', 'aria-label': 'Placement ' + (i + 1) }, [
        h('div', { class: 'plate__head' }, [title, rm]),
        h('div', { class: 'plate__body fgrid' }, [
          field('Location', h('span', { class: 'select' }, [loc])),
          field('Decoration method', h('span', { class: 'select' }, [deco])),
          unitField('Artwork width', p.width, k + 'width'),
          unitField('Artwork height', p.height, k + 'height'),
          field('Number of colours', ncol),
          field('Colour list', clist),
          unitField('Position from top', p.posFromTop, k + 'posFromTop'),
          unitField('Position from centre', p.posFromCenter, k + 'posFromCenter'),
          field('Special instructions', instr, 'span2')
        ])
      ]));
    });
  }

  /* ---------- form: images ---------------------------------------------------------------------- */
  var SLOTS = [['front', 'Front flat image'], ['back', 'Back flat image'], ['detail', 'Detail shot']];
  var slotEls = {};
  function buildSlot(slot) {
    var key = slot[0], label = slot[1];
    var input = h('input', { class: 'visually-hidden', type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif,image/svg+xml', 'aria-label': label + ': choose a file' });
    var dropText = h('span', { text: 'Choose or drop an image' });
    var drop = h('label', { class: 'btn btn--drop' }, [input, dropText]);
    var img = h('img', { alt: '' });
    var thumb = h('div', { class: 'tp-img__thumb', hidden: true }, [img]);
    var name = h('span', { class: 'tp-img__name', hidden: true });
    var rm = h('button', { class: 'btn btn--block', type: 'button', hidden: true, text: 'Remove image', 'aria-label': 'Remove ' + label.toLowerCase() });
    var box = h('div', { class: 'tp-img', role: 'group', 'aria-label': label }, [h('span', { class: 'label', text: label }), thumb, name, drop, rm]);
    input.addEventListener('change', function () { if (input.files && input.files[0]) takeImage(key, label, input.files[0]); input.value = ''; });
    rm.addEventListener('click', function () {
      var old = state.images[key];
      delete state.images[key];
      renderImages(); changed();
      drop.querySelector('input').focus();
      EL.toast('Removed the ' + label.toLowerCase() + '.', { action: { label: 'Undo', onClick: function () { if (old) { state.images[key] = old; renderImages(); changed(); } } } });
    });
    box.addEventListener('dragover', function (e) { e.preventDefault(); drop.classList.add('is-over'); });
    box.addEventListener('dragleave', function (e) { if (!box.contains(e.relatedTarget)) drop.classList.remove('is-over'); });
    box.addEventListener('drop', function (e) {
      e.preventDefault(); drop.classList.remove('is-over');
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) takeImage(key, label, f);
    });
    slotEls[key] = { img: img, thumb: thumb, name: name, rm: rm, dropText: dropText, label: label };
    add($('tp-images'), box);
  }
  function renderImages() {
    SLOTS.forEach(function (slot) {
      var e = slotEls[slot[0]], im = state.images[slot[0]];
      e.thumb.hidden = e.name.hidden = e.rm.hidden = !im;
      e.dropText.textContent = im ? 'Replace image' : 'Choose or drop an image';
      if (im) {
        if (e.img.getAttribute('src') !== im.src) e.img.setAttribute('src', im.src);
        e.img.setAttribute('alt', e.label + ' preview');
        e.name.textContent = im.name || 'Image';
      } else { e.img.removeAttribute('src'); e.name.textContent = ''; }
    });
  }
  function takeImage(key, label, file) {
    if (!/^image\/(png|jpeg|webp|gif|svg\+xml)$/.test(file.type)) { EL.toast('Use a PNG, JPEG, WebP, GIF or SVG image.', { kind: 'bad', label: 'Image' }); return; }
    if (file.size > 30 * 1024 * 1024) { EL.toast('That image is over 30 MB. Use a smaller copy.', { kind: 'bad', label: 'Image' }); return; }
    var reader = new FileReader();
    reader.onerror = function () { EL.toast('That file could not be read.', { kind: 'bad', label: 'Image' }); };
    reader.onload = function () {
      shrink(String(reader.result), file.type).then(function (src) {
        state.images[key] = { src: src, name: String(file.name || '').slice(0, 120) };
        renderImages(); changed();
        EL.toast('Added the ' + label.toLowerCase() + '.', { kind: 'ok', label: 'Image' });
      }, function () { EL.toast('That file could not be read as an image.', { kind: 'bad', label: 'Image' }); });
    };
    reader.readAsDataURL(file);
  }
  /* Scale an image down until its data URL fits IMG_TARGET. Small raster files pass through untouched. */
  function shrink(dataUrl, type) {
    return new Promise(function (resolve, reject) {
      var im = new Image();
      im.onerror = function () { reject(new Error('decode')); };
      im.onload = function () {
        var w = im.naturalWidth, ht = im.naturalHeight;
        if (!w || !ht) { reject(new Error('empty')); return; }
        if (type !== 'image/svg+xml' && dataUrl.length <= IMG_TARGET && IMG_RE.test(dataUrl)) { resolve(dataUrl); return; }
        var out = null, steps = [1600, 1200, 900, 640, 420];
        try {
          for (var i = 0; i < steps.length; i++) {
            var scale = Math.min(1, steps[i] / Math.max(w, ht));
            var c = doc.createElement('canvas');
            c.width = Math.max(1, Math.round(w * scale)); c.height = Math.max(1, Math.round(ht * scale));
            var ctx = c.getContext('2d');
            ctx.drawImage(im, 0, 0, c.width, c.height);
            out = type === 'image/jpeg' ? c.toDataURL('image/jpeg', 0.86) : c.toDataURL('image/webp', 0.9);
            if (out.length <= IMG_TARGET) break;
          }
        } catch (e) { reject(e); return; }
        if (!out || !IMG_RE.test(out) || out.length > IMG_HARD) { reject(new Error('encode')); return; }
        resolve(out);
      };
      im.src = dataUrl;
    });
  }
  /* Images that arrive already oversized (an old draft, an imported file) are scaled after load. */
  function shrinkStored() {
    Object.keys(state.images).forEach(function (key) {
      var im = state.images[key];
      if (im.src.length <= IMG_TARGET) return;
      var type = /^data:(image\/[a-z]+)/.exec(im.src)[1];
      shrink(im.src, type).then(function (src) { if (state.images[key] === im) { im.src = src; renderImages(); changed(); } }, function () {});
    });
  }
  /* A file dropped beside a slot must not navigate the page away from the form. */
  ['dragover', 'drop'].forEach(function (type) {
    window.addEventListener(type, function (e) {
      var types = e.dataTransfer && e.dataTransfer.types;
      if (types && Array.prototype.indexOf.call(types, 'Files') !== -1) e.preventDefault();
    });
  });

  /* ---------- readiness: what a factory would still ask ---------------------------------------------- */
  var SECTION_NAMES = ['Style', 'Measurements', 'Materials', 'Colourways', 'Artwork placement', 'Labels and trims', 'Packaging', 'Order and notes'];
  function count(n, one, many) { return n + ' ' + (n === 1 ? one : many); }
  function assess() {
    var f = state.f, out = [], a;
    a = [];
    if (!trim(f.productName)) a.push('the style has no name');
    if (!trim(f.styleNumber)) a.push('there is no style number');
    if (!f.productCategory) a.push('the category is not chosen');
    out.push(a);

    a = [];
    var sizes = activeSizes(), missing = 0, bad = 0, unnamed = 0, noTol = 0;
    state.measurements.forEach(function (m) {
      if (!trim(m.name)) unnamed++;
      sizes.forEach(function (s) { var q = m.values[s]; if (!q || trim(q.v) === '') missing++; else if (qBad(q)) bad++; });
      if (trim(m.tol.v) === '') noTol++; else if (qBad(m.tol)) bad++;
    });
    if (!sizes.length) a.push('no sizes are selected');
    if (!state.measurements.length) a.push('there are no measurements');
    if (unnamed) a.push(count(unnamed, 'measurement has', 'measurements have') + ' no name');
    if (missing) a.push(count(missing, 'size value is', 'size values are') + ' empty');
    if (bad) a.push(count(bad, 'value is', 'values are') + ' not a number');
    if (noTol) a.push(count(noTol, 'measurement has', 'measurements have') + ' no tolerance');
    out.push(a);

    a = [];
    if (!trim(f.fabricComp)) a.push('the fabric composition is missing');
    if (!trim(f.gsmWeight) && !trim(f.baseBlank)) a.push('there is no fabric weight or base blank');
    if (amountBad('gsmWeight')) a.push(AMOUNTS.gsmWeight + ' is not a number');
    if (!trim(f.fabricColorName)) a.push('the fabric colour has no name');
    out.push(a);

    a = [];
    if (!state.colorways.length) a.push('there are no colourways');
    else { var cn = state.colorways.filter(function (c) { return !trim(c.name); }).length; if (cn) a.push(count(cn, 'colourway has', 'colourways have') + ' no name'); }
    out.push(a);

    a = [];
    if (!f.noArtwork) {
      if (!state.placements.length) a.push('there are no placements (tick the box if the style is blank)');
      var noDeco = 0, noSize = 0;
      state.placements.forEach(function (p) {
        if (!p.decorationType) noDeco++;
        var w = parseNum(p.width.v), ht = parseNum(p.height.v);
        if (!(w > 0) || !(ht > 0)) noSize++;
      });
      if (noDeco) a.push(count(noDeco, 'placement has', 'placements have') + ' no decoration method');
      if (noSize) a.push(count(noSize, 'placement has', 'placements have') + ' no artwork size');
    }
    out.push(a);

    a = [];
    if (!f.labelType) a.push('the label type is not chosen');
    else if (f.labelType !== 'None' && !trim(f.labelPlacement)) a.push('the label placement is missing');
    if (!state.careLabels.length) a.push('no care instructions are ticked');
    if (!trim(f.countryOrigin)) a.push('the country of origin is missing');
    out.push(a);

    a = [];
    if (!f.packagingType) a.push('the packaging type is not chosen');
    if (f.hangTagToggle && !trim(f.hangTagDesc)) a.push('the hang tag has no description');
    out.push(a);

    a = [];
    if (!trim(f.moq)) a.push('there is no order quantity');
    else if (amountBad('moq')) a.push(AMOUNTS.moq + ' is not a whole number');
    else if (!(amount('moq') > 0)) a.push(AMOUNTS.moq + ' is zero');
    ['costUnit', 'retailPrice'].forEach(function (k) { if (amountBad(k)) a.push(AMOUNTS[k] + ' is not a number'); });
    out.push(a);
    return out;
  }
  function renderReadiness() {
    var asks = assess(), done = 0, list = $('tp-ready-list');
    var buttons = qsa('.tp__index > button');
    clear(list);
    asks.forEach(function (a, i) {
      var ok = !a.length;
      if (ok) done++;
      var b = buttons[i];
      if (b) {
        b.classList.toggle('is-done', ok);
        b.setAttribute('aria-label', (i + 1) + ' ' + SECTION_NAMES[i] + (ok ? ', ready' : ', ' + count(a.length, 'open question', 'open questions')));
      }
      if (ok) return;
      var text = a.join('; ');
      var btn = h('button', { class: 'tp-ask', type: 'button' }, [
        h('span', { class: 'num', text: pad2(i + 1) }), ' ',
        h('span', null, [h('strong', { text: SECTION_NAMES[i] + ': ' }), text])
      ]);
      btn.addEventListener('click', function () { goSection(i, true); });
      add(list, h('li', null, [btn]));
    });
    $('tp-ready-count').textContent = done + ' / 8';
    var bar = $('tp-ready-bar');
    bar.setAttribute('aria-valuenow', done);
    bar.setAttribute('aria-valuetext', done + ' of 8 sections ready');
    bar.firstElementChild.style.setProperty('--val', (done / 8 * 100) + '%');
    if (done === 8) bar.setAttribute('data-state', 'ok'); else bar.removeAttribute('data-state');
    var note = $('tp-ready-text');
    note.hidden = done !== 8;
    note.textContent = done === 8 ? 'Nothing left to ask. A factory can quote from this sheet.' : '';
  }

  /* ---------- the sheet ------------------------------------------------------------------------------ */
  var sheet = $('tp-sheet');
  var imgCache = {};
  function swatch(color) {
    var s = svg('svg', { class: 'tp-sw', viewBox: '0 0 12 12', 'aria-hidden': 'true' });
    s.appendChild(svg('rect', { x: 0.5, y: 0.5, width: 11, height: 11, fill: /^#[0-9a-f]{6}$/i.test(color) ? color : '#ffffff' }));
    return s;
  }
  function specRow(dl, term, value, opts) {
    var isNode = value && typeof value === 'object';
    if (!isNode && trim(value) === '') return;
    var dd = h('dd', opts && opts.num ? { class: 'num' } : null);
    if (opts && opts.swatch) add(dd, swatch(opts.swatch));
    add(dd, isNode ? value : String(value));
    if (opts && opts.unit) add(dd, h('span', { class: 'unit', text: opts.unit }));
    add(dl, h('div', null, [h('dt', { text: term }), dd]));
  }
  function sec(no, title, kids) {
    var s = h('section', { class: 'tp-sec' }, [h('h3', { class: 'label' }, [h('span', { class: 'num', text: no }), ' ', title])]);
    return add(s, kids);
  }
  function flat(view, paths, zones) {
    var marks = 0;
    var s = svg('svg', { viewBox: '0 0 200 180', role: 'img' });
    paths.forEach(function (d) { s.appendChild(svg('path', { d: d })); });
    state.placements.forEach(function (p, i) {
      var r = zones[p.location];
      if (!r || state.f.noArtwork) return;
      marks++;
      s.appendChild(svg('rect', { class: 'tp-mark', x: r[0], y: r[1], width: r[2], height: r[3] }));
      var cx = r[0] + r[2] / 2 + (placementAt(p.location) === i ? 0 : 14 * marks), cy = r[1] + r[3] / 2;
      s.appendChild(svg('circle', { class: 'tp-mark-dot', cx: cx, cy: cy, r: 7 }));
      var t = svg('text', { class: 'tp-mark-no', x: cx, y: cy + 3 }); t.textContent = String(i + 1);
      s.appendChild(t);
    });
    s.setAttribute('aria-label', view + ' flat sketch' + (marks ? ', ' + count(marks, 'placement', 'placements') + ' marked' : ''));
    if (view === 'Front') s.id = 'garmentSvg';
    return h('figure', null, [s, h('figcaption', { class: 'label', text: view })]);
  }
  function moneyText(v) { var n = parseAmount(v); return n == null ? '' : (isNaN(n) ? trim(v) : EL.money(n)); }
  function renderSheet() {
    var f = state.f, u = state.unit, sizes = activeSizes(), sh = shape();
    var name = trim(f.productName) || 'Untitled style';
    var no = trim(f.styleNumber), date = showDate(f.packDate);
    var body = h('div', { class: 'tp-sheet__body' });

    /* head */
    var code = [no, trim(f.season)].filter(Boolean).join(' / ');
    add(body, h('header', { class: 'tp-sheet__head' }, [
      h('div', null, [h('span', { class: 'label', text: trim(f.brandName) ? 'Tech pack / ' + trim(f.brandName) : 'Tech pack' }), h('h2', { class: 'title', text: name })]),
      code ? h('div', { class: 'num', text: code }) : null
    ]));

    /* overview: flats + style facts */
    var dl = h('dl', { class: 'spec' });
    specRow(dl, 'Brand', f.brandName);
    specRow(dl, 'Category', optLabel('category', f.productCategory));
    specRow(dl, 'Fit', optLabel('fit', f.fitType));
    specRow(dl, 'Season', f.season);
    specRow(dl, 'Sizes', sizes.join(', '), { num: true });
    specRow(dl, 'Base blank', f.baseBlank);
    specRow(dl, 'Fabric', f.fabricComp);
    specRow(dl, 'Weight', trim(f.gsmWeight), { num: true, unit: amountBad('gsmWeight') ? null : 'gsm' });
    if (trim(f.fabricColorName) || f.fabricColorPicker) specRow(dl, 'Fabric colour', trim(f.fabricColorName) || (f.fabricColorPicker || '').toUpperCase(), { swatch: f.fabricColorPicker || '#ffffff' });
    specRow(dl, 'Designer', f.designer);
    specRow(dl, 'Version', f.version, { num: true });
    specRow(dl, 'Date', date, { num: true });
    add(body, h('div', { class: 'tp-sheet__cols' }, [
      h('div', { class: 'tp-sheet__flat' }, [flat('Front', sh.front, sh.zf), flat('Back', sh.back, sh.zb)]),
      dl
    ]));

    /* 02 measurements */
    if (state.measurements.length) {
      var hr = h('tr', null, [h('th', { scope: 'col', text: 'Point of measure' })]);
      sizes.forEach(function (s) { add(hr, h('th', { scope: 'col', class: 'n', text: s })); });
      add(hr, h('th', { scope: 'col', class: 'n' }, ['Tol. \u00B1']));
      var tb = h('tbody');
      state.measurements.forEach(function (m, i) {
        var tr = h('tr', null, [h('th', { scope: 'row', class: 'tp-sheet__rowhead', text: mName(m, i) })]);
        sizes.forEach(function (s) { add(tr, h('td', { class: 'n', text: qShow(m.values[s], u) || '-' })); });
        add(tr, h('td', { class: 'n', text: qShow(m.tol, u) || '-' }));
        add(tb, tr);
      });
      add(body, sec('02', 'Measurements, ' + (u === 'cm' ? 'centimetres' : 'inches'), [
        h('div', { class: 'table-wrap' }, [h('table', { class: 'table' }, [h('thead', null, [hr]), tb])])
      ]));
    }

    /* 03 construction */
    var c = h('dl', { class: 'spec spec--2' });
    specRow(c, 'Stitch type', optLabel('stitch', f.stitchType));
    specRow(c, 'Seam allowance', f.seamAllowance);
    specRow(c, 'Hem style', optLabel('hem', f.hemStyle));
    specRow(c, 'Neck finish', optLabel('neck', f.neckFinish));
    if (c.firstChild || trim(f.constructionNotes)) {
      add(body, sec('03', 'Construction', [c.firstChild ? c : null, trim(f.constructionNotes) ? h('p', { class: 'tp-sec__note', text: f.constructionNotes }) : null]));
    }

    /* 04 colourways */
    if (state.colorways.length) {
      var cb = h('tbody');
      state.colorways.forEach(function (cw, i) {
        add(cb, h('tr', null, [
          h('td', null, [swatch(cw.color), trim(cw.name) || 'Colourway ' + (i + 1)]),
          h('td', { class: 'num', text: cw.color.toUpperCase() }),
          h('td', { text: trim(cw.threadColors) || '-' }),
          h('td', null, [h('span', { class: 'tag' + (cw.status === 'Approved' || cw.status === 'Production' ? ' tag--ok' : ''), text: cw.status })])
        ]));
      });
      add(body, sec('04', 'Colourways', [h('div', { class: 'table-wrap' }, [h('table', { class: 'table' }, [
        h('thead', null, [h('tr', null, [h('th', { scope: 'col', text: 'Colourway' }), h('th', { scope: 'col', text: 'Reference' }), h('th', { scope: 'col', text: 'Thread or ink colours' }), h('th', { scope: 'col', text: 'Status' })])]), cb
      ])])]));
    }

    /* 05 artwork */
    var imgs = SLOTS.filter(function (s) { return state.images[s[0]]; });
    if (f.noArtwork) {
      add(body, sec('05', 'Artwork placement', [h('p', { text: 'No artwork or decoration on this style.' })]));
    } else if (state.placements.length || imgs.length) {
      var cards = h('div', { class: 'tp-sheet__pls' });
      state.placements.forEach(function (p, i) {
        var d = h('dl', { class: 'spec' });
        specRow(d, 'Method', optLabel('decoration', p.decorationType));
        var w = qShow(p.width, u), ht = qShow(p.height, u);
        if (w || ht) specRow(d, 'Artwork size', (w || '-') + ' x ' + (ht || '-'), { num: true, unit: u });
        specRow(d, 'From top', qShow(p.posFromTop, u), { num: true, unit: u });
        specRow(d, 'From centre', qShow(p.posFromCenter, u), { num: true, unit: u });
        specRow(d, 'Colours', p.numColors, { num: true });
        specRow(d, 'Colour list', p.colorList);
        add(cards, h('div', { class: 'tp-sheet__pl' }, [
          h('strong', null, [h('span', { class: 'num', text: String(i + 1) }), ' ', optLabel('location', p.location)]),
          d.firstChild ? d : null,
          trim(p.instructions) ? h('p', { class: 'tp-sec__note', text: p.instructions }) : null
        ]));
      });
      var figs = h('div', { class: 'tp-sheet__imgs' });
      imgs.forEach(function (s) {
        var im = state.images[s[0]], cached = imgCache[s[0]];
        if (!cached || cached.src !== im.src) cached = imgCache[s[0]] = { src: im.src, el: h('img', { src: im.src }) };
        cached.el.setAttribute('alt', s[1]);
        add(figs, h('figure', null, [cached.el, h('figcaption', { class: 'label', text: s[1] })]));
      });
      add(body, sec('05', 'Artwork placement', [state.placements.length ? cards : null, imgs.length ? figs : null]));
    }

    /* 06 labels and care */
    var l = h('dl', { class: 'spec spec--2' });
    specRow(l, 'Label type', optLabel('label', f.labelType));
    specRow(l, 'Label placement', f.labelPlacement);
    specRow(l, 'Country of origin', f.countryOrigin);
    if (l.firstChild || state.careLabels.length) {
      var tags = h('div', { class: 'tp-sheet__tags' });
      OPTS.care.forEach(function (o) { if (state.careLabels.indexOf(o[0]) !== -1) add(tags, h('span', { class: 'tag', text: o[1] })); });
      add(body, sec('06', 'Labels and care', [l.firstChild ? l : null, state.careLabels.length ? tags : null]));
    }

    /* 07 packaging */
    var pk = h('dl', { class: 'spec spec--2' });
    specRow(pk, 'Packaging', optLabel('packaging', f.packagingType));
    if (f.hangTagToggle) specRow(pk, 'Hang tag', trim(f.hangTagDesc) || 'Yes');
    if (pk.firstChild || trim(f.packagingNotes)) {
      add(body, sec('07', 'Packaging', [pk.firstChild ? pk : null, trim(f.packagingNotes) ? h('p', { class: 'tp-sec__note', text: f.packagingNotes }) : null]));
    }

    /* 08 order and notes */
    var o = h('dl', { class: 'spec spec--2' });
    var q = amount('moq');
    specRow(o, 'Order quantity', q == null ? '' : (isNaN(q) ? trim(f.moq) : EL.num(q)), { num: true, unit: q != null && !isNaN(q) ? 'units' : null });
    specRow(o, 'Target cost per unit', moneyText(f.costUnit), { num: true });
    specRow(o, 'Target retail price', moneyText(f.retailPrice), { num: true });
    if (o.firstChild || trim(f.generalNotes)) {
      add(body, sec('08', 'Order and notes', [o.firstChild ? o : null, trim(f.generalNotes) ? h('p', { class: 'tp-sec__note', text: f.generalNotes }) : null]));
    }

    /* title block */
    add(body, h('div', { class: 'tblock' }, [
      h('div', null, [h('span', { class: 'label', text: 'Style' }), h('strong', { text: name })]),
      h('div', null, [h('span', { class: 'label', text: 'No.' }), h('span', { class: 'num', text: no || '-' })]),
      h('div', null, [h('span', { class: 'label', text: 'Date' }), h('span', { class: 'num', text: date || '-' })]),
      h('div', null, [h('span', { class: 'label', text: 'Revision' }), h('span', { class: 'num', text: trim(f.version) || '-' })])
    ]));

    /* print-only running header: the thead of a one-cell table repeats on every printed page */
    var run = h('div', { class: 'tp-run label' }, [
      h('span', { text: 'Tech pack / ' + name }),
      h('span', { class: 'num', text: no ? 'No. ' + no : '' }),
      h('span', { class: 'num', text: date })
    ]);
    var table = h('table', { class: 'tp-print', role: 'presentation' }, [
      h('thead', null, [h('tr', null, [h('td', null, [run])])]),
      h('tbody', null, [h('tr', null, [h('td', null, [body])])])
    ]);
    clear(sheet);
    add(sheet, table);
  }

  /* ---------- section index, back / next, phone view switch ----------------------------------------------- */
  var tp = doc.querySelector('.tp');
  var sections = qsa('.tp__section', form);
  var indexButtons = qsa('.tp__index > button');
  var current = 0;
  function setCurrent(i) {
    current = Math.max(0, Math.min(sections.length - 1, i));
    indexButtons.forEach(function (b, n) { if (n === current) b.setAttribute('aria-current', 'step'); else b.removeAttribute('aria-current'); });
    $('tp-back').disabled = current === 0;
    var next = $('tp-next');
    next.hidden = current === sections.length - 1;
    if (!next.hidden) { clear(next); add(next, h('span', null, ['Next', h('span', { class: 'hide-phone', text: ': ' + SECTION_NAMES[current + 1] })])); next.setAttribute('aria-label', 'Next: ' + SECTION_NAMES[current + 1]); }
    var b = indexButtons[current], strip = b && b.parentNode;
    if (strip && strip.scrollWidth > strip.clientWidth) strip.scrollLeft = b.offsetLeft - (strip.clientWidth - b.offsetWidth) / 2;
  }
  var spyPaused = 0;
  function goSection(i, focusHeading) {
    i = Math.max(0, Math.min(sections.length - 1, i));
    if (tp.getAttribute('data-view') !== 'form') setView('form');
    spyPaused = Date.now() + 250;
    sections[i].scrollIntoView({ block: 'start' });
    setCurrent(i);
    if (focusHeading) { var hd = sections[i].querySelector('h2'); if (hd) hd.focus({ preventScroll: true }); }
  }
  function spy() {
    if (Date.now() < spyPaused) return;
    var strip = indexButtons[0].parentNode;
    var line = strip.getBoundingClientRect().top + (getComputedStyle(strip).display === 'flex' ? strip.offsetHeight : 0) + 80;
    var found = 0;
    sections.forEach(function (s, i) { if (s.getBoundingClientRect().top <= line) found = i; });
    if (window.innerHeight + window.scrollY >= doc.documentElement.scrollHeight - 2 && sections[sections.length - 1].getBoundingClientRect().top < window.innerHeight) found = Math.max(found, current);
    if (found !== current) setCurrent(found);
  }
  var spyQueued = false;
  window.addEventListener('scroll', function () {
    if (spyQueued) return;
    spyQueued = true;
    requestAnimationFrame(function () { spyQueued = false; spy(); });
  }, { passive: true });
  function setView(view) {
    tp.setAttribute('data-view', view);
    qsa('.page-head [data-view]').forEach(function (b) { b.setAttribute('aria-pressed', b.getAttribute('data-view') === view ? 'true' : 'false'); });
    if (view === 'sheet') flushNow();
  }
  function flushNow() { sheetQueued = true; flush(); }

  /* ---------- whole-pack actions ------------------------------------------------------------------------------ */
  function renderAll() {
    fillStatic();
    renderMeasure(); renderGrade(); renderColorways(); renderPlacements(); renderDiagram(); renderImages();
    flushNow();
  }
  function replaceState(next, message, label) {
    var prev = state;
    state = next;
    renderAll(); saveNow(); shrinkStored();
    EL.toast(message, { kind: 'ok', label: label, timeout: 8000, action: { label: 'Undo', onClick: function () { state = prev; renderAll(); saveNow(); } } });
  }
  function applyTemplate() {
    var key = $('templateSelect').value, t = TEMPLATES[key];
    if (!t) { EL.toast('Choose a template first.'); $('templateSelect').focus(); return; }
    function run() {
      var next = clone(state);
      Object.keys(t.f).forEach(function (k) { next.f[k] = t.f[k]; });
      next.activeSizes = DEFAULT_SIZES.slice();
      next.measurements = t.m.map(function (m) { return { id: nid(), name: m.name, values: clone(m.values), tol: clone(m.tol), grade: { v: '', u: 'in' } }; });
      next.careLabels = t.care.slice();
      replaceState(next, 'Applied the ' + t.label + ' template. Its numbers are starting points: check each one.', 'Template');
    }
    var touched = state.measurements.length || state.careLabels.length || Object.keys(t.f).some(function (k) { return state.f[k] && state.f[k] !== t.f[k]; });
    if (!touched) { run(); return; }
    EL.confirm('This replaces the measurements, materials, construction, label, packaging type and care instructions. Brand, style, colourways, artwork and notes stay as they are.', { title: 'Apply the ' + t.label + ' template?', confirmLabel: 'Apply template', cancelLabel: 'Keep mine' })
      .then(function (yes) { if (yes) run(); });
  }
  function startOver() {
    if (isBlank(state)) { EL.toast('The tech pack is already empty.'); return; }
    EL.confirm('This clears every field and image saved on this device. Export a file first if you want to keep a copy.', { title: 'Start over?', confirmLabel: 'Start over', cancelLabel: 'Keep it', danger: true })
      .then(function (yes) {
        if (!yes) return;
        $('templateSelect').value = '';
        replaceState(blank(), 'Cleared the tech pack.', 'Start over');
        goSection(0);
      });
  }
  function fileSlug(s) { return trim(s).normalize('NFKD').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).toLowerCase(); }
  function exportFile() {
    var base = fileSlug(state.f.styleNumber) || fileSlug(state.f.productName) || 'untitled';
    var name = 'techpack-' + base + '-' + todayLocal() + '.json';
    EL.download(name, JSON.stringify(serialise(true), null, 2), 'application/json');
    EL.toast('Saved ' + name, { kind: 'ok', label: 'Export' });
  }
  function importText(text) {
    var next;
    try { next = normalise(JSON.parse(text)); }
    catch (e) {
      EL.toast(e instanceof SyntaxError ? 'That file is not valid JSON, so it cannot be a tech pack.' : e.message, { kind: 'bad', label: 'Import' });
      return Promise.resolve(false);
    }
    function run() { $('templateSelect').value = ''; replaceState(next, 'Imported the tech pack.', 'Import'); goSection(0); return true; }
    if (isBlank(state)) return Promise.resolve(run());
    return EL.confirm('The imported file replaces everything in the tech pack you have open.', { title: 'Replace the current tech pack?', confirmLabel: 'Replace', cancelLabel: 'Keep mine' })
      .then(function (yes) { return yes ? run() : false; });
  }
  function importFile(file) {
    if (file.size > 40 * 1024 * 1024) { EL.toast('That file is too large to be a tech pack.', { kind: 'bad', label: 'Import' }); return; }
    var reader = new FileReader();
    reader.onerror = function () { EL.toast('That file could not be read.', { kind: 'bad', label: 'Import' }); };
    reader.onload = function () { importText(String(reader.result)); };
    reader.readAsText(file);
  }

  /* ---------- wire up ------------------------------------------------------------------------------------------ */
  buildStatic();
  var stored = EL.store.get(KEY, null);
  if (stored) {
    try { state = normalise(stored); saveStatus('Saved on this device'); }
    catch (e) { state = blank(); EL.toast('The draft saved on this device could not be opened. It is left untouched until you change something.', { kind: 'bad', label: 'Draft' }); }
  }
  renderAll();
  setCurrent(0);
  shrinkStored();

  form.addEventListener('input', onFormInput);
  form.addEventListener('change', onFormInput);
  form.addEventListener('submit', function (e) { e.preventDefault(); });
  $('tp-units').addEventListener('click', function (e) {
    var b = e.target.closest('[data-unit]');
    if (!b || b.getAttribute('data-unit') === state.unit) return;
    state.unit = b.getAttribute('data-unit');
    syncStatic();
    keepFocus(function () { renderMeasure(); renderGrade(); renderPlacements(); });
    changed();
  });
  $('tp-measure-add').addEventListener('click', addMeasurement);
  $('tp-measure-name').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); addMeasurement(); } });
  $('tp-grade-base').addEventListener('change', function () { state.gradeBase = this.value; scheduleSave(); });
  $('tp-grade-apply').addEventListener('click', applyGrade);
  $('tp-colorway-add').addEventListener('click', addColorway);
  $('tp-placement-add').addEventListener('click', function () { addPlacement($('tp-placement-loc').value, false); });
  $('tp-template-apply').addEventListener('click', applyTemplate);
  $('tp-reset').addEventListener('click', startOver);
  $('tp-export').addEventListener('click', exportFile);
  $('tp-import').addEventListener('click', function () { $('tp-import-file').click(); });
  $('tp-import-file').addEventListener('change', function () { if (this.files && this.files[0]) importFile(this.files[0]); this.value = ''; });
  $('tp-print').addEventListener('click', function () { flushNow(); window.print(); });
  window.addEventListener('beforeprint', flushNow);
  $('tp-back').addEventListener('click', function () { goSection(current - 1, true); });
  $('tp-next').addEventListener('click', function () { goSection(current + 1, true); });
  indexButtons.forEach(function (b, i) { b.addEventListener('click', function () { goSection(i, true); }); });
  qsa('.page-head [data-view]').forEach(function (b) {
    b.addEventListener('click', function () { setView(b.getAttribute('data-view')); if (b.getAttribute('data-view') === 'sheet') tp.scrollIntoView({ block: 'start' }); });
  });

  /* Small surface for tests and the console. Not used by the page itself. */
  window.ELTechPack = {
    getState: function () { return clone(serialise(true)); },
    importText: importText,
    exportText: function () { return JSON.stringify(serialise(true), null, 2); },
    saveNow: saveNow,
    render: flushNow
  };
})();
