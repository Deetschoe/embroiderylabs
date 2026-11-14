// Marketplace: designs, stars, keys, unlocks, profiles, badges, activity, the top-5 free sew-out.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { HAVE_SQLITE, REPO } from './helpers.mjs';
import { marketApp, payload, PNG, webp, FakeR2 } from './market-helpers.mjs';
import * as Economy from '../src/economy.js';
import { slugify, validHandle } from '../src/users.js';

const opts = { skip: !HAVE_SQLITE && 'node:sqlite is not available' };
const require = createRequire(import.meta.url);

// ---------------------------------------------------------------- economy (pure)

test('economy: keys, discount, progress and the wallet', () => {
  assert.equal(Economy.keysEarned(0, 0), 0);
  assert.equal(Economy.keysEarned(9, 0), 0);
  assert.equal(Economy.keysEarned(10, 0), 1);
  assert.equal(Economy.keysEarned(99, 3), 12, 'floor(99/10) + 3 unlocks of yours');
  assert.equal(Economy.keysLeft(5, 7), 0, 'never below zero');
  assert.equal(Economy.discountPct(0), 0);
  assert.equal(Economy.discountPct(9), 0);
  assert.equal(Economy.discountPct(10), 5);
  assert.equal(Economy.discountPct(25), 10);
  assert.equal(Economy.discountPct(99), 45);
  assert.equal(Economy.discountPct(100), 50);
  assert.equal(Economy.discountPct(5000), 50, 'capped at 50%');
  assert.equal(Economy.progressTo10k(2500), 0.25);
  assert.equal(Economy.progressTo10k(20000), 1);
  for (const p of [1, 2, 5]) assert.ok(Economy.validPrice(p));
  for (const p of [0, 6, 1.5, '2', null]) assert.ok(!Economy.validPrice(p));
  assert.deepEqual(Economy.wallet({ starsReceived: 257, unlocksOfYourDesigns: 4, keysSpent: 9, claimRank: null, claimsTaken: 2 }), {
    starsReceived: 257, keys: 20, keysEarned: 29, keysSpent: 9, discountPct: 10,
    freeSewout: { eligible: false, rank: null, slotsLeft: 3 }, progressTo10k: 0.0257,
  });
  assert.deepEqual(Economy.wallet({ starsReceived: 10000, claimRank: 2, claimsTaken: 5 }).freeSewout, { eligible: true, rank: 2, slotsLeft: 0 });
});

test('economy: streaks, the activity series and badges', () => {
  assert.equal(Economy.streakDay(['2026-01-01', '2026-01-02', '2026-01-03']), null);
  const seven = ['2026-01-07', '2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04', '2026-01-05', '2026-01-06', '2026-01-06'];
  assert.equal(Economy.streakDay(seven), '2026-01-07');
  assert.equal(Economy.streakDay(['2026-02-25', '2026-02-26', '2026-02-27', '2026-02-28', '2026-03-01', '2026-03-02', '2026-03-03']), '2026-03-03', 'across a month end');
  assert.equal(Economy.streakDay(['2026-01-01', '2026-01-02', '2026-01-04', '2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08', '2026-01-09']), null, 'a gap breaks it');
  const now = Date.UTC(2026, 0, 15, 12);
  const a = Economy.activitySeries({ '2026-01-15': 3, '2026-01-14': 1, '2025-01-15': 9, '2025-01-16': 2 }, now);
  assert.equal(a.length, 365);
  assert.deepEqual(a[364], { date: '2026-01-15', count: 3 });
  assert.deepEqual(a[363], { date: '2026-01-14', count: 1 });
  assert.deepEqual(a[0], { date: '2025-01-16', count: 2 }, 'the oldest day shown is 364 days ago');
  const b = Economy.badges({ firstDesignAt: 5, earlyMember: true, joinedAt: 1, streakDay: '2026-01-07', sewoutAt: null });
  assert.deepEqual(b.map(x => x.id), ['first-design', 'streak-7', 'early-member']);
  assert.equal(b[1].earnedAt, Date.UTC(2026, 0, 7));
  assert.equal(b[0].label, 'First design');
});

test('js/market-rules.js gives the same answers as server/src/economy.js', () => {
  const R = require(path.join(REPO, 'js', 'market-rules.js'));
  assert.deepEqual({ ...R.RULES }, { ...Economy.RULES });
  assert.deepEqual([...R.MODES], [...Economy.MODES]);
  assert.deepEqual([...R.VISIBILITIES], [...Economy.VISIBILITIES]);
  assert.deepEqual([...R.EVENT_KINDS], [...Economy.EVENT_KINDS]);
  assert.deepEqual(R.BADGES.map(b => ({ ...b })), Economy.BADGES.map(b => ({ ...b })));
  for (let s = 0; s <= 1200; s += 7) {
    for (const u of [0, 1, 13]) {
      for (const spent of [0, 5, 40]) {
        const f = { starsReceived: s, unlocksOfYourDesigns: u, keysSpent: spent, claimRank: s > 1000 ? 3 : null, claimsTaken: u % 6 };
        assert.deepEqual(R.wallet(f), Economy.wallet(f));
      }
    }
    assert.equal(R.discountPct(s), Economy.discountPct(s));
    assert.equal(R.progressTo10k(s * 10), Economy.progressTo10k(s * 10));
  }
  for (const p of [0, 1, 3, 5, 6, 2.5, '1']) assert.equal(R.validPrice(p), Economy.validPrice(p));
  const days = ['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04', '2026-01-05', '2026-01-06', '2026-01-07'];
  assert.equal(R.streakDay(days), Economy.streakDay(days));
  const now = Date.UTC(2026, 5, 1);
  assert.deepEqual(R.activitySeries({ '2026-06-01': 2 }, now), Economy.activitySeries({ '2026-06-01': 2 }, now));
  const facts = { firstDesignAt: 1, firstStarAt: 2, star100At: 3, popularAt: 4, earlyMember: true, joinedAt: 0, sewoutAt: 9, streakDay: '2026-01-07', firstUnlockAt: 8 };
  assert.deepEqual(R.badges(facts), Economy.badges(facts));
});

