#!/usr/bin/env bash
# deploy.sh — deploy to Cloudflare Workers and verify the live URL actually works.
#
# Usage:
#   bash deploy.sh                    deploy, then smoke-test the deployed URL
#   bash deploy.sh --no-smoke         deploy only
#   BASE_URL=https://... bash deploy.sh
#                                     deploy, then smoke-test BASE_URL instead
#
# Auth: `npx wrangler login` once, or set CLOUDFLARE_API_TOKEN
# (+ CLOUDFLARE_ACCOUNT_ID) in the environment.

set -euo pipefail

cd "$(dirname "$0")"

SMOKE=1
BASE_URL="${BASE_URL:-}"
for arg in "$@"; do
  case "$arg" in
    --no-smoke) SMOKE=0 ;;
    *) echo "Unknown option: $arg (supported: --no-smoke)"; exit 2 ;;
  esac
done

echo "==> Refreshing sitemap lastmod dates from git history..."
node scripts/gen-sitemap.js

echo "==> Deploying to Cloudflare Workers..."
DEPLOY_OUTPUT=$(npx -y wrangler deploy 2>&1)
echo "$DEPLOY_OUTPUT"

# Extract the deployed workers.dev URL from wrangler's output.
URL=$(echo "$DEPLOY_OUTPUT" | grep -oE 'https://[a-zA-Z0-9.-]+\.workers\.dev' | tail -1 || true)

if [ "$SMOKE" -eq 1 ]; then
  TARGET="${BASE_URL:-$URL}"
  if [ -z "$TARGET" ]; then
    echo "ERROR: could not find a workers.dev URL in the deploy output and BASE_URL is not set." >&2
    echo "Run the smoke test manually: node scripts/smoke.js https://<your-worker>.workers.dev" >&2
    exit 1
  fi
  echo
  echo "==> Smoke testing $TARGET ..."
  node scripts/smoke.js "$TARGET"
  echo
  echo "==> Drift check: live behaviour vs repo (headers, cache, canonicals, robots, sitemap)..."
  DRIFT_BASE_URL="$TARGET" node scripts/check-drift.js "$TARGET"
else
  echo
  echo "==> Deploy complete (smoke test skipped)."
  [ -n "$URL" ] && echo "    Live at: $URL"
fi
