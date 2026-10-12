/*
 * kiosk-core.js
 *
 * The customer-facing "get a quote" service. A customer picks something from the
 * catalogue, gets a price, leaves an email address, and the request lands in the
 * Quote requests inbox in the app (and optionally a webhook). That's all it does.
 *
 * The rules this was built to, in order of importance:
 *
 *  1. It is NOT the admin interface with buttons hidden. The admin app talks over a
 *     WebSocket that can delete files and change settings. The customer page never
 *     touches that. It has five small HTTP endpoints of its own, and nothing else
 *     behind them. If every kiosk route had a bug, the worst case is a junk quote
 *     request, not a deleted library.
 *  2. Off by default. Nothing here answers until you switch it on.
 *  3. The server works out the price. The customer's screen only shows it. Quotes
 *     live in server memory for a short while and the browser holds just an opaque
 *     id, so there is no price in the page to tamper with and no cost or margin
 *     anywhere a customer could read it.
 *  4. The customer's device keeps nothing: no cookies, no local storage, no session.
 *     The server sets no cookies either. What you keep on your side (their email,
 *     the quote) is deleted after a retention period you choose.
 *  5. Refuse to quote on placeholder numbers. If the calculator hasn't been set up
 *     with real printer and filament prices, the kiosk says so instead of quoting
 *     0.25 per kWh fantasy money to a member of the public.
 *
 * Not here, on purpose: payment, customer uploads, accounts. Each of those turns a
 * quote form into a different (and much more serious) piece of software.
 *
 * Wishlist: an email sent straight from here. It needs SMTP credentials stored
 * somewhere safe, and I'd rather ship the webhook and the inbox than a half-secure
 * mailer. The inbox does give you a one-click "reply by email" link in the meantime.
 */
'use strict';

const crypto = require('crypto');
const http = require('http');
const https = require('https');
const path = require('path');
const FarmCost = require('./farm-cost-lib');

const SETTINGS_KEY = 'kioskSettings';
const FARM_CONFIG_KEY = 'farmCostConfig';

const DEFAULT_SETTINGS = Object.freeze({
  enabled: false,
  showPrice: true,          // false: customer is told you'll email a quote, price goes to you only
  validityDays: 7,
  minimumCharge: 0,
  idleSeconds: 120,         // the customer page clears itself after this long untouched
  retentionDays: 180,       // requests older than this are deleted
  webhookUrl: '',
  title: 'Get a print quote',
  intro: 'Choose something from the catalogue and we will price it for you.',
  privacy: 'We use your email address only to reply about this quote. This screen stores nothing about you.'
});

// ---------- settings ----------
function clampInt(v, min, max, fallback) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}
const text = (v, max, fallback = '') => (typeof v === 'string' ? v.trim().slice(0, max) : fallback);

function normaliseSettings(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const d = DEFAULT_SETTINGS;
  return {
    enabled: r.enabled === true,
    showPrice: r.showPrice === undefined ? d.showPrice : r.showPrice === true,
    validityDays: clampInt(r.validityDays, 1, 90, d.validityDays),
    minimumCharge: Math.max(0, Math.min(10000, Number(r.minimumCharge) || 0)),
    idleSeconds: clampInt(r.idleSeconds, 20, 1800, d.idleSeconds),
    retentionDays: clampInt(r.retentionDays, 1, 3650, d.retentionDays),
    webhookUrl: text(r.webhookUrl, 500),
    title: text(r.title, 80, d.title) || d.title,
    intro: text(r.intro, 400, d.intro),
    privacy: text(r.privacy, 400, d.privacy) || d.privacy
  };
}

function loadSettings(getSetting) {
  try {
    const raw = getSetting(SETTINGS_KEY);
    return normaliseSettings(raw ? JSON.parse(raw) : null);
  } catch (_) { return normaliseSettings(null); }
}

