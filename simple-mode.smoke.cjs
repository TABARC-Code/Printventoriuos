/*
 * Browser smoke test for Simple mode (simple-mode.js / simple-mode.css).
 * Needs Playwright and a Chromium, so it isn't part of `npm run test:unit`:
 *     node simple-mode.smoke.cjs        (CHROMIUM_PATH picks the browser)
 * Set AXE_PATH to an axe.min.js to also run axe-core on the simple-mode screen.
 * It drives the real index.html with a stubbed window.electron. It does not load
 * real models, so the details panel is shown by removing its "hidden" class.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');

let chromium;
try { ({ chromium } = require('playwright-core')); } catch (_) {
  try { ({ chromium } = require('playwright')); } catch (__) { console.log('skip: Playwright is not installed'); process.exit(0); }
}
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.woff2': 'font/woff2' };
function serve() {
  const server = http.createServer((req, res) => {
    const file = path.join(__dirname, decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html');
    if (!file.startsWith(__dirname) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// Visible = takes up space. Hidden by display:none = no boxes, so also out of the tab order and the accessibility tree.
const visible = (page, sel) => page.evaluate((s) => { const e = document.querySelector(s); return !!e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden'; }, sel);

(async () => {
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}`;
  const launch = { args: ['--no-sandbox'] };
  if (process.env.CHROMIUM_PATH) launch.executablePath = process.env.CHROMIUM_PATH;
  const browser = await chromium.launch(launch);
  const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => {
    const data = { getSetting: async (k) => (k === 'tosAcceptedDate' ? '2026-01-01' : k === 'hasRunBefore' ? 'true' : null), saveSetting: async () => true, getAllModels: async () => [], getAllPrinters: async () => [], getAllFilaments: async () => [], getPrintOutcomeStats: async () => [] };
    window.electron = new Proxy(data, { get: (t, k) => (k in t ? t[k] : (k === 'on' ? () => {} : (typeof k === 'string' && k.startsWith('get') ? async () => [] : async () => null))) });
  });
  await page.route('**/*', (r) => (r.request().url().startsWith(base) ? r.continue() : r.abort()));
  const hasClass = () => page.evaluate(() => document.documentElement.classList.contains('pref-simple'));
  try {
    await page.goto(`${base}/index.html`);
    await page.waitForFunction(() => window.openDisplayPrefs && window.toggleSimpleMode);
    await page.waitForTimeout(800);
    await page.evaluate(() => { const d = document.getElementById('welcome-message'); if (d && d.open) d.close(); });

    // --- off by default: the full interface, nothing new on screen ---
    assert.strictEqual(await hasClass(), false, 'off by default');
    for (const s of ['#dup-button', '#tag-button', '#printer-button', '#roulette-button', '#filter-stack-toggle', '.view-button[data-view="list"]', '#farm-cost-button']) assert.ok(await visible(page, s), `${s} visible by default`);
    for (const s of ['#simple-mode-bar', '#simple-mode-off', '#farm-cost-button .simple-label']) assert.ok(!(await visible(page, s)), `${s} not shown by default`);
    await page.evaluate(() => document.getElementById('model-details').classList.remove('hidden'));
    assert.ok(await visible(page, '#model-designer'), 'details show every field by default');
    await page.evaluate(() => document.getElementById('model-details').classList.add('hidden'));

    // --- switch on from the Display dialog ---
    await page.click('#display-prefs-button');
    assert.ok(await page.isVisible('#dp-simple'), 'Display dialog has the Simple mode switch');
    await page.check('#dp-simple');
    assert.ok(await hasClass(), 'pref-simple is on <html>');
    assert.strictEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('printventory.displayPrefs')).simple), 'on');
    await page.waitForFunction(() => document.getElementById('simple-mode-status').textContent.includes('Simple mode is on'));
    // Reset is about looks; it must not drop you out of Simple mode behind your back
    await page.click('#dp-reset');
    assert.ok(await hasClass(), 'Reset to standard leaves Simple mode alone');
    await page.evaluate(() => document.getElementById('display-prefs-dialog').close());

    // --- what stays, what goes ---
    for (const s of ['#search-filter-input', '#sort-select', '#folder-select', '#printed-select', '#scan-directory-button', '#view-library-button', '#display-prefs-button', '#simple-mode-bar', '#simple-mode-off', '#farm-cost-button', '#farm-cost-button .simple-label', '.view-button[data-view="detailed"]', '.view-button[data-view="list"]', '#total-count'])
      assert.ok(await visible(page, s), `${s} stays visible`);
    for (const s of ['#dup-button', '#tag-button', '#filament-button', '#printer-button', '#roulette-button', '#filter-stack-toggle', '#designer-select', '#tag-filter', '#invert-filter-button', '#edit-mode-toggle', '#folder-tree-button', '#search-include-notes'])
      assert.ok(!(await visible(page, s)), `${s} hidden`);
    assert.strictEqual(await page.locator('#farm-cost-button').getAttribute('aria-label'), await page.locator('#farm-cost-button .simple-label').textContent(), 'visible label matches accessible name');

    // hidden means unreachable: not focusable, not in the accessibility tree
    const snap = await page.locator('.sidebar').ariaSnapshot();
    for (const gone of ['De-Dup', 'Tag Manager', 'Printer Manager', 'Filament Manager', 'Print Roulette', 'More filters', 'Select Designer', 'Invert Filters', 'Multi-Edit Mode']) assert.ok(!snap.includes(gone), `"${gone}" is in the accessibility tree in Simple mode`);
    for (const keep of ['Show everything', 'Print Farm Cost Calculator', 'Search Models', 'Print Status']) assert.ok(snap.includes(keep), `"${keep}" missing from the accessibility tree`);
    const tabbable = [];
    await page.focus('.skip-link');
    for (let i = 0; i < 40; i++) { await page.keyboard.press('Tab'); tabbable.push(await page.evaluate(() => document.activeElement.id || document.activeElement.className)); }
    for (const id of ['dup-button', 'tag-button', 'printer-button', 'roulette-button', 'filter-stack-toggle', 'designer-select', 'invert-filter-button']) assert.ok(!tabbable.includes(id), `Tab reaches hidden #${id}`);
    assert.ok(tabbable.includes('farm-cost-button') && tabbable.includes('simple-mode-off'), 'Tab reaches the calculator and Show everything');

    // the calculator still opens (nothing was unwired)
    await page.click('#farm-cost-button');
    assert.ok(await page.evaluate(() => document.getElementById('farm-cost-dialog').open), 'Farm Cost Calculator opens in Simple mode');
    await page.evaluate(() => document.getElementById('farm-cost-dialog').close());

    // details panel: name, print status, log a print
    await page.evaluate(() => document.getElementById('model-details').classList.remove('hidden'));
    for (const s of ['#model-name', '#model-print-status', '#log-print-button']) assert.ok(await visible(page, s), `${s} stays in details`);
    for (const s of ['#model-designer', '#model-source', '#model-license', '#tag-select', '#filament-select', '#model-notes-preview']) assert.ok(!(await visible(page, s)), `${s} hidden in details`);
    await page.evaluate(() => document.getElementById('model-details').classList.add('hidden'));

    // --- axe-core on the Simple mode screen: report anything, fail on what we could have introduced ---
    if (process.env.AXE_PATH && fs.existsSync(process.env.AXE_PATH)) {
      await page.addScriptTag({ content: fs.readFileSync(process.env.AXE_PATH, 'utf8') });
      const result = await page.evaluate(async () => (await window.axe.run(document, { resultTypes: ['violations'] })).violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.map((n) => n.target.join(' ')) })));
      console.log('axe violations (simple mode):', JSON.stringify(result));
      const mine = result.filter((v) => v.nodes.some((n) => /simple-mode|farm-cost-button/.test(n)));
      assert.deepStrictEqual(mine, [], 'axe violations on Simple mode elements');
    }

    // --- persistence, then Show everything ---
    await page.reload();
    await page.waitForFunction(() => window.toggleSimpleMode);
    assert.ok(await hasClass(), 'Simple mode survives a reload');
    assert.ok(await visible(page, '#simple-mode-off'), 'and is there before anything is clicked');
    await page.evaluate(() => { const d = document.getElementById('welcome-message'); if (d && d.open) d.close(); });
    await page.click('#simple-mode-off');
    assert.strictEqual(await hasClass(), false, 'Show everything turns it off');
    assert.ok(await visible(page, '#dup-button') && await visible(page, '#filter-stack-toggle'), 'everything is back');
    assert.ok(!(await visible(page, '#simple-mode-bar')), 'the panel goes');
    assert.strictEqual(await page.evaluate(() => document.activeElement.id), 'search-filter-input', 'focus lands somewhere sensible, not on the page');
    await page.waitForFunction(() => document.getElementById('simple-mode-status').textContent.includes('Simple mode is off'));

    // old saved prefs without the field still load
    await page.evaluate(() => localStorage.setItem('printventory.displayPrefs', JSON.stringify({ v: 1, font: 'lexend' })));
    await page.reload();
    await page.waitForFunction(() => window.toggleSimpleMode);
    assert.strictEqual(await hasClass(), false, 'prefs saved before Simple mode existed load as off');

    // web menu (Server Mode) item and its filtering
    await page.evaluate(async () => {
      window.electron.isServerMode = async () => true;
      await createServerMenuBar();
    });
    const menu = (sel) => page.evaluate((s) => [...document.querySelectorAll(s)].map((e) => e.textContent.trim()), '.server-menu-item');
    assert.ok((await menu()).includes('Simple Mode'), 'web Tools menu has Simple Mode');
    await page.evaluate(() => window.setSimpleMode(true));
    const shown = await page.evaluate(() => [...document.querySelectorAll('.server-menu-item')].filter((e) => e.getClientRects().length || e.closest('.server-menu-dropdown')?.style.display === 'none' && getComputedStyle(e).display !== 'none').map((e) => e.textContent.trim()));
    assert.ok(shown.includes('Farm Cost Calculator') && shown.includes('Simple Mode'), `kept menu items: ${shown}`);
    assert.ok(!shown.includes('Purge Models') && !shown.includes('Restart Server') && !shown.includes('AI Config'), `hidden menu items leaked: ${shown}`);
    assert.ok(!(await page.evaluate(() => [...document.querySelectorAll('.server-menu-group')].some((g) => g.textContent.startsWith('Settings') && getComputedStyle(g).display !== 'none'))), 'Settings menu hidden');

    assert.deepStrictEqual(errors, [], `page errors: ${errors.join('; ')}`);
    console.log('ok simple mode smoke test');
  } finally {
    await browser.close();
    server.close();
  }
})().catch((e) => { console.error(`FAIL ${e.message}`); process.exit(1); });
