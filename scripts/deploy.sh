#!/usr/bin/env bash
# Usage: bash scripts/deploy.sh [patch|minor|major]
# Bumps the version, commits it, and pushes to main.
# Railway auto-deploys on push — the version bump ensures asset cache-busting.
set -euo pipefail

BUMP="${1:-patch}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [[ "$BUMP" != "patch" && "$BUMP" != "minor" && "$BUMP" != "major" ]]; then
  echo "Usage: $0 [patch|minor|major]"
  exit 1
fi

# Require clean working tree (untracked files are OK)
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Error: uncommitted changes present. Commit or stash before deploying."
  exit 1
fi

# Require current branch to be main
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [[ "$BRANCH" != "main" ]]; then
  echo "Error: must be on main branch to deploy (current: $BRANCH)."
  exit 1
fi

echo "==> Running tests..."
npm test

echo "==> Bumping $BUMP version..."
npm version "$BUMP" --no-git-tag-version
NEW_VERSION="$(node -p "require('./package.json').version")"

echo "==> Committing v${NEW_VERSION}..."
git add package.json package-lock.json
git commit -m "chore: release v${NEW_VERSION}"

echo "==> Pushing to main..."
git push origin main

echo ""
echo "Done. v${NEW_VERSION} pushed — Railway will deploy shortly."
