'use strict';
const express = require('express');
const path = require('path');
const fs = require('fs');
const { runAudit } = require('./lib/audit');
const { runSpeedTest } = require('./lib/speed');
const { probePerformance } = require('./lib/perfprobe');
const { checkSubmission, memoryStore, clientKey } = require('./lib/ratelimit');
const { authorize } = require('./lib/admin');

const app = express();
// A HOST-SET PORT=0 (rare, but seen in some sandboxes) would make the OS pick a
// random port, breaking the live preview connection — only honour a real port.
const PORT = process.env.PORT && Number(process.env.PORT) > 0 ? Number(process.env.PORT) : 3000;
app.disable('x-powered-by');
// ---------- Security headers on every response (mirrored in worker.js) ----------
// CSP: pages use inline <style> and inline <script>; no external resources.
const SECURITY_HEADERS = {
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    "script-src 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "form-action 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join('; '),
};
app.use((_req, res, next) => { for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v); next(); });
app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Never let a stray rejection kill the server (keeps the preview alive)
process.on('unhandledRejection', (err) => console.error('unhandledRejection:', err && err.message));
process.on('uncaughtException', (err) => console.error('uncaughtException:', err && err.message));

// Wrap async handlers so every failure becomes a clean JSON response
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Hard timeout for the audit route (stay under proxy timeouts)
const withTimeout = (promise, ms, msg) => Promise.race([
  promise,
  new Promise((_, rej) => setTimeout(() => rej(new Error(msg)), ms)),
]);

// ---------- Backlinks data store ----------
const DATA_DIR = path.join(__dirname, 'data');
const BACKLINKS_FILE = path.join(DATA_DIR, 'backlinks.json');
const SNAPSHOT_FILE = path.join(DATA_DIR, 'snapshots.json');
function loadBacklinks() {
  try { return JSON.parse(fs.readFileSync(BACKLINKS_FILE, 'utf8')); } catch { return []; }
}
function saveBacklinks(list) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(BACKLINKS_FILE, JSON.stringify(list, null, 2));
}
if (!fs.existsSync(BACKLINKS_FILE)) saveBacklinks([]);

const AU_STATES = ['NSW', 'VIC', 'QLD', 'WA', 'SA', 'TAS', 'ACT', 'NT'];
const CATEGORIES = ['Blogger', 'Business', 'Directory', 'News / Media', 'Community', 'Other'];

function clean(s, max) {
  return String(s || '').replace(/[<>]/g, '').trim().slice(0, max);
}
function validUrl(u) {
  try {
    const p = new URL(/^https?:\/\//i.test(u) ? u : 'https://' + u);
    if (!p.hostname.includes('.')) return null;
    // Store a clean canonical web link: strip UTM/tracking params, any other
    // query string, and the fragment. These links are directory content, not
    // attribution channels — and they keep the listing pages crawl-clean.
    p.hash = '';
    p.search = '';
    return p.href;
  } catch { return null; }
}

// ---------- Pages ----------
app.get('/backlinks', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'backlinks.html')));
app.get('/skills', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'skills.html')));
app.get('/api', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'api.html')));

// ---------- Health (lets the frontend detect "server asleep") ----------
app.get('/api/health', (_req, res) => res.json({ ok: true, uptime: Math.round(process.uptime()) }));

// ---------- API: full audit ----------
app.get('/api/audit', ah(async (req, res) => {
  const result = await withTimeout(runAudit(req.query.url), 50000,
    'The audit timed out after 50 seconds \u2014 that website is very slow to respond. Please try again.');

  // Drift tracking: compare with the previous audit of the same host
  try {
    let snaps = {};
    try { snaps = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8')); } catch { }
    const host = result.host;
    const prev = (snaps[host] || []).slice(-1)[0] || null;
    const entry = {
      at: result.fetchedAt,
      overall: result.overall,
      groups: Object.fromEntries(Object.entries(result.groups).map(([k, v]) => [k, v.score])),
    };
    snaps[host] = [...(snaps[host] || []), entry].slice(-10);
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(snaps));
    if (prev) {
      result.drift = {
        previousAt: prev.at,
        previousOverall: prev.overall,
        delta: result.overall - prev.overall,
        groups: Object.fromEntries(Object.entries(entry.groups).map(([k, v]) => [k, v - (prev.groups[k] ?? v)])),
      };
    }
  } catch { /* drift is optional */ }

  res.json(result);
}));

// ---------- API: built-in performance probe ----------
app.get('/api/perf', ah(async (req, res) => {
  const result = await probePerformance(req.query.url);
  if (!result) return res.status(400).json({ error: 'Could not reach that site.' });
  res.json(result);
}));

// ---------- API: PageSpeed (Lighthouse) ----------
app.get('/api/speed', ah(async (req, res) => {
  const strategy = req.query.strategy === 'desktop' ? 'desktop' : 'mobile';
  const result = await runSpeedTest(req.query.url, strategy);
  res.json(result);
}));

// ---------- API: operator moderation (token-gated) ----------
// Set ADMIN_TOKEN to enable; the endpoints stay closed (503) without it.
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

// Full listings INCLUDING emails — operator eyes only.
app.get('/api/admin/listings', ah(async (req, res) => {
  const auth = authorize(req.headers.authorization, ADMIN_TOKEN);
  if (!auth.allowed) return res.status(auth.status).json({ error: auth.error });
  const all = loadBacklinks();
  res.json({ total: all.length, listings: all.slice().reverse() });
}));

