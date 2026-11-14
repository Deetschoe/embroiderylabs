#!/usr/bin/env node
'use strict';
/*
 * Builds the design feed: designs/index.json and a thumbnail for every designs/*.embroidr.
 *
 *   node designs/src/build.js            every design
 *   node designs/src/build.js --no-thumbs   only the index (no Chrome needed)
 *
 * A design with a warning or that cannot be exported is left out of the feed and named at the end.
 * Thumbnails are the realistic stitch render on a pale cloth, 640 px, WebP (needs `cwebp`; PNG if missing).
 */
const fs = require('fs'), path = require('path'), cp = require('child_process');
const L = require('./lib.js');
const DIR = path.join(L.ROOT, 'designs'), THUMBS = path.join(DIR, 'thumbs');
/* order on the page, titles and tags; anything not listed is added after these, by file name */
const META = {
  'smiling-man': { title: 'Smiling man', tags: ['portrait'] },
  'anime-girl': { title: 'Anime girl', tags: ['portrait', 'anime'] },
  'anime-boy': { title: 'Anime boy', tags: ['portrait', 'anime'] },
  'sunflower': { title: 'Sunflower', tags: ['flower'] },
  'cherry-blossom': { title: 'Cherry blossom', tags: ['flower'] },
  'lotus': { title: 'Lotus', tags: ['flower'] },
  'butterfly': { title: 'Butterfly', tags: ['insect'] },
  'dragonfly': { title: 'Dragonfly', tags: ['insect'] },
  'ladybug': { title: 'Ladybug', tags: ['insect'] },
  'bee': { title: 'Bumblebee', tags: ['insect'] },
};
(async () => {
  const thumbs = process.argv.indexOf('--no-thumbs') < 0;
  const ids = fs.readdirSync(DIR).filter(f => /^[a-z0-9-]+\.embroidr$/.test(f)).map(f => f.replace(/\.embroidr$/, ''));
  ids.sort((a, b) => { const order = Object.keys(META), ia = order.indexOf(a), ib = order.indexOf(b); return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib) || a.localeCompare(b); });
  fs.mkdirSync(THUMBS, { recursive: true });
  const hasCwebp = cp.spawnSync('cwebp', ['-version'], { encoding: 'utf8' }).status === 0;
  let browser = null; const feed = [], left = [];
  try {
    for (const id of ids) {
      const data = JSON.parse(fs.readFileSync(path.join(DIR, id + '.embroidr'), 'utf8')), doc = data.doc || data, r = L.check(doc);
      if (!r.canExport || r.problems.length) { left.push(id + ': ' + (r.problems[0] || 'cannot be exported')); continue; }
      const t = r.result.totals, b = r.result.bounds, meta = META[id] || { title: id.replace(/-/g, ' ').replace(/^./, c => c.toUpperCase()), tags: [] };
      let thumb = null;
      if (thumbs) {
        if (!browser) browser = await require('./render.js').open();
        const png = path.join(THUMBS, id + '.png');
        fs.writeFileSync(png, await browser.draw(doc, 640, '#f4f1ea', 'twill'));
        if (hasCwebp && cp.spawnSync('cwebp', ['-quiet', '-q', '80', png, '-o', path.join(THUMBS, id + '.webp')]).status === 0) { fs.unlinkSync(png); thumb = 'designs/thumbs/' + id + '.webp'; }
        else thumb = 'designs/thumbs/' + id + '.png';
      } else thumb = ['webp', 'png'].map(e => 'designs/thumbs/' + id + '.' + e).find(p => fs.existsSync(path.join(L.ROOT, p))) || null;
      feed.push({ id, title: meta.title, tags: meta.tags, file: 'designs/' + id + '.embroidr', thumb, stitches: t.stitches, colors: new Set(doc.objects.map(o => String(o.color).toLowerCase())).size, stops: t.colors, minutes: t.timeMin,
        width: +b.width.toFixed(1), height: +b.height.toFixed(1), hoop: doc.hoop, shapes: doc.objects.length });
      console.log(id.padEnd(16) + String(t.stitches).padStart(6) + ' stitches  ' + b.width.toFixed(0) + ' x ' + b.height.toFixed(0) + ' mm  ' + (thumb || 'no thumbnail'));
    }
  } finally { if (browser) await browser.close(); }
  fs.writeFileSync(path.join(DIR, 'index.json'), JSON.stringify({ v: 1, designs: feed }, null, 1) + '\n');
  console.log('designs/index.json: ' + feed.length + ' designs');
  if (left.length) { console.log('LEFT OUT (fix these):'); left.forEach(l => console.log('  ' + l)); process.exitCode = 1; }
})().catch(e => { console.error(e.message || e); process.exit(1); });
