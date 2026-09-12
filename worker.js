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

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
  });

// ---------- API: backlink directory (KV-backed) ----------
// Validation, error messages, dedupe and the 500-listing cap mirror
// server.js exactly, so both runtimes behave the same.
const AU_STATES = ['NSW', 'VIC', 'QLD', 'WA', 'SA', 'TAS', 'ACT', 'NT'];
const CATEGORIES = ['Blogger', 'Business', 'Directory', 'News / Media', 'Community', 'Other'];
const BACKLINKS_KEY = 'backlinks';
const BACKLINKS_LIMIT = 500;

const clean = (s, max) => String(s || '').replace(/[<>]/g, '').trim().slice(0, max);
function validUrl(u) {
  try {
    const p = new URL(/^https?:\/\//i.test(u) ? u : 'https://' + u);
    return p.hostname.includes('.') ? p.href : null;
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

async function handleBacklinks(request, env) {
  const kv = env.BACKLINKS;
  if (!kv) {
    return json({ error: 'The backlink directory needs persistent storage — bind a KV namespace or use the Node hosting. All audit tools work fully on Workers.' }, 501);
  }

  if (request.method === 'GET') {
    const url = new URL(request.url);
    const all = await loadBacklinks(kv);
    const state = (url.searchParams.get('state') || '').toUpperCase();
    const cat = url.searchParams.get('category') || '';
    const filtered = all.filter((b) => (!state || b.state === state) && (!cat || b.category === cat));
    return json({ total: all.length, listings: filtered.reverse() });
  }

  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed. Use GET to read the directory or POST to add a listing.' }, 405);
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
  return json({ ok: true, entry });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/api/health') return json({ ok: true, runtime: 'cloudflare-workers' });
      if (url.pathname === '/api/audit') return json(await runAudit(url.searchParams.get('url')));
      if (url.pathname === '/api/perf') {
        const p = await probePerformance(url.searchParams.get('url'));
        return p ? json(p) : json({ error: 'Could not reach that site.' }, 400);
      }
      if (url.pathname === '/api/speed') {
        const strategy = url.searchParams.get('strategy') === 'desktop' ? 'desktop' : 'mobile';
        return json(await runSpeedTest(url.searchParams.get('url'), strategy));
      }
      if (url.pathname.startsWith('/api/backlinks')) return handleBacklinks(request, env);
      // Pages
      let p = url.pathname;
      if (p === '/backlinks') p = '/backlinks.html';
      if (p === '/skills') p = '/skills.html';
      if (p === '/api') p = '/api.html';
      if (p !== url.pathname) {
        url.pathname = p;
        return env.ASSETS.fetch(new Request(url.toString(), request));
      }
      return env.ASSETS.fetch(request);
    } catch (e) {
      return json({ error: e.message || 'Audit failed' }, 400);
    }
  },
};
