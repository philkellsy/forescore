#!/bin/bash
# Usage: ./scripts/deploy.sh [patch|minor|major]
# Bumps version, backs up production DB, pushes to main (Railway auto-deploys).
#
# Prerequisites:
#   - On main branch with a clean working tree
#   - PROD_DATABASE_URL set in environment or .env (Railway Postgres public URL)
#     Get it from: Railway dashboard → Postgres → Connect → Public URL
#   - pg_dump available (Postgres.app: add /Applications/Postgres.app/Contents/Versions/latest/bin to PATH)
set -e

BUMP="${1:-patch}"
if [[ "$BUMP" != "patch" && "$BUMP" != "minor" && "$BUMP" != "major" ]]; then
  echo "Usage: $0 [patch|minor|major]" >&2
  exit 1
fi

# ── Helpers ───────────────────────────────────────────────────────────────────
red()   { echo -e "\033[0;31m$*\033[0m"; }
green() { echo -e "\033[0;32m$*\033[0m"; }
bold()  { echo -e "\033[1m$*\033[0m"; }
step()  { echo ""; bold "▶ $*"; }

# ── 1. Load .env if it exists (for PROD_DATABASE_URL) ─────────────────────────
if [ -f .env ]; then
  set -o allexport
  # shellcheck disable=SC1091
  source .env
  set +o allexport
fi

# ── 2. Pre-flight checks ───────────────────────────────────────────────────────
step "Pre-flight checks"

BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$BRANCH" != "main" ]; then
  red "Must be on main branch (currently on $BRANCH)"
  exit 1
fi

if ! git diff --quiet || ! git diff --cached --quiet; then
  red "Working tree is not clean. Commit or stash changes first."
  exit 1
fi

# Check local is up to date with remote
git fetch origin main --quiet
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)
if [ "$LOCAL" != "$REMOTE" ]; then
  red "Local main is not up to date with origin/main. Pull first."
  exit 1
fi

green "  On main, working tree clean, up to date with remote"

# ── 3. Run tests ──────────────────────────────────────────────────────────────
step "Running tests"
npm test
green "  Tests passed"

# ── 4. Production DB backup ───────────────────────────────────────────────────
step "Production DB backup"

PG_DUMP_BIN="pg_dump"
if ! command -v pg_dump &>/dev/null; then
  # Postgres.app
  PGAPP_BIN="/Applications/Postgres.app/Contents/Versions/latest/bin/pg_dump"
  if [ -f "$PGAPP_BIN" ]; then
    PG_DUMP_BIN="$PGAPP_BIN"
  else
    red "  pg_dump not found. Install Postgres.app or add pg_dump to PATH."
    echo "  Skipping backup. Press Enter to continue without a backup, or Ctrl-C to abort."
    read -r
    PG_DUMP_BIN=""
  fi
fi

if [ -n "$PG_DUMP_BIN" ]; then
  if [ -z "$PROD_DATABASE_URL" ]; then
    red "  PROD_DATABASE_URL is not set."
    echo "  Set it to the Railway Postgres public URL (Railway → Postgres → Connect → Public URL)."
    echo "  You can add it to .env (it's gitignored)."
    echo "  Press Enter to continue without a backup, or Ctrl-C to abort."
    read -r
  else
    BACKUP_DIR="./backups"
    mkdir -p "$BACKUP_DIR"
    TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
    BACKUP_FILE="$BACKUP_DIR/forescore_pre_deploy_${TIMESTAMP}.dump"
    echo "  Backing up to $BACKUP_FILE ..."
    "$PG_DUMP_BIN" --format=custom --no-owner --no-acl "$PROD_DATABASE_URL" -f "$BACKUP_FILE"
    green "  Backup saved: $BACKUP_FILE"
    # Keep the last 10 backups only
    ls -t "$BACKUP_DIR"/forescore_pre_deploy_*.dump 2>/dev/null | tail -n +11 | xargs rm -f 2>/dev/null || true
  fi
fi

# ── 5. Bump version ───────────────────────────────────────────────────────────
step "Bumping version ($BUMP)"
npm version "$BUMP" --message "Release %s"
NEW_VERSION=$(node -p "require('./package.json').version")
green "  Version bumped to $NEW_VERSION"

# ── 6. Push to main ───────────────────────────────────────────────────────────
step "Pushing to main"
git push origin main --follow-tags
green "  Pushed. Railway will auto-deploy."

echo ""
green "✓ Deploy initiated — v$NEW_VERSION"
echo "  Monitor at: https://railway.app/dashboard"
