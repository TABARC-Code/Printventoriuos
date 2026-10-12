/**
 * Display and accessibility: the dialog.
 *
 * Every change applies straight away, so you can see what it does and undo it,
 * and it's remembered on this device (see ui-prefs-lib.js for why not per library).
 * Printer names and so on never appear here, but everything is built with
 * textContent regardless.
 *
 * Wishlist: a "what would suit me?" quick-start with three presets. Not today,
 * and not until someone who actually needs these options has told me what the
 * presets should be. Guessing for people is how bad accessibility features happen.
 */
(function () {
  'use strict';

  const Lib = window.UiPrefsLib;
  if (!Lib) { console.error('[UiPrefs] ui-prefs-lib.js did not load'); return; }

  let prefs = Lib.load();
  let built = false;

  const $ = (id) => document.getElementById(id);
  function el(tag, attrs, ...kids) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) {
      if (kid === undefined || kid === null || kid === false) continue;
      node.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return node;
  }

  const isDesktop = () => location.protocol === 'file:' && typeof window.electron?.setUiZoom === 'function';

  function change(patch) {
    prefs = Lib.normalise({ ...prefs, ...patch });
    Lib.apply(prefs, document.documentElement);
    Lib.save(prefs);
    if ('zoom' in patch && isDesktop()) window.electron.setUiZoom(prefs.zoom).catch(() => {});
    refreshHints();
  }

  function radioGroup(name, legend, hint, options, current) {
    const set = el('fieldset', {}, el('legend', { text: legend }), hint ? el('p', { class: 'dp-hint', id: `dp-hint-${name}`, text: hint }) : null);
    const wrap = el('div', { class: 'dp-options', role: 'radiogroup', 'aria-label': legend });
    options.forEach((o) => {
      const input = el('input', { type: 'radio', name: `dp-${name}`, value: String(o.value) });
      input.checked = String(current) === String(o.value);
      input.addEventListener('change', () => { if (input.checked) change({ [name]: typeof current === 'number' ? Number(o.value) : o.value }); });
      const label = el('label', { class: 'dp-option' }, input, el('span', {}, el('strong', { text: o.label, style: o.style || null }), o.note ? el('small', { text: o.note }) : null));
      wrap.append(label);
    });
    set.append(wrap);
    return set;
  }

  function toggle(name, onValue, offValue, title, note) {
    const input = el('input', { type: 'checkbox', id: `dp-${name}` });
    input.checked = prefs[name] === onValue;
    input.addEventListener('change', () => change({ [name]: input.checked ? onValue : offValue }));
    return el('label', { class: 'dp-switch', for: `dp-${name}` }, input, el('span', {}, el('strong', { text: title }), el('small', { text: note })));
  }

  function build() {
    const root = $('display-prefs-root');
    root.textContent = '';
    const fontOptions = Object.entries(Lib.FONTS).map(([value, f]) => ({ value, label: f.label, note: f.note, style: `font-family:${f.stack}` }));
    const sample = el('div', { class: 'dp-sample', 'aria-label': 'Sample of the current text and status colours' },
      el('div', { id: 'dp-sample-text', text: 'Models you have printed, queued and failed. Il1 O0 bdpq 3D print.' }),
      el('div', { class: 'dp-badges' },
        ...[['printed', 'Printed'], ['failed', 'Failed'], ['queued', 'Queued'], ['printing', 'Printing'], ['want', 'Want']].map(([cls, text]) => el('span', { class: `print-status print-status-${cls}${cls === 'printed' ? ' printed' : ''}`, text }))));

    root.append(
      el('div', { class: 'dp-body' },
        radioGroup('font', 'Font', 'Some people find these easier to read. The research on fonts and dyslexia is mixed, so try them and keep whichever feels better. Switching back is always one click.', fontOptions, prefs.font),
        radioGroup('textScale', 'Text size', 'Makes writing larger while keeping the layout. For everything at once, use your browser’s zoom (Ctrl and +), or the window size option below in the desktop app.', Lib.TEXT_SCALES.map((v) => ({ value: v, label: `${v}%`, note: v === 100 ? 'Standard' : v === 115 ? 'Larger' : v === 130 ? 'Large' : 'Largest' })), prefs.textScale),
        isDesktop() ? radioGroup('zoom', 'Window size (desktop app)', 'Scales the whole window, buttons and panels included.', Lib.ZOOMS.map((v) => ({ value: v, label: `${v}%` })), prefs.zoom) : null,
        radioGroup('spacing', 'Spacing', 'More space between letters, words and lines can help when text seems to crowd together.', [{ value: 'normal', label: 'Standard' }, { value: 'roomy', label: 'Roomy', note: 'Wider letters, words and lines' }], prefs.spacing),
        radioGroup('palette', 'Status colours', 'The colour-blind safe palette uses colours that stay distinct for the common kinds of colour blindness, and puts a shape before each status so colour is never the only clue.', [{ value: 'standard', label: 'Standard' }, { value: 'cvd', label: 'Colour-blind safe', note: 'Okabe and Ito palette plus shapes' }], prefs.palette),
        radioGroup('contrast', 'Contrast', 'High contrast brightens grey text and strengthens faint borders.', [{ value: 'normal', label: 'Standard' }, { value: 'high', label: 'High contrast' }], prefs.contrast),
        el('fieldset', {}, el('legend', { text: 'Controls and movement' }),
          toggle('targets', 'large', 'normal', 'Larger click targets', 'Buttons, menus and fields are at least 44 pixels, which is easier to hit with a mouse, a trackpad or a shaky hand.'),
          toggle('focus', 'strong', 'normal', 'Strong keyboard focus outline', 'A thick white ring with a black edge, so you can always see where the keyboard is.'),
          toggle('links', 'underline', 'normal', 'Underline links', 'Links are underlined rather than shown by colour alone.'),
          toggle('motion', 'reduce', 'system', 'Reduce animation', 'Stops fades and movement. If your device already asks for reduced motion, that is respected whatever this says.')),
        sample),
      el('div', { class: 'dp-footer' },
        el('button', { type: 'button', class: 'dp-reset', id: 'dp-reset', onclick: reset }, 'Reset to standard'),
        el('button', { type: 'button', id: 'dp-done', onclick: () => $('display-prefs-dialog').close() }, 'Done')));
    built = true;
  }

  function refreshHints() { /* the sample re-renders itself through the live classes */ }

  function reset() {
    prefs = Lib.normalise(null);
    Lib.apply(prefs, document.documentElement);
    Lib.save(prefs);
    if (isDesktop()) window.electron.setUiZoom(100).catch(() => {});
    build();
  }

  function open() {
    const dialog = $('display-prefs-dialog');
    if (!dialog) return;
    prefs = Lib.load();
    build();
    if (typeof dialog.showModal === 'function' && !dialog.open) dialog.showModal();
    // Start on the first control, not on the scrolling panel the browser would otherwise pick.
    dialog.querySelector('input[type="radio"]:checked')?.focus({ preventScroll: true });
  }

  function init() {
    window._electronRealEventHandlers = window._electronRealEventHandlers || {};
    window._electronRealEventHandlers['open-display-prefs'] = function () { open(); };
    if (window._electronPendingEvents?.['open-display-prefs']) {
      window._electronPendingEvents['open-display-prefs'].forEach((args) => window._electronRealEventHandlers['open-display-prefs'].apply(null, args));
      delete window._electronPendingEvents['open-display-prefs'];
    }
    window.openDisplayPrefs = open;
    $('display-prefs-button')?.addEventListener('click', open);
    // Desktop app: the window zoom isn't part of the page, so restore it on start.
    if (isDesktop() && prefs.zoom !== 100) window.electron.setUiZoom(prefs.zoom).catch(() => {});
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
