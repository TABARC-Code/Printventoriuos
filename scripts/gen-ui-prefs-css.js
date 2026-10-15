#!/usr/bin/env node
/*
 * Generates ui-prefs-scale.css and ui-prefs-hc.css from the app's own stylesheets.
 *
 * Why generate instead of hand-write: the interface sets sizes in px in roughly
 * 350 places, and it hard-codes dozens of muted greys. To offer larger text and a
 * high-contrast mode without rewriting every stylesheet (and without making the
 * upstream merge a nightmare), we leave those files alone and emit override rules
 * that only apply when the matching option is switched on:
 *
 *   ui-prefs-scale.css   html.pref-text-scaled <selector> { font-size: calc(Npx * var(--ui-text-scale)) }
 *   ui-prefs-hc.css      html.pref-contrast-high <selector> { colour / border overrides }
 *
 * The output is committed. ui-prefs-css.test.js regenerates it in memory and fails
 * if it has drifted, so changing a stylesheet without re-running this is caught.
 *
 *     node scripts/gen-ui-prefs-css.js          write the files
 *     node scripts/gen-ui-prefs-css.js --check  exit 1 if they are out of date
 *
 * Limits, said plainly: sizes set inline in HTML or by JavaScript aren't covered,
 * and the parser handles ordinary CSS (rules, @media, @supports, @keyframes) rather
 * than every corner of the spec.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const INPUTS = [
  'theme.css', 'styles.css', 'mobile-ui.css', 'preview-wall.css', 'thumbnail-progress.css',
  'notes-markdown.css', 'organize-library.css', 'printer-management.css', 'parts-stock.css', 'farm-cost.css', 'simple-mode.css'
];
const SURFACE = [30, 30, 46];            // #1e1e2e, the usual dialog surface
const HC_TEXT = '#f3f4f6';
const HC_BORDER = 'rgba(255, 255, 255, 0.6)';

// ---------- a small CSS tokenizer: strips comments, respects strings and url() ----------
function stripComments(css) {
  let out = '';
  for (let i = 0; i < css.length; i++) {
    const c = css[i];
    if (c === '"' || c === "'") {
      const q = c; out += c; i++;
      while (i < css.length && css[i] !== q) { if (css[i] === '\\') { out += css[i++]; } out += css[i++]; }
      out += q;
    } else if (c === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      i = end === -1 ? css.length : end + 1;
    } else out += c;
  }
  return out;
}

/** Splits at top level on `{`...`}`; returns [{prelude, body}] in order. */
function blocks(css) {
  const result = [];
  let i = 0; let start = 0; let depth = 0; let prelude = '';
  const skipString = (q) => { i++; while (i < css.length && css[i] !== q) { if (css[i] === '\\') i++; i++; } };
  while (i < css.length) {
    const c = css[i];
    if (c === '"' || c === "'") { skipString(c); i++; continue; }
    if (c === '(' && /url$/i.test(css.slice(Math.max(0, i - 3), i))) {   // url(data:...{...}) must not confuse braces
      let j = i + 1;
      while (css[j] === ' ') j++;
      if (css[j] === '"' || css[j] === "'") {            // quoted: the closing quote ends it, even if the data holds ")"
        const q = css[j]; j++;
        while (j < css.length && css[j] !== q) { if (css[j] === '\\') j++; j++; }
      }
      const close = css.indexOf(')', j); i = close === -1 ? css.length : close + 1; continue;
    }
    if (c === '{') {
      if (depth === 0) { prelude = css.slice(start, i).trim(); start = i + 1; }
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0) { result.push({ prelude, body: css.slice(start, i) }); start = i + 1; }
    } else if (c === ';' && depth === 0) { start = i + 1; }   // @import / @charset
    i++;
  }
  return result;
}

/** Flattens rules, keeping the chain of enclosing @media/@supports so output can re-wrap. */
function rules(css, wrappers = []) {
  const out = [];
  for (const { prelude, body } of blocks(css)) {
    if (!prelude) continue;
    if (/^@(media|supports|layer)/i.test(prelude)) out.push(...rules(body, [...wrappers, prelude]));
    else if (/^@(keyframes|-webkit-keyframes|font-face|page|property|counter-style)/i.test(prelude)) continue;
    else out.push({ wrappers, selector: prelude, body });
  }
  return out;
}

function declarations(body) {
  const decls = [];
  let cur = ''; let depth = 0; let q = null;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (q) { cur += c; if (c === '\\') cur += body[++i]; else if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { q = c; cur += c; continue; }
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (c === ';' && depth === 0) { decls.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) decls.push(cur);
  return decls.map((d) => {
    const idx = d.indexOf(':');
    if (idx === -1) return null;
    const prop = d.slice(0, idx).trim().toLowerCase();
    let value = d.slice(idx + 1).trim();
    const important = /!\s*important\s*$/i.test(value);
    value = value.replace(/!\s*important\s*$/i, '').trim();
    return { prop, value, important };
  }).filter(Boolean);
}

// ---------- colour helpers ----------
function parseColour(v) {
  const s = v.trim().toLowerCase();
  let m = s.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/);
  if (m) { let h = m[1]; if (h.length === 3) h = h.split('').map((c) => c + c).join(''); return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: 1 }; }
  m = s.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+))?\s*\)$/);
  if (m) return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] };
  const named = { white: [255, 255, 255, 1], silver: [192, 192, 192, 1], gray: [128, 128, 128, 1], grey: [128, 128, 128, 1], lightgray: [211, 211, 211, 1], lightgrey: [211, 211, 211, 1] };
  return named[s] ? { r: named[s][0], g: named[s][1], b: named[s][2], a: 1 } : null;
}
function lum({ r, g, b }) {
  const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function contrast(a, b) { const l1 = lum(a); const l2 = lum(b); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); }
