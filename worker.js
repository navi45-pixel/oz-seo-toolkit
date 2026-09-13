/*
 * Cloudflare Workers entry — same audit engine as the Node server.
 * Deterministic checks (HTML parsing, schema, hreflang, robots, links…) give
 * IDENTICAL results to the Node version. Runtime-bound checks (raw DNS, TLS
 * cert inspection) degrade gracefully to "info" on Workers.
 * Deploy: npx wrangler deploy
 *
 * ES Module format (export default) — required so wrangler bundles the Node
 * built-ins used by the engine (dns/tls via nodejs_compat) instead of failing
 * with "Unexpected external import … assumed to be a Service Worker format".
 * The lib/ files stay CommonJS; the bundler interops them automatically.
 *
 * The backlink directory persists in the KV namespace bound as BACKLINKS
 * (whole JSON array under the key "backlinks" — the mirror of
 * data/backlinks.json on the Node server). Without the binding, the
 * directory endpoints return a descriptive 501; audits always work.
 */
import { runAudit } from './lib/audit.js';
import { runSpeedTest } from './lib/speed.js';
import { probePerformance } from './lib/perfprobe.js';
import { checkSubmission, clientKey } from './lib/ratelimit.js';
import { authorize } from './lib/admin.js';

const json = (obj, status = 200, extraHeaders = {}) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      ...extraHeaders,
    },
  });

// ---------- API: backlink directory (KV-backed) ----------
// Validation, error messages, dedupe and the 500-listing cap mirror
// server.js exactly, so both runtimes behave the same.
const AU_STATES = ['NSW', 'VIC', 'QLD', 'WA', 'SA', 'TAS', 'ACT', 'NT'];
const CATEGORIES = ['Blogger', 'Business', 'Directory', 'News / Media', 'Community', 'Other'];
const BACKLINKS_KEY = 'backlinks';
const BACKLINKS_LIMIT = 500;
const BACKLINKS_PAGE_DEFAULT = 50;
const BACKLINKS_PAGE_MAX = 100;

// Per-IP submission quota, persisted in the same KV namespace (counters
// auto-expire after the hour window via KV TTLs, so no manual cleanup).
const RL_MAX_PER_HOUR = 3;
const RL_MIN_GAP_MS = 30_000;

// Operator token: `npx wrangler secret put ADMIN_TOKEN`. Without the secret
// the moderation endpoints answer 503 (closed by default).
const adminAllowed = (request, env) => authorize(request.headers.get('authorization'), env.ADMIN_TOKEN || '');

async function handleAdmin(request, env, url) {
  const kv = env.BACKLINKS;
  if (!kv) return json({ error: 'Moderation requires the BACKLINKS KV namespace.' }, 501);
  const auth = adminAllowed(request, env);
  if (!auth.allowed) return json({ error: auth.error }, auth.status);

  const list = await loadBacklinks(kv);

  // GET /api/admin/listings — full records including emails.
  if (request.method === 'GET') {
    return json({ total: list.length, listings: list.slice().reverse() });
  }

  // DELETE /api/admin/listings/:id — remove a spam listing.
  if (request.method === 'DELETE') {
    const id = decodeURIComponent(url.pathname.split('/').pop() || '');
    const idx = list.findIndex((x) => x.id === id);
    if (idx === -1) return json({ error: 'No listing with that id.' }, 404);
    const [removed] = list.splice(idx, 1);
    await kv.put(BACKLINKS_KEY, JSON.stringify(list));
    backlinksCache = list; // same isolate: keep the cache coherent after writes
    backlinksCacheAt = Date.now();
    await purgeStripCache(request); // deleted listing gone from the strip immediately
    return json({ ok: true, removed: (({ email, ...pub }) => pub)(removed) });
  }

  return json({ error: 'Method not allowed.' }, 405);
}
function kvRateStore(kv) {
  return {
    async get(key) {
      const k = `rl:${key}`;
      const [lastAtStr, countStr] = await Promise.all([kv.get(k), kv.get(`${k}:n`)]);
      const lastAt = lastAtStr ? Number(lastAtStr) : 0;
      const count = countStr ? Number(countStr) : 0;
      if (lastAt && Date.now() - lastAt >= 3_600_000) return { lastAt: 0, count: 0 };
      return { lastAt, count };
    },
    async increment(key) {
      const k = `rl:${key}`;
      const prev = await this.get(key);
      const fresh = prev.lastAt === 0;
      const next = { lastAt: Date.now(), count: fresh ? 1 : prev.count + 1 };
      // TTL 2h (>= window) so abandoned counters disappear on their own.
      await Promise.all([
        kv.put(k, String(next.lastAt), { expirationTtl: 7200 }),
        kv.put(`${k}:n`, String(next.count), { expirationTtl: 7200 }),
      ]);
      return next;
    },
  };
}

