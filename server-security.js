/*
 * server-security.js
 *
 * Three small jobs, kept out of main.js because main.js is already large enough
 * to have its own postcode:
 *
 *   1. Decide which browser origins may talk to the server (CORS plus the
 *      WebSocket handshake, which CORS doesn't cover at all).
 *   2. Optionally demand an access token (PRINTVENTORY_ACCESS_TOKEN).
 *   3. Refuse to serve a handful of files that have no business being public.
 *
 * Why bother: the whole app talks to the server over one WebSocket, and that
 * WebSocket used to accept anyone. Browsers don't apply CORS to WebSockets, so
 * any web page open in the same browser could connect to ws://localhost:5000 and
 * issue the same calls the UI does. Delete-a-file included. Not ideal.
 *
 * Design rules I stuck to:
 *   - No token set means behaviour is the same as before for normal use: the
 *     app's own page, MCP clients, curl, and the Chrome extension all still work.
 *   - Non-browser clients send no Origin header, so they pass the origin check.
 *     The token is what stops those, and it is opt-in.
 *   - Fail closed on garbage. A malformed Origin is a no.
 *
 * Wishlist: per-IP lockout after N bad tokens. Skipped. A 24+ character random
 * token isn't getting guessed over a LAN before the heat death of the garden shed.
 */
'use strict';

const crypto = require('crypto');

// Browser extensions have their own origin schemes and can't be same-origin
// with a server. The Printventory Chrome extension posts uploads this way.
const EXTENSION_SCHEMES = new Set(['chrome-extension:', 'moz-extension:']);

function parseList(value) {
  return String(value || '')
    .split(',')
    .map((s) => s.trim().toLowerCase().replace(/\/+$/, ''))
    .filter(Boolean);
}

function hostOf(origin) {
  try {
    return new URL(origin).host.toLowerCase();
  } catch (_) {
    return null;
  }
}

/**
 * @param {string|undefined} origin  Origin header, if any
 * @param {string|undefined} host    Host header of the request
 * @param {string[]} extra           explicitly allowed origins (lowercase, no trailing slash)
 */
function isOriginAllowed(origin, host, extra = []) {
  if (origin === undefined || origin === null || origin === '') return true; // not a browser cross-site request
  const clean = String(origin).trim().toLowerCase().replace(/\/+$/, '');
  if (clean === 'null') return false; // sandboxed iframes, file://, data: pages
  let parsed;
  try {
    parsed = new URL(clean);
  } catch (_) {
    return false;
  }
  if (EXTENSION_SCHEMES.has(parsed.protocol)) return true;
  if (extra.includes(clean)) return true;
  if (host && parsed.host.toLowerCase() === String(host).toLowerCase()) return true;
  return false;
}

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function readCookie(header, name) {
  if (!header) return null;
  for (const part of String(header).split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) {
      try {
        return decodeURIComponent(part.slice(idx + 1).trim());
      } catch (_) {
        return null;
      }
    }
  }
  return null;
}

const COOKIE_NAME = 'pv_token';
const MIN_TOKEN_LENGTH = 16;

/**
 * Pulls the token a request is presenting, in order: Bearer header, cookie.
 * (The ?token= query form is handled separately, because it also sets the cookie.)
 */
function presentedToken(req) {
  const auth = req.headers && req.headers.authorization;
  if (auth && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim();
  return readCookie(req.headers && req.headers.cookie, COOKIE_NAME);
}

function tokenOk(req, token) {
  if (!token) return true;
  const got = presentedToken(req);
  return !!got && safeEqual(got, token);
}

/**
 * Poka-yoke: a token that's too short is worse than none, because it looks like
 * protection. Refuse to start with one rather than quietly accept "password".
 */
function validateToken(token) {
  if (!token) return null;
  if (String(token).length < MIN_TOKEN_LENGTH) {
    throw new Error(`PRINTVENTORY_ACCESS_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters (try: openssl rand -hex 24)`);
  }
  return String(token);
}

/** Express middleware: origin policy + CORS headers + preflight. */
function createOriginPolicy({ allowedOrigins = [] } = {}) {
  const extra = Array.isArray(allowedOrigins) ? allowedOrigins : parseList(allowedOrigins);
  return function originPolicy(req, res, next) {
    const origin = req.headers.origin;
    res.setHeader('Vary', 'Origin');
    if (!isOriginAllowed(origin, req.headers.host, extra)) {
      // Note: this also blocks simple cross-site POSTs, which CORS alone would
      // let through to the handler (the browser only hides the response).
      res.status(403).type('text/plain').send('Origin not allowed');
      return;
    }
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.setHeader(
        'Access-Control-Allow-Headers',
        'Origin, X-Requested-With, Content-Type, Accept, Authorization, MCP-Protocol-Version, Mcp-Session-Id, Last-Event-ID'
      );
      res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id, MCP-Protocol-Version');
    }
    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  };
}

