// Marketplace test helpers: pictures, a design payload, people, publishing, seeded stars, a fake R2.

import { makeApp } from './helpers.mjs';

// A real 1x1 PNG and a minimal WebP header (the server checks the first bytes, not the whole image).
export const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
export function webp(extraBytes) {
  const body = Buffer.concat([Buffer.from('WEBPVP8 '), Buffer.alloc(extraBytes || 16, 7)]);
  const head = Buffer.alloc(8); head.write('RIFF', 0); head.writeUInt32LE(body.length, 4);
  return 'data:image/webp;base64,' + Buffer.concat([head, body]).toString('base64');
}

export const payload = { v: 1, app: 'embroidr', savedAt: 1, doc: { name: 'Bee', hoop: { w: 130, h: 180 }, objects: [{ id: 'a', type: 'rect', x: 1, y: 2, w: 3, h: 4 }] } };

export const PEOPLE = {
  ann: { sub: '1001', email: 'ann@example.com', name: 'Ann Example' },
  bob: { sub: '2002', email: 'bob@example.com', name: 'Bob Stitch' },
  cat: { sub: '3003', email: 'cat@example.com', name: 'Cat Thread' },
};

// An app with signed-in people: app.p.ann = { cookie, id, handle }
export async function marketApp(opts) {
  const app = await makeApp(opts);
  app.p = {};
  app.as = async (who, claims) => {
    const s = await app.signIn(Object.assign({}, PEOPLE[who] || {}, claims || {}));
    const sub = (claims && claims.sub) || (PEOPLE[who] && PEOPLE[who].sub);
    const id = app.userId(sub);
    const handle = app.db.get('SELECT handle FROM users WHERE id = ?', id).handle;
    app.p[who] = { cookie: s.cookie, id, handle, body: s.body };
    return app.p[who];
  };
  for (const who of (opts && opts.people) || ['ann', 'bob', 'cat']) await app.as(who);
  app.call = async (method, p, who, body, extra) => {
    const res = await app.request(method, p, Object.assign({ cookie: who ? app.p[who].cookie : undefined, body }, extra || {}));
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch (e) { data = text; }
    return { status: res.status, data, res };
  };
  app.publish = async (who, fields) => {
    const r = await app.call('POST', '/api/market', who, Object.assign({ title: 'Bee', description: 'A small bee', tags: ['insect'], mode: 'free', visibility: 'public', payload, thumb: PNG }, fields || {}));
    if (r.status !== 201) throw new Error('publish failed ' + r.status + ' ' + JSON.stringify(r.data));
    app.clock.t += 1000;
    return r.data;
  };
  // n lifetime stars received by `ownerId`, from made-up people, on a made-up (or given) design.
  app.seedMarks = (ownerId, n, itemId, at) => {
    app.db.run(
      'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < ?) ' +
      "INSERT INTO star_marks (user_id, item_id, owner_id, created_at) SELECT 'seed-' || ? || '-' || x, ?, ?, ? + x FROM c",
      n, itemId || ownerId, itemId || ('seed-item-' + ownerId), ownerId, at != null ? at : 0);
  };
  return app;
}

// An R2 bucket in memory (put / get / delete, as the Workers binding).
export class FakeR2 {
  constructor() { this.objects = new Map(); }
  async put(key, bytes, opts) { this.objects.set(key, { bytes: new Uint8Array(bytes), type: opts && opts.httpMetadata && opts.httpMetadata.contentType }); }
  async get(key) {
    const o = this.objects.get(key);
    if (!o) return null;
    return { httpMetadata: { contentType: o.type }, arrayBuffer: async () => o.bytes.buffer.slice(o.bytes.byteOffset, o.bytes.byteOffset + o.bytes.byteLength) };
  }
  async delete(key) { this.objects.delete(key); }
}
