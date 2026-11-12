#!/usr/bin/env bash
# Usage: scripts/deploy.sh <branch>
# Deploys public/ and functions/ to the Pages project named in wrangler.toml, then checks that the new
# deployment answers and reaches its database. "main" is production; any other branch is a preview
# (staging database and bucket), and "staging" is the staging deployment.
# Run the migrations of that environment first (pnpm db:migrate with its DATABASE_URL).
set -euo pipefail
branch=${1:?usage: scripts/deploy.sh <branch>}
log=$(mktemp)
trap 'rm -f "$log"' EXIT

pnpm exec wrangler pages deploy --branch "$branch" --commit-dirty=true | tee "$log"
url=$(grep -oE 'https://[a-z0-9-]+\.[a-z0-9.-]+\.pages\.dev' "$log" | head -1)
[ -n "$url" ] || { echo "no deployment URL in the wrangler output" >&2; exit 1; }
echo "checking $url"

curl -fsS --retry 5 --retry-all-errors -o /dev/null "$url/widget.js"
curl -fsS --retry 5 --retry-all-errors -o /dev/null "$url/api/limits"
# An unknown key is looked up in the database, so a 401 means the Functions and the database work.
code=$(curl -s -o /dev/null -w '%{http_code}' --retry 5 -X POST -H 'X-Project-Key: deploy-smoke-test' "$url/api/submit")
[ "$code" = 401 ] || { echo "api/submit answered $code, expected 401" >&2; exit 1; }
echo "ok: $branch is live and reaches its database"
