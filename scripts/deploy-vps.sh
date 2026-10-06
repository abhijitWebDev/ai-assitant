#!/usr/bin/env bash
# Redeploy to the VPS: sync the source, rebuild the container, check it answers.
#   npm run deploy
#
# Secrets stay on the server in /root/apps/research-agent/.env.production and the
# SQLite data in /root/apps/research-agent/data; this script never touches either.
set -euo pipefail

HOST="${DEPLOY_HOST:-root@72.61.224.97}"
DIR="/root/apps/research-agent"
URL="https://shodh.abhijitmone.com"

cd "$(dirname "$0")/.."

echo "Syncing source to $HOST:$DIR"
rsync -az --delete \
  --filter 'P data/' --filter 'P .env.production' \
  --exclude node_modules --exclude .next --exclude data --exclude .git --exclude .github \
  --exclude '.env' --exclude '.env.*' --exclude '*.log' --exclude 'tsconfig.tsbuildinfo' \
  ./ "$HOST:$DIR/"

echo "Building and restarting (a few minutes on 1 vCPU)"
ssh "$HOST" "cd $DIR && docker compose --env-file .env.production up -d --build && docker image prune -f >/dev/null"

echo "Checking $URL"
for i in $(seq 1 15); do
  code=$(curl -s -o /dev/null -w '%{http_code}' "$URL/api/config" || true)
  if [ "$code" = "200" ]; then echo "Live: $URL"; exit 0; fi
  sleep 2
done
echo "The site did not answer 200. Logs: ssh $HOST docker logs --tail 50 research-agent" >&2
exit 1
