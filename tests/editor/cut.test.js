/*
 * The Cut-out tool and the stitch-style controls, in headless Chrome against the real app.html.
 *
 *   node tests/editor/cut.test.js          (CHROME_PATH for the binary, EMB_TEST_PORT for the static server,
 *                                           EMB_SHOTS=<dir> to keep screenshots)
 *
 * Proves, by real pointer and key events on the canvas where it matters:
 *   - a freehand lasso through a filled rectangle splits it in two: inside + outside area equals the
 *     original within 0.5 %, one undo step "Cut out", the inside piece is selected and keeps the style,
 *     both pieces give engine output that Engine.validate finds clean, and one undo restores the original;
 *   - a click-polygon outline (Enter closes) with nothing selected cuts every shape under it;
 *   - an open line is split where the outline crosses it; a compound path with a hole and line art keeps
 *     its hole and its stitch style; an outline that misses everything changes nothing and says so;
 *   - Esc drops a half-made outline; K picks the tool;
 *   - cutting a 300-ring line-art path takes under 500 ms;
 *   - the Style control (Fill / Line art) and the Detail control (only for line art) change the shape
 *     and its engine input;
 *   - the page logs no errors (a missing js/engine/lineart.js is allowed: it comes with the engine change).
 * Needs Google Chrome; skipped with a message when it is not installed.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const REPO = path.join(__dirname, '..', '..');
const CHROME = [process.env.CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean).find(p => { try { return fs.statSync(p).isFile(); } catch (e) { return false; } });
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg' };
const SHOTS = process.env.EMB_SHOTS || fs.mkdtempSync(path.join(os.tmpdir(), 'emb-cut-shots-'));
const HAS_LINEART = fs.existsSync(path.join(REPO, 'js', 'engine', 'lineart.js'));

let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) { passed++; console.log('  ok   ' + msg); } else { failed++; console.log('  FAIL ' + msg); } }

function serve(port) {
  const server = http.createServer((req, res) => {
    let rel;
    try { rel = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname); } catch (e) { res.writeHead(400); res.end(); return; }
    const file = path.join(REPO, path.normalize('/' + rel));
    if (req.method !== 'GET' || (file !== REPO && !file.startsWith(REPO + path.sep))) { res.writeHead(403); res.end(); return; }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); return; }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); res.end(buf);
    });
  });
  return new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => resolve(server)); });
}
function getJson(url) { return new Promise((res, rej) => { http.get(url, r => { let b = ''; r.on('data', d => b += d); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } }); }).on('error', rej); }); }
const wait = ms => new Promise(r => setTimeout(r, ms));

async function chrome(debugPort) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'emb-cut-prof-'));
  const child = spawn(CHROME, ['--headless=new', '--remote-debugging-port=' + debugPort, '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars', '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' });
  let ver = null;
  for (let i = 0; i < 100 && !ver; i++) { try { ver = await getJson('http://127.0.0.1:' + debugPort + '/json/version'); } catch (e) { await wait(150); } }
  if (!ver) { child.kill(); throw new Error('Chrome did not start'); }
  const page = (await getJson('http://127.0.0.1:' + debugPort + '/json/list')).find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const pending = new Map(), errors = [], handlers = {};
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); return; }
    if (m.method === 'Runtime.exceptionThrown') errors.push('exception ' + ((m.params.exceptionDetails.exception && m.params.exceptionDetails.exception.description) || m.params.exceptionDetails.text));
    if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'warning')) errors.push('console.' + m.params.type + ' ' + m.params.args.map(a => a.value || a.description).join(' '));
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
      const url = m.params.entry.url || '';
      if (!(HAS_LINEART === false && /\/js\/engine\/lineart\.js$/.test(url))) errors.push('log ' + m.params.entry.text + ' ' + url);
    }
    if (handlers[m.method]) handlers[m.method](m.params);
  };
  const send = (method, params) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params: params || {} })); });
  await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable');
  const api = {
    errors,
    async goto(url) { const loaded = new Promise(r => { handlers['Page.loadEventFired'] = () => r(); }); await send('Page.navigate', { url }); await loaded; },
    async viewport(w, h) { await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false }); },
    async eval(expr) {
      const r = await send('Runtime.evaluate', { expression: '(async function(){' + expr + '})()', awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error('eval: ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text));
      return r.result.value;
    },
    async mouse(type, x, y, extra) { await send('Input.dispatchMouseEvent', Object.assign({ type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, pointerType: 'mouse' }, extra || {})); },
    async click(x, y) { await api.mouse('mouseMoved', x, y, { buttons: 0, button: 'none' }); await api.mouse('mousePressed', x, y); await api.mouse('mouseReleased', x, y); },
    async key(key, code, keyCode) {
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: keyCode, text: key.length === 1 ? key : undefined });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode });
    },
    async shot(name) {
      const r = await send('Page.captureScreenshot', { format: 'png' });
      const file = path.join(SHOTS, name); fs.writeFileSync(file, Buffer.from(r.data, 'base64')); return file;
    },
    async close() { try { ws.close(); } catch (e) { /* closed */ } child.kill(); await wait(200); try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* busy */ } }
  };
  return api;
}

