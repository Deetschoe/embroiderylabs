/*
 * The first-visit tutorial and light mode only, in headless Chrome against the real app.html and index.html.
 *
 *   node tests/editor/tutorial.test.js     (CHROME_PATH for the binary, EMB_TEST_PORT for the static server,
 *                                           EMB_SHOTS=<dir> to keep screenshots)
 *
 * Proves, with the browser asking for a DARK colour scheme the whole time:
 *   - a first visit opens a "Tutorial" tab with the starter flower and the tips card at step 1 of 7;
 *   - a pen stroke drawn with real pointer events moves it to step 2; Next / Back move it by hand;
 *   - Skip closes it and stores el-tutorial-v1 = 'done', and a reload does not show it again;
 *   - Help > Tutorial opens it again (back on the Tutorial tab, no second copy of it);
 *   - Esc closes it;
 *   - arriving with ?design=<id> on a first visit does not open it;
 *   - every page renders light: body background, color-scheme, no data-theme, no theme switch, no
 *     prefers-color-scheme rule in any stylesheet; and a phone-wide editor has no sideways scroll;
 *   - the pages log no errors.
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
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.embroidr': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg' };
const SHOTS = process.env.EMB_SHOTS || fs.mkdtempSync(path.join(os.tmpdir(), 'emb-tut-shots-'));
const HAS_LINEART = fs.existsSync(path.join(REPO, 'js', 'engine', 'lineart.js'));
const LIGHT_BG = 'rgb(243, 241, 236)';   /* --bg in css/base.css */

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
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'emb-tut-prof-'));
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
      if (/fonts\.(googleapis|gstatic)\.com/.test(url)) return;             /* offline runs: the web font is optional */
      if (!(HAS_LINEART === false && /\/js\/engine\/lineart\.js$/.test(url))) errors.push('log ' + m.params.entry.text + ' ' + url);
    }
    if (handlers[m.method]) handlers[m.method](m.params);
  };
  const send = (method, params) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params: params || {} })); });
  await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable');
  const api = {
    errors, send,
    async goto(url) { const loaded = new Promise(r => { handlers['Page.loadEventFired'] = () => r(); }); await send('Page.navigate', { url }); await loaded; },
    async viewport(w, h, mobile) { await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: !!mobile }); },
    async eval(expr) {
      const r = await send('Runtime.evaluate', { expression: '(async function(){' + expr + '})()', awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error('eval: ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text));
      return r.result.value;
    },
    async mouse(type, x, y, extra) { await send('Input.dispatchMouseEvent', Object.assign({ type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, pointerType: 'mouse' }, extra || {})); },
    async click(x, y) { await api.mouse('mouseMoved', x, y, { buttons: 0, button: 'none' }); await api.mouse('mousePressed', x, y); await api.mouse('mouseReleased', x, y); },
    async clickSel(sel) {
      const r = await api.eval('var e = document.querySelector(' + JSON.stringify(sel) + '); if (!e) return null; var b = e.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 };');
      if (!r) throw new Error('no element ' + sel);
      await api.click(r.x, r.y);
    },
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

/* the look of the page as it rendered: what must be light */
const LOOK = 'var bad = 0; for (var i = 0; i < document.styleSheets.length; i++) { var rules; try { rules = document.styleSheets[i].cssRules; } catch (e) { continue; } ' +
  'for (var j = 0; j < rules.length; j++) if (rules[j].media && /prefers-color-scheme/.test(rules[j].media.mediaText)) bad++; } ' +
  'var meta = document.querySelector("meta[name=color-scheme]"); ' +
  'return { bg: getComputedStyle(document.body).backgroundColor, scheme: getComputedStyle(document.documentElement).colorScheme, theme: document.documentElement.getAttribute("data-theme"), ' +
  'meta: meta && meta.content, toggles: document.querySelectorAll("[data-theme-toggle]").length, darkRules: bad, dark: matchMedia("(prefers-color-scheme: dark)").matches, ' +
  'ink: getComputedStyle(document.documentElement).getPropertyValue("--ink-1").trim() };';

(async () => {
  if (!CHROME) { console.log('  skip: Google Chrome not found (set CHROME_PATH)'); return; }
  const port = +process.env.EMB_TEST_PORT || 8200 + Math.floor(Math.random() * 800);
  const server = await serve(port);
  const c = await chrome(9400 + Math.floor(Math.random() * 400));
  const ev = e => c.eval(e);
  const BASE = 'http://127.0.0.1:' + port + '/';
  const ready = async () => { for (let i = 0; i < 80 && !(await ev('return document.documentElement.getAttribute("data-editor") === "ready" && !!(window.Editor && Editor.Tutorial)')); i++) await wait(100); await wait(300); };
  const state = () => ev('var card = document.getElementById("tutorial"); return { open: Editor.Tutorial.isOpen(), step: Editor.Tutorial.step(), shown: !!card && !card.hidden && card.getBoundingClientRect().height > 40, ' +
    'count: card ? card.querySelector("#tut-count").textContent : "", ring: !document.querySelector(".tut-ring").hidden, name: Editor.Model.doc.name, shapes: Editor.Model.doc.objects.length, ' +
    'tabs: Editor.Tabs ? Editor.Tabs.list.map(function (t) { return t.name; }) : [], key: localStorage.getItem("el-tutorial-v1") };');
  try {
    await c.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
    await c.viewport(1440, 900);

    /* ---- light mode only, everywhere, while the browser asks for dark */
    for (const page of ['index.html', 'app.html']) {
      await c.goto(BASE + page); await wait(page === 'app.html' ? 1200 : 600);
      const look = await ev(LOOK);
      ok(look.dark === true, page + ': the browser really asks for a dark scheme');
      ok(look.bg === LIGHT_BG && look.scheme === 'light' && look.meta === 'light' && look.ink.toUpperCase() === '#2B2D31', page + ' renders light (' + look.bg + ', color-scheme ' + look.scheme + ', meta ' + look.meta + ', ink ' + look.ink + ')');
      ok(look.theme === null && look.toggles === 0 && look.darkRules === 0, page + ': no data-theme, no theme switch, no prefers-color-scheme rule (' + JSON.stringify([look.theme, look.toggles, look.darkRules]) + ')');
      await c.shot('dark-asked-' + page.replace('.html', '') + '.png');
    }
    await ev('localStorage.setItem("el-theme", "dark"); return 1');
    await c.goto(BASE + 'app.html'); await ready();
    const stale = await ev(LOOK + '');
    ok(stale.bg === LIGHT_BG && (await ev('return localStorage.getItem("el-theme")')) === null, 'a theme stored by an older version is ignored and forgotten');

    /* ---- first visit: the Tutorial tab and the card */
    await ev('localStorage.clear(); return 1');
    await c.goto(BASE + 'app.html'); await ready();
    let s = await state();
    ok(s.open && s.shown && s.step === 0 && s.count === '1 of 7', 'a first visit opens the tutorial card at step 1 of 7 (' + s.count + ')');
    ok(s.name === 'Tutorial' && s.shapes >= 3 && s.tabs.indexOf('Tutorial') !== -1, 'it opens a "Tutorial" tab with a starter design (' + s.shapes + ' shapes, tabs ' + JSON.stringify(s.tabs) + ')');
    ok(s.ring, 'the step points at its control with the ring');
    const pen = await ev('var r = document.querySelector(".tut-ring").getBoundingClientRect(), b = document.querySelector(".rail [data-tool=pen]").getBoundingClientRect(); return Math.abs((r.left + r.width / 2) - (b.left + b.width / 2)) < 2 && Math.abs((r.top + r.height / 2) - (b.top + b.height / 2)) < 2;');
    ok(pen, 'step 1 rings the pen tool');
    const cover = await ev('var c = document.getElementById("tutorial").getBoundingClientRect(), bad = []; document.querySelectorAll(".rail .tool, .ed-bar button, .hud").forEach(function (b) { var r = b.getBoundingClientRect(); if (r.width && r.right > c.left && r.left < c.right && r.bottom > c.top && r.top < c.bottom) bad.push(b.id || b.className); }); return bad;');
    ok(cover.length === 0, 'the card covers no tool, top-bar button or zoom control (' + JSON.stringify(cover) + ')');
    ok(s.key === null, 'nothing is stored while it is still running');
    await c.shot('tutorial-step1.png');

    /* step 1 is done by drawing with the pen, with real pointer events */
    await c.key('p', 'KeyP', 80); await wait(100);
    const a = await ev('var b = document.getElementById("hoop").getBoundingClientRect(); return { x: b.left + b.width * 0.2, y: b.top + b.height * 0.8 };');
    await c.mouse('mouseMoved', a.x, a.y, { buttons: 0, button: 'none' });
    await c.mouse('mousePressed', a.x, a.y);
    for (let i = 1; i <= 12; i++) await c.mouse('mouseMoved', a.x + i * 6, a.y - i * 3);
    await c.mouse('mouseReleased', a.x + 72, a.y - 36);
    await wait(900);
    s = await state();
    ok(s.step === 1 && s.count === '2 of 7' && s.shapes >= 4, 'a pen stroke moves it on to step 2 (' + s.count + ', ' + s.shapes + ' shapes)');
    await c.clickSel('#tutorial [data-tut="next"]'); await wait(300);
    s = await state(); ok(s.step === 2, 'Next moves on by hand');
    await c.clickSel('#tutorial [data-tut="back"]'); await wait(300);
    s = await state(); ok(s.step === 1, 'Back goes back');
    /* step 2 by the editor bus: a new thread colour on a shape */
    await ev('Editor.Tools.set("select"); var o = Editor.Model.doc.objects[0]; Editor.Model.select([o.id]); Editor.Model.setProp([o.id], "color", "#3366cc"); return 1'); await wait(900);
    s = await state(); ok(s.step === 2, 'changing a thread colour moves it on to step 3');

    /* ---- Skip persists */
    await c.clickSel('#tutorial [data-tut="skip"]'); await wait(200);
    s = await state();
    ok(!s.open && !s.shown && s.key === 'done', 'Skip closes it and stores el-tutorial-v1 = done');
    await c.goto(BASE + 'app.html'); await ready();
    s = await state();
    ok(!s.open && !s.shown, 'after a reload it does not come back');

    /* ---- Help reopens it, on the same Tutorial tab */
    await ev('Editor.Tabs.add(); return 1'); await wait(200);
    const tabsBefore = (await state()).tabs.filter(n => n === 'Tutorial').length;
    await c.clickSel('#btn-help'); await wait(300);
    ok(await ev('return document.getElementById("help").open && !!document.querySelector("#help [data-tutorial-open]")'), 'the Help dialog offers the tutorial');
    await c.clickSel('#help [data-tutorial-open]'); await wait(500);
    s = await state();
    ok(s.open && s.shown && s.step === 0 && s.name === 'Tutorial' && !(await ev('return !!document.querySelector("dialog[open]")')), 'Help > Tutorial opens it again at step 1 on the Tutorial tab, and closes Help');
    ok(s.tabs.filter(n => n === 'Tutorial').length === tabsBefore, 'it goes back to the Tutorial tab instead of making a second one');
    ok(await ev('return !!document.querySelector("#more [data-tutorial-open]")'), 'the phone More menu offers it too');

    /* ---- Esc closes it */
    await c.key('Escape', 'Escape', 27); await wait(200);
    s = await state(); ok(!s.open && !s.shown, 'Esc closes it');

    /* ---- ?design= on a first visit: no tutorial */
    const index = JSON.parse(fs.readFileSync(path.join(REPO, 'designs', 'index.json'), 'utf8'));
    const id = index.designs && index.designs[0] && index.designs[0].id;
    await ev('localStorage.clear(); return 1');
    await c.goto(BASE + 'app.html?design=' + id); await ready(); await wait(1200);
    s = await state();
    ok(!s.open && !s.shown && s.tabs.indexOf('Tutorial') === -1 && s.shapes > 0, 'a first visit with ?design=' + id + ' opens that design and no tutorial (' + s.name + ')');
    ok(s.key === null, '... and leaves it for next time');

    /* ---- phone width: it fits, nothing scrolls sideways */
    await ev('localStorage.clear(); return 1');
    await c.viewport(390, 844, true);
    await c.goto(BASE + 'app.html'); await ready();
    s = await state();
    const fit = await ev('var c = document.getElementById("tutorial").getBoundingClientRect(), d = document.querySelector(".dock").getBoundingClientRect(), h = document.querySelector(".view .hud").getBoundingClientRect(); ' +
      'return { sw: document.documentElement.scrollWidth, left: c.left, right: c.right, bottom: c.bottom, dockTop: d.top, hudTop: h.top, overlapHud: c.bottom > h.top && c.right > h.left };');
    ok(s.open && s.shown, 'phone: a first visit shows it too');
    ok(fit.sw <= 390 && fit.left >= 0 && fit.right <= 390 && fit.bottom <= fit.dockTop && !fit.overlapHud, 'phone: the card fits, stays above the dock and the zoom buttons, no sideways scroll (' + JSON.stringify(fit) + ')');
    await c.shot('tutorial-phone.png');
    ok(/^Pick the pen and draw/.test(await ev('return document.getElementById("tut-text").textContent')), 'phone: step 1 leaves out the key hint');
    /* step 7 points at More, and the More menu (it holds Save) must open over the card, not under it */
    await ev('for (var i = 0; i < 6; i++) Editor.Tutorial.next(); document.getElementById("btn-more").click(); return 1'); await wait(300);
    const menu = await ev('var m = document.getElementById("more"), s = m.querySelector("[data-action=save], [data-file=save]") || m.firstElementChild, b = s.getBoundingClientRect(), t = document.getElementById("tutorial").getBoundingClientRect(); ' +
      'var x = Math.max(b.left, t.left) + 4, y = Math.min(Math.max(b.top + b.height / 2, t.top + 4), t.bottom - 4), hit = document.elementFromPoint(x, y); return { open: !m.hidden, onTop: !!(hit && hit.closest("#more")) };');
    ok(menu.open && menu.onTop, 'phone: the More menu opens over the card (' + JSON.stringify(menu) + ')');
    await ev('document.getElementById("btn-more").click(); return 1');

    ok(c.errors.length === 0, 'no errors in the console' + (c.errors.length ? ': ' + c.errors.slice(0, 5).join(' | ') : ''));
  } catch (err) {
    failed++; console.log('  FAIL ' + (err && err.stack || err));
  } finally {
    await c.close(); server.close();
  }
  console.log('\n  screenshots: ' + SHOTS);
  console.log('  ' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
