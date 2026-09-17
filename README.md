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

Plus: Google SERP snippet preview, overall A–F grade, plain-English fixes for every warning, and a live "recently listed" strip from the backlink directory (3 newest; hidden entirely when the backend is asleep or the directory is empty).

**Page 3 — Skills Hub (`/skills`) & API Reference (`/api`)**
- 25 integrated skill modules (13 auto-run in every audit, 9 guided playbooks)
- `/api` documents every endpoint with live "Run" examples against the server

**Page 4 — Site Crawler (`/crawl`)**
- Adaptive multi-page crawler: up to 25 pages per crawl (Workers caps: 15), depth-limited BFS seeded from robots.txt + sitemap.xml
- Polite by design: honours robots.txt (including Crawl-delay), auto-throttles per response speed, backs off with Retry-After, detects challenges/blocks, skips query-string and off-site URLs
- Prioritised findings, each with captured evidence, a plain-English fix and an acceptance check: missing/duplicate/long titles, missing descriptions & canonicals, duplicate/missing H1s, missing alt text, wrong lang/viewport, error/unreachable pages
- Same engine on Node and Workers (`lib/crawl.js`, zero new dependencies)

**Page 2 — Free Backlinks & Blogger Directory (`/backlinks`)**
- Free self-serve listing form (validated, persisted to `data/backlinks.json`; submitter emails are stored for the operator but never exposed via the API or the page)
- Anti-spam on `POST /api/backlinks`: per-IP limit of 3 successful submissions per rolling hour with a 30s minimum gap — identical logic on Node and Workers (in-memory counters on Node, auto-expiring KV counters on the edge)
- Operator moderation: `GET /api/admin/listings` (full records incl. emails) and
  `DELETE /api/admin/listings/:id`, gated by a bearer token — `ADMIN_TOKEN` env
  var on Node, `npx wrangler secret put ADMIN_TOKEN` on Workers. Timing-safe
  comparison; endpoints answer 503 (closed) when no token is configured
- Filter listings by state & category; API supports stable cursor pagination
  (`GET /api/backlinks?after=<id>&limit=50` — pages never shift when new
  listings arrive mid-scroll; offset paging still works)
- 14 curated free backlink sources for Australia (Google Business Profile, Bing Places, Apple Business Connect, Yellow Pages, TrueLocal, Hotfrog, Qwoted, Featured, …) — 13 external sites plus this directory itself
- Backlink safety tips
- Listing links are crawl-safe by design: submitted URLs are normalized at
  intake (UTM/tracking params, query strings and fragments stripped, stored
  scheme-canonicalized) and rendered with `rel="nofollow ugc"` — so listings
  never leak paid-link signals or tracking URLs, and all toolkit pages carry
  self-canonical tags
- Crawler files: `public/robots.txt` allows all crawlers (blocking only the
  unbounded audit endpoints and the operator-only `/api/admin/`), points at
  `public/sitemap.xml`, which lists the five site pages (`/`, `/backlinks`,
  `/crawl`, `/skills`, `/api`) at their canonical workers.dev URLs — served on Node
  (Express static) and Workers (Static Assets) alike. Sitemap `<lastmod>`
  dates are regenerated from git commit history by `npm run gen:sitemap`,
  which `deploy.sh` runs automatically before every deploy (note: deploys
  triggered from the Cloudflare dashboard's Workers Builds skip this, so run
  `npm run deploy` locally after page changes to keep dates fresh)
- Branded 404s: unknown page URLs serve a styled `public/404.html` (site
  chrome, links back to the tools, `noindex`) with a true 404 status — plus a
  client-side suggestion box that fuzzy-matches the requested path against the
  four real pages (exact keyword, plural/singular and bigram typo distance)
  and offers the closest one when confident — the route map lives in
  `data-sugg*` attributes on the nav anchors and `npm run check:routes`
  (part of `npm test`) fails CI if it ever drifts from the pages in
  `public/`, the server routes or the sitemap; unknown
  `/api/*` routes get a JSON 404 error — identical behaviour on Node (catch-all
  middleware) and Workers (asset-miss fallback)
- Share & trust hygiene: every page carries Open Graph/Twitter cards (using
  `public/og-image.png`, regenerable via `node scripts/make-og-image.js`) and
  typed JSON-LD (WebSite / CollectionPage / ItemList / WebAPI); all responses
  set HSTS, `X-Content-Type-Options`, `X-Frame-Options: DENY`, Referrer-Policy,
  Permissions-Policy and a strict CSP (inline-only, no external resources) —
  identical on Node (middleware) and Workers (`run_worker_first` + header
  wrapper, since asset-first routing would otherwise bypass the worker)

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

`npm run smoke` runs the smoke tests (`scripts/smoke.js`, dependency-free) against a running instance — defaults to `http://localhost:3000`, or pass any URL: `npm run smoke -- https://<worker>.workers.dev`. The checks: `/api/health`, a real audit, a small real multi-page crawl, the backlink directory shape, and every page returning 200.

