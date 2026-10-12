'use strict';
// Needs better-sqlite3 built for plain Node (npm rebuild better-sqlite3), as the other database tests do.
const assert = require('assert');
const http = require('http');
const express = require('express');
const Database = require('better-sqlite3');
const K = require('./kiosk-core');
const FarmCost = require('./farm-cost-lib');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`ok ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}: ${e && e.message}`); }
}

const FARM = { currency: '£', electricityRate: 0.25, labourRate: 15, failureRatePct: 10, targetMarginPct: 40,
  printers: { 1: { price: 400, lifetimeHours: 2000, watts: 150, hoursPerMonth: 500 } }, filaments: { 1: { spoolPrice: 20, spoolGrams: 1000 } } };

function makeDb() {
  const db = new Database(':memory:');
  db.prepare('CREATE TABLE models (id INTEGER PRIMARY KEY AUTOINCREMENT, fileName TEXT, designer TEXT, license TEXT, thumbnail TEXT)').run();
  K.ensureSchema(db);
  const png = 'data:image/png;base64,iVBORw0KGgo=';
  const add = (name, designer) => db.prepare('INSERT INTO models (fileName, designer, license, thumbnail) VALUES (?, ?, ?, ?)').run(name, designer, '', png).lastInsertRowid;
  return { db, add };
}

function startApp({ settings = { enabled: true }, farm = FARM, db, extra = {} }) {
  const store = { [K.SETTINGS_KEY]: JSON.stringify(settings) };
  if (farm) store.farmCostConfig = JSON.stringify(farm);
  const app = express();
  const created = [];
  K.registerRoutes(app, { getDb: () => db, getSetting: (k) => store[k] ?? null, appDir: __dirname, onNewRequest: (r) => created.push(r), ...extra });
  // the real app has this catch-all later; kiosk routes must not depend on it
  app.use((req, res) => res.status(418).json({ fallthrough: true }));
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => resolve({ server, store, created, port: server.address().port }));
  });
}
function call(port, { method = 'GET', path: p, body, headers = {} }) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: { ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}), ...headers } }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c));
      res.on('end', () => { const raw = Buffer.concat(chunks); let json = null; try { json = JSON.parse(raw.toString()); } catch (_) {} resolve({ status: res.statusCode, headers: res.headers, json, raw }); });
    });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}

