#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_ENV_FILE="${ROOT_DIR}/.env.production.local"
JITSI_RUNTIME_ENV_FILE="${ROOT_DIR}/docker/jitsi/.env.runtime"

if [[ -f "${APP_ENV_FILE}" ]]; then
  docker compose --env-file "${APP_ENV_FILE}" -f "${ROOT_DIR}/docker-compose.prod.yml" down
else
  docker compose -f "${ROOT_DIR}/docker-compose.prod.yml" down
fi

if [[ -f "${JITSI_RUNTIME_ENV_FILE}" ]]; then
  docker compose --env-file "${JITSI_RUNTIME_ENV_FILE}" -f "${ROOT_DIR}/docker/jitsi/docker-compose.yml" down
else
  docker compose --env-file "${ROOT_DIR}/docker/jitsi/.env" -f "${ROOT_DIR}/docker/jitsi/docker-compose.yml" down
fi