// Remove a listing by id (spam moderation). Returns the removed entry.
app.delete('/api/admin/listings/:id', ah(async (req, res) => {
  const auth = authorize(req.headers.authorization, ADMIN_TOKEN);
  if (!auth.allowed) return res.status(auth.status).json({ error: auth.error });
  const list = loadBacklinks();
  const idx = list.findIndex((x) => x.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'No listing with that id.' });
  const [removed] = list.splice(idx, 1);
  saveBacklinks(list);
  res.json({ ok: true, removed: publicListing(removed) });
}));

// ---------- API: backlink directory ----------
// Submitter emails are stored for the operator but NEVER exposed via the API.
const publicListing = ({ email, ...pub }) => pub;
// One shared rate-limit store for the process lifetime (fresh counters would
// never trip). Resets on restart — acceptable for spam deterrence.
const backlinkRateStore = memoryStore();
const BACKLINKS_PAGE_DEFAULT = 50;
const BACKLINKS_PAGE_MAX = 100;
app.get('/api/backlinks', ah(async (req, res) => {
  const all = loadBacklinks();
  const state = (req.query.state || '').toUpperCase();
  const cat = req.query.category || '';
  const limit = Math.min(
    BACKLINKS_PAGE_MAX,
    Math.max(1, Math.floor(Number(req.query.limit)) || BACKLINKS_PAGE_DEFAULT)
  );
  const offset = Math.max(0, Math.floor(Number(req.query.offset)) || 0);
  // Cursor pagination: `after=<id>` returns listings strictly older than that
  // id (ids begin with a Base36 timestamp, so string comparison = age order).
  // A cursor stays valid even if the anchor listing is deleted mid-scroll, and
  // new arrivals can never shift an already-seen window (unlike offset).
  const after = String(req.query.after || '').slice(0, 64);
  const matched = all.filter((b) => (!state || b.state === state) && (!cat || b.category === cat));
  const base = after ? matched.filter((b) => String(b.id) < after) : matched;
  const start = after ? 0 : offset; // cursor takes precedence over offset
  // Newest first: reverse, window the page, then strip emails.
  const page = base.slice().reverse().slice(start, start + limit).map(publicListing);
  const hasMore = start + limit < base.length;
  res.json({
    total: all.length,
    offset: start,
    limit,
    hasMore,
    nextCursor: hasMore && page.length ? page[page.length - 1].id : null,
    listings: page,
  });
}));

app.post('/api/backlinks', ah(async (req, res) => {
  // Anti-spam: per-IP submission quota (shared logic with the Workers deploy).
  const rlKey = clientKey(req.headers, req.socket && req.socket.remoteAddress);
  const rl = await checkSubmission({ key: rlKey, store: backlinkRateStore });
  if (!rl.ok) {
    const msg = rl.reason === 'gap'
      ? 'Please wait at least 30 seconds between submissions.'
      : 'Submission limit reached for this hour (3 per hour per IP) — please try again later.';
    return res.status(429).json({ error: msg });
  }

  const b = req.body || {};
  const name = clean(b.name, 80);
  const website = validUrl(clean(b.website, 300));
  const email = clean(b.email, 120);
  const state = AU_STATES.includes((b.state || '').toUpperCase()) ? b.state.toUpperCase() : '';
  const category = CATEGORIES.includes(b.category) ? b.category : 'Other';
  const description = clean(b.description, 400);
  const lookingFor = clean(b.lookingFor, 200);

  if (!name || name.length < 2) return res.status(400).json({ error: 'Please enter your name or site name.' });
  if (!website) return res.status(400).json({ error: 'Please enter a valid website URL.' });
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Please enter a valid contact email.' });
  if (!state) return res.status(400).json({ error: 'Please choose your Australian state or territory.' });
  if (!description || description.length < 20) return res.status(400).json({ error: 'Please describe your site in at least 20 characters.' });

  const list = loadBacklinks();
  const host = new URL(website).hostname.replace(/^www\./, '');
  if (list.some((x) => new URL(x.website).hostname.replace(/^www\./, '') === host)) {
    return res.status(409).json({ error: 'That website is already listed.' });
  }
  if (list.length >= 500) return res.status(400).json({ error: 'Directory is full at the moment \u2014 please try again later.' });

  const entry = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name, website, email, state, category, description, lookingFor,
    addedAt: new Date().toISOString().slice(0, 10),
  };
  list.push(entry);
  saveBacklinks(list);
  // Count the attempt against the quota only after the submission succeeded.
  await checkSubmission({ key: rlKey, store: backlinkRateStore, record: true });
  res.json({ ok: true, entry: publicListing(entry) });
}));

// ---------- 404s: branded page for URLs, JSON for API paths ----------
app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: `No such endpoint: ${req.method} ${req.path}` });
  }
  res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
});

// ---------- JSON error middleware: every failure returns JSON, never HTML/empty ----------
app.use((err, req, res, _next) => {
  const status = err.status || err.statusCode || 400;
  console.error(`[api error] ${req.method} ${req.originalUrl}: ${err.message}`);
  if (!res.headersSent) res.status(status).json({ error: err.message || 'Something went wrong.' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`OzSEO Toolkit running on http://0.0.0.0:${PORT}`);
}).on('error', (err) => {
  // Bind failures (EADDRINUSE, EACCES…) must exit non-zero so launchers like
  // start.sh can detect the failure instead of waiting on a dead process.
  console.error(`FATAL: could not bind port ${PORT}: ${err.message}`);
  process.exit(1);
});
