/*
 * Browser smoke test for the Farm Cost Calculator dialog.
 *
 * Not named *.test.js on purpose: it needs Playwright and a Chromium, so it
 * stays out of `npm run test:unit`. Run it with:
 *
 *     node farm-cost-ui.smoke.cjs
 *
 * Set CHROMIUM_PATH to use an existing browser. It loads the real index.html
 * with a stubbed window.electron (printers, filaments, settings held in memory),
 * which is enough to drive the dialog without Electron.
 *
 * What it proves: the dialog opens from the sidebar button, the page's price
 * equals the library's, saved settings round-trip, a hostile printer name is
 * rendered as text and not run, and the batch planner appears for a multi-plate
 * job. What it doesn't: how it looks. Look at it.
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
const FC = require('./farm-cost-lib');

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg' };
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
  const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => {
    window.__store = {};
    const data = {
      getSetting: async (k) => window.__store[k] ?? null,
      saveSetting: async (k, v) => { window.__store[k] = v; return true; },
      getAllPrinters: async () => [
        { id: 1, nickname: 'Voron <img src=x onerror="window.__xss=1">' },
        { id: 2, nickname: 'Bambu A1' }],
      getAllFilaments: async () => [{ id: 7, name: 'PLA Basic', vendor: 'Acme', material: 'PLA' }],
      getPrintOutcomeStats: async () => [{ printer_id: 1, outcome: 'printed', quantity: 18 }, { printer_id: 1, outcome: 'failed', quantity: 2 }]
    };
    window.electron = new Proxy(data, { get: (t, k) => (k in t ? t[k] : (k === 'on' ? () => {} : async () => null)) });
  });
  await page.route('**/*', (r) => (r.request().url().startsWith(base) ? r.continue() : r.abort()));
  try {
    await page.goto(`${base}/index.html`);
    await page.waitForFunction(() => typeof window.openFarmCost === 'function');
    await page.evaluate(() => { const d = document.getElementById('terms-of-service-dialog'); if (d && d.open) d.close(); });

    await page.click('#farm-cost-button');
    assert.ok(await page.evaluate(() => document.getElementById('farm-cost-dialog').open), 'dialog opens from the sidebar button');

    await page.click('#fc-tab-farm');
    const rows = await page.$$('#fc-pane-farm .fc-edit-table tbody tr');
    const fill = async (row, vals) => { const inputs = await row.$$('input:not([type=checkbox])'); for (let i = 0; i < vals.length; i++) await inputs[i].fill(String(vals[i])); };
    await fill(rows[0], [400, 0, 2000, 150, 0, 500, 1]);
    await fill(rows[1], [300, 0, 2000, 120, 0, 500, 2]);
    const filInputs = await (await page.$$('#fc-pane-farm .fc-card:nth-of-type(3) tbody tr'))[0].$$('input');
    await filInputs[0].fill('20'); await filInputs[1].fill('1000');

    await page.click('#fc-tab-quote');
    await page.selectOption('#fc-printer', '1');
    const nums = await page.$$('#fc-pane-quote .fc-inputs input[type=number]');
    await nums[0].fill('3');
    await page.selectOption('.fc-filament-row select', '7');
    await (await page.$('.fc-filament-row input[aria-label="Grams per plate"]')).fill('50');

    const expected = FC.computeJob(
      { printers: { 1: { price: 400, lifetimeHours: 2000, watts: 150, hoursPerMonth: 500 } }, filaments: { 7: { spoolPrice: 20, spoolGrams: 1000 } } },
      { printerId: 1, printHours: 3, filaments: [{ grams: 50, filamentId: 7 }], setupMinutes: 5, pricing: { mode: 'margin' } });
    assert.strictEqual(await page.textContent('.fc-price'), FC.formatMoney(expected.unitPrice, '£'), 'page price equals library price');
    assert.ok((await page.textContent('.fc-tiles')).includes('40.0%'), 'margin tile shows the target');
    assert.ok((await page.textContent('#fc-pane-quote')).includes('10.0%'), 'logged failure rate is offered');

    const nums2 = await page.$$('#fc-pane-quote .fc-inputs input[type=number]');
    await nums2[2].fill('6');
    assert.strictEqual((await page.$$('.fc-batch tbody tr')).length, 2, 'batch planner splits across both printers');

    assert.ok(!(await page.evaluate(() => !!window.__xss)), 'printer name is text, not markup');
    await page.waitForFunction(() => window.__store.farmCostConfig, null, { timeout: 3000 });
    const saved = await page.evaluate(() => JSON.parse(window.__store.farmCostConfig));
    assert.strictEqual(saved.printers[1].price, 400);
    assert.strictEqual(saved.filaments[7].spoolPrice, 20);
    assert.deepStrictEqual(errors, [], `page errors: ${errors.join('; ')}`);
    console.log('ok farm cost dialog smoke test');
  } finally {
    await browser.close();
    server.close();
  }
})().catch((e) => { console.error(`FAIL ${e.message}`); process.exit(1); });
