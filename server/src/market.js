// Marketplace: published designs, stars and key unlocks. Rules: economy.js. People: users.js.
//
// Who sees what
//   public   listed, anyone can see the item and its thumbnail
//   private  only the owner; to everyone else it does not exist (404)
// Who gets the .embroidr file
//   the owner always; others: mode 'free', or mode 'keys' after an unlock; mode 'show' never.
//
// Everything that moves keys or stars is one SQL statement or one D1 batch (a transaction), so a
// double click or two requests at once cannot spend keys twice, star twice or give out a 6th claim.

import { HttpError, randomId } from './http.js';
import * as Economy from './economy.js';
import { MAX_PROJECT_BYTES } from './projects.js';
import { eventStmt, recordEvent, shownName, WALLET_SQL } from './users.js';

export const MAX_PAYLOAD_BYTES = MAX_PROJECT_BYTES;      // the .embroidr JSON, same cap as saved designs
export const MAX_THUMB_BYTES = 200 * 1024;               // decoded image bytes
export const MAX_TITLE = 80;
export const MAX_DESCRIPTION = 1000;
export const MAX_TAGS = 8;
export const MAX_TAG = 24;
export const MAX_ITEMS_PER_USER = 500;
export const PUBLISH_RATE = { perWindow: 20, windowMs: 3600 * 1000 };
export const PAGE = { size: 24, max: 48 };
const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

export function checkId(id) {
  if (!ID_RE.test(id || '')) throw new HttpError(404, 'not_found', 'That design is not here.');
  return id;
}
function notFound() { return new HttpError(404, 'not_found', 'That design is not here.'); }

// ---------------------------------------------------------------- input

function text(v, max, field, keepNewlines) {
  if (v == null) return '';
  if (typeof v !== 'string') throw new HttpError(400, 'bad_' + field, 'The ' + field + ' must be text.');
  let s = keepNewlines
    ? v.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ').replace(/\n{3,}/g, '\n\n')
    : v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ');
  s = s.trim();
  if (s.length > max) throw new HttpError(400, 'bad_' + field, 'The ' + field + ' can be at most ' + max + ' characters.');
  return s;
}

export function cleanTag(t) {
  if (typeof t !== 'string') return '';
  return t.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N} -]+/gu, ' ').replace(/\s+/g, ' ').trim();
}
function tags(v) {
  if (v == null) return [];
  if (!Array.isArray(v)) throw new HttpError(400, 'bad_tags', 'Send tags as a list.');
  if (v.length > MAX_TAGS) throw new HttpError(400, 'bad_tags', 'At most ' + MAX_TAGS + ' tags.');
  const out = [];
  for (const t of v) {
    const s = cleanTag(t);
    if (!s) continue;
    if (s.length > MAX_TAG) throw new HttpError(400, 'bad_tags', 'A tag can be at most ' + MAX_TAG + ' characters.');
    if (!out.includes(s)) out.push(s);
  }
  return out;
}
function tagsKey(list) { return ',' + list.join(',') + ','; }

function mode(v) {
  if (!Economy.MODES.includes(v)) throw new HttpError(400, 'bad_mode', 'Pick free, keys or show.');
  return v;
}
function visibility(v) {
  if (!Economy.VISIBILITIES.includes(v)) throw new HttpError(400, 'bad_visibility', 'Pick public or private.');
  return v;
}
function price(v) {
  if (!Economy.validPrice(v)) {
    throw new HttpError(400, 'bad_price', 'A price is ' + Economy.RULES.priceKeysMin + ' to ' + Economy.RULES.priceKeysMax + ' keys.');
  }
  return v;
}

function payloadText(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p) || !p.doc || typeof p.doc !== 'object' || !Array.isArray(p.doc.objects)) {
    throw new HttpError(400, 'bad_payload', 'Send the design as an .embroidr file.');
  }
  const s = JSON.stringify(p);
  const size = new TextEncoder().encode(s).length;
  if (size > MAX_PAYLOAD_BYTES) throw new HttpError(413, 'too_large', 'This design is too big to publish (over 1 MB).');
  return { text: s, size };
}

