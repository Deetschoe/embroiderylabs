/* ==========================================================================
   EMBROIDERY LABS - js/config.js
   Site settings for accounts and paid exports (server/README.md).

   apiBase: null   accounts are OFF. Nothing changes: exports are made in the
                   browser and are free, exactly as before.
   apiBase: 'https://api.embroiderylabs.com'
                   accounts are ON: Google sign-in, plans, saved designs, and
                   machine files made by the server (which counts them).
   googleClientId  optional: the server sends its own when this is null.
   ========================================================================== */
window.EL_CONFIG = Object.assign({
  apiBase: null,
  googleClientId: null
}, window.EL_CONFIG || {});