const RECT = { id: 'r1', name: 'Box', type: 'rect', x: 20, y: 30, w: 60, h: 40, color: '#c0392b', paint: 'fill', lineType: 'running', lineWidth: 3, spacing: 0.4, stitchLen: 3, angle: 30, pattern: 'brick' };

(async () => {
  if (!CHROME) { console.log('  skip: Google Chrome not found (set CHROME_PATH)'); return; }
  const port = +process.env.EMB_TEST_PORT || 8200 + Math.floor(Math.random() * 800);
  const server = await serve(port);
  const c = await chrome(9400 + Math.floor(Math.random() * 400));
  const ev = e => c.eval(e);
  const shots = [];
  try {
    await c.viewport(1440, 900);
    await c.goto('http://127.0.0.1:' + port + '/app.html');
    for (let i = 0; i < 50 && !(await ev('return !!(window.Editor && Editor.Tools && Editor.Cut && Editor.IO)')); i++) await wait(100);
    ok(await ev('return Editor.Cut.available && typeof polygonClipping.intersection === "function"'), 'the vendored polygon-clipping is loaded and Cut out is available');
    const load = doc => ev('Editor.Model.load(' + JSON.stringify({ name: 'cut test', hoop: { w: 130, h: 180 }, objects: doc }) + '); Editor.View.fit && Editor.View.fit(); return 1;');
    /* screen position of a point in mm */
    const px = (x, y) => ev('var p = Editor.View.toPx(' + x + ',' + y + '), r = document.getElementById("main-canvas").getBoundingClientRect(); return { x: r.left + p.x, y: r.top + p.y };');
    const areaOf = 'function areaOf(o){ return Editor.Cut.area(Editor.Cut.region(o)); }';

    /* ---- 1. freehand lasso through a selected rectangle, by real pointer events */
    await load([RECT]);
    await ev('Editor.Model.select(["r1"]);');
    const original = await ev('return JSON.stringify(Editor.Model.doc.objects);');
    await c.key('k', 'KeyK', 75);
    ok((await ev('return Editor.Tools.current')) === 'cut', 'K picks the Cut out tool');
    const ring = [];
    for (let i = 0; i <= 48; i++) { const a = i / 48 * Math.PI * 2; ring.push([62 + 26 * Math.cos(a), 50 + 30 * Math.sin(a)]); }
    let p = await px(ring[0][0], ring[0][1]);
    await c.mouse('mouseMoved', p.x, p.y, { buttons: 0, button: 'none' }); await c.mouse('mousePressed', p.x, p.y);
    for (let i = 1; i < ring.length; i++) {
      p = await px(ring[i][0], ring[i][1]); await c.mouse('mouseMoved', p.x, p.y);
      if (i === 30) shots.push(await c.shot('cut-1-drawing.png'));
    }
    await c.mouse('mouseReleased', p.x, p.y);
    await wait(400);
    let r = await ev(areaOf + `
      var M = Editor.Model, objs = M.doc.objects, sel = M.selected();
      var res = Engine.generate(M.toEngine());
      return { n: objs.length, label: M.undoLabel(), sel: sel.map(function(o){return o.name}), selColor: sel.length && sel[0].color, selPattern: sel.length && sel[0].pattern, selAngle: sel.length && sel[0].angle,
        areas: objs.map(areaOf), problems: Engine.validate(res.ir), stitches: res.totals.stitches, perObj: res.objects.map(function(o){return o.stitches}),
        errors: res.warnings.filter(function(w){return w.severity === 'error'}).map(function(w){return w.code}) };`);
    const sum = r.areas.reduce((a, b) => a + b, 0);
    ok(r.n === 2 && r.label === 'Cut out', 'a freehand lasso splits the rectangle into 2 pieces in one undo step "Cut out" (got ' + r.n + ', "' + r.label + '")');
    ok(Math.abs(sum - 2400) / 2400 < 0.005, 'inside + outside area = ' + sum.toFixed(2) + ' mm2, the rectangle was 2400 mm2 (' + (Math.abs(sum - 2400) / 24).toFixed(3) + ' %)');
    ok(r.sel.length === 1 && r.sel[0] === 'Box cut' && r.selColor === '#c0392b' && r.selPattern === 'brick' && r.selAngle === 30, 'the inside piece is selected and keeps the thread, pattern and angle: ' + r.sel.join(','));
    ok(r.problems.length === 0 && r.errors.length === 0 && r.perObj.every(n => n > 0), 'both pieces sew: ' + r.stitches + ' stitches (' + r.perObj.join(' + ') + '), Engine.validate clean');
    await wait(500);
    shots.push(await c.shot('cut-2-after.png'));
    await ev('Editor.Model.undo();');
    r = await ev('return { json: JSON.stringify(Editor.Model.doc.objects), sel: Editor.Model.selection.join() };');
    ok(r.json === original && r.sel === 'r1', 'one undo restores the original rectangle and its selection');

    /* ---- 2. the Style and Detail controls on the inside piece */
    await ev('Editor.Model.redo();');
    await wait(200);
    const detailHidden = () => ev('return document.getElementById("line-detail-row").hidden');
    ok(await detailHidden(), 'Detail is hidden while the stitch style is Fill');
    await ev('document.querySelector("[data-fill-style=lineart]").click();');
    r = await ev('var o = Editor.Model.selected()[0], e = Editor.Model.toEngine().objects.filter(function(x){return x.id === o.id})[0]; return { fs: o.fillStyle, style: e.fill.style, detail: e.fill.lineart && e.fill.lineart.detail, other: Editor.Model.toEngine().objects.filter(function(x){return x.id !== o.id})[0].fill.style, pressed: document.querySelector("[data-fill-style=lineart]").getAttribute("aria-pressed") };');
    ok(r.fs === 'lineart' && r.style === 'lineart' && r.detail === 'normal' && r.other === undefined && r.pressed === 'true', 'Style > Line art sets the piece to line art (engine fill.style "lineart", detail normal), the other piece stays a plain fill');
    ok(!(await detailHidden()), 'Detail shows for line art');
    await ev('document.querySelector("[data-line-detail=bold]").click();');
    r = await ev('var o = Editor.Model.selected()[0]; return { d: o.lineDetail, label: Editor.Model.undoLabel(), e: Editor.Model.toEngine().objects.filter(function(x){return x.id === o.id})[0].fill.lineart.detail };');
    ok(r.d === 'bold' && r.e === 'bold' && r.label === 'Change line detail', 'Detail > Bold changes the shape and its engine input');
    await wait(300);
    shots.push(await c.shot('cut-3-lineart-panel.png'));
    await ev('document.querySelector("[data-fill-style=tatami]").click();');
    ok((await detailHidden()) && (await ev('return Editor.Model.selected()[0].fillStyle')) === 'tatami', 'Style > Fill goes back and hides Detail');

    /* ---- 3. click-polygon outline with nothing selected: cuts every shape under it; an open line too */
    await load([
      { id: 'e1', name: 'Disc', type: 'ellipse', cx: 40, cy: 110, rx: 20, ry: 20, color: '#2e86de', paint: 'fill', lineType: 'running', lineWidth: 3, spacing: 0.4, stitchLen: 3, angle: 0 },
      { id: 'l1', name: 'Rule', type: 'line', x1: 10, y1: 150, x2: 110, y2: 150, color: '#222222', paint: 'line', lineType: 'satin', lineWidth: 2, spacing: 0.4, stitchLen: 3, angle: 0 },
      { id: 'far', name: 'Far', type: 'rect', x: 95, y: 10, w: 20, h: 20, color: '#10ac84', paint: 'fill', lineType: 'running', lineWidth: 3, spacing: 0.4, stitchLen: 3, angle: 0 }
    ]);
    await ev('Editor.Model.select([]); Editor.Tools.set("cut");');
    const before = await ev(areaOf + 'return areaOf(Editor.Model.get("e1"));');
    for (const q of [[40, 85], [75, 85], [75, 165], [40, 165]]) { p = await px(q[0], q[1]); await c.click(p.x, p.y); await wait(60); }
    p = await px(60, 175); await c.mouse('mouseMoved', p.x, p.y, { buttons: 0, button: 'none' }); await wait(250);
    shots.push(await c.shot('cut-4-click-outline.png'));
    await c.key('Enter', 'Enter', 13);
    await wait(300);
    r = await ev(areaOf + `var M = Editor.Model, o = M.doc.objects;
      return { names: o.map(function(x){return x.name + ':' + x.type}), sel: M.selected().map(function(x){return x.name}),
        disc: o.filter(function(x){return /^Disc/.test(x.name)}).map(areaOf), rule: o.filter(function(x){return /^Rule/.test(x.name)}).map(function(x){return x.pts}),
        far: !!M.get("far"), label: M.undoLabel() };`);
    const discSum = r.disc.reduce((a, b) => a + b, 0);
    ok(r.disc.length === 2 && Math.abs(discSum - before) / before < 0.005, 'Enter closes a click outline; with nothing selected the disc under it is cut: ' + r.disc.map(a => a.toFixed(1)).join(' + ') + ' = ' + discSum.toFixed(1) + ' of ' + before.toFixed(1) + ' mm2');
    const rule = r.rule.map(pts => pts[0][0].toFixed(2) + '-' + pts[pts.length - 1][0].toFixed(2)).sort();
    ok(r.rule.length === 3 && rule.join() === ['10.00-40.00', '40.00-75.00', '75.00-110.00'].join(), 'the open line is split where the outline crosses it: ' + rule.join(', '));
    ok(r.far && r.sel.length === 2 && r.sel.every(n => / cut$/.test(n)) && r.label === 'Cut out', 'the shape outside the outline is untouched; the inside pieces are selected: ' + r.sel.join(', '));
    shots.push(await c.shot('cut-5-click-result.png'));

    /* ---- 4. compound path with a hole, set to line art */
    await load([{ id: 'o1', name: 'Letter O', type: 'path', rings: [[[20, 20], [80, 20], [80, 80], [20, 80]], [[35, 35], [35, 65], [65, 65], [65, 35]]], fillRule: 'evenodd', color: '#000000', paint: 'fill', lineType: 'running', lineWidth: 3, spacing: 0.4, stitchLen: 3, angle: 0, fillStyle: 'lineart', lineDetail: 'fine' }]);
    r = await ev(areaOf + `var before = areaOf(Editor.Model.get("o1"));
      Editor.Model.select(["o1"]);
      var out = Editor.Cut.apply([[50, 0], [100, 0], [100, 100], [50, 100]]);
      var o = Editor.Model.doc.objects, res = Engine.generate(Editor.Model.toEngine());
      return { before: before, areas: o.map(areaOf), styles: o.map(function(x){return x.fillStyle + '/' + x.lineDetail}), rings: o.map(function(x){return x.rings ? x.rings.length : 1}),
        problems: Engine.validate(res.ir).length, eng: Editor.Model.toEngine().objects.map(function(x){return x.fill.style + ':' + (x.fill.lineart && x.fill.lineart.detail)}) };`);
    const oSum = r.areas.reduce((a, b) => a + b, 0);
    ok(r.areas.length === 2 && Math.abs(oSum - r.before) < 0.01 && r.before === 2700, 'a compound path with a hole is cut in half: ' + r.areas.join(' + ') + ' = ' + r.before + ' mm2');
    ok(r.styles.every(s => s === 'lineart/fine') && r.eng.every(s => s === 'lineart:fine') && r.problems === 0, 'both halves keep line art (detail fine) and give valid engine output' + (HAS_LINEART ? '' : ' (this engine sews line art as the plain fill)'));

    /* ---- 5. an outline that misses: nothing changes, a toast says so; Esc drops a half-made outline */
    r = await ev(`var M = Editor.Model, before = JSON.stringify(M.doc.objects), h = M.historySize();
      var out = Editor.Cut.apply([[110, 150], [125, 150], [125, 175], [110, 175]]);
      var toasts = Array.prototype.slice.call(document.querySelectorAll('.toast')).map(function(t){return t.textContent}).join(' | ');
      return { out: out, same: JSON.stringify(M.doc.objects) === before, h: M.historySize() === h, toasts: toasts };`);
    ok(r.out === null && r.same && r.h && /does not cross|Nothing under/.test(r.toasts), 'an outline that misses changes nothing and says so');
    /* a figure-8 outline: its two loops have opposite signed areas that cancel, yet both still cut */
    r = await ev(`var M = Editor.Model, h = M.historySize(), before = JSON.stringify(M.doc.objects);
      var o = M.addMany([{ geom: { type: 'rect', x: 10, y: 120, w: 60, h: 40 } }])[0]; M.select([]);
      var a0 = Editor.Cut.area(Editor.Cut.region(o));
      var out = Editor.Cut.apply([[0, 110], [40, 170], [40, 110], [0, 170]], { ids: [o.id] });
      var sum = M.doc.objects.filter(function (x) { return x.name.indexOf(o.name) === 0; }).reduce(function (s, x) { return s + Editor.Cut.area(Editor.Cut.region(x)); }, 0);
      var n = out ? out.inside.length : 0;
      M.undo(); M.undo();
      return { split: out && out.split, n: n, a0: a0, sum: sum, same: JSON.stringify(M.doc.objects) === before };`);
    ok(r.split === 1 && Math.abs(r.sum - r.a0) < 0.5 && r.same, 'a figure-8 outline (loops that cancel in signed area) still cuts: ' + r.sum.toFixed(1) + ' of ' + r.a0.toFixed(1) + ' mm2');
    /* an outline-only path of 40 small rings: the rings the edge does not cross stay one closed shape per side */
    r = await ev(`var M = Editor.Model, before = JSON.stringify(M.doc.objects), rings = [], i, j;
      for (i = 0; i < 8; i++) for (j = 0; j < 5; j++) rings.push([[10 + i * 8, 120 + j * 8], [15 + i * 8, 120 + j * 8], [15 + i * 8, 125 + j * 8], [10 + i * 8, 125 + j * 8]]);
      var o = M.addMany([{ geom: { type: 'path', rings: rings, fillRule: 'evenodd' }, style: { paint: 'line' } }])[0];
      var out = Editor.Cut.apply([[29, 110], [51, 110], [51, 170], [29, 170]], { ids: [o.id] });
      var pieces = M.doc.objects.filter(function (x) { return x.name.indexOf(o.name) === 0; });
      var closed = pieces.filter(function (x) { return x.type === 'path'; }).map(function (x) { return x.rings.length + ':' + x.paint + ':' + x.fillRule; });
      var open = pieces.filter(function (x) { return x.type === 'pen'; }).length;
      M.undo(); M.undo();
      return { n: pieces.length, closed: closed.sort(), open: open, same: JSON.stringify(M.doc.objects) === before };`);
    /* columns 3 and 4 (x 34-39, 42-47) lie inside; columns 2 and 5 (x 26-31, 50-55) are crossed by the edge */
    ok(r.n <= 2 + r.open && r.closed.join(',') === '10:line:evenodd,20:line:evenodd' && r.same, 'an outline-only path keeps its uncrossed rings together: ' + r.n + ' pieces (' + r.closed.join(', ') + ' + ' + r.open + ' strokes)');
    await ev('Editor.Tools.set("cut");');
    for (const q of [[10, 10], [30, 10], [30, 30]]) { p = await px(q[0], q[1]); await c.click(p.x, p.y); await wait(60); }
    ok(await ev('return Editor.Tools.busy()'), 'clicks build an outline');
    await c.key('Escape', 'Escape', 27);
    ok(!(await ev('return Editor.Tools.busy()')) && (await ev('return Editor.Model.doc.objects.length')) === 2, 'Esc drops it, nothing is cut');

    /* ---- 6. speed: a 300-ring line-art path */
    r = await ev(`var rings = [];
      for (var i = 0; i < 300; i++) { var cx = 6 + (i % 20) * 6, cy = 6 + Math.floor(i / 20) * 6, pts = [];
        for (var k = 0; k < 40; k++) { var a = k / 40 * Math.PI * 2; pts.push([Math.round((cx + 2.2 * Math.cos(a)) * 100) / 100, Math.round((cy + 2.2 * Math.sin(a)) * 100) / 100]); }
        if (i % 3 === 0) pts.reverse();
        rings.push(pts); }
      Editor.Model.load({ name: 'big', hoop: { w: 130, h: 180 }, objects: [{ id: 'big', name: 'Line art', type: 'path', rings: rings, fillRule: 'nonzero', color: '#111111', paint: 'fill', lineType: 'running', lineWidth: 3, spacing: 0.4, stitchLen: 3, angle: 0, fillStyle: 'lineart' }] });
      var A = Editor.Cut.area(Editor.Cut.region(Editor.Model.get('big')));
      var las = []; for (var j = 0; j < 240; j++) { var b = j / 240 * Math.PI * 2; las.push([62 + 38 * Math.cos(b) + 4 * Math.sin(7 * b), 50 + 30 * Math.sin(b)]); }
      Editor.Model.select(['big']);
      var t0 = performance.now(); var out = Editor.Cut.apply(las); var ms = performance.now() - t0;
      var parts = Editor.Model.doc.objects.map(function (o) { return Editor.Cut.area(Editor.Cut.region(o)); });
      return { ms: ms, split: out && out.split, A: A, parts: parts, rings: Editor.Model.doc.objects.map(function(o){return o.rings ? o.rings.length : 1}) };`);
    const bigSum = r.parts.reduce((a, b) => a + b, 0);
    ok(r.split === 1 && r.ms < 500 && Math.abs(bigSum - r.A) / r.A < 0.005, 'cutting a 300-ring line-art path takes ' + r.ms.toFixed(0) + ' ms (< 500), pieces of ' + r.rings.join(' + ') + ' rings, area ' + bigSum.toFixed(1) + ' of ' + r.A.toFixed(1) + ' mm2');

    await wait(300);
    ok(c.errors.length === 0, 'no console errors' + (c.errors.length ? ':\n       ' + c.errors.join('\n       ') : ''));
    console.log('  screenshots: ' + shots.join(', '));
  } catch (e) {
    failed++; console.log('  FAIL ' + (e && e.stack || e));
  } finally {
    await c.close(); server.close();
  }
  console.log((failed ? 'FAILED ' + failed + ', ' : '') + passed + ' passed');
  process.exit(failed ? 1 : 0);
})();
