'use strict';
// Checks the arrangement main.js relies on: the public customer routes sit BEFORE the admin access guard and
// the 50 MB body parser, while everything else stays behind the guard. Built the same way main.js builds it.
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const express = require('express');
const Database = require('better-sqlite3');
const sec = require('./server-security');
const K = require('./kiosk-core');

let passed = 0, failed = 0;
async function test(name, fn) { try { await fn(); passed++; console.log(`ok ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}: ${e && e.message}`); } }

const TOKEN = 'correct-horse-battery-staple-123';
const FARM = { currency: '£', printers: { 1: { price: 400, lifetimeHours: 2000, watts: 150, hoursPerMonth: 500 } }, filaments: { 1: { spoolPrice: 20, spoolGrams: 1000 } } };

function req(port, { method = 'GET', p, body, headers = {} }) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: { ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}), ...headers } }, (res) => {
      let raw = ''; res.on('data', (c) => (raw += c)); res.on('end', () => { let json = null; try { json = JSON.parse(raw); } catch (_) {} resolve({ status: res.statusCode, json, raw }); });
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}

(async () => {
  const db = new Database(':memory:');
  db.prepare('CREATE TABLE models (id INTEGER PRIMARY KEY AUTOINCREMENT, fileName TEXT, designer TEXT, license TEXT, thumbnail TEXT)').run();
  K.ensureSchema(db);
  const id = db.prepare("INSERT INTO models (fileName, designer) VALUES ('Thing.stl', 'A')").run().lastInsertRowid;
  K.saveItem(db, { modelId: id, printHours: 2, grams: 30, filamentId: 1 });
  const store = { [K.SETTINGS_KEY]: JSON.stringify({ enabled: true }), farmCostConfig: JSON.stringify(FARM) };

  // same order as startHttpServer in main.js
  const app = express();
  app.use(sec.createOriginPolicy({ allowedOrigins: [] }));
  K.registerRoutes(app, { getDb: () => db, getSetting: (k) => store[k] ?? null, appDir: __dirname });
  app.use(sec.createAccessGuard(TOKEN));
  app.use(sec.createStaticBlocker());
  app.use(express.json({ limit: '50mb' }));
  app.get('/api/admin-thing', (req, res) => res.json({ secret: 'library contents' }));
  app.post('/api/admin-upload', (req, res) => res.json({ got: JSON.stringify(req.body).length }));
  const server = await new Promise((r) => { const s = http.createServer(app); s.listen(0, '127.0.0.1', () => r(s)); });
  const port = server.address().port;

  await test('customers reach the quote page without the admin token', async () => {
    assert.strictEqual((await req(port, { p: '/api/kiosk/config' })).status, 200);
    assert.strictEqual((await req(port, { p: '/api/kiosk/catalogue' })).json.total, 1);
    const q = await req(port, { method: 'POST', p: '/api/kiosk/quote', body: { itemId: id, quantity: 1 } });
    assert.strictEqual(q.status, 200);
  });

  await test('the same customer cannot reach anything else without the token', async () => {
    assert.strictEqual((await req(port, { p: '/api/admin-thing' })).status, 401);
    assert.strictEqual((await req(port, { method: 'POST', p: '/api/admin-upload', body: { a: 1 } })).status, 401);
    assert.strictEqual((await req(port, { p: '/api/kiosk/../admin-thing' })).status, 401);          // a path trick under /kiosk doesn't get through
    assert.strictEqual((await req(port, { p: '/api/kiosk/anything-else' })).status, 401);          // unknown kiosk paths fall to the guard, not to an open handler
    assert.strictEqual((await req(port, { p: '/api/admin-thing', headers: { Authorization: `Bearer ${TOKEN}` } })).status, 200);
  });

  await test('kiosk bodies are capped at 8 KB even though the admin parser would take 50 MB', async () => {
    const big = { itemId: id, quantity: 1, pad: 'x'.repeat(60000) };
    assert.strictEqual((await req(port, { method: 'POST', p: '/api/kiosk/quote', body: big })).status, 413);
    assert.strictEqual((await req(port, { method: 'POST', p: '/api/admin-upload', body: big, headers: { Authorization: `Bearer ${TOKEN}` } })).status, 200);
  });

  await test('a web page on another site cannot post to the quote page from a visitor\'s browser', async () => {
    const r = await req(port, { method: 'POST', p: '/api/kiosk/quote', body: { itemId: id, quantity: 1 }, headers: { Origin: 'https://evil.example' } });
    assert.strictEqual(r.status, 403);
  });

  await test('main.js still mounts things in that order', () => {
    const src = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
    const at = (needle) => { const i = src.indexOf(needle); assert.ok(i > 0, `${needle} not found in main.js`); return i; };
    const origin = at('serverSecurity.createOriginPolicy');
    const kiosk = at('kioskCore.registerRoutes(expressApp');
    const guard = at('serverSecurity.createAccessGuard');
    const parser = at("expressApp.use(express.json({ limit: '50mb' }))");
    assert.ok(origin < kiosk && kiosk < guard && guard < parser, 'order must be: origin policy, kiosk routes, access guard, 50 MB parser');
  });

  await test('main.js wires the admin handlers, the schema and the purge', () => {
    const src = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
    for (const needle of ['kioskCore.registerAdminIpc(ipcMain', 'kioskCore.ensureSchema(db)', 'purgeKioskRequests()']) assert.ok(src.includes(needle), `${needle} missing`);
  });

  server.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
