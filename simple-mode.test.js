'use strict';
// Simple mode: the parts that can be checked without a browser. The real thing (does it
// actually hide, is it out of the accessibility tree) is simple-mode.smoke.cjs.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Lib = require('./ui-prefs-lib');
const { rules, declarations, stripComments } = require('./scripts/gen-ui-prefs-css');

let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log(`ok ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}: ${e.message}`); } }
const read = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');

const css = stripComments(read('simple-mode.css'));
const parsed = rules(css).map((r) => ({ selector: r.selector, decls: declarations(r.body) }));
const hiders = parsed.filter((r) => r.decls.some((d) => d.prop === 'display' && d.value === 'none'));
const html = read('index.html');

test('the stylesheet hides by display:none only, so hidden things leave the tab order and the accessibility tree', () => {
  for (const r of parsed) for (const d of r.decls) {
    assert.ok(!(d.prop === 'opacity' && d.value === '0'), `opacity:0 in ${r.selector}`);
    assert.ok(!(d.prop === 'visibility'), `visibility in ${r.selector}`);
    assert.ok(!(/^(left|top|right|bottom|margin-left|text-indent)$/.test(d.prop) && /-\d{3,}/.test(d.value)), `off-screen positioning in ${r.selector}`);
    assert.ok(!(d.prop === 'clip' || d.prop === 'clip-path'), `clipping in ${r.selector}`);
  }
});

test('every hiding rule is scoped to html.pref-simple, apart from the "off by default" ones', () => {
  const defaults = new Set(['.simple-mode-bar', '.icon-buttons-container .simple-label']);
  for (const r of hiders) {
    for (const sel of r.selector.split(',').map((s) => s.trim())) assert.ok(sel.startsWith('html.pref-simple ') || defaults.has(sel), `unscoped hiding rule: ${sel}`);
  }
  for (const d of defaults) assert.ok(hiders.some((r) => r.selector.split(',').map((s) => s.trim()).includes(d)), `${d} should be hidden when Simple mode is off`);
});

test('the core controls are never hidden', () => {
  const core = ['search-filter-input', 'sort-select', 'folder-select', 'printed-select', 'scan-directory-button', 'view-library-button',
    'model-print-status', 'log-print-button', 'model-name', 'display-prefs-button', 'simple-mode-off', 'clear-all-filters-button', 'stop-thumbnail-generation'];
  for (const r of hiders) {
    // :not(#id) is how the farm cost button is kept; a plain #id in a hiding selector is the mistake
    const bare = r.selector.replace(/:not\([^)]*\)/g, '').replace(/:has\([^)]*\)/g, '');
    for (const id of core.concat('farm-cost-button')) assert.ok(!bare.includes(`#${id}`), `#${id} is hidden by: ${r.selector}`);
  }
  assert.ok(!hiders.some((r) => /\.view-button|\.file-grid|\.sidebar\b[^ ]*$/.test(r.selector)), 'view buttons, the grid and the sidebar itself stay');
});