// ---------------------------------------------------------------- handles and PATCH /api/me

test('handles: slugs, defaults from the Google name, unique, and PATCH /api/me', opts, async () => {
  assert.equal(slugify('Zoë O’Brien'), 'zoe-obrien');
  assert.equal(slugify('Al'), 'al-maker');
  assert.equal(slugify(''), 'maker');
  assert.equal(slugify('!!!'), 'maker');
  assert.equal(slugify('A very long name that keeps going'), 'a-very-long-name-t');
  assert.ok(validHandle('ann-1') && !validHandle('an') && !validHandle('-ann') && !validHandle('ann--x') && !validHandle('Ann') && !validHandle('you') && !validHandle('a'.repeat(25)));

  const app = await marketApp({ people: ['ann'] });
  assert.equal(app.p.ann.handle, 'ann-example');
  assert.equal(app.p.ann.body.user.handle, 'ann-example', 'sign-in answers with the handle');
  const twin = await app.as('twin', { sub: '9009', email: 'ann2@example.com', name: 'Ann Example' });
  assert.match(twin.handle, /^ann-example-[a-z0-9]{4}$/, 'a taken handle gets a suffix');

  let r = await app.call('GET', '/api/me', 'ann');
  assert.equal(r.data.user.handle, 'ann-example');

  r = await app.call('PATCH', '/api/me', 'ann', { handle: 'Ann-Sews', name: '  Ann  the  maker ' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data, { handle: 'ann-sews', name: 'Ann the maker', avatar: 'https://lh3.googleusercontent.com/a/x' });
  r = await app.call('PATCH', '/api/me', 'twin', { handle: 'ann-sews' });
  assert.equal(r.status, 409);
  assert.equal(r.data.error, 'handle_taken');
  for (const bad of ['ab', 'with space', 'x'.repeat(25), '-dash', 'you', 'embroidr', 7]) {
    r = await app.call('PATCH', '/api/me', 'twin', { handle: bad });
    assert.equal(r.status, 400, 'handle ' + bad);
  }
  r = await app.call('PATCH', '/api/me', 'twin', { name: 12 });
  assert.equal(r.status, 400);
  r = await app.call('PATCH', '/api/me', null, { handle: 'nobody' });
  assert.equal(r.status, 401);
  r = await app.call('PATCH', '/api/me', 'ann', { handle: 'evil-one' }, { origin: 'https://evil.example' });
  assert.equal(r.status, 403);

  // Signing in again keeps the chosen handle and name.
  await app.as('ann');
  r = await app.call('GET', '/api/users/ann-sews', null);
  assert.equal(r.status, 200);
  assert.equal(r.data.name, 'Ann the maker');
  r = await app.call('GET', '/api/users/ann-example', null);
  assert.equal(r.status, 404);

  // A user from before the marketplace (no handle) gets one on their next visit.
  app.db.run('UPDATE users SET handle = NULL WHERE id = ?', twin.id);
  r = await app.call('GET', '/api/me', 'twin');
  assert.match(r.data.user.handle, /^ann-example(-[a-z0-9]{4})?$/);
});

test('CORS preflight allows PATCH', opts, async () => {
  const app = await marketApp({ people: [] });
  const res = await app.request('OPTIONS', '/api/market/abcdefgh', { headers: { 'Access-Control-Request-Method': 'PATCH' } });
  assert.equal(res.status, 204);
  assert.match(res.headers.get('Access-Control-Allow-Methods'), /PATCH/);
});

// ---------------------------------------------------------------- publish, read, list

test('publish returns an Item and checks every field', opts, async () => {
  const app = await marketApp();
  const item = await app.publish('ann', { title: '  Bee  ', description: 'Line one\r\nline two', tags: ['Insect', 'insect', ' Garden  bugs '], mode: 'keys', priceKeys: 3 });
  assert.match(item.id, /^[A-Za-z0-9_-]{16}$/);
  assert.equal(item.title, 'Bee');
  assert.equal(item.description, 'Line one\nline two');
  assert.deepEqual(item.tags, ['insect', 'garden bugs']);
  assert.equal(item.mode, 'keys');
  assert.equal(item.priceKeys, 3);
  assert.equal(item.visibility, 'public');
  assert.deepEqual(item.owner, { handle: 'ann-example', name: 'Ann Example', avatar: 'https://lh3.googleusercontent.com/a/x' });
  assert.equal(item.thumb, 'https://api.embroiderylabs.com/api/market/' + item.id + '/thumb?v=' + item.updatedAt);
  assert.equal(item.stars, 0);
  assert.equal(item.starred, false);
  assert.equal(item.unlocked, true, 'the owner can always open it');
  assert.equal(item.mine, true);
  assert.equal(typeof item.createdAt, 'number');
  assert.ok(!('payload' in item));

  const free = await app.publish('ann', { mode: 'free', priceKeys: 4 });
  assert.equal(free.priceKeys, 0, 'only keys designs have a price');
  const noThumb = await app.publish('ann', { thumb: undefined });
  assert.equal(noThumb.thumb, null);
  const wp = await app.publish('ann', { thumb: webp() });
  assert.ok(wp.thumb);

  const bad = [
    [{ title: '' }, 400, 'bad_title'],
    [{ title: 'x'.repeat(81) }, 400, 'bad_title'],
    [{ title: 5 }, 400, 'bad_title'],
    [{ description: 'x'.repeat(1001) }, 400, 'bad_description'],
    [{ tags: 'a,b' }, 400, 'bad_tags'],
    [{ tags: ['1', '2', '3', '4', '5', '6', '7', '8', '9'] }, 400, 'bad_tags'],
    [{ tags: ['x'.repeat(25)] }, 400, 'bad_tags'],
    [{ mode: 'sell' }, 400, 'bad_mode'],
    [{ mode: 'keys', priceKeys: 0 }, 400, 'bad_price'],
    [{ mode: 'keys', priceKeys: 6 }, 400, 'bad_price'],
    [{ mode: 'keys', priceKeys: 1.5 }, 400, 'bad_price'],
    [{ visibility: 'friends' }, 400, 'bad_visibility'],
    [{ payload: null }, 400, 'bad_payload'],
    [{ payload: [1, 2] }, 400, 'bad_payload'],
    [{ payload: { doc: { objects: 'no' } } }, 400, 'bad_payload'],
    [{ payload: { v: 1, doc: { objects: [], blob: 'x'.repeat(1000001) } } }, 413, 'too_large'],
    [{ thumb: 'data:image/jpeg;base64,/9j/4AAQ' }, 400, 'bad_thumb'],
    [{ thumb: 'https://example.com/a.png' }, 400, 'bad_thumb'],
    [{ thumb: 'data:image/png;base64,' + Buffer.from('not a png at all').toString('base64') }, 400, 'bad_thumb'],
    [{ thumb: webp(200 * 1024) }, 413, 'thumb_too_large'],
  ];
  for (const [fields, status, code] of bad) {
    const r = await app.call('POST', '/api/market', 'ann', Object.assign({ title: 'Bee', mode: 'free', visibility: 'public', payload, thumb: PNG }, fields));
    assert.equal(r.status, status, JSON.stringify(fields).slice(0, 80));
    assert.equal(r.data.error, code);
  }
  let r = await app.call('POST', '/api/market', 'ann', [1]);
  assert.equal(r.status, 400);
  r = await app.request('POST', '/api/market', { cookie: app.p.ann.cookie, raw: 'x'.repeat(2 * 1024 * 1024), headers: { 'Content-Type': 'application/json' } });
  assert.equal(r.status, 413, 'the body cap');
  r = await app.call('POST', '/api/market', null, { title: 'x', payload });
  assert.equal(r.status, 401);
  r = await app.call('POST', '/api/market', 'ann', { title: 'x', payload }, { origin: 'https://evil.example' });
  assert.equal(r.status, 403);
  r = await app.request('POST', '/api/market', { cookie: app.p.ann.cookie, raw: '{}', headers: { 'Content-Type': 'text/plain' } });
  assert.equal(r.status, 415);
  assert.equal(app.db.get("SELECT n FROM events WHERE kind = 'publish'").n, 4, 'each publish is in the activity');
});

test('publishing is capped per hour and per person', opts, async () => {
  const app = await marketApp({ people: ['ann'] });
  for (let i = 0; i < 20; i++) {
    const r = await app.call('POST', '/api/market', 'ann', { title: 'B' + i, payload });
    assert.equal(r.status, 201);
  }
  let r = await app.call('POST', '/api/market', 'ann', { title: 'one more', payload });
  assert.equal(r.status, 429);
  app.clock.t += 3600 * 1000 + 1;
  r = await app.call('POST', '/api/market', 'ann', { title: 'next hour', payload });
  assert.equal(r.status, 201);
  app.db.run("INSERT INTO market_items (id, user_id, title, mode, visibility, payload, size, created_at, updated_at) " +
    "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 479) SELECT 'filler-' || x, ?, 't', 'free', 'public', '{}', 2, 0, 0 FROM c", app.p.ann.id);
  r = await app.call('POST', '/api/market', 'ann', { title: 'over the cap', payload });
  assert.equal(r.status, 403);
  assert.equal(r.data.error, 'too_many');
});

test('the list: new and top, tags, search, pages; private designs are not listed', opts, async () => {
  const app = await marketApp();
  const a = await app.publish('ann', { title: 'Red fox', tags: ['animal', 'forest'] });
  const b = await app.publish('bob', { title: 'Bee', description: 'buzzing in the garden', tags: ['insect'] });
  const c = await app.publish('cat', { title: 'Hidden owl', tags: ['animal'], visibility: 'private' });
  const d = await app.publish('cat', { title: 'Lotus', tags: ['flower'], mode: 'keys', priceKeys: 2 });
  await app.call('POST', '/api/market/' + b.id + '/star', 'ann');
  await app.call('POST', '/api/market/' + b.id + '/star', 'cat');
  await app.call('POST', '/api/market/' + d.id + '/star', 'ann');

  let r = await app.call('GET', '/api/market', null);
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.items.map(i => i.title), ['Lotus', 'Bee', 'Red fox'], 'newest first, no private');
  assert.equal(r.data.next, null);
  assert.ok(r.data.items.every(i => !i.mine && !i.starred));
  assert.deepEqual(r.data.items.map(i => i.unlocked), [false, true, true], 'signed out: free ones are open, keys ones are not');

  r = await app.call('GET', '/api/market?sort=top', 'ann');
  assert.deepEqual(r.data.items.map(i => [i.title, i.stars, i.starred, i.mine]), [['Bee', 2, true, false], ['Lotus', 1, true, false], ['Red fox', 0, false, true]]);
  r = await app.call('GET', '/api/market?tag=Animal', 'cat');
  assert.deepEqual(r.data.items.map(i => i.id), [a.id], 'tag filter, case-insensitive, no private');
  r = await app.call('GET', '/api/market?q=GARDEN', null);
  assert.deepEqual(r.data.items.map(i => i.id), [b.id], 'search looks at the description');
  r = await app.call('GET', '/api/market?q=fox', null);
  assert.deepEqual(r.data.items.map(i => i.id), [a.id]);
  r = await app.call('GET', '/api/market?q=%25', null);
  assert.deepEqual(r.data.items, [], 'no wildcards');
  assert.ok(c.id);

  // Pages.
  for (let i = 0; i < 5; i++) await app.publish('ann', { title: 'Extra ' + i });
  const seen = [];
  let cursor = '';
  for (let page = 0; page < 10; page++) {
    r = await app.call('GET', '/api/market?limit=3' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''), null);
    assert.equal(r.status, 200);
    seen.push(...r.data.items.map(i => i.id));
    if (!r.data.next) break;
    cursor = r.data.next;
  }
  assert.equal(seen.length, 8);
  assert.equal(new Set(seen).size, 8, 'no repeats across pages');
  const top = [];
  cursor = '';
  for (let page = 0; page < 10; page++) {
    r = await app.call('GET', '/api/market?sort=top&limit=2' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''), null);
    top.push(...r.data.items.map(i => i.stars));
    if (!r.data.next) break;
    cursor = r.data.next;
  }
  assert.deepEqual(top, [2, 1, 0, 0, 0, 0, 0, 0]);

  for (const q of ['sort=old', 'limit=0', 'limit=49', 'limit=x', 'cursor=@@@', 'cursor=' + Buffer.from('{"c":"x"}').toString('base64url')]) {
    r = await app.call('GET', '/api/market?' + q, null);
    assert.equal(r.status, 400, q);
  }
});

