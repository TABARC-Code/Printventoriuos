/**
 * Simple mode: the switch.
 *
 * The what-is-hidden part is CSS (simple-mode.css) and a short list of menu
 * names (ui-prefs-lib.js). This file only flips the preference, tells a screen
 * reader what happened, and looks after focus. It is stored with the other
 * Display and accessibility choices, so it is per device, not per library, and
 * the Display dialog (ui-prefs.js) and the menus all end up in the same place.
 *
 * Nothing here removes or rewires anything. Switching it off puts the full
 * interface back exactly as it was.
 */
(function () {
  'use strict';

  const Lib = window.UiPrefsLib;
  if (!Lib) { console.error('[SimpleMode] ui-prefs-lib.js did not load'); return; }

  const EVENT = 'printventory:simple-mode';
  const $ = (id) => document.getElementById(id);
  const isOn = () => document.documentElement.classList.contains('pref-simple');

  function announce(on) {
    const live = $('simple-mode-status');
    if (!live) return;
    live.textContent = '';   // clear first, or a repeat of the same message is not read out
    setTimeout(() => {
      live.textContent = on
        ? 'Simple mode is on. Showing the basics only.'
        : 'Simple mode is off. Showing everything.';
    }, 50);
  }

  // If whatever had focus has just been hidden, the browser drops focus on the page itself,
  // which for a keyboard user means starting again from the top. Put it somewhere useful.
  function rescueFocus() {
    const active = document.activeElement;
    const lost = !active || active === document.body || active.closest('[hidden]') || active.getClientRects().length === 0;
    if (lost) $('search-filter-input')?.focus({ preventScroll: true });
  }

  function set(on, options) {
    const opts = options || {};
    const prefs = Lib.normalise({ ...Lib.load(), simple: on ? 'on' : 'off' });
    Lib.apply(prefs, document.documentElement);
    Lib.save(prefs);
    window.dispatchEvent(new CustomEvent(EVENT, { detail: { on: !!on } }));
    if (opts.focus !== false) rescueFocus();
    return !!on;
  }

  function toggle() { return set(!isOn()); }

  function init() {
    window.setSimpleMode = set;
    window.toggleSimpleMode = toggle;
    window.isSimpleMode = isOn;
    window.addEventListener(EVENT, (e) => announce(!!(e.detail && e.detail.on)));
    $('simple-mode-off')?.addEventListener('click', () => set(false));

    // Native Tools menu (desktop app). The web menu calls toggleSimpleMode() directly.
    window._electronRealEventHandlers = window._electronRealEventHandlers || {};
    window._electronRealEventHandlers['toggle-simple-mode'] = function () { toggle(); };
    const pending = window._electronPendingEvents?.['toggle-simple-mode'];
    if (pending) {
      pending.forEach((args) => window._electronRealEventHandlers['toggle-simple-mode'].apply(null, args));
      delete window._electronPendingEvents['toggle-simple-mode'];
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
