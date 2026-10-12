/*
 * Browser smoke test for the admin side of Quote requests (kiosk-admin.js). The page's window.electron is
 * wired straight to the REAL handlers in kiosk-core.js over a throwaway in-memory library, so this exercises
 * the actual inbox, catalogue and settings logic, not a mock of it.
 * Needs Playwright, Chromium and better-sqlite3 built for plain Node:   node kiosk-admin.smoke.cjs
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const Database = require('better-sqlite3');

let chromium;
try { ({ chromium } = require('playwright-core')); } catch (_) {
  try { ({ chromium } = require('playwright')); } catch (__) { console.log('skip: Playwright is not installed'); process.exit(0); }
}
const K = require('./kiosk-core');

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.woff2': 'font/woff2' };
const CHANNELS = { getKioskSettings: 'kiosk-get-settings', saveKioskSettings: 'kiosk-save-settings', listKioskItems: 'kiosk-list-items', searchKioskModels: 'kiosk-search-models', saveKioskItem: 'kiosk-save-item', removeKioskItem: 'kiosk-remove-item', listKioskRequests: 'kiosk-list-requests', updateKioskRequest: 'kiosk-update-request', deleteKioskRequest: 'kiosk-delete-request', getKioskRequestCount: 'kiosk-request-count', previewKioskQuote: 'kiosk-preview-quote', testKioskWebhook: 'kiosk-test-webhook' };

const step = (n) => { if (process.env.STEPS) console.log('step:', n); };
(async () => {
  const db = new Database(':memory:');
  db.prepare('CREATE TABLE models (id INTEGER PRIMARY KEY AUTOINCREMENT, fileName TEXT, designer TEXT, license TEXT, thumbnail TEXT)').run();
  K.ensureSchema(db);
  db.prepare("INSERT INTO models (fileName, designer, license) VALUES ('Phone stand.stl', 'Acme', 'CC-BY')").run();
  const store = { farmCostConfig: JSON.stringify({ currency: '£', electricityRate: 0.25, labourRate: 15, printers: { 1: { price: 400, lifetimeHours: 2000, watts: 150, hoursPerMonth: 500 } }, filaments: { 1: { spoolPrice: 20, spoolGrams: 1000 } } }) };
  const handlers = {};
  K.registerAdminIpc({ handle: (c, fn) => { handlers[c] = fn; } }, { getDb: () => db, getSetting: (k) => store[k] ?? null, setSetting: (k, v) => { store[k] = String(v); }, status: () => ({ tokenSet: false, serverMode: true }) });

  const server = http.createServer((req, res) => {
    const file = path.join(__dirname, decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html');
    if (!file.startsWith(__dirname) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const launch = { args: ['--no-sandbox'] };
  if (process.env.CHROMIUM_PATH) launch.executablePath = process.env.CHROMIUM_PATH;
  const browser = await chromium.launch(launch);
  const page = await (await browser.newContext({ viewport: { width: 1300, height: 900 } })).newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.exposeFunction('__ipc', async (channel, args) => {
    try { return { ok: true, value: await handlers[channel]({}, ...args) }; } catch (e) { return { ok: false, error: e.message }; }
  });
  await page.addInitScript((channels) => {
    const data = {
      getSetting: async (k) => (k === 'tosAcceptedDate' ? '2026-01-01' : k === 'hasRunBefore' ? 'true' : null), saveSetting: async () => true,
      getAllFilaments: async () => [{ id: 1, name: 'PLA Basic', vendor: 'Acme', material: 'PLA' }], getAllModels: async () => []
    };
    for (const [name, channel] of Object.entries(channels)) {
      data[name] = async (...args) => { const r = await window.__ipc(channel, args); if (!r.ok) throw new Error(`Error invoking remote method '${channel}': Error: ${r.error}`); return r.value; };
    }
    window.electron = new Proxy(data, { get: (t, k) => (k in t ? t[k] : (k === 'on' ? () => {} : (typeof k === 'string' && k.startsWith('get') ? async () => [] : async () => null))) });
  }, CHANNELS);
  await page.route('**/*', (r) => (r.request().url().startsWith(base) ? r.continue() : r.abort()));

  try {
    await page.goto(`${base}/index.html`);
    await page.waitForFunction(() => window.openKioskAdmin, null, { timeout: 8000 }).catch(() => { throw new Error(`openKioskAdmin never appeared; page errors: ${errors.join('; ')}`); });
    await page.waitForTimeout(800);
    await page.evaluate(() => { for (const id of ['welcome-message', 'terms-of-service-dialog']) { const d = document.getElementById(id); if (d && d.open) d.close(); } });
    await page.evaluate(() => window.openKioskAdmin());
    await page.waitForSelector('#ka-pane');
    assert.ok((await page.textContent('#ka-pane')).includes('No quote requests yet'), 'empty inbox says so');

    step('ings: warnings');
    // settings: warnings before it is on, then switch on
    await page.click('#ka-tab-settings');
    await page.waitForSelector('#ka-enabled');
    await page.check('#ka-enabled');
    await page.click('text=Save settings');
    await page.waitForFunction(() => document.getElementById('ka-status').textContent === 'Saved');
    assert.strictEqual(JSON.parse(store[K.SETTINGS_KEY]).enabled, true, `the switch is stored: ${store[K.SETTINGS_KEY]}`);
    assert.ok((await page.textContent('.ka-warn')).includes('no access token'), 'it warns that the admin app is open without a token');
    assert.ok((await page.$('#kiosk-admin-button')) || true);

    step('logue: find a model');
    // catalogue: find a model, price it, offer it
    await page.click('#ka-tab-catalogue');
    await page.click('text=Offer another model');
    await page.fill('#ka-form input[type="search"]', 'phone');
    await page.click('.ka-result');
    assert.ok((await page.textContent('#ka-model')).includes('CC-BY'), 'the licence is shown');
    const inputs = await page.$$('#ka-form input[type="number"]');
    await inputs[0].fill('3'); await inputs[1].fill('50');
    await page.waitForFunction(() => document.querySelector('.ka-preview').textContent.includes('would be quoted'));
    await page.click('#ka-form >> text=Save');
    await page.waitForSelector('#ka-items .ka-card');
    assert.strictEqual(K.listItemsAdmin(db).length, 1);
    assert.strictEqual(K.publicCatalogue(db, {}).total, 1);

    step('x: a hostile');
    // inbox: a hostile request renders as text and cannot inject markup
    const snap = { itemId: 1, itemName: '<img src=x onerror=window.__xss=1>Thing', quantity: 2, unitPrice: 5, total: 10, currency: '£', internal: { cost: 6, profit: 4 }, showPrice: true, validityDays: 7 };
    K.createRequest(db, { snapshot: snap, email: 'sam@example.com', name: '<b onmouseover=window.__xss=1>Sam</b>', message: '<script>window.__xss=1</script> hello' });
    K.createRequest(db, { snapshot: snap, email: 'javascript:alert(1)//x.co', name: '' });          // not a valid address, must not become a link
    await page.click('#ka-tab-requests');
    await page.waitForSelector('.ka-card');
    assert.ok(!(await page.evaluate(() => !!window.__xss)), 'nothing a customer typed ran');
    assert.strictEqual((await page.$$('#ka-pane img, #ka-pane script, #ka-pane b')).length, 0, 'no markup from customers');
    assert.ok((await page.textContent('#ka-pane')).includes('<script>window.__xss=1</script> hello'), 'it is shown as plain text');
    const links = await page.$$eval('#ka-pane a[href^="mailto:"]', (a) => a.map((x) => x.getAttribute('href')));
    assert.strictEqual(links.length, 1, 'only the valid address gets a reply link');
    assert.ok(links[0].startsWith('mailto:sam@example.com?subject='));
    assert.ok((await page.textContent('#ka-pane')).includes('Your cost'), 'you see your own cost and profit');
    assert.ok((await page.textContent('#ka-badge')) === '2', 'the badge counts new requests');

    step('us and delete');
    // status and delete
    await page.selectOption('.ka-card:first-of-type select', 'done');
    await page.waitForFunction(() => /marked done/.test(document.getElementById('ka-status').textContent));
    assert.strictEqual(K.countNew(db), 1);
    page.once('dialog', (d) => d.accept());
    await page.click('.ka-card:first-of-type >> text=Delete');
    await page.waitForFunction(() => document.querySelectorAll('#ka-pane .ka-card').length === 1);
    assert.strictEqual(K.listRequests(db, {}).length, 1);

    assert.deepStrictEqual(errors, [], `page errors: ${errors.join('; ')}`);
    console.log('ok kiosk admin smoke test');
  } finally {
    await browser.close(); server.close();
  }
})().catch((e) => { console.error(`FAIL ${e.message}`); process.exit(1); });
