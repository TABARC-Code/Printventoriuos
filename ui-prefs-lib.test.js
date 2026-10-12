'use strict';
const assert = require('assert');
const fs = require('fs');
const L = require('./ui-prefs-lib');

let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log(`ok ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}: ${e.message}`); } }

// ---------- colour science, kept small and checked against published values ----------
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const toLin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
const toSrgb = (c) => { c = Math.min(1, Math.max(0, c)); return 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055); };

// Machado, Oliveira and Fernandes (2009), severity 1.0, applied in linear RGB. Each row sums
// to 1, so greys stay grey, which is a useful check that nothing here is mistyped.
const CVD = {
  protanopia:   [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  deuteranopia: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.011820, 0.042940, 0.968881]],
  tritanopia:   [[1.255528, -0.076749, -0.178779], [-0.078411, 0.930809, 0.147602], [0.004733, 0.691367, 0.303900]]
};
function simulate(rgb, matrix) {
  const lin = rgb.map(toLin);
  return matrix.map((row) => toSrgb(row[0] * lin[0] + row[1] * lin[1] + row[2] * lin[2]));
}
function toLab(rgb) {
  const [r, g, b] = rgb.map(toLin);
  let x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
  let y = 0.2126729 * r + 0.7151522 * g + 0.0721750 * b;
  let z = (0.0193339 * r + 0.1191920 * g + 0.9503041 * b) / 1.08883;
  const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  [x, y, z] = [f(x), f(y), f(z)];
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}
// CIEDE2000 (Sharma, Wu and Dalal 2005)
function deltaE00([L1, a1, b1], [L2, a2, b2]) {
  const rad = (d) => d * Math.PI / 180; const deg = (r) => r * 180 / Math.PI;
  const C1 = Math.hypot(a1, b1); const C2 = Math.hypot(a2, b2); const Cb = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Math.pow(Cb, 7) / (Math.pow(Cb, 7) + Math.pow(25, 7))));
  const a1p = (1 + G) * a1; const a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1); const C2p = Math.hypot(a2p, b2);
  const h = (b, a) => (b === 0 && a === 0 ? 0 : (deg(Math.atan2(b, a)) + 360) % 360);
  const h1p = h(b1, a1p); const h2p = h(b2, a2p);
  const dLp = L2 - L1; const dCp = C2p - C1p;
  let dhp = 0;
  if (C1p * C2p !== 0) { dhp = h2p - h1p; if (dhp > 180) dhp -= 360; else if (dhp < -180) dhp += 360; }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin(rad(dhp / 2));
  const Lbp = (L1 + L2) / 2; const Cbp = (C1p + C2p) / 2;
  let hbp = h1p + h2p;
  if (C1p * C2p !== 0) { hbp = Math.abs(h1p - h2p) <= 180 ? (h1p + h2p) / 2 : (h1p + h2p < 360 ? (h1p + h2p + 360) / 2 : (h1p + h2p - 360) / 2); }
  const T = 1 - 0.17 * Math.cos(rad(hbp - 30)) + 0.24 * Math.cos(rad(2 * hbp)) + 0.32 * Math.cos(rad(3 * hbp + 6)) - 0.20 * Math.cos(rad(4 * hbp - 63));
  const dTheta = 30 * Math.exp(-Math.pow((hbp - 275) / 25, 2));
  const Rc = 2 * Math.sqrt(Math.pow(Cbp, 7) / (Math.pow(Cbp, 7) + Math.pow(25, 7)));
  const Sl = 1 + (0.015 * Math.pow(Lbp - 50, 2)) / Math.sqrt(20 + Math.pow(Lbp - 50, 2));
  const Sc = 1 + 0.045 * Cbp; const Sh = 1 + 0.015 * Cbp * T;
  const Rt = -Math.sin(rad(2 * dTheta)) * Rc;
  return Math.sqrt(Math.pow(dLp / Sl, 2) + Math.pow(dCp / Sc, 2) + Math.pow(dHp / Sh, 2) + Rt * (dCp / Sc) * (dHp / Sh));
}
const contrastRatio = (a, b) => {
  const lum = ([r, g, bl]) => 0.2126 * toLin(r) + 0.7152 * toLin(g) + 0.0722 * toLin(bl);
  const l1 = lum(a); const l2 = lum(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
};

test('CIEDE2000 matches a published test pair (Sharma et al.)', () => {
  const d = deltaE00([50, 2.6772, -79.7751], [50, 0, -82.7485]);
  assert.ok(Math.abs(d - 2.0425) < 0.001, d);
});

test('every CVD matrix keeps greys grey (rows sum to 1)', () => {
  for (const [name, m] of Object.entries(CVD)) m.forEach((row, i) => assert.ok(Math.abs(row.reduce((s, v) => s + v, 0) - 1) < 1e-5, `${name} row ${i}`));
});

// ---------- preferences ----------
test('defaults normalise to themselves and are recognised as default', () => {
  assert.deepStrictEqual(L.normalise(L.DEFAULTS), { ...L.DEFAULTS });
  assert.ok(L.isDefault(null));
  assert.deepStrictEqual(L.classList(null), []);
});

test('rubbish in storage falls back to defaults, value by value', () => {
  const p = L.normalise({ font: 'comic-sans', textScale: 'big', palette: 'cvd', contrast: 7, zoom: 9999, motion: 'reduce' });
  assert.strictEqual(p.font, 'default');
  assert.strictEqual(p.textScale, 100);
  assert.strictEqual(p.contrast, 'normal');
  assert.strictEqual(p.palette, 'cvd');          // the valid ones survive
  assert.strictEqual(p.motion, 'reduce');
  assert.strictEqual(p.zoom, 150);               // snapped to the nearest allowed step
  assert.deepStrictEqual(L.normalise('nonsense'), L.normalise(null));
});

test('choices become the expected classes and variables', () => {
  const prefs = { font: 'easyread', textScale: 130, spacing: 'roomy', contrast: 'high', palette: 'cvd', targets: 'large', focus: 'strong', links: 'underline', motion: 'reduce' };
  assert.deepStrictEqual(L.classList(prefs).sort(), ['pref-contrast-high', 'pref-focus-strong', 'pref-font-easyread', 'pref-links-underline', 'pref-motion-reduce', 'pref-palette-cvd', 'pref-spacing-roomy', 'pref-targets-large', 'pref-text-scaled'].sort());
  const vars = L.cssVars(prefs);
  assert.strictEqual(vars['--ui-text-scale'], '1.3');
  assert.ok(vars['--ui-font'].startsWith("'Atkinson Hyperlegible'"));
});

test('apply replaces old pref classes and leaves other classes alone', () => {
  const classes = new Set(['theme-x', 'pref-font-lexend']);
  const style = {};
  const el = { classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), [Symbol.iterator]: () => classes[Symbol.iterator]() }, style: { setProperty: (k, v) => { style[k] = v; } } };
  Object.defineProperty(el.classList, 'length', { get: () => classes.size });
  el.classList.item = (i) => [...classes][i];
  // Array.from needs iterability, provided above
  L.apply({ font: 'easyread', palette: 'cvd' }, el);
  assert.ok(classes.has('theme-x') && classes.has('pref-font-easyread') && classes.has('pref-palette-cvd'));
  assert.ok(!classes.has('pref-font-lexend'));
  assert.strictEqual(style['--ui-text-scale'], '1');
});

