/*
 * End-to-end helper for the trace tests and for looking at results by hand.
 *
 *   picture -> Trace.trace -> Engine.generate -> Engine.export (PES) -> read back with pyembroidery -> PNG
 *
 * As a module:   const e2e = require('./e2e.js');  e2e.findPython(); e2e.sew(image, options, { dir, name })
 * As a tool:     node tests/trace/e2e.js <outDir> <picture> [width=100] [colors=6] [detail=medium] [mode=auto] [background=auto] ...
 *                (writes <name>.pes and <name>.png into outDir and prints the numbers)
 *
 * No npm packages. Python (with pyembroidery and Pillow) is only needed for the read-back and the pictures:
 * EMB_PYTHON or <repo>/venv/bin/python.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const Trace = require(path.join(ROOT, 'js', 'trace', 'trace.js'));
const Engine = require(path.join(ROOT, 'js', 'engine', 'engine.js'));
const RENDER = path.join(__dirname, 'render.py');

let pythonCache;
function findPython() {
  if (pythonCache !== undefined) return pythonCache;
  const cands = [process.env.EMB_PYTHON, path.join(ROOT, 'venv', 'bin', 'python')].filter(Boolean);
  for (const c of cands) {
    try { execFileSync(c, ['-B', '-c', 'import pyembroidery, PIL, numpy'], { stdio: 'ignore' }); pythonCache = c; return c; } catch (e) { /* next */ }
  }
  pythonCache = null;
  return null;
}

function decode(file, tmpDir) {
  const py = findPython();
  if (!py) throw new Error('python with Pillow is needed to read ' + file);
  const raw = path.join(tmpDir, path.basename(file) + '.rgba');
  const info = JSON.parse(execFileSync(py, ['-B', RENDER, 'decode', file, raw], { encoding: 'utf8' }));
  const data = new Uint8ClampedArray(fs.readFileSync(raw));
  return { width: info.width, height: info.height, data, rawPath: raw };
}

/* Trace an image and take it all the way to a machine file. Returns everything measured on the way. */
function sew(image, options, where) {
  where = where || {};
  const t0 = process.hrtime.bigint();
  const traced = Trace.trace(image, options);
  const traceMs = Number(process.hrtime.bigint() - t0) / 1e6;
  const out = { traced, traceMs };
  if (!traced.ok || !traced.objects.length) return out;
  const pad = 10;
  const hoop = (options && options.hoop) || { width: Math.max(20, Math.ceil(traced.size.width + 2 * pad)), height: Math.max(20, Math.ceil(traced.size.height + 2 * pad)) };
  // when no hoop was given the picture sits at the origin; shift a copy into the middle of the hoop
  let objects = traced.objects;
  if (!(options && options.hoop)) {
    const dx = (hoop.width - traced.size.width) / 2 - traced.origin.x, dy = (hoop.height - traced.size.height) / 2 - traced.origin.y;
    objects = traced.objects.map(o => o.type === 'path'
      ? Object.assign({}, o, { rings: o.rings.map(r => r.map(p => [p[0] + dx, p[1] + dy])) })
      : Object.assign({}, o, { points: o.points.map(p => [p[0] + dx, p[1] + dy]) }));
  }
  const t1 = process.hrtime.bigint();
  const gen = Engine.generate({ name: where.name || 'trace', hoop, objects });
  out.generateMs = Number(process.hrtime.bigint() - t1) / 1e6;
  out.gen = gen;
  out.hoop = hoop;
  if (!gen.canExport) return out;
  const file = Engine.export(gen, { format: where.format || 'pes', name: where.name || 'trace' });
  out.file = file;
  const py = findPython();
  if (!py || !where.dir) return out;
  fs.mkdirSync(where.dir, { recursive: true });
  const base = path.join(where.dir, where.name || 'trace');
  const fpath = base + '.' + (where.format || 'pes');
  fs.writeFileSync(fpath, Buffer.from(file.bytes));
  out.path = fpath;
  const args = ['-B', RENDER, 'readback', fpath];
  if (where.render !== false) {
    let rawPath = image.rawPath;
    if (!rawPath) { rawPath = base + '.rgba'; fs.writeFileSync(rawPath, Buffer.from(image.data.buffer, image.data.byteOffset, image.width * image.height * 4)); }
    const job = { out: base + '.png', source: { rgba: rawPath, width: image.width, height: image.height }, size: traced.size, origin: traced.origin, objects: traced.objects, title: where.title || '', ppmm: where.ppmm || 8, threads: where.fileColors ? null : gen.threads.map(th => th.color) };
    fs.writeFileSync(base + '.job.json', JSON.stringify(job));
    args.push(base + '.job.json');
  }
  out.read = JSON.parse(execFileSync(py, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
  if (where.render !== false && !image.rawPath && !where.keep) { try { fs.unlinkSync(base + '.rgba'); } catch (e) { /* ignore */ } }
  if (where.render !== false && !where.keep) { try { fs.unlinkSync(base + '.job.json'); } catch (e) { /* ignore */ } }
  return out;
}

function summary(name, r) {
  const t = r.traced, s = t.stats;
  const line = {
    name, ok: t.ok, mode: t.mode, mm: t.size.width + 'x' + t.size.height, work: s.workWidth + 'x' + s.workHeight,
    objects: s.objects, lines: s.lines, colors: t.colors.map(c => c.hex + ' ' + c.name).join(', '), points: s.points,
    estStitches: s.estimatedStitches, traceMs: Math.round(r.traceMs),
    stitches: r.gen ? r.gen.totals.stitches : null, trims: r.gen ? r.gen.totals.trims : null, generateMs: r.generateMs ? Math.round(r.generateMs) : null,
    engineWarnings: r.gen ? countBy(r.gen.warnings.map(w => w.code)) : null,
    warnings: t.warnings.map(w => w.code).join(' '),
    file: r.read ? { stitches: r.read.stitches, colorChanges: r.read.colorChanges, coverage: r.read.coverage, spill: r.read.spill, longest: r.read.longest } : null,
    detect: s.detect, background: t.background,
  };
  return line;
}
function countBy(list) { const o = {}; for (const k of list) o[k] = (o[k] || 0) + 1; return o; }

module.exports = { ROOT, Trace, Engine, findPython, decode, sew, summary };

if (require.main === module) {
  const [outDir, file, ...rest] = process.argv.slice(2);
  if (!outDir || !file) { console.error('usage: node tests/trace/e2e.js <outDir> <picture> [key=value ...]'); process.exit(2); }
  const options = {};
  for (const kv of rest) { const i = kv.indexOf('='); const k = kv.slice(0, i), v = kv.slice(i + 1); options[k] = v === 'true' ? true : v === 'false' ? false : (isFinite(Number(v)) ? Number(v) : v); }
  fs.mkdirSync(outDir, { recursive: true });
  const name = options.name || path.basename(file).replace(/\.[^.]+$/, '');
  delete options.name;
  const image = decode(file, outDir);
  const r = sew(image, options, { dir: outDir, name, title: name + '  ' + JSON.stringify(options) });
  try { fs.unlinkSync(image.rawPath); } catch (e) { /* ignore */ }
  console.log(JSON.stringify(summary(name, r), null, 1));
  if (process.env.TRACE_STAGES) console.log(JSON.stringify(r.traced.stats.stages));
}
