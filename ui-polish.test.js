'use strict';
const assert = require('assert');
const { pickAccentText, contrast, parseColour } = require('./ui-polish');

let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log(`ok ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}: ${e.message}`); } }
const close = (a, b, eps = 0.01) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);

test('colour parsing: hex, short hex, rgb, rubbish', () => {
  assert.deepStrictEqual(parseColour('#00d4ff'), [0, 212, 255]);
  assert.deepStrictEqual(parseColour('#fff'), [255, 255, 255]);
  assert.deepStrictEqual(parseColour('rgb(10, 20, 30)'), [10, 20, 30]);
  assert.deepStrictEqual(parseColour(' rgba(1,2,3,0.5) '), [1, 2, 3]);
  assert.strictEqual(parseColour('var(--x)'), null);
  assert.strictEqual(parseColour(''), null);
});

test('contrast: black on white is 21, same colour is 1', () => {
  close(contrast([0, 0, 0], [255, 255, 255]), 21, 0.001);
  close(contrast([9, 9, 9], [9, 9, 9]), 1, 0.001);
});

test('the default cyan accent was 1.77:1 with white text, and gets dark text now', () => {
  close(contrast([255, 255, 255], [0, 212, 255]), 1.77, 0.01);
  assert.strictEqual(pickAccentText([0, 212, 255], [91, 159, 255]), '#07121a');
  assert.ok(contrast([7, 18, 26], [0, 212, 255]) >= 4.5);
});

test('every theme accent in the app gets text that clears 4.5:1 on accent and hover', () => {
  const themes = [['#00d4ff', '#5b9fff'], ['#a855f7', '#c084fc'], ['#4ade80', '#22c55e'], ['#fb923c', '#f97316'], ['#f472b6', '#ec4899']];
  for (const [a, h] of themes) {
    const pick = pickAccentText(parseColour(a), parseColour(h));
    const fg = parseColour(pick);
    assert.ok(contrast(fg, parseColour(a)) >= 4.5, `${a} with ${pick}: ${contrast(fg, parseColour(a)).toFixed(2)}`);
    assert.ok(contrast(fg, parseColour(h)) >= 4.5, `${h} with ${pick}: ${contrast(fg, parseColour(h)).toFixed(2)}`);
  }
});

test('a dark accent gets white text', () => {
  assert.strictEqual(pickAccentText([20, 40, 120], [30, 60, 160]), '#ffffff');
});

test('no usable colours means no decision', () => {
  assert.strictEqual(pickAccentText(null, null), null);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