test('one design: item, file and picture follow mode and visibility', opts, async () => {
  const app = await marketApp();
  const free = await app.publish('ann', { title: 'Free bee', mode: 'free' });
  const keys = await app.publish('ann', { title: 'Keys bee', mode: 'keys', priceKeys: 1 });
  const show = await app.publish('ann', { title: 'Show bee', mode: 'show' });
  const priv = await app.publish('ann', { title: 'Private bee', visibility: 'private' });

  let r = await app.call('GET', '/api/market/' + free.id, null);
  assert.equal(r.status, 200);
  assert.equal(r.data.title, 'Free bee');
  r = await app.call('GET', '/api/market/' + free.id + '/file', null);
  assert.equal(r.status, 200, 'free: anyone, even signed out');
  assert.deepEqual(r.data, payload);
  assert.match(r.res.headers.get('Content-Type'), /application\/json/);

  r = await app.call('GET', '/api/market/' + keys.id + '/file', 'bob');
  assert.equal(r.status, 403);
  assert.equal(r.data.error, 'locked');
  r = await app.call('GET', '/api/market/' + keys.id + '/file', null);
  assert.equal(r.status, 403);
  r = await app.call('GET', '/api/market/' + keys.id + '/file', 'ann');
  assert.equal(r.status, 200, 'the owner');

  r = await app.call('GET', '/api/market/' + show.id + '/file', 'bob');
  assert.equal(r.status, 403);
  assert.equal(r.data.error, 'locked');
  r = await app.call('GET', '/api/market/' + show.id, 'bob');
  assert.equal(r.status, 200, 'a show design can be looked at');
  assert.equal(r.data.unlocked, false);
  r = await app.call('GET', '/api/market/' + show.id + '/thumb', 'bob');
  assert.equal(r.status, 200);
  assert.equal(r.res.headers.get('Content-Type'), 'image/png');
  assert.equal(r.res.headers.get('Cache-Control'), 'public, max-age=86400');
  r = await app.call('GET', '/api/market/' + show.id + '/file', 'ann');
  assert.equal(r.status, 200, 'show: only the owner gets the file');

  for (const sub of ['', '/file', '/thumb']) {
    r = await app.call('GET', '/api/market/' + priv.id + sub, 'bob');
    assert.equal(r.status, 404, 'private is invisible to others: ' + sub);
    r = await app.call('GET', '/api/market/' + priv.id + sub, null);
    assert.equal(r.status, 404);
    r = await app.call('GET', '/api/market/' + priv.id + sub, 'ann');
    assert.equal(r.status, 200, 'the owner sees it: ' + sub);
  }
  r = await app.call('GET', '/api/market/' + priv.id + '/thumb', 'ann');
  assert.equal(r.res.headers.get('Cache-Control'), 'private, no-store');
  const png = Buffer.from(PNG.split(',')[1], 'base64');
  const thumbRes = await app.request('GET', '/api/market/' + free.id + '/thumb', {});
  assert.deepEqual(Buffer.from(await thumbRes.arrayBuffer()), png);

  for (const p of ['/api/market/nope', '/api/market/does-not-exist-123', '/api/market/%E0%A4%A', '/api/market/abcdefgh/file']) {
    r = await app.call('GET', p, 'ann');
    assert.equal(r.status, 404, p);
  }
  r = await app.call('GET', '/api/market/' + free.id + '/other', 'ann');
  assert.equal(r.status, 404);
  r = await app.call('PUT', '/api/market/' + free.id, 'ann', {});
  assert.equal(r.status, 405);
});

