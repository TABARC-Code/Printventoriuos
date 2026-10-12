'use strict';
// The generated stylesheets must match what the generator would produce from the
// current source stylesheets. If this fails, run: node scripts/gen-ui-prefs-css.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { generate, isMutedText } = require('./scripts/gen-ui-prefs-css');

let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log(`ok ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}: ${e.message}`); } }

test('generated stylesheets are up to date', () => {
  for (const [name, text] of Object.entries(generate())) {
    const current = fs.readFileSync(path.join(__dirname, name), 'utf8');
    assert.strictEqual(current, text, `${name} is stale: run node scripts/gen-ui-prefs-css.js`);
  }
});

test('the larger-text file covers every px font size in the source stylesheets', () => {
  const out = generate()['ui-prefs-scale.css'];
  const sizes = (out.match(/calc\(/g) || []).length;
  assert.ok(sizes > 300, `only ${sizes} scaled rules; the tokenizer has probably stopped early`);
});

test('muted greys are caught, coloured text and good contrast are left alone', () => {
  assert.ok(isMutedText('#94a3b8'));
  assert.ok(isMutedText('rgba(255, 255, 255, 0.6)'));
  assert.ok(!isMutedText('#ffffff'));
  assert.ok(!isMutedText('#f3f4f6'));
  assert.ok(!isMutedText('#4a9eff'));      // a coloured link stays coloured
  assert.ok(!isMutedText('#333333'));      // dark text isn't "muted on dark"
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
