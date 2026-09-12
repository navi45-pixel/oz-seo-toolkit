'use strict';
/**
 * Enhanced audit checks — knowledge ported from the open-source
 * open-source SEO skill research:
 *  - seo-technical: redirect chains, URL structure, mixed content, JS rendering,
 *    Googlebot 2MB fetch limit, IndexNow
 *  - seo-geo: AI citability signals, crawler taxonomy (training vs citability bots)
 *  - seo-local: NAP completeness, click-to-call, hours, reviews, service-area detection
 *  - seo-schema: microdata/RDFa detection, deprecated schema types
 */

const QUESTION_START = /^(how|what|why|who|where|when|which|can|could|do|does|is|are|should|will|am)\b/i;

function detectFramework(html) {
  const sigs = [];
  if (/__NEXT_DATA__|_next\/static/i.test(html)) sigs.push('Next.js');
  if (/__NUXT__|_nuxt\//i.test(html)) sigs.push('Nuxt');
  if (/wp-content\/|wp-includes\//i.test(html)) sigs.push('WordPress');
  if (/cdn\.shopify\.com|Shopify\.theme/i.test(html)) sigs.push('Shopify');
  if (/ng-version=|data-ng-app|ng-app/i.test(html)) sigs.push('Angular');
  if (/data-v-[a-f0-9]{8}/i.test(html)) sigs.push('Vue');
  if (/\bid="root"|data-reactroot/i.test(html) && !sigs.length) sigs.push('React (CSR?)');
  if (/static\.wixstatic\.com/i.test(html)) sigs.push('Wix');
  if (/squarespace\.com|static\.space/i.test(html)) sigs.push('Squarespace');
  return sigs;
}

function countRedirects(url, fetchT, UA) {
  return (async () => {
    let hops = 0, current = url;
    for (let i = 0; i < 6; i++) {
      try {
        const r = await fetchT(current, { method: 'GET', redirect: 'manual', headers: { 'User-Agent': UA } }, 10000);
        if ([301, 302, 303, 307, 308].includes(r.status) && r.headers.get('location')) {
          hops++;
          current = new URL(r.headers.get('location'), current).toString();
        } else break;
      } catch { break; }
    }
    return hops;
  })();
}

/**
 * Adds enhanced checks. Call BEFORE scoring.
 * ctx: { $, html, bodyText, finalUrl, isHttps, schemaTypes, robotsTxt, wordCount }
 */
async function runEnhancedChecks(add, ctx, deps) {
  const { $, html, bodyText, finalUrl, isHttps, schemaTypes, robotsTxt } = ctx;
  const { fetchT, UA, targetUrl } = deps;
  const schemaLower = new Set((schemaTypes || []).map((t) => t.toLowerCase()));

  /* ================= GEO: AI citability (from seo-geo skill) ================= */

  // Question-based headings match how people ask AI assistants
  const qHeads = [];
  $('h2, h3').each((_, el) => {
    const t = ($(el).text() || '').replace(/\s+/g, ' ').trim();
    if (t && (t.endsWith('?') || QUESTION_START.test(t))) qHeads.push(t.slice(0, 70));
  });
  add('geo', 'Question-based headings', qHeads.length ? 'pass' : 'warn',
    qHeads.length ? `${qHeads.length} question-style headings found (AI assistants match answers to question queries).` : 'No question-style headings found.',
    qHeads.length ? '' : 'Add H2/H3 headings phrased as real customer questions, e.g. "How much does X cost in Sydney?"');

  // Definition patterns — highly quotable by AI engines
  const defCount = (bodyText.match(/\b(is a|is an|is the|refers to|are the|means that)\b/gi) || []).length;
  add('geo', 'Quotable definitions & answers', defCount >= 3 ? 'pass' : 'warn',
    `${defCount} definition-style statements found. AI engines preferentially cite clear "X is…" passages.`,
    defCount >= 3 ? '' : 'Write self-contained 1\u20133 sentence answers near the top of sections (ideal citation length is ~130\u2013170 words).');

  // Statistics / data points
  const statCount = (bodyText.match(/\d+(\.\d+)?\s*(%|percent|million|billion|\$|AUD|hours?|days?|years?)/gi) || []).length;
  add('geo', 'Specific facts & statistics', statCount >= 5 ? 'pass' : 'warn',
    `${statCount} numeric facts/statistics detected on the page.`,
    statCount >= 5 ? '' : 'Add concrete numbers (prices, stats, timeframes) \u2014 AI engines favour pages with citable specifics.');

  // Structural readability: lists & tables
  const lists = $('ul, ol').length, tables = $('table').length;
  add('geo', 'Lists & tables (AI-friendly structure)', lists + tables >= 2 ? 'pass' : 'warn',
    `${lists} lists, ${tables} tables found.`,
    lists + tables >= 2 ? '' : 'Break up walls of text \u2014 bullet lists and tables are heavily preferred by AI summarisers.');

  // Multi-modal content (156% higher AI selection rate per SE studies)
  const hasVideo = $('video, iframe[src*="youtube.com"], iframe[src*="youtu.be"], iframe[src*="vimeo.com"]').length > 0;
  add('geo', 'Multi-modal content (video)', hasVideo ? 'pass' : 'info',
    hasVideo ? 'Video content detected \u2014 multi-modal pages are selected by AI engines far more often.' : 'No embedded video found (optional boost).');

  // E-E-A-T: author & date signals
  const personSchema = [...schemaLower].some((t) => t === 'person');
  const byline = /byline|written by|author/i.test(html.slice(0, 400000)) || $('meta[name="author"]').length > 0 || personSchema;
  add('geo', 'Author / byline signals (E-E-A-T)', byline ? 'pass' : 'warn',
    byline ? 'Author attribution detected (Person schema, author meta, or byline text).' : 'No author signals found.',
    byline ? '' : 'Show who wrote the content with credentials \u2014 Google and AI engines weight E-E-A-T heavily.');

  const dateMeta = $('meta[property="article:published_time"], meta[property="article:modified_time"]').length > 0;
  const dateSchema = /datePublished|dateModified/i.test(html);
  const dateText = /\b(19|20)\d{2}\b/.test(bodyText);
  add('geo', 'Content freshness signals', dateMeta || dateSchema ? 'pass' : dateText ? 'warn' : 'fail',
    (dateMeta || dateSchema) ? 'Publish/update dates are machine-readable (meta/schema).' : dateText ? 'Dates appear in text but not in meta tags or schema.' : 'No publication dates found.',
    (dateMeta || dateSchema) ? '' : 'Add datePublished/dateModified \u2014 content under ~3 months old is far more likely to be cited by AI answers.');

  /* ================= Technical additions (from seo-technical skill) ================= */

  // Redirect chains (max 1 hop recommended)
  try {
    const hops = await countRedirects(targetUrl, fetchT, UA);
    add('technical', 'Redirect chain', hops <= 1 ? 'pass' : hops === 2 ? 'warn' : 'fail',
      hops === 0 ? 'No redirects \u2014 the URL serves content directly.' : `${hops} redirect hop(s) before the final page.`,
      hops <= 1 ? '' : 'Flatten redirect chains to a single 301 hop \u2014 each hop adds latency and wastes crawl budget.');
  } catch { add('technical', 'Redirect chain', 'info', 'Could not test redirects.'); }

  // URL quality
  const fullLen = finalUrl.length;
  const underscores = /_/.test(new URL(finalUrl).pathname);
  add('technical', 'URL structure', fullLen <= 100 && !underscores ? 'pass' : 'warn',
    `URL is ${fullLen} characters${underscores ? ' and contains underscores' : ''}.`,
    fullLen <= 100 && !underscores ? '' : 'Keep URLs under 100 characters, use hyphens (not underscores), and avoid parameters for content pages.');

  // Mixed content (explicit check)
  if (isHttps) {
    const mixed = $('script[src^="http:"], link[href^="http:"], img[src^="http:"], iframe[src^="http:"], source[src^="http:"]').length;
    add('security', 'Mixed content', mixed === 0 ? 'pass' : 'fail',
      mixed === 0 ? 'No insecure http:// resources on this https page.' : `${mixed} insecure http:// resource(s) loaded on an https page.`,
      mixed === 0 ? '' : 'Switch all resource URLs to https:// \u2014 mixed content triggers browser warnings and hurts trust.');
  }

  // Googlebot 2MB fetch limit
  if (html.length >= 2 * 1024 * 1024) {
    add('technical', 'HTML size vs Googlebot 2MB limit', 'fail',
      `HTML is ${(html.length / 1024 / 1024).toFixed(1)} MB \u2014 Googlebot only fetches the first 2MB.`,
      'Move critical content and JSON-LD into the first 2MB; remove inline base64 images and bloat.');
  }

  // JS rendering / CSR risk (AI crawlers do NOT execute JavaScript)
  const frameworks = detectFramework(html);
  const ratio = html.length ? ctx.wordCount / (html.length / 1024) : 0; // words per KB of HTML
  const csrRisk = ratio < 6 && (frameworks.some((f) => /React|Vue|Angular|Next|Nuxt/.test(f)) || $('script[src]').length > 15);
  add('technical', 'Content available without JavaScript', csrRisk ? 'warn' : 'pass',
    csrRisk
      ? `Detected ${frameworks.length ? frameworks.join(', ') : 'heavy scripting'} with low visible-text ratio (${ctx.wordCount} words). AI crawlers and some search crawlers do NOT execute JavaScript \u2014 they may see an empty page.`
      : `Primary content is present in the raw HTML${frameworks.length ? ' (' + frameworks.join(', ') + ', server-rendered)' : ''}.`,
    csrRisk ? 'Ensure critical content, titles and schema are server-rendered in the initial HTML \u2014 never injected only by JavaScript.' : '');

  // IndexNow (Bing/Yandex/Naver instant indexing)
  const indexNow = $('meta[name="msvalidate.01"]').length > 0 || /indexnow/i.test(html);
  add('technical', 'Bing verification (IndexNow-ready)', indexNow ? 'pass' : 'info',
    indexNow ? 'Bing verification meta found \u2014 IndexNow can push new pages to Bing instantly.' : 'No Bing verification detected. IndexNow (free) gives instant indexing on Bing, Yandex & Naver.');

  /* ================= Schema additions (from seo-schema skill) ================= */

  // Microdata / RDFa fallback formats
  const microdata = $('[itemscope]').length, rdfa = $('[typeof][property]').length;
  if (!schemaLower.size && (microdata || rdfa)) {
    add('geo', 'Legacy structured data formats', 'warn',
      `No JSON-LD found, but ${microdata ? microdata + ' Microdata items' : ''}${rdfa ? rdfa + ' RDFa nodes' : ''} detected.`,
      'Migrate to JSON-LD \u2014 Google\u2019s preferred and most reliable format.');
  }

  // Deprecated schema types
  const deprecated = [...schemaLower].filter((t) => ['howto', 'specialannouncement', 'claimreview', 'vehiclelisting', 'courseinfo'].includes(t));
  if (deprecated.length) {
    add('geo', 'Deprecated schema types', 'warn',
      `Found deprecated types: ${deprecated.join(', ')} \u2014 Google removed these rich results.`,
      'Remove deprecated markup; use Article/FAQ content blocks instead.');
  }

  /* ================= Local SEO additions (from seo-local skill) ================= */

  // Click-to-call
  const telLinks = $('a[href^="tel:"]').length;
  add('local', 'Click-to-call (tel: links)', telLinks ? 'pass' : 'warn',
    telLinks ? `${telLinks} click-to-call link(s) found \u2014 76% of "near me" mobile searches lead to a visit within 24h.` : 'No tel: links found.',
    telLinks ? '' : 'Wrap your phone number in <a href="tel:+61..."> so mobile visitors can tap to call.');

  // Opening hours
  const hoursSchema = /openingHours|"opens"/i.test(html);
  const hoursText = /\b(opening|business|trading)\s+hours\b|\bmon(day)?\s*[-\u2013]\s*(fri|sat|sun)/i.test(bodyText);
  add('local', 'Opening hours visible', hoursSchema ? 'pass' : hoursText ? 'warn' : 'info',
    hoursSchema ? 'Opening hours in structured data \u2014 businesses open at search time rank higher.' : hoursText ? 'Hours appear in text but not in schema.' : 'No opening hours detected.',
    hoursSchema ? '' : 'Add openingHours to your LocalBusiness schema and show hours on the page.');

  // Reviews schema
  const reviewSchema = [...schemaLower].some((t) => /aggregaterating|review/.test(t)) || /aggregateRating/i.test(html);
  add('local', 'Review markup (aggregateRating)', reviewSchema ? 'pass' : 'info',
    reviewSchema ? 'Review/rating markup found \u2014 eligible for star ratings in results.' : 'No review markup. Collect Google reviews and consider aggregateRating schema.');

  // Service-area business detection
  const sabLang = /servic(e|ing)\s+(area|all\s+of)|serving\s+(all\s+of\s+)?(sydney|melbourne|brisbane|perth|adelaide|canberra|hobart|darwin|the\s+)|we come to you|on-?site service/i.test(bodyText);
  if (sabLang) add('local', 'Service-area signals', 'pass',
    'Service-area language detected ("serving X", "we come to you") \u2014 good for area-based local queries.');

  /* ================= GEO: search-citability bot checks (from seo-geo skill) ================= */
  if (robotsTxt) {
    const allowed = (bot) => {
      const lines = robotsTxt.split(/\r?\n/);
      let inBlock = false; const disallows = [];
      for (const raw of lines) {
        const m = raw.trim().match(/^user-agent:\s*(.+)$/i);
        if (m) { inBlock = m[1].trim().toLowerCase() === bot.toLowerCase(); continue; }
        if (inBlock) { const d = raw.trim().match(/^disallow:\s*(\S*)$/i); if (d) disallows.push(d[1]); }
      }
      return !disallows.some((p) => p === '' || p === '/');
    };
    add('geo', 'ChatGPT Search citability (OAI-SearchBot)', allowed('OAI-SearchBot') ? 'pass' : 'fail',
      allowed('OAI-SearchBot') ? 'OAI-SearchBot is allowed \u2014 your content can be cited in ChatGPT Search.' : 'OAI-SearchBot is blocked \u2014 you are excluded from ChatGPT Search citations.',
      allowed('OAI-SearchBot') ? '' : 'Allow OAI-SearchBot in robots.txt (note: GPTBot only controls training, not citability).');
    add('geo', 'Claude search citability (Claude-SearchBot)', allowed('Claude-SearchBot') ? 'pass' : 'fail',
      allowed('Claude-SearchBot') ? 'Claude-SearchBot is allowed \u2014 citable in Claude\u2019s search features.' : 'Claude-SearchBot is blocked.',
      allowed('Claude-SearchBot') ? '' : 'Allow Claude-SearchBot in robots.txt (ClaudeBot only controls training).');
  }
}

module.exports = { runEnhancedChecks };
