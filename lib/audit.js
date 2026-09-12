'use strict';
/**
 * OzSEO Toolkit — full website audit engine
 * Powered by free open-source projects:
 *  - Express  (https://github.com/expressjs/express)
 *  - Cheerio  (https://github.com/cheeriojs/cheerio)
 * Plus free public APIs: Google PageSpeed Insights (Lighthouse), RDAP, DNS, TLS.
 */
const cheerio = require('cheerio');
/* Lazy Node builtins — keeps the engine loadable on Cloudflare Workers (nodejs_compat),
   where dns/tls may be missing; checks degrade to "info" there. */
let dnsp = null; try { dnsp = require('dns').promises; } catch { }
let tlsLib = null; try { tlsLib = require('tls'); } catch { }
const { runEnhancedChecks } = require('./enhanced');
const { runSkills2Checks } = require('./skills2');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 OzSEO-Audit/1.0';

const STOPWORDS = new Set(('a,an,the,and,or,but,if,then,else,when,while,of,at,by,for,with,about,against,between,into,through,during,before,after,above,below,to,from,up,down,in,out,on,off,over,under,again,further,once,here,there,all,any,both,each,few,more,most,other,some,such,no,nor,not,only,own,same,so,than,too,very,can,will,just,should,now,is,are,was,were,be,been,being,have,has,had,having,do,does,did,doing,would,could,might,must,shall,may,i,you,he,she,it,we,they,them,his,her,its,our,your,their,my,me,us,as,what,which,who,whom,this,that,these,those,am,also,than,into,onto,per,via,within,without,across,around,along,among,upon,get,got,like,one,two,new,you,yours,ours,ourselves,yourself,myself,itself,themselves,every,need,want,use,using,used').split(','));

const AU_STATES = {
  NSW: { name: 'New South Wales', cities: ['sydney', 'newcastle', 'wollongong', 'central coast', 'parramatta', 'penrith', 'wagga wagga'] },
  VIC: { name: 'Victoria', cities: ['melbourne', 'geelong', 'ballarat', 'bendigo', 'shepparton', 'mornington'] },
  QLD: { name: 'Queensland', cities: ['brisbane', 'gold coast', 'sunshine coast', 'cairns', 'townsville', 'toowoomba', 'mackay'] },
  WA: { name: 'Western Australia', cities: ['perth', 'fremantle', 'joondalup', 'bunbury', 'mandurah'] },
  SA: { name: 'South Australia', cities: ['adelaide', 'mount gambier', 'victor harbor'] },
  TAS: { name: 'Tasmania', cities: ['hobart', 'launceston', 'devonport'] },
  ACT: { name: 'Australian Capital Territory', cities: ['canberra', 'belconnen', 'tuggeranong'] },
  NT: { name: 'Northern Territory', cities: ['darwin', 'alice springs', 'palmerston'] },
};

const AI_CRAWLERS = [
  { bot: 'GPTBot', vendor: 'OpenAI \u2014 model training only' },
  { bot: 'OAI-SearchBot', vendor: 'OpenAI \u2014 ChatGPT Search citability' },
  { bot: 'ChatGPT-User', vendor: 'OpenAI \u2014 user-triggered browsing' },
  { bot: 'Google-Extended', vendor: 'Google \u2014 Gemini training only (not Search)' },
  { bot: 'ClaudeBot', vendor: 'Anthropic \u2014 model training only' },
  { bot: 'Claude-SearchBot', vendor: 'Anthropic \u2014 Claude search citability' },
  { bot: 'Claude-User', vendor: 'Anthropic \u2014 user-triggered browsing' },
  { bot: 'PerplexityBot', vendor: 'Perplexity AI search' },
  { bot: 'CCBot', vendor: 'Common Crawl \u2014 feeds most LLM training' },
  { bot: 'Amazonbot', vendor: 'Amazon' },
  { bot: 'Meta-ExternalAgent', vendor: 'Meta AI' },
  { bot: 'Applebot-Extended', vendor: 'Apple \u2014 Apple Intelligence training opt-out' },
  { bot: 'Bytespider', vendor: 'ByteDance \u2014 TikTok/Douyin AI' },
  { bot: 'cohere-ai', vendor: 'Cohere' },
];

function normalizeUrl(input) {
  let u = String(input || '').trim();
  if (!u) throw new Error('Please enter a website URL.');
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  try {
    const parsed = new URL(u);
    if (!parsed.hostname.includes('.')) throw new Error('bad host');
    return parsed.toString();
  } catch {
    throw new Error('That does not look like a valid URL. Try something like yoursite.com.au');
  }
}

function fetchT(url, opts = {}, ms = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...opts, signal: ctrl.signal, redirect: opts.redirect || 'follow' })
    .finally(() => clearTimeout(t));
}

function textOf($el) { return ($el.text() || '').replace(/\s+/g, ' ').trim(); }

function parseJsonLd($) {
  const types = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      let data = JSON.parse($(el).html() || '');
      if (!Array.isArray(data)) data = [data];
      const walk = (d) => {
        if (!d || typeof d !== 'object') return;
        if (Array.isArray(d)) { d.forEach(walk); return; }
        if (d['@type']) {
          const t = Array.isArray(d['@type']) ? d['@type'] : [d['@type']];
          t.forEach((x) => typeof x === 'string' && types.push(x));
        }
        if (d['@graph']) walk(d['@graph']);
      };
      walk(data);
    } catch { /* invalid JSON-LD noted elsewhere */ }
  });
  return types;
}

function robotsAllows(robotsTxt, botName) {
  // crude robots.txt parser: find the matching UA block, look for disallow /
  if (!robotsTxt) return { allowed: true, mentioned: false };
  const lines = robotsTxt.split(/\r?\n/);
  let inBlock = false, mentioned = false, disallows = [];
  for (const raw of lines) {
    const line = raw.trim();
    const m = line.match(/^user-agent:\s*(.+)$/i);
    if (m) {
      inBlock = m[1].trim().toLowerCase() === botName.toLowerCase();
      if (inBlock) mentioned = true;
      continue;
    }
    if (inBlock) {
      const d = line.match(/^disallow:\s*(\S*)$/i);
      if (d) disallows.push(d[1] || '');
    }
  }
  const blocked = disallows.some((p) => p === '' || p === '/');
  return { allowed: !blocked, mentioned };
}