test('load and save survive blocked and corrupt storage', () => {
  const store = {};
  const good = { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = v; } };
  assert.ok(L.save({ font: 'lexend', textScale: 115 }, good));
  assert.strictEqual(L.load(good).font, 'lexend');
  assert.strictEqual(L.load(good).textScale, 115);
  store[L.STORAGE_KEY] = '{not json';
  assert.ok(L.isDefault(L.load(good)));
  const blocked = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
  assert.ok(L.isDefault(L.load(blocked)));
  assert.strictEqual(L.save({}, blocked), false);
});

// ---------- the colour-blind palette ----------
const names = Object.keys(L.STATUS_PALETTE);
const pairs = [];
for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) pairs.push([names[i], names[j]]);

test('palette text colour reads on every fill (WCAG AA, 4.5:1)', () => {
  for (const [n, p] of Object.entries(L.STATUS_PALETTE)) {
    const r = contrastRatio(hex(p.text), hex(p.fill));
    assert.ok(r >= 4.5, `${n}: ${r.toFixed(2)}`);
  }
});

test('palette colours stay apart under simulated colour blindness', () => {
  const report = [];
  for (const [cvdName, matrix] of Object.entries(CVD)) {
    let worst = { d: Infinity };
    for (const [a, b] of pairs) {
      const la = toLab(simulate(hex(L.STATUS_PALETTE[a].fill), matrix));
      const lb = toLab(simulate(hex(L.STATUS_PALETTE[b].fill), matrix));
      const d = deltaE00(la, lb);
      if (d < worst.d) worst = { d, pair: `${a}/${b}` };
    }
    report.push(`${cvdName}: closest ${worst.pair} dE00 ${worst.d.toFixed(1)}`);
    assert.ok(worst.d >= 10, `${cvdName}: ${worst.pair} only ${worst.d.toFixed(1)} apart`);
  }
  console.log('   ' + report.join(' | '));
});