// data:image/webp|png;base64,... -> { mime, bytes, url } (checked: size and the file's first bytes)
export function parseThumb(v) {
  if (typeof v !== 'string') throw new HttpError(400, 'bad_thumb', 'The picture must be a WebP or PNG.');
  const m = /^data:image\/(webp|png);base64,([A-Za-z0-9+/]+={0,2})$/.exec(v);
  if (!m) throw new HttpError(400, 'bad_thumb', 'The picture must be a WebP or PNG.');
  if (m[2].length > Math.ceil(MAX_THUMB_BYTES / 3) * 4) throw new HttpError(413, 'thumb_too_large', 'The picture can be at most 200 KB.');
  let bin;
  try { bin = atob(m[2]); } catch (e) { throw new HttpError(400, 'bad_thumb', 'The picture must be a WebP or PNG.'); }
  if (bin.length > MAX_THUMB_BYTES) throw new HttpError(413, 'thumb_too_large', 'The picture can be at most 200 KB.');
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const png = bytes.length > 8 && bytes[0] === 0x89 && bin.slice(1, 4) === 'PNG';
  const webp = bytes.length > 12 && bin.slice(0, 4) === 'RIFF' && bin.slice(8, 12) === 'WEBP';
  if ((m[1] === 'png' && !png) || (m[1] === 'webp' && !webp)) throw new HttpError(400, 'bad_thumb', 'The picture must be a WebP or PNG.');
  return { mime: 'image/' + m[1], bytes, url: v };
}

// ---------------------------------------------------------------- reading items

// Columns for an Item as seen by `viewer` (a user id or ''). Never the payload or the picture itself.
const ITEM_COLS =
  'i.id, i.title, i.description, i.tags, i.mode, i.price_keys, i.visibility, i.stars, i.created_at, i.updated_at,' +
  ' i.user_id, i.has_thumb, u.handle, u.name, u.display_name, u.picture,' +
  ' EXISTS(SELECT 1 FROM stars s WHERE s.user_id = ? AND s.item_id = i.id) AS starred,' +
  ' EXISTS(SELECT 1 FROM unlocks k WHERE k.user_id = ? AND k.item_id = i.id) AS unlock_row';
const ITEM_FROM = ' FROM market_items i JOIN users u ON u.id = i.user_id ';

