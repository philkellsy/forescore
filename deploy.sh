#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP="${APP:-legends}"
REGION="${REGION:-syd}"
VOLUME_NAME="${VOLUME_NAME:-legends_data}"
CONFIG_FILE="${CONFIG_FILE:-$ROOT_DIR/fly.toml}"
DOCKERFILE="${DOCKERFILE:-$ROOT_DIR/Dockerfile}"
REQUIRED_FLY_ACCOUNT="${REQUIRED_FLY_ACCOUNT:-phil@kellskin.com}"

if [[ -n "${FLY_API_TOKEN:-}" && -z "${FLY_ACCESS_TOKEN:-}" ]]; then
  export FLY_ACCESS_TOKEN="$FLY_API_TOKEN"
fi

if command -v flyctl >/dev/null 2>&1; then
  FLY_BIN="flyctl"
elif command -v fly >/dev/null 2>&1; then
  FLY_BIN="fly"
else
  echo "Missing dependency: flyctl (or fly)"
  exit 1
fi

need() { command -v "$1" >/dev/null 2>&1 || { echo "Missing dependency: $1"; exit 1; }; }
need date
need npm

echo "==> Using app: $APP (region: $REGION)"
echo "==> Config: $CONFIG_FILE"
echo "==> Dockerfile: $DOCKERFILE"
echo "==> Required Fly account: $REQUIRED_FLY_ACCOUNT"

echo "==> Running local tests..."
(
  cd "$ROOT_DIR"
  npm test
)
echo "==> Local tests passed."

if [[ ! -f "$CONFIG_FILE" ]]; then
  echo "Config file not found: $CONFIG_FILE"
  exit 1
fi
if [[ ! -f "$DOCKERFILE" ]]; then
  echo "Dockerfile not found: $DOCKERFILE"
  exit 1
fi

if ! "$FLY_BIN" auth token >/dev/null 2>&1; then
  echo "You are not logged in to Fly."
  echo "Provide FLY_API_TOKEN/FLY_ACCESS_TOKEN or run: $FLY_BIN auth login"
  exit 1
fi

CURRENT_FLY_ACCOUNT="$("$FLY_BIN" auth whoami 2>/dev/null | tr -d '\r' | awk 'NF{print $1; exit}')"
if [[ "$CURRENT_FLY_ACCOUNT" != "$REQUIRED_FLY_ACCOUNT" ]]; then
  echo "==> Fly account mismatch (current: ${CURRENT_FLY_ACCOUNT:-unknown}, required: $REQUIRED_FLY_ACCOUNT)"
  if [[ -n "${FLY_API_TOKEN:-}" || -n "${FLY_ACCESS_TOKEN:-}" ]]; then
    echo "Token-based auth is active; cannot switch interactively."
    echo "Use a token for $REQUIRED_FLY_ACCOUNT."
    exit 1
  fi
  echo "==> Re-authenticating with Fly..."
  "$FLY_BIN" auth logout >/dev/null 2>&1 || true
  "$FLY_BIN" auth login
  CURRENT_FLY_ACCOUNT="$("$FLY_BIN" auth whoami 2>/dev/null | tr -d '\r' | awk 'NF{print $1; exit}')"
  if [[ "$CURRENT_FLY_ACCOUNT" != "$REQUIRED_FLY_ACCOUNT" ]]; then
    echo "Fly login check failed. Required account: $REQUIRED_FLY_ACCOUNT, current: ${CURRENT_FLY_ACCOUNT:-unknown}"
    exit 1
  fi
fi
echo "==> Fly account verified: $CURRENT_FLY_ACCOUNT"

echo "==> Ensuring app exists..."
"$FLY_BIN" apps create "$APP" >/dev/null 2>&1 || true

echo "==> Locating volume..."
VOL_ID=""
if command -v jq >/dev/null 2>&1; then
  VOL_ID="$("$FLY_BIN" -a "$APP" volumes list --json | jq -r --arg name "$VOLUME_NAME" '.[] | select(.name == $name) | .id' | head -n1)"
else
  VOL_ID="$("$FLY_BIN" -a "$APP" volumes list | awk -v name="$VOLUME_NAME" '$2==name{print $1; exit}')" || true
fi
if [[ -z "${VOL_ID:-}" ]]; then
  echo "No volume named '$VOLUME_NAME' found for $APP. Create one first:"
  echo "  $FLY_BIN -a \"$APP\" volumes create \"$VOLUME_NAME\" --size 1 --region $REGION"
  exit 1
fi
echo "   Volume: $VOL_ID ($VOLUME_NAME)"

echo '==> Creating volume snapshot (best-effort)...'
if ! "$FLY_BIN" volumes snapshots create "$VOL_ID" >/dev/null 2>&1; then
  echo "Warning: snapshot creation failed (continuing)."
  "$FLY_BIN" volumes snapshots create "$VOL_ID" || true
fi

TS="$(date +%Y%m%d%H%M)"
if command -v git >/dev/null 2>&1; then
  APP_VERSION="$(git -C "$ROOT_DIR" rev-parse --short HEAD 2>/dev/null || echo "$TS")"
else
  APP_VERSION="$TS"
fi

echo "==> Setting release marker secret APP_VERSION=$APP_VERSION"
"$FLY_BIN" secrets set APP_VERSION="$APP_VERSION" -a "$APP"

echo "==> Deploying to Fly..."
"$FLY_BIN" deploy \
  --app "$APP" \
  --config "$CONFIG_FILE" \
  --dockerfile "$DOCKERFILE" \
  --strategy immediate

echo "==> Fly status:"
"$FLY_BIN" status -a "$APP" || true
echo "==> Done."
