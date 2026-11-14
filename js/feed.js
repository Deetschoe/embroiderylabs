/* EMBROIDERY LABS - js/feed.js (index.html only)
   The collection: reads designs/index.json and shows a card per starter design, with category chips
   (All, People, Anime, Flowers, Bugs) to filter them. A card opens the design in the editor
   (app.html?design=<id>), where it lands in a tab of its own, ready to change.

   Categories come from a design's "category" field when index.json has one, otherwise from its tags
   (anime -> Anime, portrait -> People, flower -> Flowers, insect -> Bugs). A design that fits none still shows under All. */
(function () {
  'use strict';
  var list = document.getElementById('feed-list'), chips = document.getElementById('coll-chips'), empty = document.getElementById('feed-empty');
  if (!list || !window.fetch) return;
  var CATS = [{ id: 'people', label: 'People' }, { id: 'anime', label: 'Anime' }, { id: 'flowers', label: 'Flowers' }, { id: 'bugs', label: 'Bugs' }];
  var FROM_TAG = { anime: 'anime', portrait: 'people', person: 'people', people: 'people', flower: 'flowers', flowers: 'flowers', plant: 'flowers', insect: 'bugs', bug: 'bugs', bugs: 'bugs' };
  var KEY = 'el-home-cat';

  function categoryOf(d) {
    if (typeof d.category === 'string') { var c = d.category.toLowerCase(); if (CATS.some(function (k) { return k.id === c; })) return c; }
    var tags = Array.isArray(d.tags) ? d.tags.map(function (t) { return String(t).toLowerCase(); }) : [];
    if (tags.indexOf('anime') >= 0) return 'anime';                      /* anime portraits go under Anime, not People */
    for (var i = 0; i < tags.length; i++) if (FROM_TAG[tags[i]]) return FROM_TAG[tags[i]];
    return null;
  }
  function inches(mm) { return (Number(mm) / 25.4).toFixed(1).replace(/\.0$/, ''); }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

  function card(d) {
    var li = document.createElement('li'), a = el('a', 'card');
    li.setAttribute('data-cat', d.cat || '');
    a.href = 'app.html?design=' + encodeURIComponent(d.id);
    var pic = el('span', 'card__pic');
    if (typeof d.thumb === 'string' && /^designs\/[\w/.-]+\.(webp|png|jpe?g)$/.test(d.thumb)) {
      var img = document.createElement('img'); img.src = d.thumb; img.alt = d.title + ', stitched'; img.loading = 'lazy'; img.decoding = 'async'; img.width = 640; img.height = 640;
      pic.appendChild(img);
    }
    pic.appendChild(el('span', 'card__open', 'Open in Embroidr'));
    var size = d.width && d.height ? inches(d.width) + ' × ' + inches(d.height) + ' in' : '';
    var meta = [size, d.colors ? d.colors + ' colours' : ''].filter(Boolean).join(' · ');
    a.appendChild(pic); a.appendChild(el('strong', 'card__name', d.title)); if (meta) a.appendChild(el('span', 'card__meta', meta));
    a.setAttribute('aria-label', d.title + (meta ? ', ' + meta : '') + '. Open in Embroidr');
    li.appendChild(a);
    return li;
  }

  function filter(cat) {
    var items = list.children;
    for (var i = 0; i < items.length; i++) items[i].hidden = cat !== 'all' && items[i].getAttribute('data-cat') !== cat;
    var bs = chips.querySelectorAll('.chip');
    for (var j = 0; j < bs.length; j++) bs[j].setAttribute('aria-pressed', bs[j].getAttribute('data-cat') === cat ? 'true' : 'false');
    try { sessionStorage.setItem(KEY, cat); } catch (e) { /* private mode */ }
  }
  function buildChips(designs) {
    var counts = {}; designs.forEach(function (d) { if (d.cat) counts[d.cat] = (counts[d.cat] || 0) + 1; });
    var shown = CATS.filter(function (c) { return counts[c.id]; });
    if (!chips || shown.length < 2) return null;
    [{ id: 'all', label: 'All', n: designs.length }].concat(shown.map(function (c) { return { id: c.id, label: c.label, n: counts[c.id] }; })).forEach(function (c) {
      var b = el('button', 'chip'); b.type = 'button'; b.setAttribute('data-cat', c.id); b.setAttribute('aria-pressed', 'false');
      b.appendChild(document.createTextNode(c.label + ' ')); b.appendChild(el('span', 'chip__n', String(c.n)));
      b.addEventListener('click', function () { filter(c.id); });
      chips.appendChild(b);
    });
    chips.hidden = false;
    return shown.map(function (c) { return c.id; });
  }

  fetch('designs/index.json', { cache: 'no-cache' }).then(function (r) { if (!r.ok) throw new Error('no feed'); return r.json(); }).then(function (data) {
    var designs = data && Array.isArray(data.designs) ? data.designs.filter(function (d) { return d && /^[a-z0-9-]{1,60}$/.test(d.id) && typeof d.title === 'string'; }) : [];
    if (!designs.length) throw new Error('empty feed');
    designs.forEach(function (d) { d.cat = categoryOf(d); });
    var frag = document.createDocumentFragment(); designs.forEach(function (d) { frag.appendChild(card(d)); });
    list.textContent = ''; list.appendChild(frag);
    var cats = buildChips(designs);
    if (cats) { var saved = null; try { saved = sessionStorage.getItem(KEY); } catch (e) { /* private mode */ } filter(saved && cats.indexOf(saved) >= 0 ? saved : 'all'); }
  }).catch(function () { if (empty) empty.hidden = false; });
})();
