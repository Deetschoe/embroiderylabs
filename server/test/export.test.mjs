// POST /api/export: the same bytes as the browser engine, and quota counting.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { makeApp, REPO, HAVE_SQLITE } from './helpers.mjs';

const require = createRequire(import.meta.url);
const Engine = require(path.join(REPO, 'js/engine/engine.js'));          // the copy the browser and node suites use
const D = require(path.join(REPO, 'tests/engine/designs.js'));
const GOLDEN = path.join(REPO, 'tests/engine/golden');
const opts = { skip: !HAVE_SQLITE && 'node:sqlite is not available' };

const patch = { name: 'Patch', hoop: { width: 100, height: 100 }, objects: [{ id: 'p', type: 'rect', x: 30, y: 35, width: 40, height: 30, color: '#1d4ed8' }] };

async function exportOnce(app, cookie, design, format) {
  const r = await app.request('POST', '/api/export', { cookie, body: { design: design || patch, format: format || 'pes' } });
  const bytes = r.status === 200 ? Buffer.from(await r.arrayBuffer()) : null;
  const body = r.status === 200 ? null : await r.json();
  return { r, bytes, body };
}

// The editor's own input shape, as Editor.Model.toEngine() builds it (every field it writes).
function editorDesign() {
  return {
    name: 'From the editor', hoop: { width: 130, height: 180 },
    objects: [
      { id: 'a1', color: '#3157e0', paint: 'both', fill: { spacing: 0.4, stitchLength: 3, angle: 45, pattern: 'smooth' }, line: { type: 'satin', stitchLength: 3, width: 3, spacing: 0.4 }, type: 'ellipse', cx: 65, cy: 70, rx: 30, ry: 22 },
      { id: 'a2', color: '#c9a45c', paint: 'fill', fill: { spacing: 0.4, stitchLength: 3, angle: 0, pattern: 'brick' }, line: { type: 'running', stitchLength: 3, width: 3, spacing: 0.4 }, type: 'rect', x: 40, y: 110, width: 50, height: 25 },
      { id: 'a3', color: '#2b2d31', paint: 'line', fill: { spacing: 0.4, stitchLength: 3, angle: 0, pattern: 'smooth' }, line: { type: 'bean', stitchLength: 2.5, width: 3, spacing: 0.4 }, type: 'polyline', points: [[30, 150], [50, 160], [80, 150], [100, 165]], closed: false },
    ],
  };
}

test('the server file is byte-identical to the engine for every format (golden test-sew files and an editor design)', opts, async () => {
  const app = await makeApp();
  // Pro, so the 3 free exports do not run out during this test
  const { cookie } = await app.signIn();
  app.db.run("INSERT INTO subscriptions (id, user_id, plan, status, price_id, updated_at) VALUES ('sub_x', ?, 'pro', 'active', 'price_pro', 0)", app.userId());

  const golden = { pes: 'testsew.pes', pes6: 'testsew-v6.pes', pec: 'testsew.pec', dst: 'testsew.dst' };
  for (const [fmt, file] of Object.entries(golden)) {
    const { r, bytes } = await exportOnce(app, cookie, D.designs.testsew, fmt);
    assert.equal(r.status, 200, fmt);
    assert.ok(bytes.equals(fs.readFileSync(path.join(GOLDEN, file))), fmt + ': server bytes equal the golden reference file');
  }
  const design = editorDesign();
  for (const fmt of ['pes', 'dst']) {
    const { r, bytes } = await exportOnce(app, cookie, design, fmt);
    const local = Engine.export(Engine.generate(design), { format: fmt, name: design.name });
    assert.equal(r.status, 200);
    assert.ok(bytes.equals(Buffer.from(local.bytes)), fmt + ': server bytes equal Engine.export in the browser code path');
    assert.equal(decodeURIComponent(r.headers.get('X-EL-Filename')), local.filename);
    assert.equal(Number(r.headers.get('X-EL-Stitches')), local.stitches);
    assert.equal(r.headers.get('Content-Type'), local.mime);
    assert.equal(r.headers.get('X-EL-Exports-Left'), 'unlimited');
    assert.match(r.headers.get('Access-Control-Expose-Headers'), /X-EL-Filename/);
  }
  assert.equal(app.db.get("SELECT COUNT(*) AS n FROM export_log WHERE status = 'ok'").n, 6);
});

