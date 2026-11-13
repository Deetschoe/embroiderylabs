#!/usr/bin/env node
/*
 * Picture set x sizes x colour counts -> trace -> Engine.generate -> PES -> pyembroidery read-back -> contact sheets.
 * A tool for LOOKING at results (tests/trace/run.js is the pass / fail suite).
 *
 *   node tests/trace/tools/matrix.js <imageDir> <outDir> [--only=name] [--widths=60,100] [--colors=3,6,10] [--no-sheets] [--panel=470] [--crop=x0,y0,x1,y1] [key=value trace options]
 *
 * Writes <outDir>/<image>_<width>.png (rows: colour counts; columns: source, traced shapes, stitch-out),
 * <outDir>/results.json and prints one line per run. Needs venv/bin/python (pyembroidery, Pillow, numpy).
 */
'use strict';
const fs = require('fs'), path = require('path');
const { execFileSync } = require('child_process');
const e2e = require('../e2e.js');
const { Trace, Engine } = e2e;

const argv = process.argv.slice(2);
const pos = argv.filter(a => !a.startsWith('--') && a.indexOf('=') < 0);
const val = (n, d) => { const a = argv.find(x => x.startsWith('--' + n + '=')); return a ? a.slice(n.length + 3) : d; };
const [imgDir, outDir] = pos;
if (!imgDir || !outDir) { console.error('usage: node tests/trace/tools/matrix.js <imageDir> <outDir> [--only=name] [--widths=60,100] [--colors=3,6,10]'); process.exit(2); }
const only = val('only', null), widths = val('widths', '60,100').split(',').map(Number), colorsList = val('colors', '3,6,10').split(',').map(Number);
const sheets = !argv.includes('--no-sheets');
const panelPx = Number(val('panel', 470));
const cropBox = val('crop', '') ? val('crop', '').split(',').map(Number) : null;   // --crop=x0,y0,x1,y1 as fractions: zoom in
const extra = {};
for (const kv of argv.filter(a => !a.startsWith('--') && a.indexOf('=') > 0)) { const i = kv.indexOf('='), v = kv.slice(i + 1); extra[kv.slice(0, i)] = v === 'true' ? true : v === 'false' ? false : (isFinite(Number(v)) ? Number(v) : v); }
// SEW.name=value tries another sewing constant for this run only (an experiment, not an option of the API)
for (const k of Object.keys(extra)) if (k.startsWith('SEW.')) { e2e.Trace._internal.SEW[k.slice(4)] = extra[k]; delete extra[k]; }
fs.mkdirSync(outDir, { recursive: true });
const tmp = path.join(outDir, 'tmp'); fs.mkdirSync(tmp, { recursive: true });
const py = e2e.findPython();
const files = fs.readdirSync(imgDir).filter(f => /\.(png|jpe?g)$/i.test(f) && (!only || only.split(',').some(o => f.indexOf(o) >= 0))).sort();
const all = [];
const countBy = l => { const o = {}; for (const k of l) o[k] = (o[k] || 0) + 1; return o; };
for (const f of files) {
  const name = f.replace(/\.[^.]+$/, '');
  const image = e2e.decode(path.join(imgDir, f), tmp);
  for (const width of widths) {
    const rows = [], recs = [];
    for (const colors of colorsList) {
      const opt = Object.assign({ width, colors }, extra);
      const t0 = process.hrtime.bigint();
      let traced, err = null;
      try { traced = Trace.trace(image, opt); } catch (e) { err = e; }
      const traceMs = Number(process.hrtime.bigint() - t0) / 1e6;
      const rec = { image: name, width, colors, traceMs: Math.round(traceMs) };
      recs.push(rec); all.push(rec);
      if (err) { rec.error = String(err && err.stack || err); rows.push({ source: { rgba: image.rawPath, width: image.width, height: image.height }, size: { width, height: width * image.height / image.width }, objects: [], caption: name + ' CRASH ' + err.message }); continue; }
      const hoop = { width: Math.ceil(traced.size.width + 20), height: Math.ceil(traced.size.height + 20) };
      const dx = 10, dy = 10;
      const objects = traced.objects.map(o => o.type === 'path'
        ? Object.assign({}, o, { rings: o.rings.map(r => r.map(p => [p[0] + dx, p[1] + dy])) })
        : Object.assign({}, o, { points: o.points.map(p => [p[0] + dx, p[1] + dy]) }));
      Object.assign(rec, { ok: traced.ok, mode: traced.mode, regions: traced.stats.regions, objects: traced.stats.objects, lines: traced.stats.lines, nColors: traced.colors.length,
        palette: traced.colors.map(c => c.hex).join(' '), est: traced.stats.estimatedStitches, bg: traced.background.reason, detect: traced.stats.detect,
        tWarn: traced.warnings.map(w => w.code).join(' ') });
      let pes = null, gen = null;
      if (traced.ok && objects.length) {
        const t1 = process.hrtime.bigint();
        gen = Engine.generate({ name, hoop, objects });
        rec.genMs = Math.round(Number(process.hrtime.bigint() - t1) / 1e6);
        Object.assign(rec, { stitches: gen.totals.stitches, changes: gen.totals.colorChanges, trims: gen.totals.trims, jumps: gen.totals.jumps, eLongest: gen.totals.longestStitchMm,
          eWarn: countBy(gen.warnings.map(w => w.code)), timeMin: gen.totals.timeMin });
        const b = gen.bounds;
        if (b) rec.outside = (b.minX < dx - 0.6 || b.minY < dy - 0.6 || b.maxX > dx + traced.size.width + 0.6 || b.maxY > dy + traced.size.height + 0.6) ? [r1(b.minX - dx), r1(b.minY - dy), r1(b.maxX - dx - traced.size.width), r1(b.maxY - dy - traced.size.height)] : null;
        if (gen.canExport) {
          const file = Engine.export(gen, { format: 'pes', name });
          pes = path.join(tmp, name + '_' + width + '_' + colors + '.pes');
          fs.writeFileSync(pes, Buffer.from(file.bytes));
        }
      }
      rows.push({ source: { rgba: image.rawPath, width: image.width, height: image.height }, size: traced.size.width ? traced.size : { width, height: width * image.height / image.width }, origin: { x: 10, y: 10 }, objects, pes,
        bounds: gen && gen.bounds, threads: gen ? gen.threads.map(t => t.color) : [], _rec: rec });
    }
    let read = null;
    if (py) {
      const job = path.join(tmp, name + '_' + width + '.job.json');
      const mk = () => rows.map(r => Object.assign({}, r, { _rec: undefined, caption: cap(r._rec), crop: cropBox || undefined }));
      fs.writeFileSync(job, JSON.stringify({ out: path.join(outDir, name + '_' + width + '.png'), panel: sheets ? panelPx : 120, rows: mk() }));
      read = JSON.parse(execFileSync(py, ['-B', path.join(__dirname, 'sheet.py'), job], { encoding: 'utf8', maxBuffer: 1 << 26 }));
      rows.forEach((r, i) => { if (r._rec) Object.assign(r._rec, { short: read.rows[i].short, long: read.rows[i].long, longest: read.rows[i].longest, coverage: read.rows[i].coverage, fStitches: read.rows[i].stitches, fTrims: read.rows[i].trims, fJumps: read.rows[i].jumps, fChanges: read.rows[i].colorChanges }); });
      // again, now with the numbers from the file in the captions
      fs.writeFileSync(job, JSON.stringify({ out: path.join(outDir, name + '_' + width + '.png'), panel: sheets ? panelPx : 120, rows: mk() }));
      if (sheets) execFileSync(py, ['-B', path.join(__dirname, 'sheet.py'), job], { encoding: 'utf8', maxBuffer: 1 << 26 });
      fs.unlinkSync(job);
    }
    for (const rec of recs) console.log(line(rec));
  }
  try { fs.unlinkSync(image.rawPath); } catch (e) { /* ignore */ }
}
fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(all, null, 1));
for (const f of fs.readdirSync(tmp)) if (/\.pes$/.test(f) && !argv.includes('--keep')) fs.unlinkSync(path.join(tmp, f));

