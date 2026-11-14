/*
 * The Mockup view's layers, in headless Chrome against the real app.html.
 *
 *   node tests/editor/mockup.test.js       (CHROME_PATH for the binary, EMB_TEST_PORT for the static server,
 *                                           EMB_SHOTS=<dir> to keep screenshots)
 *
 * Proves, by real pointer and key events where it matters:
 *   - R turns the picked layer +15 degrees, Shift+R -15, not while typing in a field; the Rotation slider and
 *     number field follow, and the angle is stored (and an old stored state without rotation loads as 0);
 *   - a corner handle scales uniformly with the opposite corner fixed, Alt scales from the centre, the round
 *     handle turns the layer and Shift snaps to 15 degrees; clicks hit the turned box, not the unturned one;
 *   - "Add image" (file input) and a file dropped on the garment add image layers, cut down to 2048 px;
 *   - the Layers list shows every layer top first; dragging a row reorders, Ctrl+] / [ move up / down,
 *     the eye hides and the cross deletes;
 *   - the downloads (white, transparent, stitching only) follow order, rotation, opacity, blend, visibility,
 *     and the garment clips every layer; stitching only has the embroidery and nothing else;
 *   - when localStorage is full the pictures stay in memory and one calm toast says so;
 *   - a phone-width page has no sideways scroll, and the page logs no errors.
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
const SHOTS = process.env.EMB_SHOTS || fs.mkdtempSync(path.join(os.tmpdir(), 'emb-mock-shots-'));
const HAS_LINEART = fs.existsSync(path.join(REPO, 'js', 'engine', 'lineart.js'));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'emb-mock-files-'));

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
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'emb-mock-prof-'));
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

const BADGE = { id: 'b1', name: 'Badge', type: 'rect', x: 20, y: 30, w: 60, h: 40, color: '#1f9d3a', paint: 'fill', lineType: 'running', lineWidth: 3, spacing: 0.4, stitchLen: 3, angle: 30, pattern: 'brick' };
/* in-page helpers: read pixels of a downloaded PNG; count red pixels */
const PIX = `
  window.__dl = window.__dl || [];
  if (!window.__dlWrapped) { window.__dlWrapped = true; EL.download = function (name, blob) { window.__dl.push({ name: name, blob: blob }); }; }
  window.__px = async function (blob, pts) {
    var bmp = await createImageBitmap(blob), c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
    var x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(bmp, 0, 0);
    var out = pts.map(function (p) { return Array.prototype.slice.call(x.getImageData(p[0], p[1], 1, 1).data); });
    var d = x.getImageData(0, 0, c.width, c.height).data, red = 0, solid = 0;
    for (var i = 0; i < d.length; i += 4) { if (d[i + 3] > 200) { solid++; if (d[i] > 200 && d[i + 1] < 60 && d[i + 2] < 60) red++; } }
    return { w: c.width, h: c.height, px: out, red: red, solid: solid };
  };
  window.__last = async function (kind, pts) {
    var before = window.__dl.length;
    var r = kind === 'thread' ? await Editor.Mockup.downloadStitching() : await Editor.Mockup.downloadImage(kind === 'transparent');
    if (!r || window.__dl.length === before) return null;
    var f = window.__dl[window.__dl.length - 1], res = await window.__px(f.blob, pts || []); res.name = f.name; return res;
  };`;

