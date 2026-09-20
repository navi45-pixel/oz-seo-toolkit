# Postmortem: bugs the automated gates have caught

**Repo:** `navi45-pixel/oz-seo-toolkit` · **Window:** 2026-09-12 → 2026-09-18 (34 commits) · **Doc updated:** 2026-09-18

This document exists to answer one question with evidence: *do the automated gates earn their keep?*
Every incident below is a bug the gates caught before or after it shipped — with the gate that fired,
the root cause, the fix commit, and how to re-verify it. Near-misses and things the gates did
**not** catch are listed too, because a gate ledger that only records wins is marketing, not engineering.

---

## 1. The gate inventory

| Gate | Where it runs | What it checks | Failure mode |
|---|---|---|---|
| `ci.yml` → smoke-test job | every push / PR | README-vs-code counts, launcher + `/api/health`, full `smoke.js` suite, wrangler dry-run bundle | red build |
| `check:readme` (also `npm test`) | CI + locally | README's check count & Skills Hub module counts vs actual `<span class="tag">` cards and `add()` call sites in `lib/` | red build |
| `check:routes` (also `npm test`) | CI + locally | the 404 suggester's `data-sugg` route map vs real routes in `server.js` **and** `worker.js` (3-way sync) | red build |
| `smoke.js` (17 checks) | CI, `deploy.sh`, on demand | health, a real audit, a real multi-page crawl, backlinks shape/privacy/pagination/cursor, admin lockout, robots, sitemap, branded 404 + JSON 404, all pages, **self-drift** | red build / failed deploy |
| `deploy.sh` | manual deploys | wrangler build → deploy → smoke suite → live-vs-repo drift check | deploy aborts non-zero |
| `drift.yml` site-drift job | daily 22:05 UTC + dispatch | live worker's headers, cache policy, HTTPS 301, canonical/og:url per page, robots rules, sitemap locs/lastmod, 404, content fingerprints (title/description/h1–h3/nav/FAQ) vs repo | red job + deduplicated issue |
| `drift.yml` kv-drift job | daily 22:05 UTC | Workers KV directory vs repo-side store (`sync-kv.js --check` against the latest `backlinks-merged` artifact) | red job + dedicated issue |
| `sync-kv.yml` | daily 21:17 UTC + push | pull-merge → verified push of the backlink store; per-step secrets guard | red job |
| `/api/health` + launcher gate | `start.sh`, UI | server answers health before the launcher reports success; PORT env neutralized | launcher fails loudly |

**Track record (last 100 Actions runs):** 41 runs — **40 green, 1 red**. The single red run was a
gate catch, not a flake (incident C-1). Zero silent regressions shipped to the worker during the window.

---

## 2. The catches

Format: what the gate saw → root cause → fix → re-verify.

### C-1 · CI (workflow run itself) — invalid `secrets` context kills the KV sync workflow
- **Date:** 2026-09-13 · **Commit:** fixed by `8e19349`
- **Gate saw:** the push-triggered run of the brand-new `sync-kv.yml` failed red — the only red run in the window.
- **Root cause:** GitHub Actions does not allow the `secrets` context in step-level `if:` conditions;
  the guard step referenced it directly and the workflow errored instead of skipping.
- **Fix:** guard moved into a `run:` shell step that reads the env vars itself.
- **Re-verify:** `gh run list --workflow sync-kv.yml` — all runs green since the fix.

### C-2 · Deploy (Workers Builds) — Workers bundle rejected Node built-ins → origin of the dry-run gate
- **Date:** 2026-09-12 · **Commits:** `0aa7954`
- **Gate saw:** Cloudflare's build failed: `Unexpected external import of "dns", "node:events", … Your worker has no default export…`
- **Root cause:** Service-Worker-format entry with bare imports; wrangler couldn't bundle the Node built-ins the audit engine uses.
- **Fix:** ES-module entry (`export default`) + `nodejs_compat`; **and** a permanent CI step
  (`wrangler deploy --dry-run`) so this class of regression fails in CI, not at deploy time.
- **Re-verify:** `npx wrangler deploy --dry-run --outdir=dist` locally, or any CI run.

### C-3 · `check:routes` — the new `/crawl` page had an API but no page route in `server.js`
- **Date:** 2026-09-17 · **Commit:** `709f2e7`
- **Gate saw:** `npm run check:routes` failed mid-feature: the interrupted crawl work had wired
  `/api/crawl` into `server.js` but the `/crawl` **page** route was never added. Node would have
  served a 404 page on a URL the nav, sitemap, robots and 404 suggester all advertised.