## Deploy to Cloudflare Workers
The same audit engine runs on Cloudflare (`worker.js` + `wrangler.toml`).

**Custom domain:** the full cutover runbook — DNS records, Cloudflare domain
attachment, the one-command canonical/sitemap/robots origin swap
(`node scripts/set-origin.js <url>`, safe by construction: it replaces only
URLs on the current canonical host), Search Console handover and the SPF/DMARC
records that close the last self-audit fail — lives in
[docs/custom-domain.md](docs/custom-domain.md).

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
npm run deploy               # deploy + automatic smoke test of the live URL
npx wrangler deploy          # deploy only
```
`npm run deploy` runs `deploy.sh`: it deploys, extracts the live workers.dev
URL from wrangler's output, then runs the shared smoke tests **and a drift
check** against it (`--no-smoke` to skip; `BASE_URL=https://... npm run deploy`
targets a different URL instead of the freshly deployed one). CI runs the same
`scripts/smoke.js`, so local, CI, and post-deploy checks cannot drift.

**Drift detection** — `npm run check:drift` diffs the deployed worker's
*behaviour* against the repo so a stale deploy, a hand-changed Cloudflare
dashboard setting, or an undeployed file edit gets caught automatically:
security headers + cache policy (read back from `lib/security-headers.js`,
the single copy shared by Node and Workers), the HTTP→HTTPS 301, every page
returning 200 with its repo canonical/`og:url` tags, **content
fingerprints** for every page and the 404 (title, meta description, all
h1–h3 headings, nav links and FAQPage JSON-LD Q&A — diffs name the exact
item that changed, so a stale deploy shipping yesterday's FAQ is caught
even when every header looks right), robots.txt rules,
sitemap `<loc>`/`<lastmod>` validity and the `/api/health` contract. It
derives the deploy origin from `public/sitemap.xml` (one source of truth —
survives the custom-domain swap) or takes an explicit URL:
`node scripts/check-drift.js https://<worker>.workers.dev` (`--local` for
localhost). The scheduled **drift.yml** workflow runs it daily and opens a
deduplicated GitHub issue on any difference; it also runs after every
`npm run deploy`.
- Pages (`/`, `/backlinks`, `/crawl`, `/skills`, `/api`) are served from `public/` as Static Assets.
- `/api/audit`, `/api/perf`, `/api/speed`, `/api/health` run the identical engine.
- The backlink directory persists in a **KV namespace** (`BACKLINKS`, id
  `2b4845a99d4f43729bdc6df50a1fd440`) — the whole directory is one JSON array
  under the key `backlinks`. Same validation, dedupe and response shapes as Node.
- To (re)seed or sync the directory from the Node data file:
  ```bash
  npm run sync:kv             # push data/backlinks.json → KV, verify read-back
  npm run sync:kv -- --pull   # merge Workers submissions back into the file
  npm run sync:kv -- --check  # verify only (exit 1 if the two sides differ)
  ```
  `--pull` is a safe merge, not an overwrite: it takes the union of both
  sides (by listing id, then deduping identical hostnames), writes the
  result back to `data/backlinks.json`, converges KV to the same union, and
  verifies both. Run it after periods of Workers traffic so the Node store
  picks up submissions made on the edge.  The script reads the namespace id from `wrangler.toml` and always uses
  `--remote` (wrangler 4 defaults KV commands to *local* storage — the
  classic silent no-op). Verification is an authoritative read-back via the
  KV API, not the edge cache; edge readers can still lag ~60s afterwards.
- **Automatic convergence**: `.github/workflows/sync-kv.yml` runs the
  pull-merge + verified push **daily at 21:17 UTC** (and on demand via
  *Run workflow*). It needs the `CLOUDFLARE_API_TOKEN` repo secret (KV edit
  permission); without it the job skips instead of failing red. The merged
  store — which contains submitter emails — is **never committed** to the
  public repo; it lives in the KV namespace (authoritative) and as a
  private 90-day run artifact (offsite backup). A fresh clone adopts the
  directory with a single `npm run sync:kv -- --pull`.
- Deterministic checks (HTML parsing, schema, hreflang, robots, links, speed probe)
  produce the **same results** on Workers and Node.
- Runtime-bound checks (raw DNS lookups, TLS certificate inspection) are not
  available in the Workers sandbox — they degrade to an "info" note there.
  For 100% identical reports, host the Node version (optionally behind the
  Cloudflare proxy) or accept the two info-level differences.
- KV is eventually consistent: a fresh listing can take up to ~60s to appear
  for readers on other edges (the writing edge sees it immediately).
- Without the `BACKLINKS` KV binding, directory endpoints return a
  descriptive 501 JSON error; audits always work.

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
- `GET /api/crawl?url=…&pages=10&depth=3` — multi-page crawl report (score, prioritised findings with evidence/fix/acceptance, per-page stats, throttle notes; Workers caps: 15 pages / 30s budget)

Every API failure returns JSON (`{"error":"…"}`), never an HTML error page.
Audit requests time out after 50s server-side; the UI aborts at 60s.