test('PATCH and DELETE: owner only', opts, async () => {
  const app = await marketApp();
  const item = await app.publish('ann', { title: 'Bee', mode: 'free' });
  const priv = await app.publish('ann', { title: 'Mine', visibility: 'private' });
  app.clock.t += 5000;

  let r = await app.call('PATCH', '/api/market/' + item.id, 'ann', { title: 'Bumble bee', tags: ['Bug'], mode: 'keys' });
  assert.equal(r.status, 200);
  assert.equal(r.data.title, 'Bumble bee');
  assert.deepEqual(r.data.tags, ['bug']);
  assert.equal(r.data.mode, 'keys');
  assert.equal(r.data.priceKeys, 1, 'keys without a price: 1');
  assert.ok(r.data.updatedAt > item.updatedAt);
  assert.notEqual(r.data.thumb, item.thumb, 'a new picture address after a change');
  r = await app.call('PATCH', '/api/market/' + item.id, 'ann', { priceKeys: 5 });
  assert.equal(r.data.priceKeys, 5);
  r = await app.call('PATCH', '/api/market/' + item.id, 'ann', { mode: 'show' });
  assert.equal(r.data.priceKeys, 0);
  r = await app.call('PATCH', '/api/market/' + item.id, 'ann', { visibility: 'private', description: 'shh' });
  assert.equal(r.data.visibility, 'private');
  r = await app.call('GET', '/api/market/' + item.id, 'bob');
  assert.equal(r.status, 404, 'now private');
  r = await app.call('PATCH', '/api/market/' + item.id, 'ann', { visibility: 'public', mode: 'free' });
  assert.equal(r.status, 200);

  for (const [body, code] of [[{ title: '' }, 'bad_title'], [{ title: 'x'.repeat(81) }, 'bad_title'], [{ mode: 'keys', priceKeys: 9 }, 'bad_price'],
    [{ visibility: 'x' }, 'bad_visibility'], [{ tags: new Array(9).fill('t') }, 'bad_tags'], [{ description: 'x'.repeat(1001) }, 'bad_description']]) {
    r = await app.call('PATCH', '/api/market/' + item.id, 'ann', body);
    assert.equal(r.status, 400);
    assert.equal(r.data.error, code);
  }

  // The longest allowed fields fit in one PATCH, even with every character escaped as \uXXXX.
  const long = JSON.stringify({ description: '蜂'.repeat(1000), tags: new Array(8).fill('蜂'.repeat(24)) })
    .replace(/[\u0080-￿]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
  r = await app.request('PATCH', '/api/market/' + item.id, { cookie: app.p.ann.cookie, raw: long, headers: { 'Content-Type': 'application/json' } });
  assert.equal(r.status, 200, await r.clone().text());
  assert.equal((await r.json()).description.length, 1000);

  r = await app.call('PATCH', '/api/market/' + item.id, 'bob', { title: 'Mine now' });
  assert.equal(r.status, 403);
  assert.equal(r.data.error, 'not_owner');
  r = await app.call('DELETE', '/api/market/' + item.id, 'bob');
  assert.equal(r.status, 403);
  r = await app.call('PATCH', '/api/market/' + priv.id, 'bob', { title: 'x' });
  assert.equal(r.status, 404, 'private: not even a hint it exists');
  r = await app.call('DELETE', '/api/market/' + priv.id, 'bob');
  assert.equal(r.status, 404);
  r = await app.call('PATCH', '/api/market/' + item.id, null, { title: 'x' });
  assert.equal(r.status, 401);
  r = await app.call('DELETE', '/api/market/' + item.id, 'ann', undefined, { origin: 'https://evil.example' });
  assert.equal(r.status, 403);
  assert.equal(app.db.get('SELECT title FROM market_items WHERE id = ?', item.id).title, 'Bumble bee');

  r = await app.call('DELETE', '/api/market/' + item.id, 'ann');
  assert.equal(r.status, 200);
  assert.deepEqual(r.data, { deleted: true });
  r = await app.call('GET', '/api/market/' + item.id, 'ann');
  assert.equal(r.status, 404);
  r = await app.call('DELETE', '/api/market/' + item.id, 'ann');
  assert.equal(r.status, 404);
});

// ---------------------------------------------------------------- stars

test('stars: one per person, not your own, unstar keeps lifetime stars', opts, async () => {
  const app = await marketApp();
  const item = await app.publish('ann', { title: 'Bee' });
  const priv = await app.publish('ann', { title: 'Hidden', visibility: 'private' });

  let r = await app.call('POST', '/api/market/' + item.id + '/star', 'ann');
  assert.equal(r.status, 400);
  assert.equal(r.data.error, 'own_design');
  r = await app.call('POST', '/api/market/' + priv.id + '/star', 'bob');
  assert.equal(r.status, 404);
  r = await app.call('POST', '/api/market/' + item.id + '/star', null);
  assert.equal(r.status, 401);
  r = await app.call('POST', '/api/market/' + item.id + '/star', 'bob', undefined, { origin: 'https://evil.example' });
  assert.equal(r.status, 403);

  // A double click: two requests at the same moment.
  const both = await Promise.all([1, 2, 3].map(() => app.call('POST', '/api/market/' + item.id + '/star', 'bob')));
  for (const x of both) { assert.equal(x.status, 200); assert.equal(x.data.starred, true); }
  r = await app.call('POST', '/api/market/' + item.id + '/star', 'bob');
  assert.deepEqual(r.data, { stars: 1, starred: true });
  r = await app.call('POST', '/api/market/' + item.id + '/star', 'cat');
  assert.deepEqual(r.data, { stars: 2, starred: true });
  assert.equal(app.db.get('SELECT COUNT(*) AS n FROM stars').n, 2);

  r = await app.call('GET', '/api/me/wallet', 'ann');
  assert.equal(r.data.starsReceived, 2);

  r = await app.call('DELETE', '/api/market/' + item.id + '/star', 'bob');
  assert.deepEqual(r.data, { stars: 1, starred: false });
  r = await app.call('DELETE', '/api/market/' + item.id + '/star', 'bob');
  assert.deepEqual(r.data, { stars: 1, starred: false }, 'unstar twice is fine');
  r = await app.call('GET', '/api/me/wallet', 'ann');
  assert.equal(r.data.starsReceived, 2, 'lifetime: an unstar does not take it back');
  r = await app.call('POST', '/api/market/' + item.id + '/star', 'bob');
  assert.equal(r.data.stars, 2);
  r = await app.call('GET', '/api/me/wallet', 'ann');
  assert.equal(r.data.starsReceived, 2, 'starring again does not count twice');

  r = await app.call('GET', '/api/market/' + item.id, 'bob');
  assert.equal(r.data.starred, true);
  r = await app.call('GET', '/api/market/' + item.id, 'ann');
  assert.equal(r.data.starred, false);

  // Deleting the design removes its stars, but not the owner's lifetime total.
  await app.call('DELETE', '/api/market/' + item.id, 'ann');
  assert.equal(app.db.get('SELECT COUNT(*) AS n FROM stars').n, 0);
  r = await app.call('GET', '/api/me/wallet', 'ann');
  assert.equal(r.data.starsReceived, 2);
});

// ---------------------------------------------------------------- keys and unlocks

test('wallet and unlocks: keys from stars, spending, the owner\'s +1, discount', opts, async () => {
  const app = await marketApp();
  const lock3 = await app.publish('ann', { title: 'Three keys', mode: 'keys', priceKeys: 3 });
  const lock1 = await app.publish('ann', { title: 'One key', mode: 'keys', priceKeys: 1 });
  const free = await app.publish('ann', { title: 'Free' });
  const show = await app.publish('ann', { title: 'Show', mode: 'show' });
  const own = await app.publish('bob', { title: 'Bob own', mode: 'keys', priceKeys: 2 });

  let r = await app.call('GET', '/api/me/wallet', 'bob');
  assert.deepEqual(r.data, { starsReceived: 0, keys: 0, keysEarned: 0, keysSpent: 0, discountPct: 0, freeSewout: { eligible: false, rank: null, slotsLeft: 5 }, progressTo10k: 0 });
  r = await app.call('GET', '/api/me/wallet', null);
  assert.equal(r.status, 401);

  r = await app.call('POST', '/api/market/' + lock3.id + '/unlock', 'bob');
  assert.equal(r.status, 402);
  assert.equal(r.data.error, 'not-enough-keys');
  assert.equal(r.data.keys, 0);
  assert.equal(r.data.need, 3);

  app.seedMarks(app.p.bob.id, 39);                        // 39 stars received -> 3 keys
  r = await app.call('GET', '/api/me/wallet', 'bob');
  assert.equal(r.data.keys, 3);
  assert.equal(r.data.progressTo10k, 0.0039);

  // A double click on unlock spends once.
  const clicks = await Promise.all([1, 2, 3].map(() => app.call('POST', '/api/market/' + lock3.id + '/unlock', 'bob')));
  for (const c of clicks) { assert.equal(c.status, 200); assert.deepEqual(c.data, { unlocked: true, keys: 0 }); }
  r = await app.call('GET', '/api/me/wallet', 'bob');
  assert.deepEqual([r.data.keys, r.data.keysEarned, r.data.keysSpent], [0, 3, 3]);
  r = await app.call('GET', '/api/market/' + lock3.id + '/file', 'bob');
  assert.equal(r.status, 200, 'unlocked once, forever');
  r = await app.call('GET', '/api/market/' + lock3.id, 'bob');
  assert.equal(r.data.unlocked, true);
  r = await app.call('POST', '/api/market/' + lock3.id + '/unlock', 'bob');
  assert.deepEqual(r.data, { unlocked: true, keys: 0 }, 'unlocking again is free');

  r = await app.call('GET', '/api/me/wallet', 'ann');
  assert.deepEqual([r.data.keys, r.data.keysEarned], [1, 1], 'the owner gets a key per unlock');

  r = await app.call('POST', '/api/market/' + lock1.id + '/unlock', 'bob');
  assert.equal(r.status, 402);
  r = await app.call('POST', '/api/market/' + free.id + '/unlock', 'bob');
  assert.deepEqual(r.data, { unlocked: true, keys: 0 }, 'free needs no keys');
  r = await app.call('POST', '/api/market/' + show.id + '/unlock', 'bob');
  assert.equal(r.status, 403);
  r = await app.call('POST', '/api/market/' + own.id + '/unlock', 'bob');
  assert.deepEqual(r.data, { unlocked: true, keys: 0 }, 'your own design');
  r = await app.call('POST', '/api/market/' + lock1.id + '/unlock', null);
  assert.equal(r.status, 401);
  r = await app.call('POST', '/api/market/abcdefgh123/unlock', 'bob');
  assert.equal(r.status, 404);

  // Two different unlocks at the same moment with keys for only one of them.
  app.seedMarks(app.p.cat.id, 10);                        // cat: 1 key
  const lockB = await app.publish('bob', { title: 'Bob one key', mode: 'keys', priceKeys: 1 });
  const race = await Promise.all([lock1.id, lockB.id].map(id => app.call('POST', '/api/market/' + id + '/unlock', 'cat')));
  assert.deepEqual(race.map(x => x.status).sort(), [200, 402]);
  r = await app.call('GET', '/api/me/wallet', 'cat');
  assert.deepEqual([r.data.keys, r.data.keysSpent], [0, 1], 'never below zero');

  // The owner deletes an unlocked design: what was spent and earned stays.
  await app.call('DELETE', '/api/market/' + lock3.id, 'ann');
  r = await app.call('GET', '/api/me/wallet', 'bob');
  assert.equal(r.data.keysSpent, 3);
  r = await app.call('GET', '/api/me/wallet', 'ann');
  assert.ok(r.data.keysEarned >= 1);

  // Discount: 5% per 10 keys, at most 50%.
  app.seedMarks(app.p.ann.id, 1000);                      // +100 keys
  r = await app.call('GET', '/api/me/wallet', 'ann');
  assert.equal(r.data.discountPct, 50);
  assert.equal(r.data.keys, r.data.keysEarned - r.data.keysSpent);
});

// ---------------------------------------------------------------- the top-5 free sew-out

test('free sew-out: exactly five, given atomically when 10,000 is crossed, even at the same moment', opts, async () => {
  const app = await marketApp({ people: ['ann'] });
  const owners = [];
  for (let i = 0; i < 7; i++) {
    const who = 'o' + i;
    await app.as(who, { sub: 'owner-' + i, email: who + '@example.com', name: 'Owner ' + i });
    app.seedMarks(app.p[who].id, 9999);
    owners.push({ who, item: await app.publish(who, { title: 'Design ' + i }) });
  }
  const fans = [];
  for (let i = 0; i < 3; i++) fans.push(await app.as('f' + i, { sub: 'fan-' + i, email: 'f' + i + '@example.com', name: 'Fan ' + i }));

  let r = await app.call('GET', '/api/me/wallet', 'o0');
  assert.equal(r.data.starsReceived, 9999);
  assert.equal(r.data.freeSewout.eligible, false);

  // Every fan stars every design at once: 21 stars, 7 owners crossing 10,000 in the same moment.
  const calls = [];
  for (const f of ['f0', 'f1', 'f2']) for (const o of owners) calls.push(app.call('POST', '/api/market/' + o.item.id + '/star', f));
  const res = await Promise.all(calls);
  assert.ok(res.every(x => x.status === 200));

  const claims = app.db.db.prepare('SELECT rank, user_id FROM sewout_claims ORDER BY rank').all();
  assert.deepEqual(claims.map(c => c.rank), [1, 2, 3, 4, 5]);
  assert.equal(new Set(claims.map(c => c.user_id)).size, 5);
  let winners = 0;
  for (const o of owners) {
    r = await app.call('GET', '/api/me/wallet', o.who);
    assert.equal(r.data.starsReceived, 10002);
    assert.equal(r.data.progressTo10k, 1);
    assert.equal(r.data.freeSewout.slotsLeft, 0);
    if (r.data.freeSewout.eligible) {
      winners++;
      assert.ok(r.data.freeSewout.rank >= 1 && r.data.freeSewout.rank <= 5);
      const page = await app.call('GET', '/api/users/' + app.p[o.who].handle, null);
      assert.ok(page.data.badges.some(b => b.id === 'free-sewout'));
      assert.ok(page.data.badges.some(b => b.id === 'stars-10000'));
    } else {
      assert.equal(r.data.freeSewout.rank, null);
    }
  }
  assert.equal(winners, 5);

  // More stars later change nothing.
  app.seedMarks(app.p.ann.id, 10000);
  const late = await app.as('late', { sub: 'late-1', email: 'late@example.com', name: 'Late' });
  const annItem = await app.publish('ann', { title: 'Late bloomer' });
  await app.call('POST', '/api/market/' + annItem.id + '/star', 'late');
  assert.equal(app.db.get('SELECT COUNT(*) AS n FROM sewout_claims').n, 5);
  r = await app.call('GET', '/api/me/wallet', 'ann');
  assert.deepEqual(r.data.freeSewout, { eligible: false, rank: null, slotsLeft: 0 });
  assert.ok(late && fans.length === 3);
});

test('free sew-out: a person can win only once', opts, async () => {
  const app = await marketApp({ people: ['ann', 'bob', 'cat'] });
  app.seedMarks(app.p.ann.id, 9999);
  const a1 = await app.publish('ann', { title: 'One' });
  const a2 = await app.publish('ann', { title: 'Two' });
  await Promise.all([app.call('POST', '/api/market/' + a1.id + '/star', 'bob'), app.call('POST', '/api/market/' + a2.id + '/star', 'cat'),
    app.call('POST', '/api/market/' + a2.id + '/star', 'bob')]);
  assert.equal(app.db.get('SELECT COUNT(*) AS n FROM sewout_claims').n, 1);
  const r = await app.call('GET', '/api/me/wallet', 'ann');
  assert.deepEqual(r.data.freeSewout, { eligible: true, rank: 1, slotsLeft: 4 });
});

// ---------------------------------------------------------------- profiles, badges, activity

test('profile: designs, badges and the activity graph', opts, async () => {
  const day0 = Date.UTC(2026, 0, 1, 10);
  const app = await marketApp({ now: day0 });
  const pub = await app.publish('ann', { title: 'Public' });
  const priv = await app.publish('ann', { title: 'Private', visibility: 'private' });
  const keys = await app.publish('bob', { title: 'Bob keys', mode: 'keys', priceKeys: 1 });

  // Seven days in a row of saving designs; an export-like event and stars given on top.
  for (let d = 0; d < 7; d++) {
    app.clock.t = day0 + d * 86400000;
    const r = await app.call('PUT', '/api/projects/design_000' + d, 'ann', { name: 'D' + d, data: payload });
    assert.equal(r.status, 200);
  }
  await app.call('POST', '/api/market/' + keys.id + '/star', 'ann');
  await app.call('POST', '/api/market/' + pub.id + '/star', 'bob');
  app.seedMarks(app.p.ann.id, 120, pub.id, day0);         // 121 lifetime stars on that design -> popular + stars-100
  await app.call('POST', '/api/market/' + keys.id + '/unlock', 'ann');

  let r = await app.call('GET', '/api/users/ann-example', 'bob');
  assert.equal(r.status, 200);
  const p = r.data;
  assert.equal(p.handle, 'ann-example');
  assert.equal(p.name, 'Ann Example');
  assert.equal(p.avatar, 'https://lh3.googleusercontent.com/a/x');
  assert.equal(p.joined, day0);
  assert.equal(p.starsReceived, 121);
  assert.deepEqual(p.designs.map(d => d.title), ['Public'], 'others see public designs only');
  assert.equal(p.designs[0].starred, true, 'as seen by the caller');
  const ids = p.badges.map(b => b.id);
  assert.deepEqual(ids, ['first-design', 'first-star', 'stars-100', 'streak-7', 'first-unlock', 'popular', 'early-member']);
  for (const b of p.badges) { assert.equal(typeof b.label, 'string'); assert.equal(typeof b.earnedAt, 'number'); }
  assert.equal(p.badges.find(b => b.id === 'streak-7').earnedAt, Date.UTC(2026, 0, 7));
  assert.equal(p.badges.find(b => b.id === 'first-design').earnedAt, pub.createdAt);

  assert.equal(p.activity.length, 365);
  assert.equal(p.activity[364].date, '2026-01-07');
  const byDay = Object.fromEntries(p.activity.map(a => [a.date, a.count]));
  assert.equal(byDay['2026-01-01'], 3, 'two publishes and a save on day one');
  assert.equal(byDay['2026-01-03'], 1);
  assert.equal(byDay['2026-01-07'], 2, 'a save and a star given');
  assert.equal(byDay['2025-12-31'], 0);

  r = await app.call('GET', '/api/users/ann-example', 'ann');
  assert.deepEqual(r.data.designs.map(d => d.title).sort(), ['Private', 'Public'], 'all of them for yourself');
  assert.ok(priv.id);
  r = await app.call('GET', '/api/users/ANN-EXAMPLE', null);
  assert.equal(r.status, 200, 'handles are not case sensitive');
  assert.equal(r.data.designs[0].starred, false);

  r = await app.call('GET', '/api/users/bob-stitch', null);
  assert.deepEqual(r.data.badges.map(b => b.id), ['first-design', 'first-star', 'early-member']);
  r = await app.call('GET', '/api/users/nobody-here', null);
  assert.equal(r.status, 404);
  r = await app.call('GET', '/api/users/%E0%A4%A', null);
  assert.equal(r.status, 404);
  r = await app.call('GET', '/api/users/' + 'x'.repeat(40), null);
  assert.equal(r.status, 404);

  // Activity drops off after a year.
  app.clock.t = day0 + 400 * 86400000;
  r = await app.call('GET', '/api/users/ann-example', null);
  assert.ok(r.data.activity.every(a => a.count === 0));
});

test('early member: only the first 100 people', opts, async () => {
  const app = await marketApp({ people: ['ann'] });
  app.db.run("WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 100) " +
    "INSERT INTO users (id, google_sub, email, created_at, last_login_at) SELECT 'early-' || x, 'g-' || x, 'e' || x || '@x.com', x, x FROM c");
  app.clock.t += 1000;
  await app.as('bob');
  let r = await app.call('GET', '/api/users/' + app.p.bob.handle, null);
  assert.ok(!r.data.badges.some(b => b.id === 'early-member'), 'the 102nd person');
  r = await app.call('GET', '/api/users/' + app.p.ann.handle, null);
  assert.ok(!r.data.badges.some(b => b.id === 'early-member'), 'ann signed up after the 100 seeded people');
  app.db.run('UPDATE users SET created_at = 0 WHERE id = ?', app.p.ann.id);
  r = await app.call('GET', '/api/users/' + app.p.ann.handle, null);
  assert.ok(r.data.badges.some(b => b.id === 'early-member'));
});

test('exports and saves count as activity', opts, async () => {
  const app = await marketApp({ people: ['ann'] });
  await app.call('PUT', '/api/projects/design_0001', 'ann', { name: 'A', data: payload });
  await app.call('PUT', '/api/projects/design_0001', 'ann', { name: 'A', data: payload });
  const design = { name: 'Patch', hoop: { width: 100, height: 100 }, objects: [{ id: 'p', type: 'rect', x: 30, y: 35, width: 40, height: 30, color: '#1d4ed8' }] };
  const r = await app.call('POST', '/api/export', 'ann', { design, format: 'dst' });
  assert.equal(r.status, 200);
  const rows = app.db.db.prepare('SELECT kind, n FROM events ORDER BY kind').all().map(x => [x.kind, x.n]);
  assert.deepEqual(rows, [['export', 1], ['save', 2]]);
});

// ---------------------------------------------------------------- pictures in R2

test('with an R2 bucket bound as THUMBS, pictures go there', opts, async () => {
  const r2 = new FakeR2();
  const app = await marketApp({ env: { THUMBS: r2 }, people: ['ann', 'bob'] });
  const item = await app.publish('ann', { thumb: webp(64) });
  const row = app.db.get('SELECT thumb FROM market_items WHERE id = ?', item.id);
  assert.equal(row.thumb, 'r2:thumbs/' + item.id);
  assert.equal(r2.objects.size, 1);
  const res = await app.request('GET', '/api/market/' + item.id + '/thumb', {});
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Content-Type'), 'image/webp');
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), Buffer.from(webp(64).split(',')[1], 'base64'));
  await app.call('DELETE', '/api/market/' + item.id, 'ann');
  assert.equal(r2.objects.size, 0, 'deleted with the design');
});

