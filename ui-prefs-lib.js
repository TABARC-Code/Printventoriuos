/*
 * ui-prefs-lib.js
 *
 * The logic behind Display and accessibility: what the options are, how a saved
 * choice is cleaned up, and which classes and CSS variables it turns into. No
 * dialog code here, so it can be unit tested and loaded in <head> to apply your
 * choices before the first paint (otherwise the page flashes in the default look
 * and then jumps, which is miserable if you picked big text because you need it).
 *
 * Choices are kept in this browser's localStorage, not in the library database.
 * That's deliberate. In Server Mode several people share one library, and one
 * person's need for large text or a colour-blind palette must not be imposed on
 * the next. Per device, not per library.
 *
 * About the options, honestly:
 *  - The research on fonts and dyslexia is mixed. Atkinson Hyperlegible was
 *    designed so similar characters (I l 1, b d p q) look different, and Lexend
 *    for reading fluency; plenty of people find them easier, but nobody should
 *    claim a font fixes dyslexia. So there's a choice, and a way back.
 *  - The colour-blind palette is Okabe and Ito's (2008), which was designed to
 *    stay distinguishable for the common forms of colour blindness. The tests
 *    simulate three of them and measure it; they don't replace asking people.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.UiPrefsLib = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const STORAGE_KEY = 'printventory.displayPrefs';

  const FONTS = Object.freeze({
    default: { label: 'Standard', note: 'Inter', stack: "'Inter', 'SF Pro Display', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif" },
    easyread: { label: 'Easy-read', note: 'Atkinson Hyperlegible', stack: "'Atkinson Hyperlegible', 'Inter', Verdana, Arial, sans-serif" },
    lexend: { label: 'Lexend', note: 'Spaced for reading fluency', stack: "'Lexend', 'Inter', Verdana, Arial, sans-serif" },
    system: { label: 'System font', note: 'Whatever your device uses', stack: "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif" }
  });

  const TEXT_SCALES = Object.freeze([100, 115, 130, 150]);
  const ZOOMS = Object.freeze([100, 110, 125, 150]);

  const DEFAULTS = Object.freeze({
    v: 1,
    font: 'default',
    textScale: 100,        // percent; scales text, not boxes
    zoom: 100,             // percent; whole-window zoom, desktop app only
    spacing: 'normal',     // normal | roomy
    contrast: 'normal',    // normal | high
    palette: 'standard',   // standard | cvd
    targets: 'normal',     // normal | large
    focus: 'normal',       // normal | strong
    links: 'normal',       // normal | underline
    motion: 'system'       // system | reduce
  });

  const CHOICES = Object.freeze({
    font: Object.keys(FONTS),
    spacing: ['normal', 'roomy'],
    contrast: ['normal', 'high'],
    palette: ['standard', 'cvd'],
    targets: ['normal', 'large'],
    focus: ['normal', 'strong'],
    links: ['normal', 'underline'],
    motion: ['system', 'reduce']
  });

  /**
   * Okabe-Ito colours for the print states, plus the text colour that reads on each.
   * Mirrored in ui-prefs.css; the tests check the two agree and that the pairs
   * stay apart under simulated colour blindness.
   */
  const STATUS_PALETTE = Object.freeze({
    printed:  { fill: '#009E73', text: '#000000', label: 'Printed' },
    failed:   { fill: '#D55E00', text: '#000000', label: 'Failed' },
    queued:   { fill: '#F0E442', text: '#000000', label: 'Queued' },
    printing: { fill: '#0072B2', text: '#FFFFFF', label: 'Printing' },
    want:     { fill: '#CC79A7', text: '#000000', label: 'Want' },
    mixed:    { fill: '#E69F00', text: '#000000', label: 'Mixed' },
    neutral:  { fill: '#6B7280', text: '#FFFFFF', label: 'Not printed' }
  });

  const nearest = (value, list, fallback) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return list.reduce((best, c) => (Math.abs(c - n) < Math.abs(best - n) ? c : best), list[0]);
  };

  /** Anything stored or imported is checked against the allowed values. Unknown means default. */
  function normalise(raw) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const out = { v: 1 };
    for (const key of Object.keys(CHOICES)) out[key] = CHOICES[key].includes(r[key]) ? r[key] : DEFAULTS[key];
    out.textScale = nearest(r.textScale, TEXT_SCALES, DEFAULTS.textScale);
    out.zoom = nearest(r.zoom, ZOOMS, DEFAULTS.zoom);
    return out;
  }

  function classList(prefs) {
    const p = normalise(prefs);
    const c = [];
    if (p.font !== 'default') c.push(`pref-font-${p.font}`);
    if (p.textScale !== 100) c.push('pref-text-scaled');
    if (p.spacing === 'roomy') c.push('pref-spacing-roomy');
    if (p.contrast === 'high') c.push('pref-contrast-high');
    if (p.palette === 'cvd') c.push('pref-palette-cvd');
    if (p.targets === 'large') c.push('pref-targets-large');
    if (p.focus === 'strong') c.push('pref-focus-strong');
    if (p.links === 'underline') c.push('pref-links-underline');
    if (p.motion === 'reduce') c.push('pref-motion-reduce');
    return c;
  }

  function cssVars(prefs) {
    const p = normalise(prefs);
    return { '--ui-text-scale': String(p.textScale / 100), '--ui-font': FONTS[p.font].stack };
  }

  const isDefault = (prefs) => {
    const p = normalise(prefs);
    return Object.keys(DEFAULTS).every((k) => p[k] === DEFAULTS[k]);
  };

  /** Puts the choices on an element (normally <html>). Removes any earlier pref-* classes first. */
  function apply(prefs, el) {
    if (!el) return;
    Array.from(el.classList).filter((c) => c.startsWith('pref-')).forEach((c) => el.classList.remove(c));
    classList(prefs).forEach((c) => el.classList.add(c));
    const vars = cssVars(prefs);
    for (const [k, v] of Object.entries(vars)) el.style.setProperty(k, v);
  }

  function load(storage) {
    try {
      const s = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
      const raw = s && s.getItem(STORAGE_KEY);
      return normalise(raw ? JSON.parse(raw) : null);
    } catch (_) { return normalise(null); }   // blocked storage or corrupt JSON: defaults, never an error
  }

  function save(prefs, storage) {
    try {
      const s = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
      if (!s) return false;
      s.setItem(STORAGE_KEY, JSON.stringify(normalise(prefs)));
      return true;
    } catch (_) { return false; }
  }

  return { STORAGE_KEY, FONTS, TEXT_SCALES, ZOOMS, DEFAULTS, CHOICES, STATUS_PALETTE, normalise, classList, cssVars, isDefault, apply, load, save };
});
