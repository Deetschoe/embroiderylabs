/*
 * Editor groups in the model: pure node, js/editor/geom.js and js/editor/model.js in a vm.
 *
 *   node tests/editor/groups-model.test.js
 *
 * Proves:
 *   - grouping keeps the members next to each other and, for shapes that already follow each other,
 *     changes nothing about the sewing order; the engine input stays byte-identical to before grouping;
 *   - every design in designs/*.embroidr gives the same engine input with every shape grouped as without;
 *   - ungroup, rename, undo / redo of group and ungroup, reorder of a whole group as one block and of a
 *     shape inside its group, place() into and out of a group, delete, duplicate and copy / paste;
 *   - cut pieces and eraser pieces stay in their group;
 *   - save / load keeps groups; a file without groups (v1) loads with none; hostile group data
 *     (bad ids, unknown groups, scattered members, duplicates) loads into valid groups.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REPO = path.join(__dirname, '..', '..');
const Engine = require(path.join(REPO, 'js', 'engine', 'engine.js'));

function loadEditor() {
  const win = { Engine, localStorage: { getItem() { return null; }, setItem() {} } };
  win.window = win;
  const ctx = vm.createContext(win);
  for (const f of ['geom.js', 'model.js']) vm.runInContext(fs.readFileSync(path.join(REPO, 'js', 'editor', f), 'utf8'), ctx, { filename: f });
  return win.Editor;
}

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); } catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e).toString().split('\n').slice(0, 3).join('\n       ')); }
}

const Ed = loadEditor(), M = Ed.Model;
const plain = v => JSON.parse(JSON.stringify(v));
function rect(id, x, color) { return { id, name: id, type: 'rect', x, y: 20, w: 10, h: 10, color: color || '#c0392b', paint: 'fill', lineType: 'running', lineWidth: 3, spacing: 0.4, stitchLen: 3, angle: 0, pattern: 'smooth' }; }
function fresh(n) {
  const objs = []; for (let i = 0; i < (n || 5); i++) objs.push(rect('s' + i, 5 + i * 15));
  M.load({ name: 'groups', hoop: { w: 130, h: 180 }, objects: objs });
}
const order = () => M.doc.objects.map(o => o.id).join(',');
const groupsOf = () => M.doc.objects.map(o => o.group ? M.group(o.group).name : '-').join(',');
const engineJson = () => JSON.stringify(M.toEngine());

test('grouping shapes that follow each other changes neither the order nor the engine input', () => {
  fresh(5);
  const before = engineJson(), ord = order();
  const g = M.groupShapes(['s1', 's2', 's3']);
  assert.ok(g && g.name === 'Group 1');
  assert.strictEqual(order(), ord);
  assert.strictEqual(engineJson(), before);
  assert.deepStrictEqual(plain(M.members(g.id)), ['s1', 's2', 's3']);
  assert.deepStrictEqual(plain(M.selection), ['s1', 's2', 's3']);
  assert.strictEqual(M.undoLabel(), 'Group');
  assert.ok(engineJson().indexOf(g.id) === -1 && engineJson().indexOf('"group"') === -1, 'no group reaches the engine');
});

test('grouping scattered shapes gathers them where the last one was sewn', () => {
  fresh(5);
  const g = M.groupShapes(['s0', 's3']);
  assert.strictEqual(order(), 's1,s2,s0,s3,s4');
  assert.strictEqual(groupsOf(), '-,-,Group 1,Group 1,-');
  assert.deepStrictEqual(plain(M.members(g.id)), ['s0', 's3']);
});

test('a new group never lands inside another group', () => {
  fresh(6);
  const a = M.groupShapes(['s2', 's3', 's4']);
  const b = M.groupShapes(['s0', 's3']);                          /* takes s3 out of a */
  assert.deepStrictEqual(plain(M.members(a.id)), ['s2', 's4']);
  const ids = M.doc.objects.map(o => o.group || '-');
  /* each group is one run */
  [a.id, b.id].forEach(gid => { const first = ids.indexOf(gid), last = ids.lastIndexOf(gid); assert.ok(ids.slice(first, last + 1).every(x => x === gid), 'contiguous ' + ids.join(',')); });
});

