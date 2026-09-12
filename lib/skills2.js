'use strict';
/**
 * Second wave of skill checks:
 *  - seo-sitemap:   sitemap quality (URL count, lastmod coverage, legacy attrs)
 *  - seo-hreflang:  code validation, self-reference, x-default, https consistency
 *  - seo-images:    width/height (CLS), modern formats, descriptive filenames
 *  - seo-content:   keyword stuffing, title/H1 alignment (Who-How-Why proxies)
 *  - seo-sxo:       primary CTA / page-type signals
 *  - seo-ecommerce: Product/Offer schema completeness, platform detection
 *  - seo-maps:      review widgets & GBP integration signals
 */

const VALID_HREFLANG = /^x-default$|^[a-z]{2,3}(-[A-Z]{2})?$/;

async function runSkills2Checks(add, ctx) {
  const { $, html, bodyText, sitemapText, sitemapOk, hreflangs, keywords, title, headings } = ctx;
  const schemaLower = new Set((ctx.schemaTypes || []).map((t) => t.toLowerCase()));

  /* ---------- seo-sitemap ---------- */
  if (sitemapOk && sitemapText) {
    const urlCount = (sitemapText.match(/<url>/g) || []).length;
    const smCount = (sitemapText.match(/<sitemap>/g) || []).length;
    const lastmod = (sitemapText.match(/<lastmod>/g) || []).length;
    const legacy = (sitemapText.match(/<changefreq>|<priority>/g) || []).length;
    add('technical', 'Sitemap size & structure', (urlCount || smCount) ? 'pass' : 'warn',
      urlCount ? `Sitemap lists ${urlCount} URLs.` : smCount ? `Sitemap index with ${smCount} child sitemaps.` : 'Sitemap contains no <url> entries.',
      urlCount || smCount ? '' : 'Regenerate the sitemap so it lists your real pages.');
    if (urlCount) {
      add('technical', 'Sitemap lastmod coverage', lastmod / urlCount >= 0.8 ? 'pass' : lastmod > 0 ? 'warn' : 'warn',
        `${lastmod}/${urlCount} URLs carry <lastmod>.`,
        lastmod / urlCount >= 0.8 ? '' : 'Add accurate <lastmod> dates — Google uses them to prioritise re-crawls.');
    }
    if (legacy) add('technical', 'Legacy sitemap attributes', 'info',
      `${legacy} <changefreq>/<priority> tags — Google ignores both; harmless but unnecessary.`);
  }

  /* ---------- seo-hreflang ---------- */
  if (hreflangs && hreflangs.length) {
    const bad = hreflangs.filter((h) => !VALID_HREFLANG.test(h) || /-uk$|^uk-$/i.test(h));
    const hasSelf = $('link[hreflang]').filter((_, el) => ($(el).attr('href') || '') === (ctx.canonical || ctx.finalUrl)).length > 0;
    const hasXDefault = hreflangs.includes('x-default');
    const httpMixed = $('link[hreflang][href^="http://"]').length > 0;
    add('seo', 'Hreflang validation', bad.length === 0 ? 'pass' : 'fail',
      bad.length === 0 ? `All ${hreflangs.length} hreflang codes are valid ISO format.` : `Invalid hreflang codes: ${bad.join(', ')} (use ISO 639-1 + ISO 3166-1 Alpha-2, e.g. en-AU not en-uk).`,
      bad.length ? 'Fix the invalid codes — broken hreflang is ignored entirely.' : '');
    add('seo', 'Hreflang self-reference', hasSelf ? 'pass' : 'warn',
      hasSelf ? 'Page references itself in hreflang (required).' : 'No self-referencing hreflang tag.',
      hasSelf ? '' : 'Every language version must include an hreflang pointing to itself.');
    if (hreflangs.length > 2) add('seo', 'Hreflang x-default', hasXDefault ? 'pass' : 'warn',
      hasXDefault ? 'x-default fallback present.' : 'No x-default tag.',
      hasXDefault ? '' : 'Add x-default pointing at your fallback/selector page.');
    if (httpMixed) add('seo', 'Hreflang https consistency', 'warn', 'Some hreflang URLs use http://.', 'Standardise all hreflang URLs to https.');
  }

  /* ---------- seo-images ---------- */
  const imgs = $('img');
  if (imgs.length) {
    const noDims = imgs.filter((_, el) => !($(el).attr('width') || (el.attribs && el.attribs.style && /width/.test(el.attribs.style))) && !$(el).attr('height')).length;
    add('performance', 'Image dimensions declared (CLS)', noDims === 0 ? 'pass' : noDims / imgs.length > 0.4 ? 'warn' : 'pass',
      `${imgs.length - noDims}/${imgs.length} images declare width/height — prevents layout shift.`,
      noDims ? 'Add width & height attributes to images so the browser reserves space (fixes CLS).' : '');
    const modern = imgs.filter((_, el) => /\.(webp|avif)(\?|$)/i.test($(el).attr('src') || '') || $(el).attr('type') === 'image/webp').length;
    const legacyFmt = imgs.length - modern;
    add('performance', 'Modern image formats (WebP/AVIF)', modern > 0 ? 'pass' : legacyFmt > 5 ? 'warn' : 'info',
      `${modern}/${imgs.length} images use modern formats.`,
      modern ? '' : 'Convert PNG/JPG to WebP/AVIF — typically 25-50% smaller files.');
    const generic = imgs.filter((_, el) => /(IMG|DSC|DCIM|screenshot|untitled|image\d+)[-_]?\d*/i.test($(el).attr('src') || '')).length;
    add('seo', 'Descriptive image filenames', generic === 0 ? 'pass' : 'warn',
      generic === 0 ? 'Image filenames look descriptive (good for Image Search).' : `${generic} image(s) use generic filenames (IMG_1234.jpg etc).`,
      generic ? 'Rename uploads descriptively, e.g. end-of-lease-cleaning-canberra.webp.' : '');
  }

  /* ---------- seo-content ---------- */
  const top = keywords && keywords[0];
  if (top && top.density > 3.5 && top.count > 10) {
    add('content', 'Keyword stuffing', 'warn',
      `"${top.word}" appears at ${top.density}% density — over-optimisation risk.`,
      'Rewrite for humans; keep primary keyword density under ~3%.');
  }
  const h1 = (headings && headings.find((h) => h.tag === 'h1') || {}).text || '';
  if (h1 && title) {
    const words = (s) => new Set((s.toLowerCase().match(/[a-z]{4,}/g) || []).filter((w) => !['with', 'from', 'your', 'about', 'services'].includes(w)));
    const tw = words(title), hw = words(h1);
    const overlap = [...tw].filter((w) => hw.has(w)).length;
    add('content', 'Title \u2194 H1 topic alignment', overlap >= 1 ? 'pass' : 'info',
      overlap >= 1 ? 'Title and H1 reinforce the same topic.' : 'Title and H1 share no significant words.',
      '');
  }
  // Who/How/Why (helpful content) proxies
  const aboutLink = $('a[href*="about"], a[href*="/team"], a[href*="/our-"]').length > 0;
  add('content', 'Who/How/Why trust proxies (helpful content)', aboutLink ? 'pass' : 'warn',
    aboutLink ? 'About/team pages linked — supports the "who created this" test.' : 'No About/team link found.',
    aboutLink ? '' : 'Link an About page with real credentials — Google\u2019s helpful-content heuristic asks WHO created the content.');

  /* ---------- seo-sxo ---------- */
  const cta = (bodyText.match(/\b(get a (free )?quote|book (now|online)|request a quote|contact us|call now|enquire|get started|free estimate)\b/gi) || []).length;
  add('seo', 'Primary CTA present (SXO)', cta >= 2 ? 'pass' : cta === 1 ? 'warn' : 'fail',
    cta ? `${cta} conversion CTA phrase(s) found ("get a quote", "book now"…).` : 'No clear call-to-action phrases found.',
    cta >= 2 ? '' : 'Add obvious CTAs above the fold — ranking without a conversion path wastes the click.');

  /* ---------- seo-ecommerce ---------- */
  const isShop = /add-to-cart|woocommerce|shopify|bigcommerce|\bcart\b/i.test(html);
  if ([...schemaLower].some((t) => /product|offer/.test(t))) {
    const cur = /priceCurrency/.test(html), avail = /availability/.test(html);
    add('seo', 'Product schema completeness', cur && avail ? 'pass' : 'warn',
      `Product/Offer markup found. priceCurrency ${cur ? '\u2713' : '\u2717'}, availability ${avail ? '\u2713' : '\u2717'}.`,
      cur && avail ? '' : 'Add priceCurrency (AUD) and availability to Product/Offer schema.');
  } else if (isShop) {
    add('seo', 'E-commerce platform', 'info', 'Shopping platform detected but no Product/Offer schema found — add it for rich results.');
  }

  /* ---------- seo-maps ---------- */
  const reviewWidget = /tripadvisor|reviews\.io|trustpilot|productreview\.com\.au|google\.com\/maps|gstatic\.com\/place/i.test(html);
  add('local', 'GBP / review widget integration', reviewWidget ? 'pass' : 'info',
    reviewWidget ? 'Google Maps embed or third-party review widget detected — strong local trust signal.' : 'No maps/review widget found. Embed your Google reviews or map for local pack signals.');
}

module.exports = { runSkills2Checks };
