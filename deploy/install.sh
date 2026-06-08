#!/usr/bin/env bash
# Host deploy for the COROS -> Hermes notifier (notify-activities).
# Run ON THE VPS, from the repo root: bash deploy/install.sh
# Prereqs on the host: Node >= 22 (ideally 24, see .nvmrc), git, and a .env file.
# It does NOT touch your crontab — it prints the exact line for you to add (review first).
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

# 1. Node present?
if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: 'node' not found on the host. Install Node 24 (see .nvmrc) and re-run." >&2
  exit 1
fi
echo "Node:  $(node -v)   (repo targets v$(cat .nvmrc 2>/dev/null | tr -d 'v\n' || echo '24'))"

# 2. pnpm via corepack (matches packageManager in package.json)
corepack enable >/dev/null 2>&1 || true
corepack prepare pnpm@11.2.2 --activate >/dev/null 2>&1 || true
if ! command -v pnpm >/dev/null 2>&1; then
  echo "ERROR: pnpm unavailable (corepack failed). Install pnpm 11 and re-run." >&2
  exit 1
fi
echo "pnpm:  $(pnpm -v)"

# 3. Install deps + build
pnpm install --frozen-lockfile
pnpm build
[ -f dist/main.js ] || { echo "ERROR: build did not produce dist/main.js" >&2; exit 1; }

# 4. .env sanity (do NOT print secrets)
if [ ! -f .env ]; then
  echo "ERROR: .env missing. Create it from .env.example with:" >&2
  echo "       COROS_API_URL=https://teameuapi.coros.com" >&2
  echo "       COROS_EMAIL / COROS_PASSWORD" >&2
  echo "       HERMES_WEBHOOK_URL=http://127.0.0.1:8644/webhooks/coros" >&2
  echo "       HERMES_WEBHOOK_SECRET=<your route secret>" >&2
  exit 1
fi
for key in COROS_API_URL COROS_EMAIL COROS_PASSWORD HERMES_WEBHOOK_URL; do
  grep -q "^${key}=" .env || echo "WARN: ${key} not set in .env"
done
grep -q "^HERMES_WEBHOOK_SECRET=" .env || echo "WARN: HERMES_WEBHOOK_SECRET not set (Hermes route requires a signature)."

echo
echo "Build OK -> $REPO/dist/main.js"
echo "First run will BOOTSTRAP (seed state, no notifications). Try it once now:"
echo "    node dist/main notify-activities"
echo
NODE_BIN="$(command -v node)"
echo "Then add ONE of these to your crontab (crontab -e):"
echo "  # every minute:"
echo "  * * * * * cd $REPO && $NODE_BIN dist/main notify-activities >> $REPO/notify.log 2>&1"
echo "  # every 5 minutes (gentler on the unofficial COROS API, recommended):"
echo "  */5 * * * * cd $REPO && $NODE_BIN dist/main notify-activities >> $REPO/notify.log 2>&1"
echo
echo "Note: the absolute node path is used because cron has a minimal PATH."
