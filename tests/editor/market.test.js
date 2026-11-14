/*
 * The marketplace on its DEMO backend (EL_CONFIG.apiBase null), in headless Chrome against the real pages.
 *
 *   node tests/editor/market.test.js       (CHROME_PATH for the binary, EMB_TEST_PORT for the static server,
 *                                           EMB_SHOTS=<dir> to keep screenshots)
 *
 * Proves, with real clicks where it matters:
 *   - market.html seeds itself from designs/index.json: the starter designs belong to @embroidr, two cost keys,
 *     one is show only; the demo note and the wallet show; sort Top, a tag and search filter the grid;
 *   - star / unstar change the count and stick; your own design cannot be starred;
 *   - unlock with keys spends them and opens the design; a dearer one says "not enough keys" in the sheet;
 *     a show-only file is never handed out;
 *   - in the editor, File > Share to Marketplace publishes the design with a stitch picture, and
 *     app.html?market=<id> opens a marketplace design in a tab;
 *   - profile.html: badges, an activity graph of 371 cells, Public / Private tabs, the visibility toggle,
 *     the mode select and Delete (asked in place, no browser dialog);
 *   - no sideways scroll at 390 px, no errors in the console.
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
const SHOTS = process.env.EMB_SHOTS || fs.mkdtempSync(path.join(os.tmpdir(), 'emb-market-shots-'));
fs.mkdirSync(SHOTS, { recursive: true });
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
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'emb-market-prof-'));
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
      if (!(HAS_LINEART === false && /\/js\/engine\/lineart\.js$/.test(url)) && !/fonts\.(googleapis|gstatic)\.com/.test(url)) errors.push('log ' + m.params.entry.text + ' ' + url);
    }
    if (handlers[m.method]) handlers[m.method](m.params);
  };
  const send = (method, params) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params: params || {} })); });
  await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable');
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
    async click(x, y) { await api.mouse('mouseMoved', x, y, { buttons: 0, button: 'none' }); await api.mouse('mousePressed', x, y); await api.mouse('mouseReleased', x, y); },
    /* a real click in the middle of the element */
    async clickSel(sel) {
      const r = await api.eval('var e = document.querySelector(' + JSON.stringify(sel) + '); if (!e) return null; e.scrollIntoView({ block: "center" }); var b = e.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 };');
      if (!r) throw new Error('no element ' + sel);
      await api.click(r.x, r.y);
    },
    async shot(name, full) {
      let clip;
      if (full) { const mtr = await send('Page.getLayoutMetrics'); clip = { x: 0, y: 0, width: mtr.cssContentSize.width, height: Math.min(mtr.cssContentSize.height, 5000), scale: 1 }; }
      const r = await send('Page.captureScreenshot', Object.assign({ format: 'png', captureBeyondViewport: !!full }, clip ? { clip } : {}));
      const file = path.join(SHOTS, name); fs.writeFileSync(file, Buffer.from(r.data, 'base64')); return file;
    },
    async close() { try { ws.close(); } catch (e) { /* closed */ } child.kill(); await wait(200); try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* busy */ } }
  };
  return api;
}

