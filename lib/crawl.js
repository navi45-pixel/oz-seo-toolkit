'use strict';
/**
 * lib/crawl.js — adaptive site crawler for the OzSEO Toolkit.
 *
 * Capability map from the projects this is modelled on:
 *   - BeyondSEO (beyondtahir/beyondseo): evidence-first crawling — every page
 *     keeps status/redirect/timing/content observations, findings carry the
 *     affected URL, captured evidence, a fix and an acceptance check; limits
 *     are reported in the result so the report is never over-interpreted.
 *   - Scrapling (d4vinci/Scrapling): adaptive fetch discipline — robots.txt
 *     compliance (with Crawl-delay), per-host AutoThrottle that backs off when
 *     the site slows or blocks us and speeds back up afterwards, block/challenge
 *     detection, and Retry-After honouring.
 *
 * Runtime: identical on Node and Cloudflare Workers (fetch + cheerio only).
 * Politeness: sequential requests, honest User-Agent, robots.txt obeyed by
 * default, query-string URLs skipped (anti crawl-trap), same-host only.
 *
 * Input  : runCrawl(url, { maxPages, depth })
 * Output : { url, host, fetchedAt, limits, source, pages[], stats, throttle,
 *            findings[], score, summary }
 */

const DEFAULT_MAX_PAGES = 10;
const HARD_MAX_PAGES = 25;      // also keeps Workers under the subrequest budget
const MAX_DEPTH = 5;
const REQUEST_TIMEOUT_MS = 20_000;
const DEADLINE_MS = 45_000;     // stay under the Node route's 50s timeout
const BASE_DELAY_MS = 350;      // AutoThrottle floor
const MAX_DELAY_MS = 8_000;     // AutoThrottle ceiling
const MAX_SITEMAP_SEED = 200;
const MAX_HTML_CHARS = 600_000; // evidence cap per page (CPU-friendly on Workers)
const SUBREQUEST_BUDGET = 45;   // Workers free tier allows 50 per invocation
const UA = 'Mozilla/5.0 (compatible; OzSEOCrawler/1.0; +https://oz-seo-toolkit.multani-navdeep29.workers.dev/crawl)';
const ROBOT_TOKEN = 'ozseocrawler';

let cheerio = null;
try { cheerio = require('cheerio'); } catch { /* parsing degrades gracefully */ }

/* ------------------------------------------------------------------ */
/* URL helpers                                                         */
/* ------------------------------------------------------------------ */

const stripWww = (h) => h.replace(/^www\./i, '');

function normalizeSeed(input) {
  let u = String(input || '').trim();
  if (!u) throw new Error('Please enter a website URL to crawl.');
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  let parsed;
  try { parsed = new URL(u); } catch {
    throw new Error('That does not look like a valid URL. Try something like yoursite.com.au');
  }
  if (!parsed.hostname.includes('.')) throw new Error('That does not look like a valid public website URL.');
  parsed.hash = '';
  return parsed;
}

/** Private / loopback / metadata hosts must never be crawled (SSRF guard). */
function isForbiddenHost(hostname) {
  const h = String(hostname).toLowerCase().replace(/\.$/, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (!h.includes('.')) return true; // e.g. "intranet", "localhost", bare names
  if (h === '169.254.169.254' || h.endsWith('.internal.example.com')) return true;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true; // link-local incl. cloud metadata
    if (a >= 224) return true;               // multicast/reserved
  }
  return false;
}

/** Canonical crawl key: lowercase host, no hash, no trailing slash dupes. */
function crawlKey(urlStr) {
  try {
    const u = new URL(urlStr);
    u.hash = '';
    let s = u.toString();
    if (s.endsWith('/')) s = s.slice(0, -1);
    return s.toLowerCase();
  } catch { return String(urlStr).toLowerCase(); }
}

/* ------------------------------------------------------------------ */
/* robots.txt (Scrapling-style compliance)                             */
/* ------------------------------------------------------------------ */