function getSslInfo(host) {
  return new Promise((resolve) => {
    if (!tlsLib) return resolve(null);
    try {
      const socket = tlsLib.connect({ host, port: 443, servername: host, rejectUnauthorized: false }, () => {
        const cert = socket.getPeerCertificate(true);
        socket.end();
        if (!cert || !cert.valid_to) return resolve(null);
        const validTo = new Date(cert.valid_to);
        const daysLeft = Math.round((validTo - Date.now()) / 86400000);
        resolve({
          issuer: (cert.issuer && (cert.issuer.O || cert.issuer.CN)) || 'Unknown',
          validTo: validTo.toISOString().slice(0, 10),
          daysLeft,
          protocol: socket.getProtocol(),
        });
      });
      socket.setTimeout(8000, () => { socket.destroy(); resolve(null); });
      socket.on('error', () => resolve(null));
    } catch { resolve(null); }
  });
}

async function getRdap(host) {
  try {
    const res = await fetchT(`https://rdap.org/domain/${encodeURIComponent(host)}`, {}, 10000);
    if (!res.ok) return null;
    const data = await res.json();
    let registered = null, registrar = null;
    (data.events || []).forEach((e) => { if (e.eventAction === 'registration') registered = e.eventDate; });
    (data.entities || []).forEach((e) => {
      if ((e.roles || []).includes('registrar')) {
        const v = (e.vcardArray || [])[1] || [];
        const fn = v.find((x) => x[0] === 'fn');
        if (fn) registrar = fn[3];
      }
    });
    const ageYears = registered ? Math.round(((Date.now() - new Date(registered)) / 86400000) * 10) / 10 : null;
    return { registered: registered ? registered.slice(0, 10) : null, registrar, ageYears };
  } catch { return null; }
}

function syllables(word) {
  word = word.toLowerCase().replace(/[^a-z]/g, '');
  if (!word) return 0;
  if (word.length <= 3) return 1;
  word = word.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '').replace(/^y/, '');
  const m = word.match(/[aeiouy]{1,2}/g);
  return m ? m.length : 1;
}