(async () => {
  await test('settings: defaults off, rubbish clamped, values kept', () => {
    assert.strictEqual(K.normaliseSettings(null).enabled, false);
    assert.strictEqual(K.normaliseSettings({ enabled: 'yes' }).enabled, false);     // only a real true switches it on
    const s = K.normaliseSettings({ enabled: true, validityDays: 9999, idleSeconds: 1, retentionDays: -4, title: '  Shop  ' });
    assert.strictEqual(s.validityDays, 90); assert.strictEqual(s.idleSeconds, 20); assert.strictEqual(s.retentionDays, 1); assert.strictEqual(s.title, 'Shop');
  });

  await test('pricingReady refuses placeholder setups and accepts real ones', () => {
    assert.strictEqual(K.pricingReady(null).ok, false);
    assert.strictEqual(K.pricingReady({ printers: {}, filaments: {} }).ok, false);
    assert.strictEqual(K.pricingReady({ printers: { 1: { price: 0 } }, filaments: { 1: { spoolPrice: 20 } } }).ok, false);
    assert.strictEqual(K.pricingReady({ printers: { 1: { price: 300 } }, filaments: {} }).ok, false);
    assert.strictEqual(K.pricingReady(FARM).ok, true);
  });

  await test('quote equals the calculator, charges whole plates, and keeps cost internal', () => {
    const item = { print_hours: 3, grams: 50, units_per_plate: 4, filament_id: 1 };
    const q = K.computeQuote({ farmConfig: FARM, item, quantity: 3, settings: K.normaliseSettings({}) });
    const direct = FarmCost.computeJob(FARM, { printHours: 3, plates: 1, unitsPerPlate: 4, filaments: [{ grams: 50, filamentId: 1 }], setupMinutes: 5, pricing: { mode: 'margin' } });
    assert.ok(q.ok);
    assert.ok(Math.abs(q.total - Math.round(direct.revenue * 100) / 100) < 0.011, `${q.total} vs ${direct.revenue}`);   // one whole plate, for 3 requested
    assert.ok(Math.abs(q.unitPrice - q.total / 3) < 0.006);
    assert.ok(q.internal.cost > 0 && q.internal.profit > 0);
  });

  await test('quote: minimum charge, bad quantity, unpriced filament, missing setup', () => {
    const item = { print_hours: 0.1, grams: 1, units_per_plate: 1, filament_id: 1 };
    assert.strictEqual(K.computeQuote({ farmConfig: FARM, item, quantity: 1, settings: K.normaliseSettings({ minimumCharge: 5 }) }).total, 5);
    assert.strictEqual(K.computeQuote({ farmConfig: FARM, item, quantity: 0, settings: K.normaliseSettings({}) }).ok, false);
    assert.strictEqual(K.computeQuote({ farmConfig: FARM, item: { ...item, filament_id: 9 }, quantity: 1, settings: K.normaliseSettings({}) }).ok, false);
    assert.strictEqual(K.computeQuote({ farmConfig: null, item, quantity: 1, settings: K.normaliseSettings({}) }).ok, false);
  });

  await test('saveItem validates, upserts, and the catalogue shows only enabled items with no internals', () => {
    const { db, add } = makeDb();
    const a = add('Dragon bust.stl', 'Acme'); const b = add('Secret thing.stl', 'Zed');
    assert.throws(() => K.saveItem(db, { modelId: 999, printHours: 1, grams: 1 }), /no longer exists/);
    assert.throws(() => K.saveItem(db, { modelId: a, printHours: 0, grams: 10 }), /Print time/);
    assert.throws(() => K.saveItem(db, { modelId: a, printHours: 2, grams: -1 }), /weight/);
    K.saveItem(db, { modelId: a, printHours: 2, grams: 30, unitsPerPlate: 2, filamentId: 1, note: 'Painted by hand' });
    K.saveItem(db, { modelId: a, printHours: 2.5, grams: 35, title: 'Dragon bust (large)' });          // upsert
    K.saveItem(db, { modelId: b, printHours: 1, grams: 10, enabled: false });
    const cat = K.publicCatalogue(db, {});
    assert.strictEqual(cat.total, 1);
    assert.deepStrictEqual(Object.keys(cat.items[0]).sort(), ['designer', 'id', 'name', 'note']);
    assert.strictEqual(cat.items[0].name, 'Dragon bust (large)');
    assert.strictEqual(K.publicCatalogue(db, { q: 'zzz' }).total, 0);
    assert.strictEqual(K.publicCatalogue(db, { q: 'acme' }).total, 1);          // designer credit is searchable
    assert.strictEqual(K.publicCatalogue(db, { q: "%'; DROP TABLE models;--" }).total, 0);
    assert.ok(db.prepare('SELECT COUNT(*) AS n FROM models').get().n === 2);
    assert.strictEqual(K.offeredItem(db, b), null);
  });

  await test('reference numbers avoid look-alike characters', () => {
    for (let i = 0; i < 200; i++) assert.ok(/^Q-[A-HJ-NP-Z2-9]{6}$/.test(K.newReference()));
  });

  await test('submission validation', () => {
    assert.strictEqual(K.validateSubmission({ email: 'not an email' }).ok, false);
    assert.strictEqual(K.validateSubmission({ email: 'a@b' }).ok, false);
    assert.strictEqual(K.validateSubmission({ email: 'x@y.com<script>' }).ok, false);
    assert.strictEqual(K.validateSubmission({}).ok, false);
    const v = K.validateSubmission({ email: ' sam@example.co.uk ', name: 'S'.repeat(500), message: 'hi' });
    assert.ok(v.ok); assert.strictEqual(v.email, 'sam@example.co.uk'); assert.strictEqual(v.name.length, 80);
  });

  await test('quote store: single use and expiry', () => {
    let t = 1000; const store = K.createQuoteStore({ ttlMs: 100, now: () => t });
    const id = store.put({ a: 1 });
    assert.deepStrictEqual(store.take(id), { a: 1 });
    assert.strictEqual(store.take(id), null);                  // used
    const id2 = store.put({ a: 2 }); t += 200;
    assert.strictEqual(store.take(id2), null);                 // expired
    assert.strictEqual(store.take('nonsense'), null); assert.strictEqual(store.take(undefined), null);
  });

  await test('rate limiter', () => {
    let t = 0; const rl = K.createRateLimiter({ windowMs: 1000, max: 2, now: () => t });
    assert.ok(rl.hit('a').allowed); assert.ok(rl.hit('a').allowed);
    const blocked = rl.hit('a'); assert.ok(!blocked.allowed && blocked.retryAfter >= 1);
    assert.ok(rl.hit('b').allowed);                            // other devices unaffected
    t = 1500; assert.ok(rl.hit('a').allowed);
  });

  await test('inbox: create, list, update, count, delete, purge', () => {
    const { db } = makeDb();
    const snap = { itemId: 1, itemName: 'Thing', quantity: 2, unitPrice: 5, total: 10, currency: '£', internal: { cost: 6, profit: 4 }, showPrice: true, validityDays: 7 };
    const r1 = K.createRequest(db, { snapshot: snap, email: 'a@b.co', name: 'A', message: 'm', now: new Date('2026-01-01T00:00:00Z') });
    const r2 = K.createRequest(db, { snapshot: snap, email: 'c@d.co', now: new Date('2026-06-01T00:00:00Z') });
    assert.strictEqual(r1.valid_until.slice(0, 10), '2026-01-08');
    assert.strictEqual(K.countNew(db), 2);
    assert.ok(K.updateRequest(db, r1.id, 'done')); assert.strictEqual(K.countNew(db), 1);
    assert.throws(() => K.updateRequest(db, r1.id, 'weird'), /status/);
    assert.strictEqual(K.listRequests(db, { status: 'done' }).length, 1);
    assert.strictEqual(K.purgeOld(db, 180, new Date('2026-07-01T00:00:00Z')), 1);     // the January one is older than 180 days
    assert.strictEqual(K.listRequests(db, {}).length, 1);
    assert.ok(K.deleteRequest(db, r2.id)); assert.strictEqual(K.listRequests(db, {}).length, 0);
  });

  // ---------- over HTTP ----------
  const { db, add } = makeDb();
  const item = add('Phone stand.stl', 'Acme');
  K.saveItem(db, { modelId: item, printHours: 3, grams: 50, unitsPerPlate: 1, filamentId: 1 });

  await test('off by default: every kiosk URL answers 404 and nothing leaks', async () => {
    const { server, port } = await startApp({ settings: {}, db });
    for (const p of ['/kiosk', '/kiosk/app.js', '/api/kiosk/config', '/api/kiosk/catalogue']) assert.strictEqual((await call(port, { path: p })).status, 404, p);
    assert.strictEqual((await call(port, { method: 'POST', path: '/api/kiosk/quote', body: { itemId: item, quantity: 1 } })).status, 404);
    server.close();
  });

  await test('only the exact allowlisted assets exist under /kiosk, and no cookies are ever set', async () => {
    const { server, port } = await startApp({ db });
    for (const p of ['/kiosk/package.json', '/kiosk/../package.json', '/kiosk/main.js', '/kiosk/fonts/../../main.js', '/kiosk/app.js.map']) {
      const r = await call(port, { path: p }); assert.ok(r.status === 418 || r.status === 404, `${p} -> ${r.status}`);
      assert.ok(!/require\(|ipcMain/.test(r.raw.toString()), `${p} leaked source`);
    }
    for (const p of ['/api/kiosk/config', '/api/kiosk/catalogue', `/api/kiosk/thumb/${item}`]) {
      const r = await call(port, { path: p }); assert.strictEqual(r.status, 200, p);
      assert.ok(!r.headers['set-cookie'], `${p} set a cookie`);
      assert.ok(/no-store|max-age/.test(r.headers['cache-control']));
    }
    server.close();
  });

  await test('catalogue, thumbnails and quote over HTTP; the price matches the calculator', async () => {
    const { server, port } = await startApp({ db });
    const cat = await call(port, { path: '/api/kiosk/catalogue?q=phone' });
    assert.strictEqual(cat.json.total, 1); assert.strictEqual(cat.json.items[0].name, 'Phone stand');
    const thumb = await call(port, { path: `/api/kiosk/thumb/${item}` });
    assert.strictEqual(thumb.headers['content-type'], 'image/png');
    assert.strictEqual((await call(port, { path: '/api/kiosk/thumb/99999' })).status, 404);
    const q = await call(port, { method: 'POST', path: '/api/kiosk/quote', body: { itemId: item, quantity: 2 } });
    assert.strictEqual(q.status, 200);
    const expect = K.computeQuote({ farmConfig: FARM, item: K.offeredItem(db, item), quantity: 2, settings: K.normaliseSettings({}) });
    assert.strictEqual(q.json.total, expect.total);
    assert.ok(/^[0-9a-f]{32}$/.test(q.json.quoteId));
    const wire = JSON.stringify(q.json).toLowerCase();
    for (const secret of ['internal', 'cost', 'profit', 'margin']) assert.ok(!wire.includes(secret), `quote response mentions ${secret}`);
    server.close();
  });

  await test('hidden-price mode: the customer gets a reference but no money figures', async () => {
    const { server, port } = await startApp({ settings: { enabled: true, showPrice: false }, db });
    const q = await call(port, { method: 'POST', path: '/api/kiosk/quote', body: { itemId: item, quantity: 1 } });
    assert.strictEqual(q.status, 200); assert.strictEqual(q.json.total, undefined); assert.strictEqual(q.json.unitPrice, undefined);
    assert.strictEqual(q.json.showPrice, false);
    server.close();
  });

  await test('unconfigured pricing refuses to quote', async () => {
    const { server, port } = await startApp({ db, farm: null });
    const q = await call(port, { method: 'POST', path: '/api/kiosk/quote', body: { itemId: item, quantity: 1 } });
    assert.strictEqual(q.status, 422); assert.ok(/not set up/.test(q.json.error));
    assert.strictEqual((await call(port, { path: '/api/kiosk/config' })).json.ready, false);
    server.close();
  });

  await test('bad input to /quote: unknown item, bad quantity, junk body, oversized body', async () => {
    const { server, port } = await startApp({ db });
    assert.strictEqual((await call(port, { method: 'POST', path: '/api/kiosk/quote', body: { itemId: 12345, quantity: 1 } })).status, 404);
    assert.strictEqual((await call(port, { method: 'POST', path: '/api/kiosk/quote', body: { itemId: item, quantity: -3 } })).status, 422);
    assert.strictEqual((await call(port, { method: 'POST', path: '/api/kiosk/quote', body: { itemId: item, quantity: 'lots' } })).status, 422);
    assert.strictEqual((await call(port, { method: 'POST', path: '/api/kiosk/quote', body: '{not json' })).status, 400);
    assert.strictEqual((await call(port, { method: 'POST', path: '/api/kiosk/quote', body: { itemId: item, quantity: 1, pad: 'x'.repeat(20000) } })).status, 413);
    server.close();
  });

  await test('submit: stores the request with your internal numbers, once, and notifies', async () => {
    const hooks = [];
    const hit = await new Promise((resolve) => { const s = http.createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { hooks.push(JSON.parse(b)); res.end('ok'); }); }); s.listen(0, '127.0.0.1', () => resolve(s)); });
    const { server, port, created } = await startApp({ settings: { enabled: true, webhookUrl: `http://127.0.0.1:${hit.address().port}/hook` }, db });
    const q = (await call(port, { method: 'POST', path: '/api/kiosk/quote', body: { itemId: item, quantity: 2 } })).json;
    const bad = await call(port, { method: 'POST', path: '/api/kiosk/submit', body: { quoteId: q.quoteId, email: 'nope' } });
    assert.strictEqual(bad.status, 422);
    const ok = await call(port, { method: 'POST', path: '/api/kiosk/submit', body: { quoteId: q.quoteId, email: 'sam@example.com', name: 'Sam', message: 'Red please' } });
    assert.strictEqual(ok.status, 200); assert.ok(/^Q-/.test(ok.json.reference));
    const row = db.prepare('SELECT * FROM quote_requests WHERE reference = ?').get(ok.json.reference);
    assert.strictEqual(row.customer_email, 'sam@example.com'); assert.strictEqual(row.quantity, 2); assert.strictEqual(row.total_price, q.total);
    assert.ok(row.internal_cost > 0 && row.internal_profit > 0);
    assert.strictEqual(created.length, 1);
    for (let i = 0; i < 40 && !hooks.length; i++) await new Promise((r) => setTimeout(r, 25));
    assert.strictEqual(hooks.length, 1); assert.ok(hooks[0].content.includes(ok.json.reference)); assert.strictEqual(hooks[0].email, 'sam@example.com');
    const again = await call(port, { method: 'POST', path: '/api/kiosk/submit', body: { quoteId: q.quoteId, email: 'sam@example.com' } });
    assert.strictEqual(again.status, 410);                                  // single use
    server.close(); hit.close();
  });

  await test('submit: the price cannot be changed by the customer', async () => {
    const { server, port } = await startApp({ db });
    const q = (await call(port, { method: 'POST', path: '/api/kiosk/quote', body: { itemId: item, quantity: 1 } })).json;
    const r = await call(port, { method: 'POST', path: '/api/kiosk/submit', body: { quoteId: q.quoteId, email: 'a@b.co', total: 0.01, unitPrice: 0.01, quantity: 99, internal: { cost: 0 } } });
    const row = db.prepare('SELECT * FROM quote_requests WHERE reference = ?').get(r.json.reference);
    assert.strictEqual(row.total_price, q.total); assert.strictEqual(row.quantity, 1);
    assert.strictEqual((await call(port, { method: 'POST', path: '/api/kiosk/submit', body: { quoteId: 'a'.repeat(32), email: 'a@b.co' } })).status, 410);   // invented id
    server.close();
  });

  await test('submit: honeypot gets a convincing reply and stores nothing', async () => {
    const { server, port } = await startApp({ db });
    const before = db.prepare('SELECT COUNT(*) AS n FROM quote_requests').get().n;
    const q = (await call(port, { method: 'POST', path: '/api/kiosk/quote', body: { itemId: item, quantity: 1 } })).json;
    const r = await call(port, { method: 'POST', path: '/api/kiosk/submit', body: { quoteId: q.quoteId, email: 'bot@spam.co', website: 'http://spam' } });
    assert.strictEqual(r.status, 200); assert.ok(/^Q-/.test(r.json.reference));
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM quote_requests').get().n, before);
    server.close();
  });

  await test('rate limits: submissions and quotes are capped per device', async () => {
    const { server, port } = await startApp({ db });
    let last;
    for (let i = 0; i < 6; i++) last = await call(port, { method: 'POST', path: '/api/kiosk/submit', body: { quoteId: 'x', email: 'a@b.co' } });
    assert.strictEqual(last.status, 429); assert.ok(last.headers['retry-after']);
    let q; for (let i = 0; i < 62; i++) q = await call(port, { method: 'POST', path: '/api/kiosk/quote', body: { itemId: item, quantity: 1 } });
    assert.strictEqual(q.status, 429);
    server.close();
  });

  await test('webhook: https only (plain http allowed to this machine), failures are reported not thrown', async () => {
    assert.strictEqual((await K.sendWebhook('http://example.com/x', {})).ok, false);
    assert.strictEqual((await K.sendWebhook('ftp://example.com/x', {})).ok, false);
    assert.strictEqual((await K.sendWebhook('not a url', {})).ok, false);
    assert.strictEqual((await K.sendWebhook('http://127.0.0.1:1/', {}, { timeoutMs: 500 })).ok, false);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
