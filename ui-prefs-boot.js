/* Applies saved display choices before the page paints. See ui-prefs-lib.js. Loaded in <head>. */
(function () {
  try {
    if (window.UiPrefsLib) window.UiPrefsLib.apply(window.UiPrefsLib.load(), document.documentElement);
  } catch (_) { /* a broken preference must never stop the app loading */ }
})();