function flesch(text) {
  const words = text.toLowerCase().match(/[a-z0-9']+/g) || [];
  const sentences = (text.match(/[.!?]+(\s|$)/g) || []).length || 1;
  if (words.length < 30) return null;
  const syl = words.reduce((s, w) => s + syllables(w), 0);
  const score = 206.835 - 1.015 * (words.length / sentences) - 84.6 * (syl / words.length);
  return Math.max(0, Math.min(100, Math.round(score)));
}

async function runAudit(input) {
  const target = normalizeUrl(input);
  const checks = [];
  const add = (group, name, status, message, fix = '') => checks.push({ group, name, status, message, fix });

  // ---------- 1. Fetch the page ----------
  let res, html = '', finalUrl = target, ttfb = null, headers = {}, status = 0;
  const t0 = Date.now();
  try {
    res = await fetchT(target, { headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml' } }, 25000);
    ttfb = Date.now() - t0;
    finalUrl = res.url || target;
    status = res.status;
    headers = Object.fromEntries(res.headers.entries());
    html = (await res.text() || '').slice(0, 3000000);
  } catch (e) {
    throw new Error(`Could not reach ${new URL(target).hostname} — ${e.name === 'AbortError' ? 'the request timed out (25s).' : e.message}`);
  }
  const $ = cheerio.load(html);
  let final; try { final = new URL(finalUrl); } catch { final = new URL(target); }
  const host = final.hostname;
  const origin = final.origin;
  const isHttps = final.protocol === 'https:';

  if (status >= 200 && status < 300) add('technical', 'HTTP status code', 'pass', `Server responded with ${status}.`);
  else if (status < 400) add('technical', 'HTTP status code', 'warn', `Server responded with ${status}.`, 'A homepage should normally return 200 after redirects.');
  else add('technical', 'HTTP status code', 'fail', `Server responded with ${status}.`, 'Fix the server response so the homepage returns 200 OK.');

  add('technical', 'HTTPS enabled', isHttps ? 'pass' : 'fail',
    isHttps ? 'The site is served over a secure HTTPS connection.' : 'The final URL is not using HTTPS.',
    isHttps ? '' : 'Install a free SSL certificate (e.g. Let\u2019s Encrypt) and force HTTPS.');

  const requestedHost = new URL(target).hostname;
  const redirectedToHttps = !/^https:/i.test(target) && isHttps;
  if (requestedHost === host) {
    // test http -> https redirect explicitly
    try {
      const r2 = await fetchT(`http://${host}/`, { redirect: 'follow' }, 10000);
      add('security', 'HTTP \u2192 HTTPS redirect', r2.url.startsWith('https:') ? 'pass' : 'fail',
        r2.url.startsWith('https:') ? 'Plain HTTP requests are redirected to HTTPS.' : 'HTTP traffic is not forced to HTTPS.',
        r2.url.startsWith('https:') ? '' : 'Add a 301 redirect from HTTP to HTTPS (server config or .htaccess).');
    } catch { add('security', 'HTTP \u2192 HTTPS redirect', 'info', 'Could not test the HTTP version of the site.'); }
  }

  // ---------- 2. Parallel background probes ----------
  const robotsUrl = `${origin}/robots.txt`;
  const sitemapGuess = `${origin}/sitemap.xml`;
  const llmsUrl = `${origin}/llms.txt`;
  const notFoundUrl = `${origin}/zz-404-check-${Math.random().toString(36).slice(2)}`;

  const pRobots = fetchT(robotsUrl, { headers: { 'User-Agent': UA } }, 10000).then((r) => (r.ok ? r.text() : null)).catch(() => null);
  const pLlms = fetchT(llmsUrl, { headers: { 'User-Agent': UA } }, 10000).then((r) => (r.ok ? { status: r.status, text: r.text() } : { status: r.status, text: null })).catch(() => null);
  const pSitemapGuess = fetchT(sitemapGuess, { headers: { 'User-Agent': UA } }, 10000).then((r) => ({ ok: r.ok, text: r.ok ? r.text() : '' })).catch(() => null);
  const p404 = fetchT(notFoundUrl, { headers: { 'User-Agent': UA } }, 10000).then((r) => r.status).catch(() => null);
  const pSsl = isHttps ? getSslInfo(host) : Promise.resolve(null);
  const pRdap = getRdap(host.replace(/^www\./, ''));
  const pDns = (async () => {
    const out = { a: [], aaaa: [], mx: [], ns: [], txt: [], dmarc: [] };
    if (!dnsp) return out;
    const bare = host.replace(/^www\./, '');
    try { out.a = await dnsp.resolve4(bare); } catch { out.a = []; }
    try { out.aaaa = await dnsp.resolve6(bare); } catch { out.aaaa = []; }
    try { out.mx = (await dnsp.resolveMx(bare)).map((m) => m.exchange); } catch { out.mx = []; }
    try { out.ns = await dnsp.resolveNs(bare); } catch { out.ns = []; }
    try { out.txt = (await dnsp.resolveTxt(bare)).map((r) => r.join('')); } catch { out.txt = []; }
    try { out.dmarc = (await dnsp.resolveTxt('_dmarc.' + bare)).map((r) => r.join('')); } catch { out.dmarc = []; }
    return out;
  })();

  // ---------- 3. On-page SEO ----------
  const title = textOf($('title').first());
  const metaDesc = ($('meta[name="description"]').attr('content') || '').trim();
  const metaKeywords = ($('meta[name="keywords"]').attr('content') || '').trim();
  const canonical = ($('link[rel="canonical"]').attr('href') || '').trim();
  const metaRobots = ($('meta[name="robots"]').attr('content') || '').toLowerCase();
  const lang = ($('html').attr('lang') || '').trim();
  const viewport = $('meta[name="viewport"]').length > 0;
  const h1s = $('h1');
  const charset = ($('meta[charset]').attr('charset') || ($('meta[http-equiv="Content-Type"]').attr('content') || ''));

  add('seo', 'Title tag', title ? (title.length >= 10 && title.length <= 60 ? 'pass' : 'warn') : 'fail',
    title ? `Found: \u201C${title}\u201D (${title.length} chars).` : 'No <title> tag found.',
    title ? (title.length < 10 ? 'Make the title more descriptive (30\u201360 characters is ideal).' : title.length > 60 ? 'Shorten the title to ~60 characters so Google doesn\u2019t truncate it.' : '') : 'Add a unique, keyword-rich <title> of 30\u201360 characters.');

  add('seo', 'Meta description', metaDesc ? (metaDesc.length >= 70 && metaDesc.length <= 160 ? 'pass' : 'warn') : 'fail',
    metaDesc ? `Found (${metaDesc.length} chars).` : 'No meta description found.',
    metaDesc ? (metaDesc.length > 160 ? 'Trim it to ~155 characters so it isn\u2019t cut off in search results.' : metaDesc.length < 70 ? 'Expand it to 120\u2013155 characters with a clear value proposition.' : '') : 'Write a compelling 120\u2013155 character meta description with your primary keyword.');

  add('seo', 'Meta keywords tag', metaKeywords ? 'warn' : 'pass',
    metaKeywords ? 'A meta keywords tag is present \u2014 Google ignores it and it can expose your strategy.' : 'No meta keywords tag (correct \u2014 Google ignores it).',
    metaKeywords ? 'Remove the meta keywords tag.' : '');

  add('seo', 'H1 heading', h1s.length === 1 ? 'pass' : h1s.length === 0 ? 'fail' : 'warn',
    h1s.length === 1 ? `Exactly one H1: \u201C${textOf(h1s.first()).slice(0, 90)}\u201D` : h1s.length === 0 ? 'No H1 heading found.' : `Found ${h1s.length} H1 tags \u2014 pages should usually have exactly one.`,
    h1s.length === 1 ? '' : 'Use exactly one H1 containing your primary keyword.');

  const headings = [];
  $('h1,h2,h3,h4,h5,h6').each((_, el) => headings.push({ tag: el.tagName, text: textOf($(el)).slice(0, 80) }));
  add('seo', 'Heading structure', headings.length > 2 ? 'pass' : 'warn',
    `${headings.length} headings found (${headings.filter(h => h.tag === 'h2').length} H2s).`,
    headings.length > 2 ? '' : 'Structure content with H2/H3 subheadings for readers and search engines.');

  add('seo', 'Canonical tag', canonical ? 'pass' : 'warn',
    canonical ? `Canonical: ${canonical}` : 'No canonical tag found.',
    canonical ? '' : 'Add <link rel="canonical"> to avoid duplicate-content issues.');

  if (/noindex/.test(metaRobots)) add('seo', 'Indexability', 'fail', 'The meta robots tag contains "noindex" \u2014 Google will not show this page.', 'Remove noindex from the meta robots tag.');
  else add('seo', 'Indexability', 'pass', 'Page is not blocked from indexing by meta robots.');

  add('seo', 'HTML lang attribute', lang ? 'pass' : 'warn',
    lang ? `lang="${lang}" declared.` : 'No lang attribute on <html>.',
    lang ? '' : 'Add lang="en-AU" for Australian targeting.');

  add('seo', 'Character encoding', charset ? 'pass' : 'warn',
    charset ? `Charset declared: ${charset}.` : 'No charset meta tag.',
    charset ? '' : 'Add <meta charset="utf-8"> in the <head>.');

  const hreflangs = $('link[hreflang]').map((_, el) => $(el).attr('hreflang')).get();
  add('seo', 'Hreflang (international targeting)', hreflangs.length ? 'pass' : 'info',
    hreflangs.length ? `Hreflang languages: ${hreflangs.join(', ')}` : 'No hreflang tags \u2014 fine if you target one market only.');

  // Images & alt text
  const imgs = $('img').length;
  const imgsNoAlt = $('img:not([alt]), img[alt=""]').length;
  add('seo', 'Image alt text', imgs === 0 ? 'info' : imgsNoAlt === 0 ? 'pass' : imgsNoAlt / imgs > 0.3 ? 'fail' : 'warn',
    imgs === 0 ? 'No images found on the page.' : `${imgs - imgsNoAlt}/${imgs} images have alt text.`,
    imgsNoAlt ? 'Add descriptive alt text to every image (include keywords where natural).' : '');

  // Links
  const links = { internal: 0, external: 0, nofollow: 0, empty: 0 };
  const internalHrefs = new Set();
  const externalSample = [];
  $('a[href]').each((_, el) => {
    const href = ($(el).attr('href') || '').trim();
    if (!href || href.startsWith('#') || href.startsWith('javascript:') || href.startsWith('mailto:') || href.startsWith('tel:')) { if (!href) links.empty++; return; }
    if ($(el).attr('rel')?.includes('nofollow')) links.nofollow++;
    try {
      const u = new URL(href, origin);
      if (u.hostname === host || u.hostname === host.replace(/^www\./, '') || host.replace(/^www\./, '') === u.hostname.replace(/^www\./, '')) {
        links.internal++;
        if (u.pathname !== final.pathname) internalHrefs.add(u.origin + u.pathname);
      } else {
        links.external++;
        if (externalSample.length < 8 && /^https?:/.test(u.protocol)) externalSample.push(u.toString());
      }
    } catch { /* ignore */ }
  });
  add('seo', 'Internal links', links.internal >= 3 ? 'pass' : 'warn',
    `${links.internal} internal links found.`,
    links.internal >= 3 ? '' : 'Add more internal links to help Google discover and prioritise your pages.');

  const favicon = $('link[rel*="icon"]').length > 0;
  add('seo', 'Favicon', favicon ? 'pass' : 'warn',
    favicon ? 'A favicon is declared.' : 'No favicon link tag found.',
    favicon ? '' : 'Add a favicon \u2014 it appears in Google mobile results and builds brand trust.');

  // Open Graph / social cards
  const og = { title: $('meta[property="og:title"]').attr('content'), desc: $('meta[property="og:description"]').attr('content'), image: $('meta[property="og:image"]').attr('content') };
  const twCard = $('meta[name="twitter:card"]').attr('content');
  add('seo', 'Open Graph tags', og.title && og.image ? 'pass' : og.title || og.desc ? 'warn' : 'fail',
    `og:title ${og.title ? '\u2713' : '\u2717'}  og:description ${og.desc ? '\u2713' : '\u2717'}  og:image ${og.image ? '\u2713' : '\u2717'}`,
    og.title && og.image ? '' : 'Add og:title, og:description and og:image so links shared on social/AI chat previews look great.');
  add('seo', 'Twitter/X card', twCard ? 'pass' : 'warn',
    twCard ? `twitter:card = ${twCard}` : 'No twitter:card meta tag.',
    twCard ? '' : 'Add twitter:card meta tags for better X/Twitter previews.');

  // ---------- 4. GEO / AI SEO ----------
  const schemaTypes = parseJsonLd($);
  const schemaSet = new Set(schemaTypes.map((t) => t.toLowerCase()));
  add('geo', 'Structured data (Schema.org / JSON-LD)', schemaTypes.length ? 'pass' : 'fail',
    schemaTypes.length ? `Found types: ${[...new Set(schemaTypes)].join(', ')}` : 'No JSON-LD structured data found.',
    schemaTypes.length ? '' : 'Add JSON-LD schema (Organization, LocalBusiness, Service, FAQPage). AI engines lean heavily on structured data to understand your business.');

  const hasLocalSchema = [...schemaSet].some((t) => /localbusiness|organization|store|service|attorney|dentist|medicalbusiness|realestateagent|plumber|electrician|restaurant/.test(t));
  add('geo', 'Business/Organization schema', hasLocalSchema ? 'pass' : 'warn',
    hasLocalSchema ? 'Business entity markup present \u2014 AI assistants can extract who you are.' : 'No business-type schema detected.',
    hasLocalSchema ? '' : 'Add LocalBusiness/Organization schema with name, address, phone, opening hours and areaServed.');

  const hasFaq = [...schemaSet].some((t) => /faqpage|question|article|blogposting/.test(t));
  add('geo', 'Question/answer content markup', hasFaq ? 'pass' : 'warn',
    hasFaq ? 'FAQ / Article markup detected. Note: Google retired FAQ rich results in May 2026, but FAQ-style content remains valuable for AI citations.' : 'No FAQ or Article markup.',
    hasFaq ? '' : 'Answer common customer questions in content and mark them up with Article/FAQPage schema for AI engines.');

  const semantic = ['main', 'nav', 'article', 'header', 'footer', 'section'].filter((t) => $(t).length > 0);
  add('geo', 'Semantic HTML structure', semantic.length >= 3 ? 'pass' : 'warn',
    `Semantic elements found: ${semantic.join(', ') || 'none'}.`,
    semantic.length >= 3 ? '' : 'Use <main>, <nav>, <article>, <header>, <footer> \u2014 both crawlers and LLMs parse semantic HTML better.');

  // robots.txt + AI crawlers
  const robotsTxt = await pRobots;
  add('technical', 'robots.txt', robotsTxt !== null ? 'pass' : 'warn',
    robotsTxt !== null ? 'robots.txt is present and reachable.' : 'No robots.txt found at /robots.txt.',
    robotsTxt !== null ? '' : 'Add a robots.txt file to guide crawlers and reference your sitemap.');

  let sitemapUrl = null;
  if (robotsTxt) {
    const m = robotsTxt.match(/^sitemap:\s*(\S+)/im);
    if (m) sitemapUrl = m[1];
  }
  let sitemapOk = false, sitemapText = '';
  if (sitemapUrl) {
    try { const r = await fetchT(sitemapUrl, { headers: { 'User-Agent': UA } }, 10000); sitemapOk = r.ok; if (r.ok) sitemapText = (await r.text()).slice(0, 200000); } catch { }
  }
  if (!sitemapOk) {
    const g = await pSitemapGuess;
    if (g.ok && /<urlset|<sitemapindex/i.test(g.text)) { sitemapOk = true; sitemapUrl = sitemapGuess; sitemapText = g.text; }
  } else if (!/<urlset|<sitemapindex/i.test(sitemapText)) { sitemapOk = false; }
  add('technical', 'XML sitemap', sitemapOk ? 'pass' : 'fail',
    sitemapOk ? `Sitemap found: ${sitemapUrl}` : 'No XML sitemap found (checked robots.txt directives and /sitemap.xml).',
    sitemapOk ? '' : 'Generate a sitemap.xml and submit it in Google Search Console & Bing Webmaster Tools.');
  if (sitemapOk && robotsTxt && !/sitemap:/i.test(robotsTxt)) {
    add('technical', 'Sitemap referenced in robots.txt', 'warn', 'Sitemap exists but is not declared in robots.txt.', 'Add a "Sitemap: https://yoursite/sitemap.xml" line to robots.txt.');
  }

  const llms = await pLlms;
  add('geo', 'llms.txt (AI crawler guide)', llms && llms.status === 200 ? 'pass' : 'info',
    llms && llms.status === 200 ? 'An llms.txt file was found \u2014 emerging standard that helps LLMs understand your site.' : 'No llms.txt file found (optional but recommended for AI visibility).',
    llms && llms.status === 200 ? '' : 'Consider adding /llms.txt summarising your business, key pages and contact details for AI assistants.');

  const crawlerReport = AI_CRAWLERS.map((c) => {
    const r = robotsAllows(robotsTxt, c.bot);
    return { ...c, blocked: robotsTxt ? !r.allowed : false, rule: r.mentioned };
  });
  const blockedBots = crawlerReport.filter((c) => c.blocked);
  add('geo', 'AI crawler access (robots.txt)', !robotsTxt ? 'info' : blockedBots.length === 0 ? 'pass' : 'warn',
    !robotsTxt ? 'No robots.txt, so AI crawlers are not explicitly blocked.' :
      blockedBots.length === 0 ? 'No AI crawlers are blocked in robots.txt.' :
        `Blocked AI crawlers: ${blockedBots.map((b) => b.bot).join(', ')}`,
    blockedBots.length ? 'If you want visibility in ChatGPT/Perplexity/AI Overviews, allow these bots in robots.txt.' : '');

  // ---------- 5. Content analysis ----------
  const visible = $('body').clone();
  visible.find('script,style,noscript,svg,template').remove();
  const bodyText = textOf(visible).slice(0, 60000);
  const words = bodyText.toLowerCase().match(/[a-z0-9'\-]+/g) || [];
  const wordCount = words.length;
  add('content', 'Word count', wordCount >= 300 ? 'pass' : wordCount >= 100 ? 'warn' : 'fail',
    `${wordCount.toLocaleString()} words of visible text.`,
    wordCount >= 300 ? '' : 'Thin content ranks poorly. Aim for 300+ words answering real customer questions.');

  const freq = {};
  words.forEach((w) => { if (w.length > 2 && !STOPWORDS.has(w)) freq[w] = (freq[w] || 0) + 1; });
  const keywords = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 12)
    .map(([word, count]) => ({ word, count, density: Math.round((count / wordCount) * 1000) / 10 }));

  const readScore = flesch(bodyText);
  add('content', 'Readability (Flesch Reading Ease)', readScore === null ? 'info' : readScore >= 50 ? 'pass' : 'warn',
    readScore === null ? 'Not enough text to score.' : `Score: ${readScore}/100 (${readScore >= 60 ? 'easy to read' : readScore >= 40 ? 'moderate' : 'difficult \u2014 academic/complex'}).`,
    readScore !== null && readScore < 50 ? 'Shorten sentences and use simpler words \u2014 aim for a grade-8 reading level.' : '');

  add('content', 'Reading time', 'info', `~${Math.max(1, Math.round(wordCount / 220))} minutes to read.`);

  // ---------- 6. Performance ----------
  const pageSizeKb = Math.round(Buffer.byteLength(html, 'utf8') / 1024);
  add('performance', 'TTFB (server response)', ttfb <= 600 ? 'pass' : ttfb <= 1500 ? 'warn' : 'fail',
    `First byte received in ${ttfb} ms.`,
    ttfb <= 600 ? '' : 'A slow server response hurts every other metric. Consider better hosting or a CDN like Cloudflare (free tier).');
  add('performance', 'HTML document size', pageSizeKb <= 150 ? 'pass' : pageSizeKb <= 400 ? 'warn' : 'fail',
    `HTML is ${pageSizeKb} KB.`,
    pageSizeKb <= 150 ? '' : 'Trim inline scripts/styles and split long pages.');

  const scripts = $('script[src]').length;
  const inlineScripts = $('script:not([src])').length;
  const styles = $('link[rel="stylesheet"]').length;
  const blocking = $('head script[src]:not([async]):not([defer]):not([type="module"])').length;
  add('performance', 'Render-blocking scripts in <head>', blocking === 0 ? 'pass' : blocking <= 2 ? 'warn' : 'fail',
    `${blocking} blocking <script> tags in <head> (${scripts} external scripts total).`,
    blocking ? 'Add defer/async to non-critical scripts or move them before </body>.' : '');
  add('performance', 'Stylesheets', 'info', `${styles} external stylesheets, ${inlineScripts} inline scripts.`);

  const lazy = $('img[loading="lazy"]').length;
  add('performance', 'Lazy loading images', imgs > 3 ? (lazy > 0 ? 'pass' : 'warn') : 'info',
    imgs > 3 ? `${lazy}/${imgs} images use loading="lazy".` : 'Too few images to assess.',
    imgs > 3 && !lazy ? 'Add loading="lazy" to below-the-fold images.' : '');

  const compression = headers['content-encoding'];
  add('performance', 'Compression (gzip/brotli)', compression ? 'pass' : 'warn',
    compression ? `Response uses ${compression}.` : 'No Content-Encoding header \u2014 compression may be off.',
    compression ? '' : 'Enable brotli/gzip on your web host.');

  const cacheCtl = headers['cache-control'] || '';
  add('performance', 'Cache headers', /max-age=\s*([0-9]+)/.test(cacheCtl) && parseInt(cacheCtl.match(/max-age=\s*([0-9]+)/)[1], 10) >= 86400 ? 'pass' : 'warn',
    cacheCtl ? `Cache-Control: ${cacheCtl}` : 'No Cache-Control header on the HTML response.',
    'Set long max-age for static assets (images, CSS, JS).');

  // ---------- 7. Security ----------
  const ssl = await pSsl;
  if (isHttps) {
    if (ssl) add('security', 'SSL certificate', ssl.daysLeft > 14 ? 'pass' : ssl.daysLeft > 0 ? 'warn' : 'fail',
      `Issued by ${ssl.issuer}, valid until ${ssl.validTo} (${ssl.daysLeft} days left), ${ssl.protocol}.`,
      ssl.daysLeft <= 14 ? 'Renew the certificate now \u2014 expired SSL destroys trust and rankings.' : '');
    else add('security', 'SSL certificate', 'warn', 'Could not read the TLS certificate.');
  }
  const secHeaders = [
    ['strict-transport-security', 'HSTS (Strict-Transport-Security)', 'Forces browsers to always use HTTPS.'],
    ['content-security-policy', 'Content-Security-Policy', 'Mitigates XSS and injection attacks.'],
    ['x-content-type-options', 'X-Content-Type-Options', 'Prevents MIME-type sniffing (should be "nosniff").'],
    ['x-frame-options', 'X-Frame-Options', 'Protects against clickjacking.'],
    ['referrer-policy', 'Referrer-Policy', 'Controls referrer information leakage.'],
    ['permissions-policy', 'Permissions-Policy', 'Restricts browser features (camera, mic, etc.).'],
  ];
  let secFound = 0;
  secHeaders.forEach(([h]) => { if (headers[h]) secFound++; });
  const missingHeaders = secHeaders.filter(([h]) => !headers[h]);
  add('security', 'Security headers', secFound >= 4 ? 'pass' : secFound >= 2 ? 'warn' : 'fail',
    `${secFound}/6 recommended security headers present (${secHeaders.filter(([h]) => headers[h]).map(([, n]) => n).join(', ') || 'none'}).`,
    secFound >= 4 ? '' : `Add missing headers: ${missingHeaders.map(([h, n]) => `${n} (${h})`).join(', ')} — these protect visitors and are a trust signal.`);

  // ---------- 8. DNS & domain ----------
  const dnsInfo = await pDns;
  if (!dnsp) add('technical', 'DNS records', 'info', 'DNS lookups unavailable in this runtime (e.g. Cloudflare Workers) \u2014 run the Node version for full DNS checks.');
  add('technical', 'DNS A record', !dnsp ? 'info' : dnsInfo.a.length ? 'pass' : 'fail',
    dnsInfo.a.length ? `Resolves to ${dnsInfo.a.join(', ')}` : 'No A record found.');
  add('technical', 'IPv6 (AAAA)', dnsInfo.aaaa.length ? 'pass' : 'info',
    dnsInfo.aaaa.length ? `IPv6 enabled: ${dnsInfo.aaaa[0]}` : 'No IPv6 record \u2014 optional but nice to have.');
  add('technical', 'Mail (MX)', dnsInfo.mx.length ? 'pass' : 'warn',
    dnsInfo.mx.length ? `Email configured: ${dnsInfo.mx.slice(0, 2).join(', ')}` : 'No MX records \u2014 this domain cannot receive email.',
    dnsInfo.mx.length ? '' : 'Set up email for the domain \u2014 trust signals matter for local SEO.');
  add('technical', 'Name servers', dnsInfo.ns.length ? 'info' : 'warn',
    dnsInfo.ns.length ? `${dnsInfo.ns.slice(0, 2).join(', ')}` : 'Could not read name servers.');
  const hasSpf = dnsInfo.txt.some((t) => t.startsWith('v=spf1'));
  const hasDmarc = dnsInfo.dmarc.some((t) => t.startsWith('v=DMARC1'));
  add('security', 'Email authentication (SPF + DMARC)', hasSpf && hasDmarc ? 'pass' : hasSpf || hasDmarc ? 'warn' : 'fail',
    `SPF ${hasSpf ? '\u2713' : '\u2717'}   DMARC ${hasDmarc ? '\u2713' : '\u2717'}`,
    hasSpf && hasDmarc ? '' : 'Add SPF and DMARC DNS records so your emails reach inboxes and your domain can\u2019t be spoofed.');

  const rdap = await pRdap;
  if (rdap && rdap.ageYears !== null) {
    add('technical', 'Domain age', rdap.ageYears >= 1 ? 'pass' : 'warn',
      `Registered ${rdap.registered} (${rdap.ageYears} years)${rdap.registrar ? ' via ' + rdap.registrar : ''}.`,
      rdap.ageYears >= 1 ? '' : 'New domains take time to build trust \u2014 focus on quality backlinks.');
  } else {
    add('technical', 'Domain age', 'info', 'Could not fetch registration data from RDAP for this TLD.');
  }

  // ---------- 9. Mobile ----------
  add('mobile', 'Viewport meta tag', viewport ? 'pass' : 'fail',
    viewport ? 'Responsive viewport meta tag present.' : 'No viewport meta tag \u2014 the page won\u2019t render correctly on phones.',
    viewport ? '' : 'Add <meta name="viewport" content="width=device-width, initial-scale=1">.');
  add('mobile', 'Apple touch icon', $('link[rel="apple-touch-icon"]').length ? 'pass' : 'info',
    $('link[rel="apple-touch-icon"]').length ? 'Apple touch icon declared.' : 'No apple-touch-icon (minor).');
  add('mobile', 'Theme colour', $('meta[name="theme-color"]').length ? 'pass' : 'info',
    $('meta[name="theme-color"]').length ? 'theme-color set (nice mobile browser chrome).' : 'No theme-color meta tag (minor).');
  const fontTiny = (html.match(/font-size:\s*(9|10|11)px/g) || []).length;
  add('mobile', 'Legible font sizes', fontTiny === 0 ? 'pass' : 'warn',
    fontTiny === 0 ? 'No extremely small fixed font sizes detected.' : `${fontTiny} very small font-size declarations found.`,
    fontTiny ? 'Use 16px+ base font size for body text on mobile.' : '');

  // ---------- 10. Local SEO (Australia) ----------
  const tld = host.slice(host.lastIndexOf('.'));
  const isAuDomain = /\.au$/.test(host) || /\.com\.au$/.test(host) || /\.net\.au$/.test(host) || /\.org\.au$/.test(host);
  add('local', 'Australian domain (.au)', isAuDomain ? 'pass' : 'info',
    isAuDomain ? 'An .au domain is a strong trust & ranking signal in Australia.' : `Domain uses "${tld}" \u2014 fine, but .com.au can boost local trust.`);

  const lowerHtml = html.toLowerCase();
  const lowerBody = bodyText.toLowerCase();
  const stateHits = {};
  Object.entries(AU_STATES).forEach(([code, s]) => {
    const hits = [s.name.toLowerCase(), ...s.cities].filter((c) => lowerBody.includes(c));
    if (hits.length) stateHits[code] = hits;
  });
  const statesFound = Object.keys(stateHits);
  add('local', 'Australian location mentions', statesFound.length ? 'pass' : 'warn',
    statesFound.length ? `Mentions of: ${statesFound.map((c) => `${c} (${stateHits[c].slice(0, 2).join(', ')})`).join(' \u00b7 ')}` : 'No Australian state/city names found in the page text.',
    statesFound.length ? '' : 'Mention the suburbs, cities and states you service \u2014 e.g. "Plumber in Parramatta, NSW".');

  const phoneRegex = /(\+61[\s\-]?\(?0?\)?[\s\-]?\d[\s\-]?\d{4}[\s\-]?\d{4})|(0[2-8][\s\-]?\d{4}[\s\-]?\d{4})|(04\d{2}[\s\-]?\d{3}[\s\-]?\d{3})|(1300[\s\-]?\d{3}[\s\-]?\d{3})|(1800[\s\-]?\d{3}[\s\-]?\d{3})/;
  const phoneMatch = bodyText.match(phoneRegex);
  const telHref = $('a[href^="tel:"]').first().attr('href') || '';
  const telDigits = (telHref.match(/\+?[0-9]{8,15}/) || [null])[0];
  const schemaPhone = (html.match(/"telephone"\s*:\s*"([^"]+)"/i) || [null, null])[1];
  const anyPhone = phoneMatch ? phoneMatch[0].trim() : telDigits || schemaPhone;
  add('local', 'Phone number (NAP signal)', phoneMatch ? 'pass' : anyPhone ? 'warn' : 'fail',
    phoneMatch ? `Australian phone format detected: ${anyPhone}` :
      anyPhone ? `Phone found via tel:/schema (${anyPhone}) but NOT displayed as readable text on the page.` :
        'No Australian-format phone number found on the page.',
    phoneMatch ? '' : anyPhone ? 'Also print the number visibly (e.g. "0432 889 445") — a visible NAP is a core local ranking & trust signal.' : 'Display your phone number prominently \u2014 it\u2019s a core local ranking & trust signal.');

  const hasAddressSchema = [...schemaSet].some((t) => /postaladdress/.test(t)) || /postaladdress/i.test(html);
  add('local', 'Address / PostalAddress markup', hasAddressSchema ? 'pass' : 'warn',
    hasAddressSchema ? 'Postal address markup detected.' : 'No postal address or PostalAddress schema found.',
    hasAddressSchema ? '' : 'Add your full street address with PostalAddress schema for local pack rankings.');

  const geoMeta = $('meta[name="geo.region"]').attr('content') || $('meta[name="geo.placename"]').attr('content');
  add('local', 'Geo meta tags', geoMeta ? 'pass' : 'info',
    geoMeta ? `Geo meta found: ${geoMeta}` : 'No geo.region/geo.placename meta tags (minor signal).');

  const mapsEmbed = $('iframe[src*="google.com/maps"], iframe[src*="maps.google"]').length > 0 || /goo\.gl\/maps|google\.com\/maps/i.test(html);
  add('local', 'Google Maps presence', mapsEmbed ? 'pass' : 'info',
    mapsEmbed ? 'Google Maps embed/link detected.' : 'No Google Maps embed found \u2014 consider embedding your location map.');

  const abn = /ABN[:\s]*(\d{2}\s?\d{3}\s?\d{3}\s?\d{3})/i.test(bodyText);
  add('local', 'ABN displayed', abn ? 'pass' : 'info',
    abn ? 'An Australian Business Number is shown \u2014 good for trust.' : 'No ABN found in page text (recommended for AU businesses).');

  // ---------- 11. Social ----------
  const socialDefs = [
    ['Facebook', /facebook\.com|fb\.com/i], ['Instagram', /instagram\.com/i], ['LinkedIn', /linkedin\.com/i],
    ['X / Twitter', /(twitter\.com|x\.com)/i], ['YouTube', /youtube\.com|youtu\.be/i], ['TikTok', /tiktok\.com/i], ['Threads', /threads\.(net|com)/i],
  ];
  const socialFound = socialDefs.filter(([, rx]) => rx.test(html)).map(([n]) => n);
  add('local', 'Social media profiles', socialFound.length >= 2 ? 'pass' : socialFound.length === 1 ? 'warn' : 'fail',
    socialFound.length ? `Linked: ${socialFound.join(', ')}` : 'No social media profile links found.',
    socialFound.length >= 2 ? '' : 'Link your social profiles \u2014 brand searches feed local credibility.');

  // ---------- 12. Broken-link & 404 handling probes ----------
  const nfStatus = await p404;
  if (nfStatus !== null) {
    add('technical', '404 handling', nfStatus === 404 || nfStatus === 410 ? 'pass' : nfStatus === 200 ? 'fail' : 'warn',
      nfStatus === 404 || nfStatus === 410 ? 'Fake URL correctly returns 404.' : nfStatus === 200 ? 'A non-existent page returns 200 (soft 404) \u2014 bad for crawl efficiency.' : `Fake URL returned ${nfStatus}.`,
      nfStatus === 200 ? 'Configure the server to return a real 404 status for missing pages.' : '');
  }

  const internalSample = [...internalHrefs].slice(0, 10);
  const brokenLinks = [];
  let checkedLinks = 0;
  const probe = async (u) => {
    checkedLinks++;
    try {
      const r = await fetchT(u, { method: 'GET', headers: { 'User-Agent': UA } }, 7000);
      if (r.status >= 400) brokenLinks.push({ url: u, status: r.status });
      if (r.body && r.body.cancel) r.body.cancel().catch(() => {}); // don't download bodies
    } catch (e) { brokenLinks.push({ url: u, status: e.name === 'AbortError' ? 'timeout' : 'error' }); }
  };
  await Promise.all([...internalSample.map(probe), ...externalSample.slice(0, 6).map(probe)]);
  add('technical', 'Broken link check (sample)', brokenLinks.length === 0 ? 'pass' : brokenLinks.length <= 2 ? 'warn' : 'fail',
    checkedLinks ? `Checked ${checkedLinks} links \u2014 ${brokenLinks.length} problem(s) found.${brokenLinks.length ? ' ' + brokenLinks.slice(0, 3).map((b) => `${b.status} ${b.url}`).join(' | ') : ''}` : 'No links to sample.',
    brokenLinks.length ? 'Fix or remove the broken links listed.' : '');

  // ---------- 13. Enhanced checks (knowledge ported from open SEO skill research) ----------
  try {
    await runEnhancedChecks(add, {
      $, html, bodyText, finalUrl, isHttps, schemaTypes, robotsTxt, wordCount,
    }, { fetchT, UA, targetUrl: target });
  } catch (e) {
    add('technical', 'Enhanced analysis', 'info', `Some advanced checks were skipped (${e.message}).`);
  }

  // ---------- 14. Second skill wave: sitemap/hreflang/images/content/SXO/ecom/maps ----------
  try {
    await runSkills2Checks(add, {
      $, html, bodyText, sitemapText, sitemapOk, hreflangs, keywords, title, headings,
      canonical, finalUrl, schemaTypes,
    });
  } catch (e) {
    add('technical', 'Extended skill checks', 'info', `Some skill checks were skipped (${e.message}).`);
  }

  // ---------- Scoring ----------
  const GROUPS = {
    seo: { label: 'On-Page SEO', weight: 22 },
    geo: { label: 'GEO / AI SEO', weight: 18 },
    technical: { label: 'Technical & Health', weight: 16 },
    performance: { label: 'Speed & Performance', weight: 12 },
    security: { label: 'Security & Trust', weight: 10 },
    mobile: { label: 'Mobile', weight: 7 },
    content: { label: 'Content Quality', weight: 8 },
    local: { label: 'Local SEO (Australia)', weight: 7 },
  };
  const groupScores = {};
  let overallNum = 0, overallDen = 0;
  Object.keys(GROUPS).forEach((g) => {
    const gc = checks.filter((c) => c.group === g);
    const pass = gc.filter((c) => c.status === 'pass').length;
    const warn = gc.filter((c) => c.status === 'warn').length;
    const fail = gc.filter((c) => c.status === 'fail').length;
    const scored = pass + warn + fail;
    const score = scored ? Math.round(((pass + warn * 0.5) / scored) * 100) : 100;
    groupScores[g] = { label: GROUPS[g].label, score, pass, warn, fail, total: gc.length };
    overallNum += score * GROUPS[g].weight;
    overallDen += GROUPS[g].weight;
  });

  return {
    requested: input,
    url: finalUrl,
    host,
    fetchedAt: new Date().toISOString(),
    httpStatus: status,
    ttfb,
    pageSizeKb,
    overall: Math.round(overallNum / overallDen),
    groups: groupScores,
    checks,
    serp: { title, description: metaDesc, url: canonical || finalUrl },
    wordCount, keywords, readability: readScore,
    schemaTypes: [...new Set(schemaTypes)],
    social: socialFound,
    aiCrawlers: crawlerReport,
    ssl,
    dns: { ip: dnsInfo.a[0] || null, ipv6: dnsInfo.aaaa[0] || null, mx: dnsInfo.mx.slice(0, 3), ns: dnsInfo.ns.slice(0, 4) },
    domain: rdap || {},
    states: stateHits,
    links: { internal: links.internal, external: links.external, checked: checkedLinks, broken: brokenLinks },
    sitemapUrl, robotsTxt: robotsTxt !== null, llmsTxt: !!(llms && llms.status === 200),
    headings: headings.slice(0, 30),
  };
}

module.exports = { runAudit, normalizeUrl };
