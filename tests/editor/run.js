#!/usr/bin/env node
/*
 * Editor tests, one after another:   node tests/editor/run.js
 *
 *   model.test.js      Model fields (stitch style, line detail, underlay) and M.toEngine, in node
 *   svgimport.test.js  SVG import clean-up, in headless Chrome (skipped loudly without Chrome)
 *   cut.test.js        the Cut-out tool and the stitch-style panel, in headless Chrome
 *   groups-model.test.js  groups in the model (order, undo, save / load, engine input unchanged), in node
 *   groups.test.js     groups and "export selection only" in headless Chrome
 *
 * Each file prints its own checks; this exits non-zero if any of them fails.
 */
'use strict';
const path = require('path');
const { spawnSync } = require('child_process');

const FILES = ['model.test.js', 'svgimport.test.js', 'cut.test.js', 'groups-model.test.js', 'groups.test.js'];
let failed = 0;
for (const f of FILES) {
  console.log('\n== ' + f);
  const r = spawnSync(process.execPath, [path.join(__dirname, f)], { stdio: 'inherit' });
  if (r.status !== 0) { failed++; console.log('FAILED: ' + f + ' (exit ' + r.status + ')'); }
}
console.log('\neditor tests: ' + (FILES.length - failed) + ' of ' + FILES.length + ' files passed');
process.exit(failed ? 1 : 0);