function r1(v) { return Math.round(v * 10) / 10; }
function cap(r) {
  if (!r) return '';
  if (r.error) return r.image + ' CRASH';
  return r.image + '  ' + r.width + ' mm  ' + r.colors + ' colours asked, ' + r.nColors + ' used  mode ' + r.mode + '  regions ' + r.regions + ' objects ' + r.objects + ' (' + r.lines + ' lines)  trace ' + r.traceMs + ' ms' +
    '\nstitches ' + r.stitches + '  changes ' + r.changes + '  trims ' + r.trims + '  jumps ' + r.jumps + '  <0.5mm ' + r.short + '  >7mm ' + r.long + '  longest ' + r.longest + '  cover ' + r.coverage + '  ' + JSON.stringify(r.eWarn || {}) + '  ' + (r.tWarn || '');
}
function line(r) {
  if (r.error) return r.image + ' ' + r.width + '/' + r.colors + ' CRASH ' + r.error.split('\n')[0];
  return [r.image.padEnd(24), String(r.width).padStart(3), String(r.colors).padStart(2), (r.mode || '-').padEnd(5), ('c' + r.nColors).padEnd(3), ('reg' + r.regions).padEnd(6), ('obj' + r.objects).padEnd(6), ('ln' + r.lines).padEnd(5),
    ('st' + r.stitches).padEnd(8), ('ch' + r.changes).padEnd(4), ('tr' + r.trims).padEnd(5), ('j' + r.jumps).padEnd(5), ('<' + r.short).padEnd(5), ('>' + r.long).padEnd(3), ('cov' + r.coverage).padEnd(9), (r.traceMs + 'ms').padEnd(6),
    r.outside ? 'OUTSIDE' + JSON.stringify(r.outside) : '', JSON.stringify(r.eWarn || {}), r.tWarn, r.bg ? 'bg:' + r.bg : ''].join(' ');
}