test('grouping exactly an existing group does nothing; one shape can be a group', () => {
  fresh(3);
  const g = M.groupShapes(['s0', 's1']);
  const n = M.historySize();
  assert.strictEqual(M.groupShapes(['s0', 's1']), null);
  assert.strictEqual(M.historySize(), n);
  assert.ok(M.groupShapes(['s2']));
  assert.strictEqual(M.groups().length, 2);
  assert.ok(g);
});

test('ungroup frees the shapes in place and selects them; undo / redo cover group and ungroup', () => {
  fresh(4);
  const snap0 = JSON.stringify(M.serialize());
  const g = M.groupShapes(['s1', 's2']);
  const snap1 = JSON.stringify(M.serialize());
  M.select(['s1']);
  assert.strictEqual(M.ungroup(['s1']), 1);
  assert.strictEqual(M.groups().length, 0);
  assert.strictEqual(order(), 's0,s1,s2,s3');
  assert.deepStrictEqual(plain(M.selection), ['s1', 's2']);
  assert.strictEqual(M.undoLabel(), 'Ungroup');
  M.undo(); assert.strictEqual(JSON.stringify(M.serialize()), snap1); assert.ok(M.group(g.id));
  M.undo(); assert.strictEqual(JSON.stringify(M.serialize()), snap0); assert.strictEqual(M.groups().length, 0);
  M.redo(); assert.strictEqual(JSON.stringify(M.serialize()), snap1);
  M.redo(); assert.strictEqual(M.groups().length, 0);
  assert.strictEqual(M.ungroup(['s0']), 0, 'a loose shape has nothing to ungroup');
});

test('rename a group (one undo step, cleaned like shape names)', () => {
  fresh(3);
  const g = M.groupShapes(['s0', 's1']);
  assert.ok(M.renameGroup(g.id, '  Logo\u0000 <b>  '));
  assert.strictEqual(M.group(g.id).name, 'Logo <b>');
  assert.strictEqual(M.undoLabel(), 'Rename');
  M.undo(); assert.strictEqual(M.group(g.id).name, 'Group 1');
});

test('selectedGroup / insideGroup / unitOf', () => {
  fresh(4);
  const g = M.groupShapes(['s1', 's2']);
  assert.deepStrictEqual(plain(M.unitOf('s2')), ['s1', 's2']);
  assert.deepStrictEqual(plain(M.unitOf('s3')), ['s3']);
  M.select(['s1', 's2']); assert.strictEqual(M.selectedGroup().id, g.id); assert.strictEqual(M.insideGroup(), null);
  M.select(['s2']); assert.strictEqual(M.selectedGroup(), null); assert.strictEqual(M.insideGroup().id, g.id);
  M.select(['s2', 's3']); assert.strictEqual(M.insideGroup(), null);
});

test('reorder: a whole group steps as one block, a shape inside steps within its group only', () => {
  fresh(5);
  const g = M.groupShapes(['s1', 's2']);
  M.reorder(M.members(g.id), 1);
  assert.strictEqual(order(), 's0,s3,s1,s2,s4');
  M.reorder(M.members(g.id), -1); M.reorder(M.members(g.id), -1);
  assert.strictEqual(order(), 's1,s2,s0,s3,s4');
  M.reorder(['s1'], 1);
  assert.strictEqual(order(), 's2,s1,s0,s3,s4');
  assert.ok(!M.reorder(['s1'], 1), 'the last shape of a group does not leave it by [ / ]');
  assert.strictEqual(groupsOf(), 'Group 1,Group 1,-,-,-');
  /* a loose shape steps over a whole group */
  M.reorder(['s0'], -1);
  assert.strictEqual(order(), 's0,s2,s1,s3,s4');
  /* without groups the old behaviour: several picked shapes each step one place */
  fresh(5);
  M.reorder(['s0', 's2'], 1);
  assert.strictEqual(order(), 's1,s0,s3,s2,s4');
});

