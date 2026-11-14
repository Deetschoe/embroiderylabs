#!/usr/bin/env node
/*
 * SVG import clean-up (js/editor/svgimport.js) in a real browser.   node tests/editor/svgimport.test.js
 *
 * Opens app.html from file:// in headless Chrome (driven over a pipe, no port, no server) and checks:
 *   - a traced line drawing (fixtures/lineart-eyes.svg) becomes ONE object, no background, no stray pens,
 *     the 'lineart' stitch style, parsed in under 100 ms
 *   - a stacked trace (white islands painted on black) becomes one black compound with its holes
 *   - a multi-colour logo keeps its colours and paint order; text outlines keep their counters as holes
 *   - keepBackground brings the background back; the toast's "Keep background" does it in the app
 *   - colours: a 25-colour file lands on at most 10 threads (a small, clearly different accent survives),
 *     one object per thread, opts.maxColors 2..30
 * Set CHROME=/path/to/chrome if Chrome is not in the usual place; without Chrome the run is SKIPPED, loudly.
 */
'use strict';
var cp = require('child_process'), fs = require('fs'), os = require('os'), path = require('path');
var ROOT = path.resolve(__dirname, '..', '..'), FIX = path.join(__dirname, 'fixtures');
var CANDIDATES = [process.env.CHROME, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean);

var passed = 0, failed = 0, failures = [], current = '', queue = [];
function test(name, fn) { queue.push({ name: name, fn: fn }); }
function show(v) { try { var s = JSON.stringify(v); return s === undefined ? String(v) : s.length > 200 ? s.slice(0, 200) + '...' : s; } catch (e) { return String(v); } }
function check(ok, msg) { if (ok) passed++; else { failed++; failures.push(current + ': ' + msg); } }
var t = {
  ok: function (v, msg) { check(!!v, msg || 'expected a true value'); },
  equal: function (a, b, msg) { check(a === b, (msg ? msg + ': ' : '') + 'got ' + show(a) + ', expected ' + show(b)); },
  deepEqual: function (a, b, msg) { check(JSON.stringify(a) === JSON.stringify(b), (msg ? msg + ': ' : '') + 'got ' + show(a) + ', expected ' + show(b)); }
};