function saturation({ r, g, b }) { const mx = Math.max(r, g, b); const mn = Math.min(r, g, b); return mx === 0 ? 0 : (mx - mn) / mx; }

/** A muted, greyish text colour intended for a dark surface that falls short of 7:1. */
function isMutedText(value) {
  const c = parseColour(value);
  if (!c) return false;
  if (c.a < 1 && c.r === 255 && c.g === 255 && c.b === 255) return c.a < 0.9;     // translucent white
  if (c.a < 1) return false;
  if (saturation(c) > 0.22) return false;                                          // keep coloured text coloured
  const surface = { r: SURFACE[0], g: SURFACE[1], b: SURFACE[2] };
  return lum(c) > 0.12 && contrast(c, surface) < 7;                                // light enough to be "text on dark", but weak
}

// Borders written as var(--border, ...) are handled by overriding --border / --border-strong in ui-prefs.css.
function weakBorderColour(value) {
  return value.replace(/rgba\(\s*255\s*,\s*255\s*,\s*255\s*,\s*([\d.]+)\s*\)/gi, (m, a) => (parseFloat(a) < 0.5 ? HC_BORDER : m));
}

// ---------- generation ----------
function selectorsWith(prefix, selector) {
  return selector.split(/,(?![^(]*\))/).map((s) => s.trim()).filter(Boolean)
    .filter((s) => !/^(html|:root)\b/i.test(s))                                    // root rules are handled by hand in ui-prefs.css
    .map((s) => `${prefix} ${s}`).join(',\n');
}
function wrap(wrappers, text) {
  return wrappers.reduceRight((inner, w) => `${w} {\n${inner.replace(/^/gm, '  ')}\n}`, text);
}

function generate() {
  const scale = []; const hc = [];
  for (const file of INPUTS) {
    const full = path.join(ROOT, file);
    if (!fs.existsSync(full)) continue;
    const css = stripComments(fs.readFileSync(full, 'utf8'));
    for (const rule of rules(css)) {
      const decls = declarations(rule.body);
      const sel = rule.selector;
      // 1. text scale
      const sizeDecl = decls.filter((d) => d.prop === 'font-size').pop();
      const px = sizeDecl && sizeDecl.value.match(/^(\d*\.?\d+)px$/);
      if (px) {
        const s = selectorsWith('html.pref-text-scaled', sel);
        if (s) scale.push(wrap(rule.wrappers, `${s} {\n  font-size: calc(${px[1]}px * var(--ui-text-scale, 1)) !important;\n}`));
      }
      // 2. high contrast
      const out = [];
      for (const d of decls) {
        if (d.prop === 'color' && isMutedText(d.value)) out.push(`  color: ${HC_TEXT} !important;`);
        else if (/^(border|outline)/.test(d.prop) && !d.value.includes('var(') && weakBorderColour(d.value) !== d.value) out.push(`  ${d.prop}: ${weakBorderColour(d.value)} !important;`);
      }
      if (out.length) {
        const s = selectorsWith('html.pref-contrast-high', sel);
        if (s) hc.push(wrap(rule.wrappers, `${s} {\n${out.join('\n')}\n}`));
      }
    }
  }
  const header = (title, how) => `/*\n * ${title}\n * GENERATED by scripts/gen-ui-prefs-css.js. Do not edit by hand: change the source\n * stylesheets or the generator, then run \`node scripts/gen-ui-prefs-css.js\`.\n * ${how}\n */\n`;
  return {
    'ui-prefs-scale.css': header('Larger text (Display and accessibility > Text size)', 'Active only when <html> has the class pref-text-scaled; --ui-text-scale is set by ui-prefs-lib.js.') + scale.join('\n') + '\n',
    'ui-prefs-hc.css': header('High contrast (Display and accessibility > Contrast)', 'Active only when <html> has the class pref-contrast-high. Brightens muted grey text and strengthens faint borders.') + hc.join('\n') + '\n'
  };
}

if (require.main === module) {
  const out = generate();
  const check = process.argv.includes('--check');
  let stale = false;
  for (const [name, text] of Object.entries(out)) {
    const target = path.join(ROOT, name);
    const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
    if (check) { if (current !== text) { console.error(`${name} is out of date`); stale = true; } continue; }
    fs.writeFileSync(target, text);
    console.log(`${name}: ${text.split('\n').length} lines`);
  }
  if (check) process.exit(stale ? 1 : 0);
}

module.exports = { generate, stripComments, rules, declarations, isMutedText, parseColour, contrast };
