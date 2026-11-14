/*
 * Groups in the editor, in headless Chrome against the real app.html, with real pointer and key events.
 *
 *   node tests/editor/groups.test.js       (CHROME_PATH for the binary, EMB_TEST_PORT for the static server,
 *                                           EMB_SHOTS=<dir> to keep screenshots)
 *
 * Proves:
 *   - Shift-click two shapes and Cmd/Ctrl+G groups them: one undo step, a group row with its shapes indented
 *     and the total stitch count, and the engine input (and the exported .pes bytes) are unchanged;
 *   - a click on a grouped shape picks the whole group, dragging moves the whole group, a double-click
 *     picks one shape inside, a click then picks a sibling, Esc steps out to the group, then clears;
 *   - in the sewing order: a click on the group row picks its shapes, double-click renames it, the caret
 *     folds it, dragging the group row moves the block, dragging a shape into and out of the group works;
 *   - Shift+Cmd/Ctrl+G ungroups; undo / redo bring the group back and forth;
 *   - "Selection only" in the export menu downloads a .dst of just the group, with the stitches the engine
 *     makes for those shapes alone; the normal export is still the whole design; Shift+Cmd/Ctrl+E too;
 *   - the right-click menu offers Ungroup on a group and Group on loose shapes;
 *   - the design file is version 2 with groups and opens again with them; without groups it stays version 1;
 *   - phone width 390: the layers sheet shows the group, no sideways scroll;
 *   - the page logs no errors.
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
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.embroidr': 'application/json' };
const SHOTS = process.env.EMB_SHOTS || fs.mkdtempSync(path.join(os.tmpdir(), 'emb-groups-shots-'));
const DOWNLOADS = fs.mkdtempSync(path.join(os.tmpdir(), 'emb-groups-dl-'));
const HAS_LINEART = fs.existsSync(path.join(REPO, 'js', 'engine', 'lineart.js'));
fs.mkdirSync(SHOTS, { recursive: true });

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

const MODS = { alt: 1, ctrl: 2, meta: 4, shift: 8 };
async function chrome(debugPort) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'emb-groups-prof-'));
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
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });   /* the editor is light only */
  /* a first-visit tutorial (if the page has one) would cover the stage */
  await send('Page.addScriptToEvaluateOnNewDocument', { source: "try{localStorage.setItem('el-tutorial-v1','done')}catch(e){}" });
  await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DOWNLOADS }).catch(() => send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: DOWNLOADS }));
  const api = {
    errors,
    async goto(url) { const loaded = new Promise(r => { handlers['Page.loadEventFired'] = () => r(); }); await send('Page.navigate', { url }); await loaded; },
    async viewport(w, h, mobile) { await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: !!mobile }); },
    async eval(expr) {
      const r = await send('Runtime.evaluate', { expression: '(async function(){' + expr + '})()', awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error('eval: ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text));
      return r.result.value;
    },
    async mouse(type, x, y, extra) { await send('Input.dispatchMouseEvent', Object.assign({ type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, pointerType: 'mouse' }, extra || {})); },
    async click(x, y, mods, count) {
      const m = mods || 0, n = count || 1;
      await api.mouse('mouseMoved', x, y, { buttons: 0, button: 'none', modifiers: m });
      for (let i = 1; i <= n; i++) { await api.mouse('mousePressed', x, y, { modifiers: m, clickCount: i }); await api.mouse('mouseReleased', x, y, { modifiers: m, clickCount: i }); }
    },
    async rightClick(x, y) {
      await api.mouse('mouseMoved', x, y, { buttons: 0, button: 'none' });
      await api.mouse('mousePressed', x, y, { button: 'right', buttons: 2 }); await api.mouse('mouseReleased', x, y, { button: 'right', buttons: 0 });
    },
    async drag(x0, y0, x1, y1, steps) {
      await api.mouse('mouseMoved', x0, y0, { buttons: 0, button: 'none' }); await api.mouse('mousePressed', x0, y0);
      steps = steps || 10;
      for (let i = 1; i <= steps; i++) await api.mouse('mouseMoved', x0 + (x1 - x0) * i / steps, y0 + (y1 - y0) * i / steps);
      await api.mouse('mouseReleased', x1, y1);
    },
    async key(key, code, keyCode, mods) {
      const m = mods || 0;
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: keyCode, modifiers: m, text: key.length === 1 && !(m & (MODS.meta | MODS.ctrl)) ? key : undefined });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode, modifiers: m });
    },
    async type(text) { for (const ch of text) await send('Input.dispatchKeyEvent', { type: 'char', text: ch }); },
    async shot(name) {
      const r = await send('Page.captureScreenshot', { format: 'png' });
      const file = path.join(SHOTS, name); fs.writeFileSync(file, Buffer.from(r.data, 'base64')); return file;
    },
    async close() { try { ws.close(); } catch (e) { /* closed */ } child.kill(); await wait(200); try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* busy */ } }
  };
  return api;
}