function launch(chrome) {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'svgimport-test-'));
  var child = cp.spawn(chrome, ['--headless=new', '--remote-debugging-pipe', '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars', '--mute-audio',
    '--user-data-dir=' + dir, '--window-size=1440,900', '--force-device-scale-factor=1'], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
  var out = child.stdio[3], inp = child.stdio[4], buf = Buffer.alloc(0), nextId = 1, waiting = {}, listeners = [], dead = null;
  child.on('error', function (e) { dead = e; Object.keys(waiting).forEach(function (k) { waiting[k].reject(e); }); });
  inp.on('data', function (d) {
    buf = Buffer.concat([buf, d]); var i, msg, w;
    while ((i = buf.indexOf(0)) >= 0) {
      msg = JSON.parse(buf.slice(0, i).toString('utf8')); buf = buf.slice(i + 1);
      if (msg.id && waiting[msg.id]) { w = waiting[msg.id]; delete waiting[msg.id]; if (msg.error) w.reject(new Error(msg.error.message)); else w.resolve(msg.result); }
      else listeners.forEach(function (f) { f(msg); });
    }
  });
  function send(method, params, sessionId) {
    return new Promise(function (resolve, reject) {
      if (dead) return reject(dead);
      var id = nextId++, m = { id: id, method: method, params: params || {} }; if (sessionId) m.sessionId = sessionId;
      waiting[id] = { resolve: resolve, reject: reject }; out.write(JSON.stringify(m) + '\0');
    });
  }
  return {
    open: async function (url) {
      var tg = await send('Target.createTarget', { url: 'about:blank' }), a = await send('Target.attachToTarget', { targetId: tg.targetId, flatten: true }), sid = a.sessionId;
      var errors = [], loaded, onLoad = new Promise(function (r) { loaded = r; });
      listeners.push(function (m) {
        if (m.sessionId !== sid) return;
        if (m.method === 'Runtime.exceptionThrown') errors.push('exception: ' + (m.params.exceptionDetails.exception && m.params.exceptionDetails.exception.description || m.params.exceptionDetails.text));
        else if (m.method === 'Runtime.consoleAPICalled' && /^(error|warning|assert)$/.test(m.params.type)) errors.push('console.' + m.params.type + ': ' + m.params.args.map(function (x) { return x.value !== undefined ? String(x.value) : (x.description || x.type); }).join(' '));
        else if (m.method === 'Log.entryAdded' && /^(error|warning)$/.test(m.params.entry.level)) errors.push('log.' + m.params.entry.level + ': ' + m.params.entry.text + ' ' + (m.params.entry.url || ''));
        else if (m.method === 'Page.loadEventFired') loaded();
      });
      await send('Page.enable', {}, sid); await send('Runtime.enable', {}, sid); await send('Log.enable', {}, sid);
      await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, sid);
      await send('Page.navigate', { url: url }, sid); await onLoad;
      return {
        errors: errors,
        eval: async function (expr) {
          var r = await send('Runtime.evaluate', { expression: '(async function () { ' + expr + ' })()', awaitPromise: true, returnByValue: true }, sid);
          if (r.exceptionDetails) throw new Error('in the page: ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
          return r.result.value;
        },
        click: async function (x, y) {
          var base = { x: x, y: y, button: 'left', clickCount: 1, pointerType: 'mouse' };
          await send('Input.dispatchMouseEvent', Object.assign({ type: 'mouseMoved', buttons: 0 }, base, { button: 'none' }), sid);
          await send('Input.dispatchMouseEvent', Object.assign({ type: 'mousePressed', buttons: 1 }, base), sid);
          await send('Input.dispatchMouseEvent', Object.assign({ type: 'mouseReleased', buttons: 0 }, base), sid);
        }
      };
    },
    close: async function () {
      try { await Promise.race([send('Browser.close'), new Promise(function (r) { setTimeout(r, 2000); })]); } catch (e) { /* already gone */ }
      await new Promise(function (r) { setTimeout(r, 200); }); try { child.kill(); } catch (e) { /* already gone */ }
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* leave it */ }
    }
  };
}
function fixture(name) { return fs.readFileSync(path.join(FIX, name), 'utf8'); }
function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

/* in the page: parse with the default 130 x 180 hoop and describe the result in plain data */
var PAGE_HELPERS = [
  'window.__T = {',
  '  parse: function (text, opts) {',
  '    var t0 = performance.now(), res = Editor.SvgImport.parse(text, { w: 130, h: 180 }, opts), ms = performance.now() - t0;',
  '    return { ok: res.ok, error: res.error, ms: ms, report: res.report, list: res.list,',
  '      objs: res.list.map(function (o) { return { type: o.geom.type, color: o.style.color, paint: o.style.paint, fillStyle: o.style.fillStyle || null,',
  '        rings: o.geom.rings ? o.geom.rings.length : 1, rule: o.geom.fillRule || null }; }) };',
  '  },',
  '  winding: function (geom, x, y) {',
  '    var rings = geom.rings || [geom.pts], w = 0, c = 0;',
  '    rings.forEach(function (r) {',
  '      var inside = false;',
  '      for (var i = 0, j = r.length - 1; i < r.length; j = i++) {',
  '        var a = r[j], b = r[i];',
  '        if ((a[1] > y) !== (b[1] > y)) { var xi = a[0] + (y - a[1]) * (b[0] - a[0]) / (b[1] - a[1]); if (x < xi) { inside = !inside; w += b[1] > a[1] ? 1 : -1; } }',
  '      }',
  '      if (inside) c++;',
  '    });',
  '    return geom.fillRule === "evenodd" ? (c & 1) : (w !== 0 ? 1 : 0);',
  '  }',
  '};',
  'return 1;'
].join('\n');

