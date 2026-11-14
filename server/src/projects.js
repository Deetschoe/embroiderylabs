// Saved canvases: one row per design, owned by one user.

import { HttpError } from './http.js';

export const MAX_PROJECT_BYTES = 1000000;     // the design JSON, UTF-8 (D1 allows about 2 MB per value)
export const MAX_PROJECTS = 200;              // per user
const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

export function checkId(id) {
  if (!ID_RE.test(id || '')) throw new HttpError(400, 'bad_id', 'That is not a design id.');
  return id;
}
function cleanName(name) {
  const s = String(name == null ? '' : name).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 80);
  return s || 'untitled';
}

export async function list(db, userId) {
  const { results } = await db.prepare(
    'SELECT id, name, size, created_at, updated_at FROM projects WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?'
  ).bind(userId, MAX_PROJECTS).all();
  return (results || []).map(r => ({ id: r.id, name: r.name, size: r.size, createdAt: r.created_at, updatedAt: r.updated_at }));
}

export async function get(db, userId, id) {
  const r = await db.prepare('SELECT id, name, data, size, created_at, updated_at FROM projects WHERE id = ? AND user_id = ?').bind(checkId(id), userId).first();
  if (!r) throw new HttpError(404, 'not_found', 'That design is not in your account.');
  let data = null;
  try { data = JSON.parse(r.data); } catch (e) { data = null; }
  return { id: r.id, name: r.name, size: r.size, createdAt: r.created_at, updatedAt: r.updated_at, data };
}

// Create or replace. -> { id, name, size, updatedAt, created }
export async function put(db, userId, id, body, nowMs) {
  checkId(id);
  if (!body || typeof body !== 'object' || !body.data || typeof body.data !== 'object' || Array.isArray(body.data)) {
    throw new HttpError(400, 'bad_project', 'Send the design as { name, data }.');
  }
  const text = JSON.stringify(body.data);
  const size = new TextEncoder().encode(text).length;
  if (size > MAX_PROJECT_BYTES) throw new HttpError(413, 'too_large', 'This design is too big to save to your account (over 1 MB). Save it as a file instead.');
  const name = cleanName(body.name);

  const upd = await db.prepare('UPDATE projects SET name = ?, data = ?, size = ?, updated_at = ? WHERE id = ? AND user_id = ?')
    .bind(name, text, size, nowMs, id, userId).run();
  if (upd.meta && upd.meta.changes) return { id, name, size, updatedAt: nowMs, created: false };

  // New design: insert only while the user is under the cap (one statement, so it cannot overshoot).
  const ins = await db.prepare(
    'INSERT INTO projects (id, user_id, name, data, size, created_at, updated_at) SELECT ?, ?, ?, ?, ?, ?, ? ' +
    'WHERE (SELECT COUNT(*) FROM projects WHERE user_id = ?) < ? ON CONFLICT(id) DO NOTHING'
  ).bind(id, userId, name, text, size, nowMs, nowMs, userId, MAX_PROJECTS).run();
  if (ins.meta && ins.meta.changes) return { id, name, size, updatedAt: nowMs, created: true };
  const taken = await db.prepare('SELECT 1 AS x FROM projects WHERE id = ?').bind(id).first();
  if (taken) throw new HttpError(409, 'id_taken', 'That design id is already used. Save again.');
  throw new HttpError(403, 'too_many', 'Your account holds ' + MAX_PROJECTS + ' designs. Delete one to save another.');
}

export async function remove(db, userId, id) {
  const r = await db.prepare('DELETE FROM projects WHERE id = ? AND user_id = ?').bind(checkId(id), userId).run();
  if (!r.meta || !r.meta.changes) throw new HttpError(404, 'not_found', 'That design is not in your account.');
}