function loadFarmConfig(getSetting) {
  try {
    const raw = getSetting(FARM_CONFIG_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (_) { return null; }
}

/** Can we honestly quote? Placeholder numbers don't count. */
function pricingReady(farmConfigRaw) {
  const problems = [];
  if (!farmConfigRaw) {
    problems.push('The Farm Cost Calculator has no saved settings yet. Open it, check the figures, and they will be saved.');
    return { ok: false, problems };
  }
  const c = FarmCost.normaliseConfig(farmConfigRaw);
  const active = Object.values(c.printers).filter((p) => p.active);
  if (!active.length) problems.push('No printer is marked in service in the Farm Cost Calculator.');
  else if (!active.some((p) => p.price > 0)) problems.push('None of your printers has a purchase price set, so wear and tear would be quoted as zero.');
  if (!Object.values(c.filaments).some((f) => f.spoolPrice > 0)) problems.push('No filament has a spool price set.');
  return { ok: problems.length === 0, problems };
}

// ---------- schema ----------
function ensureSchema(db) {
  db.prepare(`CREATE TABLE IF NOT EXISTS kiosk_items (
    model_id INTEGER PRIMARY KEY,
    enabled INTEGER NOT NULL DEFAULT 1,
    title TEXT,
    print_hours REAL NOT NULL,
    grams REAL NOT NULL,
    units_per_plate INTEGER NOT NULL DEFAULT 1,
    filament_id INTEGER,
    note TEXT
  )`).run();
  db.prepare(`CREATE TABLE IF NOT EXISTS quote_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reference TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'new',
    model_id INTEGER,
    item_name TEXT,
    quantity INTEGER NOT NULL,
    unit_price REAL,
    total_price REAL,
    currency TEXT,
    valid_until TEXT,
    customer_email TEXT NOT NULL,
    customer_name TEXT,
    message TEXT,
    internal_cost REAL,
    internal_profit REAL,
    price_shown INTEGER NOT NULL DEFAULT 1,
    notify_status TEXT NOT NULL DEFAULT 'none',
    handled_at TEXT
  )`).run();
  db.prepare('CREATE INDEX IF NOT EXISTS idx_quote_requests_status ON quote_requests(status, created_at)').run();
}

// ---------- catalogue ----------
const stripExt = (name) => String(name || '').replace(/\.[a-z0-9]{2,5}$/i, '');

function saveItem(db, input) {
  const modelId = Number(input && input.modelId);
  const model = Number.isInteger(modelId) ? db.prepare('SELECT id, fileName FROM models WHERE id = ?').get(modelId) : null;
  if (!model) throw new Error('That model no longer exists.');
  const hours = Number(input.printHours);
  const grams = Number(input.grams);
  if (!(hours > 0 && hours <= 500)) throw new Error('Print time must be more than 0 and no more than 500 hours.');
  if (!(grams > 0 && grams <= 20000)) throw new Error('Filament weight must be more than 0 and no more than 20,000 grams.');
  const perPlate = clampInt(input.unitsPerPlate, 1, 500, 1);
  const filamentId = input.filamentId === '' || input.filamentId == null ? null : Number(input.filamentId);
  if (filamentId !== null && !Number.isInteger(filamentId)) throw new Error('Choose a filament from the list.');
  db.prepare(`INSERT INTO kiosk_items (model_id, enabled, title, print_hours, grams, units_per_plate, filament_id, note)
    VALUES (@model_id, @enabled, @title, @print_hours, @grams, @units_per_plate, @filament_id, @note)
    ON CONFLICT(model_id) DO UPDATE SET enabled = excluded.enabled, title = excluded.title, print_hours = excluded.print_hours,
      grams = excluded.grams, units_per_plate = excluded.units_per_plate, filament_id = excluded.filament_id, note = excluded.note`).run({
    model_id: model.id,
    enabled: input.enabled === false ? 0 : 1,
    title: text(input.title, 120) || null,
    print_hours: hours,
    grams,
    units_per_plate: perPlate,
    filament_id: filamentId,
    note: text(input.note, 300) || null
  });
  return model.id;
}

function removeItem(db, modelId) {
  return db.prepare('DELETE FROM kiosk_items WHERE model_id = ?').run(Number(modelId)).changes > 0;
}

function listItemsAdmin(db) {
  return db.prepare(`SELECT k.*, m.fileName, m.designer, m.license
    FROM kiosk_items k JOIN models m ON m.id = k.model_id ORDER BY lower(coalesce(k.title, m.fileName))`).all();
}

function searchModels(db, query, limit = 20) {
  const q = `%${String(query || '').replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
  return db.prepare(`SELECT id, fileName, designer, license FROM models
    WHERE fileName LIKE ? ESCAPE '\\' ORDER BY fileName LIMIT ?`).all(q, Math.min(50, Math.max(1, limit)));
}

/** What a customer may see: a name, a designer credit, a short note. Nothing about cost, files or paths. */
function publicRow(row) {
  return { id: row.model_id, name: row.title || stripExt(row.fileName), designer: row.designer && row.designer !== 'Unknown' ? row.designer : '', note: row.note || '' };
}

function publicCatalogue(db, { q = '', offset = 0, limit = 12 } = {}) {
  const like = `%${String(q).trim().slice(0, 60).replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
  const lim = clampInt(limit, 1, 24, 12);
  const off = clampInt(offset, 0, 100000, 0);
  const where = `k.enabled = 1 AND (coalesce(k.title, m.fileName) LIKE ? ESCAPE '\\' OR coalesce(m.designer,'') LIKE ? ESCAPE '\\')`;
  const total = db.prepare(`SELECT COUNT(*) AS n FROM kiosk_items k JOIN models m ON m.id = k.model_id WHERE ${where}`).get(like, like).n;
  const rows = db.prepare(`SELECT k.model_id, k.title, k.note, m.fileName, m.designer
    FROM kiosk_items k JOIN models m ON m.id = k.model_id WHERE ${where}
    ORDER BY lower(coalesce(k.title, m.fileName)) LIMIT ? OFFSET ?`).all(like, like, lim, off);
  return { total, items: rows.map(publicRow) };
}

function offeredItem(db, id) {
  return db.prepare(`SELECT k.*, m.fileName, m.designer FROM kiosk_items k JOIN models m ON m.id = k.model_id
    WHERE k.enabled = 1 AND k.model_id = ?`).get(Number(id)) || null;
}

/** Decodes the stored data-URL thumbnail. Returns null if there isn't a usable one. */
function thumbnailFor(db, id) {
  const row = db.prepare(`SELECT m.thumbnail FROM kiosk_items k JOIN models m ON m.id = k.model_id WHERE k.enabled = 1 AND k.model_id = ?`).get(Number(id));
  const m = row && typeof row.thumbnail === 'string' && row.thumbnail.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/);
  return m ? { type: m[1], data: Buffer.from(m[2], 'base64') } : null;
}

// ---------- quoting ----------
/**
 * Prices `quantity` of an item. The customer is charged for whole plates: ask for 3
 * of something that prints 4 to a plate and you still pay for the plate, spread
 * over the 3. (Quoting the odd one out for free is how small shops go quietly
 * broke.) The cost and profit come back so the inbox can show them to you, never
 * to the customer.
 */
function computeQuote({ farmConfig, item, quantity, settings }) {
  const ready = pricingReady(farmConfig);
  if (!ready.ok) return { ok: false, error: 'Pricing is not set up yet. Please ask staff for a quote.' };
  // Not clamped: -3 or 0 or 5000 is a mistake to point out, not something to quietly turn into 1 or 100.
  const qty = Math.round(Number(quantity));
  if (!Number.isFinite(qty) || qty < 1 || qty > 100) return { ok: false, error: 'Choose a quantity between 1 and 100.' };
  const config = FarmCost.normaliseConfig(farmConfig);
  if (item.filament_id != null && !(config.filaments[item.filament_id] && config.filaments[item.filament_id].spoolPrice > 0)) {
    return { ok: false, error: 'This item cannot be priced right now. Please ask staff.' };
  }
  const perPlate = Math.max(1, item.units_per_plate || 1);
  const plates = Math.ceil(qty / perPlate);
  const filamentLine = item.filament_id != null
    ? { grams: item.grams, filamentId: item.filament_id }
    : { grams: item.grams, costPerGram: averageFilamentCostPerGram(config) };
  const job = FarmCost.computeJob(config, {
    printHours: item.print_hours,
    plates,
    unitsPerPlate: perPlate,
    filaments: [filamentLine],
    setupMinutes: 5,
    pricing: { mode: 'margin' }
  });
  if (!job.reachable) return { ok: false, error: 'This item cannot be priced right now. Please ask staff.' };
  let total = Math.max(job.revenue, settings.minimumCharge || 0);
  total = Math.round(total * 100) / 100;
  return {
    ok: true,
    quantity: qty,
    total,
    unitPrice: Math.round((total / qty) * 100) / 100,
    currency: config.currency,
    internal: { cost: Math.round(job.cost * 100) / 100, profit: Math.round((total - job.cost - job.fees) * 100) / 100 }
  };
}

function averageFilamentCostPerGram(config) {
  const priced = Object.values(config.filaments).filter((f) => f.spoolPrice > 0);
  return priced.length ? priced.reduce((s, f) => s + f.spoolPrice / f.spoolGrams, 0) / priced.length : 0;
}

// ---------- short-lived quotes held in server memory ----------
function createQuoteStore({ ttlMs = 60 * 60 * 1000, max = 2000, now = Date.now } = {}) {
  const map = new Map();
  function sweep() { const t = now(); for (const [k, v] of map) if (v.expires <= t) map.delete(k); }
  return {
    put(snapshot) {
      sweep();
      if (map.size >= max) map.delete(map.keys().next().value);   // drop the oldest rather than refuse
      const id = crypto.randomBytes(16).toString('hex');
      map.set(id, { snapshot, expires: now() + ttlMs });
      return id;
    },
    /** Single use: a quote can become one request, not a hundred. */
    take(id) {
      sweep();
      const entry = typeof id === 'string' ? map.get(id) : null;
      if (!entry) return null;
      map.delete(id);
      return entry.snapshot;
    },
    size: () => map.size
  };
}

function createRateLimiter({ windowMs, max, now = Date.now }) {
  const hits = new Map();
  return {
    hit(key) {
      const t = now();
      const recent = (hits.get(key) || []).filter((x) => t - x < windowMs);
      if (recent.length >= max) { hits.set(key, recent); return { allowed: false, retryAfter: Math.ceil((windowMs - (t - recent[0])) / 1000) }; }
      recent.push(t); hits.set(key, recent);
      if (hits.size > 5000) { for (const [k, v] of hits) if (!v.some((x) => t - x < windowMs)) hits.delete(k); }
      return { allowed: true, retryAfter: 0 };
    }
  };
}

// ---------- requests (the inbox) ----------
const REF_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // no 0/O or 1/I: these get read out over the phone
function newReference() {
  const bytes = crypto.randomBytes(6);
  return 'Q-' + Array.from(bytes, (b) => REF_ALPHABET[b % REF_ALPHABET.length]).join('');
}

const EMAIL = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/;
function validateSubmission(body) {
  const b = body && typeof body === 'object' ? body : {};
  const email = text(b.email, 254);
  if (!email || !EMAIL.test(email)) return { ok: false, error: 'Please enter a valid email address.' };
  return {
    ok: true,
    email,
    name: text(b.name, 80),
    message: text(b.message, 500)
  };
}

function createRequest(db, { snapshot, email, name, message, now = new Date() }) {
  const created = now.toISOString();
  const validUntil = new Date(now.getTime() + snapshot.validityDays * 86400000).toISOString();
  for (let attempt = 0; attempt < 5; attempt++) {
    const reference = newReference();
    try {
      db.prepare(`INSERT INTO quote_requests (reference, created_at, model_id, item_name, quantity, unit_price, total_price, currency, valid_until,
        customer_email, customer_name, message, internal_cost, internal_profit, price_shown)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        reference, created, snapshot.itemId, snapshot.itemName, snapshot.quantity, snapshot.unitPrice, snapshot.total, snapshot.currency,
        validUntil, email, name || null, message || null, snapshot.internal.cost, snapshot.internal.profit, snapshot.showPrice ? 1 : 0);
      return db.prepare('SELECT * FROM quote_requests WHERE reference = ?').get(reference);
    } catch (e) {
      if (!/UNIQUE/.test(String(e.message))) throw e;   // a clash on the reference: try another
    }
  }
  throw new Error('Could not create a reference');
}

const REQUEST_STATUSES = ['new', 'quoted', 'accepted', 'declined', 'done'];
function listRequests(db, { status = '', limit = 200 } = {}) {
  const lim = clampInt(limit, 1, 500, 200);
  return REQUEST_STATUSES.includes(status)
    ? db.prepare('SELECT * FROM quote_requests WHERE status = ? ORDER BY created_at DESC LIMIT ?').all(status, lim)
    : db.prepare('SELECT * FROM quote_requests ORDER BY created_at DESC LIMIT ?').all(lim);
}
const countNew = (db) => db.prepare("SELECT COUNT(*) AS n FROM quote_requests WHERE status = 'new'").get().n;
function updateRequest(db, id, status, now = new Date()) {
  if (!REQUEST_STATUSES.includes(status)) throw new Error('Unknown status');
  return db.prepare('UPDATE quote_requests SET status = ?, handled_at = ? WHERE id = ?').run(status, status === 'new' ? null : now.toISOString(), Number(id)).changes > 0;
}
const deleteRequest = (db, id) => db.prepare('DELETE FROM quote_requests WHERE id = ?').run(Number(id)).changes > 0;
function purgeOld(db, retentionDays, now = new Date()) {
  const cutoff = new Date(now.getTime() - retentionDays * 86400000).toISOString();
  return db.prepare('DELETE FROM quote_requests WHERE created_at < ?').run(cutoff).changes;
}

// ---------- notifying you ----------
function webhookPayload(request, settings) {
  const price = request.price_shown
    ? `${request.currency}${Number(request.total_price).toFixed(2)}`
    : `${request.currency}${Number(request.total_price).toFixed(2)} (customer was NOT shown a price)`;
  const line = `New quote request ${request.reference}: ${request.quantity} x ${request.item_name}, ${price}. From ${request.customer_email}${request.customer_name ? ` (${request.customer_name})` : ''}.${request.message ? ` Message: ${request.message}` : ''}`;
  // "content" is what Discord reads, "text" what Slack reads; anything else gets the full record.
  return { content: line, text: line, reference: request.reference, item: request.item_name, quantity: request.quantity, total: request.total_price, currency: request.currency, email: request.customer_email, name: request.customer_name || '', message: request.message || '' };
}

/** https only (plain http only to this machine, for testing). No redirects followed, short timeout. */
function sendWebhook(urlString, payload, { timeoutMs = 8000 } = {}) {
  return new Promise((resolve) => {
    let url;
    try { url = new URL(urlString); } catch (_) { resolve({ ok: false, error: 'bad url' }); return; }
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) { resolve({ ok: false, error: 'https required' }); return; }
    const body = JSON.stringify(payload);
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(url, { method: 'POST', timeout: timeoutMs, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'User-Agent': 'Printventory-Kiosk' } }, (res) => {
      res.resume();
      resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    req.on('error', (e) => resolve({ ok: false, error: e.code || 'error' }));
    req.end(body);
  });
}

// ---------- the HTTP surface ----------
const ASSETS = Object.freeze({
  '/kiosk': ['kiosk.html', 'text/html; charset=utf-8'],
  '/kiosk/app.js': ['kiosk-client.js', 'text/javascript; charset=utf-8'],
  '/kiosk/app.css': ['kiosk.css', 'text/css; charset=utf-8'],
  '/kiosk/fonts/inter.css': ['fonts/inter.css', 'text/css; charset=utf-8'],
  '/kiosk/fonts/inter-normal-100-900-latin.woff2': ['fonts/inter-normal-100-900-latin.woff2', 'font/woff2'],
  '/kiosk/logo.png': ['logo.png', 'image/png']
});

function securityHeaders(res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
}

/**
 * ctx: { getDb(), getSetting(key), appDir, onNewRequest?(request), now? }
 * Mount this BEFORE the app's global JSON parser (50 MB) and BEFORE the admin access
 * guard: the customer page is public by design and must accept only tiny bodies.
 */
function registerRoutes(app, ctx) {
  const express = require('express');
  const quotes = createQuoteStore({ ttlMs: 60 * 60 * 1000, now: ctx.now });
  const quoteLimit = createRateLimiter({ windowMs: 60 * 1000, max: 60, now: ctx.now });
  const submitLimit = createRateLimiter({ windowMs: 10 * 60 * 1000, max: 5, now: ctx.now });
  const settings = () => loadSettings(ctx.getSetting);

  const gate = (req, res, next) => {
    securityHeaders(res);
    if (!settings().enabled) { res.status(404).json({ error: 'Not available' }); return; }
    next();
  };
  const small = express.json({ limit: '8kb' });
  const jsonErrors = (err, req, res, next) => {   // too big, or not JSON: say so plainly
    if (err && err.type === 'entity.too.large') { res.status(413).json({ error: 'That request is too large.' }); return; }
    if (err) { res.status(400).json({ error: 'That request could not be read.' }); return; }
    next();
  };

  // page and assets: exact allowlist, nothing else is reachable under /kiosk
  app.get(Object.keys(ASSETS), (req, res) => {
    securityHeaders(res);
    if (!settings().enabled) { res.status(404).type('text/plain').send('Not available'); return; }
    const [file, type] = ASSETS[req.path];
    if (req.path === '/kiosk') res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; form-action 'none'; base-uri 'none'");
    res.type(type);
    if (req.path.endsWith('.woff2') || req.path.endsWith('.png')) res.setHeader('Cache-Control', 'public, max-age=86400');
    res.sendFile(path.join(ctx.appDir, file));
  });

  const api = express.Router();
  api.use(gate);

  api.get('/config', (req, res) => {
    const s = settings();
    const ready = pricingReady(loadFarmConfig(ctx.getSetting));
    const cfg = loadFarmConfig(ctx.getSetting);
    res.json({ title: s.title, intro: s.intro, privacy: s.privacy, showPrice: s.showPrice, idleSeconds: s.idleSeconds, validityDays: s.validityDays, ready: ready.ok, currency: cfg && cfg.currency ? String(cfg.currency).slice(0, 4) : '£' });
  });

  api.get('/catalogue', (req, res) => {
    res.json(publicCatalogue(ctx.getDb(), { q: req.query.q, offset: req.query.offset, limit: req.query.limit }));
  });

  api.get('/thumb/:id', (req, res) => {
    const t = thumbnailFor(ctx.getDb(), req.params.id);
    if (!t) { res.status(404).end(); return; }
    res.setHeader('Content-Type', t.type);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.end(t.data);
  });

  api.post('/quote', small, jsonErrors, (req, res) => {
    const gateKey = req.ip || 'unknown';
    const lim = quoteLimit.hit(gateKey);
    if (!lim.allowed) { res.setHeader('Retry-After', String(lim.retryAfter)); res.status(429).json({ error: 'Please wait a moment and try again.' }); return; }
    const s = settings();
    const item = offeredItem(ctx.getDb(), req.body && req.body.itemId);
    if (!item) { res.status(404).json({ error: 'That item is not available.' }); return; }
    const q = computeQuote({ farmConfig: loadFarmConfig(ctx.getSetting), item, quantity: req.body && req.body.quantity, settings: s });
    if (!q.ok) { res.status(422).json({ error: q.error }); return; }
    const validUntil = new Date((ctx.now ? ctx.now() : Date.now()) + s.validityDays * 86400000).toISOString();
    const quoteId = quotes.put({ itemId: item.model_id, itemName: item.title || stripExt(item.fileName), quantity: q.quantity, unitPrice: q.unitPrice, total: q.total, currency: q.currency, internal: q.internal, showPrice: s.showPrice, validityDays: s.validityDays });
    const out = { quoteId, name: item.title || stripExt(item.fileName), quantity: q.quantity, validUntil, showPrice: s.showPrice };
    if (s.showPrice) { out.unitPrice = q.unitPrice; out.total = q.total; out.currency = q.currency; }
    res.json(out);
  });

  api.post('/submit', small, jsonErrors, async (req, res) => {
    const lim = submitLimit.hit(req.ip || 'unknown');
    if (!lim.allowed) { res.setHeader('Retry-After', String(lim.retryAfter)); res.status(429).json({ error: 'Too many requests from this device. Please try again later.' }); return; }
    const body = req.body || {};
    // honeypot: a field no person can see. Bots fill it in. Pretend it worked and store nothing.
    if (typeof body.website === 'string' && body.website.trim() !== '') { res.json({ reference: newReference(), validUntil: new Date().toISOString() }); return; }
    const v = validateSubmission(body);
    if (!v.ok) { res.status(422).json({ error: v.error }); return; }
    const snapshot = quotes.take(body.quoteId);
    if (!snapshot) { res.status(410).json({ error: 'That quote has expired. Please get a new one.' }); return; }
    const s = settings();
    let request;
    try { request = createRequest(ctx.getDb(), { snapshot, email: v.email, name: v.name, message: v.message, now: ctx.now ? new Date(ctx.now()) : new Date() }); }
    catch (e) { res.status(500).json({ error: 'Sorry, that did not go through. Please ask staff.' }); return; }
    res.json({ reference: request.reference, validUntil: request.valid_until });
    // Tell you afterwards, so a slow webhook never keeps the customer waiting.
    try { if (ctx.onNewRequest) ctx.onNewRequest(request); } catch (_) { /* a failing hook must not matter */ }
    if (s.webhookUrl) {
      sendWebhook(s.webhookUrl, webhookPayload(request, s)).then((r) => {
        try { ctx.getDb().prepare('UPDATE quote_requests SET notify_status = ? WHERE id = ?').run(r.ok ? 'sent' : 'failed', request.id); } catch (_) { /* db closing */ }
      });
    }
  });

  app.use('/api/kiosk', api);
}

// ---------- admin side (IPC handlers) ----------
function registerAdminIpc(ipcMain, ctx) {
  const h = (channel, fn) => ipcMain.handle(channel, async (event, ...args) => fn(...args));
  const db = () => ctx.getDb();
  h('kiosk-get-settings', () => {
    const farm = loadFarmConfig(ctx.getSetting);
    return { settings: loadSettings(ctx.getSetting), ready: pricingReady(farm), status: ctx.status ? ctx.status() : {} };
  });
  h('kiosk-save-settings', (patch) => {
    const merged = normaliseSettings({ ...loadSettings(ctx.getSetting), ...(patch && typeof patch === 'object' ? patch : {}) });
    ctx.setSetting(SETTINGS_KEY, JSON.stringify(merged));
    return merged;
  });
  h('kiosk-list-items', () => listItemsAdmin(db()));
  h('kiosk-search-models', (q) => searchModels(db(), q));
  h('kiosk-save-item', (input) => saveItem(db(), input));
  h('kiosk-remove-item', (modelId) => removeItem(db(), modelId));
  h('kiosk-list-requests', (status) => listRequests(db(), { status }));
  h('kiosk-update-request', (id, status) => updateRequest(db(), id, status));
  h('kiosk-delete-request', (id) => deleteRequest(db(), id));
  h('kiosk-request-count', () => countNew(db()));
  // What a customer would be quoted, and what it costs you, before an item goes live.
  h('kiosk-preview-quote', (input) => {
    const i = input && typeof input === 'object' ? input : {};
    const item = { print_hours: Number(i.printHours), grams: Number(i.grams), units_per_plate: clampInt(i.unitsPerPlate, 1, 500, 1), filament_id: i.filamentId === '' || i.filamentId == null ? null : Number(i.filamentId) };
    if (!(item.print_hours > 0) || !(item.grams > 0)) return { ok: false, error: 'Enter a print time and a filament weight.' };
    return computeQuote({ farmConfig: loadFarmConfig(ctx.getSetting), item, quantity: i.quantity || 1, settings: loadSettings(ctx.getSetting) });
  });
  h('kiosk-test-webhook', async () => {
    const s = loadSettings(ctx.getSetting);
    if (!s.webhookUrl) return { ok: false, error: 'No webhook address saved.' };
    const r = await sendWebhook(s.webhookUrl, { content: 'Test message from Printventory quote requests.', text: 'Test message from Printventory quote requests.', test: true });
    return r;
  });
}

module.exports = {
  SETTINGS_KEY, DEFAULT_SETTINGS, REQUEST_STATUSES,
  normaliseSettings, loadSettings, loadFarmConfig, pricingReady, ensureSchema,
  saveItem, removeItem, listItemsAdmin, searchModels, publicCatalogue, offeredItem, thumbnailFor,
  computeQuote, createQuoteStore, createRateLimiter, validateSubmission, newReference,
  createRequest, listRequests, countNew, updateRequest, deleteRequest, purgeOld,
  webhookPayload, sendWebhook, registerRoutes, registerAdminIpc
};
