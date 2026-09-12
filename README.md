# OzSEO Toolkit 🇦🇺

Free all-in-one website audit & SEO toolkit for **Australian businesses** — every state & territory (NSW, VIC, QLD, WA, SA, TAS, ACT, NT).

## What it does

**Page 1 — Free Website Audit (`/`)**
Paste any URL and get 90+ checks across 8 scored categories:

| Category | Checks include |
|---|---|
| On-Page SEO | Title, meta description, H1s, canonical, indexability, alt text, internal links, Open Graph, favicon |
| GEO / AI SEO | JSON-LD schema (+ deprecated types), llms.txt, FAQ markup, semantic HTML, freshness & E-E-A-T signals, AI-crawler access in robots.txt (GPTBot, ClaudeBot, OAI-SearchBot, PerplexityBot, Google-Extended, CCBot…) |
| Technical & Health | HTTP status, HTTPS, robots.txt, XML sitemap (size & lastmod coverage), 404 handling, broken-link scan, redirect chains, DNS (A/AAAA/MX/NS), domain age via RDAP |
| Speed | TTFB, page weight, render-blocking scripts, lazy loading, image dimensions (CLS), WebP/AVIF, compression, cache headers + live server probe + Google Lighthouse via free PSI API |
| Security | SSL cert validity & expiry days, 6 recommended security headers, HTTP→HTTPS redirect, mixed-content scan, SPF & DMARC |
| Mobile | Viewport, touch icons, theme colour, legible font sizes |
| Content | Word count, keyword stuffing, title↔H1 alignment, Flesch readability, reading time, helpful-content (Who/How/Why) proxies |
| Local SEO (AU) | .au domain, state/city mentions, AU phone formats, PostalAddress schema, geo meta, Maps embed & review widgets, ABN, click-to-call, opening hours, social profiles |

Plus: Google SERP snippet preview, overall A–F grade, plain-English fixes for every warning.

**Page 3 — Skills Hub (`/skills`) & API Reference (`/api`)**
- 25 integrated skill modules (13 auto-run in every audit, 9 guided playbooks)
- `/api` documents every endpoint with live "Run" examples against the server

**Page 2 — Free Backlinks & Blogger Directory (`/backlinks`)**
- Free self-serve listing form (validated, persisted to `data/backlinks.json`)
- Filter listings by state & category
- 14 curated free backlink sources for Australia (Google Business Profile, Bing Places, Apple Business Connect, Yellow Pages, TrueLocal, Hotfrog, Qwoted, Featured, …) — 13 external sites plus this directory itself
- Backlink safety tips

## Built entirely on free GitHub repos & free APIs
- [Express](https://github.com/expressjs/express) — web server
- [Cheerio](https://github.com/cheeriojs/cheerio) — HTML parsing
- [Google Lighthouse](https://github.com/GoogleChrome/lighthouse) via the free PageSpeed Insights API (optional `PAGESPEED_API_KEY` env var raises quota)
- Free RDAP for domain age, Node built-ins for DNS/TLS checks

## Run it
```bash
npm start            # recommended: self-healing launcher
# or directly:
npm install
node server.js       # http://localhost:3000
```

`npm start` runs `start.sh`, which:
- reinstalls dependencies if a sandbox reset wiped them
- neutralizes a broken `PORT` env (e.g. `PORT=0` or `PORT=abc` would make Node pick a random port)
- takes over the port if a stale instance is still running
- **verifies `/api/health` answers** before declaring the server up (exits non-zero with the log tail otherwise)

Use `PORT=8080 npm start` to run on a different port; check `server.log` if anything goes wrong.

`npm stop` stops the server again — it finds whatever is listening on the port (with the same `PORT` env override), tries a graceful close first, then force-kills if needed. `start.sh` uses the same logic (`stop.sh` holds the shared helpers) to take over a port left busy by a stale instance.

## Deploy to Cloudflare Workers
The same audit engine runs on Cloudflare (`worker.js` + `wrangler.toml`).

**Push deploys are handled by Cloudflare Workers Builds** (Cloudflare's Git
integration — it clones the repo itself and runs `npx wrangler deploy`; no
GitHub secrets needed). Connect the repo once at dash.cloudflare.com →
Workers & Pages → this Worker → Settings → Build, and every push deploys.

The `.github/workflows/deploy.yml` workflow is **manual-trigger only**
(Actions tab → run manually) as an alternative path; it requires the
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` repo secrets. CI
(`ci.yml`) runs on every push and includes a `wrangler deploy --dry-run`
bundling gate so deploy-breaking changes can't land.

Deploy by hand from a local checkout with:
```bash
npx wrangler deploy
```
- Pages (`/`, `/backlinks`, `/skills`) are served from `public/` as Static Assets.
- `/api/audit`, `/api/perf`, `/api/speed`, `/api/health` run the identical engine.
- Deterministic checks (HTML parsing, schema, hreflang, robots, links, speed probe)
  produce the **same results** on Workers and Node.
- Runtime-bound checks (raw DNS lookups, TLS certificate inspection) are not
  available in the Workers sandbox — they degrade to an "info" note there.
  For 100% identical reports, host the Node version (optionally behind the
  Cloudflare proxy) or accept the two info-level differences.
- The backlink directory needs storage; on Workers bind a KV or keep it on Node.

## Skills Hub — 25 integrated skill modules
All 25 SEO skill modules from the knowledge base are surfaced on `/skills`:
- **13 × AUTO** (contribute live checks to every audit): technical, geo, local,
  schema, sitemap, hreflang, images, content, sxo, ecommerce, maps,
  audit (scoring framework), drift (snapshots).
- **9 × PLAYBOOK** (guided strategy checklists): cluster, competitor-pages,
  content-brief, plan, flow, page, programmatic, visual/image-gen, google.
- **3 × special**: `seo-backlinks` (the `/backlinks` page as a PAGE skill),
  the master `seo` router (HUB), and `seo-dataforseo` (OPTIONAL paid-data add-on,
  listed for completeness — this toolkit stays 100% free).
- **Drift tracking**: each audit is snapshotted per host (`data/snapshots.json`);
  re-runs show score delta ("92 → 93, +1") in the UI and API.

## API
Full interactive reference with live examples: **`/api`** on any running instance.

- `GET /api/health` — liveness probe (`{"ok":true}`) used by the UI and `start.sh`
- `GET /api/audit?url=example.com.au` — full audit JSON (groups, scores, drift)
- `GET /api/perf?url=…` — 3-run TTFB/weight probe (average + best)
- `GET /api/speed?url=…&strategy=mobile|desktop` — Lighthouse via PSI
- `GET|POST /api/backlinks` — directory list / submit listing

Every API failure returns JSON (`{"error":"…"}`), never an HTML error page.
Audit requests time out after 50s server-side; the UI aborts at 60s.