const clean = (s, max) => String(s || '').replace(/[<>]/g, '').trim().slice(0, max);
function validUrl(u) {
  try {
    const p = new URL(/^https?:\/\//i.test(u) ? u : 'https://' + u);
    if (!p.hostname.includes('.')) return null;
    // Same normalization as server.js: strip UTM/tracking params, any query
    // string and the fragment — listings link to the clean canonical URL.
    p.hash = '';
    p.search = '';
    return p.href;
  } catch { return null; }
}

// The whole directory lives under one key. Cache it per-isolate with a short
// TTL (KV reads are billed per op and the directory is small); writes through
// this worker refresh the cache immediately, and out-of-band writes (e.g.
// `wrangler kv key put`) become visible within the TTL.
let backlinksCache = null;
let backlinksCacheAt = 0;
const BACKLINKS_CACHE_TTL_MS = 60_000;
async function loadBacklinks(kv) {
  if (backlinksCache && Date.now() - backlinksCacheAt < BACKLINKS_CACHE_TTL_MS) return backlinksCache;
  const raw = await kv.get(BACKLINKS_KEY);
  backlinksCache = raw ? JSON.parse(raw) : [];
  backlinksCacheAt = Date.now();
  return backlinksCache;
}

// ---------- Edge cache for the homepage strip ----------
// The homepage fetches /api/backlinks?limit=3 on every view; that exact
// request is served from the Workers edge Cache API for 5 minutes to cut KV
// reads. Any write through this worker purges the entry so a fresh
// submission appears on the next request. Other queries (filters, cursors,
// other page sizes) bypass the edge cache entirely.
const STRIP_LIMIT = 3;
const STRIP_TTL_SECONDS = 300;
const stripCacheKey = (request) =>
  new Request(new URL('/api/backlinks?limit=' + STRIP_LIMIT, request.url).toString(), { method: 'GET' });
const isStripRequest = (url, limit) =>
  limit === STRIP_LIMIT && !url.searchParams.get('after') && !url.searchParams.get('offset')
  && !url.searchParams.get('state') && !url.searchParams.get('category');

// Purge the cached strip after a successful write (POST/DELETE) so new
// listings appear immediately. Best-effort: a failed purge only costs
// freshness for the remaining TTL, never correctness.
async function purgeStripCache(request) {
  try {
    if (typeof caches !== 'undefined' && caches.default) {
      await caches.default.delete(stripCacheKey(request));
    }
  } catch { /* ignore — TTL bounds staleness */ }
}

async function handleBacklinks(request, env) {
  const kv = env.BACKLINKS;
  if (!kv) {
    return json({ error: 'The backlink directory needs persistent storage — bind a KV namespace or use the Node hosting. All audit tools work fully on Workers.' }, 501);
  }

  if (request.method === 'GET') {
    const url = new URL(request.url);
    const limit = Math.min(
      BACKLINKS_PAGE_MAX,
      Math.max(1, Math.floor(Number(url.searchParams.get('limit'))) || BACKLINKS_PAGE_DEFAULT)
    );

    // Homepage strip: serve from the edge cache when possible.
    if (isStripRequest(url, limit) && typeof caches !== 'undefined' && caches.default) {
      const cacheKey = stripCacheKey(request);
      const cached = await caches.default.match(cacheKey);
      if (cached) {
        return new Response(cached.body, {
          status: cached.status,
          headers: { ...Object.fromEntries(cached.headers), 'x-cache': 'HIT' },
        });
      }
    }

    const all = await loadBacklinks(kv);
    const state = (url.searchParams.get('state') || '').toUpperCase();
    const cat = url.searchParams.get('category') || '';
    const offset = Math.max(0, Math.floor(Number(url.searchParams.get('offset'))) || 0);
    // Cursor pagination: `after=<id>` returns listings strictly older than
    // that id (ids begin with a Base36 timestamp, so string comparison = age
    // order). Stable under concurrent insertions and anchor deletion.
    const after = String(url.searchParams.get('after') || '').slice(0, 64);
    const matched = all.filter((b) => (!state || b.state === state) && (!cat || b.category === cat));
    const base = after ? matched.filter((b) => String(b.id) < after) : matched;
    const start = after ? 0 : offset; // cursor takes precedence over offset
    // Newest first: reverse, window the page, then strip submitter emails —
    // they stay in storage and never appear in API responses.
    const page = base.slice().reverse().slice(start, start + limit).map(({ email, ...pub }) => pub);
    const hasMore = start + limit < base.length;
    const stripHit = isStripRequest(url, limit);
    const response = json(
      { total: all.length, offset: start, limit, hasMore, nextCursor: hasMore && page.length ? page[page.length - 1].id : null, listings: page },
      200,
      stripHit
        ? { 'x-cache': 'MISS', 'cache-control': `public, max-age=${STRIP_TTL_SECONDS}` }
        : {}
    );
    if (stripHit && typeof caches !== 'undefined' && caches.default) {
      // Store for the next 5 minutes (same-colo put is fast; awaiting keeps
      // ordering simple without an execution context).
      await caches.default.put(stripCacheKey(request), response.clone());
    }
    return response;
  }

  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed. Use GET to read the directory or POST to add a listing.' }, 405);
  }

  // Anti-spam: per-IP submission quota (shared logic with the Node server).
  const rlKey = clientKey(request.headers, 'unknown');
  const rlStore = kvRateStore(kv);
  const rl = await checkSubmission({ key: rlKey, store: rlStore });
  if (!rl.ok) {
    const waitMs = rl.lastAt
      ? Math.max(1000, (rl.reason === 'gap' ? RL_MIN_GAP_MS : 3_600_000) - (Date.now() - rl.lastAt))
      : 60_000;
    const msg = rl.reason === 'gap'
      ? 'Please wait at least 30 seconds between submissions.'
      : 'Submission limit reached for this hour (3 per hour per IP) — please try again later.';
    return json({ error: msg }, 429, { 'retry-after': String(Math.ceil(waitMs / 1000)) });
  }

  let body;
  try { body = await request.json(); } catch { body = {}; }
  const b = body || {};

  const name = clean(b.name, 80);
  const website = validUrl(clean(b.website, 300));
  const email = clean(b.email, 120);
  const state = AU_STATES.includes((b.state || '').toUpperCase()) ? b.state.toUpperCase() : '';
  const category = CATEGORIES.includes(b.category) ? b.category : 'Other';
  const description = clean(b.description, 400);
  const lookingFor = clean(b.lookingFor, 200);

  if (!name || name.length < 2) return json({ error: 'Please enter your name or site name.' }, 400);
  if (!website) return json({ error: 'Please enter a valid website URL.' }, 400);
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: 'Please enter a valid contact email.' }, 400);
  if (!state) return json({ error: 'Please choose your Australian state or territory.' }, 400);
  if (!description || description.length < 20) return json({ error: 'Please describe your site in at least 20 characters.' }, 400);

  const list = await loadBacklinks(kv);
  const host = new URL(website).hostname.replace(/^www\./, '');
  const dupe = list.some((x) => {
    try { return new URL(x.website).hostname.replace(/^www\./, '') === host; } catch { return false; }
  });
  if (dupe) return json({ error: 'That website is already listed.' }, 409);
  if (list.length >= BACKLINKS_LIMIT) {
    return json({ error: 'Directory is full at the moment — please try again later.' }, 400);
  }

  const entry = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name, website, email, state, category, description, lookingFor,
    addedAt: new Date().toISOString().slice(0, 10),
  };
  list.push(entry);
  await kv.put(BACKLINKS_KEY, JSON.stringify(list));
  backlinksCache = list; // same isolate: keep the cache coherent after writes
  backlinksCacheAt = Date.now();
  await purgeStripCache(request); // fresh submissions visible immediately
  // Count the attempt against the quota only after the submission succeeded.
  await checkSubmission({ key: rlKey, store: rlStore, record: true });
  return json({ ok: true, entry: (({ email, ...pub }) => pub)(entry) });
}

