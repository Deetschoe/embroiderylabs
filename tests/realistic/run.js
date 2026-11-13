#!/usr/bin/env node
/*
 * Tests for js/realistic.   node tests/realistic/run.js            everything
 *                           node tests/realistic/run.js --pure     only the parts that need no browser
 * The browser part drives headless Chrome over a pipe (no port is opened). Set CHROME=/path/to/chrome if it
 * is not in the usual place; if no Chrome is found the browser part is reported as SKIPPED, loudly.
 */
'use strict';
var assert = require('assert'), path = require('path');
var passed = 0, failed = 0, failures = [], current = '', queue = [];
var t = {
  test: function (name, fn) { queue.push({ name: name, fn: fn }); },
  ok: function (v, msg) { check(!!v, msg || 'expected a true value'); },
  equal: function (a, b, msg) { check(a === b, (msg ? msg + ': ' : '') + 'got ' + show(a) + ', expected ' + show(b)); },
  notEqual: function (a, b, msg) { check(a !== b, (msg ? msg + ': ' : '') + 'both are ' + show(a)); },
  deepEqual: function (a, b, msg) { var same = true; try { assert.deepStrictEqual(a, b); } catch (e) { same = false; } check(same, (msg ? msg + ': ' : '') + 'got ' + show(a) + ', expected ' + show(b)); },
  doesNotThrow: function (fn, msg) { try { fn(); check(true); } catch (e) { check(false, (msg || 'should not throw') + ': threw ' + (e && e.message)); } }
};
function show(v) { try { var s = JSON.stringify(v); return s === undefined ? String(v) : s.length > 160 ? s.slice(0, 160) + '...' : s; } catch (e) { return String(v); } }
function check(ok, msg) { if (ok) passed++; else { failed++; failures.push(current + ': ' + msg); } }

(async function () {
  var pureOnly = process.argv.indexOf('--pure') >= 0, skipped = null;
  require('./pure.test.js')(t);
  if (!pureOnly) skipped = require('./browser.test.js')(t);
  for (var i = 0; i < queue.length; i++) {
    var q = queue[i], before = failed; current = q.name;
    try { await q.fn(); } catch (e) { failed++; failures.push(q.name + ': threw ' + (e && e.stack || e)); }
    console.log((failed === before ? '  ok    ' : '  FAIL  ') + q.name);
  }
  console.log('\n' + passed + ' checks passed, ' + failed + ' failed.');
  if (skipped) console.log('SKIPPED: the browser checks did not run (' + skipped + '). The renderer was NOT verified in a browser by this run.');
  if (pureOnly) console.log('(--pure: the browser checks were not asked for.)');
  if (failed) { console.log('\nFailures:\n  ' + failures.join('\n  ')); process.exit(1); }
})().catch(function (e) { console.error(e); process.exit(1); });
