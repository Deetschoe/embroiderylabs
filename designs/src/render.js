#!/usr/bin/env node
'use strict';
/*
 * Draws a design the way the Mockup view does (realistic thread on cloth) and saves it as a PNG.
 *
 *   node designs/src/render.js designs/name.embroidr out.png [size=640] [cloth=#f3efe6] [fabric=twill]
 *
 * Needs Google Chrome (headless). Starts its own small file server and its own Chrome on free ports, so
 * several can run at once. Also used by build.js for the thumbnails of the design feed.
 */
const fs = require('fs'), path = require('path'), http = require('http'), cp = require('child_process'), os = require('os');
const L = require('./lib.js');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const TYPES = { '.js': 'application/javascript', '.html': 'text/html', '.css': 'text/css', '.json': 'application/json', '.webp': 'image/webp', '.png': 'image/png' };
const PAGE = '<!doctype html><meta charset="utf-8"><title>render</title>' + ['js/engine/embwriter.js', 'js/engine/digitize.js', 'js/engine/engine.js', 'js/realistic/core.js', 'js/realistic/realistic.js'].map(s => '<script src="/' + s + '"></script>').join('');

function serve() {
  return new Promise(resolve => {
    const srv = http.createServer((req, res) => {
      const url = decodeURIComponent(req.url.split('?')[0]);
      if (url === '/__render') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(PAGE); return; }
      const file = path.join(L.ROOT, path.normalize(url).replace(/^([/\\])+/, ''));
      if (!file.startsWith(L.ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' }); fs.createReadStream(file).pipe(res);
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}
const getJson = url => new Promise((res, rej) => { http.get(url, r => { let b = ''; r.on('data', x => b += x); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } }); }).on('error', rej); });

async function open() {
  const srv = await serve(), base = 'http://127.0.0.1:' + srv.address().port;
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'el-render-'));
  const probe = http.createServer(); await new Promise(r => probe.listen(0, '127.0.0.1', r)); const port = probe.address().port; await new Promise(r => probe.close(r));
  const child = cp.spawn(CHROME, ['--headless=new', '--remote-debugging-port=' + port, '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--user-data-dir=' + prof, 'about:blank'], { stdio: 'ignore' });
  let targets = null;
  for (let i = 0; i < 100 && !targets; i++) { try { targets = await getJson('http://127.0.0.1:' + port + '/json/list'); } catch (e) { await new Promise(r => setTimeout(r, 150)); } }
  if (!targets) { child.kill(); srv.close(); throw new Error('Chrome did not start (set CHROME=/path/to/chrome)'); }
  const ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const pending = new Map(); let loaded = null;
  ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); } else if (m.method === 'Page.loadEventFired' && loaded) loaded(); };
  const send = (method, params) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params: params || {} })); });
  await send('Page.enable'); await send('Runtime.enable');
  const done = new Promise(r => { loaded = r; });
  await send('Page.navigate', { url: base + '/__render' }); await done;
  return {
    async draw(doc, size, cloth, fabric) {
      const input = JSON.stringify(L.toEngine(doc));
      const expr = '(async function(){ var r = Engine.generate(' + input + '); var blob = await Realistic.exportImage(r, { scene: "swatch", fabric: ' + JSON.stringify(fabric) + ', fabricColor: ' + JSON.stringify(cloth) + ', width: ' + size + ', height: ' + size + ', scale: 1, margin: 0.07 });' +
        ' var buf = new Uint8Array(await blob.arrayBuffer()), s = ""; for (var i = 0; i < buf.length; i += 32768) s += String.fromCharCode.apply(null, buf.subarray(i, i + 32768)); return btoa(s); })()';
      const out = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
      if (out.exceptionDetails) throw new Error((out.exceptionDetails.exception && out.exceptionDetails.exception.description) || out.exceptionDetails.text);
      return Buffer.from(out.result.value, 'base64');
    },
    async close() { try { ws.close(); } catch (e) { /* closing anyway */ } child.kill(); srv.close(); await new Promise(r => setTimeout(r, 150)); try { fs.rmSync(prof, { recursive: true, force: true }); } catch (e) { /* temp folder */ } }
  };
}
module.exports = { open };

if (require.main === module) {
  (async () => {
    const [src, out, size, cloth, fabric] = process.argv.slice(2);
    if (!src || !out) { console.error('usage: node designs/src/render.js design.embroidr out.png [size] [cloth colour] [fabric]'); process.exit(2); }
    const data = JSON.parse(fs.readFileSync(src, 'utf8')), doc = data.doc || data;
    const r = L.check(doc); console.log(path.basename(src) + ': ' + r.summary); r.problems.forEach(p => console.log('  ' + p));
    const browser = await open();
    try { fs.writeFileSync(out, await browser.draw(doc, +size || 640, cloth || '#f3efe6', fabric || 'twill')); console.log('wrote ' + out); }
    finally { await browser.close(); }
  })().catch(e => { console.error(e.message || e); process.exit(1); });
}