test('place: into a group, out of a group, a group as a block', () => {
  fresh(6);
  const g = M.groupShapes(['s2', 's3']);
  assert.ok(M.place(['s5'], 's3', g.id, 'Move into group'));
  assert.strictEqual(order(), 's0,s1,s2,s5,s3,s4');
  assert.deepStrictEqual(plain(M.members(g.id)), ['s2', 's5', 's3']);
  assert.ok(M.place(['s2'], 's0', null, 'Move out of group'));
  assert.strictEqual(order(), 's2,s0,s1,s5,s3,s4');
  assert.strictEqual(groupsOf(), '-,-,-,Group 1,Group 1,-');
  /* a loose shape asked to go between two members lands after the group */
  assert.ok(M.place(['s0'], 's3', null));
  assert.strictEqual(order(), 's2,s1,s5,s3,s0,s4');
  /* the group block moves to the front, keeping its group */
  assert.ok(M.place(M.members(g.id), 's2', undefined));
  assert.strictEqual(order(), 's5,s3,s2,s1,s0,s4');
  assert.strictEqual(groupsOf(), 'Group 1,Group 1,-,-,-,-');
  /* the last member moved out: the group is gone */
  M.place(['s5'], null, null); M.place(['s3'], null, null);
  assert.strictEqual(M.groups().length, 0);
});

test('delete removes empty groups; clear removes all', () => {
  fresh(4);
  const g = M.groupShapes(['s0', 's1']);
  M.remove(['s0']); assert.ok(M.group(g.id));
  M.remove(['s1']); assert.strictEqual(M.group(g.id), null);
  M.groupShapes(['s2', 's3']); M.clear();
  assert.strictEqual(M.groups().length, 0);
});

test('duplicate and paste: a whole group becomes a new group, part of a group becomes loose copies', () => {
  fresh(4);
  const g = M.groupShapes(['s0', 's1']);
  M.select(M.members(g.id)); M.duplicate();
  assert.strictEqual(M.groups().length, 2);
  const copy = M.groups()[1];
  assert.strictEqual(copy.name, 'Group 1 copy');
  assert.deepStrictEqual(plain(M.selection), plain(M.members(copy.id)));
  M.select(['s0']); M.copy(); M.paste();
  const pasted = M.get(M.selection[0]);
  assert.ok(!pasted.group, 'a copy of one member is loose');
  M.select(M.members(g.id)); M.copy(); M.remove(M.members(g.id)); M.paste();
  const again = M.groupOf(M.selection[0]);
  assert.ok(again && again.name === 'Group 1 copy' && M.members(again.id).length === 2, 'pasting a deleted group makes a group again');
  M.doc.objects.forEach(o => assert.ok(!o.group || M.group(o.group)));
});

test('pieces of a grouped shape stay in its group', () => {
  fresh(3);
  const g = M.groupShapes(['s0', 's1']);
  const piece = M.piece(M.get('s1'), { type: 'polygon', pts: [[0, 0], [5, 0], [5, 5]] }, 'cut');
  assert.strictEqual(piece.group, g.id);
  const stroke = M.strokePiece(M.get('s0'), [[0, 0], [5, 5]]);
  assert.strictEqual(stroke.group, g.id);
  assert.ok(!M.piece(M.get('s2'), { type: 'polygon', pts: [[0, 0], [5, 0], [5, 5]] }).group);
});

test('save / load keeps groups; a file without groups has none; serialize adds the key only with groups', () => {
  fresh(4);
  assert.ok(!('groups' in M.serialize()), 'no groups key in a design without groups');
  const g = M.groupShapes(['s2', 's3']); M.renameGroup(g.id, 'Badge');
  const saved = plain(M.serialize());
  assert.deepStrictEqual(plain(saved.groups), [{ id: g.id, name: 'Badge' }]);
  M.load(null);
  M.load(saved);
  assert.strictEqual(M.group(g.id).name, 'Badge');
  assert.deepStrictEqual(plain(M.members(g.id)), ['s2', 's3']);
  assert.strictEqual(M.historySize(), 0);
  const v1 = plain(saved); delete v1.groups;
  M.load(v1);
  assert.strictEqual(M.groups().length, 0);
  assert.ok(M.doc.objects.every(o => !o.group), 'a group id with no group entry is dropped');
});