module.exports = function () {
  var chrome = CANDIDATES.filter(function (c) { try { return fs.existsSync(c); } catch (e) { return false; } })[0];
  if (!chrome) return 'no Chrome found; set CHROME=/path/to/chrome';
  var browser = null, page = null;
  async function parse(name, opts) { return page.eval('return __T.parse(' + JSON.stringify(fixture(name)) + ', ' + JSON.stringify(opts || {}) + ');'); }

  test('the editor loads from file:// with a clean console', async function () {
    browser = launch(chrome); page = await browser.open('file://' + path.join(ROOT, 'app.html'));
    await wait(800);
    t.equal(await page.eval('return typeof (Editor && Editor.SvgImport && Editor.SvgImport.parse);'), 'function', 'Editor.SvgImport.parse');
    await page.eval(PAGE_HELPERS);
    t.equal(page.errors.length, 0, 'console: ' + page.errors.join(' | '));
  });

  test('the traced line drawing becomes one line-art object with no background and no stray pens', async function () {
    var r = await parse('lineart-eyes.svg');
    t.ok(r.ok, r.error);
    t.equal(r.objs.length, 1, 'objects');
    t.equal(r.objs.filter(function (o) { return o.type === 'pen' || o.type === 'line' || o.paint === 'line'; }).length, 0, 'pen / line objects');
    t.equal(r.objs[0].fillStyle, 'lineart', 'stitch style');
    t.equal(r.objs[0].paint, 'fill', 'paint');
    t.ok(r.objs[0].rings > 100, 'one compound holding the whole drawing: ' + r.objs[0].rings + ' rings');
    t.equal(r.report.hygiene.background, 1, 'report.hygiene.background');
    t.equal(r.report.hygiene.backgroundColor, '#FBFBFB', 'the background colour');
    t.ok(r.report.hygiene.hairlines >= 1, 'the anti-gap hairline stroke is dropped');
    t.ok(r.report.hygiene.degenerate > 50, 'degenerate subpaths are dropped: ' + r.report.hygiene.degenerate);
    t.ok(r.report.hygiene.specks > 0 && r.report.hygiene.pinholes > 0, 'specks and pinholes are counted');
    t.deepEqual([r.report.colors.before, r.report.colors.after], [1, 1], 'colours before / after');
    t.ok(r.report.fitted && Math.abs(r.report.height - 144) < 0.5, 'fitted by the artwork (without the background): ' + r.report.width.toFixed(1) + ' x ' + r.report.height.toFixed(1) + ' mm');
    var best = r.ms;
    for (var i = 0; i < 3; i++) best = Math.min(best, (await parse('lineart-eyes.svg')).ms);
    t.ok(best < 100, 'parse time ' + best.toFixed(1) + ' ms');
  });

  test('the same file twice gives the same objects (deterministic)', async function () {
    var a = await parse('lineart-eyes.svg'), b = await parse('lineart-eyes.svg');
    t.ok(JSON.stringify(a.list) === JSON.stringify(b.list), 'identical lists');
  });

  test('keepBackground keeps the background as an object', async function () {
    var r = await parse('lineart-eyes.svg', { keepBackground: true });
    t.equal(r.report.hygiene.background, 0, 'nothing taken for fabric');
    t.equal(r.objs.length, 2, 'objects');
    t.ok(r.objs.some(function (o) { return o.color === '#FBFBFB' && o.paint === 'fill'; }), 'the light background fill is back');
    t.equal(r.objs.filter(function (o) { return o.paint === 'line'; }).length, 0, 'still no stray pens');
  });

  test('a stacked trace becomes one black compound with its holes', async function () {
    var r = await parse('stacked.svg');
    t.equal(r.objs.length, 1, 'objects');
    t.equal(r.objs[0].color, '#000000', 'colour');
    t.equal(r.objs[0].rings, 5, 'rings');
    t.equal(r.report.hygiene.stackedHoles, 1, 'stacked holes');
    t.equal(r.report.hygiene.background, 2, 'the canvas and the white island layer are fabric');
    /* file px -> mm: artwork 10..350 px fitted to 104 mm wide, centred in 130 x 180 */
    var k = r.report.width / 340, mm = function (x, y) { return [65 + (x - 180) * k, 90 + (y - 180) * k]; };
    var probes = [[75, 75, 1], [200, 120, 0], [200, 200, 1], [20, 11, 1], [220, 30, 1], [375, 375, 0]];
    for (var i = 0; i < probes.length; i++) {
      var p = mm(probes[i][0], probes[i][1]);
      t.equal(await page.eval('return __T.winding(' + JSON.stringify(r.list[0].geom) + ', ' + p[0] + ', ' + p[1] + ');'), probes[i][2], 'filled at file point ' + probes[i][0] + ',' + probes[i][1]);
    }
  });

  test('a multi-colour logo keeps its colours, its paint order and the plain fill', async function () {
    var r = await parse('logo-multicolour.svg');
    t.deepEqual(r.objs.map(function (o) { return o.color; }), ['#1D3A6E', '#E8B21C', '#1D3A6E', '#C62828', '#2E7D32'], 'colours in sewing order');
    t.deepEqual([r.report.colors.before, r.report.colors.after], [4, 4], 'colours before / after');
    t.equal(r.objs[2].rings, 2, 'the blue square over the gold circle is not pulled under it; the far blue bar joins it');
    t.equal(r.objs.filter(function (o) { return o.fillStyle; }).length, 0, 'no line art');
    t.equal(r.report.hygiene.background, 0, 'no background');
  });

  test('text outlines keep their letter counters as holes', async function () {
    var r = await parse('text-outlines.svg');
    t.equal(r.objs.length, 1, 'one object for the one colour');
    t.equal(r.objs[0].rings, 7, 'rings: O 2, A 2, B 3');
    t.equal(r.objs[0].fillStyle, null, 'plain fill, not line art');
    var k = r.report.width / 336, mm = function (x, y) { return [65 + (x - 178) * k, 90 + (y - 60) * k]; };
    var probes = [[60, 60, 0], [21, 60, 1], [170, 60, 0], [140, 100, 1], [290, 40, 0], [290, 81, 0], [250, 60, 1], [330, 85, 1]];
    for (var i = 0; i < probes.length; i++) {
      var p = mm(probes[i][0], probes[i][1]);
      t.equal(await page.eval('return __T.winding(' + JSON.stringify(r.list[0].geom) + ', ' + p[0] + ', ' + p[1] + ');'), probes[i][2], (probes[i][2] ? 'thread' : 'a counter') + ' at file point ' + probes[i][0] + ',' + probes[i][1]);
    }
  });

  test('25 colours land on at most 10 threads, one object each, the small accent kept', async function () {
    var r = await parse('many-colours.svg');
    t.equal(r.report.colors.before, 25, 'colours before');
    t.ok(r.report.colors.after <= 10 && r.report.colors.after >= 8, 'threads after: ' + r.report.colors.after);
    t.equal(r.report.colors.max, 10, 'the automatic cap');
    var cols = r.objs.map(function (o) { return o.color; });
    t.equal(new Set(cols).size, cols.length, 'every thread is one object: ' + cols.join(' '));
    t.ok(cols.indexOf('#F5D020') >= 0, 'the small yellow accent keeps its own thread');
    var hue = function (hex) { var n = parseInt(hex.slice(1), 16), r2 = n >> 16, g = (n >> 8) & 255, b = n & 255; return r2 > g && r2 > b ? 'r' : g > r2 && g > b ? 'g' : b > r2 && b > g ? 'b' : 'grey'; };
    ['r', 'g', 'b', 'grey'].forEach(function (h) { t.ok(cols.some(function (c) { return hue(c) === h || (h === 'grey' && Math.max.apply(null, [1, 3, 5].map(function (i) { return parseInt(c.substr(i, 2), 16); })) - Math.min.apply(null, [1, 3, 5].map(function (i) { return parseInt(c.substr(i, 2), 16); })) < 12); }), 'the ' + h + ' family keeps a thread'); });
    var distinct = true;
    for (var i = 0; i < cols.length; i++) for (var j = i + 1; j < cols.length; j++) if (await page.eval('return Editor.SvgImport.deltaE(' + JSON.stringify(cols[i]) + ', ' + JSON.stringify(cols[j]) + ');') < 4) distinct = false;
    t.ok(distinct, 'no two threads left are near-identical');
  });

  test('opts.maxColors sets the cap (2..30)', async function () {
    var r30 = await parse('many-colours.svg', { maxColors: 30 }), r4 = await parse('many-colours.svg', { maxColors: 4 });
    t.ok(r30.report.colors.after >= 20 && r30.report.colors.max === 30, '30: ' + r30.report.colors.after + ' threads (only near-identical shades merge)');
    t.ok(r4.report.colors.after <= 4, '4: ' + r4.report.colors.after + ' threads');
    t.ok(r4.objs.some(function (o) { return o.color === '#F5D020'; }), '4: the yellow accent is still there');
    t.equal((await parse('many-colours.svg', { maxColors: 1 })).report.colors.max, 2, 'below 2 is clamped');
    t.equal((await parse('many-colours.svg', { maxColors: 99 })).report.colors.max, 30, 'above 30 is clamped');
    t.equal((await parse('logo-multicolour.svg', { maxColors: 2 })).report.colors.after, 2, 'a logo can be cut down to 2');
  });

  test('paint order survives the clean-up: partly covering light shapes, overlapping subpaths, light donuts', async function () {
    async function probeAt(svg, bb, pts) {
      return page.eval('var r = __T.parse(' + JSON.stringify(svg) + '), bb = ' + JSON.stringify(bb) + ', k = r.report.width / (bb[2] - bb[0]);'
        + 'return { colors: r.objs.map(function (o) { return o.color; }), at: ' + JSON.stringify(pts) + '.map(function (q) { var x = 65 + (q[0] - (bb[0] + bb[2]) / 2) * k, y = 90 + (q[1] - (bb[1] + bb[3]) / 2) * k;'
        + ' var top = null; r.list.forEach(function (o) { if (__T.winding(o.geom, x, y)) top = o.style.color; }); return top; }) };');
    }
    /* a white bar half over a black circle, half over the white canvas: where it covers the circle, no black */
    var a = await probeAt("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 200 200' width='200' height='200'><rect width='200' height='200' fill='#fff'/><circle cx='80' cy='100' r='50' fill='#000'/>"
      + "<rect x='100' y='80' width='80' height='40' fill='#fff'/><rect x='20' y='180' width='160' height='10' fill='#c00'/></svg>", [20, 50, 180, 190], [[80, 100], [120, 100], [60, 60]]);
    t.deepEqual(a.at, ['#000000', '#FFFFFF', '#000000'], 'partly covering white bar stays on top: ' + a.colors.join(' '));
    /* one path of two overlapping squares (nonzero) plus another black shape: the overlap stays thread */
    var b = await probeAt("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 200 200' width='200' height='200'><path d='M20 20 H120 V120 H20 Z M50 50 H110 V170 H50 Z' fill='#000'/>"
      + "<rect x='160' y='10' width='30' height='30' fill='#000'/></svg>", [20, 10, 190, 170], [[80, 100], [30, 30], [80, 160], [170, 20]]);
    t.deepEqual(b.at, ['#000000', '#000000', '#000000', '#000000'], 'overlapping subpaths stay filled');
    /* a white donut stacked on black: the donut is cut out, its centre stays black */
    var c = await probeAt("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 200 200' width='200' height='200'><rect width='200' height='200' fill='#fff'/><rect x='20' y='20' width='160' height='160' fill='#000'/>"
      + "<path fill='#fff' fill-rule='evenodd' d='M50 50 H150 V150 H50 Z M80 80 H120 V120 H80 Z'/><circle cx='170' cy='190' r='5' fill='#f00'/></svg>", [20, 20, 180, 195], [[100, 100], [60, 60], [30, 30]]);
    t.deepEqual(c.at, ['#000000', null, '#000000'], 'the donut centre');
  });

  test('plain strokes still import as lines', async function () {
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100"><line x1="10" y1="10" x2="90" y2="10" stroke="#ff0000" stroke-width="2"/>'
      + '<polyline points="10,50 50,90 90,50" fill="none" stroke="#0000ff" stroke-width="6"/><rect x="20" y="20" width="60" height="20" fill="none" stroke="#00aa00" stroke-width="1"/></svg>';
    var r = await page.eval('return __T.parse(' + JSON.stringify(svg) + ');');
    t.deepEqual(r.objs.map(function (o) { return [o.type, o.paint]; }), [['line', 'line'], ['pen', 'line'], ['polygon', 'line']], 'objects');
    t.equal(r.report.lines, 3, 'report.lines');
  });

  test('in the app: one undo step, the toast says background left out, and Keep background brings it back', async function () {
    await page.eval('Editor.Model.clear(); Editor.SvgImport.importText(' + JSON.stringify(fixture('lineart-eyes.svg')) + '); return 1;');
    await wait(400);
    var s = await page.eval('await Editor.IO.fresh(); var r = Editor.IO.result, o = Editor.Model.doc.objects;'
      + 'return { n: o.length, undo: Editor.Model.undoLabel(), stitches: r && r.totals.stitches, trims: r && r.totals.trims, colors: r && r.totals.colors,'
      + ' toast: Array.prototype.slice.call(document.querySelectorAll(".toast")).map(function (x) { return x.textContent; }).join(" | ") };');
    t.equal(s.n, 1, 'objects on the hoop');
    t.equal(s.undo, 'Import SVG', 'undo label');
    t.ok(/Background left out\./.test(s.toast), 'toast: ' + s.toast);
    t.ok(s.stitches > 1000 && s.stitches < 25000, 'stitches ' + s.stitches);
    t.ok(s.trims < 120, 'trims ' + s.trims);
    t.equal(s.colors, 1, 'thread colours');
    var b = await page.eval('var b = Array.prototype.slice.call(document.querySelectorAll(".toast__action")).filter(function (x) { return x.textContent === "Keep background"; })[0];'
      + 'if (!b) return null; var r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 };');
    t.ok(b, 'the toast has a Keep background button');
    if (b) {
      await page.click(b.x, b.y); await wait(400);
      var k = await page.eval('return { n: Editor.Model.doc.objects.length, colors: Editor.Model.doc.objects.map(function (o) { return o.color; }), undo: Editor.Model.undoLabel() };');
      t.equal(k.n, 2, 'objects after Keep background');
      t.ok(k.colors.indexOf('#fbfbfb') >= 0 || k.colors.indexOf('#FBFBFB') >= 0, 'the background is an object: ' + k.colors.join(' '));
      t.equal(k.undo, 'Import SVG', 'still one undo step');
      await page.eval('Editor.Model.undo(); return 1;');
      t.equal(await page.eval('return Editor.Model.doc.objects.length;'), 0, 'one undo removes the import');
    }
    t.equal(page.errors.length, 0, 'console: ' + page.errors.join(' | '));
  });

  test('close the browser', async function () { if (browser) await browser.close(); });
};

if (require.main === module) {
  (async function () {
    var skipped = module.exports();
    for (var i = 0; i < queue.length; i++) {
      var q = queue[i], before = failed; current = q.name;
      try { await q.fn(); } catch (e) { failed++; failures.push(q.name + ': threw ' + (e && e.stack || e)); }
      console.log((failed === before ? '  ok    ' : '  FAIL  ') + q.name);
    }
    console.log('\n' + passed + ' checks passed, ' + failed + ' failed.');
    if (skipped) console.log('SKIPPED: the browser checks did not run (' + skipped + '). The importer was NOT verified by this run.');
    if (failed) { console.log('\nFailures:\n  ' + failures.join('\n  ')); process.exit(1); }
    if (skipped) process.exit(2);
  })().catch(function (e) { console.error(e); process.exit(1); });
}