- **Root cause:** feature split across two runtimes and two route tables; only one got half the change.
- **Fix:** added the route; the gate now permanently 3-way-syncs 404-suggester data attributes ↔ `server.js` ↔ `worker.js`.
- **Re-verify:** `npm run check:routes`.

### C-4 · `smoke.js` — sitemap expectation went stale when the site grew from 4 to 5 pages
- **Date:** 2026-09-17 · **Commit:** `709f2e7`
- **Gate saw:** local smoke run `15/16` — `GET /sitemap.xml` failed because the check hardcoded 4 URLs.
- **Root cause:** the *check* was stale, not the site: a new page had been added and the expectation wasn't updated.
  The gate correctly refused to stay green while reality and expectation diverged — exactly its job, pointed at itself.
- **Fix:** sitemap check now expects the 5-page route list.
- **Re-verify:** `node scripts/smoke.js http://localhost:3000`.

### C-5 · Drift checker's first live run — Worker was caching **all JSON API responses for a day**
- **Date:** 2026-09-17 · **Commit:** `f9a3fb1`
- **Gate saw:** `check-drift.js` vs the live worker flagged cache-policy drift on API routes.
- **Root cause:** the Worker's cache-override wrapper (added in `c6328b4` to fix asset caching) stamped
  `max-age=86400` on **every** non-HTML response — clobbering the homepage strip's carefully-set
  `max-age=300` and letting browsers pin audit/health JSON for a day. Node never had the bug because
  its middleware skips `/api/`. The header-mirroring between runtimes had hidden exactly this asymmetry.
- **Fix:** `applyCachePolicy` (now a shared module, `lib/security-headers.js`) never touches `application/json`.
  Verified live: strip back to `max-age=300`.
- **Re-verify:** `npm run check:drift` (clean), or `curl -sI https://oz-seo-toolkit.multani-navdeep29.workers.dev/api/backlinks?limit=3 | grep -i cache-control`.

### C-6 · Deploy smoke — `/api/drift` on Workers reported *total* drift because a Worker cannot fetch its own URL
- **Date:** 2026-09-18 · **Commit:** `7ebcbdc`
- **Gate saw:** the post-deploy smoke suite failed `GET /api/drift` with every page, robots, sitemap,
  404 **and** headers "drifting" seconds after a successful deploy.
- **Root cause:** a Worker fetching its own workers.dev URL never re-enters the worker — Cloudflare
  answers the self-subrequest at the edge with a 404 block page (confirmed by probing: every self-fetch
  returned status 404 with an edge block page, while curl from outside got 200s). The endpoint compared
  that block page against the repo: total, false drift.
- **Fix:** `runSelfDrift({ selfFetch })` — Workers resolve self-probes through the same `servePage`
  pipeline real requests use (assets binding + security headers); Node keeps genuine HTTP round-trips
  (`mode: network` vs `mode: binding` is reported in the response).
- **Re-verify:** `curl -s https://oz-seo-toolkit.multani-navdeep29.workers.dev/api/drift | jq .ok` → `true`.

### C-7 · Deploy smoke — sitemap advertised a **future** `lastmod` (timezone bug in the generator)
- **Date:** 2026-09-18 · **Commit:** `7ebcbdc`
- **Gate saw:** post-deploy smoke failed `GET /sitemap.xml`: `invalid/missing lastmod: 1`.
- **Root cause:** `gen-sitemap.js`'s `utcDate()` subtracted `getTimezoneOffset()` — which converts
  *to local*, not to UTC. On a UTC+10 machine a commit landing 2026-09-18 local / 2026-09-17 UTC was
  emitted as `2026-09-18`, which the UTC-based smoke check rightly rejects as a future date.
- **Fix:** generator is genuinely UTC (`new Date(ms).toISOString()`), commit dates normalized via
  `Date` parsing and clamped to now.
- **Re-verify:** `node scripts/smoke.js <url>` — sitemap check passes; `grep lastmod public/sitemap.xml`.

### C-8 · Daily-job design exposed a **missing secret** and a silently-skipping workflow
- **Date:** 2026-09-18 (found while building the kv-drift job, commit `436152d`)
- **Gate saw (design-time):** the kv-drift job's baseline is the `backlinks-merged` artifact; when the
  artifact was missing, investigation showed every recent `sync-kv.yml` run was green, 6–9 seconds,
  with **zero artifacts** — the token guard was silently skipping because
  **`CLOUDFLARE_API_TOKEN` was not set in the repo at all**. The daily convergence had been a no-op for days.