function parseRobots(txt) {
  const groups = [];
  let current = null;
  let lastWasAgent = false;
  for (const raw of String(txt).split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const m = line.match(/^([a-z-]+):\s*(.*)$/i);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim();
    if (key === 'user-agent') {
      if (!current || !lastWasAgent) { current = { agents: [], allow: [], disallow: [], crawlDelay: 0 }; groups.push(current); }
      current.agents.push(val.toLowerCase());
      lastWasAgent = true;
    } else if (key === 'disallow' && current) {
      if (val) current.disallow.push(val);
      lastWasAgent = false;
    } else if (key === 'allow' && current) {
      if (val) current.allow.push(val);
      lastWasAgent = false;
    } else if (key === 'crawl-delay' && current) {
      const n = parseFloat(val);
      if (Number.isFinite(n) && n > 0) current.crawlDelay = Math.min(n, 30);
      lastWasAgent = false;
    } else if (key === 'sitemap') {
      // global directive — collect on a synthetic group
      let g = groups.find((x) => x.agents.includes('*sitemap*'));
      if (!g) { g = { agents: ['*sitemap*'], allow: [], disallow: [], crawlDelay: 0, sitemaps: [] }; groups.push(g); }
      g.sitemaps.push(val);
      lastWasAgent = false;
    }
  }
  return groups;
}

/** Google-style path match: longest rule wins, Allow wins exact ties. */
function robotsPathMatches(rule, path) {
  // Support leading/trailing and inline '*' wildcards; '$' anchor.
  const anchor = rule.endsWith('$');
  let pattern = rule.replace(/\$/g, '').split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^?]*');
  // (query strings are already stripped from candidate paths before matching)
  const re = new RegExp('^' + pattern + (anchor ? '$' : ''));
  return re.test(path);
}

function robotsDecision(groups, urlStr) {
  const u = new URL(urlStr);
  const path = u.pathname; // query-less candidates only
  const usable = groups.filter((g) => g.agents.some((a) => a !== '*sitemap*' && (a === '*' || ROBOT_TOKEN.includes(a) || a.includes(ROBOT_TOKEN))));
  // Named group for us wins over '*'; among groups, the longest matching agent token wins.
  let group = null;
  for (const g of usable) {
    for (const a of g.agents) {
      if (a !== '*' && (ROBOT_TOKEN.includes(a) || a.includes(ROBOT_TOKEN))) {
        if (!group || a.length > group._best) { group = g; group._best = a.length; }
      }
    }
  }
  if (!group) group = usable.find((g) => g.agents.includes('*')) || null;
  if (!group) return { allowed: true, mentioned: false, crawlDelay: 0 };
  const rules = [
    ...group.allow.map((p) => ({ p, allow: true })),
    ...group.disallow.map((p) => ({ p, allow: false })),
  ].map((r) => ({ ...r, len: r.p.length })).filter((r) => robotsPathMatches(r.p, path));
  if (!rules.length) return { allowed: true, mentioned: group.agents.some((a) => a !== '*'), crawlDelay: group.crawlDelay };
  rules.sort((x, y) => y.len - x.len || (x.allow ? -1 : 1));
  return { allowed: rules[0].allow, mentioned: true, crawlDelay: group.crawlDelay };
}

/* ------------------------------------------------------------------ */
/* fetching with timeout + subrequest budget                           */
/* ------------------------------------------------------------------ */

function fetchT(url, opts = {}, ms = REQUEST_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...opts, signal: ctrl.signal, redirect: 'follow', headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', ...(opts.headers || {}) } })
    .finally(() => clearTimeout(t));
}

const BLOCK_MARKERS = ['just a moment', 'cf-browser-verification', 'cf_challenge', 'captcha', 'attention required', 'checking your browser', 'access denied', 'request blocked'];

function detectBlock(status, bodyHead) {
  if (status === 403 || status === 429 || status === 503) return true;
  if (!bodyHead) return false;
  const hay = bodyHead.slice(0, 2500).toLowerCase();
  return BLOCK_MARKERS.some((mk) => hay.includes(mk));
}

/* ------------------------------------------------------------------ */
/* page evidence capture                                               */
/* ------------------------------------------------------------------ */

