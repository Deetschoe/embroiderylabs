/* EMBROIDERY LABS - js/feed.js (index.html only)
   The design feed: reads designs/index.json and shows a card per starter design. A card opens the
   design in the editor (app.html?design=<id>), where it lands in a tab of its own, ready to change. */
(function () {
  'use strict';
  var list = document.getElementById('feed-list'), box = document.getElementById('feed');
  if (!list || !box || !window.fetch) return;
  function inches(mm) { return (mm / 25.4).toFixed(1).replace(/\.0$/, ''); }
  function card(d) {
    var li = document.createElement('li'), a = document.createElement('a');
    a.className = 'design'; a.href = 'app.html?design=' + encodeURIComponent(d.id);
    var fig = document.createElement('span'); fig.className = 'design__pic';
    if (d.thumb) { var img = document.createElement('img'); img.src = d.thumb; img.alt = ''; img.loading = 'lazy'; img.decoding = 'async'; img.width = 640; img.height = 640; fig.appendChild(img); }
    var name = document.createElement('strong'); name.className = 'design__name'; name.textContent = d.title;
    var meta = document.createElement('span'); meta.className = 'design__meta';
    meta.textContent = Number(d.stitches).toLocaleString('en-US') + ' stitches · ' + inches(d.width) + ' x ' + inches(d.height) + ' in · ' + d.colors + ' colours';
    var go = document.createElement('span'); go.className = 'design__go'; go.textContent = 'Open and remix';
    a.setAttribute('aria-label', d.title + ': open in the editor. ' + meta.textContent);
    a.appendChild(fig); a.appendChild(name); a.appendChild(meta); a.appendChild(go); li.appendChild(a);
    return li;
  }
  fetch('designs/index.json', { cache: 'no-cache' }).then(function (r) { if (!r.ok) throw new Error('no feed'); return r.json(); }).then(function (data) {
    var designs = data && Array.isArray(data.designs) ? data.designs.filter(function (d) { return d && /^[a-z0-9-]+$/.test(d.id) && typeof d.title === 'string'; }) : [];
    if (!designs.length) return;
    var frag = document.createDocumentFragment(); designs.forEach(function (d) { frag.appendChild(card(d)); });
    list.textContent = ''; list.appendChild(frag); box.hidden = false;
  }).catch(function () { /* the page works without the feed */ });
})();
