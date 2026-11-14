// Saved canvases: create, list, read, replace, delete; owners only; size and count caps.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, HAVE_SQLITE } from './helpers.mjs';
import { MAX_PROJECTS } from '../src/projects.js';

const opts = { skip: !HAVE_SQLITE && 'node:sqlite is not available' };
const payload = { v: 1, app: 'embroidr', savedAt: 1, doc: { name: 'Bee', hoop: { w: 100, h: 100 }, objects: [{ id: 'a', type: 'rect', x: 1, y: 2, w: 3, h: 4 }] } };

test('save, list, open, rename and delete a design', opts, async () => {
  const app = await makeApp();
  const { cookie } = await app.signIn();
  let r = await app.request('PUT', '/api/projects/design_0001', { cookie, body: { name: 'Bee', data: payload } });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).created, true);
  app.clock.t += 1000;
  r = await app.request('PUT', '/api/projects/design_0002', { cookie, body: { name: 'Fox', data: payload } });
  assert.equal(r.status, 200);

  let list = (await (await app.request('GET', '/api/projects', { cookie })).json()).projects;
  assert.deepEqual(list.map(p => p.name), ['Fox', 'Bee'], 'newest first');
  assert.ok(!('data' in list[0]), 'the list carries no design data');

  r = await app.request('GET', '/api/projects/design_0001', { cookie });
  const one = await r.json();
  assert.deepEqual(one.data, payload);

  app.clock.t += 1000;
  r = await app.request('PUT', '/api/projects/design_0001', { cookie, body: { name: 'Bumble bee', data: payload } });
  assert.equal((await r.json()).created, false);
  list = (await (await app.request('GET', '/api/projects', { cookie })).json()).projects;
  assert.deepEqual(list.map(p => p.name), ['Bumble bee', 'Fox']);

  r = await app.request('DELETE', '/api/projects/design_0002', { cookie });
  assert.equal(r.status, 200);
  r = await app.request('GET', '/api/projects/design_0002', { cookie });
  assert.equal(r.status, 404);
});

test('another user can neither read, overwrite nor delete my design', opts, async () => {
  const app = await makeApp();
  const ann = await app.signIn();
  await app.request('PUT', '/api/projects/design_ann1', { cookie: ann.cookie, body: { name: 'Mine', data: payload } });
  const bob = await app.signIn({ sub: '2002', email: 'bob@example.com' });
  let r = await app.request('GET', '/api/projects/design_ann1', { cookie: bob.cookie });
  assert.equal(r.status, 404);
  r = await app.request('PUT', '/api/projects/design_ann1', { cookie: bob.cookie, body: { name: 'Stolen', data: { x: 1 } } });
  assert.equal(r.status, 409);
  r = await app.request('DELETE', '/api/projects/design_ann1', { cookie: bob.cookie });
  assert.equal(r.status, 404);
  assert.deepEqual((await (await app.request('GET', '/api/projects', { cookie: bob.cookie })).json()).projects, []);
  const mine = await (await app.request('GET', '/api/projects/design_ann1', { cookie: ann.cookie })).json();
  assert.equal(mine.name, 'Mine');
  r = await app.request('GET', '/api/projects');
  assert.equal(r.status, 401, 'signed out');
});

test('size cap, count cap and bad input', opts, async () => {
  const app = await makeApp();
  const { cookie } = await app.signIn();
  let r = await app.request('PUT', '/api/projects/design_big1', { cookie, body: { name: 'Big', data: { blob: 'x'.repeat(1000001) } } });
  assert.equal(r.status, 413);
  r = await app.request('PUT', '/api/projects/bad id!', { cookie, body: { name: 'x', data: payload } });
  assert.equal(r.status, 400);
  r = await app.request('PUT', '/api/projects/design_0003', { cookie, body: { name: 'x', data: [1, 2] } });
  assert.equal(r.status, 400);
  r = await app.request('PUT', '/api/projects/design_0003', { cookie, body: { name: 'x'.repeat(500) + '\u0000', data: payload } });
  assert.equal((await r.json()).name.length, 80, 'long names are cut');

  const uid = app.userId();
  for (let i = app.db.get('SELECT COUNT(*) AS n FROM projects').n; i < MAX_PROJECTS; i++) {
    app.db.run("INSERT INTO projects (id, user_id, name, data, size, created_at, updated_at) VALUES (?, ?, 'n', '{}', 2, 0, 0)", 'filler_' + String(i).padStart(4, '0'), uid);
  }
  r = await app.request('PUT', '/api/projects/design_one_more', { cookie, body: { name: 'x', data: payload } });
  assert.equal(r.status, 403);
  r = await app.request('PUT', '/api/projects/design_0003', { cookie, body: { name: 'still fine', data: payload } });
  assert.equal(r.status, 200, 'replacing an existing design works at the cap');
});

test('a malformed design id in the path is a 400, not a server error', async () => {
  const { makeApp } = await import('./helpers.mjs');
  const app = await makeApp();
  const { cookie } = await app.signIn();
  const r = await app.request('GET', '/api/projects/%E0%A4%A', { cookie });
  assert.equal(r.status, 400);
});