function extractEvidence(html, res, requestedUrl, ttfbMs) {
  const finalUrl = res.url || requestedUrl;
  const page = {
    url: requestedUrl,
    finalUrl,
    redirected: normalizeForCompare(finalUrl) !== normalizeForCompare(requestedUrl),
    status: res.status,
    ttfbMs,
    contentType: res.headers.get('content-type') || '',
    sizeKb: 0,
    title: '', titleLen: 0,
    metaDescription: '', descriptionLen: 0,
    canonical: '',
    h1Count: 0, h1: '',
    words: 0,
    lang: '',
    viewport: false,
    robotsMeta: '',
    noindex: false,
    nofollow: false,
    images: 0, imagesMissingAlt: 0,
    internalLinks: 0, externalLinks: 0,
    compression: res.headers.get('content-encoding') || 'none',
    cacheControl: res.headers.get('cache-control') || '',
    links: [],
  };
  if (!cheerio || !/text\/html|application\/xhtml/i.test(page.contentType)) return page;

  const htmlCut = html.length > MAX_HTML_CHARS ? html.slice(0, MAX_HTML_CHARS) : html;
  const $ = cheerio.load(htmlCut);
  page.sizeKb = Math.round(new TextEncoder().encode(htmlCut).length / 1024);

  page.title = ($('head title').first().text() || '').replace(/\s+/g, ' ').trim();
  page.titleLen = page.title.length;
  page.metaDescription = ($('meta[name="description"]').attr('content') || '').replace(/\s+/g, ' ').trim();
  page.descriptionLen = page.metaDescription.length;
  page.canonical = ($('link[rel="canonical"]').attr('href') || '').trim();
  page.h1Count = $('h1').length;
  page.h1 = ($('h1').first().text() || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  page.lang = (htmlCut.match(/<html[^>]*\slang=["']?([a-zA-Z-]{2,10})/i) || [])[1] || '';
  page.viewport = $('meta[name="viewport"]').length > 0;
  const robotsMeta = ($('meta[name="robots"]').attr('content') || '').toLowerCase();
  const xrobots = (res.headers.get('x-robots-tag') || '').toLowerCase();
  page.robotsMeta = robotsMeta || xrobots;
  page.noindex = /noindex/.test(robotsMeta) || /noindex/.test(xrobots);
  page.nofollow = /nofollow/.test(robotsMeta) || /nofollow/.test(xrobots);

  $('img').each((_, el) => {
    page.images++;
    const alt = $(el).attr('alt');
    if (alt == null || !String(alt).trim()) page.imagesMissingAlt++;
  });

  const baseHost = stripWww(new URL(finalUrl).hostname.toLowerCase());
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') || '';
    if (/^(mailto:|tel:|javascript:|#)/i.test(href)) return;
    let abs;
    try { abs = new URL(href, page.finalUrl).toString(); } catch { return; }
    const pu = new URL(abs);
    pu.hash = '';
    if (pu.protocol !== 'http:' && pu.protocol !== 'https:') return;
    const host = stripWww(pu.hostname.toLowerCase());
    if (host === baseHost) {
      page.internalLinks++;
      if (!pu.search && pu.pathname) page.links.push(pu.toString());
    } else {
      page.externalLinks++;
    }
  });

  $('script,style,noscript').remove();
  const words = ($('body').text() || '').replace(/\s+/g, ' ').trim();
  page.words = words ? words.split(' ').filter((w) => w.length > 1).length : 0;
  return page;
}

function normalizeForCompare(u) {
  try { const x = new URL(u); x.hash = ''; let s = x.toString(); return s.endsWith('/') ? s.slice(0, -1) : s; } catch { return u; }
}

/* ------------------------------------------------------------------ */
/* main crawl                                                          */
/* ------------------------------------------------------------------ */

async function runCrawl(input, opts = {}) {
  const startedAt = Date.now();
  const seed = normalizeSeed(input);
  if (isForbiddenHost(seed.hostname)) throw new Error('Private, loopback and metadata hosts cannot be crawled — enter a public website URL.');

  const maxPages = Math.min(HARD_MAX_PAGES, Math.max(1, Math.floor(Number(opts.maxPages)) || DEFAULT_MAX_PAGES));
  const maxDepth = Math.min(MAX_DEPTH, Math.max(1, Math.floor(Number(opts.depth)) || 3));
  const host = stripWww(seed.hostname.toLowerCase());
  const origin = seed.origin;

  const limits = {
    maxPages, maxDepth,
    requested: maxPages,
    crawled: 0, failed: 0,
    queuedAtStop: 0,
    duplicateSkipped: 0, offsiteSkipped: 0, querySkipped: 0, disallowedSkipped: 0,
    stopReason: 'page-budget',
    parsing: cheerio ? 'cheerio' : 'unavailable',
  };
  const source = {
    robots: { found: false, url: origin + '/robots.txt', sitemaps: [], note: '' },
    sitemap: { found: false, urls: 0, seeded: 0, note: '' },
  };
  const throttle = { initialDelayMs: BASE_DELAY_MS, finalDelayMs: BASE_DELAY_MS, maxDelayMs: MAX_DELAY_MS, backoffs: 0, retryAfterMs: 0 };
  const pages = [];
  const stats = {
    ok: 0, redirects: 0, unreachable: 0, clientErrors: 0, serverErrors: 0, blocked: 0,
    avgTtfbMs: 0, avgWords: 0,
    missingTitles: 0, missingDescriptions: 0, missingCanonicals: 0,
    multipleH1: 0, missingAltImages: 0, noindex: 0, noViewport: 0, noLang: 0,
  };
  const findings = [];
  let subrequests = 0;
  let delayMs = BASE_DELAY_MS;
  const budgetLeft = () => SUBREQUEST_BUDGET - subrequests > 0 && Date.now() - startedAt < DEADLINE_MS;

  const addFinding = (severity, check, evidence, fix, accept, url) => {
    findings.push({ severity, check, url: url || '', evidence, fix, accept });
  };

  const seen = new Set();
  seen.add(crawlKey(seed.toString())); // never re-crawl the seed via links
  const queue = [{ url: seed.toString(), depth: 0 }];
  const disallowCache = new Map();

  /* ---- 1. robots.txt ---- */
  let robotsGroups = [];
  try {
    subrequests++;
    const rr = await fetchT(source.robots.url, {}, 10_000);
    if (rr.status === 200) {
      const txt = await rr.text();
      robotsGroups = parseRobots(txt);
      source.robots.found = true;
      const smGroup = robotsGroups.find((g) => g.agents.includes('*sitemap*'));
      if (smGroup) source.robots.sitemaps = smGroup.sitemaps.slice(0, 5);
    } else if (rr.status === 401 || rr.status === 403) {
      source.robots.note = `robots.txt returned ${rr.status} — conservatively treating the site as closed to crawlers.`;
    } else if (rr.status === 404) {
      source.robots.note = 'No robots.txt (fine for small sites; add one to declare your sitemap).';
    } else {
      source.robots.note = `robots.txt answered ${rr.status}.`;
    }
  } catch (e) {
    source.robots.note = `robots.txt unreachable (${e.name === 'AbortError' ? 'timeout' : 'network error'}) — continuing optimistically.`;
  }

  const robotsAllows = (urlStr) => {
    if (disallowCache.has(urlStr)) return disallowCache.get(urlStr);
    const d = robotsGroups.length ? robotsDecision(robotsGroups, urlStr) : { allowed: true, mentioned: false, crawlDelay: 0 };
    disallowCache.set(urlStr, d);
    return d;
  };
  if (robotsGroups.length) {
    const base = robotsAllows(origin + '/');
    if (base.crawlDelay > 0) {
      delayMs = Math.max(delayMs, Math.round(base.crawlDelay * 1000));
      throttle.initialDelayMs = delayMs;
    }
  }

  /* ---- 2. sitemap discovery (robots Sitemap: lines, else /sitemap.xml) ---- */
  const sitemapUrls = [];
  const candidates = source.robots.sitemaps.length ? source.robots.sitemaps.slice(0, 3) : [origin + '/sitemap.xml'];
  for (const smUrl of candidates) {
    if (!budgetLeft()) break;
    try {
      subrequests++;
      const sr = await fetchT(smUrl, {}, 10_000);
      if (sr.status !== 200) continue;
      const xml = (await sr.text()).slice(0, 2_000_000);
      if (!/<sitemapindex/i.test(xml)) {
        source.sitemap.found = true;
        const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]);
        for (const loc of locs) {
          if (sitemapUrls.length >= MAX_SITEMAP_SEED) break;
          try {
            const lu = new URL(loc);
            if (stripWww(lu.hostname.toLowerCase()) !== host) continue;
            if (lu.search) { limits.querySkipped++; continue; }
            if (lu.protocol !== 'https:' && lu.protocol !== 'http:') continue;
            sitemapUrls.push(lu.toString());
          } catch { /* ignore bad loc */ }
        }
        break;
      } else {
        // sitemap index: fetch up to 2 child sitemaps
        const childLocs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]).slice(0, 2);
        for (const child of childLocs) {
          if (!budgetLeft()) break;
          try {
            subrequests++;
            const cr = await fetchT(child, {}, 10_000);
            if (cr.status !== 200) continue;
            const cxml = (await cr.text()).slice(0, 2_000_000);
            source.sitemap.found = true;
            for (const m of cxml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)) {
              if (sitemapUrls.length >= MAX_SITEMAP_SEED) break;
              try {
                const lu = new URL(m[1]);
                if (stripWww(lu.hostname.toLowerCase()) !== host || lu.search) continue;
                sitemapUrls.push(lu.toString());
              } catch { /* ignore */ }
            }
          } catch { /* ignore child failures */ }
        }
        break;
      }
    } catch { /* try next candidate */ }
  }
  if (source.sitemap.found) {
    const uniqueSitemap = [...new Set(sitemapUrls.map(crawlKey))].map((k) => sitemapUrls.find((u) => crawlKey(u) === k));
    source.sitemap.urls = uniqueSitemap.length;
    for (const u of uniqueSitemap) {
      const k = crawlKey(u);
      if (seen.has(k)) { limits.duplicateSkipped++; continue; }
      seen.add(k);
      if (!robotsAllows(u).allowed) { limits.disallowedSkipped++; continue; }
      queue.push({ url: u, depth: 1, fromSitemap: true });
      source.sitemap.seeded++;
    }
  } else {
    source.sitemap.note = source.robots.sitemaps.length ? 'Sitemap listed in robots.txt could not be fetched.' : 'No sitemap found (checked robots.txt directives and /sitemap.xml).';
  }

  /* ---- 3. BFS with AutoThrottle ---- */
  while (queue.length && pages.length < maxPages && budgetLeft()) {
    const { url: pageUrl, depth } = queue.shift();
    const permission = robotsAllows(pageUrl);
    if (!permission.allowed) { limits.disallowedSkipped++; continue; }

    // AutoThrottle pause
    if (pages.length > 0 || source.sitemap.seeded) await new Promise((r) => setTimeout(r, delayMs));

    let res = null;
    const t0 = Date.now();
    try {
      subrequests++;
      res = await fetchT(pageUrl);
    } catch (e) {
      limits.failed++;
      pages.push({ url: pageUrl, finalUrl: pageUrl, redirected: false, status: 0, ttfbMs: Date.now() - t0, error: e.name === 'AbortError' ? 'timeout' : 'network error', depth });
      delayMs = Math.min(delayMs * 2, MAX_DELAY_MS);
      throttle.backoffs++;
      continue;
    }
    const ttfbMs = Date.now() - t0;
    const isHtml = /text\/html|application\/xhtml/i.test(res.headers.get('content-type') || '');
    let html = '';
    if (isHtml) { try { html = await res.text(); } catch { /* body read failure — status still recorded */ } }
    const blocked = detectBlock(res.status, html);
    const page = extractEvidence(html, res, pageUrl, ttfbMs);
    page.depth = depth;
    page.blocked = blocked;
    pages.push(page);
    limits.crawled++;

    // AutoThrottle: back off on trouble, ease off when healthy
    const retryAfter = parseFloat(res.headers.get('retry-after') || '');
    if (blocked || res.status >= 400) {
      delayMs = Math.min(delayMs * 2, MAX_DELAY_MS);
      throttle.backoffs++;
      if (Number.isFinite(retryAfter) && retryAfter > 0) {
        throttle.retryAfterMs = Math.max(throttle.retryAfterMs, Math.min(retryAfter * 1000, 10_000));
        delayMs = Math.max(delayMs, Math.min(retryAfter * 1000, 10_000));
      }
    } else {
      delayMs = Math.max(BASE_DELAY_MS, Math.round(Math.min(delayMs * 0.75, Math.max(ttfbMs, BASE_DELAY_MS))));
    }

    // queue links
    if (!page.nofollow && isHtml && !blocked && depth < maxDepth && pages.length + queue.length < maxPages + 40) {
      for (const link of page.links.slice(0, 60)) {
        const k = crawlKey(link);
        if (seen.has(k)) { limits.duplicateSkipped++; continue; }
        seen.add(k);
        const lu = new URL(link);
        if (stripWww(lu.hostname.toLowerCase()) !== host) { limits.offsiteSkipped++; continue; }
        if (lu.search) { limits.querySkipped++; continue; }
        if (!robotsAllows(link).allowed) { limits.disallowedSkipped++; continue; }
        queue.push({ url: link, depth: depth + 1 });
      }
    }
  }

  // Stop-reason honesty
  if (limits.crawled >= maxPages) limits.stopReason = 'page-budget';
  else if (SUBREQUEST_BUDGET - subrequests <= 0) limits.stopReason = 'subrequest-budget';
  else if (Date.now() - startedAt >= DEADLINE_MS) limits.stopReason = 'time-budget';
  else if (!queue.length) limits.stopReason = 'site-exhausted';
  limits.queuedAtStop = queue.length;

  throttle.finalDelayMs = delayMs;

  /* ---- 4. stats ---- */
  for (const p of pages) {
    if (p.error || p.status === 0) { stats.unreachable++; continue; }
    if (p.blocked) { stats.blocked++; continue; }
    if (p.status >= 200 && p.status < 300) {
      stats.ok++;
      if (p.redirected) stats.redirects++;
    } else if (p.status >= 400 && p.status < 500) stats.clientErrors++;
    else if (p.status >= 500) stats.serverErrors++;

    if (!p.titleLen) stats.missingTitles++;
    if (!p.descriptionLen) stats.missingDescriptions++;
    if (!p.canonical) stats.missingCanonicals++;
    if (p.h1Count > 1) stats.multipleH1++;
    if (p.imagesMissingAlt > 0) stats.missingAltImages++;
    if (!p.viewport) stats.noViewport++;
    if (!p.lang) stats.noLang++;
    if (p.noindex) stats.noindex++;
  }
  const okPages = pages.filter((p) => !p.error && p.status > 0 && !p.blocked);
  const avg = (arr) => (arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0);
  stats.avgTtfbMs = avg(okPages.map((p) => p.ttfbMs));
  stats.avgWords = avg(okPages.map((p) => p.words));

  /* ---- 5. findings (evidence → fix → acceptance check) ---- */
  const worst = (pred) => (pages.find(pred) || {}); // first affected page as evidence
  const unreachable = pages.filter((p) => p.error || p.status === 0);
  const broken = pages.filter((p) => !p.error && p.status >= 400 && !p.blocked);
  if (broken.length) {
    addFinding('high', 'Broken page', `${broken.length} page(s) answered ${broken.map((p) => p.status).join(', ')} — e.g. ${broken[0].url}`, 'Fix or redirect (301) every broken URL found in the table below; update internal links to point at the live URL.', 'Re-crawl: zero pages answer 4xx/5xx.', broken[0].url);
  }
  if (unreachable.length) {
    addFinding('high', 'Unreachable page', `${unreachable.length} page(s) timed out or failed — e.g. ${unreachable[0].url}`, 'Check server reliability/uptime for those URLs; slow pages lose rankings and users.', 'Re-crawl: every queued page answers within 20s.', unreachable[0].url);
  }
  if (stats.blocked) {
    addFinding('medium', 'Crawler blocked', `${stats.blocked} page(s) returned an anti-bot challenge or block (our crawler identifies itself honestly as OzSEOCrawler).`, 'Whitelist known good crawlers in your WAF/CDN rules — or verify the block is intentional; blocking benign crawlers hides your content from tools and some AI engines.', 'Re-crawl: zero challenge/block responses.', (pages.find((p) => p.blocked) || {}).url);
  }
  if (stats.missingTitles) {
    addFinding('high', 'Missing title tag', `${stats.missingTitles} page(s) have no <title> — e.g. ${worst((p) => !p.titleLen).url}`, 'Write a unique 30–60 character title per page with its main keyword near the front.', 'Re-crawl: every page reports a non-empty title.', worst((p) => !p.titleLen).url);
  }
  if (stats.missingDescriptions) {
    addFinding('medium', 'Missing meta description', `${stats.missingDescriptions} page(s) have no meta description — e.g. ${worst((p) => !p.descriptionLen).url}`, 'Add a unique 120–160 character description per page; it is your organic ad copy.', 'Re-crawl: zero missing descriptions.', worst((p) => !p.descriptionLen).url);
  }
  if (stats.missingCanonicals) {
    addFinding('medium', 'Missing canonical link', `${stats.missingCanonicals} page(s) declare no canonical URL — e.g. ${worst((p) => !p.canonical).url}`, 'Add <link rel="canonical"> to every indexable page to consolidate duplicate URLs.', 'Re-crawl: zero missing canonicals.', worst((p) => !p.canonical).url);
  }
  if (stats.multipleH1) {
    addFinding('low', 'Multiple H1 headings', `${stats.multipleH1} page(s) use more than one H1 — e.g. ${worst((p) => p.h1Count > 1).url}`, 'Keep one H1 per page summarising the topic; demote the rest to H2/H3.', 'Re-crawl: every page has exactly one H1.', worst((p) => p.h1Count > 1).url);
  }
  if (stats.missingAltImages) {
    addFinding('low', 'Images missing alt text', `${stats.missingAltImages} page(s) contain images without alt attributes — e.g. ${worst((p) => p.imagesMissingAlt > 0).url}`, 'Describe every meaningful image in its alt attribute (decorative images get alt="").', 'Re-crawl: zero images missing alt.', worst((p) => p.imagesMissingAlt > 0).url);
  }
  if (stats.noViewport) {
    addFinding('medium', 'No mobile viewport', `${stats.noViewport} page(s) lack <meta name="viewport"> — e.g. ${worst((p) => !p.viewport).url}`, 'Add <meta name="viewport" content="width=device-width, initial-scale=1.0"> for mobile-friendly rendering.', 'Re-crawl: zero pages without a viewport.', worst((p) => !p.viewport).url);
  }
  if (stats.noLang) {
    addFinding('low', 'No html lang attribute', `${stats.noLang} page(s) do not declare a language — e.g. ${worst((p) => !p.lang).url}`, 'Set <html lang="en-AU"> (or the correct locale) so engines and screen readers classify the page.', 'Re-crawl: zero pages without lang.', worst((p) => !p.lang).url);
  }
  if (stats.noindex) {
    addFinding('medium', 'noindex on crawled page', `${stats.noindex} page(s) carry a noindex directive — e.g. ${worst((p) => p.noindex).url}`, 'Remove noindex from pages you want ranked; keep it only on thank-you/admin pages.', 'Re-crawl: noindex only where intended.', worst((p) => p.noindex).url);
  }
  if (!source.sitemap.found && source.robots.found !== false) {
    addFinding('medium', 'No XML sitemap', 'No sitemap was found via robots.txt directives or /sitemap.xml.', 'Publish an XML sitemap and reference it from robots.txt (Sitemap: line).', 'Re-crawl: source.sitemap.found === true.');
  } else if (!source.robots.found) {
    addFinding('low', 'No robots.txt', 'No robots.txt was served at the root.', 'Add robots.txt declaring crawl rules and the Sitemap: line — it also keeps well-behaved AI crawlers honest.', 'Re-crawl: source.robots.found === true.');
  }

  /* ---- 6. score (site-level deductions, deterministic) ---- */
  let score = 100;
  const deductions = [
    [broken.length, 10], [unreachable.length, 10], [stats.blocked, 6],
    [stats.missingTitles, 8], [stats.missingDescriptions, 6], [stats.missingCanonicals, 4],
    [stats.multipleH1, 4], [stats.missingAltImages, 4], [stats.noViewport, 4],
    [stats.noLang, 2], [stats.noindex, 2],
    [!source.sitemap.found && pages.length > 1, 4],
    [!source.robots.found, 2],
  ];
  for (const [cond, amt] of deductions) if (cond) score -= amt;
  score = Math.max(0, Math.min(100, score));

  const problemBits = [];
  if (broken.length + unreachable.length) problemBits.push(`${broken.length + unreachable.length} broken/unreachable`);
  if (stats.missingTitles) problemBits.push(`${stats.missingTitles} missing titles`);
  if (stats.missingDescriptions) problemBits.push(`${stats.missingDescriptions} missing descriptions`);
  if (stats.missingAltImages) problemBits.push(`${stats.missingAltImages} pages with untagged images`);
  if (stats.blocked) problemBits.push(`${stats.blocked} blocked by anti-bot`);
  const summary = `Crawled ${limits.crawled} page${limits.crawled === 1 ? '' : 's'} of ${host} in ${((Date.now() - startedAt) / 1000).toFixed(1)}s (${source.sitemap.found ? `sitemap seeded ${source.sitemap.seeded} URL${source.sitemap.seeded === 1 ? '' : 's'}` : 'no sitemap found'}, stopped: ${limits.stopReason.replace('-', ' ')}) — ${problemBits.length ? problemBits.join(', ') : 'no significant issues found'}.`;

  return {
    url: seed.toString(),
    host,
    fetchedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    limits,
    source,
    throttle,
    pages,
    stats,
    findings,
    score,
    summary,
    runtime: typeof WebSocketPair !== 'undefined' ? 'cloudflare-workers' : 'node',
  };
}

module.exports = { runCrawl, parseRobots, robotsDecision, isForbiddenHost };