/**
 * Express middleware: requires the access token when one is configured.
 * Visiting any page with ?token=... sets an HttpOnly cookie and redirects to the
 * same URL without it, so the token doesn't linger in the address bar or history.
 */
function createAccessGuard(token) {
  if (!token) return (req, res, next) => next();
  return function accessGuard(req, res, next) {
    if (req.method === 'OPTIONS') return next();
    if (tokenOk(req, token)) return next();

    if (req.method === 'GET' && req.query && typeof req.query.token === 'string' && safeEqual(req.query.token, token)) {
      const secure = req.socket && req.socket.encrypted ? '; Secure' : '';
      res.setHeader('Set-Cookie', `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict${secure}`);
      const url = new URL(req.originalUrl, 'http://placeholder');
      url.searchParams.delete('token');
      res.redirect(302, `${url.pathname}${url.search}`);
      return;
    }

    res.setHeader('WWW-Authenticate', 'Bearer realm="Printventory"');
    if (req.method === 'GET' && String(req.headers.accept || '').includes('text/html')) {
      res.status(401).type('text/plain').send('Access token required. Open this address once with ?token=YOUR_TOKEN on the end.');
    } else {
      res.status(401).json({ error: 'Access token required' });
    }
  };
}

/** `verifyClient` for the `ws` library. Same rules as the HTTP side. */
function createWsVerifier({ token, allowedOrigins = [] } = {}) {
  const extra = Array.isArray(allowedOrigins) ? allowedOrigins : parseList(allowedOrigins);
  return function verifyClient(info) {
    const req = info.req;
    if (!isOriginAllowed(req.headers.origin, req.headers.host, extra)) return false;
    return tokenOk(req, token);
  };
}

// Files that should never go out over static serving, whatever they're called.
const BLOCKED_PATH = /(^|\/)(node_modules|scripts|tests|\.github|\.git|build|appx|helper)(\/|$)|\.(db|sqlite|sqlite3|db-wal|db-shm|env|pem|key|ps1|sh)$|(^|\/)(package-lock\.json|dockerfile[^/]*|docker-compose[^/]*|\.npmrc|\.gitattributes|\.dockerignore)$/i;

function isBlockedStaticPath(urlPath) {
  let p;
  try {
    p = decodeURIComponent(String(urlPath || ''));
  } catch (_) {
    return true;
  }
  return BLOCKED_PATH.test(p.replace(/\\/g, '/'));
}

function createStaticBlocker() {
  return function staticBlocker(req, res, next) {
    // Mounted ahead of express.static, so it sees API traffic too. /api/helper/bundle
    // contains "helper/", which the pattern would otherwise take for a folder.
    if (req.path.startsWith('/api/') || req.path === '/mcp' || req.path.startsWith('/mcp/')) {
      next();
      return;
    }
    if (isBlockedStaticPath(req.path)) {
      res.status(404).type('text/plain').send('Not Found');
      return;
    }
    next();
  };
}

module.exports = {
  parseList,
  hostOf,
  isOriginAllowed,
  validateToken,
  tokenOk,
  createOriginPolicy,
  createAccessGuard,
  createWsVerifier,
  isBlockedStaticPath,
  createStaticBlocker,
  COOKIE_NAME
};
