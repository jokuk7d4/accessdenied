#!/usr/bin/env sh
set -eu

echo "[app] Running Prisma migrations..."
npx prisma migrate deploy

echo "[app] Starting Next.js production server..."
exec npx next start -H 0.0.0.0 -p "${PORT:-3000}"
