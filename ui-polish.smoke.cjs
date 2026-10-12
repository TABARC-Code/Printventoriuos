/*
 * Browser smoke test for ui-polish.js (accent text colour, scroll regions, empty
 * states). Like farm-cost-ui.smoke.cjs it needs Playwright and a Chromium, so it
 * isn't part of `npm run test:unit`:   node ui-polish.smoke.cjs
 * Set CHROMIUM_PATH to use an existing browser.
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
  const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => {
    const data = { getSetting: async () => null, saveSetting: async () => true, getAllPrinters: async () => [], getAllFilaments: async () => [], getPrintOutcomeStats: async () => [] };
    window.electron = new Proxy(data, { get: (t, k) => (k in t ? t[k] : (k === 'on' ? () => {} : async () => null)) });
  });
  await page.route('**/*', (r) => (r.request().url().startsWith(base) ? r.continue() : r.abort()));
  try {
    await page.goto(`${base}/index.html`);
    await page.waitForFunction(() => window.UiPolish);
    await page.evaluate(() => { const d = document.getElementById('terms-of-service-dialog'); if (d && d.open) d.close(); });

    // 1. accent text
    const text = () => page.evaluate(() => document.documentElement.style.getPropertyValue('--primary-accent-text'));
    assert.strictEqual(await text(), '#07121a', 'dark text on the default cyan');
    assert.strictEqual(await page.evaluate(() => getComputedStyle(document.getElementById('scan-directory-button')).color), 'rgb(7, 18, 26)');
    await page.evaluate(() => { document.documentElement.style.setProperty('--primary-accent', '#14287a'); document.documentElement.style.setProperty('--primary-accent-hover', '#1e3ca0'); });
    await page.waitForFunction(() => document.documentElement.style.getPropertyValue('--primary-accent-text') === '#ffffff');

    // 2. empty library
    await page.waitForSelector('#library-empty-state:not([hidden])', { timeout: 4000 });
    assert.strictEqual(await page.textContent('#les-title'), 'Your library is empty');
    await page.evaluate(() => { window.__scanClicks = 0; document.getElementById('scan-directory-button').addEventListener('click', () => window.__scanClicks++); });
    await page.click('#les-primary');
    assert.strictEqual(await page.evaluate(() => window.__scanClicks), 1, 'the button starts a scan');

    // 3. filters that match nothing
    await page.evaluate(() => { document.getElementById('total-count').textContent = '1,250 models total'; });
    await page.waitForFunction(() => document.getElementById('les-title').textContent === 'Nothing matches these filters', null, { timeout: 4000 });
    assert.ok((await page.textContent('#les-text')).includes('1,250'));

    // 4. something to show, so the message goes away
    await page.evaluate(() => { document.getElementById('view-count').textContent = '12 models in view'; });
    await page.waitForSelector('#library-empty-state', { state: 'hidden', timeout: 4000 });

    // 5. scrollable regions are reachable by keyboard
    await page.evaluate(() => {
      const d = document.createElement('dialog'); d.id = 'scroll-test';
      d.innerHTML = '<h3>Long text</h3><div id="long" style="height:60px;overflow:auto"><div style="height:400px">text</div></div>';
      document.body.append(d); d.showModal();
    });
    await page.waitForFunction(() => document.getElementById('long').getAttribute('tabindex') === '0', null, { timeout: 3000 });
    assert.ok((await page.getAttribute('#long', 'aria-label')).startsWith('Long text'));

    assert.deepStrictEqual(errors, [], `page errors: ${errors.join('; ')}`);
    console.log('ok ui polish smoke test');
  } finally {
    await browser.close();
    server.close();
  }
})().catch((e) => { console.error(`FAIL ${e.message}`); process.exit(1); });
