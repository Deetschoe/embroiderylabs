/*
 * One scale case in a process of its own, so time and peak memory belong to that case alone.
 *   node scale-child.js <case> <outDir> [raw]      raw: do not decode the files (peak memory is then the engine's alone)
 * Prints one JSON line: { case, ms, stitches, canExport, codes, maxRssMb, heapMb, files: { fmt: { bytes, ms, problems } } }
 * and leaves <case>__<format>.<ext> in <outDir>.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const C = require('./common.js');
const { Engine, D } = C;

const dense = { spacing: 0.2, stitchLength: 1 };
const grid = (n, size, gap, fill, colours) => { const o = []; for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) o.push({ type: 'rect', x: gap + i * (size + gap), y: gap + j * (size + gap), width: size, height: size, color: colours ? '#' + ('00000' + (((i + j * n) * 0x2f4b6d + 0x111111) & 0xffffff).toString(16)).slice(-6) : '#224488', fill }); return o; };
const cases = {
  // the largest common hoop, filled edge to edge as densely as the API allows
  dense200x300: () => ({ name: 'Dense 200x300', hoop: { width: 200, height: 300 }, objects: [{ type: 'rect', x: 2, y: 2, width: 196, height: 296, color: '#224488', fill: dense }] }),
  // the same hoop at default settings with an outline: what a visitor who fills the hoop really gets
  default200x300: () => ({ name: 'Default 200x300', hoop: { width: 200, height: 300 }, objects: [{ type: 'rect', x: 4, y: 4, width: 192, height: 292, color: '#224488', paint: 'both', line: { type: 'satin', width: 3, color: '#ffffff' } }] }),
  // dense, angled, round: rows of every length
  denseEllipse: () => ({ name: 'Dense ellipse', hoop: { width: 200, height: 300 }, objects: [{ type: 'ellipse', cx: 100, cy: 150, rx: 97, ry: 147, color: '#aa3300', fill: { spacing: 0.2, stitchLength: 1, angle: 37 } }] }),
  // 16 colours of dense fill in a 300 mm hoop
  grid300: () => ({ name: 'Grid 300', hoop: { width: 300, height: 300 }, objects: grid(4, 70, 4, dense, true) }),
  // over the per-object limit: must be refused cleanly and quickly
  tooLarge: () => ({ name: 'Too large', hoop: { width: 300, height: 300 }, objects: [{ type: 'rect', x: 2, y: 2, width: 296, height: 296, color: '#224488', fill: dense }] }),
  // the largest hoop the API accepts, covered once by 16 dense objects: millions of stitches
  hoop1000: () => ({ name: 'Hoop 1000', hoop: { width: 1000, height: 1000 }, objects: grid(4, 245, 4, dense, false) }),
  // a one-square design: what a process of this kind costs when the engine has next to nothing to do
  tiny: () => ({ name: 'Tiny', hoop: { width: 100, height: 100 }, objects: [{ type: 'rect', x: 40, y: 40, width: 20, height: 20, color: '#224488' }] }),
  // ... and covered twice
  hoop1000twice: () => ({ name: 'Hoop 1000 x2', hoop: { width: 1000, height: 1000 }, objects: grid(4, 245, 4, dense, false).concat(grid(4, 245, 4, { spacing: 0.2, stitchLength: 1, angle: 90 }, false)) }),
};

const name = process.argv[2], outDir = process.argv[3], raw = process.argv[4] === 'raw';
const design = cases[name]();
const out = { case: name, files: {} };
let r;
try {
  const t0 = process.hrtime.bigint();
  r = Engine.generate(design);
  out.ms = Number(process.hrtime.bigint() - t0) / 1e6;
  out.limit = r.warnings.find(w => w.code === 'TOO_MANY_STITCHES') || null;
  out.stitches = r.totals.stitches; out.canExport = r.canExport; out.codes = r.warnings.map(w => w.code + ':' + w.severity); out.threads = r.threads.length;
  out.irStitches = C.irRuns(r.ir).counts[0];
  let longest = 0, run = 0; const c = r.ir.commands; for (let i = 0; i < c.length; i += 3) { if (c[i] === 0) { run++; if (run > longest) longest = run; } else run = 0; }
  out.longestRun = longest;
  out.validate = Engine.validate(r).length;
} catch (e) { out.generateError = String(e && e.stack || e).slice(0, 400); }
if (r && r.canExport) for (const fmt of ['pes', 'pes6', 'pec', 'dst']) {
  const f = {}; out.files[fmt] = f;
  try {
    const t1 = process.hrtime.bigint(), file = Engine.export(r, { format: fmt });
    f.ms = Number(process.hrtime.bigint() - t1) / 1e6; f.bytes = file.bytes.length;
    const buf = Buffer.from(file.bytes.buffer, file.bytes.byteOffset, file.bytes.length);
    if (outDir && name !== 'hoop1000' && name !== 'hoop1000twice') fs.writeFileSync(path.join(outDir, name + '__' + fmt + '.' + (fmt === 'pes6' ? 'pes' : fmt)), buf);
    if (raw) continue;
    const d = fmt === 'dst' ? D.decodeDst(buf) : fmt === 'pec' ? D.decodePec(buf) : D.decodePes(buf);
    f.problems = d.problems.slice(0, 5); f.decodedStitches = d.ops.reduce((n, o) => n + (o[0] === 'S' ? 1 : 0), 0);
    if (d.seg) f.sections = d.seg.sections.length;
    if (d.streamBytes !== undefined) f.streamBytes = d.streamBytes;
    if (d.header) f.ST = d.header.ST;
      } catch (e) { f.error = (e && e.code ? e.code + ': ' : '') + String(e && e.message || e).slice(0, 300); }
}
out.maxRssMb = Math.round(process.resourceUsage().maxRSS / 1024); out.heapMb = Math.round(process.memoryUsage().heapUsed / 1048576);
console.log(JSON.stringify(out));
