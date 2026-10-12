/*
 * Browser smoke test for Display and accessibility (ui-prefs.js and friends).
 * Needs Playwright and a Chromium, so it isn't part of `npm run test:unit`:
 *     node ui-prefs.smoke.cjs        (CHROMIUM_PATH picks the browser)
 * It drives the real index.html with a stubbed window.electron.
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

(async () => {
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}`;
  const launch = { args: ['--no-sandbox'] };
  if (process.env.CHROMIUM_PATH) launch.executablePath = process.env.CHROMIUM_PATH;
  const browser = await chromium.launch(launch);
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  const requests = [];
  page.on('request', (r) => requests.push(r.url()));
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => {
    const data = { getSetting: async (k) => (k === 'tosAcceptedDate' ? '2026-01-01' : k === 'hasRunBefore' ? 'true' : null), saveSetting: async () => true, getAllModels: async () => [], getAllPrinters: async () => [], getAllFilaments: async () => [], getPrintOutcomeStats: async () => [] };
    // anything not stubbed: lists for get*, null otherwise (the real app returns arrays from its list calls)
    window.electron = new Proxy(data, { get: (t, k) => (k in t ? t[k] : (k === 'on' ? () => {} : (typeof k === 'string' && k.startsWith('get') ? async () => [] : async () => null))) });
  });
  await page.route('**/*', (r) => (r.request().url().startsWith(base) ? r.continue() : r.abort()));
  const cls = () => page.evaluate(() => [...document.documentElement.classList].filter((c) => c.startsWith('pref-')).sort());
  const css = (sel, prop, pseudo) => page.evaluate(([s, p, ps]) => getComputedStyle(document.querySelector(s), ps || null)[p], [sel, prop, pseudo]);
  try {
    await page.goto(`${base}/index.html`);
    await page.waitForFunction(() => window.openDisplayPrefs);
    await page.waitForTimeout(800);   // the first-run welcome dialog opens a moment after load
    await page.evaluate(() => { const d = document.getElementById('welcome-message'); if (d && d.open) d.close(); });
    assert.deepStrictEqual(await cls(), [], 'no pref classes by default');
    const baseSize = parseFloat(await css('#total-count', 'fontSize'));

    // keyboard: the skip link comes first in the tab order and lands on the grid area
    assert.ok(await page.evaluate(() => {
      const first = [...document.querySelectorAll('a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])')].find((e) => !e.closest('dialog:not([open])'));
      return first && first.className === 'skip-link';
    }), 'the skip link is first in the tab order');
    await page.focus('.skip-link');
    await page.keyboard.press('Enter');
    assert.strictEqual(await page.evaluate(() => document.activeElement.id), 'main-content', 'the skip link moves focus to the grid area');

    await page.click('#display-prefs-button');
    assert.ok(await page.evaluate(() => document.getElementById('display-prefs-dialog').open), 'the Aa button opens the dialog');
    assert.ok(!(await page.textContent('#display-prefs-root')).includes('Window size'), 'window zoom is desktop-only');
    assert.strictEqual(await page.evaluate(() => document.activeElement.type), 'radio', 'focus starts on a control, not the scroll panel');

    const choose = async (name, value) => { await page.check(`input[name="dp-${name}"][value="${value}"]`); };

    await choose('font', 'easyread');
    assert.ok((await cls()).includes('pref-font-easyread'));
    assert.ok((await css('#total-count', 'fontFamily')).includes('Atkinson Hyperlegible'), 'text uses the chosen font');
    await page.waitForFunction(() => [...document.fonts].some((f) => f.family.replace(/["']/g, '') === 'Atkinson Hyperlegible' && f.status === 'loaded'), null, { timeout: 5000 });
    assert.ok(requests.some((u) => u.endsWith('atkinson-hyperlegible-normal-400-latin.woff2')), 'the font file comes from the app, not Google');
    assert.ok(!requests.some((u) => !u.startsWith(base)), 'no request leaves the app');

    await choose('textScale', '150');
    const bigSize = parseFloat(await css('#total-count', 'fontSize'));
    assert.ok(Math.abs(bigSize / baseSize - 1.5) < 0.02, `text is 1.5x (${baseSize} to ${bigSize})`);
    assert.ok(parseFloat(await css('.sidebar', 'width')) > 400, 'the sidebar grows with the text');

    await choose('spacing', 'roomy');
    assert.ok(parseFloat(await css('body', 'letterSpacing')) > 0, 'letter spacing is applied');

    await choose('palette', 'cvd');
    // badges fade between colours (a 0.2s transition), so wait for them to arrive
    const colourIs = (sel, rgb) => page.waitForFunction(([s, c]) => getComputedStyle(document.querySelector(s)).backgroundColor === c, [sel, rgb], { timeout: 3000 });
    await colourIs('#display-prefs-dialog .print-status-failed', 'rgb(213, 94, 0)');       // Okabe-Ito vermillion
    await colourIs('#display-prefs-dialog .print-status-printed', 'rgb(0, 158, 115)');     // bluish green
    assert.notStrictEqual(await css('#display-prefs-dialog .print-status-failed', 'content', '::before'), 'none', 'a shape comes before each status');

    await choose('contrast', 'high');
    assert.ok((await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--border'))).includes('0.6'), 'borders are stronger');

    await page.check('#dp-targets');
    assert.ok(parseFloat(await css('#scan-directory-button', 'minHeight')) >= 44, 'buttons are at least 44px');
    await page.check('#dp-focus'); await page.check('#dp-links'); await page.check('#dp-motion');
    assert.deepStrictEqual((await cls()).sort(), ['pref-contrast-high', 'pref-focus-strong', 'pref-font-easyread', 'pref-links-underline', 'pref-motion-reduce', 'pref-palette-cvd', 'pref-spacing-roomy', 'pref-targets-large', 'pref-text-scaled'].sort());

    // remembered, and applied before the page paints
    await page.evaluate(() => document.getElementById('display-prefs-dialog').close());
    await page.reload();
    const early = await page.evaluate(() => document.documentElement.className);
    assert.ok(early.includes('pref-font-easyread') && early.includes('pref-text-scaled'), 'choices survive a reload');

    // reset
    await page.waitForFunction(() => window.openDisplayPrefs);
    await page.evaluate(() => window.openDisplayPrefs());
    await page.click('#dp-reset');
    assert.deepStrictEqual(await cls(), [], 'reset puts everything back');
    assert.ok(await page.evaluate(() => { const v = JSON.parse(localStorage.getItem('printventory.displayPrefs')); return v.font === 'default' && v.textScale === 100; }));

    assert.deepStrictEqual(errors, [], `page errors: ${errors.join('; ')}`);
    console.log('ok display and accessibility smoke test');
  } finally {
    await browser.close();
    server.close();
  }
})().catch((e) => { console.error(`FAIL ${e.message}`); process.exit(1); });