test('the whole palette is easier to tell apart than the original colours, for all three types', () => {
  // The original badge colours. Measured honestly: printed/failed specifically is NOT better under
  // protanopia (the old green was much lighter, which helps), but the closest pair anywhere in the set is.
  const oldSet = { printed: '#2ecc71', want: '#9b59b6', queued: '#f1c40f', printing: '#3498db', failed: '#e74c3c', mixed: '#e67e22' };
  const newSet = Object.fromEntries(Object.keys(oldSet).map((k) => [k, L.STATUS_PALETTE[k].fill]));
  const closest = (set, matrix) => {
    const n = Object.keys(set); let w = Infinity;
    for (let i = 0; i < n.length; i++) for (let j = i + 1; j < n.length; j++) {
      w = Math.min(w, deltaE00(toLab(simulate(hex(set[n[i]]), matrix)), toLab(simulate(hex(set[n[j]]), matrix))));
    }
    return w;
  };
  for (const [name, matrix] of Object.entries(CVD)) {
    const before = closest(oldSet, matrix); const after = closest(newSet, matrix);
    console.log(`   ${name}: closest pair dE00 ${before.toFixed(1)} before, ${after.toFixed(1)} now`);
    assert.ok(after > before, `${name}: ${after.toFixed(1)} vs ${before.toFixed(1)}`);
  }
});

test('printed versus failed, the pair that matters most, stays clearly apart for every type', () => {
  for (const [name, matrix] of Object.entries(CVD)) {
    const d = deltaE00(toLab(simulate(hex(L.STATUS_PALETTE.printed.fill), matrix)), toLab(simulate(hex(L.STATUS_PALETTE.failed.fill), matrix)));
    console.log(`   ${name}: printed/failed dE00 ${d.toFixed(1)}`);
    assert.ok(d >= 15, `${name}: ${d.toFixed(1)}`);
  }
});

test('ui-prefs.css uses exactly the palette in the library', () => {
  const css = fs.readFileSync(require('path').join(__dirname, 'ui-prefs.css'), 'utf8').toUpperCase();
  for (const [n, p] of Object.entries(L.STATUS_PALETTE)) assert.ok(css.includes(p.fill.toUpperCase()), `${n} ${p.fill} missing from ui-prefs.css`);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
