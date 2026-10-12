/*
 * Browser smoke test for the customer quote page. Runs the real kiosk routes (kiosk-core.js) on a throwaway
 * in-memory library, then drives /kiosk like a customer. Needs Playwright, Chromium and better-sqlite3 built
 * for plain Node, so it isn't part of `npm run test:unit`:   node kiosk.smoke.cjs   (CHROMIUM_PATH picks the browser)
 *
 * What it proves that matters most: the customer flow works end to end, and the customer's browser is left
 * holding nothing (no cookies, no local or session storage, no databases).
 */
'use strict';
const assert = require('assert');
const http = require('http');
const express = require('express');
const Database = require('better-sqlite3');

let chromium;
try { ({ chromium } = require('playwright-core')); } catch (_) {
  try { ({ chromium } = require('playwright')); } catch (__) { console.log('skip: Playwright is not installed'); process.exit(0); }
}
const K = require('./kiosk-core');

const FARM = { currency: '£', electricityRate: 0.25, labourRate: 15, failureRatePct: 10, targetMarginPct: 40,
  printers: { 1: { price: 400, lifetimeHours: 2000, watts: 150, hoursPerMonth: 500 } }, filaments: { 1: { spoolPrice: 20, spoolGrams: 1000 } } };

(async () => {
  const db = new Database(':memory:');
  db.prepare('CREATE TABLE models (id INTEGER PRIMARY KEY AUTOINCREMENT, fileName TEXT, designer TEXT, license TEXT, thumbnail TEXT)').run();
  K.ensureSchema(db);
  // a real, tiny, valid PNG so the <img> loads
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  const add = (n, d) => db.prepare('INSERT INTO models (fileName, designer, license, thumbnail) VALUES (?, ?, ?, ?)').run(n, d, 'CC-BY', png).lastInsertRowid;
  const a = add('Phone stand.stl', 'Acme'); const b = add('Dragon bust.stl', 'Zed'); add('Not offered.stl', 'X');
  K.saveItem(db, { modelId: a, printHours: 3, grams: 50, unitsPerPlate: 1, filamentId: 1, note: 'Fits most phones' });
  K.saveItem(db, { modelId: b, printHours: 6, grams: 120, unitsPerPlate: 1, filamentId: 1 });

  const store = { [K.SETTINGS_KEY]: JSON.stringify({ enabled: true, idleSeconds: 20 }), farmCostConfig: JSON.stringify(FARM) };
  const app = express();
  const created = [];
  K.registerRoutes(app, { getDb: () => db, getSetting: (k) => store[k] ?? null, appDir: __dirname, onNewRequest: (r) => created.push(r) });
  const server = await new Promise((resolve) => { const s = http.createServer(app); s.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;

  const launch = { args: ['--no-sandbox'] };
  if (process.env.CHROMIUM_PATH) launch.executablePath = process.env.CHROMIUM_PATH;
  const browser = await chromium.launch(launch);
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 800 } });
  const page = await ctx.newPage();
  const errors = []; const external = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  page.on('request', (r) => { if (!r.url().startsWith(base)) external.push(r.url()); });
  try {
    await page.goto(`${base}/kiosk`);
    await page.waitForSelector('.k-card');
    assert.strictEqual(await page.textContent('#k-title'), 'Get a print quote');
    await page.waitForFunction(() => [...document.fonts].some((f) => f.family.replace(/["']/g, '') === 'Inter' && f.status === 'loaded'), null, { timeout: 5000 });   // the bundled font arrives from the allowlist
    assert.strictEqual((await page.$$('.k-card')).length, 2, 'only offered items are listed');
    assert.ok(!(await page.textContent('body')).includes('Not offered'));
    assert.ok(await page.evaluate(() => [...document.images].filter((i) => i.closest('.k-card')).every((i) => i.complete && i.naturalWidth > 0)), 'thumbnails load');

    // search
    await page.fill('#k-q', 'dragon'); await page.click('.k-search button[type="submit"]');
    await page.waitForFunction(() => document.querySelectorAll('.k-card').length === 1);
    await page.fill('#k-q', ''); await page.click('.k-search button[type="submit"]');
    await page.waitForFunction(() => document.querySelectorAll('.k-card').length === 2);

    // pick, choose a quantity, get the quote
    await page.click('.k-card:has-text("Phone stand")');
    await page.waitForSelector('#k-qty');
    assert.strictEqual(await page.evaluate(() => document.activeElement.id), 'k-screen-title', 'focus moves to the new screen heading');
    await page.click('button[aria-label="One more"]');
    assert.strictEqual(await page.inputValue('#k-qty'), '2');
    await page.click('text=Get my quote');
    await page.waitForSelector('.k-price');
    const expected = K.computeQuote({ farmConfig: FARM, item: K.offeredItem(db, a), quantity: 2, settings: K.normaliseSettings({}) });
    assert.strictEqual(await page.textContent('.k-price'), `£${expected.total.toFixed(2)}`, 'the page shows the server price');
    assert.ok((await page.textContent('main')).includes('estimate'), 'it says it is an estimate');
    const visible = (await page.textContent('body')).toLowerCase();
    for (const secret of ['profit', 'margin', 'internal']) assert.ok(!visible.includes(secret), `page mentions ${secret}`);

    // email checks, then send
    await page.fill('#k-email', 'not-an-email'); await page.click('text=Send my request');
    await page.waitForSelector('.k-error:not(:empty)');
    assert.ok((await page.textContent('.k-error')).includes('valid email'));
    await page.fill('#k-email', 'sam@example.com'); await page.fill('#k-name', 'Sam'); await page.fill('#k-msg', 'Red please');
    await page.click('text=Send my request');
    await page.waitForSelector('.k-ref');
    const ref = await page.textContent('.k-ref');
    assert.ok(/^Q-[A-Z2-9]{6}$/.test(ref), ref);
    const row = db.prepare('SELECT * FROM quote_requests WHERE reference = ?').get(ref);
    assert.ok(row && row.customer_email === 'sam@example.com' && row.quantity === 2 && row.total_price === expected.total, 'the request reached the back end with the right numbers');
    assert.strictEqual(created.length, 1);

    // the customer's device keeps nothing
    const leftovers = await page.evaluate(async () => ({ local: localStorage.length, session: sessionStorage.length, cookie: document.cookie, dbs: (await indexedDB.databases()).length, caches: (await caches.keys()).length }));
    assert.deepStrictEqual(leftovers, { local: 0, session: 0, cookie: '', dbs: 0, caches: 0 }, JSON.stringify(leftovers));
    assert.deepStrictEqual(await ctx.cookies(), [], 'the server set no cookies');
    assert.deepStrictEqual(external, [], `requests left the server: ${external.join(', ')}`);

    // start again clears the screen; the typed details are gone from the page
    await page.click('text=Start again');
    await page.waitForSelector('.k-card');
    assert.ok(!(await page.content()).includes('sam@example.com'), 'no trace of the customer on the page');

    // idle clear: after the idle time a half-finished order is wiped (the page clock is sped up)
    await page.click('.k-card:has-text("Dragon")'); await page.waitForSelector('#k-qty');
    await page.clock.install({ time: Date.now() }).catch(() => {});
    if (page.clock && page.clock.fastForward) {
      await page.clock.fastForward(30000);
      await page.waitForSelector('.k-card', { timeout: 5000 });
      assert.ok(!(await page.$('#k-qty')), 'a half-finished order is cleared after the idle time');
    }

    assert.deepStrictEqual(errors, [], `page errors: ${errors.join('; ')}`);
    console.log('ok kiosk customer page smoke test');
  } finally {
    await browser.close(); server.close();
  }
})().catch((e) => { console.error(`FAIL ${e.message}`); process.exit(1); });
