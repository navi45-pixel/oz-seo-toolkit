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
 */
import { runAudit } from './lib/audit.js';
import { runSpeedTest } from './lib/speed.js';
import { probePerformance } from './lib/perfprobe.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const json = (obj, status = 200) =>
      new Response(JSON.stringify(obj), {
        status,
        headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
      });
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
      if (url.pathname.startsWith('/api/backlinks')) {
        return json({ error: 'The backlink directory needs persistent storage — bind a KV namespace or use the Node hosting. All audit tools work fully on Workers.' }, 501);
      }
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