(async () => {
  if (!CHROME) { console.log('  skip: Google Chrome not found (set CHROME_PATH)'); return; }
  const port = +process.env.EMB_TEST_PORT || 8200 + Math.floor(Math.random() * 800);
  const server = await serve(port);
  const c = await chrome(9400 + Math.floor(Math.random() * 400));
  const ev = e => c.eval(e);
  const BASE = 'http://127.0.0.1:' + port + '/';
  const until = async (expr, ms) => { for (let t = 0; t < (ms || 6000); t += 100) { if (await ev('return !!(' + expr + ')')) return true; await wait(100); } return false; };
  const card = id => '.mk-card[data-id="' + id + '"]';
  try {
    await c.viewport(1440, 900);

    /* ---- 1. the market seeds itself */
    await c.goto(BASE + 'market.html');
    ok(await until('document.querySelectorAll(".mk-card").length >= 11'), 'market.html lists the seeded designs');
    ok(await ev('return MarketAPI.demo === true'), 'with apiBase null the demo backend is used');
    ok(await ev('return !document.getElementById("mk-demo").hidden && /Demo — saved on this device until sign-in is switched on\\./.test(document.getElementById("mk-demo").textContent)'), 'the demo note shows');
    const seeded = await ev('var r = await MarketAPI.list({ sort: "new" }); return r.items.map(function (i) { return [i.id, i.owner.handle, i.mode, i.priceKeys]; });');
    const house = seeded.filter(s => s[1] === 'embroidr');
    ok(house.length === 10 && house.filter(s => s[2] === 'keys').length === 2 && house.filter(s => s[2] === 'show').length === 1, 'the 10 starters are @embroidr: 2 for keys, 1 show only, the rest free');
    ok(await until('!document.getElementById("wallet").hidden'), 'the wallet strip shows');
    const w0 = await ev('return MarketAPI.wallet()');
    ok(w0.starsReceived === 24 && w0.keys === 2 && w0.discountPct === 0, 'the demo visitor starts with 24 stars received and 2 keys (got ' + w0.starsReceived + ', ' + w0.keys + ')');
    ok(await ev('return /First 5 to 10,000 stars get their design sewn free/.test(document.getElementById("wallet").textContent) && /off your next sew-out/.test(document.getElementById("wallet").textContent)'), 'the wallet names the sew-out discount and the 10,000-star goal');
    await c.shot('market-desktop.png', true);

    /* ---- 2. star / unstar */
    const before = await ev('return MarketAPI.get("bee")');
    await c.clickSel(card('bee') + ' .star');
    ok(await until('document.querySelector(\'' + card('bee') + ' .star\').getAttribute("aria-pressed") === "true"'), 'clicking the star marks it');
    await wait(150);
    const starred = await ev('return MarketAPI.get("bee")');
    ok(starred.starred === true && starred.stars === before.stars + 1, 'the star is counted: ' + before.stars + ' -> ' + starred.stars);
    ok(await ev('return document.querySelector(\'' + card('bee') + ' .star .num\').textContent') === String(before.stars + 1), 'the card shows the new count');
    await c.clickSel(card('bee') + ' .star');
    await wait(250);
    const unstarred = await ev('return MarketAPI.get("bee")');
    ok(unstarred.starred === false && unstarred.stars === before.stars, 'clicking again unstars it');
    ok(await ev('return document.querySelector(\'' + card('star-patch') + ' .star\').disabled'), 'your own design cannot be starred');
    ok(await ev('try { await MarketAPI.star("star-patch"); return false; } catch (e) { return e.code === "own-design"; }'), 'the backend refuses a star on your own design too');

    /* ---- 3. sort, tag, search */
    await c.clickSel('[data-sort="top"]');
    ok(await until('document.querySelector(".mk-card") && document.querySelector(".mk-card").getAttribute("data-id") === "anime-girl"'), 'Top puts the most-starred design first');
    await c.clickSel('[data-sort="new"]');
    await ev('[].find.call(document.querySelectorAll("#mk-tags button"), function (b) { return b.textContent === "Bugs"; }).click(); return 1');
    ok(await until('document.querySelectorAll(".mk-card").length === 4'), 'the Bugs tag shows the four insects');
    await ev('[].find.call(document.querySelectorAll("#mk-tags button"), function (b) { return b.textContent === "All"; }).click(); return 1');
    await ev('var q = document.getElementById("mk-q"); q.value = "lotus"; q.dispatchEvent(new Event("input", { bubbles: true })); return 1');
    ok(await until('document.querySelectorAll(".mk-card").length === 1 && document.querySelector(".mk-card").getAttribute("data-id") === "lotus"'), 'search finds one design');
    await ev('var q = document.getElementById("mk-q"); q.value = ""; q.dispatchEvent(new Event("input", { bubbles: true })); return 1');
    await until('document.querySelectorAll(".mk-card").length >= 11');

    /* ---- 4. unlock with keys */
    await c.clickSel(card('butterfly') + ' .mk-card__pic');
    ok(await until('document.getElementById("mk-sheet").open && document.getElementById("mk-unlock")'), 'the detail sheet opens with "Unlock for 2 keys"');
    ok(/Unlock for 2 keys/.test(await ev('return document.getElementById("mk-unlock").textContent')), 'the unlock button names the price');
    ok(await ev('return /stitches/.test(document.querySelector(".mk-stats").textContent) && /inches/.test(document.querySelector(".mk-stats").textContent)'), 'the sheet shows stitches, colours and size in inches');
    await c.shot('market-sheet-locked.png');
    await c.clickSel('#mk-unlock');
    ok(await until('document.getElementById("mk-open")'), 'after unlocking, "Open in Embroidr" is there');
    ok((await ev('return document.getElementById("mk-open").getAttribute("href")')) === 'app.html?market=butterfly', 'it links to app.html?market=butterfly');
    const w1 = await ev('return MarketAPI.wallet()');
    ok(w1.keys === 0 && w1.keysSpent === 2, 'the two keys are spent');
    ok(await ev('var f = await MarketAPI.file("butterfly"); return !!(f && f.doc && f.doc.objects.length)'), 'the unlocked file is handed out');
    await ev('EL.dialog.close("mk-sheet"); return 1');
    await c.clickSel(card('lotus') + ' .mk-card__pic');
    await until('document.getElementById("mk-unlock")');
    await c.clickSel('#mk-unlock');
    ok(await until('/Not enough keys yet: this one needs 3 and you have 0/.test(document.getElementById("mk-msg").textContent)'), 'a dearer design says there are not enough keys, in the sheet');
    await c.shot('market-sheet-not-enough.png');
    ok(await ev('try { await MarketAPI.file("lotus"); return false; } catch (e) { return e.code === "locked" && e.status === 403; }'), 'a locked file is refused (403 locked)');
    ok(await ev('try { await MarketAPI.unlock("lotus"); return false; } catch (e) { return e.code === "not-enough-keys" && e.status === 402; }'), 'unlock answers 402 not-enough-keys');
    await ev('EL.dialog.close("mk-sheet"); return 1');
    await c.clickSel(card('smiling-man') + ' .mk-card__pic');
    await until('document.getElementById("mk-sheet").open && document.getElementById("mk-msg")');
    ok(await ev('return !document.getElementById("mk-open") && !document.getElementById("mk-unlock") && /Show only/.test(document.getElementById("mk-msg").textContent)'), 'a show-only design has no open or unlock button');
    ok(await ev('try { await MarketAPI.file("smiling-man"); return false; } catch (e) { return e.code === "locked"; }'), 'a show-only file is never handed out');
    await ev('EL.dialog.close("mk-sheet"); return 1');

    /* ---- 5. publish from the editor, open a marketplace design */
    await c.goto(BASE + 'app.html');
    ok(await until('document.documentElement.getAttribute("data-editor") === "ready" && window.Editor && Editor.Share', 10000), 'the editor starts with the share module');
    ok(await ev('return !!document.querySelector("#file-menu [data-file=share]") && !!document.getElementById("btn-market")'), 'the File menu has "Share to Marketplace" and the bar a Marketplace link');
    await ev('document.getElementById("btn-example").click(); return 1');
    await until('Editor.Model.doc.objects.length === 2');
    await c.clickSel('#btn-file');
    await c.clickSel('#file-menu [data-file="share"]');
    ok(await until('document.getElementById("share") && document.getElementById("share").open'), 'File > Share to Marketplace opens the dialog');
    ok(await until('document.querySelector("#share-pic img")', 15000), 'the dialog shows a stitch picture of the design');
    await ev('var t = document.getElementById("share-name"); t.value = "Test badge"; document.querySelector("#share-tags [data-tag=patches]").click(); document.querySelector("#share-mode [data-v=keys]").click(); return 1');
    await c.shot('editor-share.png');
    await c.clickSel('#share-publish');
    ok(await until('!document.getElementById("share").open && [].some.call(document.querySelectorAll(".toast"), function (t) { return /Test badge is shared/.test(t.textContent) && /View/.test(t.textContent); })'), 'Publish closes the dialog and the toast offers View');
    const pub = await ev('var r = await MarketAPI.list({ q: "Test badge" }); return r.items[0] || null;');
    ok(pub && pub.mine && pub.mode === 'keys' && pub.priceKeys === 2 && pub.tags.indexOf('patches') !== -1 && /^data:image\/(webp|png);base64,/.test(pub.thumb), 'the design is in the market: yours, 2 keys, tagged, with a picture');
    ok(pub && pub.stats && pub.stats.stitches > 0, 'it carries its stitch count');
    await c.goto(BASE + 'app.html?market=butterfly');
    ok(await until('document.documentElement.getAttribute("data-editor") === "ready" && Editor.Model.doc.name === "butterfly"', 10000), 'app.html?market=butterfly opens the unlocked design');
    ok(await ev('return Editor.Tabs ? Editor.Tabs.designs().length >= 2 : true'), 'in a tab of its own');
    ok(await ev('return location.search === ""'), 'and the address is cleaned');
    await c.goto(BASE + 'app.html?market=lotus');
    ok(await until('[].some.call(document.querySelectorAll(".toast"), function (t) { return /locked/.test(t.textContent); })', 8000), 'a locked design is not opened and the toast says why');

    /* ---- 6. profile */
    await c.goto(BASE + 'profile.html?u=you');
    ok(await until('document.querySelector(".graph svg")'), 'profile.html renders');
    ok(await ev('return document.querySelectorAll(".graph svg rect").length') === 371, 'the activity graph has 371 cells (53 weeks x 7 days)');
    ok(await ev('return document.querySelectorAll(".graph svg text").length >= 10'), 'with month and day labels');
    ok(await ev('return document.querySelectorAll(".badges .badge").length === MarketRules.BADGES.length && document.querySelectorAll(".badges .badge:not(.is-off)").length >= 3'), 'the badges row shows earned and not-yet badges');
    const tipText = await ev('var r = document.querySelector(".graph rect[data-n]:not([data-n=\'0\'])"); r.dispatchEvent(new PointerEvent("pointerover", { bubbles: true })); return document.querySelector(".tip-float").textContent;');
    ok(/^\d+ things? on (Sun|Mon|Tue|Wed|Thu|Fri|Sat), [A-Z][a-z]{2} \d{1,2}$/.test(tipText), 'a cell says what was done that day: "' + tipText + '"');
    ok(await ev('return /Public\\s*2/.test(document.querySelector(".pf-tabs").textContent) && document.querySelectorAll(".pf-row").length === 2'), 'your Public tab lists your two designs');
    await c.shot('profile-own.png', true);
    await c.clickSel('.pf-row[data-id="star-patch"] [data-vis="private"]');
    ok(await until('document.querySelectorAll(".pf-row").length === 1'), 'Private moves the design out of the Public tab');
    ok((await ev('return MarketAPI.get("star-patch")')).visibility === 'private', 'the design is private now');
    ok(!(await ev('var r = await MarketAPI.list({}); return r.items.some(function (i) { return i.id === "star-patch"; });')), 'and no longer listed in the market');
    await c.clickSel('.pf-tabs [data-tab="private"]');
    ok(await until('document.querySelector(\'.pf-row[data-id="star-patch"]\')'), 'it is on the Private tab');
    await c.clickSel('.pf-row[data-id="star-patch"] [data-vis="public"]');
    await until('(await MarketAPI.get("star-patch")).visibility === "public"');
    ok((await ev('return MarketAPI.get("star-patch")')).visibility === 'public', 'and can be made public again');
    await c.clickSel('.pf-tabs [data-tab="public"]');
    await until('document.querySelectorAll(".pf-row").length === 2');
    ok(await ev('var o = document.querySelector(\'.pf-row[data-id="star-patch"] select option[value=sell]\'); return o.disabled && /coming soon/.test(o.textContent)'), 'selling for money is shown as coming soon');
    await ev('var s = document.querySelector(\'.pf-row[data-id="star-patch"] select\'); s.value = "keys-3"; s.dispatchEvent(new Event("change", { bubbles: true })); return 1');
    await wait(300);
    const changed = await ev('return MarketAPI.get("star-patch")');
    ok(changed.mode === 'keys' && changed.priceKeys === 3, 'the mode select sets Keys: 3');
    const pid = pub && pub.id;
    await c.clickSel('.pf-row[data-id="' + pid + '"] .pf-row__del .btn');
    ok(await until('/Delete it\\?/.test(document.querySelector(\'.pf-row[data-id="' + pid + '"] .pf-row__del\').textContent)'), 'Delete asks in place');
    await c.shot('profile-delete-ask.png');
    await c.clickSel('.pf-row[data-id="' + pid + '"] .pf-row__del .btn--danger');
    ok(await until('!document.querySelector(\'.pf-row[data-id="' + pid + '"]\')'), 'Delete removes the row');
    ok(await ev('try { await MarketAPI.get(' + JSON.stringify(pid) + '); return false; } catch (e) { return e.code === "not-found"; }'), 'and the design is gone');
    await c.goto(BASE + 'profile.html?u=embroidr');
    await until('document.querySelector(".graph svg")');
    ok(await ev('return document.querySelectorAll(".mk-card").length === 10 && !document.querySelector(".pf-row")'), 'someone else\'s profile shows cards, no controls');

    /* ---- 7. phone */
    await c.viewport(390, 844, true);
    await c.goto(BASE + 'market.html');
    await until('document.querySelectorAll(".mk-card").length >= 11');
    ok(await ev('return document.documentElement.scrollWidth <= window.innerWidth'), 'market at 390 px: no sideways scroll');
    await c.shot('market-phone.png');
    await c.clickSel(card('butterfly') + ' .mk-card__pic');
    await until('document.getElementById("mk-sheet").open && document.getElementById("mk-open")');
    await c.shot('market-phone-sheet.png');
    await c.goto(BASE + 'profile.html?u=you');
    await until('document.querySelector(".graph svg")');
    ok(await ev('return document.documentElement.scrollWidth <= window.innerWidth'), 'profile at 390 px: no sideways scroll');
    await c.shot('profile-phone.png', true);

    ok(c.errors.length === 0, 'no console errors' + (c.errors.length ? ': ' + c.errors.join(' | ') : ''));
  } catch (e) {
    failed++; console.log('  FAIL ' + (e && e.stack || e));
  } finally {
    await c.close(); server.close();
    console.log('  screenshots: ' + SHOTS);
    console.log('market: ' + passed + ' passed, ' + failed + ' failed');
    process.exit(failed ? 1 : 0);
  }
})();
