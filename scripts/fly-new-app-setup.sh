#!/usr/bin/env bash
set -euo pipefail

if ! command -v flyctl >/dev/null 2>&1; then
  echo "flyctl is required. Install it first: https://fly.io/docs/flyctl/install/"
  exit 1
fi

APP_NAME="${1:-}"
PRIMARY_REGION="${2:-syd}"
VOLUME_NAME="${3:-legends_data}"
VOLUME_SIZE_GB="${4:-1}"

if [[ -z "${APP_NAME}" ]]; then
  echo "Usage: scripts/fly-new-app-setup.sh <app-name> [region] [volume-name] [volume-size-gb]"
  echo "Example: scripts/fly-new-app-setup.sh legends-2026 syd legends_data 1"
  exit 1
fi

echo "Creating Fly app: ${APP_NAME}"
flyctl apps create "${APP_NAME}" || true

echo "Creating volume: ${VOLUME_NAME} (${VOLUME_SIZE_GB}GB) in ${PRIMARY_REGION}"
flyctl volumes create "${VOLUME_NAME}" \
  --size "${VOLUME_SIZE_GB}" \
  --region "${PRIMARY_REGION}" \
  --app "${APP_NAME}" || true

cat <<EOF

Next steps:
1. Set secrets:
   flyctl secrets set \
     SESSION_SECRET="<strong-random-secret>" \
     APP_BASE_URL="https://${APP_NAME}.fly.dev" \
     BREVO_API_KEY="<brevo-api-key>" \
     BREVO_SENDER_EMAIL="<verified-sender-email>" \
     BREVO_SENDER_NAME="Legends Golf" \
     --app "${APP_NAME}"

2. Deploy:
   flyctl deploy --app "${APP_NAME}"

3. Open:
   flyctl open --app "${APP_NAME}"

EOF
