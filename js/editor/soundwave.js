/* ==========================================================================
   EMBROIDERY LABS - js/editor/soundwave.js
   Sound wave: a song or a sound becomes an embroidery design.

   Up to 10 seconds of audio are read in the browser (Web Audio, nothing is
   uploaded) and drawn as a waveform:
     - one wave, stretched to any width and height, or
     - a big square of 4 or 5 rows, one per "stem". With one file the rows are
       frequency bands (bass, low mids, vocals, highs, hats): close to stems, not
       a true separation. With several files (stems exported from a DAW) each
       file is its own row.
   Styles: Filled (one fill per row, sews with no trims), Line (one continuous
   triple-stitch line per row) and Bars (a satin column per bar).
   The result opens as a design in its own tab, or downloads as an SVG.

   Creates Editor.SoundWave. The geometry half (envelope, shapes, svg) has no
   DOM and also loads in node (module.exports) for the tests.
   ========================================================================== */
(function (root) {
  'use strict';

  var WINDOW_S = 10;                       /* seconds of audio used */
  var BAR_PITCH = 2;                       /* mm from one bar to the next */
  var MAX_FILES = 5, MAX_FILE_BYTES = 200 * 1024 * 1024;
  var COLORS = ['#2F4858', '#33658A', '#5FA8A0', '#E0A526', '#D9644A'];
  /* frequency bands for a single file: [name, low Hz, high Hz] (0 = open) */
  var BANDS = {
    4: [['Bass', 0, 150], ['Body', 150, 800], ['Vocals and leads', 800, 4000], ['Hats', 4000, 0]],
    5: [['Bass', 0, 150], ['Low mids', 150, 500], ['Vocals', 500, 2000], ['Leads', 2000, 6000], ['Hats', 6000, 0]]
  };

  function r2(v) { return Math.round(v * 100) / 100; }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

  /* ---------- geometry (no DOM) ------------------------------------------------ */

  /* samples (Float32Array, mono) -> n bar heights 0..1. RMS per bar, gently compressed so quiet
     parts still read, scaled so the loud end (98th percentile) reaches 1. */
  function envelope(samples, n) {
    var out = new Array(n), len = samples.length, i, j;
    for (i = 0; i < n; i++) {
      var a = Math.floor(i * len / n), b = Math.max(a + 1, Math.floor((i + 1) * len / n)), s = 0;
      for (j = a; j < b && j < len; j++) s += samples[j] * samples[j];
      out[i] = Math.pow(Math.sqrt(s / Math.max(1, b - a)), 0.7);
    }
    var sorted = out.slice().sort(function (x, y) { return x - y; });
    var top = sorted[Math.min(n - 1, Math.floor(n * 0.98))] || 0;
    for (i = 0; i < n; i++) out[i] = top > 1e-6 ? clamp(out[i] / top, 0, 1) : 0;
    return out;
  }
  function smooth(v) {
    return v.map(function (x, i) { return (v[Math.max(0, i - 1)] + 2 * x + v[Math.min(v.length - 1, i + 1)]) / 4; });
  }

  /* rows: [{ name, color, env: [0..1] }]; box: { x, y, w, h } in mm; style: 'fill' | 'line' | 'bars'.
     Returns model objects (hoop coordinates, mm). */
  function shapes(rows, box, style) {
    var objs = [], R = rows.length, gap = R > 1 ? Math.min(6, box.h * 0.04) : 0;
    var rowH = (box.h - gap * (R - 1)) / R;
    rows.forEach(function (row, ri) {
      var env = row.env, n = env.length, cy = box.y + ri * (rowH + gap) + rowH / 2, amp = rowH / 2;
      var x = function (i) { return box.x + (n > 1 ? i * box.w / (n - 1) : box.w / 2); };
      var base = { name: row.name, color: row.color, spacing: 0.4, stitchLen: 2.5, angle: 90, pattern: 'smooth' };
      var o, i;
      if (style === 'fill') {
        var e = smooth(env), top = [], bot = [];
        for (i = 0; i < n; i++) {
          var a = Math.max(0.7, e[i] * amp);
          top.push([r2(x(i)), r2(cy - a)]); bot.push([r2(x(i)), r2(cy + a)]);
        }
        o = Object.assign({ type: 'pen', closed: true, pts: top.concat(bot.reverse()), paint: 'fill', lineType: 'running', lineWidth: 2 }, base);
        objs.push(o);
      } else if (style === 'line') {
        /* down one bar, along the edge, up the next: one continuous line, no trims */
        var pts = [];
        for (i = 0; i < n; i++) {
          var h = Math.max(0.3, env[i] * amp), up = [r2(x(i)), r2(cy - h)], dn = [r2(x(i)), r2(cy + h)];
          if (i % 2) pts.push(dn, up); else pts.push(up, dn);
        }
        objs.push(Object.assign({ type: 'pen', closed: false, pts: pts, paint: 'line', lineType: 'bean', lineWidth: 2 }, base));
      } else {
        var wid = clamp((n > 1 ? box.w / (n - 1) : BAR_PITCH) * 0.6, 1, 4);
        for (i = 0; i < n; i++) {
          var hb = Math.max(0.6, env[i] * amp);
          objs.push(Object.assign({}, base, { name: row.name + ' ' + (i + 1), type: 'pen', closed: false, pts: [[r2(x(i)), r2(cy - hb)], [r2(x(i)), r2(cy + hb)]], paint: 'line', lineType: 'satin', lineWidth: r2(wid), spacing: 0.4 }));
        }
      }
    });
    objs.forEach(function (o, k) { o.id = 'w' + (k + 1); });
    return objs;
  }

  /* model objects -> SVG text, sized in mm, the area { w, h } at 0,0 */
  function svg(objs, w, h, bg) {
    var out = ['<svg xmlns="http://www.w3.org/2000/svg" width="' + r2(w) + 'mm" height="' + r2(h) + 'mm" viewBox="0 0 ' + r2(w) + ' ' + r2(h) + '">'];
    if (bg) out.push('<rect width="100%" height="100%" fill="' + bg + '"/>');
    objs.forEach(function (o) {
      var d = o.pts.map(function (p) { return p[0] + ',' + p[1]; }).join(' ');
      if (o.paint === 'fill') out.push('<polygon points="' + d + '" fill="' + o.color + '"/>');
      else out.push('<polyline points="' + d + '" fill="none" stroke="' + o.color + '" stroke-width="' + (o.lineType === 'satin' ? o.lineWidth : 0.6) + '" stroke-linejoin="round" stroke-linecap="' + (o.lineType === 'satin' ? 'butt' : 'round') + '"/>');
    });
    out.push('</svg>');
    return out.join('');
  }

  /* the smallest standard hoop with 10 mm to spare, else a custom one */
  function hoopFor(w, h, hoops) {
    for (var i = 0; i < hoops.length; i++) if (w + 10 <= hoops[i][0] && h + 10 <= hoops[i][1]) return { w: hoops[i][0], h: hoops[i][1] };
    return { w: Math.ceil((w + 20) / 10) * 10, h: Math.ceil((h + 20) / 10) * 10 };
  }

  var API = { WINDOW_S: WINDOW_S, BAR_PITCH: BAR_PITCH, BANDS: BANDS, COLORS: COLORS, envelope: envelope, shapes: shapes, svg: svg, hoopFor: hoopFor };
  if (typeof module !== 'undefined' && module.exports) { module.exports = API; return; }

  /* ---------- audio (browser) ----------------------------------------------- */
  var Editor = root.Editor = root.Editor || {};
  Editor.SoundWave = API;
  var actx = null;
  function ctx() { if (!actx) { var C = root.AudioContext || root.webkitAudioContext; actx = C ? new C() : null; } return actx; }

  function decode(file) {
    return new Promise(function (resolve, reject) {
      if (file.size > MAX_FILE_BYTES) { reject(new Error('too large')); return; }
      var reader = new FileReader();
      reader.onerror = function () { reject(new Error('unreadable')); };
      reader.onload = function () {
        var c = ctx(); if (!c) { reject(new Error('no audio')); return; }
        var done = false;
        var p = c.decodeAudioData(reader.result, function (b) { if (!done) { done = true; resolve(b); } }, function () { if (!done) { done = true; reject(new Error('not audio')); } });
        if (p && p.then) p.then(function (b) { if (!done) { done = true; resolve(b); } }, function () { if (!done) { done = true; reject(new Error('not audio')); } });
      };
      reader.readAsArrayBuffer(file);
    });
  }
  /* mono mix of the window [start, start + 10 s) */
  function mono(buf, start) {
    var sr = buf.sampleRate, a = Math.floor(clamp(start, 0, buf.duration) * sr);
    var len = Math.max(1, Math.min(buf.length - a, Math.floor(WINDOW_S * sr))), out = new Float32Array(len), c, i;
    for (c = 0; c < buf.numberOfChannels; c++) {
      var d = buf.getChannelData(c);
      for (i = 0; i < len; i++) out[i] += d[a + i] / buf.numberOfChannels;
    }
    return out;
  }
  /* one band of the window, through two cascaded filters per edge (24 dB/oct) */
  function band(samples, sr, lo, hi) {
    var OAC = root.OfflineAudioContext || root.webkitOfflineAudioContext;
    var oc = new OAC(1, samples.length, sr), src = oc.createBufferSource(), b = oc.createBuffer(1, samples.length, sr);
    b.getChannelData(0).set(samples); src.buffer = b;
    var node = src;
    function add(type, f) { var q = oc.createBiquadFilter(); q.type = type; q.frequency.value = f; q.Q.value = 0.707; node.connect(q); node = q; }
    if (lo) { add('highpass', lo); add('highpass', lo); }
    if (hi) { add('lowpass', hi); add('lowpass', hi); }
    node.connect(oc.destination); src.start();
    return oc.startRendering().then(function (r) { return r.getChannelData(0); });
  }

  /* ---------- dialog -------------------------------------------------------- */
  function $(id) { return document.getElementById(id); }
  function toast(msg, opts) { if (root.EL) root.EL.toast(msg, opts); }
  var st = { files: [], buffers: [], start: 0, layout: 'stems', rows: 5, style: 'fill', width: 180, height: 60, size: 180, signals: null, job: 0 };
  var el = {};

  function multi() { return st.buffers.length > 1; }
  function duration() { return st.buffers.reduce(function (m, b) { return Math.max(m, b.duration); }, 0); }
  function baseName() { return String(st.files[0] && st.files[0].name || 'sound').replace(/\.[^.]+$/, '').slice(0, 40) || 'sound'; }

  /* the audio signals for the current start: [{ name, samples }] */
  function compute() {
    var job = ++st.job;
    el.status.textContent = 'Reading the sound…';
    var p;
    if (multi()) {
      p = Promise.resolve(st.buffers.map(function (b, i) { return { name: String(st.files[i].name).replace(/\.[^.]+$/, '').slice(0, 40), samples: mono(b, st.start) }; }));
    } else {
      var b = st.buffers[0], m = mono(b, st.start);
      var bands = BANDS[st.rows];
      p = Promise.all(bands.map(function (bd) { return band(m, b.sampleRate, bd[1], bd[2]); })).then(function (list) {
        return [{ name: 'Whole song', samples: m, whole: true }].concat(list.map(function (s, i) { return { name: bands[i][0], samples: s }; }));
      });
    }
    return p.then(function (sig) { if (job !== st.job) return; st.signals = sig; st.signalRows = st.rows; el.status.textContent = ''; render(); })
      .catch(function () { if (job === st.job) el.status.textContent = 'This sound could not be split in this browser.'; });
  }

  /* current design: { objs, w, h } in a 0,0 frame */
  function build() {
    if (!st.signals) return null;
    var stems = st.layout === 'stems', rows, w, h;
    if (stems) {
      var sig = st.signals.filter(function (s) { return !s.whole; });
      w = h = st.size;
      var n = Math.max(8, Math.round(w / BAR_PITCH));
      rows = sig.map(function (s, i) { return { name: s.name, color: COLORS[i % COLORS.length], env: envelope(s.samples, n) }; });
    } else {
      var whole = st.signals[0].whole ? st.signals[0].samples : mix(st.signals);
      w = st.width; h = st.height;
      rows = [{ name: 'Sound wave', color: COLORS[1], env: envelope(whole, Math.max(8, Math.round(w / BAR_PITCH))) }];
    }
    return { objs: shapes(rows, { x: 0, y: 0, w: w, h: h }, st.style), w: w, h: h };
  }
  function mix(sig) {
    var len = sig.reduce(function (m, s) { return Math.max(m, s.samples.length); }, 0), out = new Float32Array(len);
    sig.forEach(function (s) { for (var i = 0; i < s.samples.length; i++) out[i] += s.samples[i]; });
    return out;
  }

  function fmtTime(s) { var m = Math.floor(s / 60), r = Math.floor(s % 60); return m + ':' + (r < 10 ? '0' : '') + r; }
  function render() {
    var stems = st.layout === 'stems';
    el.controls.hidden = !st.buffers.length;
    el.pick.textContent = st.files.length ? (st.files.length === 1 ? st.files[0].name : st.files.length + ' stem files') + ' (pick again)' : 'Pick a song or sound, or drop it here';
    pressed(el.layout, st.layout); pressed(el.rows, String(st.rows)); pressed(el.style, st.style);
    el.rowsProp.hidden = !stems || multi();
    el.sizeProp.hidden = !stems; el.widthProp.hidden = stems; el.heightProp.hidden = stems;
    var dur = duration(), max = Math.max(0, Math.floor((dur - WINDOW_S) * 2) / 2);
    el.start.max = String(max); el.start.disabled = max <= 0;
    el.startVal.textContent = fmtTime(st.start) + ' – ' + fmtTime(Math.min(dur, st.start + WINDOW_S));
    var U = Editor.Units;
    el.sizeVal.textContent = U ? U.text(st.size) : st.size + ' mm';
    el.widthVal.textContent = U ? U.text(st.width) : st.width + ' mm';
    el.heightVal.textContent = U ? U.text(st.height) : st.height + ' mm';
    [el.start, el.size, el.width, el.height].forEach(function (s) { if (root.EL) root.EL.syncSlider(s); });
    var d = build();
    el.preview.innerHTML = d ? svg(d.objs, d.w, d.h) : '';
    el.make.disabled = el.svg.disabled = !d;
    if (d) {
      var hp = hoopFor(d.w, d.h, Editor.Model ? Editor.Model.HOOPS : [[200, 200]]);
      el.note.textContent = d.objs.length + (d.objs.length === 1 ? ' shape' : ' shapes') + ', ' + (U ? U.sizeShort(d.w, d.h) + ' ' + U.label() : r2(d.w) + ' x ' + r2(d.h) + ' mm') + ', fits the ' + (U ? U.sizeShort(hp.w, hp.h) + ' ' + U.label() : hp.w + ' x ' + hp.h + ' mm') + ' hoop.' + (st.style === 'bars' ? ' Bars need a trim between each one.' : '');
    }
  }
  function pressed(group, v) { Array.prototype.forEach.call(group.querySelectorAll('button'), function (b) { b.setAttribute('aria-pressed', b.getAttribute('data-v') === v ? 'true' : 'false'); }); }

  function load(fileList) {
    var files = Array.prototype.slice.call(fileList || []).filter(Boolean);
    if (!files.length) return;
    if (files.length > MAX_FILES) { toast('Up to ' + MAX_FILES + ' stem files; the first ' + MAX_FILES + ' are used.', { label: 'Sound wave' }); files = files.slice(0, MAX_FILES); }
    el.status.textContent = 'Opening ' + (files.length === 1 ? files[0].name : files.length + ' files') + '…';
    Promise.all(files.map(decode)).then(function (bufs) {
      st.files = files; st.buffers = bufs; st.start = 0; el.start.value = '0'; st.signals = null;
      if (bufs.length > 1) st.layout = 'stems';
      render(); return compute();
    }).catch(function (e) {
      el.status.textContent = '';
      toast(e && e.message === 'too large' ? 'That file is too large.' : 'That file could not be read as sound. Try an MP3, WAV, M4A or OGG.', { kind: 'bad', label: 'Sound wave' });
    });
  }

  function makeDesign() {
    var d = build(); if (!d) return;
    var M = Editor.Model, IO = Editor.IO, hoop = hoopFor(d.w, d.h, M.HOOPS);
    var dx = (hoop.w - d.w) / 2, dy = (hoop.h - d.h) / 2;
    d.objs.forEach(function (o) { o.pts = o.pts.map(function (p) { return [r2(p[0] + dx), r2(p[1] + dy)]; }); });
    if (Editor.Mockup && Editor.Mockup.isOpen()) Editor.Mockup.close();
    if (Editor.Tabs && M.doc.objects.length && !Editor.Tabs.add(null, true)) return;
    if (!Editor.Tabs && M.doc.objects.length) return;
    IO.applyPayload({ doc: { name: baseName() + ' wave', hoop: hoop, objects: d.objs } });
    if (Editor.View) { if (Editor.View.mode !== 'design') Editor.View.setMode('design'); Editor.View.fit(); }
    IO.saveNow();
    root.EL.dialog.close('sound');
    toast('Sound wave added: ' + d.objs.length + (d.objs.length === 1 ? ' shape' : ' shapes') + '. Every row can be recoloured or resized like any shape.', { kind: 'ok', label: 'Sound wave', timeout: 7000 });
    if (Editor.say) Editor.say('Sound wave design opened');
  }
  function downloadSvg() {
    var d = build(); if (!d) return;
    root.EL.download(baseName() + '-wave.svg', svg(d.objs, d.w, d.h), 'image/svg+xml');
  }

  function seg(group, fn) {
    group.addEventListener('click', function (e) { var b = e.target.closest('button[data-v]'); if (b) fn(b.getAttribute('data-v')); });
  }
  var later = 0;
  function init() {
    var dlg = $('sound'); if (!dlg) return;
    ['pick', 'input', 'controls', 'preview', 'status', 'start', 'startVal', 'layout', 'rows', 'rowsProp', 'style', 'size', 'sizeVal', 'sizeProp', 'width', 'widthVal', 'widthProp', 'height', 'heightVal', 'heightProp', 'note', 'make', 'svg'].forEach(function (k) {
      el[k] = $('sound-' + k.replace(/[A-Z]/g, function (c) { return '-' + c.toLowerCase(); }));
    });
    el.pick.addEventListener('click', function () { el.input.click(); });
    el.input.addEventListener('change', function () { var f = el.input.files; load(f); el.input.value = ''; });
    ['dragover', 'drop'].forEach(function (t) {
      el.pick.addEventListener(t, function (e) { e.preventDefault(); e.stopPropagation(); if (t === 'drop') load(e.dataTransfer.files); });
    });
    el.start.addEventListener('input', function () {
      st.start = Number(el.start.value) || 0; render();
      clearTimeout(later); later = setTimeout(compute, 180);
    });
    [['size', 'size'], ['width', 'width'], ['height', 'height']].forEach(function (p) {
      el[p[0]].addEventListener('input', function () { st[p[1]] = Number(el[p[0]].value); render(); });
    });
    seg(el.layout, function (v) { st.layout = v; render(); });
    seg(el.style, function (v) { st.style = v; render(); });
    seg(el.rows, function (v) { st.rows = Number(v); compute(); });
    el.make.addEventListener('click', makeDesign);
    el.svg.addEventListener('click', downloadSvg);
    Editor.on && Editor.on('units', function () { if (st.buffers.length) render(); });
    render();
  }
  API.open = function () { if (!$('sound')) return; root.EL.dialog.open('sound'); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})(typeof window !== 'undefined' ? window : this);
