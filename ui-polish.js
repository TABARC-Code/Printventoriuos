/**
 * ui-polish.js: small usability and accessibility fixes that apply across the
 * whole interface, kept in one place so they're easy to find (and to remove).
 *
 *  1. Readable text on accent-coloured buttons. The accent is a bright colour
 *     (cyan by default, and the themes offer green, orange, pink...) and the
 *     button text was always white. White on the default cyan is 1.77:1; the
 *     usual minimum is 4.5:1. So we work out whether black or white reads better
 *     on the current accent and publish it as --primary-accent-text.
 *  2. Scrollable regions you can reach with the keyboard. If a panel scrolls and
 *     has nothing focusable inside, a keyboard user can't scroll it at all.
 *  3. An empty library, and a filter that matches nothing, now say so and offer
 *     the obvious next step, instead of leaving a blank grid.
 *
 * Nothing in here touches data. It only reads the screen and adds helpers.
 */
(function () {
  'use strict';

  // ---------- 1. accent contrast ----------
  function parseColour(value) {
    const v = String(value || '').trim();
    let m = v.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
    if (m) {
      let h = m[1];
      if (h.length === 3) h = h.split('').map((c) => c + c).join('');
      return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
    }
    m = v.match(/^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  }
  function luminance([r, g, b]) {
    const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  }
  function contrast(a, b) {
    const l1 = luminance(a); const l2 = luminance(b);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  }
  const DARK = [7, 18, 26];      // #07121a
  const LIGHT = [255, 255, 255];

  /** Pick the text colour that reads best on both the accent and its hover shade. */
  function pickAccentText(accent, hover) {
    const backgrounds = [accent, hover].filter(Boolean);
    if (!backgrounds.length) return null;
    const worst = (fg) => Math.min(...backgrounds.map((bg) => contrast(fg, bg)));
    return worst(DARK) >= worst(LIGHT) ? '#07121a' : '#ffffff';
  }

  function applyAccentText() {
    const root = document.documentElement;
    const cs = getComputedStyle(root);
    const accent = parseColour(cs.getPropertyValue('--primary-accent'));
    const hover = parseColour(cs.getPropertyValue('--primary-accent-hover'));
    const pick = pickAccentText(accent, hover);
    if (pick && root.style.getPropertyValue('--primary-accent-text') !== pick) {
      root.style.setProperty('--primary-accent-text', pick);   // only when it changes, or the observer below would loop
    }
  }

  // ---------- 2. keyboard access to scrollable regions ----------
  const INTERACTIVE = 'a[href],button,input,select,textarea,summary,[tabindex],[contenteditable="true"]';
  function makeScrollRegionsFocusable(scope) {
    if (!scope || !scope.querySelectorAll) return;
    const used = new Map();   // landmark names must be unique within a page, so number repeats
    scope.querySelectorAll('div,section,pre,ul,ol,article,aside,form,table,tbody').forEach((el) => {
      if (el.hasAttribute('tabindex') || el.matches(INTERACTIVE)) return;
      if (el.scrollHeight <= el.clientHeight + 1 && el.scrollWidth <= el.clientWidth + 1) return;
      const oy = getComputedStyle(el).overflowY;
      const ox = getComputedStyle(el).overflowX;
      const scrolls = /auto|scroll/.test(oy) && el.scrollHeight > el.clientHeight + 1
        || /auto|scroll/.test(ox) && el.scrollWidth > el.clientWidth + 1;
      if (!scrolls || el.querySelector(INTERACTIVE)) return;   // reachable by tabbing to a child already
      el.setAttribute('tabindex', '0');
      if (!el.hasAttribute('role')) el.setAttribute('role', 'region');
      if (!el.hasAttribute('aria-label') && !el.hasAttribute('aria-labelledby')) {
        const heading = el.closest('dialog')?.querySelector('h1,h2,h3,h4');
        const base = heading ? `${heading.textContent.trim()} (scrollable)` : 'Scrollable content';
        const n = (used.get(base) || 0) + 1;
        used.set(base, n);
        el.setAttribute('aria-label', n === 1 ? base : `${base} ${n}`);
      }
    });
  }

  // ---------- 3. empty states ----------
  let emptyEl = null;
  let emptyTimer = null;
  const countOf = (id) => {
    const m = (document.getElementById(id)?.textContent || '').replace(/,/g, '').match(/(\d+)/);
    return m ? Number(m[1]) : null;
  };

  function buildEmptyState() {
    const grid = document.querySelector('.file-grid');
    if (!grid || !grid.parentElement) return null;
    const box = document.createElement('div');
    box.id = 'library-empty-state';
    box.className = 'library-empty-state';
    box.hidden = true;
    box.setAttribute('role', 'status');
    const card = document.createElement('div');
    card.className = 'les-card';
    const title = document.createElement('h2');
    title.id = 'les-title';
    const text = document.createElement('p');
    text.id = 'les-text';
    const actions = document.createElement('div');
    actions.className = 'les-actions';
    const primary = document.createElement('button');
    primary.type = 'button';
    primary.id = 'les-primary';
    const secondary = document.createElement('button');
    secondary.type = 'button';
    secondary.id = 'les-secondary';
    secondary.className = 'les-secondary';
    actions.append(primary, secondary);
    card.append(title, text, actions);
    box.append(card);
    grid.insertAdjacentElement('afterend', box);
    return { box, title, text, primary, secondary };
  }

  function showEmpty(kind, total) {
    if (!emptyEl) emptyEl = buildEmptyState();
    if (!emptyEl) return;
    const { box, title, text, primary, secondary } = emptyEl;
    primary.onclick = null; secondary.onclick = null;
    if (kind === 'none') {
      title.textContent = 'Your library is empty';
      text.textContent = 'Choose the folder where you keep your STL and 3MF files. Printventory scans it, makes thumbnails, and lets you tag, search and keep track of what you have printed.';
      primary.textContent = 'Scan a folder';
      primary.onclick = () => document.getElementById('scan-directory-button')?.click();
      secondary.textContent = 'Read the quick guide';
      secondary.hidden = false;
      secondary.onclick = () => { try { window.electron?.send?.('open-guide'); } catch (_) { /* no guide available */ } };
    } else {
      title.textContent = 'Nothing matches these filters';
      text.textContent = `Your library has ${total.toLocaleString()} model${total === 1 ? '' : 's'}, but none match the current search or filters.`;
      primary.textContent = 'Clear all filters';
      primary.onclick = () => {
        const clear = document.getElementById('clear-all-filters-button');
        if (clear) clear.click(); else document.getElementById('view-library-button')?.click();
      };
      secondary.textContent = 'View entire library';
      secondary.hidden = false;
      secondary.onclick = () => document.getElementById('view-library-button')?.click();
    }
    box.hidden = false;
    alignEmptyState();
  }

  // The grid is pushed right to clear the fixed sidebar (and the folder rail, when
  // it's open), with responsive overrides on top. Copy its margin and width rather
  // than guess, so the message sits centred in the same space the tiles would use.
  function alignEmptyState() {
    const grid = document.querySelector('.file-grid');
    if (!emptyEl || !grid) return;
    const cs = getComputedStyle(grid);
    emptyEl.box.style.marginLeft = cs.marginLeft;
    emptyEl.box.style.width = cs.width;
    emptyEl.box.style.maxWidth = cs.maxWidth;
  }

  function refreshEmptyState() {
    const view = countOf('view-count');
    const total = countOf('total-count');
    const overlay = document.getElementById('loading-overlay');
    const loading = overlay && getComputedStyle(overlay).display !== 'none';
    const grid = document.querySelector('.file-grid');
    const hasTiles = grid && grid.children.length > 0;
    if (view === null || total === null || loading || hasTiles) { if (emptyEl) emptyEl.box.hidden = true; return; }
    if (total === 0) showEmpty('none', 0);
    else if (view === 0) showEmpty('filtered', total);
    else if (emptyEl) emptyEl.box.hidden = true;
  }

  // Counters change in bursts while the library loads, so wait for them to settle
  // before declaring anything empty. Otherwise the message flashes on every start-up.
  function scheduleEmptyCheck() {
    clearTimeout(emptyTimer);
    if (emptyEl) emptyEl.box.hidden = true;
    emptyTimer = setTimeout(refreshEmptyState, 900);
  }

  function init() {
    applyAccentText();
    const mo = new MutationObserver(applyAccentText);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class', 'data-theme'] });
    if (document.body) mo.observe(document.body, { attributes: true, attributeFilter: ['class', 'data-theme'] });

    // dialogs: when one opens, look for scroll regions inside it
    new MutationObserver((records) => {
      for (const r of records) {
        if (r.target.tagName === 'DIALOG' && r.target.open) setTimeout(() => makeScrollRegionsFocusable(r.target), 50);
      }
    }).observe(document.body, { attributes: true, attributeFilter: ['open'], subtree: true });

    for (const id of ['view-count', 'total-count']) {
      const el = document.getElementById(id);
      if (el) new MutationObserver(scheduleEmptyCheck).observe(el, { childList: true, characterData: true, subtree: true });
    }
    const grid = document.querySelector('.file-grid');
    if (grid) new MutationObserver(scheduleEmptyCheck).observe(grid, { childList: true });
    window.addEventListener('resize', alignEmptyState);
    scheduleEmptyCheck();
  }

  const api = { pickAccentText, contrast, parseColour };
  if (typeof module === 'object' && module.exports) module.exports = api;   // so the colour maths can be unit tested
  if (typeof document !== 'undefined') {
    window.UiPolish = api;
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
  }
})();
