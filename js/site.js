/* ==========================================================================
   EMBROIDERY LABS - js/site.js
   Shared behaviour for every page. No dependencies, no build step.
   Load with:  <script src="js/site.js" defer></script>
   Exposes one global: window.EL
   ========================================================================== */
(function () {
  'use strict';

  var root = document.documentElement;

  /* ---------- storage that never throws (private mode, quota, blocked) ---- */
  var store = {
    get: function (key, fallback) {
      try {
        var raw = localStorage.getItem(key);
        return raw == null ? fallback : JSON.parse(raw);
      } catch (e) { return fallback; }
    },
    set: function (key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch (e) { return false; }
    },
    remove: function (key) { try { localStorage.removeItem(key); } catch (e) {} }
  };

  /* ---------- light mode only ------------------------------------------- */
  /* The site has one look, light. The OS dark setting is ignored and there is
     no switch. A theme stored by an older version is forgotten. EL.theme stays
     as a stub so older callers keep working: it always answers "light". */
  ['el-theme', 'theme-mode'].forEach(function (k) { try { localStorage.removeItem(k); } catch (e) {} });
  root.removeAttribute('data-theme');
  var theme = { get: function () { return 'light'; }, set: function () {}, toggle: function () {} };

  /* Read a design token (for canvas drawing). */
  function token(name, el) {
    return getComputedStyle(el || root).getPropertyValue(name).trim();
  }

  /* ---------- helpers ------------------------------------------------------ */
  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function money(n, opts) {
    var cents = !opts || opts.cents !== false;
    var v = Number(n); if (!isFinite(v)) v = 0;
    var s = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0 });
    return (v < 0 ? '-$' : '$') + s;
  }
  function num(n, digits) {
    var v = Number(n); if (!isFinite(v)) v = 0;
    return v.toLocaleString('en-US', { minimumFractionDigits: digits || 0, maximumFractionDigits: digits || 0 });
  }
  /* Save a file from memory. data: string | ArrayBuffer | typed array | Blob. */
  function download(filename, data, mime) {
    var blob = data instanceof Blob ? data : new Blob([data], { type: mime || 'application/octet-stream' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename; a.style.display = 'none';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }

  /* ---------- toast -------------------------------------------------------- */
  /* EL.toast('Saved design.pes', { kind: 'ok', label: 'Export', timeout: 4000,
                                    action: { label: 'Undo', onClick: fn } })
     kind: undefined | 'ok' | 'bad'.  timeout 0 = stays until dismissed.
     Text is always set with textContent - never pass HTML. */
  function toastHost() {
    var host = document.querySelector('.toasts');
    if (!host) {
      host = document.createElement('div');
      host.className = 'toasts';
      document.body.appendChild(host);
    }
    if (!host.hasAttribute('role')) { host.setAttribute('role', 'status'); host.setAttribute('aria-live', 'polite'); }
    return host;
  }
  function toast(message, opts) {
    opts = opts || {};
    var host = toastHost();
    var el = document.createElement('div');
    el.className = 'toast';
    if (opts.kind) el.setAttribute('data-kind', opts.kind);
    var label = document.createElement('span');
    label.className = 'label';
    label.textContent = opts.label || (opts.kind === 'bad' ? 'Error' : opts.kind === 'ok' ? 'Done' : 'Note');
    var text = document.createElement('span');
    text.textContent = String(message);
    el.appendChild(label); el.appendChild(text);
    var timer = null;
    function dismiss() {
      if (!el.parentNode) return;
      clearTimeout(timer);
      el.classList.add('is-leaving');
      setTimeout(function () { el.remove(); }, 160);
    }
    if (opts.action && opts.action.label) {
      var btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'toast__action'; btn.textContent = opts.action.label;
      btn.addEventListener('click', function () { if (opts.action.onClick) opts.action.onClick(); dismiss(); });
      el.appendChild(btn);
    }
    host.appendChild(el);
    while (host.children.length > 3) host.firstElementChild.remove();
    var ms = opts.timeout == null ? (opts.kind === 'bad' ? 7000 : 4000) : opts.timeout;
    if (ms > 0) timer = setTimeout(dismiss, ms);
    return { el: el, dismiss: dismiss };
  }

  /* ---------- dialogs ------------------------------------------------------ */
  /* Markup: <dialog class="dialog" id="x" aria-labelledby="x-title">...</dialog>
     Open:   <button data-dialog-open="x">   Close: <button data-dialog-close>
     Clicking the backdrop and pressing Esc also close it. */
  var dialog = {
    open: function (target) {
      var d = typeof target === 'string' ? document.getElementById(target) : target;
      if (d && !d.open) { if (d.showModal) d.showModal(); else d.setAttribute('open', ''); }
      return d;
    },
    close: function (target, value) {
      var d = typeof target === 'string' ? document.getElementById(target) : target;
      if (d && d.open) { if (d.close) d.close(value); else d.removeAttribute('open'); }
    }
  };
  /* Replacement for window.confirm(). Resolves true or false.
     EL.confirm('Clear every shape on the hoop?', { title: 'Clear design',
                 confirmLabel: 'Clear', cancelLabel: 'Keep', danger: true }) */
  function confirmDialog(message, opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var d = document.createElement('dialog');
      d.className = 'dialog';
      var head = document.createElement('div'); head.className = 'dialog__head';
      var title = document.createElement('span'); title.className = 'label'; title.id = 'el-confirm-title';
      title.textContent = opts.title || 'Confirm';
      head.appendChild(title);
      var body = document.createElement('div'); body.className = 'dialog__body';
      var p = document.createElement('p'); p.textContent = String(message); body.appendChild(p);
      var foot = document.createElement('div'); foot.className = 'dialog__foot';
      var no = document.createElement('button'); no.type = 'button'; no.className = 'btn'; no.textContent = opts.cancelLabel || 'Cancel';
      var yes = document.createElement('button'); yes.type = 'button';
      yes.className = opts.danger ? 'btn btn--danger' : 'btn btn--primary';
      yes.textContent = opts.confirmLabel || 'OK';
      foot.appendChild(no); foot.appendChild(yes);
      d.appendChild(head); d.appendChild(body); d.appendChild(foot);
      d.setAttribute('aria-labelledby', 'el-confirm-title');
      var result = false;
      no.addEventListener('click', function () { dialog.close(d); });
      yes.addEventListener('click', function () { result = true; dialog.close(d); });
      d.addEventListener('close', function () { d.remove(); resolve(result); });
      document.body.appendChild(d);
      dialog.open(d);
      (opts.danger ? no : yes).focus();
    });
  }

  /* ---------- sliders ------------------------------------------------------ */
  /* Keeps the filled part of .slider in step with its value (CSS reads --val).
     Call EL.syncSlider(input) after changing a slider's value from script. */
  function syncSlider(input) {
    var min = parseFloat(input.min); if (isNaN(min)) min = 0;
    var max = parseFloat(input.max); if (isNaN(max)) max = 100;
    var val = parseFloat(input.value); if (isNaN(val)) val = min;
    var pct = max > min ? (val - min) / (max - min) * 100 : 0;
    input.style.setProperty('--val', Math.max(0, Math.min(100, pct)) + '%');
  }

  /* ---------- tabs --------------------------------------------------------- */
  /* Markup: <div class="tabs" role="tablist" data-tabs>
               <button role="tab" aria-selected="true" aria-controls="p1" id="t1">One</button> ...
             <div role="tabpanel" id="p1" aria-labelledby="t1"> ... <div role="tabpanel" id="p2" hidden>
     Fires "el:tabchange" (bubbles) on the tablist with detail { id: panelId }. */
  function selectTab(tab) {
    var list = tab.closest('[role="tablist"]'); if (!list) return;
    var tabs = list.querySelectorAll('[role="tab"]');
    for (var i = 0; i < tabs.length; i++) {
      var on = tabs[i] === tab;
      tabs[i].setAttribute('aria-selected', on ? 'true' : 'false');
      tabs[i].tabIndex = on ? 0 : -1;
      var panel = document.getElementById(tabs[i].getAttribute('aria-controls'));
      if (panel) panel.hidden = !on;
    }
    list.dispatchEvent(new CustomEvent('el:tabchange', { bubbles: true, detail: { id: tab.getAttribute('aria-controls') } }));
  }

  /* ---------- nav ---------------------------------------------------------- */
  function pageSlug(path) {
    var s = String(path).split('#')[0].split('?')[0].replace(/\/+$/, '');
    s = s.slice(s.lastIndexOf('/') + 1).replace(/\.html?$/i, '').toLowerCase();
    return s === '' || s === 'home' ? 'index' : s;
  }
  function markCurrentNav() {
    var here = pageSlug(location.pathname);
    var links = document.querySelectorAll('.nav a[href], .site-foot nav a[href]');
    for (var i = 0; i < links.length; i++) {
      var href = links[i].getAttribute('href');
      if (/^(https?:|mailto:|#)/i.test(href)) continue;
      if (pageSlug(href) === here) links[i].setAttribute('aria-current', 'page');
      else links[i].removeAttribute('aria-current');
    }
  }

  /* ---------- wiring (delegated: works for markup added later) ------------- */
  document.addEventListener('click', function (e) {
    var t = e.target instanceof Element ? e.target : null; if (!t) return;
    var el;
    if ((el = t.closest('[data-dialog-open]'))) { dialog.open(el.getAttribute('data-dialog-open')); return; }
    if ((el = t.closest('[data-dialog-close]'))) { dialog.close(el.closest('dialog')); return; }
    if (t.matches('dialog.dialog')) {                           /* click on the backdrop */
      var r = t.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dialog.close(t);
      return;
    }
    if ((el = t.closest('[data-tabs] [role="tab"]'))) selectTab(el);
  });
  document.addEventListener('keydown', function (e) {
    var t = e.target instanceof Element ? e.target.closest('[data-tabs] [role="tab"]') : null;
    if (!t || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home' && e.key !== 'End')) return;
    var tabs = Array.prototype.slice.call(t.closest('[role="tablist"]').querySelectorAll('[role="tab"]'));
    var i = tabs.indexOf(t);
    var next = e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    e.preventDefault(); tabs[next].focus(); selectTab(tabs[next]);
  });
  document.addEventListener('input', function (e) {
    if (e.target instanceof HTMLInputElement && e.target.classList.contains('slider')) syncSlider(e.target);
  });

  function init() {
    markCurrentNav();
    var sliders = document.querySelectorAll('input.slider');
    for (var i = 0; i < sliders.length; i++) syncSlider(sliders[i]);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();

  window.EL = {
    theme: theme, token: token, toast: toast, dialog: dialog, confirm: confirmDialog,
    store: store, escapeHtml: escapeHtml, money: money, num: num, download: download,
    syncSlider: syncSlider, selectTab: selectTab
  };
})();
