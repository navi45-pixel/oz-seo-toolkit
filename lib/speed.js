'use strict';
/**
 * Speed & Core Web Vitals test via the FREE Google PageSpeed Insights API
 * (powered by Google Lighthouse — https://github.com/GoogleChrome/lighthouse).
 * No API key required for light usage; an optional key can be set via env PAGESPEED_API_KEY.
 */

function fetchT(url, ms = 120000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { signal: ctrl.signal }).finally(() => clearTimeout(t));
}

async function runSpeedTest(input, strategy = 'mobile') {
  let u = String(input || '').trim();
  if (!u) throw new Error('URL required');
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  new URL(u); // validate

  const key = process.env.PAGESPEED_API_KEY ? `&key=${process.env.PAGESPEED_API_KEY}` : '';
  const api = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(u)}&strategy=${strategy}&category=PERFORMANCE&category=ACCESSIBILITY&category=BEST_PRACTICES&category=SEO${key}`;

  const res = await fetchT(api);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    if (res.status === 429) throw new Error('Google PageSpeed rate limit reached \u2014 please wait a minute and try again.');
    throw new Error(`PageSpeed API error ${res.status}. ${body.slice(0, 160)}`);
  }
  const data = await res.json();
  const lr = data.lighthouseResult || {};
  const cats = lr.categories || {};
  const audits = lr.audits || {};
  const metric = (id) => audits[id] && audits[id].numericValue != null ? audits[id].numericValue : null;
  const display = (id) => audits[id] && audits[id].displayValue ? audits[id].displayValue : null;

  const opportunities = Object.values(audits)
    .filter((a) => a.details && a.details.type === 'opportunity' && a.details.overallSavingsMs > 250)
    .sort((a, b) => b.details.overallSavingsMs - a.details.overallSavingsMs)
    .slice(0, 6)
    .map((a) => ({ title: a.title, saving: Math.round(a.details.overallSavingsMs), description: (a.description || '').split('[')[0].trim() }));

  const lcpElem = audits['largest-contentful-paint-element'];
  let lcpElement = null;
  try {
    const items = lcpElem?.details?.items || [];
    for (const it of items) {
      if (it.items && it.items[0] && it.items[0].node && it.items[0].node.snippet) { lcpElement = it.items[0].node.snippet; break; }
    }
  } catch { }

  return {
    url: u,
    strategy,
    fetchTime: lr.fetchTime || new Date().toISOString(),
    scores: {
      performance: cats.PERFORMANCE ? Math.round((cats.PERFORMANCE.score || 0) * 100) : null,
      accessibility: cats.ACCESSIBILITY ? Math.round((cats.ACCESSIBILITY.score || 0) * 100) : null,
      bestPractices: cats.BEST_PRACTICES ? Math.round((cats.BEST_PRACTICES.score || 0) * 100) : null,
      seo: cats.SEO ? Math.round((cats.SEO.score || 0) * 100) : null,
    },
    metrics: {
      fcp: { value: metric('first-contentful-paint'), display: display('first-contentful-paint') },
      lcp: { value: metric('largest-contentful-paint'), display: display('largest-contentful-paint') },
      tbt: { value: metric('total-blocking-time'), display: display('total-blocking-time') },
      cls: { value: metric('cumulative-layout-shift'), display: display('cumulative-layout-shift') },
      si: { value: metric('speed-index'), display: display('speed-index') },
      tti: { value: metric('interactive'), display: display('interactive') },
    },
    lcpElement,
    opportunities,
    reportUrl: `https://pagespeed.web.dev/analysis?url=${encodeURIComponent(u)}&form_factor=${strategy}`,
  };
}

module.exports = { runSpeedTest };