test('every id the stylesheet and script rely on exists in index.html', () => {
  const ids = new Set();
  for (const r of parsed) for (const m of r.selector.matchAll(/#([a-z][\w-]*)/gi)) ids.add(m[1]);
  for (const m of read('simple-mode.js').matchAll(/\$\('([\w-]+)'\)/g)) ids.add(m[1]);
  assert.ok(ids.size > 8);
  for (const id of ids) assert.ok(html.includes(`id="${id}"`), `#${id} is not in index.html`);
});

test('the panel says Show everything, and the calculator button keeps its name when its label appears', () => {
  assert.ok(/<button[^>]*id="simple-mode-off"[^>]*>Show everything<\/button>/.test(html));
  const btn = html.match(/<button id="farm-cost-button"[\s\S]*?<\/button>/)[0];
  const aria = btn.match(/aria-label="([^"]+)"/)[1];
  const visible = btn.match(/<span class="simple-label">([^<]+)<\/span>/)[1];
  assert.strictEqual(visible, aria, 'visible text must match the accessible name (WCAG 2.5.3)');
  assert.ok(/id="simple-mode-status"[^>]*role="status"/.test(html), 'a polite live region announces the change');
});

test('Simple mode files are packaged for the desktop and Docker builds', () => {
  const pkg = read('package.json'); const docker = read('Dockerfile'); const dist = read('scripts/create-docker-distribution.js');
  for (const f of ['simple-mode.js', 'simple-mode.css']) {
    assert.ok(pkg.includes(`"${f}"`), `${f} missing from package.json`);
    assert.ok(dist.includes(`'${f}'`), `${f} missing from create-docker-distribution.js`);
    assert.ok(docker.includes(f), `${f} missing from Dockerfile`);
  }
});

test('the native menus and the preload allow-list know about toggle-simple-mode', () => {
  assert.ok(read('preload.js').includes("'toggle-simple-mode'"));
  assert.ok(read('renderer.js').includes("'toggle-simple-mode'"));
  assert.strictEqual((read('main.js').match(/send\('toggle-simple-mode'\)/g) || []).length, 2, 'both native Tools menus');
});

// ---- simple-mode.js against a tiny fake page ----
function fakePage(stored) {
  const classes = new Set();
  const listeners = {};
  const store = Object.assign({}, stored);
  const documentElement = { classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c), [Symbol.iterator]: () => classes[Symbol.iterator]() }, style: { setProperty() {} } };
  const dispatched = [];
  class CustomEvent { constructor(type, init) { this.type = type; this.detail = init && init.detail; } }
  const window = {
    CustomEvent,
    addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); },
    dispatchEvent: (e) => { dispatched.push(e); (listeners[e.type] || []).forEach((fn) => fn(e)); },
    _electronPendingEvents: {}, _electronRealEventHandlers: {}
  };
  const localStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = v; } };
  const document = { readyState: 'complete', documentElement, activeElement: null, body: {}, getElementById: () => null };
  const ctx = vm.createContext({ window, document, localStorage, CustomEvent, setTimeout: () => 0, console });
  // load the real library inside the fake page so it sees the fake localStorage, as it would in a browser
  vm.runInContext(read('ui-prefs-lib.js'), ctx);
  window.UiPrefsLib = ctx.UiPrefsLib;
  return { ctx, window, classes, store, dispatched };
}
const load = (page) => vm.runInContext(read('simple-mode.js'), page.ctx);

test('toggling saves, applies and announces, and leaves the other display choices alone', () => {
  const page = fakePage({ [Lib.STORAGE_KEY]: JSON.stringify({ v: 1, font: 'easyread', textScale: 130 }) });
  load(page);
  assert.strictEqual(page.window.isSimpleMode(), false);
  page.window.toggleSimpleMode();
  assert.ok(page.classes.has('pref-simple'));
  let saved = JSON.parse(page.store[Lib.STORAGE_KEY]);
  assert.deepStrictEqual([saved.simple, saved.font, saved.textScale], ['on', 'easyread', 130]);
  assert.strictEqual(page.dispatched.length, 1);
  assert.strictEqual(page.dispatched[0].detail.on, true);
  page.window.setSimpleMode(false);
  assert.ok(!page.classes.has('pref-simple'));
  saved = JSON.parse(page.store[Lib.STORAGE_KEY]);
  assert.deepStrictEqual([saved.simple, saved.font], ['off', 'easyread']);
});

test('the native menu event toggles it, including one that arrived before the script loaded', () => {
  const page = fakePage();
  page.window._electronPendingEvents['toggle-simple-mode'] = [[]];
  load(page);
  assert.ok(page.classes.has('pref-simple'), 'the queued event was replayed');
  page.window._electronRealEventHandlers['toggle-simple-mode']();
  assert.ok(!page.classes.has('pref-simple'));
  assert.strictEqual(page.window._electronPendingEvents['toggle-simple-mode'], undefined);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