test('Free: 3 exports in total, the 4th is refused with 402, also in later months', opts, async () => {
  const app = await makeApp();
  const { cookie } = await app.signIn();
  for (let i = 1; i <= 3; i++) {
    const { r } = await exportOnce(app, cookie);
    assert.equal(r.status, 200, 'export ' + i);
    assert.equal(r.headers.get('X-EL-Exports-Left'), String(3 - i));
  }
  let { r, body } = await exportOnce(app, cookie);
  assert.equal(r.status, 402);
  assert.equal(body.error, 'quota');
  assert.equal(body.plan, 'free');
  assert.match(body.message, /3 free exports/);
  app.clock.t = Date.UTC(2026, 1, 10);                             // next month: Free does not reset
  ({ r } = await exportOnce(app, cookie));
  assert.equal(r.status, 402);
  const me = await (await app.request('GET', '/api/me', { cookie })).json();
  assert.deepEqual([me.exports.used, me.exports.left, me.exports.per], [3, 0, 'total']);
});

test('Hobby: 100 per calendar month (UTC), counted again from the 1st', opts, async () => {
  const app = await makeApp({ now: Date.UTC(2026, 0, 31, 23, 0, 0) });
  const { cookie } = await app.signIn();
  const uid = app.userId();
  app.db.run("INSERT INTO subscriptions (id, user_id, plan, status, price_id, updated_at) VALUES ('sub_h', ?, 'hobby', 'active', 'price_hobby', 0)", uid);
  // free exports from before the upgrade do not count against Hobby
  app.db.run("INSERT INTO export_log (user_id, month, plan, format, status, created_at) VALUES (?, '2026-01', 'free', 'pes', 'ok', 0)", uid);
  for (let i = 0; i < 99; i++) app.db.run("INSERT INTO export_log (user_id, month, plan, format, status, created_at) VALUES (?, '2026-01', 'hobby', 'pes', 'ok', 0)", uid);
  // a failed export and last month's exports do not count either
  app.db.run("INSERT INTO export_log (user_id, month, plan, format, status, created_at) VALUES (?, '2026-01', 'hobby', 'pes', 'failed', 0)", uid);
  for (let i = 0; i < 40; i++) app.db.run("INSERT INTO export_log (user_id, month, plan, format, status, created_at) VALUES (?, '2025-12', 'hobby', 'pes', 'ok', 0)", uid);

  let me = await (await app.request('GET', '/api/me', { cookie })).json();
  assert.deepEqual([me.plan, me.exports.used, me.exports.left], ['hobby', 99, 1]);
  assert.equal(me.exports.resetsAt, Date.UTC(2026, 1, 1));
  let { r, body } = await exportOnce(app, cookie);
  assert.equal(r.status, 200, 'the 100th');
  assert.equal(r.headers.get('X-EL-Exports-Left'), '0');
  ({ r, body } = await exportOnce(app, cookie));
  assert.equal(r.status, 402, 'the 101st');
  assert.match(body.message, /100 exports.*February 1/);

  app.clock.t = Date.UTC(2026, 1, 1, 0, 0, 1);                   // a new month
  ({ r } = await exportOnce(app, cookie));
  assert.equal(r.status, 200);
  me = await (await app.request('GET', '/api/me', { cookie })).json();
  assert.deepEqual([me.exports.used, me.exports.left], [1, 99]);
});

test('Pro is unlimited; a cancelled subscription falls back to Free', opts, async () => {
  const app = await makeApp();
  const { cookie } = await app.signIn();
  const uid = app.userId();
  app.db.run("INSERT INTO subscriptions (id, user_id, plan, status, price_id, updated_at) VALUES ('sub_p', ?, 'pro', 'active', 'price_pro', 0)", uid);
  for (let i = 0; i < 500; i++) app.db.run("INSERT INTO export_log (user_id, month, plan, format, status, created_at) VALUES (?, '2026-01', 'pro', 'pes', 'ok', 0)", uid);
  let { r } = await exportOnce(app, cookie);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('X-EL-Plan'), 'pro');
  app.db.run("UPDATE subscriptions SET status = 'canceled' WHERE id = 'sub_p'");
  const me = await (await app.request('GET', '/api/me', { cookie })).json();
  assert.deepEqual([me.plan, me.exports.left], ['free', 3], 'paid exports do not use up the free ones');
});