- **Root cause:** secret lost outside the repo (local env only); guard design skipped instead of failing,
  which kept the skip invisible.
- **Fix / hardening:** kv-drift's guard logs the skip *loudly* and never claims a false green;
  the skip-vs-verified distinction is now visible in every run's logs. Secret re-addition remains an
  operator step (`gh secret set CLOUDFLARE_API_TOKEN`) — flagged in the kv-drift summary, not papered over.
- **Re-verify:** `gh run view <sync-kv-run> --log | grep -i "not set"` shows the guard's message path.

---

## 3. What the gates did **not** catch (and what closed the gap)

A gate ledger without misses is a brochure. These were found by other means:

1. **AU phone-format false negative in the audit engine** (2026-09-17, `8886941`): found by a
   *manual* sanity audit of jimsmowing.com.au, not by any gate — the engine ignored every `tel:` anchor
   after the first and had no branch for `(03) 9780 9998` or the 131 546 smart-number. The 24-case
   battery that now guards the regex ran ad-hoc; **it is still not a permanent CI test** (open item).
2. **Hreflang case-sensitivity false positive** (same session): our validator demanded uppercase region
   codes; Google's own docs use lowercase (`en-au`). Also found manually, fixed in `8886941`.
3. **`similarityPct` always returned 0%** (2026-09-18): the self-drift engine's LCS split on newlines
   that the normalizer had already removed. Caught by the throwaway mutation rig **before commit** —
   the lesson: the rig existed because the feature was tested against a deliberately-mutated copy, and
   that habit catches bugs pre-ship that CI can't see.
4. **The drift checker's own bugs** (http probe actually fetching the https URL; expecting a cache
   header localhost correctly never sets): caught by direct curl cross-examination the same session.
   Gates need gates; every checker change still gets a manual adversarial pass.
5. **Browser cache false alarms during UI verification** (duplicate nav link that wasn't there):
   caught by comparing disk vs served vs DOM — a manual discipline, not automatable in CI cheaply.
6. **CSP silently unstyled the entire site** (2026-09-20, user-reported): the CSP was written when
   every page carried inline `<style>` blocks (`style-src 'unsafe-inline'`); consolidating to an
   external `/css/styles.css` made every real browser **block the stylesheet** — every page rendered
   raw HTML. Every byte-level gate stayed green because curl/smoke/drift fetch bytes and headers but
   never *execute* CSP; only a human looking at the Preview caught it. Fixed by adding `'self'` to
   `style-src` with a warning comment in `security-headers.js`. **Lesson:** header *presence* checks
   are not header *enforcement* checks — any change to how resources are loaded needs one manual
   look in a real browser.

**Pattern:** gates are strongest on *structural* drift (routes, counts, headers, dates, shapes) and
weakest on *semantic* accuracy (does the phone regex mean the right thing?) — and blind to browser
*enforcement* (CSP execution, M-6). The manual sanity-run
habit against real AU sites is the complementary gate, and it has its own catch ledger (`8886941`).

---

## 4. Why the gates earn their keep

- **Five of the eight catches (C-2, C-4, C-5, C-6, C-7) were shipped-code bugs** that user-visible
  surfaces would have hit: a JSON cache pinning API data for a day, a page 404ing behind its own nav,
  a sitemap telling crawlers the future, a self-check that lied.
- **The two CI-side catches (C-1, C-3) were both "two sources of truth" bugs** — precisely the class
  that code review reliably misses and a 3-way sync gate reliably doesn't.
- **One catch (C-8) turned a silent outage** (a daily job skipping for days behind green checkmarks)
  **into a visible, diagnosable finding** — the failure mode honest-degradation design exists for.
- **The red run count (1) with zero shipped regressions in the window** is the headline: the gates
  fail loudly at the moment of introduction, so nothing accumulates.

## 5. Maintenance

- This file is **append-only for incidents**: when a gate catches something new, add a `C-n` entry
  (date, gate, symptom, root cause, fix commit, re-verify) and update the run stats in §1.
- Adding a gate? Add it to the inventory table **and** give it a first catch to prove it works
  (mutation-test it against a deliberately broken copy — the drift lab and self-drift rigs in the
  history are the templates).
- Related docs: [custom-domain.md](custom-domain.md) (origin swap checklist),
  README §"Checks & gates" (how to run every gate locally).