export function toItem(r, viewer, base) {
  const mine = !!viewer && r.user_id === viewer;
  let t = [];
  try { t = JSON.parse(r.tags); } catch (e) { t = []; }
  return {
    id: r.id,
    title: r.title,
    description: r.description,
    tags: Array.isArray(t) ? t : [],
    mode: r.mode,
    priceKeys: r.mode === 'keys' ? Number(r.price_keys) : 0,
    visibility: r.visibility,
    owner: { handle: r.handle || '', name: shownName(r), avatar: r.picture || '' },
    thumb: Number(r.has_thumb) ? base + '/api/market/' + encodeURIComponent(r.id) + '/thumb?v=' + Number(r.updated_at) : null,
    stars: Number(r.stars),
    starred: !!Number(r.starred),
    unlocked: mine || r.mode === 'free' || (r.mode === 'keys' && !!Number(r.unlock_row)),
    mine,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

async function row(db, viewer, id) {
  const r = await db.prepare('SELECT ' + ITEM_COLS + ITEM_FROM + 'WHERE i.id = ?').bind(viewer, viewer, checkId(id)).first();
  if (!r || (r.visibility !== 'public' && r.user_id !== viewer)) throw notFound();
  return r;
}

export async function get(db, viewer, id, base) {
  return toItem(await row(db, viewer || '', id), viewer || '', base);
}

function encodeCursor(o) { return btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function decodeCursor(s) {
  try {
    const o = JSON.parse(atob(s.replace(/-/g, '+').replace(/_/g, '/')));
    if (o && Number.isFinite(o.c) && typeof o.i === 'string' && (o.s === undefined || Number.isFinite(o.s))) return o;
  } catch (e) { /* fall through */ }
  throw new HttpError(400, 'bad_cursor', 'That page link is not valid.');
}

// GET /api/market?sort=new|top&tag=&q=&cursor=&limit= -> { items, next }
export async function list(db, viewer, params, base) {
  viewer = viewer || '';
  const sort = params.get('sort') || 'new';
  if (sort !== 'new' && sort !== 'top') throw new HttpError(400, 'bad_sort', 'Sort by new or top.');
  let limit = PAGE.size;
  if (params.get('limit')) {
    limit = Number(params.get('limit'));
    if (!Number.isInteger(limit) || limit < 1 || limit > PAGE.max) throw new HttpError(400, 'bad_limit', 'Ask for 1 to ' + PAGE.max + ' designs.');
  }
  const where = ["i.visibility = 'public'"], binds = [viewer, viewer];
  const tag = cleanTag(params.get('tag') || '');
  if (tag) { where.push('instr(i.tags_key, ?) > 0'); binds.push(',' + tag.slice(0, MAX_TAG) + ','); }
  const q = (params.get('q') || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().toLowerCase().slice(0, 60);
  if (q) { where.push("instr(lower(i.title || ' ' || i.description || ' ' || i.tags_key), ?) > 0"); binds.push(q); }
  const cur = params.get('cursor');
  if (cur) {
    const c = decodeCursor(cur);
    if (sort === 'new') {
      where.push('(i.created_at < ? OR (i.created_at = ? AND i.id < ?))'); binds.push(c.c, c.c, c.i);
    } else {
      const s = Number(c.s) || 0;
      where.push('(i.stars < ? OR (i.stars = ? AND (i.created_at < ? OR (i.created_at = ? AND i.id < ?))))');
      binds.push(s, s, c.c, c.c, c.i);
    }
  }
  const order = sort === 'new' ? 'i.created_at DESC, i.id DESC' : 'i.stars DESC, i.created_at DESC, i.id DESC';
  const { results } = await db.prepare('SELECT ' + ITEM_COLS + ITEM_FROM + 'WHERE ' + where.join(' AND ') + ' ORDER BY ' + order + ' LIMIT ?')
    .bind(...binds, limit + 1).all();
  const rows = results || [];
  let next = null;
  if (rows.length > limit) {
    rows.length = limit;
    const last = rows[rows.length - 1];
    next = encodeCursor(sort === 'new' ? { c: Number(last.created_at), i: last.id } : { s: Number(last.stars), c: Number(last.created_at), i: last.id });
  }
  return { items: rows.map(r => toItem(r, viewer, base)), next };
}

// A person's designs for their profile: public ones, or all of them for the person themself.
export async function byOwner(db, viewer, ownerId, base) {
  viewer = viewer || '';
  const all = viewer === ownerId;
  const { results } = await db.prepare('SELECT ' + ITEM_COLS + ITEM_FROM + 'WHERE i.user_id = ?' +
    (all ? '' : " AND i.visibility = 'public'") + ' ORDER BY i.created_at DESC, i.id DESC LIMIT ?')
    .bind(viewer, viewer, ownerId, MAX_ITEMS_PER_USER).all();
  return (results || []).map(r => toItem(r, viewer, base));
}

// GET /api/market/:id/file -> the .embroidr JSON, or 403 locked
export async function file(db, viewer, id) {
  viewer = viewer || '';
  const r = await db.prepare(
    'SELECT i.user_id, i.visibility, i.mode, i.payload, EXISTS(SELECT 1 FROM unlocks k WHERE k.user_id = ? AND k.item_id = i.id) AS unlock_row ' +
    'FROM market_items i WHERE i.id = ?'
  ).bind(viewer, checkId(id)).first();
  if (!r || (r.visibility !== 'public' && r.user_id !== viewer)) throw notFound();
  const ok = r.user_id === viewer || r.mode === 'free' || (r.mode === 'keys' && !!Number(r.unlock_row));
  if (!ok) {
    throw new HttpError(403, 'locked', r.mode === 'show' ? 'This design is for looking at only.' : 'Unlock this design with keys to open it.');
  }
  return new Response(r.payload, { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
}

function dataUrlBytes(url) {
  const m = /^data:(image\/(?:webp|png));base64,(.*)$/.exec(url);
  if (!m) return null;
  const bin = atob(m[2]);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { mime: m[1], bytes };
}

// GET /api/market/:id/thumb -> the picture
export async function thumb(env, db, viewer, id) {
  viewer = viewer || '';
  const r = await db.prepare('SELECT user_id, visibility, thumb FROM market_items WHERE id = ?').bind(checkId(id)).first();
  if (!r || (r.visibility !== 'public' && r.user_id !== viewer) || !r.thumb) throw notFound();
  let img = null;
  if (r.thumb.startsWith('r2:')) {
    const obj = env.THUMBS ? await env.THUMBS.get(r.thumb.slice(3)) : null;
    if (obj) img = { mime: (obj.httpMetadata && obj.httpMetadata.contentType) || 'image/webp', bytes: new Uint8Array(await obj.arrayBuffer()) };
  } else {
    img = dataUrlBytes(r.thumb);
  }
  if (!img) throw notFound();
  return new Response(img.bytes, {
    status: 200,
    headers: {
      'Content-Type': img.mime,
      'Cache-Control': r.visibility === 'public' ? 'public, max-age=86400' : 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

// ---------------------------------------------------------------- writing items

// Thumbnails live in D1 as a data URL; with an R2 bucket bound as THUMBS they go there instead.
async function storeThumb(env, id, t) {
  if (!t) return '';
  if (env.THUMBS) {
    const key = 'thumbs/' + id;
    await env.THUMBS.put(key, t.bytes, { httpMetadata: { contentType: t.mime } });
    return 'r2:' + key;
  }
  return t.url;
}
async function dropThumb(env, stored) {
  if (stored && stored.startsWith('r2:') && env.THUMBS) {
    try { await env.THUMBS.delete(stored.slice(3)); } catch (e) { console.error('thumb delete', e && e.message); }
  }
}

// POST /api/market -> Item
export async function publish(env, db, user, body, nowMs, base) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'bad_request', 'Send the design and its details.');
  const title = text(body.title, MAX_TITLE, 'title');
  if (!title) throw new HttpError(400, 'bad_title', 'Give the design a title.');
  const description = text(body.description, MAX_DESCRIPTION, 'description', true);
  const tagList = tags(body.tags);
  const m = mode(body.mode == null ? 'free' : body.mode);
  const p = m === 'keys' ? price(body.priceKeys == null ? 1 : body.priceKeys) : 0;
  const vis = visibility(body.visibility == null ? 'public' : body.visibility);
  const pl = payloadText(body.payload);
  const th = body.thumb == null || body.thumb === '' ? null : parseThumb(body.thumb);

  const id = randomId(12);
  const stored = await storeThumb(env, id, th);
  // One statement: under the per-person cap and the hourly publish limit, or nothing is written.
  const res = await db.prepare(
    'INSERT INTO market_items (id, user_id, title, description, tags, tags_key, mode, price_keys, visibility, payload, size, thumb, has_thumb, stars, created_at, updated_at) ' +
    'SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ? ' +
    'WHERE (SELECT COUNT(*) FROM market_items WHERE user_id = ?) < ? AND (SELECT COUNT(*) FROM market_items WHERE user_id = ? AND created_at > ?) < ?'
  ).bind(id, user.id, title, description, JSON.stringify(tagList), tagsKey(tagList), m, p, vis, pl.text, pl.size, stored, stored ? 1 : 0, nowMs, nowMs,
    user.id, MAX_ITEMS_PER_USER, user.id, nowMs - PUBLISH_RATE.windowMs, PUBLISH_RATE.perWindow).run();
  if (!res.meta || !res.meta.changes) {
    await dropThumb(env, stored);
    const n = await db.prepare('SELECT COUNT(*) AS n FROM market_items WHERE user_id = ?').bind(user.id).first();
    if (Number(n.n) >= MAX_ITEMS_PER_USER) throw new HttpError(403, 'too_many', 'You have ' + MAX_ITEMS_PER_USER + ' designs up. Delete one to publish another.');
    throw new HttpError(429, 'slow_down', 'That is a lot of designs in an hour. Try again later.');
  }
  await recordEvent(db, user.id, 'publish', nowMs);
  return get(db, user.id, id, base);
}

async function ownRow(db, userId, id) {
  const r = await db.prepare('SELECT id, user_id, visibility, mode, price_keys, thumb FROM market_items WHERE id = ?').bind(checkId(id)).first();
  if (!r || (r.visibility !== 'public' && r.user_id !== userId)) throw notFound();
  if (r.user_id !== userId) throw new HttpError(403, 'not_owner', 'Only the owner can change this design.');
  return r;
}

// PATCH /api/market/:id { title?, description?, tags?, mode?, priceKeys?, visibility? } -> Item
export async function update(db, user, id, body, nowMs, base) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'bad_request', 'Send the details to change.');
  const r = await ownRow(db, user.id, id);
  const sets = [], binds = [];
  if (body.title !== undefined) {
    const t = text(body.title, MAX_TITLE, 'title');
    if (!t) throw new HttpError(400, 'bad_title', 'Give the design a title.');
    sets.push('title = ?'); binds.push(t);
  }
  if (body.description !== undefined) { sets.push('description = ?'); binds.push(text(body.description, MAX_DESCRIPTION, 'description', true)); }
  if (body.tags !== undefined) { const t = tags(body.tags); sets.push('tags = ?', 'tags_key = ?'); binds.push(JSON.stringify(t), tagsKey(t)); }
  if (body.visibility !== undefined) { sets.push('visibility = ?'); binds.push(visibility(body.visibility)); }
  if (body.mode !== undefined || body.priceKeys !== undefined) {
    const m = body.mode !== undefined ? mode(body.mode) : r.mode;
    let p = 0;
    if (m === 'keys') p = body.priceKeys !== undefined ? price(body.priceKeys) : (Number(r.price_keys) || 1);
    sets.push('mode = ?', 'price_keys = ?'); binds.push(m, p);
  }
  if (sets.length) {
    sets.push('updated_at = ?'); binds.push(nowMs);
    await db.prepare('UPDATE market_items SET ' + sets.join(', ') + ' WHERE id = ? AND user_id = ?').bind(...binds, r.id, user.id).run();
  }
  return get(db, user.id, r.id, base);
}

// DELETE /api/market/:id. Its stars go with it; unlocks stay (keys already spent and earned).
export async function remove(env, db, user, id) {
  const r = await ownRow(db, user.id, id);
  const res = await db.prepare('DELETE FROM market_items WHERE id = ? AND user_id = ?').bind(r.id, user.id).run();
  if (!res.meta || !res.meta.changes) throw notFound();
  await dropThumb(env, r.thumb);
  return { deleted: true };
}

// ---------------------------------------------------------------- stars

async function starTarget(db, userId, id) {
  const r = await db.prepare('SELECT id, user_id, visibility, EXISTS(SELECT 1 FROM stars WHERE user_id = ? AND item_id = ?) AS starred FROM market_items WHERE id = ?')
    .bind(userId, checkId(id), id).first();
  if (!r || (r.visibility !== 'public' && r.user_id !== userId)) throw notFound();
  if (r.user_id === userId) throw new HttpError(400, 'own_design', 'You cannot star your own design.');
  return r;
}

// The top-5 free sew-out: given to the owner in the same transaction as the star that takes their
// lifetime stars to 10,000, while fewer than 5 are given. rank is the primary key (1..5) and user_id
// is unique, so even two transactions at once cannot give out a 6th or a second one.
export function claimStmt(db, ownerId, nowMs) {
  const R = Economy.RULES;
  return db.prepare(
    'INSERT OR IGNORE INTO sewout_claims (rank, user_id, claimed_at) ' +
    'SELECT (SELECT COUNT(*) FROM sewout_claims) + 1, ?, ? ' +
    'WHERE (SELECT COUNT(*) FROM star_marks WHERE owner_id = ?) >= ? AND (SELECT COUNT(*) FROM sewout_claims) < ? ' +
    'AND NOT EXISTS (SELECT 1 FROM sewout_claims WHERE user_id = ?)'
  ).bind(ownerId, nowMs, ownerId, R.sewoutStars, R.sewoutSlots, ownerId);
}

function countStmt(db, id) {
  return db.prepare('UPDATE market_items SET stars = (SELECT COUNT(*) FROM stars WHERE item_id = ?) WHERE id = ?').bind(id, id);
}
async function starCount(db, id) {
  const r = await db.prepare('SELECT stars FROM market_items WHERE id = ?').bind(id).first();
  return r ? Number(r.stars) : 0;
}

// POST /api/market/:id/star -> { stars, starred: true }
export async function star(db, user, id, nowMs) {
  const r = await starTarget(db, user.id, id);
  if (!Number(r.starred)) {
    const stmts = [
      db.prepare("INSERT INTO stars (user_id, item_id, owner_id, created_at) SELECT ?, id, user_id, ? FROM market_items WHERE id = ? AND visibility = 'public' AND user_id != ? ON CONFLICT(user_id, item_id) DO NOTHING")
        .bind(user.id, nowMs, r.id, user.id),
      db.prepare('INSERT OR IGNORE INTO star_marks (user_id, item_id, owner_id, created_at) SELECT user_id, item_id, owner_id, created_at FROM stars WHERE user_id = ? AND item_id = ?')
        .bind(user.id, r.id),
      countStmt(db, r.id),
      claimStmt(db, r.user_id, nowMs),
      eventStmt(db, user.id, 'star-given', nowMs),
    ];
    await db.batch(stmts);
  }
  return { stars: await starCount(db, r.id), starred: true };
}

// DELETE /api/market/:id/star -> { stars, starred: false }. Lifetime stars received are kept.
export async function unstar(db, user, id) {
  const r = await starTarget(db, user.id, id);
  await db.batch([
    db.prepare('DELETE FROM stars WHERE user_id = ? AND item_id = ?').bind(user.id, r.id),
    countStmt(db, r.id),
  ]);
  return { stars: await starCount(db, r.id), starred: false };
}

// ---------------------------------------------------------------- unlocks

async function keysOf(db, userId) {
  const r = await db.prepare(WALLET_SQL).bind(userId).first();
  return Economy.keysLeft(Economy.keysEarned(r.stars_received, r.unlocks_of_yours), r.keys_spent);
}

// POST /api/market/:id/unlock -> { unlocked: true, keys } | 402 not-enough-keys
export async function unlock(db, user, id, nowMs) {
  const r = await db.prepare('SELECT id, user_id, visibility, mode, price_keys FROM market_items WHERE id = ?').bind(checkId(id)).first();
  if (!r || (r.visibility !== 'public' && r.user_id !== user.id)) throw notFound();
  if (r.user_id === user.id || r.mode === 'free') return { unlocked: true, keys: await keysOf(db, user.id) };
  if (r.mode === 'show') throw new HttpError(403, 'show-only', 'This design is for looking at only.');
  // One statement: the balance check and the spend happen together, and (user, item) is unique,
  // so a double click or two unlocks at once never spend more keys than there are.
  const res = await db.prepare(
    'INSERT INTO unlocks (user_id, item_id, owner_id, price_keys, created_at) ' +
    "SELECT ?, i.id, i.user_id, i.price_keys, ? FROM market_items i WHERE i.id = ? AND i.mode = 'keys' AND i.visibility = 'public' AND i.user_id != ? " +
    // CAST: whole keys, as in economy.js, even when the driver binds 10 as a REAL.
    'AND (CAST((SELECT COUNT(*) FROM star_marks WHERE owner_id = ?) / ? AS INTEGER) + (SELECT COUNT(*) FROM unlocks WHERE owner_id = ?) ' +
    '     - (SELECT COALESCE(SUM(price_keys), 0) FROM unlocks WHERE user_id = ?)) >= i.price_keys ' +
    'ON CONFLICT(user_id, item_id) DO NOTHING'
  ).bind(user.id, nowMs, r.id, user.id, user.id, Economy.RULES.starsPerKey, user.id, user.id).run();
  const keys = await keysOf(db, user.id);
  if (res.meta && res.meta.changes) return { unlocked: true, keys };
  const had = await db.prepare('SELECT 1 AS x FROM unlocks WHERE user_id = ? AND item_id = ?').bind(user.id, r.id).first();
  if (had) return { unlocked: true, keys };
  throw new HttpError(402, 'not-enough-keys', 'You need ' + Number(r.price_keys) + ' keys to unlock this design.', { keys, need: Number(r.price_keys) });
}