// ---------------------------------------------------------------- sessions

test('auth failures: forged, expired and missing sessions', opts, async () => {
  const app = await marketApp({ people: ['ann', 'bob'] });
  const item = await app.publish('bob', { mode: 'keys', priceKeys: 1 });
  const forged = app.p.ann.cookie.replace(/.$/, c => (c === 'A' ? 'B' : 'A'));
  const routes = [
    ['POST', '/api/market', { title: 'x', payload }],
    ['PATCH', '/api/market/' + item.id, { title: 'x' }],
    ['DELETE', '/api/market/' + item.id],
    ['POST', '/api/market/' + item.id + '/star'],
    ['DELETE', '/api/market/' + item.id + '/star'],
    ['POST', '/api/market/' + item.id + '/unlock'],
    ['GET', '/api/me/wallet'],
    ['PATCH', '/api/me', { handle: 'zzz' }],
  ];
  for (const [m, p, body] of routes) {
    for (const cookie of [undefined, forged, 'el_session=garbage']) {
      const r = await app.request(m, p, { cookie, body });
      assert.equal(r.status, 401, m + ' ' + p + ' ' + (cookie || 'none'));
    }
  }
  app.clock.t += 31 * 86400000;
  const r = await app.request('POST', '/api/market/' + item.id + '/star', { cookie: app.p.ann.cookie });
  assert.equal(r.status, 401, 'expired');
  // Reading stays open to everyone.
  assert.equal((await app.request('GET', '/api/market', { cookie: forged })).status, 200);
  assert.equal((await app.request('GET', '/api/market/' + item.id, {})).status, 200);
});

test('lists never read the big columns: thumb and payload are last, has_thumb is a flag', opts, async () => {
  const app = await marketApp();
  const cols = app.db.db.prepare('PRAGMA table_info(market_items)').all().map(c => c.name);
  assert.deepEqual(cols.slice(-2), ['thumb', 'payload']);
  const a = await app.publish('ann', { thumb: PNG });
  const b = await app.publish('ann', { thumb: undefined });
  assert.equal(app.db.get('SELECT has_thumb FROM market_items WHERE id = ?', a.id).has_thumb, 1);
  assert.equal(app.db.get('SELECT has_thumb FROM market_items WHERE id = ?', b.id).has_thumb, 0);
  const r = await app.call('GET', '/api/market', null);
  const byId = Object.fromEntries(r.data.items.map(i => [i.id, i]));
  assert.ok(byId[a.id].thumb);
  assert.equal(byId[b.id].thumb, null);
  const f = await app.call('GET', '/api/market/' + a.id + '/file', null);
  assert.equal(f.res.headers.get('X-Content-Type-Options'), 'nosniff');
});
