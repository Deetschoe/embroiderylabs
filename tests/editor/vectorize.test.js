/*
 * Picture to SVG (js/editor/vectorize.js), in headless Chrome against the real app.html.
 *
 *   node tests/editor/vectorize.test.js     (CHROME_PATH for the binary, EMB_TEST_PORT for the static server,
 *                                            EMB_SHOTS=<dir> to keep screenshots, EMB_VZ_PICTURE=<png> to also try a picture)
 *
 * Proves, with a PNG made on a canvas (three coloured blobs on white):
 *   - a paste event carrying the picture opens the studio; Auto picks the three colours and removes the white;
 *   - unticking a colour drops its shapes at once, without a new trace;
 *   - the shape eraser (key E, a real click) removes one shape, without a new trace; Cmd/Ctrl+Z inside the studio
 *     undoes that erase and leaves the design's own history alone; redo brings it back;
 *   - the brush (key B, a real drag) erases a blob from the picture and the new trace leaves it out;
 *   - Download .svg gives an SVG sized in mm with one path per kept shape;
 *   - Add to design adds every kept shape as ONE undo step, centred in the hoop; Cmd/Ctrl+Z takes them away;
 *   - copy / paste of shapes still works with the keyboard, and a picture on the clipboard wins over copied shapes;
 *   - File > Picture to SVG opens it empty; phone width 390 px has no sideways scroll; the page logs no errors.
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
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.woff2': 'font/woff2' };
const SHOTS = process.env.EMB_SHOTS || fs.mkdtempSync(path.join(os.tmpdir(), 'emb-vz-shots-'));
const HAS_LINEART = fs.existsSync(path.join(REPO, 'js', 'engine', 'lineart.js'));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'emb-vz-files-'));

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
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'emb-vz-prof-'));
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
  await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable'); await send('DOM.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: "try{localStorage.setItem('el-tutorial-v1','done')}catch(e){}" });
  const api = {
    errors, send,
    async goto(url) { const loaded = new Promise(r => { handlers['Page.loadEventFired'] = () => r(); }); await send('Page.navigate', { url }); await loaded; },
    async reload() { const loaded = new Promise(r => { handlers['Page.loadEventFired'] = () => r(); }); await send('Page.reload', {}); await loaded; },
    async viewport(w, h, mobile) { await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: !!mobile }); },
    async eval(expr) {
      const r = await send('Runtime.evaluate', { expression: '(async function(){' + expr + '})()', awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error('eval: ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text));
      return r.result.value;
    },
    async mouse(type, x, y, extra) { await send('Input.dispatchMouseEvent', Object.assign({ type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, pointerType: 'mouse' }, extra || {})); },
    async click(x, y, mods) { await api.mouse('mouseMoved', x, y, { buttons: 0, button: 'none', modifiers: mods || 0 }); await api.mouse('mousePressed', x, y, { modifiers: mods || 0 }); await api.mouse('mouseReleased', x, y, { modifiers: mods || 0 }); },
    async drag(x0, y0, x1, y1, mods, steps) {
      const m = mods || 0; steps = steps || 10;
      await api.mouse('mouseMoved', x0, y0, { buttons: 0, button: 'none', modifiers: m });
      await api.mouse('mousePressed', x0, y0, { modifiers: m });
      for (let i = 1; i <= steps; i++) { await api.mouse('mouseMoved', x0 + (x1 - x0) * i / steps, y0 + (y1 - y0) * i / steps, { modifiers: m }); await wait(16); }
      await api.mouse('mouseReleased', x1, y1, { modifiers: m });
    },
    /* modifiers: 1 Alt, 2 Ctrl, 4 Meta, 8 Shift */
    async key(key, code, keyCode, mods) {
      const text = key.length === 1 && !(mods & 6) ? key : undefined;
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: keyCode, modifiers: mods || 0, text });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode, modifiers: mods || 0 });
    },
    async setFile(selector, file) {
      const doc = await send('DOM.getDocument', { depth: 0 });
      const node = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector });
      await send('DOM.setFileInputFiles', { nodeId: node.nodeId, files: [file] });
    },
    async shot(name) {
      const r = await send('Page.captureScreenshot', { format: 'png' });
      const file = path.join(SHOTS, name); fs.writeFileSync(file, Buffer.from(r.data, 'base64')); return file;
    },
    async close() { try { ws.close(); } catch (e) { /* closed */ } child.kill(); await wait(200); try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* busy */ } }
  };
  return api;
}


