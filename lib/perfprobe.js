'use strict';
/**
 * Built-in performance probe — always available, no external API needed.
 * Measures real network timings and page weight.
 */
function fetchT(url, opts = {}, ms = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(t));
}

async function probePerformance(input) {
  let u = String(input || '').trim();
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  const target = new URL(u).toString();
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36';

  // 3 cold-ish runs of the HTML document
  const runs = [];
  for (let i = 0; i < 3; i++) {
    const t0 = Date.now();
    try {
      const r = await fetchT(target, { headers: { 'User-Agent': UA, 'Accept': 'text/html' } }, 20000);
      const html = await r.text();
      runs.push({ ttfb: Date.now() - t0, size: Buffer.byteLength(html, 'utf8'), encoding: r.headers.get('content-encoding') || 'none' });
    } catch { /* skip failed run */ }
  }
  if (!runs.length) return null;
  const avg = (arr) => Math.round(arr.reduce((a, b) => a + b, 0) / arr.length);

  return {
    samples: runs.length,
    ttfbAvg: avg(runs.map((r) => r.ttfb)),
    ttfbBest: Math.min(...runs.map((r) => r.ttfb)),
    htmlKb: Math.round(runs[0].size / 1024),
    encoding: runs[0].encoding,
  };
}

module.exports = { probePerformance };