function shape(id, x, y, color) { return { id, name: id, type: 'rect', x, y, w: 22, h: 18, color, paint: 'fill', lineType: 'running', lineWidth: 3, spacing: 0.4, stitchLen: 3, angle: 0, pattern: 'smooth' }; }
const DOC = { name: 'group test', hoop: { w: 130, h: 180 }, objects: [shape('A', 15, 20, '#c0392b'), shape('B', 45, 30, '#2e8b57'), shape('C', 80, 20, '#1f3a5f'), shape('D', 30, 110, '#e0a526')] };

(async () => {
  if (!CHROME) { console.log('  skip: Google Chrome not found (set CHROME_PATH)'); return; }
  const port = +process.env.EMB_TEST_PORT || 8200 + Math.floor(Math.random() * 800);
  const server = await serve(port);
  const c = await chrome(9400 + Math.floor(Math.random() * 400));
  const ev = e => c.eval(e);
  const shots = [];
  /* Cmd on a Mac, Ctrl elsewhere: the page reads either */
  const MOD = MODS.meta;
  try {
    await c.viewport(1440, 900);
    await c.goto('http://127.0.0.1:' + port + '/app.html');
    for (let i = 0; i < 50 && !(await ev('return document.documentElement.getAttribute("data-editor") === "ready"')); i++) await wait(100);
    await ev('Editor.Model.load(' + JSON.stringify(DOC) + '); Editor.View.fit(); return 1;');
    await wait(600);
    const px = (x, y) => ev('var p = Editor.View.toPx(' + x + ',' + y + '), r = document.getElementById("main-canvas").getBoundingClientRect(); return { x: r.left + p.x, y: r.top + p.y };');
    const sel = () => ev('return Editor.Model.selection.slice().sort().join(",")');
    const order = () => ev('return Editor.Model.doc.objects.map(function(o){ return o.id + (o.group ? "*" : ""); }).join(",")');
    const fullBytes = () => ev('var r = Engine.generate(Editor.Model.toEngine()), f = Engine.export(r, { format: "pes", name: "x" }), h = 0; for (var i = 0; i < f.bytes.length; i++) h = (h * 31 + f.bytes[i]) >>> 0; return { n: f.bytes.length, h: h, engine: JSON.stringify(Editor.Model.toEngine()) };');
    const before = await fullBytes();

    /* ---- 1. Shift-click two shapes, Cmd+G */
    let a = await px(26, 29), b = await px(56, 39);
    await c.click(a.x, a.y); await c.click(b.x, b.y, MODS.shift);
    ok((await sel()) === 'A,B', 'click and Shift-click pick A and B');
    await c.key('g', 'KeyG', 71, MOD);
    await wait(500);
    let r = await ev(`var M = Editor.Model, g = M.groups()[0];
      var head = document.querySelector('.layer--group'), kids = document.querySelectorAll('.layer--child');
      return { n: M.groups().length, name: g && g.name, members: g && M.members(g.id).join(','), label: M.undoLabel(), head: head && head.querySelector('.name').textContent,
        kids: kids.length, sel: M.selection.slice().sort().join(','), headSel: head && head.getAttribute('aria-selected'), btn: document.getElementById('layer-group').getAttribute('aria-label') };`);
    ok(r.n === 1 && r.name === 'Group 1' && r.members === 'A,B' && r.label === 'Group', 'Cmd+G makes "Group 1" of A and B as one undo step');
    ok(r.head === 'Group 1' && r.kids === 2 && r.headSel === 'true' && r.sel === 'A,B', 'the sewing order shows a group row (selected) with its 2 shapes indented');
    ok(r.btn === 'Ungroup', 'the header button turns into Ungroup for a selected group');
    const after = await fullBytes();
    ok(after.engine === before.engine && after.n === before.n && after.h === before.h, 'engine input and the exported .pes bytes are identical after grouping (' + after.n + ' bytes)');
    await wait(400);
    r = await ev(`var M = Editor.Model, res = Editor.IO.result, sum = 0; res.objects.forEach(function (o) { if (o.id === 'A' || o.id === 'B') sum += o.stitches; });
      return { sum: sum, text: document.querySelector('.layer--group .count').textContent.replace(/[^0-9]/g, '') };`);
    ok(+r.text === r.sum && r.sum > 0, 'the group row shows the stitches of its shapes: ' + r.text);
    shots.push(await c.shot('groups-1-grouped.png'));

    /* ---- 2. canvas: click picks the group, drag moves it, double-click enters, Esc steps out */
    const empty = await px(110, 160);
    await c.click(empty.x, empty.y);
    ok((await sel()) === '', 'a click on the empty hoop clears the selection');
    a = await px(26, 29);
    await c.click(a.x, a.y);
    ok((await sel()) === 'A,B', 'a click on a grouped shape picks the whole group');
    const pos0 = await ev('var M = Editor.Model; return [M.get("A").x, M.get("B").x, M.get("C").x];');
    const to = await px(36, 29);
    await c.drag(a.x, a.y, to.x, to.y);
    await wait(300);
    const pos1 = await ev('var M = Editor.Model; return [M.get("A").x, M.get("B").x, M.get("C").x, M.undoLabel()];');
    ok(Math.abs(pos1[0] - pos0[0] - 10) < 0.6 && Math.abs(pos1[1] - pos0[1] - 10) < 0.6 && pos1[2] === pos0[2] && pos1[3] === 'Move', 'dragging one grouped shape moves the whole group 10 mm (A ' + pos0[0] + ' -> ' + pos1[0] + ', B ' + pos0[1] + ' -> ' + pos1[1] + ')');
    b = await px(pos1[1] + 11, 39);
    await c.click(b.x, b.y, 0, 2);
    await wait(150);
    ok((await sel()) === 'B', 'a double-click picks just B inside the group');
    a = await px(pos1[0] + 11, 29);
    await c.click(a.x, a.y);
    ok((await sel()) === 'A', 'inside the group, a click picks the sibling A alone');
    shots.push(await c.shot('groups-2-inside.png'));
    await c.key('Escape', 'Escape', 27);
    ok((await sel()) === 'A,B', 'Esc steps out to the whole group');
    await c.key('Escape', 'Escape', 27);
    ok((await sel()) === '', 'a second Esc clears the selection');
    /* marquee touching one grouped shape takes the group */
    const m0 = await px(pos1[0] - 4, 15), m1 = await px(pos1[0] + 4, 24);
    await c.drag(m0.x, m0.y, m1.x, m1.y);
    ok((await sel()) === 'A,B', 'a marquee touching one grouped shape picks the group');

    /* ---- 3. sewing order: click, rename, fold, drag in / out */
    await c.click(empty.x, empty.y);
    const rowBox = sel2 => ev('var e = ' + sel2 + '; if (!e) return null; e.scrollIntoView({ block: "nearest" }); var b = e.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2, top: b.top, bottom: b.bottom, left: b.left };');
    const rowOf = id => 'Array.prototype.find.call(document.querySelectorAll(".layer"), function (r) { return r._id === ' + JSON.stringify(id) + '; })';
    let head = await rowBox('document.querySelector(".layer--group")');
    await c.click(head.x - 40, head.y);
    ok((await sel()) === 'A,B', 'a click on the group row picks its shapes');
    await c.click(head.x - 40, head.y, 0, 2);
    await wait(150);
    const hasInput = await ev('return !!document.querySelector(".layer--group .layer__rename")');
    ok(hasInput, 'a double-click on the group row opens the name field');
    await ev('document.querySelector(".layer__rename").select(); return 1;');
    await c.type('Logo');
    await c.key('Enter', 'Enter', 13);
    await wait(200);
    ok((await ev('return Editor.Model.groups()[0].name + "|" + Editor.Model.undoLabel()')) === 'Logo|Rename', 'typing a name and Enter renames the group (one undo step)');
    head = await rowBox('document.querySelector(".layer--group")');
    const caret = await rowBox('document.querySelector(".layer--group .layer__caret")');
    await c.click(caret.x, caret.y);
    await wait(100);
    r = await ev('return { kids: document.querySelectorAll(".layer--child").length, exp: document.querySelector(".layer--group").getAttribute("aria-expanded"), rows: document.querySelectorAll(".layer").length }');
    ok(r.kids === 0 && r.exp === 'false' && r.rows === 3, 'the caret folds the group: 3 rows, no shapes under it');
    shots.push(await c.shot('groups-3-folded.png'));
    await c.click(caret.x, caret.y);
    ok((await ev('return document.querySelectorAll(".layer--child").length')) === 2, 'and unfolds it');
    /* drag the group row below D: the block moves */
    head = await rowBox('document.querySelector(".layer--group")');
    let dRow = await rowBox(rowOf('D'));
    await c.drag(head.x - 40, head.y, dRow.x - 40, dRow.bottom - 3, 12);
    await wait(300);
    ok((await order()) === 'C,D,A*,B*' && (await ev('return Editor.Model.undoLabel()')) === 'Reorder', 'dragging the group row below D moves A and B as one block: ' + (await order()));
    /* drag D into the group: onto the lower half of A's row */
    dRow = await rowBox(rowOf('D'));
    let aRow = await rowBox(rowOf('A'));
    await c.drag(dRow.x - 40, dRow.y, aRow.x - 40, aRow.bottom - 4, 12);
    await wait(300);
    r = await ev('var M = Editor.Model, g = M.groups()[0]; return { members: M.members(g.id).join(","), label: M.undoLabel() };');
    ok(r.members === 'A,D,B' && r.label === 'Move into group', 'dragging D onto the lower half of A puts it in the group after A: ' + r.members);
    shots.push(await c.shot('groups-4-moved-in.png'));
    /* and out again: onto the upper half of the first row (C) */
    dRow = await rowBox(rowOf('D'));
    const cRow = await rowBox(rowOf('C'));
    await c.drag(dRow.x - 40, dRow.y, cRow.x - 40, cRow.top + 4, 12);
    await wait(300);
    ok((await order()) === 'D,C,A*,B*' && (await ev('return Editor.Model.undoLabel()')) === 'Move out of group', 'dragging D to the top takes it out of the group: ' + (await order()));
    await c.key('z', 'KeyZ', 90, MOD); await c.key('z', 'KeyZ', 90, MOD);
    ok((await order()) === 'C,D,A*,B*', 'two undos put D back where it was, loose');
    await c.key('z', 'KeyZ', 90, MOD | MODS.shift);
    ok((await ev('var M = Editor.Model; return M.members(M.groups()[0].id).join(",")')) === 'A,D,B', 'redo puts it in the group again');
    await c.key('z', 'KeyZ', 90, MOD);

    /* ---- 4. ungroup, undo, redo */
    await ev('var M = Editor.Model; M.select(M.members(M.groups()[0].id)); return 1;');
    await c.key('G', 'KeyG', 71, MOD | MODS.shift);
    r = await ev('var M = Editor.Model; return { n: M.groups().length, sel: M.selection.slice().sort().join(","), label: M.undoLabel(), rows: document.querySelectorAll(".layer--group").length };');
    ok(r.n === 0 && r.sel === 'A,B' && r.label === 'Ungroup' && r.rows === 0, 'Shift+Cmd+G ungroups and keeps the shapes picked');
    await c.key('z', 'KeyZ', 90, MOD);
    ok((await ev('var M = Editor.Model; return M.groups().length + ":" + M.groups()[0].name')) === '1:Logo', 'undo brings the group back with its name');
    await c.key('z', 'KeyZ', 90, MOD | MODS.shift);
    ok((await ev('return Editor.Model.groups().length')) === 0, 'redo ungroups again');
    await c.key('z', 'KeyZ', 90, MOD);

    /* ---- 5. export: the selection only, and the whole design */
    await ev('var M = Editor.Model; M.select(M.members(M.groups()[0].id)); return 1;');
    await wait(400);
    await ev('document.getElementById("btn-export-menu").click(); return 1;');
    await wait(150);
    const only = await rowBox('document.getElementById("export-only-sel")');
    await c.click(only.x, only.y);
    r = await ev('var b = document.getElementById("export-only-sel"); return { checked: b.getAttribute("aria-checked"), note: b.querySelector("small").textContent, open: !document.getElementById("export-menu").hidden };');
    ok(r.checked === 'true' && r.open && /Logo/.test(r.note), 'the export menu has "Selection only"; it switches on: "' + r.note + '"');
    shots.push(await c.shot('groups-5-export-menu.png'));
    const dst = await rowBox('document.querySelector("#export-menu [data-format=dst]")');
    await c.click(dst.x, dst.y);
    for (let i = 0; i < 40 && !(await ev('return !!(Editor.IO.lastExport && Editor.IO.lastExport.selection)')); i++) await wait(100);
    r = await ev(`var M = Editor.Model, ids = M.selection, d = M.toEngine(); d.objects = d.objects.filter(function (o) { return ids.indexOf(o.id) !== -1; });
      var res = Engine.generate(d), full = Editor.IO.result; return { last: Editor.IO.lastExport, partStitches: res.totals.stitches, fullStitches: full.totals.stitches };`);
    await wait(500);
    let files = fs.readdirSync(DOWNLOADS);
    ok(r.last && r.last.selection && r.last.format === 'dst' && r.last.objects === 2 && r.last.stitches === r.partStitches && r.partStitches < r.fullStitches,
      'Selection only + DST exports just the group: ' + (r.last && r.last.filename) + ', ' + (r.last && r.last.stitches) + ' stitches (the whole design has ' + r.fullStitches + ')');
    ok(files.some(f => /^Logo\.dst$/.test(f)), 'the browser saved ' + files.join(', '));
    const dstBytes = files.includes('Logo.dst') ? fs.readFileSync(path.join(DOWNLOADS, 'Logo.dst')) : null;
    ok(dstBytes && dstBytes.length > 512, 'the .dst file is ' + (dstBytes ? dstBytes.length : 0) + ' bytes');
    ok((await ev('return document.getElementById("export-only-sel").getAttribute("aria-checked")')) === 'false', '"Selection only" is off again when the menu is opened next');
    await ev('document.getElementById("btn-export").click(); return 1;');
    for (let i = 0; i < 40 && !(await ev('return !!(Editor.IO.lastExport && !Editor.IO.lastExport.selection)')); i++) await wait(100);
    r = await ev('return { last: Editor.IO.lastExport, full: Editor.IO.result.totals.stitches };');
    ok(r.last && !r.last.selection && r.last.objects === 4 && r.last.stitches === r.full, 'the Export button still makes the whole design: ' + r.last.stitches + ' stitches');
    await c.key('E', 'KeyE', 69, MOD | MODS.shift);
    for (let i = 0; i < 40 && !(await ev('return !!(Editor.IO.lastExport && Editor.IO.lastExport.selection && Editor.IO.lastExport.format === "pes")')); i++) await wait(100);
    ok(await ev('return !!(Editor.IO.lastExport && Editor.IO.lastExport.selection && Editor.IO.lastExport.format === "pes" && Editor.IO.lastExport.objects === 2)'), 'Shift+Cmd+E exports the selection as .pes');

    /* ---- 6. right-click menu */
    await c.click(empty.x, empty.y);
    let cpt = await px(await ev('return Editor.Model.get("A").x + 5'), 29);
    await c.rightClick(cpt.x, cpt.y);
    await wait(150);
    r = await ev('var m = document.getElementById("context-menu"); return m ? { items: Array.prototype.map.call(m.querySelectorAll("button"), function (b) { return b.textContent; }), sel: Editor.Model.selection.slice().sort().join(",") } : null;');
    ok(r && r.sel === 'A,B' && /^Ungroup/.test(r.items[0]) && r.items.some(t => /Export selection/.test(t)), 'right-click on a grouped shape picks the group and offers ' + (r ? r.items.join(' | ') : 'nothing'));
    shots.push(await c.shot('groups-6-context.png'));
    await c.key('Escape', 'Escape', 27);
    ok(await ev('return !document.getElementById("context-menu")'), 'Esc closes the right-click menu');
    cpt = await px(91, 29);
    await c.rightClick(cpt.x, cpt.y);
    await wait(100);
    r = await ev('var m = document.getElementById("context-menu"); return m ? m.querySelector("button").textContent : null;');
    ok(/^Group/.test(r || ''), 'on a loose shape it offers Group');
    await ev('document.querySelector("#context-menu button").click(); return 1;');
    ok((await ev('return Editor.Model.groups().length')) === 2, 'and Group from the menu makes a second group');
    await c.key('z', 'KeyZ', 90, MOD);

    /* ---- 7. design file: version 2 with groups, opens again; version 1 without */
    r = await ev(`var IO = Editor.IO, M = Editor.Model, f = IO.projectFile(), data = JSON.parse(f.text);
      var groups = JSON.stringify(M.groups()), order = M.doc.objects.map(function (o) { return o.id + ':' + (o.group || ''); }).join(',');
      M.load(null); IO.applyPayload(JSON.parse(f.text));
      var back = { v: data.v, groups: JSON.stringify(M.groups()) === groups, order: M.doc.objects.map(function (o) { return o.id + ':' + (o.group || ''); }).join(',') === order };
      M.ungroup(M.doc.objects.map(function (o) { return o.id; }));
      back.v1 = JSON.parse(IO.projectFile().text).v; back.noKey = !('groups' in JSON.parse(IO.projectFile().text).doc);
      M.undo(); return back;`);
    ok(r.v === 2 && r.groups && r.order, 'Save writes a version 2 file with the group, and Open gives the same groups and order');
    ok(r.v1 === 1 && r.noKey, 'a design without groups is still saved as version 1, without a groups key');
    await wait(500);
    r = await ev(`var IO = Editor.IO; IO.saveNow(); var stored = JSON.parse(localStorage.getItem(IO.KEY)); return { v: stored.v, groups: (stored.doc.groups || []).length };`);
    ok(r.v === 2 && r.groups === 1, 'the autosave keeps the group too');
    shots.push(await c.shot('groups-7-desktop.png'));

    /* ---- 8. reload: the group comes back from the autosave */
    await c.goto('http://127.0.0.1:' + port + '/app.html');
    for (let i = 0; i < 50 && !(await ev('return document.documentElement.getAttribute("data-editor") === "ready"')); i++) await wait(100);
    await wait(500);
    ok((await ev('return Editor.Model.groups().length + ":" + (Editor.Model.groups()[0] || {}).name + ":" + document.querySelectorAll(".layer--group").length')) === '1:Logo:1', 'after a reload the group is back, in the sewing order too');

    /* ---- 9. phone */
    await c.viewport(390, 844, true);
    await wait(400);
    await ev('Editor.Model.select(Editor.Model.members(Editor.Model.groups()[0].id)); Editor.sheet.tab("side"); Editor.sheet.set("half"); return 1;');
    await wait(500);
    r = await ev('var h = document.querySelector(".layer--group"), b = h && h.getBoundingClientRect(); return { sw: document.documentElement.scrollWidth, vw: window.innerWidth, visible: !!(b && b.width > 0 && b.height > 0), kids: document.querySelectorAll(".layer--child").length };');
    ok(r.sw <= r.vw && r.visible && r.kids === 2, 'phone 390: the layers sheet shows the group and its shapes, no sideways scroll (' + r.sw + ' / ' + r.vw + ')');
    shots.push(await c.shot('groups-8-phone.png'));

    await wait(300);
    ok(c.errors.length === 0, 'no console errors' + (c.errors.length ? ':\n       ' + c.errors.join('\n       ') : ''));
    console.log('  screenshots: ' + shots.join(', '));
  } catch (e) {
    failed++; console.log('  FAIL ' + (e && e.stack || e));
  } finally {
    await c.close(); server.close();
    try { fs.rmSync(DOWNLOADS, { recursive: true, force: true }); } catch (e) { /* busy */ }
  }
  console.log((failed ? 'FAILED ' + failed + ', ' : '') + passed + ' passed');
  process.exit(failed ? 1 : 0);
})();
