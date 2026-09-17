'use strict';
/**
 * lib/drift.js — live-vs-repo drift comparison, runnable from inside the
 * deployed server itself (Node and Workers share this module).
 *
 * Where scripts/check-drift.js runs from a developer machine or CI and
 * derives its expectations from a local checkout, this module lets the
 * RUNNING server answer "am I still serving what the repo says?" on demand:
 * the repo-side expectations are fetched from the public GitHub repo at
 * raw.githubusercontent.com and compared against what this very process
 * serves. No parameters, no trust in the caller, read-only.
 *
 * Compared per page (and for the 404 page):
 *   - content fingerprint: title, meta description, h1-h3 headings, nav
 *     links and FAQPage JSON-LD Q&A — semantic, whitespace-insensitive
 *   - full rendered text: sha256 of the normalized text when identical,
 *     otherwise a bounded similarity percentage (catches wholesale
 *     divergence like a stale deploy; targeted wording is the fingerprint's job)
 * Plus robots.txt rules, sitemap <loc> set, and the security headers on the
 * HTML response (Worker deployments report them from the same constants that
 * wrap every response, so the comparison is real there too).
 *
 * Runtime-agnostic: uses only fetch/JSON — no Node built-ins — so the same
 * file is required by server.js and bundled into worker.js by wrangler.
 * CommonJS export (module.exports), like every other lib/ module: Node
 * requires it directly, and wrangler interops it into the ESM worker.
 */

const REPO_OWNER = 'navi45-pixel';
const REPO_NAME = 'oz-seo-toolkit';
const REPO_BRANCH = process.env.DRIFT_REPO_BRANCH || 'master';
const RAW_BASE = `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/${REPO_BRANCH}`;

// Pages fingerprinted (route -> file). 404.html is fetched separately.
const PAGES = [
  ['/', 'index.html'],
  ['/backlinks', 'backlinks.html'],
  ['/crawl', 'crawl.html'],
  ['/skills', 'skills.html'],
  ['/api', 'api.html'],
];

const REFETCH_TIMEOUT_MS = 15_000;
const SELF_TIMEOUT_MS = 15_000;

const fetchText = async (url, timeoutMs) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' });
  const text = await res.text();
  return { status: res.status, headers: res.headers, text };
};

// ---------- text/fingerprint extraction (mirrors scripts/check-drift.js) ----------

const decodeEntities = (s) =>
  s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&nbsp;/gi, ' ');

const text = (html) => decodeEntities(
  html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
).trim();

const sha256 = (s) => {
  // Workers-compatible SHA-256 (Web Crypto), hex-encoded.
  return crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)).then((buf) =>
    [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
  );
};

const truncate = (s) => (s.length > 70 ? s.slice(0, 67) + '…' : s);

const firstDiff = (a, b) => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) return `item ${i}: live ${JSON.stringify(a[i] ?? '(absent)')} ≠ repo ${JSON.stringify(b[i] ?? '(absent)')}`;
  }
  return null;
};

function fingerprint(html) {
  const pick = (re) => (html.match(re) || [])[1] || '';
  const headings = [];
  for (const m of html.matchAll(/<h([1-3])\b[^>]*>([\s\S]*?)<\/h\1>/gi)) headings.push(`h${m[1]}: ${text(m[2])}`);
  const nav = [];
  const navMatch = html.match(/<nav\b[^>]*>([\s\S]*?)<\/nav>/i);
  if (navMatch) {
    for (const a of navMatch[1].matchAll(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi)) nav.push(`${a[1]} ${text(a[2])}`);
  }
  const faq = [];
  for (const m of html.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const data = JSON.parse(m[1]);
      for (const node of Array.isArray(data) ? data : [data]) {
        for (const n of Array.isArray(node['@graph']) ? node['@graph'] : [node]) {
          if (String(n['@type'] || '').toLowerCase() !== 'faqpage') continue;
          for (const q of n.mainEntity || []) {
            faq.push(`Q: ${text(String(q.name || ''))}`);
            faq.push(`A: ${text(String((q.acceptedAnswer || {}).text || ''))}`);
          }
        }
      }
    } catch {
      faq.push('(unparseable JSON-LD)');
    }
  }
  return {
    title: pick(/<title[^>]*>([\s\S]*?)<\/title>/i),
    description: pick(/<meta\s+name="description"\s+content="([^"]*)"/i),
    headings,
    nav,
    faq,
  };
}

const fingerprintDiffs = (live, want) => {
  const out = [];
  if (live.title !== want.title) out.push(`title ${JSON.stringify(truncate(live.title))} ≠ repo ${JSON.stringify(truncate(want.title))}`);
  if (live.description !== want.description) out.push(`meta description ${JSON.stringify(truncate(live.description))} ≠ repo ${JSON.stringify(truncate(want.description))}`);
  if (live.headings.join('\n') !== want.headings.join('\n')) out.push(`headings differ — ${firstDiff(live.headings, want.headings)}`);
  if (live.nav.join('|') !== want.nav.join('|')) out.push(`nav links differ — ${firstDiff(live.nav, want.nav)}`);
  if (live.faq.join('|') !== want.faq.join('|')) out.push(`FAQ JSON-LD differs — ${firstDiff(live.faq, want.faq)}`);
  return out;
};