/* in page: a 600 x 400 PNG, red disc, blue square, green disc on white */
const MAKE_PNG = `
  var c = document.createElement('canvas'); c.width = 600; c.height = 400;
  var x = c.getContext('2d'); x.fillStyle = '#ffffff'; x.fillRect(0, 0, 600, 400);
  x.fillStyle = '#d23c3c'; x.beginPath(); x.arc(110, 200, 70, 0, Math.PI * 2); x.fill();
  x.fillStyle = '#2f5fb8'; x.fillRect(235, 130, 130, 140);
  x.fillStyle = '#2f9a4a'; x.beginPath(); x.arc(490, 200, 70, 0, Math.PI * 2); x.fill();
  var blob = await new Promise(function (r) { c.toBlob(r, 'image/png'); });
  window.__png = new File([blob], 'three blobs.png', { type: 'image/png' });`;
const PASTE = (what) => `
  var dt = new DataTransfer(); ${what}
  (document.activeElement || document.body).dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));`;

(async () => {
  if (!CHROME) { console.log('  skip: Google Chrome not found (set CHROME_PATH)'); return; }
  let port = +process.env.EMB_TEST_PORT || 8200 + Math.floor(Math.random() * 800), server = null;
  for (let i = 0; i < 6 && !server; i++) { try { server = await serve(port); } catch (e) { if (e.code !== 'EADDRINUSE' || process.env.EMB_TEST_PORT) throw e; port = 8200 + Math.floor(Math.random() * 800); } }
  const c = await chrome(9400 + Math.floor(Math.random() * 400));
  const ev = e => c.eval(e);
  const shots = [];
  const META = process.platform === 'darwin' ? 4 : 2;
  const st = () => ev('return Editor.Vectorize.state();');
  const settled = async (seqAbove) => {
    for (let i = 0; i < 150; i++) { const s = await st(); if (!s.busy && s.resSeq > (seqAbove || 0) && !(await ev('return Editor.Vectorize.state().busy'))) return s; await wait(100); }
    return st();
  };
  const ready = async () => { for (let i = 0; i < 60 && !(await ev('return !!(window.Editor && Editor.Vectorize && document.documentElement.getAttribute("data-editor") === "ready")')); i++) await wait(100); };
  try {
    await c.viewport(1440, 900);
    await c.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
    await c.goto('http://127.0.0.1:' + port + '/app.html');
    await ready();
    await ev('Editor.Model.load(Editor.Model.blank()); window.__dl = []; EL.download = function (name, data, mime) { window.__dl.push({ name: name, data: data, mime: mime }); }; return 1;');
    await ev(MAKE_PNG + ' return 1;');

    /* ---- 1. paste a picture */
    await ev(PASTE('dt.items.add(window.__png);') + ' return 1;');
    await wait(60);
    let s = await st();
    ok(s.open && !!s.picture && s.picture.w === 600 && s.picture.h === 400, 'a paste event with a PNG opens the studio with the picture (' + JSON.stringify(s.picture) + ')');
    shots.push(await c.shot('vz-1-tracing.png'));
    s = await settled();
    ok(s.colors.length === 3, 'Auto picks the three colours (' + s.colors.map(q => q.hex).join(' ') + ')');
    ok(s.background && s.background.removed, 'the white background is removed (' + JSON.stringify(s.background) + ')');
    ok(s.shapes === s.objects && s.shapes >= 3, 'every traced shape is shown (' + s.shapes + ')');
    ok(s.settings.width > 10 && /in|mm/.test(await ev('return document.getElementById("vz-width").nextElementSibling.textContent')), 'the width reads in ' + (await ev('return Editor.Units.label()')));
    shots.push(await c.shot('vz-2-after.png'));

    /* ---- 2. untick a colour: shapes drop at once */
    const seq0 = s.resSeq;
    const redIdx = s.colors.findIndex(q => parseInt(q.hex.slice(1, 3), 16) > 150 && parseInt(q.hex.slice(3, 5), 16) < 120);
    const boxPt = await ev('var b = document.querySelectorAll("#vz-colors .vz__color")[' + redIdx + '].querySelector("input.check").getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2];');
    await c.click(boxPt[0], boxPt[1]);
    s = await st();
    ok(redIdx >= 0 && !s.colors[redIdx].keep && s.shapes < s.objects && s.resSeq === seq0 && !s.busy, 'unticking the red colour drops its shapes without a new trace (' + s.shapes + ' of ' + s.objects + ')');
    shots.push(await c.shot('vz-3-one-colour-off.png'));
    await c.click(boxPt[0], boxPt[1]);
    s = await st();
    ok(s.shapes === s.objects, 'ticking it again brings them back');

    /* ---- 3. recolour and merge, instant */
    await ev('var p = document.querySelectorAll("#vz-colors .vz__color")[0].querySelector("input[type=color]"); p.value = "#ff00ff"; p.dispatchEvent(new Event("input", { bubbles: true })); p.dispatchEvent(new Event("change", { bubbles: true })); return 1;');
    s = await st();
    ok(s.colors[0].now === '#ff00ff' && s.resSeq === seq0, 'a new colour from the swatch applies without a new trace');
    await ev('var sel = document.querySelectorAll("#vz-colors .vz__color")[1].querySelector("select"); sel.value = "2"; sel.dispatchEvent(new Event("change", { bubbles: true })); return 1;');
    s = await st();
    ok(s.colors[1].into === 2 && s.resSeq === seq0, 'Merge into another colour applies without a new trace');
    shots.push(await c.shot('vz-3b-merged.png'));
    const svgMerged = await ev('return Editor.Vectorize.svg();');
    ok((svgMerged.match(/data-thread=/g) || []).length >= 1 && svgMerged.indexOf('#ff00ff') > 0, 'the SVG follows the new colour');
    await ev('var sel = document.querySelectorAll("#vz-colors .vz__color")[1].querySelector("select"); sel.value = "-1"; sel.dispatchEvent(new Event("change", { bubbles: true })); var p = document.querySelectorAll("#vz-colors .vz__color")[0].querySelector("input[type=color]"); p.value = ' + JSON.stringify(s.colors[0].hex) + '; p.dispatchEvent(new Event("input", { bubbles: true })); return 1;');
    s = await st();
    ok(s.colors[1].into === -1 && s.colors[0].now === s.colors[0].hex, 'both can be put back');

    /* ---- 4. shape eraser + studio undo */
    const hist0 = await ev('return Editor.Model.historySize() + ":" + Editor.Model.undoLabel()');
    await ev('document.getElementById("vz-add").focus(); return 1;');
    await c.key('e', 'KeyE', 69);
    s = await st();
    ok(s.tool === 'shape' && s.view === 'after', 'E picks the shape eraser and shows After');
    const blueIdx = s.colors.findIndex(q => parseInt(q.hex.slice(5, 7), 16) > 150 && parseInt(q.hex.slice(1, 3), 16) < 120);
    const objIdx = await ev('var r = Editor.Vectorize; for (var i = 0; i < 400; i++) { var p = r.pointOf(i); if (p) return i; } return -1;');
    const pt = await ev('return Editor.Vectorize.pointOf(' + objIdx + ');');
    await c.mouse('mouseMoved', pt[0], pt[1], { buttons: 0, button: 'none' });
    shots.push(await c.shot('vz-4-shape-hover.png'));
    const before = s.shapes;
    await c.click(pt[0], pt[1]);
    s = await st();
    ok(s.shapes === before - 1 && s.steps === 1 && s.resSeq === seq0, 'a click removes just that shape, without a new trace (' + before + ' -> ' + s.shapes + ')');
    await c.key('z', 'KeyZ', 90, META);
    s = await st();
    ok(s.shapes === before && s.steps === 0 && s.canRedo, 'Cmd/Ctrl+Z in the studio brings the shape back');
    ok((await ev('return Editor.Model.historySize() + ":" + Editor.Model.undoLabel()')) === hist0, 'and leaves the design history alone (' + hist0 + ')');
    await c.key('z', 'KeyZ', 90, META | 8);
    s = await st();
    ok(s.shapes === before - 1 && s.steps === 1, 'Shift+Cmd/Ctrl+Z redoes it');
    await ev('document.getElementById("vz-reset").click(); return 1;');
    s = await st();
    ok(s.shapes === before && s.steps === 0, 'Reset brings back everything erased');

    /* ---- 5. brush erase: the green disc goes, after a new trace */
    await c.key('b', 'KeyB', 66);
    s = await st();
    ok(s.tool === 'brush' && s.view === 'before', 'B picks the brush and shows Before');
    await c.key(']', 'BracketRight', 221); await c.key(']', 'BracketRight', 221); await c.key(']', 'BracketRight', 221);
    const b1 = (await st()).brush;
    ok(b1 > s.brush, '] makes the brush bigger (' + s.brush + ' -> ' + b1 + ')');
    for (let i = 0; i < 6; i++) await c.key(']', 'BracketRight', 221);
    const k = s.rect.k, rad = (await st()).brush / 2 / k;
    const greenBefore = s.colors.length;
    const seq1 = s.resSeq;
    /* zigzag over the disc at (490, 200) r 70, in picture pixels */
    const pts = [];
    for (let y = 120; y <= 280; y += Math.max(8, rad * 0.8)) { pts.push([400, y]); pts.push([580, y]); }
    const page = await ev('return ' + JSON.stringify(pts) + '.map(function (p) { return Editor.Vectorize.picToPage(p[0], p[1]); });');
    await c.mouse('mouseMoved', page[0][0], page[0][1], { buttons: 0, button: 'none' });
    await c.mouse('mousePressed', page[0][0], page[0][1]);
    for (let i = 1; i < page.length; i++) {
      const a = page[i - 1], b = page[i];
      for (let j = 1; j <= 6; j++) await c.mouse('mouseMoved', a[0] + (b[0] - a[0]) * j / 6, a[1] + (b[1] - a[1]) * j / 6);
      if (i === Math.floor(page.length / 2)) shots.push(await c.shot('vz-5-brushing.png'));
    }
    await c.mouse('mouseReleased', page[page.length - 1][0], page[page.length - 1][1]);
    s = await settled(seq1);
    const greens = s.colors.filter(q => parseInt(q.hex.slice(3, 5), 16) > 120 && parseInt(q.hex.slice(1, 3), 16) < 120);
    ok(s.resSeq > seq1 && greens.length === 0 && s.colors.length === greenBefore - 1, 'brushing over the green disc retraces without it (' + s.colors.map(q => q.hex).join(' ') + ')');
    ok(s.background && s.background.removed, 'the erased area counts as background, so the white is still removed');
    await ev('Editor.Vectorize.setView("split"); return 1;');
    shots.push(await c.shot('vz-6-split.png'));
    await ev('Editor.Vectorize.setView("after"); return 1;');

    /* ---- 6. Download .svg */
    await ev('window.__dl = []; document.getElementById("vz-svg").click(); return 1;');
    const svg = await ev(`var f = window.__dl[0]; if (!f) return null;
      var doc = new DOMParser().parseFromString(f.data, 'image/svg+xml'), root = doc.documentElement;
      return { name: f.name, mime: f.mime, bad: !!doc.querySelector('parsererror'), tag: root.tagName, w: root.getAttribute('width'), h: root.getAttribute('height'), vb: root.getAttribute('viewBox'),
        paths: doc.querySelectorAll('path').length, evenodd: doc.querySelectorAll('path[fill-rule="evenodd"]').length, rect: doc.querySelectorAll('rect').length };`);
    s = await st();
    ok(svg && !svg.bad && svg.tag === 'svg' && /mm$/.test(svg.w) && /mm$/.test(svg.h) && /^0 0 [\d.]+ [\d.]+$/.test(svg.vb), 'Download .svg gives a valid SVG sized in mm (' + (svg && [svg.name, svg.w, svg.h, svg.vb].join(' ')) + ')');
    ok(svg && svg.paths === s.shapes && svg.evenodd >= 1 && svg.rect === 0 && svg.mime === 'image/svg+xml', 'one path per shape (' + (svg && svg.paths) + ' = ' + s.shapes + '), fills evenodd, no background rectangle');

    /* ---- 7. Add to design: one undo step, Cmd/Ctrl+Z takes it away */
    const n0 = await ev('return Editor.Model.doc.objects.length');
    await ev('document.getElementById("vz-add").click(); return 1;');
    await wait(100);
    const added = await ev(`var M = Editor.Model, o = M.doc.objects, u = Editor.Geom.union(o), b = [u.x0, u.y0, u.x1, u.y1];
      return { n: o.length, label: M.undoLabel(), open: Editor.Vectorize.isOpen(), names: o.map(function (x) { return x.name; }), cx: (b[0] + b[2]) / 2, cy: (b[1] + b[3]) / 2, hw: M.doc.hoop.w / 2, hh: M.doc.hoop.h / 2 };`);
    ok(added.n === n0 + s.shapes && added.label === 'Picture to SVG' && !added.open, 'Add to design adds ' + s.shapes + ' shapes as one undo step and closes the studio');
    ok(Math.abs(added.cx - added.hw) < 1 && Math.abs(added.cy - added.hh) < 1, 'centred in the hoop (' + added.cx.toFixed(1) + ', ' + added.cy.toFixed(1) + ')');
    ok(added.names.every(n => !/^Shape \d+$|^Polygon \d+$/.test(n)), 'named after their thread (' + added.names.slice(0, 3).join(', ') + ')');
    await ev('document.body.focus(); return 1;');
    await c.key('z', 'KeyZ', 90, META);
    ok((await ev('return Editor.Model.doc.objects.length')) === n0, 'Cmd/Ctrl+Z removes them in one step');

    /* ---- 8. copy / paste of shapes still works */
    await ev('document.getElementById("btn-example") ? document.getElementById("btn-example").click() : 0; return 1;');
    await wait(100);
    const n1 = await ev('var M = Editor.Model; M.select([M.doc.objects[0].id]); return M.doc.objects.length;');
    await c.key('c', 'KeyC', 67, META);
    await c.key('v', 'KeyV', 86, META);
    await wait(250);
    ok((await ev('return Editor.Model.doc.objects.length')) === n1 + 1 && !(await ev('return Editor.Vectorize.isOpen()')), 'Cmd/Ctrl+C then Cmd/Ctrl+V pastes the shape (' + n1 + ' -> ' + (n1 + 1) + ')');
    await ev(PASTE('dt.setData("' + 'application/x-embroidr' + '", "1");') + ' return 1;');
    await wait(150);
    ok((await ev('return Editor.Model.doc.objects.length')) === n1 + 2 && !(await ev('return Editor.Vectorize.isOpen()')), 'a paste event carrying the editor mark pastes shapes, not a picture');
    await ev(PASTE('dt.items.add(window.__png);') + ' return 1;');
    await wait(200);
    ok((await ev('return Editor.Vectorize.isOpen()')) && (await ev('return Editor.Model.doc.objects.length')) === n1 + 2, 'a picture on the clipboard opens the studio even with shapes copied, and pastes no shape');
    await settled(0);
    await c.key('Escape', 'Escape', 27);
    await wait(100);
    ok(!(await ev('return Editor.Vectorize.isOpen()')), 'Esc closes the studio');

    /* ---- 9. File menu, empty, phone */
    await ev('Editor.Vectorize.state(); document.getElementById("btn-file").click(); document.querySelector("[data-file=vectorize]").click(); return 1;');
    await wait(100);
    ok(await ev('return Editor.Vectorize.isOpen()'), 'File > Picture to SVG opens the studio');
    await c.viewport(390, 844, true); await wait(500);
    await ev('Editor.Vectorize.setView("after"); return 1;'); await wait(200);
    const sw = await ev('var d = document.getElementById("vectorize"); return { sw: document.documentElement.scrollWidth, dw: d.scrollWidth, cw: d.clientWidth, w: d.getBoundingClientRect().width, h: d.getBoundingClientRect().height };');
    ok(sw.sw <= 390 && sw.dw <= sw.cw && sw.w >= 389 && sw.h >= 840, 'phone 390 px: full screen sheet, no sideways scroll (' + JSON.stringify(sw) + ')');
    shots.push(await c.shot('vz-7-phone.png'));
    await ev('document.querySelector(".vz__side").scrollIntoView({ block: "start" }); return 1;'); await wait(150);
    shots.push(await c.shot('vz-8-phone-panel.png'));
    await ev('document.querySelector(".vz__body").scrollTop = 0; Editor.Vectorize.setTool("brush"); return 1;'); await wait(100);
    /* touch drawing with the brush */
    const sp = await st();
    const tp = await ev('return [Editor.Vectorize.picToPage(150, 150), Editor.Vectorize.picToPage(260, 260)];');
    await c.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: tp[0][0], y: tp[0][1] }] });
    for (let i = 1; i <= 8; i++) await c.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: tp[0][0] + (tp[1][0] - tp[0][0]) * i / 8, y: tp[0][1] + (tp[1][1] - tp[0][1]) * i / 8 }] });
    await c.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await wait(100);
    ok((await st()).steps === sp.steps + 1, 'a finger draws a brush stroke on the phone');
    shots.push(await c.shot('vz-9-phone-brush.png'));
    await settled(sp.resSeq);

    /* ---- optional: a real picture */
    if (process.env.EMB_VZ_PICTURE && fs.existsSync(process.env.EMB_VZ_PICTURE)) {
      await c.viewport(1440, 900); await wait(300);
      const b64 = fs.readFileSync(process.env.EMB_VZ_PICTURE).toString('base64');
      const before2 = (await st()).resSeq;
      await ev('var bin = atob(' + JSON.stringify(b64) + '), u = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); window.__real = new File([u], "real.png", { type: "image/png" }); return 1;');
      await ev(PASTE('dt.items.add(window.__real);') + ' return 1;');
      const r = await settled(before2);
      console.log('  info real picture: ' + r.picture.w + 'x' + r.picture.h + ', ' + r.colors.length + ' colours, ' + r.shapes + ' shapes, ' + JSON.stringify(r.background));
      shots.push(await c.shot('vz-10-real-after.png'));
      await ev('Editor.Vectorize.setView("split"); return 1;');
      shots.push(await c.shot('vz-11-real-split.png'));
    }

    await wait(300);
    ok(c.errors.length === 0, 'no console errors' + (c.errors.length ? ':\n       ' + c.errors.join('\n       ') : ''));
    console.log('  screenshots: ' + shots.join(', '));
  } catch (e) {
    failed++; console.log('  FAIL ' + (e && e.stack || e));
  } finally {
    await c.close(); server.close();
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* busy */ }
  }
  console.log((failed ? 'FAILED ' + failed + ', ' : '') + passed + ' passed');
  process.exit(failed ? 1 : 0);
})();
