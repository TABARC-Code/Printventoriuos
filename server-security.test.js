/*
 * Tests for server-security.js. Real express server, real sockets, no mocks:
 * the whole point of this module is what happens on the wire, so faking the
 * wire would be a bit like testing a lock by describing a door.
 */
'use strict';

const assert = require('assert');
const http = require('http');
const express = require('express');
const WebSocket = require('ws');
const sec = require('./server-security');

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`ok ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL ${name}: ${err && err.message}`);
  }
}

function startServer({ token, allowedOrigins = [] } = {}) {
  const app = express();
  app.use(sec.createOriginPolicy({ allowedOrigins }));
  app.use(sec.createAccessGuard(token));
  app.use(sec.createStaticBlocker());
  app.get('/ping', (req, res) => res.json({ ok: true }));
  app.post('/api/do', express.json(), (req, res) => res.json({ done: true }));
  app.get('/api/helper/bundle', (req, res) => res.json({ bundle: true }));
  app.get('/package-lock.json', (req, res) => res.send('should never be reached'));
  app.get('/index.html', (req, res) => res.send('<html></html>'));
  const server = http.createServer(app);
  const wss = new WebSocket.Server({ server, verifyClient: sec.createWsVerifier({ token, allowedOrigins }) });
  wss.on('connection', (ws) => ws.send('hello'));
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, wss, port: server.address().port }));
  });
}

function request(port, { method = 'GET', path = '/ping', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function wsConnect(port, headers = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers });
    ws.on('message', () => { ws.close(); resolve('open'); });
    ws.on('unexpected-response', (_req, res) => resolve(`rejected:${res.statusCode}`));
    ws.on('error', () => resolve('error'));
  });
}

(async () => {
  await test('isOriginAllowed: no origin, same host, extension, other site, null, garbage', () => {
    assert.ok(sec.isOriginAllowed(undefined, 'localhost:5000'));
    assert.ok(sec.isOriginAllowed('http://localhost:5000', 'localhost:5000'));
    assert.ok(sec.isOriginAllowed('chrome-extension://abcdef', 'localhost:5000'));
    assert.ok(!sec.isOriginAllowed('https://evil.example', 'localhost:5000'));
    assert.ok(!sec.isOriginAllowed('http://localhost:5001', 'localhost:5000'));
    assert.ok(!sec.isOriginAllowed('null', 'localhost:5000'));
    assert.ok(!sec.isOriginAllowed('not a url', 'localhost:5000'));
    assert.ok(sec.isOriginAllowed('https://tools.example/', 'localhost:5000', ['https://tools.example']));
  });

  await test('validateToken refuses short tokens and accepts empty (feature off)', () => {
    assert.strictEqual(sec.validateToken(''), null);
    assert.strictEqual(sec.validateToken(undefined), null);
    assert.throws(() => sec.validateToken('password'), /at least 16/);
    assert.strictEqual(sec.validateToken('a'.repeat(24)), 'a'.repeat(24));
  });

  await test('isBlockedStaticPath blocks secrets and scaffolding, leaves app files', () => {
    for (const p of ['/package-lock.json', '/node_modules/x/index.js', '/tests/printventory.db', '/scripts/a.sh', '/Dockerfile', '/.github/workflows/a.yml', '/a.db', '/%2e%2e/%2e%2e/x.env']) {
      assert.ok(sec.isBlockedStaticPath(p), p);
    }
    for (const p of ['/', '/index.html', '/renderer.js', '/styles.css', '/logo.png', '/sw.js']) {
      assert.ok(!sec.isBlockedStaticPath(p), p);
    }
  });

  const open = await startServer();
  await test('no token: normal requests, same-origin POST and no-origin clients still work', async () => {
    assert.strictEqual((await request(open.port)).status, 200);
    const same = await request(open.port, { method: 'POST', path: '/api/do', headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${open.port}` }, body: '{}' });
    assert.strictEqual(same.status, 200);
    assert.strictEqual(await wsConnect(open.port), 'open');
  });

  await test('cross-site request is refused, simple POST included', async () => {
    const r = await request(open.port, { method: 'POST', path: '/api/do', headers: { 'Content-Type': 'text/plain', Origin: 'https://evil.example' }, body: '{}' });
    assert.strictEqual(r.status, 403);
    assert.ok(!r.headers['access-control-allow-origin']);
  });

  await test('cross-site WebSocket is refused (the original hole)', async () => {
    const result = await wsConnect(open.port, { Origin: 'https://evil.example' });
    assert.ok(result.startsWith('rejected:') || result === 'error', result);
    assert.notStrictEqual(result, 'open');
  });

  await test('CORS reflects the allowed origin instead of *', async () => {
    const r = await request(open.port, { headers: { Origin: `http://127.0.0.1:${open.port}` } });
    assert.strictEqual(r.headers['access-control-allow-origin'], `http://127.0.0.1:${open.port}`);
    assert.strictEqual(r.headers.vary, 'Origin');
    const pre = await request(open.port, { method: 'OPTIONS', headers: { Origin: 'chrome-extension://abc' } });
    assert.strictEqual(pre.status, 204);
  });

  await test('static blocker hides repo files but leaves /api/helper/bundle alone', async () => {
    assert.strictEqual((await request(open.port, { path: '/package-lock.json' })).status, 404);
    assert.strictEqual((await request(open.port, { path: '/index.html' })).status, 200);
    assert.strictEqual((await request(open.port, { path: '/api/helper/bundle' })).status, 200);
  });

  const TOKEN = 'correct-horse-battery-staple-123';
  const locked = await startServer({ token: TOKEN });
  await test('token set: requests without it get 401, wrong token too', async () => {
    assert.strictEqual((await request(locked.port)).status, 401);
    assert.strictEqual((await request(locked.port, { headers: { Authorization: 'Bearer nope-nope-nope-nope' } })).status, 401);
    assert.strictEqual(await wsConnect(locked.port), 'rejected:401');
  });

  await test('token set: Bearer header works for HTTP and WebSocket', async () => {
    assert.strictEqual((await request(locked.port, { headers: { Authorization: `Bearer ${TOKEN}` } })).status, 200);
    assert.strictEqual(await wsConnect(locked.port, { Authorization: `Bearer ${TOKEN}` }), 'open');
  });

  await test('token set: ?token= sets an HttpOnly cookie, redirects without the token, and the cookie then works', async () => {
    const first = await request(locked.port, { path: `/ping?token=${TOKEN}&x=1`, headers: { Accept: 'text/html' } });
    assert.strictEqual(first.status, 302);
    assert.strictEqual(first.headers.location, '/ping?x=1');
    const cookie = String(first.headers['set-cookie']);
    assert.ok(/HttpOnly/.test(cookie) && /SameSite=Strict/.test(cookie));
    const jar = cookie.split(';')[0];
    assert.strictEqual((await request(locked.port, { headers: { Cookie: jar } })).status, 200);
    assert.strictEqual(await wsConnect(locked.port, { Cookie: jar }), 'open');
  });

  await test('token set: a wrong ?token= is not accepted', async () => {
    const r = await request(locked.port, { path: '/ping?token=wrong-wrong-wrong-wrong', headers: { Accept: 'text/html' } });
    assert.strictEqual(r.status, 401);
    assert.ok(/Access token required/.test(r.body));
  });

  open.wss.close(); open.server.close();
  locked.wss.close(); locked.server.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