test('hostile group data loads into valid groups', () => {
  const objs = [rect('a', 5), rect('b', 20), rect('c', 35), rect('d', 50), rect('e', 65)];
  objs[0].group = 'g1'; objs[2].group = 'g1'; objs[1].group = 'nope'; objs[3].group = { x: 1 }; objs[4].group = 'g2';
  M.load({ hoop: { w: 130, h: 180 }, objects: objs, groups: [{ id: 'g1', name: 'One' }, { id: 'g1', name: 'Dup' }, { id: 'bad id!', name: 'x' }, null, 7, { id: 'g2', name: '\u0007' }, { id: 'g3', name: 'Empty' }] });
  assert.strictEqual(M.doc.objects.length, 5);
  assert.deepStrictEqual(plain(M.groups().map(g => g.id)), ["g1", "g2"]);
  assert.strictEqual(M.group('g2').name, 'Group');
  assert.strictEqual(order(), 'a,c,b,d,e', 'scattered members are gathered at the first one');
  assert.deepStrictEqual(plain(M.members('g1')), ['a', 'c']);
  assert.ok(!M.get('b').group && !M.get('d').group);
  M.load({ objects: [rect('a', 5)], groups: 'nonsense' });
  assert.strictEqual(M.groups().length, 0);
});

test('group ids that are names of Object.prototype keys never lose shapes', () => {
  const objs = [rect('a', 5), rect('b', 20), rect('c', 35), rect('d', 50)];
  objs[0].group = 'constructor'; objs[1].group = 'g1'; objs[2].group = 'toString'; objs[3].group = '__proto__';
  M.load({ hoop: { w: 130, h: 180 }, objects: objs, groups: [{ id: '__proto__', name: 'p' }, { id: 'constructor', name: 'c' }, { id: 'g1', name: 'One' }] });
  assert.strictEqual(M.doc.objects.length, 4, 'no shape dropped: ' + order());
  assert.deepStrictEqual(plain(M.groups().map(g => g.id)), ['g1']);
  assert.ok(['a', 'c', 'd'].every(id => !M.get(id).group), 'shapes of a made-up group are loose');
  assert.ok(M.groupShapes(['a']), 'a loose shape can be grouped');
});

test('a group of 1500 shapes stays quick to select', () => {
  const objs = []; for (let i = 0; i < 1500; i++) objs.push(rect('r' + i, i % 100));
  M.load({ hoop: { w: 130, h: 180 }, objects: objs });
  const t0 = Date.now();
  const g = M.groupShapes(objs.map(o => o.id));
  M.select([]); M.select(M.members(g.id));
  assert.ok(M.selectedGroup() === g);
  assert.ok(Date.now() - t0 < 2000, 'took ' + (Date.now() - t0) + ' ms');
});

test('every design in designs/*.embroidr gives the same engine input with all shapes grouped', () => {
  const dir = process.env.EMB_DESIGNS_DIR || path.join(REPO, 'designs');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.embroidr')) : [];
  assert.ok(files.length > 0, 'no designs found in ' + dir);
  files.forEach(f => {
    const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    M.load(data.doc || data);
    const before = engineJson(), ids = M.doc.objects.map(o => o.id);
    const half = Math.ceil(ids.length / 2);
    M.groupShapes(ids.slice(0, half));
    if (ids.length > half) M.groupShapes(ids.slice(half));
    assert.strictEqual(engineJson(), before, f + ': engine input changed by grouping');
    const saved = plain(M.serialize());
    M.load(saved);
    assert.strictEqual(engineJson(), before, f + ': engine input changed by save / load with groups');
    assert.strictEqual(M.groups().length, ids.length > half ? 2 : 1);
  });
  console.log('       (' + files.length + ' designs)');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