// Bounded longest-common-subsequence similarity (%) between two strings.
// Runs only when the normalized-text hashes differ; word-level with a
// head+tail window so a huge page cannot burn CPU budget on Workers (the
// normalized text has no newlines, so line-based splitting would always
// report 0%).
function similarityPct(a, b) {
  const MAX_WORDS = 600;
  const words = (s) => s.split(' ');
  const win = (w) => (w.length <= MAX_WORDS * 2 ? w : w.slice(0, MAX_WORDS).concat(w.slice(-MAX_WORDS)));
  const x = win(words(a));
  const y = win(words(b));
  let prev = new Array(y.length + 1).fill(0);
  for (let i = 1; i <= x.length; i++) {
    const cur = [0];
    for (let j = 1; j <= y.length; j++) {
      cur[j] = x[i - 1] === y[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    prev = cur;
  }
  const lcs = prev[y.length];
  const total = x.length + y.length || 1;
  return Math.round((2 * lcs * 100) / total);
}

// Full-text comparison: cheap hash when identical, bounded similarity when not.
async function compareText(liveHtml, repoHtml) {
  const liveT = text(liveHtml);
  const repoT = text(repoHtml);
  if (liveT === repoT) {
    return { ok: true, hash: await sha256(liveT), chars: liveT.length };
  }
  const pct = similarityPct(liveT, repoT);
  return {
    ok: pct >= 98,
    similarity: pct,
    repoHash: await sha256(repoT),
    liveHash: await sha256(liveT),
    liveChars: liveT.length,
    repoChars: repoT.length,
    note: 'full text differs — fingerprint says whether a meaningful section changed; low similarity usually means a stale deploy',
  };
}

// robots.txt: Sitemap line + Disallow rules must survive live.
const robotsDiffs = (liveText, repoText) => {
  const out = [];
  const wantSitemap = (repoText.match(/^sitemap:\s*(\S+)\s*$/im) || [])[1];
  if (wantSitemap && !new RegExp(`^sitemap:\\s*${wantSitemap.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'im').test(liveText)) {
    out.push(`missing "Sitemap: ${wantSitemap}"`);
  }
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const m of repoText.matchAll(/^disallow:\s*(\S+)\s*$/gim)) {
    if (!new RegExp(`^disallow:\\s*${esc(m[1])}\\s*$`, 'im').test(liveText)) out.push(`missing "Disallow: ${m[1]}"`);
  }
  return out;
};

// sitemap.xml: the repo's <loc> set must all be present live.
const sitemapDiffs = (liveText, repoText) => {
  const locs = (s) => [...s.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  const repoLocs = locs(repoText);
  const liveLocs = new Set(locs(liveText));
  const missing = repoLocs.filter((l) => !liveLocs.has(l));
  if (missing.length) return { ok: false, diffs: [`live sitemap missing: ${missing.join(', ')}`] };
  if (liveLocs.size !== repoLocs.length) return { ok: false, diffs: [`live has ${liveLocs.size} urls, repo has ${repoLocs.length}`] };
  return { ok: true, diffs: [] };
};

/**
 * Run the comparison. `origin` is the base URL the server serves itself on
 * (the caller knows its own address; every self-fetch goes there).
 *
 * `selfFetch` (optional, Workers): a Worker fetching its own workers.dev URL
 * does NOT re-enter the worker — Cloudflare answers the subrequest at the
 * edge with a 404 block page, which would read as total drift. Instead the
 * caller passes selfFetch(path) -> { status, headers, text } that resolves
 * the path through the same pipeline real requests flow through (assets
 * binding + security headers). Node leaves it unset and self-probes over
 * HTTP, which is a real round-trip there.
 */
async function runSelfDrift({ origin, selfFetch }) {
  const checkedAt = new Date().toISOString();
  const result = {
    checkedAt,
    origin,
    selfFetch: selfFetch ? 'binding' : 'network',
    repo: { source: 'github', repo: `${REPO_OWNER}/${REPO_NAME}`, ref: REPO_BRANCH, base: RAW_BASE },
    pages: [],
    robots: null,
    sitemap: null,
    notFoundPage: null,
    headers: null,
    ok: true,
  };

  // Self-fetch helper: caller-provided pipeline (Workers) or a real HTTP
  // round-trip to our own origin (Node).
  const selfGet = selfFetch
    ? (path) => Promise.resolve(selfFetch(path))
    : (path) => fetchText(origin + path, SELF_TIMEOUT_MS);

  // 1. Fetch all repo-side expectations first. If GitHub raw is unreachable
  //    (egress-restricted sandbox, offline demo), the whole check is honestly
  //    degraded rather than pretending everything is fine.
  const repo = {};
  const needed = ['robots.txt', 'sitemap.xml', '404.html', ...PAGES.map(([, f]) => f)];
  try {
    await Promise.all(needed.map(async (f) => {
      const r = await fetchText(`${RAW_BASE}/public/${f}`, REFETCH_TIMEOUT_MS);
      if (r.status !== 200) throw new Error(`repo file public/${f}: HTTP ${r.status}`);
      repo[f] = r.text;
    }));
  } catch (e) {
    return { ...result, ok: false, degraded: true, error: `repo-unreachable: ${e.message}`, note: 'The drift endpoint needs outbound HTTPS to raw.githubusercontent.com. Sandboxed or offline deployments cannot verify themselves this way — run scripts/check-drift.js from CI instead.' };
  }

  // 2. Compare each page the server actually serves against the repo file.
  for (const [route, file] of PAGES) {
    const entry = { route, liveStatus: 0, fingerprint: null, textHash: null };
    try {
      const live = await selfGet(route);
      entry.liveStatus = live.status;
      if (live.status !== 200) {
        entry.fingerprint = { ok: false, diffs: [`live status ${live.status}`] };
        entry.textHash = { ok: false };
      } else {
        const fpDiffs = fingerprintDiffs(fingerprint(live.text), fingerprint(repo[file]));
        entry.fingerprint = { ok: fpDiffs.length === 0, diffs: fpDiffs };
        entry.textHash = await compareText(live.text, repo[file]);
      }
    } catch (e) {
      entry.fingerprint = { ok: false, diffs: [`unreachable: ${e.message}`] };
      entry.textHash = { ok: false };
    }
    if (!entry.fingerprint.ok || !entry.textHash.ok) result.ok = false;
    result.pages.push(entry);
  }

  // 3. The 404 page (suggester routes change with the site).
  try {
    const live = await selfGet('/definitely-not-a-page');
    result.notFoundPage = { route: '/(404)', liveStatus: live.status };
    if (live.status !== 404) {
      result.notFoundPage.fingerprint = { ok: false, diffs: [`expected 404, got ${live.status}`] };
    } else {
      const fpDiffs = fingerprintDiffs(fingerprint(live.text), fingerprint(repo['404.html']));
      result.notFoundPage.fingerprint = { ok: fpDiffs.length === 0, diffs: fpDiffs };
      result.notFoundPage.textHash = await compareText(live.text, repo['404.html']);
    }
    if (!result.notFoundPage.fingerprint.ok || !result.notFoundPage.textHash?.ok) result.ok = false;
  } catch (e) {
    result.notFoundPage = { route: '/(404)', liveStatus: 0, fingerprint: { ok: false, diffs: [`unreachable: ${e.message}`] } };
    result.ok = false;
  }

  // 4. robots.txt and sitemap.xml.
  try {
    const live = await selfGet('/robots.txt');
    const diffs = live.status === 200 ? robotsDiffs(live.text, repo['robots.txt']) : [`live status ${live.status}`];
    result.robots = { liveStatus: live.status, ok: diffs.length === 0, diffs };
    if (diffs.length) result.ok = false;
  } catch (e) {
    result.robots = { liveStatus: 0, ok: false, diffs: [`unreachable: ${e.message}`] };
    result.ok = false;
  }
  try {
    const live = await selfGet('/sitemap.xml');
    const diffs = live.status === 200 ? sitemapDiffs(live.text, repo['sitemap.xml']).diffs : [`live status ${live.status}`];
    result.sitemap = { liveStatus: live.status, ok: diffs.length === 0, diffs };
    if (diffs.length) result.ok = false;
  } catch (e) {
    result.sitemap = { liveStatus: 0, ok: false, diffs: [`unreachable: ${e.message}`] };
    result.ok = false;
  }

  // 5. Security headers. Server.js applies them in middleware; the Worker
  //    wraps every response — but /api/health is the only HTML-cache-policy
  //    self-view this process can fetch through its full pipeline... pages on
  //    Workers come from the asset layer through withSecurityHeaders too, so
  //    probing a real page works on both runtimes.
  try {
    const live = await selfGet('/');
    const liveHeaders = {};
    for (const [k, v] of live.headers.entries()) liveHeaders[k.toLowerCase()] = v;
    // The canonical values live in lib/security-headers.js — but that module
    // is bundled into the server already; re-deriving them from the repo copy
    // would need another raw fetch, so the repo-side expectation here is the
    // module itself.
    const { SECURITY_HEADERS } = require('./security-headers.js');
    const missing = [];
    const different = [];
    for (const [h, want] of Object.entries(SECURITY_HEADERS)) {
      const got = liveHeaders[h] || '';
      if (!got) missing.push(h);
      else if (got !== want) different.push(h);
    }
    const cache = liveHeaders['cache-control'] || '';
    const cacheOk = cache.includes('max-age=0');
    result.headers = {
      probed: origin + '/',
      ok: missing.length === 0 && different.length === 0 && cacheOk,
      missing,
      different,
      cacheControl: cache,
      note: 'values compared against lib/security-headers.js, the single source shared by both runtimes',
    };
    if (!result.headers.ok) result.ok = false;
  } catch (e) {
    result.headers = { ok: false, error: e.message };
    result.ok = false;
  }

  return result;
}

module.exports = { runSelfDrift };
