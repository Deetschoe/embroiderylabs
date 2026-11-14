#!/usr/bin/env node
/*
 * Editor tests, one after another:   node tests/editor/run.js
 *
 *   model.test.js      Model fields (stitch style, line detail, underlay) and M.toEngine, in node
 *   svgimport.test.js  SVG import clean-up, in headless Chrome (skipped loudly without Chrome)
 *   cut.test.js        the Cut-out tool and the stitch-style panel, in headless Chrome
 *   tutorial.test.js   the first-visit tutorial and light mode only (dark scheme asked), in headless Chrome
 *   groups-model.test.js  groups in the model (order, undo, save / load, engine input unchanged), in node
 *   groups.test.js     groups and "export selection only" in headless Chrome
 *   mockup.test.js     Mockup layers: rotation, handles, pictures, reorder, downloads, in headless Chrome
 *   market.test.js     the marketplace on its demo backend: list, stars, keys, publish, profile, in headless Chrome
 *   vectorize.test.js  Picture to SVG: paste, colours, erasers, studio undo, .svg, Add to design, copy / paste, in headless Chrome
 *
 * Each file prints its own checks; this exits non-zero if any of them fails.
 */
'use strict';
const path = require('path');
const { spawnSync } = require('child_process');

const FILES = ['model.test.js', 'svgimport.test.js', 'cut.test.js', 'tutorial.test.js', 'groups-model.test.js', 'groups.test.js', 'mockup.test.js', 'market.test.js', 'vectorize.test.js'];
let failed = 0;
for (const f of FILES) {
  console.log('\n== ' + f);
  const r = spawnSync(process.execPath, [path.join(__dirname, f)], { stdio: 'inherit' });
  if (r.status !== 0) { failed++; console.log('FAILED: ' + f + ' (exit ' + r.status + ')'); }
}
console.log('\neditor tests: ' + (FILES.length - failed) + ' of ' + FILES.length + ' files passed');
process.exit(failed ? 1 : 0);