// Security headers applied to every response (mirrored in server.js).
// CSP matches the site's reality: inline styles/scripts only, no external resources.
const SECURITY_HEADERS = {
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  'content-security-policy': [
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
const withSecurityHeaders = (res) => {
  // Responses from env.ASSETS.fetch() have immutable headers in workerd —
  // clone into a fresh Response instead of mutating.
  const h = new Headers(res.headers);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) h.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/api/health') return withSecurityHeaders(json({ ok: true, runtime: 'cloudflare-workers' }));
      if (url.pathname === '/api/audit') return withSecurityHeaders(json(await runAudit(url.searchParams.get('url'))));
      if (url.pathname === '/api/perf') {
        const p = await probePerformance(url.searchParams.get('url'));
        return withSecurityHeaders(p ? json(p) : json({ error: 'Could not reach that site.' }, 400));
      }
      if (url.pathname === '/api/speed') {
        const strategy = url.searchParams.get('strategy') === 'desktop' ? 'desktop' : 'mobile';
        return withSecurityHeaders(json(await runSpeedTest(url.searchParams.get('url'), strategy)));
      }
      if (url.pathname.startsWith('/api/admin/listings')) return withSecurityHeaders(await handleAdmin(request, env, url));
      if (url.pathname.startsWith('/api/backlinks')) return withSecurityHeaders(await handleBacklinks(request, env));
      // Pages: fetch the original URL — the asset layer resolves clean
      // (extension-less) URLs itself. Fetching /backlinks.html instead would
      // 307 back to /backlinks and loop forever.
      const assetRes = await env.ASSETS.fetch(new Request(url.toString(), request));
      if (assetRes.status !== 404) return withSecurityHeaders(assetRes);
      // Missing asset: JSON 404 for API paths, branded 404 page otherwise.
      if (url.pathname.startsWith('/api/')) {
        return withSecurityHeaders(json({ error: `No such endpoint: ${request.method} ${url.pathname}` }, 404));
      }
      const nf = await env.ASSETS.fetch(new Request(new URL('/404', url).toString(), request));
      return withSecurityHeaders(new Response(nf.body, { status: 404, headers: nf.headers }));
    } catch (e) {
      return withSecurityHeaders(json({ error: e.message || 'Audit failed' }, 400));
    }
  },
};