(async () => {
  if (!CHROME) { console.log('  skip: Google Chrome not found (set CHROME_PATH)'); return; }
  /* other test runs may hold a port: try a few */
  let port = +process.env.EMB_TEST_PORT || 8200 + Math.floor(Math.random() * 800), server = null;
  for (let i = 0; i < 6 && !server; i++) { try { server = await serve(port); } catch (e) { if (e.code !== 'EADDRINUSE' || process.env.EMB_TEST_PORT) throw e; port = 8200 + Math.floor(Math.random() * 800); } }
  const c = await chrome(9400 + Math.floor(Math.random() * 400));
  const ev = e => c.eval(e);
  const shots = [];
  const ready = async () => { for (let i = 0; i < 50 && !(await ev('return !!(window.Editor && Editor.Mockup && Editor.Tools && Editor.IO && Editor.Tabs)')); i++) await wait(100); };
  const layers = () => ev('return Editor.Mockup.layers();');
  const handles = () => ev('var r = document.getElementById("mock-canvas").getBoundingClientRect(); return Editor.Mockup.handles().map(function (h) { return { k: h.k, x: r.left + h.x, y: r.top + h.y }; });');
  const centre = hs => ({ x: (hs[0].x + hs[2].x) / 2, y: (hs[0].y + hs[2].y) / 2 });
  const near = (a, b, tol) => Math.abs(a - b) <= tol;
  const toasts = () => ev('return Array.prototype.slice.call(document.querySelectorAll(".toast")).map(function (t) { return t.textContent; });');
  try {
    await c.viewport(1440, 900);
    await c.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });   /* the site is light only */
    await c.goto('http://127.0.0.1:' + port + '/app.html');
    await ready();
    await ev('Editor.Model.load(' + JSON.stringify({ name: 'Badge', hoop: { w: 100, h: 100 }, objects: [BADGE] }) + '); return 1;');
    await wait(400);
    await ev('document.getElementById("view-mockup").click(); return 1;');
    for (let i = 0; i < 100; i++) { const l = await layers(); if (l.length && l[0].ready && !(await ev('return !!document.querySelector("#mock-busy:not([hidden])")'))) break; await wait(150); }
    await wait(600);
    let l = await layers();
    ok(l.length === 1 && l[0].kind === 'design' && l[0].rot === 0 && l[0].ready, 'opening the mockup places the design as one embroidery layer, rotation 0');
    ok(await ev('var r = document.getElementById("mock-rot-row"), s = document.getElementById("mock-scale-row"); return !!r && s.nextElementSibling === r;'), 'the Rotation row sits directly below Size');
    const did = l[0].id;
    await ev(PIX + ' return 1;');

    /* ---- 1. R / Shift+R */
    let hs = await handles();
    ok(hs.length === 5 && hs[4].k === 'rot' && hs[4].y < Math.min(hs[0].y, hs[1].y), 'the picked layer shows four corner handles and a rotate handle above the top edge');
    let ctr = centre(hs);
    await c.click(ctr.x, ctr.y);
    await c.key('r', 'KeyR', 82);
    l = await layers();
    ok(l[0].rot === 15, 'R turns the picked layer +15 degrees (' + l[0].rot + ')');
    await c.key('r', 'KeyR', 82);
    await c.key('R', 'KeyR', 82, 8);
    await c.key('R', 'KeyR', 82, 8);
    await c.key('R', 'KeyR', 82, 8);
    l = await layers();
    const ui = await ev('return [document.getElementById("mock-rot").value, document.getElementById("mock-rot-value").value];');
    ok(l[0].rot === -15 && ui[0] === '-15' && ui[1] === '-15', 'Shift+R turns it -15 degrees; slider and number field follow (' + l[0].rot + ', ' + ui.join(' / ') + ')');
    await ev('document.getElementById("mock-rot-value").focus(); return 1;');
    await c.key('r', 'KeyR', 82);
    ok((await layers())[0].rot === -15, 'R typed in the number field does not turn the layer');
    await ev('var n = document.getElementById("mock-rot-value"); n.value = "40"; n.dispatchEvent(new Event("input", { bubbles: true })); n.blur(); return 1;');
    ok((await layers())[0].rot === 40, 'typing 40 in the number field turns it to 40');
    await wait(450);
    ok((await ev('return JSON.parse(localStorage.getItem("el-editor-mockup-v1")).placements.front[0].rot')) === 40, 'the rotation is stored in el-editor-mockup-v1');
    shots.push(await c.shot('mock-1-rotated.png'));
    await ev('document.getElementById("mock-rot-reset").click(); return 1;');
    ok((await layers())[0].rot === 0 && (await ev('return document.getElementById("mock-rot-reset").disabled')), 'the reset button puts it back to 0');

    /* ---- 2. corner handles */
    hs = await handles();
    const nw0 = { x: hs[0].x, y: hs[0].y }, ratio0 = (hs[1].x - hs[0].x) / (hs[3].y - hs[0].y), s0 = (await layers())[0].scale;
    await c.drag(hs[2].x, hs[2].y, hs[2].x + 60, hs[2].y + 40);
    hs = await handles(); l = await layers();
    const ratio1 = (hs[1].x - hs[0].x) / (hs[3].y - hs[0].y);
    ok(l[0].scale > s0 * 1.2 && near(hs[0].x, nw0.x, 1.5) && near(hs[0].y, nw0.y, 1.5) && Math.abs(ratio1 - ratio0) < 0.02, 'dragging the bottom-right corner scales uniformly to ' + Math.round(l[0].scale * 100) + '% with the top-left corner fixed');
    ok((await ev('return document.getElementById("mock-scale-value").textContent')) === Math.round(l[0].scale * 100) + '%', 'the Size read-out follows');
    const c1 = centre(hs), s1 = l[0].scale;
    await c.drag(hs[0].x, hs[0].y, hs[0].x + 25, hs[0].y + 17, 1);
    hs = await handles(); l = await layers();
    const c2 = centre(hs);
    ok(l[0].scale < s1 * 0.9 && near(c2.x, c1.x, 1.5) && near(c2.y, c1.y, 1.5), 'Alt + corner scales from the centre (' + Math.round(s1 * 100) + '% -> ' + Math.round(l[0].scale * 100) + '%, centre moved ' + Math.hypot(c2.x - c1.x, c2.y - c1.y).toFixed(2) + ' px)');
    await ev('Editor.Mockup.setLayer(' + JSON.stringify(did) + ', { scale: 1, dx: 0, dy: 0 }); return 1;'); await wait(100);

    /* ---- 3. the rotate handle, Shift snaps; hit-testing follows the turn */
    hs = await handles(); ctr = centre(hs);
    const cur = await (async () => { await c.mouse('mouseMoved', hs[4].x, hs[4].y, { buttons: 0, button: 'none' }); return ev('return document.getElementById("mock-canvas").style.cursor'); })();
    ok(/svg/.test(cur), 'hovering the rotate handle shows the rotate cursor');
    await c.mouse('mouseMoved', hs[2].x, hs[2].y, { buttons: 0, button: 'none' });
    ok((await ev('return document.getElementById("mock-canvas").style.cursor')) === 'nwse-resize', 'hovering a corner shows the resize cursor');
    await c.drag(hs[4].x, hs[4].y, ctr.x + 90, ctr.y + 3, 8, 12);
    l = await layers();
    ok(l[0].rot === 90, 'dragging the rotate handle to the right with Shift snaps to 90 degrees (' + l[0].rot + ')');
    hs = await handles();
    await c.drag(hs[4].x, hs[4].y, ctr.x + 90, ctr.y + 38, 0, 12);
    l = await layers();
    ok(l[0].rot !== 90 && l[0].rot % 15 !== 0, 'without Shift the turn is free (' + l[0].rot + ')');
    await ev('Editor.Mockup.setLayer(' + JSON.stringify(did) + ', { rot: 90 }); return 1;'); await wait(100);
    hs = await handles(); ctr = centre(hs);
    /* the design is 66 x 46 mm with its margin: 0.4 of its width to the side is inside the unturned box, outside the turned one */
    const side = Math.hypot(hs[1].x - hs[0].x, hs[1].y - hs[0].y) * 0.4;
    await c.click(ctr.x + side, ctr.y);
    ok((await ev('return Editor.Mockup.selected()')) === null, 'a click beside the turned layer (inside where it was before turning) misses it');
    await c.click(ctr.x, ctr.y + side * 0.9);
    ok((await ev('return Editor.Mockup.selected()')) === did, 'a click inside the turned layer picks it');

    /* ---- 4. images: the button (file input) and a drop */
    const png = await ev('var c = document.createElement("canvas"); c.width = 3000; c.height = 1500; var x = c.getContext("2d"); x.fillStyle = "#ff0000"; x.fillRect(0, 0, 3000, 1500); return c.toDataURL("image/png").split(",")[1];');
    const pngFile = path.join(TMP, 'red-banner.png'); fs.writeFileSync(pngFile, Buffer.from(png, 'base64'));
    await c.setFile('#mock-image-file', pngFile);
    for (let i = 0; i < 40 && (await layers()).length < 2; i++) await wait(100);
    l = await layers();
    ok(l.length === 2 && l[1].kind === 'image' && l[1].name === 'red-banner' && l[1].px && l[1].px[0] === 2048 && l[1].px[1] === 1024 && l[1].opacity === 100 && l[1].blend === 'normal', 'Add image puts the picture on top, cut down from 3000 x 1500 to ' + (l[1] && l[1].px && l[1].px.join(' x ')) + ' (' + (l[1] && l[1].srcType) + ')');
    const imgId = l[1].id;
    ok(await ev('return !document.getElementById("mock-img-props").hidden && document.getElementById("mock-true-size").hidden'), 'a picture shows Opacity and Blend');
    await ev(`var svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 20"><rect width="40" height="20" fill="#0000ff"/></svg>';
      var dt = new DataTransfer(); dt.items.add(new File([svg], "blue.svg", { type: "image/svg+xml" }));
      var st = document.getElementById("mock-stage"), opts = { bubbles: true, cancelable: true, dataTransfer: dt };
      st.dispatchEvent(new DragEvent("dragenter", opts)); st.dispatchEvent(new DragEvent("dragover", opts)); st.dispatchEvent(new DragEvent("drop", opts)); return 1;`);
    for (let i = 0; i < 40 && (await layers()).length < 3; i++) await wait(100);
    l = await layers();
    ok(l.length === 3 && l[2].kind === 'image' && l[2].name === 'blue' && /^image\/(webp|png)$/.test(l[2].srcType) && l[2].px[0] === 1536, 'an SVG dropped on the garment becomes a picture layer (' + (l[2] && l[2].px && l[2].px.join(' x ')) + ' ' + (l[2] && l[2].srcType) + ')');
    const svgId = l[2].id;
    await ev('var st = document.getElementById("mock-stage"); var dt = new DataTransfer(); dt.items.add(new File(["x"], "notes.txt", { type: "text/plain" })); st.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt })); return 1;');
    await wait(200);
    ok((await layers()).length === 3 && (await toasts()).some(t => /PNG, JPG, WebP or SVG/.test(t)), 'a dropped text file is refused with a short note');

    /* ---- 5. the Layers list: top first, drag to reorder, keys, eye, delete */
    let rows = await ev('return Array.prototype.slice.call(document.querySelectorAll("#mock-layers [data-item]")).map(function (r) { return { id: r.getAttribute("data-item"), name: r.querySelector(".name").textContent, thumb: !!r.querySelector("canvas.mock__thumb"), eye: !!r.querySelector("[data-eye]"), del: !!r.querySelector("[data-remove]") }; });');
    ok(rows.length === 3 && rows[0].id === svgId && rows[2].id === did && rows.every(r => r.thumb && r.eye && r.del), 'the Layers list shows every layer top first, each with a thumbnail, name, eye and delete: ' + rows.map(r => r.name).join(', '));
    shots.push(await c.shot('mock-2-layers.png'));
    const rowPos = await ev('return Array.prototype.slice.call(document.querySelectorAll("#mock-layers [data-item]")).map(function (r) { var b = r.querySelector(".name").getBoundingClientRect(); return { x: b.left + 20, y: b.top + b.height / 2, top: r.getBoundingClientRect().top }; });');
    await c.drag(rowPos[2].x, rowPos[2].y, rowPos[2].x, rowPos[0].top + 3, 0, 14);
    await wait(100);
    l = await layers();
    ok(l.map(p => p.id).join() === [imgId, svgId, did].join(), 'dragging the bottom row to the top draws the design over both pictures');
    ok((await ev('return Editor.Mockup.selected()')) === did, 'the dragged layer is picked');
    await c.click(ctr.x, ctr.y);
    await c.key('[', 'BracketLeft', 219, 2);
    l = await layers();
    ok(l.map(p => p.id).join() === [imgId, did, svgId].join(), 'Ctrl+[ moves the picked layer down one');
    await c.key(']', 'BracketRight', 221, 2);
    ok((await layers()).map(p => p.id).join() === [imgId, svgId, did].join(), 'Ctrl+] moves it up again');
    await ev('document.querySelector(\'#mock-layers [data-item="' + svgId + '"] [data-eye]\').click(); return 1;');
    ok((await layers()).filter(p => p.id === svgId)[0].hidden === true && (await ev('return document.querySelector(\'#mock-layers [data-item="' + svgId + '"]\').classList.contains("is-hidden")')), 'the eye hides a layer');
    await ev('document.querySelector(\'#mock-layers [data-item="' + svgId + '"] [data-remove]\').click(); return 1;');
    ok((await layers()).length === 2, 'the cross deletes it');
    await ev('document.querySelector(\'#mock-layers [data-item="' + imgId + '"]\').click(); return 1;');
    ok((await ev('return Editor.Mockup.selected()')) === imgId, 'clicking a row picks the layer');

    /* ---- 6. downloads: order, rotation, opacity, blend, visibility, clipping */
    const A = [1000, 930];                                                     /* the middle of the hoodie's chest */
    const P = [[A[0], A[1]], [A[0] + 90, A[1]], [A[0] + 55, A[1]], [A[0], A[1] + 55], [1960, 80], [30, 30]];
    const set = (id, props) => ev('Editor.Mockup.setLayer(' + JSON.stringify(id) + ', ' + JSON.stringify(props) + '); return 1;');
    await set(did, { rot: 0, scale: 1, dx: 0, dy: 0 }); await set(imgId, { rot: 0, scale: 1, dx: 0, dy: 0 });
    await ev('Editor.Mockup.reorder([' + JSON.stringify(imgId) + ',' + JSON.stringify(did) + ']); return 1;');      /* picture on top */
    const isRed = p => p[0] > 200 && p[1] < 50 && p[2] < 50, isGreen = p => p[1] > p[0] + 20 && p[1] > p[2], isWhite = p => p[0] === 255 && p[1] === 255 && p[2] === 255 && p[3] === 255;
    let r = await ev('return __last("white", ' + JSON.stringify(P) + ');');
    ok(r && r.w === 2000 && isRed(r.px[0]) && isWhite(r.px[5]), 'white download: the picture on top covers the chest ' + JSON.stringify(r && r.px[0]));
    const garmentPx = (await ev('Editor.Mockup.setLayer(' + JSON.stringify(imgId) + ', { hidden: true }); return __last("white", ' + JSON.stringify(P) + ');'));
    ok(isGreen(garmentPx.px[0]) && !isRed(garmentPx.px[1]) && garmentPx.red === 0, 'a hidden picture is left out: the thread shows ' + JSON.stringify(garmentPx.px[0]) + ', cloth beside it ' + JSON.stringify(garmentPx.px[1]));
    const cloth = garmentPx.px[1];
    await set(imgId, { hidden: false, opacity: 50 });
    r = await ev('return __last("white", ' + JSON.stringify(P) + ');');
    let q = r.px[1];
    ok(Math.abs(q[0] - (255 + cloth[0]) / 2) < 14 && Math.abs(q[1] - cloth[1] / 2) < 14, 'opacity 50: half red, half cloth ' + JSON.stringify(q) + ' (cloth ' + JSON.stringify(cloth) + ')');
    await set(imgId, { opacity: 100, blend: 'multiply' });
    r = await ev('return __last("white", ' + JSON.stringify(P) + ');'); q = r.px[1];
    ok(Math.abs(q[0] - cloth[0]) < 10 && q[1] < 8 && q[2] < 8, 'multiply: red times the cloth ' + JSON.stringify(q));
    await set(imgId, { blend: 'screen' });
    r = await ev('return __last("white", ' + JSON.stringify(P) + ');'); q = r.px[1];
    ok(q[0] > 245 && Math.abs(q[1] - cloth[1]) < 10 && Math.abs(q[2] - cloth[2]) < 10, 'screen: red lifted onto the cloth ' + JSON.stringify(q));
    await set(imgId, { blend: 'normal' });
    await ev('Editor.Mockup.moveLayer(' + JSON.stringify(imgId) + ', "bottom"); return 1;');
    r = await ev('return __last("white", ' + JSON.stringify(P) + ');');
    ok(isGreen(r.px[0]) && isRed(r.px[1]), 'picture under the embroidery: thread in the middle ' + JSON.stringify(r.px[0]) + ', picture round it ' + JSON.stringify(r.px[1]));
    ok(isGreen(r.px[2]) && !isGreen(r.px[3]), 'unturned design: wide, not tall');
    await set(did, { rot: 90 });
    r = await ev('return __last("white", ' + JSON.stringify(P) + ');');
    ok(!isGreen(r.px[2]) && isGreen(r.px[3]), 'turned 90 degrees, the download has it tall, not wide ' + JSON.stringify([r.px[2], r.px[3]]));
    await set(imgId, { dx: (1960 - A[0]) / 2.02, dy: (80 - A[1]) / 2.02 });
    r = await ev('return __last("transparent", ' + JSON.stringify(P) + ');');
    ok(r.px[4][3] === 0 && r.px[5][3] === 0 && r.red === 0, 'a picture moved off the garment is clipped away (transparent download, alpha ' + r.px[4][3] + ')');
    r = await ev('return __last("white", ' + JSON.stringify(P) + ');');
    ok(isWhite(r.px[4]), 'and on white the spot stays white');
    await set(imgId, { dx: 0, dy: 0 });
    await ev('Editor.Mockup.moveLayer(' + JSON.stringify(imgId) + ', "top"); return 1;');
    r = await ev('return __last("thread", [[2, 2]]);');
    ok(r && /-stitching\.png$/.test(r.name) && r.red === 0 && r.solid > 1000 && r.h > r.w * 1.3 && r.px[0][3] === 0, 'stitching only: the turned embroidery alone (' + (r && r.w + ' x ' + r.h) + ', no picture pixels, clear corners)');
    await set(did, { rot: 0 });
    r = await ev('return __last("thread", []);');
    ok(r && r.w > r.h * 1.3, 'unturned, the stitching file is wide (' + (r && r.w + ' x ' + r.h) + ')');
    await set(did, { hidden: true });
    r = await ev('return __last("thread", []);');
    ok(r === null && (await ev('return document.querySelector("[data-dl=thread]").getAttribute("aria-disabled")')) === 'true', 'with the embroidery hidden there is no stitching file');
    await set(did, { hidden: false });

    /* ---- 7. localStorage full: pictures stay in memory, one calm toast */
    await ev('window.__set = EL.store.set; EL.store.set = function (k, v) { return /data:image/.test(JSON.stringify(v)) ? false : window.__set(k, v); }; Editor.Mockup.saveNow(); Editor.Mockup.saveNow(); return 1;');
    await wait(200);
    const quota = (await toasts()).filter(t => /too big to keep/.test(t));
    const kept = await ev('var s = JSON.parse(localStorage.getItem("el-editor-mockup-v1")); return s.placements.front.map(function (p) { return p.kind; });');
    ok(quota.length === 1 && kept.join() === 'design' && (await layers()).length === 2, 'when storage is full: one toast, the design is stored, the picture stays in memory (' + quota.length + ' toast, stored ' + kept.join() + ')');
    ok(!(await ev('return !!document.querySelector(".toast[data-kind=bad]") && Array.prototype.slice.call(document.querySelectorAll(".toast[data-kind=bad]")).some(function (t) { return /too big/.test(t.textContent); })')), 'the toast is calm (not an error)');
    await ev('EL.store.set = window.__set; Editor.Mockup.setLayer(' + JSON.stringify(did) + ', { rot: 30 }); Editor.Mockup.saveNow(); return 1;');
    shots.push(await c.shot('mock-3-picture-and-design.png'));

    /* ---- 8. reload keeps rotation and pictures; an old state without rotation loads as 0 */
    await c.reload(); await ready();
    await ev('document.getElementById("view-mockup").click(); return 1;');
    for (let i = 0; i < 80; i++) { const ll = await layers(); if (ll.length === 2 && ll.every(p => p.ready)) break; await wait(150); }
    l = await layers();
    ok(l.length === 2 && l.filter(p => p.id === did)[0].rot === 30 && l.filter(p => p.kind === 'image')[0].ready, 'after a reload the rotation and the picture are back');
    const tabId = await ev('return Editor.Mockup.state().placements.front.filter(function (p) { return p.kind === "design"; })[0].tab;');
    await ev('localStorage.setItem("el-editor-mockup-v1", JSON.stringify({ v: 1, garment: "tee", side: "front", color: "#F4F3F0", scene: "studio", placements: { front: [{ id: "old1", tab: ' + JSON.stringify(tabId) + ', dx: 4, dy: 2, scale: 1.2 }], back: [] } })); return 1;');
    await c.reload(); await ready();
    await ev('document.getElementById("view-mockup").click(); return 1;');
    for (let i = 0; i < 80; i++) { const ll = await layers(); if (ll.length && ll[0].ready) break; await wait(150); }
    l = await layers();
    ok(l.length === 1 && l[0].id === 'old1' && l[0].rot === 0 && l[0].kind === 'design' && l[0].hidden === false && l[0].scale === 1.2, 'an old stored state without rotation loads with rotation 0');
    await ev('Editor.Mockup.select("old1"); return 1;'); await wait(300);
    shots.push(await c.shot('mock-4-tee-desktop.png'));

    /* ---- 8b. pictures never crowd out the designs: a noisy picture over the budget stays in memory only */
    const big = await ev(`var n = 1200, cv = document.createElement('canvas'); cv.width = n; cv.height = n; var x = cv.getContext('2d'), im = x.createImageData(n, n);
      for (var i = 0; i < im.data.length; i++) im.data[i] = Math.random() * 255 | 0; x.putImageData(im, 0, 0);
      var b = await new Promise(function (r) { cv.toBlob(r, 'image/png'); });
      var p = await Editor.Mockup.addImage(new File([b], 'noise.png', { type: 'image/png' })); Editor.Mockup.saveNow();
      var s = localStorage.getItem('el-editor-mockup-v1');
      return { src: p ? p.src.length : 0, stored: s.length, kinds: JSON.parse(s).placements.front.map(function (q) { return q.kind; }).join() };`);
    ok(big.src > 1500000 && big.stored < 1500000 && big.kinds === 'design', 'a picture too big for the storage budget is not stored (' + big.src + ' chars, stored ' + big.stored + ': ' + big.kinds + ')');
    /* a stored id with quotes cannot break the Layers list */
    await ev('localStorage.setItem("el-editor-mockup-v1", JSON.stringify({ v: 1, garment: "tee", side: "front", color: "#F4F3F0", scene: "studio", placements: { front: [{ id: "a\\"]x", tab: ' + JSON.stringify(tabId) + ', dx: 0, dy: 0, scale: 1 }], back: [] } })); return 1;');
    await c.reload(); await ready();
    await ev('document.getElementById("view-mockup").click(); return 1;');
    for (let i = 0; i < 80; i++) { const ll = await layers(); if (ll.length && ll[0].ready) break; await wait(150); }
    ok(await ev('var r = document.querySelector("#mock-layers [data-item]"); if (!r) return false; r.click(); return Editor.Mockup.selected() === r.getAttribute("data-item") && /^[A-Za-z0-9_-]+$/.test(r.getAttribute("data-item"));'), 'a stored id with quotes is cleaned and its row still picks the layer');

    /* ---- 9. phone width */
    await c.viewport(390, 844, true); await wait(700);
    const sw = await ev('return { sw: document.documentElement.scrollWidth, mock: document.getElementById("mock").scrollWidth, cw: document.documentElement.clientWidth };');
    ok(sw.sw <= 390 && sw.mock <= sw.cw, 'phone 390 px: no sideways scroll (' + sw.sw + ' / ' + sw.mock + ')');
    shots.push(await c.shot('mock-5-phone.png'));
    await ev('var p = document.getElementById("mock-layers"); p.scrollIntoView({ block: "start" }); return 1;'); await wait(200);
    shots.push(await c.shot('mock-6-phone-layers.png'));

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