test('exports racing for the last one: exactly one wins', opts, async () => {
  const app = await makeApp();
  const { cookie } = await app.signIn();
  const uid = app.userId();
  app.db.run("INSERT INTO export_log (user_id, month, plan, format, status, created_at) VALUES (?, '2026-01', 'free', 'pes', 'ok', 0)", uid);
  app.db.run("INSERT INTO export_log (user_id, month, plan, format, status, created_at) VALUES (?, '2026-01', 'free', 'pes', 'ok', 0)", uid);
  const all = await Promise.all(Array.from({ length: 6 }, () => exportOnce(app, cookie)));
  assert.equal(all.filter(x => x.r.status === 200).length, 1);
  assert.equal(all.filter(x => x.r.status === 402).length, 5);
  assert.equal(app.db.get("SELECT COUNT(*) AS n FROM export_log WHERE status = 'ok'").n, 3);
});

test('a design the engine refuses, bad input and signed-out requests do not use an export', opts, async () => {
  const app = await makeApp();
  let r = await app.request('POST', '/api/export', { body: { design: patch, format: 'pes' } });
  assert.equal(r.status, 401, 'signed out');
  const { cookie } = await app.signIn();
  // outside the hoop: the engine reports an error, export is blocked
  const outside = { name: 'Out', hoop: { width: 100, height: 100 }, objects: [{ id: 'o', type: 'rect', x: 150, y: 150, width: 40, height: 30, color: '#000000' }] };
  let x = await exportOnce(app, cookie, outside);
  assert.equal(x.r.status, 422);
  assert.equal(x.body.error, 'cannot_export');
  x = await exportOnce(app, cookie, patch, 'jef');
  assert.equal(x.r.status, 400);
  x = await exportOnce(app, cookie, { name: 'Empty', objects: [] });
  assert.equal(x.r.status, 400);
  r = await app.request('POST', '/api/export', { cookie, raw: '{"design":', headers: { 'Content-Type': 'application/json' } });
  assert.equal(r.status, 400);
  r = await app.request('POST', '/api/export', { cookie, raw: 'x'.repeat(4 * 1024 * 1024 + 10), headers: { 'Content-Type': 'application/json' } });
  assert.equal(r.status, 413, 'body over 4 MB');
  r = await app.request('POST', '/api/export', { cookie, origin: 'https://evil.example.com', body: { design: patch } });
  assert.equal(r.status, 403, 'another site');
  const me = await (await app.request('GET', '/api/me', { cookie })).json();
  assert.equal(me.exports.left, 3, 'nothing was counted');
});

test('one account cannot start more than 20 exports a minute, refused designs included; nothing extra is counted', opts, async () => {
  const app = await makeApp();
  const { cookie } = await app.signIn();
  const uid = app.userId();
  app.db.run("INSERT INTO subscriptions (id, user_id, plan, status, price_id, updated_at) VALUES ('sub_p', ?, 'pro', 'active', 'price_pro', 0)", uid);
  const outside = { name: 'Out', hoop: { width: 100, height: 100 }, objects: [{ id: 'o', type: 'rect', x: 150, y: 150, width: 40, height: 30, color: '#000000' }] };
  for (let i = 0; i < 10; i++) assert.equal((await exportOnce(app, cookie, outside)).r.status, 422);
  for (let i = 0; i < 10; i++) assert.equal((await exportOnce(app, cookie)).r.status, 200);
  let x = await exportOnce(app, cookie);
  assert.equal(x.r.status, 429, 'the 21st start in a minute');
  assert.equal(x.body.error, 'slow_down');
  assert.equal(app.db.get("SELECT COUNT(*) AS n FROM export_log WHERE status = 'ok'").n, 10, 'only the made files count');
  assert.equal(app.db.get("SELECT COUNT(*) AS n FROM export_log WHERE status = 'attempt'").n, 0, 'no attempt left behind');
  app.clock.t += 61 * 1000;
  x = await exportOnce(app, cookie);
  assert.equal(x.r.status, 200, 'fine again a minute later');
  app.clock.t += 2 * 86400 * 1000;
  await exportOnce(app, cookie);
  assert.equal(app.db.get("SELECT COUNT(*) AS n FROM export_log WHERE status = 'refused'").n, 0, 'old refused rows are cleared');
});
