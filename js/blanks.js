/* EMBROIDERY LABS - js/blanks.js (blanks.html only).
   Needs js/site.js (window.EL) and js/blanks-data.js (window.BLANKS_DATA), both loaded before this file.
   Everything on the page is built with DOM methods and textContent: no data string is ever parsed as HTML. */
(function () {
  'use strict';

  var EL = window.EL || {};
  var DATA = window.BLANKS_DATA;
  var MAX_COMPARE = 4;
  var STORE_KEY = 'el-blanks-compare';
  var NONE = '~none';                       /* facet value for "the source did not say" */
  var OZ_TO_GSM = 33.906;
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var SVG_NS = 'http://www.w3.org/2000/svg';

  function $(id) { return document.getElementById(id); }

  /* ---------- small helpers ------------------------------------------------ */
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null && text !== '') n.textContent = text;
    return n;
  }
  function icon(viewBox, d, size) {
    var s = document.createElementNS(SVG_NS, 'svg');
    s.setAttribute('viewBox', viewBox); s.setAttribute('width', size); s.setAttribute('height', size);
    s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '1.5');
    s.setAttribute('aria-hidden', 'true');
    var p = document.createElementNS(SVG_NS, 'path'); p.setAttribute('d', d); s.appendChild(p);
    return s;
  }
  function str(v) {
    if (typeof v === 'string') return v.trim();
    if (typeof v === 'number' && isFinite(v)) return String(v);
    return '';
  }
  function pos(v) {                                    /* a finite number above zero, or null */
    var n = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
    return isFinite(n) && n > 0 ? n : null;
  }
  function list(v) { return Array.isArray(v) ? v.map(str).filter(Boolean) : []; }
  function httpUrl(v) {
    try { var u = new URL(str(v)); return (u.protocol === 'http:' || u.protocol === 'https:') ? u : null; } catch (e) { return null; }
  }
  function hostOf(u) { return u.hostname.replace(/^www\./, ''); }
  function fmtDate(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str(iso));
    if (!m || !MONTHS[Number(m[2]) - 1]) return '';
    return Number(m[3]) + ' ' + MONTHS[Number(m[2]) - 1] + ' ' + m[1];
  }
  function trimNum(n, digits) { return String(parseFloat(n.toFixed(digits))); }
  function money(n, cur) { var s = n.toFixed(2); return (!cur || cur === 'USD') ? '$' + s : s + ' ' + cur; }
  function fold(s) {                                   /* lower case, accents off, punctuation to spaces */
    var t = str(s).toLowerCase();
    if (t.normalize) t = t.normalize('NFKD').replace(/[̀-ͯ]/g, '');
    return t.replace(/[^a-z0-9]+/g, ' ').trim();
  }
  function squash(s) { return fold(s).replace(/ /g, ''); }
  function naturalCompare(a, b) { return a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' }); }
  function missing(text) { return el('span', 'missing', text || 'Not listed'); }
  function toast(msg, opts) { if (EL.toast) EL.toast(msg, opts); }
  function setText(node, text) { if (node && node.textContent !== text) node.textContent = text; }

  /* ---------- reading one row ---------------------------------------------- */
  var TYPE_LABEL = { 't-shirt': 'T-shirt', 'long sleeve': 'Long sleeve' };
  function typeLabel(type) { return TYPE_LABEL[type.toLowerCase()] || type; }

  function typeWords(type) {
    var t = fold(type), w = [];
    if (/t shirt|tee/.test(t)) w.push('tee tshirt t shirt short sleeve');
    if (/long sleeve/.test(t)) w.push('long sleeve tee longsleeve');
    if (/hood/.test(t)) w.push('hoodie hoody hooded sweatshirt fleece');
    if (/crew/.test(t)) w.push('crewneck crew neck sweatshirt sweater fleece');
    if (/tank/.test(t)) w.push('tank top sleeveless');
    return w.join(' ');
  }
  function kindOf(type, fabric) {                      /* which weight scale applies */
    var t = fold(type);
    if (/hood|crew|sweat|fleece|zip/.test(t)) return 'fleece';
    if (/shirt|tee|tank|sleeve/.test(t)) return 'jersey';
    return /fleece|terry/.test(fold(fabric)) ? 'fleece' : 'jersey';
  }
  /* Fibre shares of the main (solid colour) fabric, read from the first clause of the text.
     Returns null when the shares do not add up to 100, so nothing is guessed. */
  function composition(fabric) {
    var seg = str(fabric).split(';')[0].split(',')[0];
    var re = /(\d+(?:\.\d+)?)\s*%\s*([^\/]+)/g, m, n = 0;
    var c = { cotton: 0, polyester: 0, rayon: 0, other: 0 };
    while ((m = re.exec(seg))) {
      var share = parseFloat(m[1]), word = m[2].toLowerCase(); n++;
      if (/poly/.test(word)) c.polyester += share;
      else if (/cotton/.test(word)) c.cotton += share;
      else if (/rayon|viscose|modal/.test(word)) c.rayon += share;
      else c.other += share;
    }
    if (!n || Math.abs(c.cotton + c.polyester + c.rayon + c.other - 100) > 0.5) return null;
    return c;
  }
  function fabricClass(c) {
    if (!c) return 'other';
    if (c.cotton === 100) return 'cotton';
    if (c.polyester === 100) return 'poly';
    if (c.rayon === 0 && c.other === 0) return 'blend';
    return 'tri';
  }
  function fabricShort(c, fabric) {
    if (!c) return str(fabric).split(';')[0].split(',')[0];
    return [['cotton', c.cotton], ['polyester', c.polyester], ['rayon', c.rayon], ['other fibre', c.other]]
      .filter(function (p) { return p[1] > 0; })
      .sort(function (a, b) { return b[1] - a[1]; })
      .map(function (p) { return trimNum(p[1], 1) + '% ' + p[0]; }).join(' / ');
  }
  function weightClass(oz, kind) {
    if (oz == null) return NONE;
    var light = kind === 'fleece' ? 8 : 5, heavy = kind === 'fleece' ? 10 : 6;
    return oz < light ? 'light' : (oz < heavy ? 'mid' : 'heavy');
  }
  function brandWords(brand) {                         /* "Los Angeles Apparel" is also found as "la apparel" */
    var w = fold(brand).split(' ').filter(Boolean);
    if (w.length < 3) return '';
    var lead = w.slice(0, -1).map(function (x) { return x.charAt(0); }).join('');
    return lead + ' ' + w[w.length - 1] + ' ' + lead + w[w.length - 1].charAt(0);
  }

  /* Decoration methods. "test" is a rule of thumb from fabric and weight, never a maker's claim.
     "words" are searched one by one; "phrases" only as a whole, because "garment" or "dye" alone
     would also match garment-dyed and pigment-dyed blanks. */
  var DECO = [
    { key: 'dtg', label: 'DTG', option: 'DTG: 100% cotton or cotton face', words: 'dtg', phrases: ['direct to garment'],
      test: function (it) { return !!(it.comp && it.comp.cotton === 100) || it.cottonFace; } },
    { key: 'emb', label: 'Embroidery', option: 'Embroidery: 180 gsm and up', words: 'embroidery embroider embroidered',
      test: function (it) { return it.gsm != null && it.gsm >= 180; } },
    { key: 'sub', label: 'Sublimation', option: 'Sublimation: 65% polyester or more', words: 'sublimation', phrases: ['dye sublimation', 'dye sub'],
      test: function (it) { return !!(it.comp && it.comp.polyester >= 65); } },
    { key: 'screen', label: 'Screen print', option: 'Screen print', words: 'screen print screenprint screen printing',
      test: function () { return true; } },
    { key: 'dtf', label: 'DTF transfer', option: 'DTF transfer', words: 'dtf heat transfer',
      test: function () { return true; } }
  ];

  function readRow(row, index) {
    var it = { row: row, key: str(row.id) || 'row-' + index };
    it.brand = str(row.brand); it.style = str(row.style); it.name = str(row.name); it.type = str(row.type);
    it.aliases = list(row.aliases); it.fabric = str(row.fabric); it.fit = str(row.fit); it.sizes = str(row.sizes);
    it.origin = str(row.origin); it.features = list(row.features); it.note = str(row.note);
    it.status = str(row.status).toLowerCase(); it.verified = row.verified === true;
    it.checked = fmtDate(row.checkedOn);
    var colors = pos(row.colors); it.colors = colors == null ? null : Math.round(colors);

    it.title = [it.brand, it.style].filter(Boolean).join(' ') || it.name || 'Blank ' + it.key;
    it.full = it.name && it.title !== it.name ? it.title + ', ' + it.name : it.title;

    var oz = pos(row.ozyd), gsm = pos(row.gsm);
    it.gsmStated = row.gsmStated === true && gsm != null;
    if (oz == null && gsm != null) oz = gsm / OZ_TO_GSM;
    if (gsm == null && oz != null) gsm = oz * OZ_TO_GSM;
    it.oz = oz; it.gsm = gsm == null ? null : Math.round(gsm);
    it.ozStated = pos(row.ozyd) != null;
    it.kind = kindOf(it.type, it.fabric);
    it.wclass = weightClass(it.oz, it.kind);

    it.comp = composition(it.fabric);
    it.fclass = fabricClass(it.fabric ? it.comp : null);
    it.fabricShort = fabricShort(it.comp, it.fabric);
    it.cottonFace = /100\s*%[^,;\/]*cotton face/i.test(it.fabric);

    var lo = pos(row.priceLow), hi = pos(row.priceHigh);
    if (lo == null) lo = hi; if (hi == null) hi = lo;
    if (lo != null && lo > hi) { var swap = lo; lo = hi; hi = swap; }
    it.lo = lo; it.hi = hi;
    it.currency = str(row.priceCurrency).toUpperCase();
    var usd = !it.currency || it.currency === 'USD';
    it.priceText = lo == null ? '' : (lo === hi ? money(lo, it.currency) : (usd ? money(lo, '') + '–' + money(hi, '') : lo.toFixed(2) + '–' + money(hi, it.currency)));
    it.priceSource = str(row.priceSource); it.priceSourceUrl = httpUrl(row.priceSourceUrl);
    it.priceBasis = str(row.priceBasis); it.priceNote = str(row.priceNote);

    it.sourceUrl = httpUrl(row.sourceUrl);
    it.sources = (Array.isArray(row.sources) ? row.sources : []).map(httpUrl).filter(Boolean);
    if (!it.sourceUrl && it.sources.length) it.sourceUrl = it.sources[0];
    if (it.sourceUrl && !it.sources.some(function (u) { return u.href === it.sourceUrl.href; })) it.sources.unshift(it.sourceUrl);

    it.deco = DECO.filter(function (d) { return d.test(it); }).map(function (d) { return d.key; });

    var identity = [it.brand, brandWords(it.brand), it.style].concat(it.aliases, [it.name, it.type, typeWords(it.type)]);
    var rest = [it.fabric, FABRIC_LABEL[it.fclass], it.fit ? it.fit + ' fit' : '', it.origin, it.origin ? 'made in ' + it.origin : '', it.sizes,
      it.wclass === NONE ? '' : it.wclass + ' ' + it.wclass + 'weight', it.status, it.priceSource, it.verified ? '' : 'unverified']
      .concat(it.features, DECO.filter(function (d) { return it.deco.indexOf(d.key) >= 0; }).map(function (d) { return d.words; }));
    it.hay = ' ' + identity.concat(rest).map(fold).filter(Boolean).join(' ') + ' ';
    it.haySquash = identity.concat(rest).map(squash).filter(Boolean).join('|');
    it.idSquash = identity.map(squash).filter(Boolean).join('|');
    it.ui = {};
    return it;
  }

  /* ---------- filter groups ------------------------------------------------ */
  var WEIGHT_LABEL = { light: 'Light', mid: 'Mid', heavy: 'Heavy' };
  var FABRIC_LABEL = { cotton: '100% cotton', blend: 'Cotton/polyester blend', tri: 'Tri-blend', poly: '100% polyester', other: 'Other or not listed' };
  var WEIGHT_ORDER = ['light', 'mid', 'heavy', NONE];
  var FABRIC_ORDER = ['cotton', 'blend', 'tri', 'poly', 'other'];

  var GROUPS = [
    { key: 'type', host: 'opts-type', value: function (it) { return [it.type || NONE]; }, label: function (v) { return v === NONE ? 'Not listed' : typeLabel(v); }, order: 'count' },
    { key: 'weight', host: 'opts-weight', value: function (it) { return [it.wclass]; }, label: function (v) { return WEIGHT_LABEL[v] || 'Not listed'; }, order: WEIGHT_ORDER },
    { key: 'fabric', host: 'opts-fabric', value: function (it) { return [it.fclass]; }, label: function (v) { return FABRIC_LABEL[v] || v; }, order: FABRIC_ORDER },
    { key: 'deco', host: 'opts-deco', all: true, value: function (it) { return it.deco; }, label: function (v) { return decoByKey(v).option; }, order: DECO.map(function (d) { return d.key; }) },
    { key: 'brand', host: 'opts-brand', fold: 'n-brand', value: function (it) { return [it.brand || NONE]; }, label: function (v) { return v === NONE ? 'Not listed' : v; }, order: 'alpha' },
    { key: 'fit', host: 'opts-fit', fold: 'n-fit', value: function (it) { return [it.fit || NONE]; }, label: function (v) { return v === NONE ? 'Not listed' : v; }, order: 'alpha' }
  ];
  function decoByKey(k) { for (var i = 0; i < DECO.length; i++) if (DECO[i].key === k) return DECO[i]; return DECO[0]; }

  var SORTS = {
    'brand': function (a, b) { return byBrand(a, b); },
    'brand-desc': function (a, b) { return byBrand(b, a); },
    'price-asc': function (a, b) { return nullsLast(a.lo, b.lo, 1) || byBrand(a, b); },
    'price-desc': function (a, b) { return nullsLast(a.hi, b.hi, -1) || byBrand(a, b); },
    'weight-asc': function (a, b) { return nullsLast(a.gsm, b.gsm, 1) || byBrand(a, b); },
    'weight-desc': function (a, b) { return nullsLast(a.gsm, b.gsm, -1) || byBrand(a, b); }
  };
  function byBrand(a, b) { return naturalCompare(a.brand, b.brand) || naturalCompare(a.style, b.style) || naturalCompare(a.name, b.name); }
  function nullsLast(a, b, dir) {
    if (a == null && b == null) return 0;
    if (a == null) return 1;
    if (b == null) return -1;
    return (a - b) * dir;
  }

  /* ---------- state -------------------------------------------------------- */
  var items = [], byKey = {}, maxGsm = 1;
  var state = { q: '', type: [], brand: [], weight: [], fabric: [], fit: [], deco: [], max: null, sort: 'brand', view: '', compare: [], open: false };
  var options = {};                                    /* group key -> [{ value, input, count, row }] */
  var phone = window.matchMedia ? window.matchMedia('(max-width: 720px)') : { matches: false };
  var detailItem = null;
  var lastShown = [];

  function known(groupKey, value) {
    return (options[groupKey] || []).some(function (o) { return o.value === value; });
  }
  function cleanCompare(v) {                           /* any input -> up to four known keys, no repeats */
    if (!Array.isArray(v)) return [];
    var out = [];
    v.forEach(function (x) {
      var k = str(x);
      if (k && byKey[k] && out.indexOf(k) < 0 && out.length < MAX_COMPARE) out.push(k);
    });
    return out;
  }

  /* ---------- URL hash ----------------------------------------------------- */
  function readHash() {
    var p;
    try { p = new URLSearchParams(location.hash.replace(/^#/, '')); } catch (e) { p = new URLSearchParams(''); }
    var out = { q: str(p.get('q')).slice(0, 80), max: pos(p.get('max')), sort: SORTS[p.get('sort')] ? p.get('sort') : 'brand',
      view: p.get('view') === 'table' || p.get('view') === 'tags' ? p.get('view') : '',
      hasCompare: p.has('c'), compare: cleanCompare(str(p.get('c')).split(',')), open: p.get('open') === 'compare' };
    GROUPS.forEach(function (g) {
      var seen = [];
      p.getAll(g.key).forEach(function (v) { if (known(g.key, v) && seen.indexOf(v) < 0) seen.push(v); });
      out[g.key] = seen;
    });
    return out;
  }
  function hashString() {
    var p = new URLSearchParams();
    if (state.q) p.set('q', state.q);
    GROUPS.forEach(function (g) { state[g.key].forEach(function (v) { p.append(g.key, v); }); });
    if (state.max != null) p.set('max', trimNum(state.max, 2));
    if (state.sort !== 'brand') p.set('sort', state.sort);
    if (state.view) p.set('view', state.view);
    if (state.compare.length) p.set('c', state.compare.join(','));
    if (state.open && state.compare.length >= 2) p.set('open', 'compare');
    return p.toString();
  }
  var hashTimer = 0;
  function flushHash() {
    clearTimeout(hashTimer); hashTimer = 0;
    var s = hashString(), here = location.pathname + location.search;
    if ((s ? '#' + s : '') === location.hash) return;
    try { history.replaceState(history.state, '', here + (s ? '#' + s : '')); } catch (e) { /* throttled or blocked: the view still works */ }
  }
  function scheduleHash() { clearTimeout(hashTimer); hashTimer = setTimeout(flushHash, 200); }

  /* ---------- matching ----------------------------------------------------- */
  var qTokens = [], qSquash = '', qDeco = [];
  function setQuery(q) {
    state.q = q;
    var text = ' ' + fold(q).split(' ').filter(Boolean).join(' ') + ' ';
    qDeco = [];
    DECO.forEach(function (d) {
      (d.phrases || []).forEach(function (ph) {
        var at = text.indexOf(' ' + ph + ' ');
        if (at < 0) return;
        if (qDeco.indexOf(d.key) < 0) qDeco.push(d.key);
        text = text.slice(0, at) + ' ' + text.slice(at + ph.length + 2);
      });
    });
    qTokens = text.split(' ').filter(Boolean); qSquash = qTokens.join('');
  }
  function matchSearch(it) {
    for (var d = 0; d < qDeco.length; d++) if (it.deco.indexOf(qDeco[d]) < 0) return false;
    if (!qTokens.length) return true;
    if (qSquash.length >= 4 && it.idSquash.indexOf(qSquash) >= 0) return true;     /* "bellacanvas", "tshirt" */
    for (var i = 0; i < qTokens.length; i++) {
      var t = qTokens[i];
      if (it.hay.indexOf(' ' + t) >= 0) continue;                                  /* start of a word */
      if (/\d/.test(t) && t.length >= 3 && it.haySquash.indexOf(t) >= 0) continue; /* part of a style number */
      return false;
    }
    return true;
  }
  function matchGroup(it, g, selected) {
    if (!selected.length) return true;
    var vals = g.value(it);
    if (g.all) return selected.every(function (v) { return vals.indexOf(v) >= 0; });
    return selected.some(function (v) { return vals.indexOf(v) >= 0; });
  }
  function matches(it, skipKey) {
    if (!matchSearch(it)) return false;
    if (state.max != null && (it.lo == null || it.lo > state.max)) return false;
    for (var i = 0; i < GROUPS.length; i++) {
      if (GROUPS[i].key !== skipKey && !matchGroup(it, GROUPS[i], state[GROUPS[i].key])) return false;
    }
    return true;
  }
  function activeFilterCount() {
    var n = (state.q ? 1 : 0) + (state.max != null ? 1 : 0);
    GROUPS.forEach(function (g) { n += state[g.key].length; });
    return n;
  }

  /* ---------- building the filter rail ------------------------------------- */
  function buildOptions() {
    GROUPS.forEach(function (g) {
      var host = $(g.host), counts = {}, values = [];
      items.forEach(function (it) {
        g.value(it).forEach(function (v) { if (!(v in counts)) { counts[v] = 0; values.push(v); } counts[v]++; });
      });
      /* An option is offered only when it narrows the list: never zero rows, and for
         "must suit all" groups never every row either. */
      values = values.filter(function (v) { return counts[v] > 0 && !(g.all && counts[v] === items.length); });
      if (Array.isArray(g.order)) values.sort(function (a, b) { return g.order.indexOf(a) - g.order.indexOf(b); });
      else if (g.order === 'count') values.sort(function (a, b) { return counts[b] - counts[a] || naturalCompare(a, b); });
      else values.sort(function (a, b) { return (a === NONE) - (b === NONE) || naturalCompare(a, b); });

      options[g.key] = values.map(function (v) {
        var row = el('label', 'check-row filters__opt');
        var input = el('input', 'check'); input.type = 'checkbox'; input.value = v; input.name = g.key;
        var count = el('span', 'num muted', String(counts[v]));
        row.appendChild(input); row.appendChild(el('span', '', g.label(v))); row.appendChild(count);
        input.addEventListener('change', function () {
          var sel = state[g.key], at = sel.indexOf(v);
          if (input.checked && at < 0) sel.push(v);
          if (!input.checked && at >= 0) sel.splice(at, 1);
          renderList(); scheduleHash();
        });
        host.appendChild(row);
        return { value: v, input: input, count: count, row: row };
      });
      var fieldset = host.closest('fieldset');
      if (fieldset && !values.length) fieldset.hidden = true;
    });

    /* Say plainly which methods are not filters, and why. */
    var everyRow = [], noRow = [];
    DECO.forEach(function (d) {
      var n = items.filter(function (it) { return it.deco.indexOf(d.key) >= 0; }).length;
      if (items.length && n === items.length) everyRow.push(d.label);
      if (n === 0) noRow.push(d.label.toLowerCase());
    });
    var hint = 'Rules of thumb, not maker claims.';
    if (everyRow.length) hint += ' ' + everyRow.join(' and ') + (everyRow.length > 1 ? ' suit' : ' suits') + ' every blank here.';
    if (noRow.length) hint += ' None has the fabric for ' + noRow.join(' or ') + '.';
    setText($('deco-hint'), hint);
  }

  function syncControls() {
    var search = $('f-search');
    if (search.value !== state.q) search.value = state.q;
    var max = $('f-max'), want = state.max == null ? '' : trimNum(state.max, 2);
    if (document.activeElement !== max && max.value !== want) max.value = want;
    GROUPS.forEach(function (g) {
      options[g.key].forEach(function (o) { o.input.checked = state[g.key].indexOf(o.value) >= 0; });
      if (g.fold) {
        setText($(g.fold), state[g.key].length ? String(state[g.key].length) : '');
        if (state[g.key].length) setFold($(g.host), true);
      }
    });
    if ($('sort').value !== state.sort) $('sort').value = state.sort;
  }
  function setFold(listEl, open) {
    var btn = document.querySelector('.filters__toggle[aria-controls="' + listEl.id + '"]');
    listEl.hidden = !open;
    if (btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  /* ---------- rows and tags (built once, then shown, hidden and reordered) -- */
  function sourceLink(it, cls) {
    if (!it.sourceUrl) return missing('No source listed');
    var a = el('a', cls || 'src');
    hostOf(it.sourceUrl).split('.').forEach(function (part, i) {   /* a long host name may wrap before a dot, not mid-word */
      if (i) a.appendChild(document.createElement('wbr'));
      a.appendChild(document.createTextNode((i ? '.' : '') + part));
    });
    a.href = it.sourceUrl.href; a.target = '_blank'; a.rel = 'noopener noreferrer';
    a.setAttribute('aria-label', hostOf(it.sourceUrl) + ', source for ' + it.title + ' (opens in a new tab)');
    return a;
  }
  function statusTags(it, host) {
    if (it.status === 'closeout') host.appendChild(el('span', 'tag tag--warn', 'Closeout'));
    if (!it.verified) host.appendChild(el('span', 'tag tag--bad', 'Unverified'));
  }
  function weightNodes(it, withBar) {
    var frag = document.createDocumentFragment();
    if (it.gsm == null) { frag.appendChild(missing()); return frag; }
    if (withBar) {
      var bar = el('span', 'gsm'); bar.setAttribute('aria-hidden', 'true');
      bar.style.setProperty('--val', Math.max(4, Math.round(it.gsm / maxGsm * 100)) + '%');
      bar.appendChild(el('i')); frag.appendChild(bar);
    }
    frag.appendChild(document.createTextNode(String(it.gsm)));
    frag.appendChild(el('span', 'unit', 'gsm'));
    return frag;
  }
  function ozText(it) { return it.oz == null ? '' : trimNum(it.oz, it.ozStated ? 2 : 1) + ' oz'; }
  function compareBox(it) {
    var cb = el('input', 'check'); cb.type = 'checkbox';
    cb.setAttribute('aria-label', 'Compare ' + it.full);
    cb.addEventListener('change', function () { if (!setCompare(it, cb.checked)) cb.checked = false; });
    return cb;
  }
  function nameButton(it) {
    var b = el('button', 'blank-btn', it.name || it.title); b.type = 'button';
    b.addEventListener('click', function () { openDetail(it); });
    return b;
  }

  function buildRow(it) {
    var tr = el('tr'), td;
    tr.setAttribute('data-id', it.key);
    td = el('td'); it.ui.rowCheck = compareBox(it); td.appendChild(it.ui.rowCheck); tr.appendChild(td);

    td = el('td', 'wrap-cell col-brand'); td.appendChild(it.brand ? document.createTextNode(it.brand) : missing()); tr.appendChild(td);

    td = el('td', 'wrap-cell col-style'); td.appendChild(nameButton(it));
    var sub = el('span', 'sub');
    if (it.style) sub.appendChild(el('span', 'num', it.style));
    sub.appendChild(document.createTextNode((it.style ? ' · ' : '') + (it.type ? typeLabel(it.type) : 'Garment not listed')));
    statusTags(it, sub);
    td.appendChild(sub); tr.appendChild(td);

    td = el('td', 'n'); td.appendChild(weightNodes(it, true));
    if (it.oz != null) td.appendChild(el('span', 'sub', ozText(it)));
    tr.appendChild(td);

    td = el('td', 'wrap-cell col-fabric'); td.appendChild(it.fabricShort ? document.createTextNode(it.fabricShort) : missing()); tr.appendChild(td);
    td = el('td', 'wrap-cell col-fit'); td.appendChild(it.fit ? document.createTextNode(it.fit) : missing()); tr.appendChild(td);

    td = el('td', 'n');
    if (it.priceText) { td.appendChild(document.createTextNode(it.priceText)); if (it.priceSource) td.appendChild(el('span', 'sub', 'at ' + it.priceSource)); }
    else td.appendChild(missing('No price listed'));
    tr.appendChild(td);

    td = el('td', 'wrap-cell col-src'); td.appendChild(sourceLink(it));
    td.appendChild(el('span', 'sub', it.checked || 'Date not listed'));
    tr.appendChild(td);

    it.ui.tr = tr;
    return tr;
  }

  function specLine(dl, term, value) {
    var row = el('div'), dd = el('dd');
    row.appendChild(el('dt', '', term));
    if (value == null || value === '') dd.appendChild(missing()); else if (typeof value === 'string') dd.textContent = value; else dd.appendChild(value);
    row.appendChild(dd); dl.appendChild(row);
  }
  function buildTag(it) {
    var tag = el('article', 'hangtag'); tag.setAttribute('aria-label', it.title);
    tag.setAttribute('data-id', it.key);
    var top = el('div', 'hangtag__brand');
    top.appendChild(el('span', 'label', it.brand || 'Brand not listed'));
    it.ui.tagCheck = compareBox(it); top.appendChild(it.ui.tagCheck);
    tag.appendChild(top);

    var name = el('div', 'hangtag__name'); name.appendChild(nameButton(it));
    if (it.style) name.appendChild(el('span', 'num', it.style));
    tag.appendChild(name);

    var tags = el('div', 'hangtag__tags'); statusTags(it, tags);
    if (tags.childNodes.length) tag.appendChild(tags);

    var dl = el('dl', 'spec');
    specLine(dl, 'Garment', it.type ? typeLabel(it.type) : '');
    var w = null;
    if (it.gsm != null) { w = el('span', 'num'); w.appendChild(weightNodes(it, false)); w.appendChild(document.createTextNode(' · ' + ozText(it))); }
    specLine(dl, 'Weight', w);
    specLine(dl, 'Fabric', it.fabricShort);
    specLine(dl, 'Fit', it.fit);
    if (it.origin) specLine(dl, 'Made in', it.origin);
    tag.appendChild(dl);

    var price = el('div', 'hangtag__price');
    price.appendChild(el('span', 'label', 'Approx., each'));
    price.appendChild(it.priceText ? el('span', 'num', it.priceText) : missing('No price listed'));
    tag.appendChild(price);

    var foot = el('div', 'hangtag__foot');
    foot.appendChild(sourceLink(it));
    foot.appendChild(el('span', '', it.checked ? 'Checked ' + it.checked : 'Date not listed'));
    tag.appendChild(foot);

    /* A click anywhere on the card that is not a control ticks it. Keyboard users have the checkbox.
       A click that ends a text selection (drag, or the second click of a double click) is not a tick. */
    tag.addEventListener('click', function (e) {
      if (e.target instanceof Element && e.target.closest('a, button, input, label')) return;
      var picked = window.getSelection ? window.getSelection() : null;
      if (picked && !picked.isCollapsed && tag.contains(picked.anchorNode)) return;
      setCompare(it, state.compare.indexOf(it.key) < 0);
    });
    it.ui.tag = tag;
    return tag;
  }

  /* ---------- list ---------------------------------------------------------- */
  /* Until the visitor picks a view, show the table only where every column fits: on a phone, a
     tablet or a narrow window the price and source columns would sit out of sight to the right. */
  var tableFits = true;
  function currentView() { return state.view || (phone.matches || !tableFits ? 'tags' : 'table'); }
  function rowsOf(list) { return list.map(function (it) { return it.ui.tr; }); }
  function measureTable() {                            /* measured with every row in, so typing in search never flips the view */
    var wrap = $('view-table'), body = $('rows'), was = wrap.hidden;
    var swap = lastShown.length !== items.length, focused = document.activeElement;
    if (swap) body.replaceChildren.apply(body, rowsOf(items));
    wrap.hidden = false;
    var fits = wrap.scrollWidth <= wrap.clientWidth + 1;
    wrap.hidden = was;
    if (swap) {
      body.replaceChildren.apply(body, rowsOf(lastShown));
      if (focused && focused !== document.activeElement && focused.isConnected && focused.focus) focused.focus();
    }
    return fits;
  }
  function refit() {
    var fits = measureTable();
    if (fits === tableFits) return;
    tableFits = fits; renderList();
  }

  function renderList() {
    var shown = items.filter(function (it) { return matches(it, null); }).sort(SORTS[state.sort] || SORTS.brand);
    lastShown = shown;
    $('rows').replaceChildren.apply($('rows'), rowsOf(shown));
    $('view-tags').replaceChildren.apply($('view-tags'), shown.map(function (it) { return it.ui.tag; }));

    var view = currentView(), none = shown.length === 0;
    $('view-table').hidden = none || view !== 'table';
    $('view-tags').hidden = none || view !== 'tags';
    $('empty').hidden = !none;
    /* A table the visitor asked for on a narrow screen scrolls sideways: say so, and let the keyboard scroll it. */
    var clipped = !none && view === 'table' && !tableFits;
    $('table-hint').hidden = !clipped;
    if (clipped) $('view-table').setAttribute('tabindex', '0'); else $('view-table').removeAttribute('tabindex');
    var segs = document.querySelectorAll('.results__bar [data-view]');
    for (var i = 0; i < segs.length; i++) segs[i].setAttribute('aria-pressed', segs[i].getAttribute('data-view') === view ? 'true' : 'false');

    setText($('result-count'), String(shown.length));
    setText($('result-total'), 'of ' + items.length);
    setText($('result-status'), shown.length + ' of ' + items.length + ' blanks shown');
    setText($('filters-count'), 'Filters · ' + shown.length + ' of ' + items.length);
    var active = activeFilterCount();
    setText($('filters-open'), active ? 'Filters (' + active + ')' : 'Filters');

    /* Counts beside each option: what you would get by ticking it, given everything else. */
    GROUPS.forEach(function (g) {
      var pool = items.filter(function (it) { return matches(it, g.key); });
      options[g.key].forEach(function (o) {
        var sel = g.all ? state[g.key].concat(state[g.key].indexOf(o.value) < 0 ? [o.value] : []) : [o.value];
        var n = pool.filter(function (it) { return matchGroup(it, g, sel); }).length;
        setText(o.count, String(n));
        o.row.classList.toggle('is-zero', n === 0 && !o.input.checked);
      });
      if (g.fold) setText($(g.fold), state[g.key].length ? String(state[g.key].length) : '');
    });

    /* Header sort arrows */
    var heads = document.querySelectorAll('.blank-table [data-sort-key]');
    for (var h = 0; h < heads.length; h++) {
      var key = heads[h].getAttribute('data-sort-key'), dir = 'none';
      if (key === 'brand' && state.sort === 'brand') dir = 'ascending';
      else if (state.sort === key + '-asc') dir = 'ascending';
      else if (state.sort === key + '-desc') dir = 'descending';
      heads[h].parentNode.setAttribute('aria-sort', dir);
    }
  }

  /* ---------- selection and tray ------------------------------------------- */
  function saveSelection() { saveSelectionOf(state.compare); }
  function loadSelection() {
    if (!EL.store) return [];
    var raw = EL.store.get(STORE_KEY, null);
    var clean = cleanCompare(raw);
    if (raw != null && (!Array.isArray(raw) || clean.length !== raw.length)) saveSelectionOf(clean);   /* repair what was stored */
    return clean;
  }
  function saveSelectionOf(keys) {
    if (!EL.store) return;
    if (keys.length) EL.store.set(STORE_KEY, keys); else EL.store.remove(STORE_KEY);
  }
  function setCompare(it, on) {
    var at = state.compare.indexOf(it.key);
    if (on && at < 0) {
      if (state.compare.length >= MAX_COMPARE) {
        toast('You can compare up to ' + MAX_COMPARE + ' blanks. Remove one to add another.', { kind: 'bad', label: 'Compare' });
        renderSelection();
        return false;
      }
      state.compare.push(it.key);
    } else if (!on && at >= 0) {
      state.compare.splice(at, 1);
    }
    saveSelection(); renderSelection(); scheduleHash();
    return true;
  }
  function renderSelection() {
    items.forEach(function (it) {
      var on = state.compare.indexOf(it.key) >= 0;
      it.ui.rowCheck.checked = on; it.ui.tagCheck.checked = on;
      if (on) it.ui.tr.setAttribute('aria-selected', 'true'); else it.ui.tr.removeAttribute('aria-selected');
      it.ui.tag.classList.toggle('is-selected', on);
    });
    var n = state.compare.length, tray = $('tray');
    tray.hidden = n === 0;
    setText($('tray-count'), String(n));
    var chips = state.compare.map(function (key) {
      var it = byKey[key], chip = el('span', 'tray__chip'), x = el('button');
      chip.appendChild(el('span', '', it.title));
      x.type = 'button'; x.setAttribute('aria-label', 'Remove ' + it.full + ' from the comparison'); x.setAttribute('data-key', key);
      x.appendChild(icon('0 0 12 12', 'M2.5 2.5l7 7M9.5 2.5l-7 7', '12'));
      x.addEventListener('click', function () { removeFromTray(it); });
      chip.appendChild(x);
      return chip;
    });
    $('tray-items').replaceChildren.apply($('tray-items'), chips);
    var open = $('tray-open');
    open.setAttribute('aria-disabled', n < 2 ? 'true' : 'false');
    setText(open, n < 2 ? 'Pick 1 more to compare' : 'Compare side by side');
    if ($('compare').open) { if (n < 2) EL.dialog.close('compare'); else renderCompare(); }
    if (detailItem && $('detail').open) syncDetailToggle();
  }
  function removeFromTray(it) {
    var at = state.compare.indexOf(it.key);
    setCompare(it, false);
    var left = $('tray-items').querySelectorAll('button');
    if (left.length) left[Math.min(at, left.length - 1)].focus();
    else focusAfterTray(it);
  }
  function focusAfterTray(it) {                        /* the tray is gone: put focus somewhere sensible */
    var box = currentView() === 'table' ? it.ui.rowCheck : it.ui.tagCheck;
    if (box && box.isConnected && !box.closest('[hidden]')) { box.focus(); return; }
    var seg = document.querySelector('.results__bar [aria-pressed="true"]');
    if (seg) seg.focus();
  }

  /* ---------- compare sheet ------------------------------------------------- */
  function textCell(text) { return { key: text, node: text ? document.createTextNode(text) : missing() }; }
  function listNode(values) {
    var ul = el('ul');
    values.forEach(function (v) { ul.appendChild(el('li', '', v)); });
    return ul;
  }
  function weightText(it) {
    if (it.gsm == null) return '';
    return ozText(it) + ' per sq yd, ' + it.gsm + ' gsm' + (it.gsmStated ? '' : ' (converted)');
  }
  function weightClassText(it) {
    if (it.wclass === NONE) return '';
    return WEIGHT_LABEL[it.wclass] + ' for ' + (it.kind === 'fleece' ? 'fleece' : 'jersey');
  }
  function decoText(it) {
    return DECO.filter(function (d) { return it.deco.indexOf(d.key) >= 0; }).map(function (d) { return d.label; }).join(', ');
  }
  function priceBasisNode(it) {
    var text = it.priceText ? it.priceBasis : (it.priceNote || it.priceBasis);
    if (!text && !it.priceSourceUrl) return null;
    var wrap = el('span', '', text);
    if (it.priceText && it.priceSourceUrl) {
      wrap.appendChild(document.createTextNode(text ? ' ' : ''));
      var a = el('a', 'src', (it.priceSource || hostOf(it.priceSourceUrl)) + ' price page');
      a.href = it.priceSourceUrl.href; a.target = '_blank'; a.rel = 'noopener noreferrer';
      a.setAttribute('aria-label', a.textContent + ' for ' + it.title + ' (opens in a new tab)');
      wrap.appendChild(a);
    }
    return wrap;
  }
  function sourcesNode(it) {
    if (!it.sources.length) return null;
    var ul = el('ul');
    it.sources.forEach(function (u) {
      var li = el('li'), a = el('a', 'src', hostOf(u));
      a.href = u.href; a.target = '_blank'; a.rel = 'noopener noreferrer';
      a.setAttribute('aria-label', hostOf(u) + ', source for ' + it.title + ' (opens in a new tab)');
      li.appendChild(a); ul.appendChild(li);
    });
    return ul;
  }
  /* One definition of a blank's facts, used by both the compare sheet and the detail sheet. */
  var FACTS = [
    { label: 'Brand', cell: function (it) { return textCell(it.brand); }, compareOnly: true },
    { label: 'Style', cell: function (it) { return textCell(it.style + (it.aliases.length ? (it.style ? ' ' : '') + '(also ' + it.aliases.join(', ') + ')' : '')); } },
    { label: 'Garment', cell: function (it) { return textCell(it.type ? typeLabel(it.type) : ''); } },
    { label: 'Weight', cell: function (it) { return { key: it.gsm == null ? '' : ozText(it) + '/' + it.gsm, node: it.gsm == null ? missing() : document.createTextNode(weightText(it)) }; } },
    { label: 'Weight class', cell: function (it) { return textCell(weightClassText(it)); } },
    { label: 'Fabric', cell: function (it) { return textCell(it.fabric); } },
    { label: 'Fit', cell: function (it) { return textCell(it.fit); } },
    { label: 'Sizes', cell: function (it) { return textCell(it.sizes); } },
    { label: 'Colours', cell: function (it) { return textCell(it.colors == null ? '' : it.colors + ' listed'); } },
    { label: 'Made in', cell: function (it) { return textCell(it.origin); } },
    { label: 'Approx. price, each', price: true, cell: function (it) { return { key: it.priceText, node: it.priceText ? el('span', 'num', it.priceText) : missing('No price listed') }; } },
    { label: 'Price basis', cell: function (it) { var n = priceBasisNode(it); return { key: n ? n.textContent : '', node: n || missing() }; } },
    { label: 'Good for', cell: function (it) { return textCell(decoText(it)); } },
    { label: 'Features', cell: function (it) { return { key: it.features.join('|'), node: it.features.length ? listNode(it.features) : missing() }; } },
    { label: 'Status', cell: function (it) { return textCell(it.status ? it.status.charAt(0).toUpperCase() + it.status.slice(1) : ''); } },
    { label: 'Note', info: true, cell: function (it) { return { key: it.note, node: it.note ? document.createTextNode(it.note) : missing('No note') }; } },
    { label: 'Sources', info: true, cell: function (it) { return { key: '', node: sourcesNode(it) || missing('No source listed') }; } },
    { label: 'Checked', info: true, cell: function (it) { return { key: it.checked, node: it.checked ? document.createTextNode(it.checked + (it.verified ? '' : ', not verified')) : missing('Date not listed') }; } }
  ];

  function renderCompare() {
    var cols = state.compare.map(function (k) { return byKey[k]; });
    var table = $('compare-table'), thead = table.tHead, tbody = table.tBodies[0];
    setText($('compare-title'), 'Compare ' + cols.length + ' blanks');

    var hr = el('tr'), corner = el('th'); corner.scope = 'col';
    corner.appendChild(el('span', 'visually-hidden', 'Spec')); hr.appendChild(corner);
    cols.forEach(function (it) {
      var th = el('th'); th.scope = 'col';
      var box = el('div', 'compare__col');
      box.appendChild(el('span', 'label', it.brand || 'Brand not listed'));
      box.appendChild(el('strong', '', it.name || it.title));
      var tags = el('span', 'hangtag__tags'); statusTags(it, tags);
      if (tags.childNodes.length) box.appendChild(tags);
      var rm = el('button', 'btn btn--ghost', 'Remove'); rm.type = 'button';
      rm.setAttribute('aria-label', 'Remove ' + it.full + ' from the comparison');
      rm.addEventListener('click', function () {
        setCompare(it, false);
        var next = $('compare').open ? $('compare-table').querySelector('thead button') : null;
        if (next) next.focus();
      });
      box.appendChild(rm); th.appendChild(box); hr.appendChild(th);
    });
    thead.replaceChildren(hr);

    var priced = cols.filter(function (it) { return it.lo != null; });
    var lowest = priced.length >= 2 ? Math.min.apply(null, priced.map(function (it) { return it.lo; })) : null;
    if (lowest != null && priced.every(function (it) { return it.lo === lowest; })) lowest = null;

    var onlyDiff = $('compare-only-diff').checked, differing = 0, comparable = 0, rows = [];
    FACTS.forEach(function (f) {
      var cells = cols.map(function (it) { return f.cell(it); });
      var differs = !f.info && cells.some(function (c) { return c.key !== cells[0].key; });
      if (!f.info) { comparable++; if (differs) differing++; }
      var tr = el('tr', f.info ? '' : (differs ? 'is-diff' : 'is-same'));
      var head = el('td', 'label', f.label);
      if (!f.info) head.appendChild(el('span', 'visually-hidden', differs ? ' (differs)' : ' (same)'));
      tr.appendChild(head);
      cells.forEach(function (c, i) {
        var td = el('td');
        td.appendChild(c.node);
        if (f.price && lowest != null && cols[i].lo === lowest) { td.className = 'best'; td.appendChild(el('span', 'visually-hidden', ' (lowest)')); }
        tr.appendChild(td);
      });
      if (onlyDiff && !f.info && !differs) tr.hidden = true;
      rows.push(tr);
    });
    tbody.replaceChildren.apply(tbody, rows);
    setText($('compare-diff-count'), String(differing));
    setText($('compare-diff-total'), 'of ' + comparable + ' rows differ');
  }
  function openCompare() {
    if (state.compare.length < 2) {
      toast('Tick at least 2 blanks to compare them.', { label: 'Compare' });
      return;
    }
    renderCompare();
    EL.dialog.open('compare');
    state.open = true; scheduleHash();
  }

  /* ---------- detail sheet -------------------------------------------------- */
  function syncDetailToggle() {
    var btn = $('detail-toggle'), on = state.compare.indexOf(detailItem.key) >= 0;
    var full = !on && state.compare.length >= MAX_COMPARE;
    setText(btn, on ? 'Remove from compare' : (full ? 'Comparison is full (' + MAX_COMPARE + ')' : 'Add to compare'));
    btn.setAttribute('aria-disabled', full ? 'true' : 'false');
  }
  function openDetail(it) {
    detailItem = it;
    var body = $('detail-body'), head = el('div', 'detail__head');
    head.appendChild(el('span', 'label', it.brand || 'Brand not listed'));
    head.appendChild(el('h2', 'h2', it.name || it.title));
    var tags = el('div', 'row'); statusTags(it, tags);
    if (tags.childNodes.length) head.appendChild(tags);

    var dl = el('dl', 'facts');
    FACTS.forEach(function (f) {
      if (f.compareOnly) return;
      dl.appendChild(el('dt', 'label', f.label));
      var dd = el('dd'); dd.appendChild(f.cell(it).node); dl.appendChild(dd);
    });
    var note = el('p', 'detail__note', 'The price is a rough range, not a quote. “Good for” and weight class are rules of thumb from fabric and weight.');
    body.replaceChildren(head, dl, note);
    syncDetailToggle();
    EL.dialog.open('detail');
  }

  /* ---------- copy link ------------------------------------------------------ */
  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(function () { return true; }, function () { return legacyCopy(text); });
    }
    return Promise.resolve(legacyCopy(text));
  }
  function legacyCopy(text) {
    var host = document.querySelector('dialog[open]') || document.body, ta = el('textarea', 'visually-hidden');
    ta.value = text; ta.setAttribute('readonly', ''); ta.setAttribute('aria-hidden', 'true'); ta.tabIndex = -1;
    host.appendChild(ta);
    var ok = false, prev = document.activeElement;
    try { ta.select(); ok = document.execCommand('copy'); } catch (e) { ok = false; }
    ta.remove();
    if (prev && prev.focus) prev.focus();
    return ok;
  }
  function copyLink(btn, idle) {
    flushHash();
    copyText(location.href).then(function (ok) {
      /* A toast would sit under an open dialog, so the button itself reports the result. */
      setText(btn, ok ? 'Link copied' : 'Copy it from the address bar');
      setText($('result-status'), ok ? 'Link copied.' : 'Could not copy. The link is in the address bar.');
      clearTimeout(btn._t);
      btn._t = setTimeout(function () { setText(btn, idle); }, 2400);
    });
  }

  /* ---------- phone filter panel --------------------------------------------- */
  function setFilterPanel(open, returnFocus) {
    var panel = $('filters'), btn = $('filters-open');
    if (open && !phone.matches) return;
    panel.classList.toggle('is-open', open);
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    document.documentElement.classList.toggle('is-filters-open', open);
    var behind = document.querySelectorAll('.skip, .site-head, .site-foot, .page-head, .results');
    for (var i = 0; i < behind.length; i++) { if (open) behind[i].setAttribute('inert', ''); else behind[i].removeAttribute('inert'); }
    if (open) $('filters-close').focus();
    else if (returnFocus) btn.focus();
  }

  /* ---------- applying a whole state ----------------------------------------- */
  function applyHash(first) {
    var h = readHash();
    setQuery(h.q); state.max = h.max; state.sort = h.sort; state.view = h.view;
    GROUPS.forEach(function (g) { state[g.key] = h[g.key]; });
    if (h.hasCompare) { state.compare = h.compare; saveSelection(); }   /* a shared link wins over what was stored */
    else if (first) state.compare = loadSelection();
    syncControls(); renderList(); renderSelection();
    if (h.open && state.compare.length >= 2) { if (!$('compare').open) openCompare(); }
    else if ($('compare').open && !first) EL.dialog.close('compare');
  }
  function resetFilters() {
    setQuery(''); state.max = null;
    GROUPS.forEach(function (g) { state[g.key] = []; });
    $('f-max').value = ''; setMaxInvalid(false);
    syncControls(); renderList(); scheduleHash();
  }
  function setMaxInvalid(bad) {
    if (bad) $('f-max-box').setAttribute('aria-invalid', 'true'); else $('f-max-box').removeAttribute('aria-invalid');
    $('f-max').setAttribute('aria-invalid', bad ? 'true' : 'false');
    $('f-max-error').hidden = !bad;                    /* said in words, not only in colour */
  }

  /* ---------- about this data ------------------------------------------------- */
  /* The notes in the data file are written for whoever edits it and use its column names.
     Each known note is matched by how it opens and shown as a plain sentence under a heading.
     A note this list does not know is still shown, with column names put into words. */
  var NOTE_COPY = [
    [/^every value\b/i, 'Source', 'Every value was read from the maker or distributor page linked on its row. “Not listed” means the page did not say. It does not mean zero or none.'],
    [/^prices?\b/i, 'Price', 'Not a quote. A rough per-piece range for standard sizes at one US distributor, before bulk discounts, shipping, tax and decoration. Each blank’s details name the distributor. Prices move often, and 2XL and up cost more.'],
    [/^ozyd\b/i, 'Weight', 'In oz per square yard, as the source states it. Where a source gives no gsm, it is worked out (oz × ' + OZ_TO_GSM + ') and marked as converted. A stated gsm can differ from that by a few grams.'],
    [/^fit\b/i, 'Fit', 'The maker’s or distributor’s own word (Classic, Retail, Relaxed), not a measured scale. Brands use these words differently.'],
    [/^sizes\b/i, 'Sizes, colours', 'What the source listed on the check date. Not every colour comes in every size, distributors may stock fewer sizes, and colour counts change often.'],
    [/^origin\b/i, 'Made in', 'Filled only when a page names a country. “Imported” is not a country.'],
    [/^fabric\b/i, 'Fabric', 'For solid colours. Heathers and specialty colours often use a different blend.'],
    [/^status\b/i, 'Closeout', 'The distributors checked had clearance stock only. Treat the style as being phased out.']
  ];
  var NOTE_WORDS = [
    [/\bsourceUrl\s*\/\s*sources\b|\bsourceUrl\b|\bsources\b/g, 'the source link'], [/\bpriceLow and priceHigh\b/g, 'The low and high price'],
    [/\bpriceLow\b/g, 'the low price'], [/\bpriceHigh\b/g, 'the high price'], [/\bpriceBasis\b/g, 'the price basis'], [/\bpriceSource\b/g, 'the price source'],
    [/\bpriceNote\b/g, 'the price note'], [/\bgsmStated\b/g, 'the stated gsm'], [/\bozyd\b/g, 'the oz weight'], [/\bcheckedOn\b/g, 'the check date'],
    [/\bcolors\b/g, 'colours'], [/\bA null\b/g, '“Not listed”'], [/\bnull\b/g, 'not listed']
  ];
  function plainNote(text) {
    for (var i = 0; i < NOTE_COPY.length; i++) if (NOTE_COPY[i][0].test(text)) return { term: NOTE_COPY[i][1], text: NOTE_COPY[i][2] };
    var t = text.replace(/\b\d{4}-\d{2}-\d{2}\b/g, function (d) { return fmtDate(d) || d; });
    NOTE_WORDS.forEach(function (w) {
      t = t.replace(w[0], function (m, at, all) {          /* a swapped-in word that starts a sentence gets its capital */
        return at === 0 || /[.!?]\s+$/.test(all.slice(0, at)) ? w[1].charAt(0).toUpperCase() + w[1].slice(1) : w[1];
      });
    });
    return { term: 'Note', text: t.charAt(0).toUpperCase() + t.slice(1) };
  }
  function renderAbout(checked) {
    setText($('about-data-lead'), items.length + (items.length === 1 ? ' blank' : ' blanks') + (checked ? ', checked ' + checked : '') + '.');
    var dl = $('about-data-notes'), seen = {}, nodes = [];
    list(DATA.notes).forEach(function (n) {
      var p = plainNote(n);
      if (seen[p.term + '|' + p.text]) return;
      seen[p.term + '|' + p.text] = true;
      nodes.push(el('dt', 'label', p.term), el('dd', '', p.text));
    });
    dl.replaceChildren.apply(dl, nodes);
    dl.hidden = !nodes.length;
  }

  /* ---------- start ----------------------------------------------------------- */
  function fail() {
    $('load-error').hidden = false;
    ['data-notice', 'view-table', 'view-tags', 'tray'].forEach(function (id) { $(id).hidden = true; });
    document.querySelector('.results__bar').hidden = true;
    $('filters').hidden = true; $('filters-open').hidden = true;
  }

  function start() {
    var rows = DATA && Array.isArray(DATA.rows) ? DATA.rows.filter(function (r) { return r && typeof r === 'object'; }) : [];
    if (!rows.length) { fail(); return; }

    rows.forEach(function (row, i) {
      var it = readRow(row, i);
      if (byKey[it.key]) return;                       /* a repeated id is shown once */
      byKey[it.key] = it; items.push(it);
    });
    maxGsm = items.reduce(function (m, it) { return it.gsm != null && it.gsm > m ? it.gsm : m; }, 1);
    items.forEach(function (it) { buildRow(it); buildTag(it); });
    buildOptions();

    /* Data notice */
    var checked = fmtDate(DATA.checkedOn);
    setText($('data-checked'), checked ? 'Checked ' + checked : 'Check date not listed');
    var unverified = items.filter(function (it) { return !it.verified; }).length;
    if (unverified) {
      $('unverified-notice').hidden = false;
      setText($('unverified-text'), (unverified === 1 ? '1 blank has' : unverified + ' blanks have') + ' not been checked against a source page yet. ' +
        (unverified === 1 ? 'It carries' : 'They carry') + ' an Unverified tag: treat every value on ' + (unverified === 1 ? 'it' : 'them') + ' as a placeholder.');
    }
    renderAbout(checked);

    lastShown = items;
    $('rows').replaceChildren.apply($('rows'), rowsOf(items));
    tableFits = measureTable();
    applyHash(true);
    wire();
    flushHash();
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(refit);   /* web fonts change the column widths */
  }

  function wire() {
    var form = $('filters');
    form.addEventListener('submit', function (e) { e.preventDefault(); });
    form.addEventListener('reset', function (e) { e.preventDefault(); resetFilters(); });
    form.addEventListener('keydown', function (e) { if (e.key === 'Escape' && form.classList.contains('is-open')) { e.preventDefault(); setFilterPanel(false, true); } });
    $('f-search').addEventListener('input', function () { setQuery(this.value.slice(0, 80)); renderList(); scheduleHash(); });
    $('f-max').addEventListener('input', function () {
      var raw = this.value.trim(), n = pos(raw);
      /* A number field reports "e" or "-" as an empty value, so ask it whether something unreadable was typed. */
      setMaxInvalid((raw !== '' && n == null) || !!(this.validity && this.validity.badInput));
      state.max = n; renderList(); scheduleHash();
    });
    var folds = form.querySelectorAll('.filters__toggle');
    for (var i = 0; i < folds.length; i++) folds[i].addEventListener('click', function () {
      setFold($(this.getAttribute('aria-controls')), this.getAttribute('aria-expanded') !== 'true');
    });
    $('empty-clear').addEventListener('click', function () {
      resetFilters();
      var seg = document.querySelector('.results__bar [aria-pressed="true"]'); if (seg) seg.focus();
    });

    $('sort').addEventListener('change', function () { if (SORTS[this.value]) { state.sort = this.value; renderList(); scheduleHash(); } });
    var heads = document.querySelectorAll('.blank-table [data-sort-key]');
    for (var h = 0; h < heads.length; h++) heads[h].addEventListener('click', function () {
      var key = this.getAttribute('data-sort-key');
      if (key === 'brand') state.sort = state.sort === 'brand' ? 'brand-desc' : 'brand';
      else state.sort = state.sort === key + '-asc' ? key + '-desc' : key + '-asc';
      $('sort').value = state.sort; renderList(); scheduleHash();
    });
    var segs = document.querySelectorAll('.results__bar [data-view]');
    for (var s = 0; s < segs.length; s++) segs[s].addEventListener('click', function () {
      state.view = this.getAttribute('data-view'); renderList(); scheduleHash();
    });
    var onPhoneChange = function () { if (!phone.matches) setFilterPanel(false, false); tableFits = measureTable(); renderList(); };
    if (phone.addEventListener) phone.addEventListener('change', onPhoneChange); else if (phone.addListener) phone.addListener(onPhoneChange);
    var fitFrame = 0;
    window.addEventListener('resize', function () {
      if (fitFrame) return;
      fitFrame = requestAnimationFrame(function () { fitFrame = 0; refit(); });
    });

    $('filters-open').addEventListener('click', function () { setFilterPanel(true, false); });
    $('filters-close').addEventListener('click', function () { setFilterPanel(false, true); });

    $('tray-open').addEventListener('click', openCompare);
    $('tray-clear').addEventListener('click', function () {
      var last = byKey[state.compare[0]];
      state.compare = []; saveSelection(); renderSelection(); scheduleHash();
      if (last) focusAfterTray(last);
    });
    $('compare-only-diff').addEventListener('change', renderCompare);
    $('compare').addEventListener('close', function () { state.open = false; scheduleHash(); });
    $('detail').addEventListener('close', function () { detailItem = null; });
    $('detail-toggle').addEventListener('click', function () {
      if (!detailItem || this.getAttribute('aria-disabled') === 'true') return;
      setCompare(detailItem, state.compare.indexOf(detailItem.key) < 0);
    });
    $('copy-link').addEventListener('click', function () { copyLink(this, 'Copy link'); });
    $('compare-copy').addEventListener('click', function () { copyLink(this, 'Copy link'); });

    window.addEventListener('hashchange', function () { clearTimeout(hashTimer); applyHash(false); });

    /* BASE-CANDIDATE (js/site.js): a click on the backdrop closes a dialog, so the second click of a
       double click on "Compare side by side" closed the sheet it had just opened. */
    document.addEventListener('click', function (e) {
      if (e.detail > 1 && e.target instanceof Element && e.target.matches('dialog.dialog')) e.stopPropagation();
    }, true);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
