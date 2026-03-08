#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASE_ENV_FILE="${ROOT_DIR}/.env"
APP_ENV_FILE="${ROOT_DIR}/.env.production.auto"
JITSI_BASE_ENV_FILE="${ROOT_DIR}/docker/jitsi/.env"
JITSI_RUNTIME_ENV_FILE="${ROOT_DIR}/docker/jitsi/.env.runtime"
CERT_DIR="${ROOT_DIR}/docker/prod/certs"
CERT_FILE="${CERT_DIR}/app.crt"
KEY_FILE="${CERT_DIR}/app.key"
CERT_IP_TRACK_FILE="${CERT_DIR}/.last_ip"

detect_lan_ip() {
  local ip

  # Try to get the Windows host IP from WSL
  if command -v cat >/dev/null 2>&1; then
    # Get the default gateway (Windows host IP)
    ip="$(ip route | grep default | awk '{print $3}' | head -n1)"
    if [[ -n "${ip}" ]]; then
      echo "${ip}"
      return
    fi
  fi

  # Fallback to other methods
  if command -v ip >/dev/null 2>&1; then
    ip="$(ip route get 1.1.1.1 2>/dev/null | awk '/src/ {for (i=1; i<=NF; i++) if ($i=="src") {print $(i+1); exit}}')"
    if [[ -n "${ip}" ]]; then
      echo "${ip}"
      return
    fi
  fi

  if command -v hostname >/dev/null 2>&1; then
    ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
    if [[ -n "${ip}" ]]; then
      echo "${ip}"
      return
    fi
  fi

  echo "Failed to detect LAN IP automatically." >&2
  exit 1
}

read_env_value() {
  local key="$1"
  local file="$2"
  if [[ ! -f "${file}" ]]; then
    return
  fi

  local line
  line="$(grep -E "^${key}=" "${file}" | tail -n 1 || true)"
  if [[ -z "${line}" ]]; then
    return
  fi

  local value="${line#*=}"
  value="${value%\"}"
  value="${value#\"}"
  echo "${value}"
}

upsert_env() {
  local file="$1"
  local key="$2"
  local value="$3"
  local tmp_file
  tmp_file="$(mktemp)"

  if [[ -f "${file}" ]]; then
    grep -Ev "^${key}=" "${file}" > "${tmp_file}" || true
  fi

  printf "%s=%s\n" "${key}" "${value}" >> "${tmp_file}"
  mv "${tmp_file}" "${file}"
}

generate_local_cert() {
  local ip="$1"
  mkdir -p "${CERT_DIR}"

  local current_ip=""
  if [[ -f "${CERT_IP_TRACK_FILE}" ]]; then
    current_ip="$(cat "${CERT_IP_TRACK_FILE}")"
  fi

  # Always regenerate certificate if IP has changed
  if [[ -f "${CERT_FILE}" && -f "${KEY_FILE}" && "${current_ip}" == "${ip}" ]]; then
    echo "Certificate already exists for ${ip}, skipping generation."
    return
  fi

  echo "Generating HTTPS certificate for ${ip}..."
  local openssl_cfg
  openssl_cfg="$(mktemp)"
  cat > "${openssl_cfg}" <<EOF
[req]
default_bits = 2048
prompt = no
default_md = sha256
distinguished_name = dn
x509_extensions = v3_req

[dn]
CN = ${ip}

[v3_req]
subjectAltName = @alt_names

[alt_names]
IP.1 = ${ip}
IP.2 = 127.0.0.1
DNS.1 = localhost
EOF

  openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
    -keyout "${KEY_FILE}" \
    -out "${CERT_FILE}" \
    -config "${openssl_cfg}" >/dev/null 2>&1

  rm -f "${openssl_cfg}"
  echo "${ip}" > "${CERT_IP_TRACK_FILE}"
}

prepare_app_env() {
  local ip="$1"

  if [[ ! -f "${BASE_ENV_FILE}" ]]; then
    echo ".env not found at project root. Create it first." >&2
    exit 1
  fi

  cp "${BASE_ENV_FILE}" "${APP_ENV_FILE}"

  local db_user db_password db_name db_port
  db_user="$(read_env_value POSTGRES_USER "${BASE_ENV_FILE}")"
  db_password="$(read_env_value POSTGRES_PASSWORD "${BASE_ENV_FILE}")"
  db_name="$(read_env_value POSTGRES_DB "${BASE_ENV_FILE}")"
  db_port="$(read_env_value POSTGRES_PORT "${BASE_ENV_FILE}")"

  db_user="${db_user:-postgres}"
  db_password="${db_password:-mysecretpassword}"
  db_name="${db_name:-postgres}"
  db_port="${db_port:-5432}"

  upsert_env "${APP_ENV_FILE}" "POSTGRES_USER" "${db_user}"
  upsert_env "${APP_ENV_FILE}" "POSTGRES_PASSWORD" "${db_password}"
  upsert_env "${APP_ENV_FILE}" "POSTGRES_DB" "${db_name}"
  upsert_env "${APP_ENV_FILE}" "POSTGRES_PORT" "${db_port}"
  upsert_env "${APP_ENV_FILE}" "DATABASE_URL" "\"postgresql://${db_user}:${db_password}@postgres:5432/${db_name}\""
  upsert_env "${APP_ENV_FILE}" "APP_BASE_URL" "\"https://${ip}:3000\""
  upsert_env "${APP_ENV_FILE}" "NEXT_PUBLIC_JITSI_DOMAIN" "\"${ip}:8443\""
  upsert_env "${APP_ENV_FILE}" "NEXT_PUBLIC_JITSI_SCRIPT_HOST" "\"${ip}:8443\""
  upsert_env "${APP_ENV_FILE}" "NEXT_PUBLIC_JITSI_FALLBACK_DOMAIN" ""
  
  # Ensure Jitsi domain is properly set for the application
  echo "Setting Jitsi domain to: ${ip}:8443"
}

prepare_jitsi_env() {
  local ip="$1"

  if [[ -f "${JITSI_BASE_ENV_FILE}" ]]; then
    cp "${JITSI_BASE_ENV_FILE}" "${JITSI_RUNTIME_ENV_FILE}"
  else
    cp "${ROOT_DIR}/docker/jitsi/env.sample" "${JITSI_RUNTIME_ENV_FILE}"
  fi

  upsert_env "${JITSI_RUNTIME_ENV_FILE}" "PUBLIC_URL" "https://${ip}:8443"
  upsert_env "${JITSI_RUNTIME_ENV_FILE}" "DOCKER_HOST_ADDRESS" "${ip}"
  upsert_env "${JITSI_RUNTIME_ENV_FILE}" "JVB_ADVERTISE_IPS" "${ip}"
  upsert_env "${JITSI_RUNTIME_ENV_FILE}" "ENABLE_AUTH" "0"
  upsert_env "${JITSI_RUNTIME_ENV_FILE}" "ENABLE_GUESTS" "1"
  upsert_env "${JITSI_RUNTIME_ENV_FILE}" "ENABLE_LOBBY" "0"
  upsert_env "${JITSI_RUNTIME_ENV_FILE}" "ENABLE_AUTO_OWNER" "1"
  upsert_env "${JITSI_RUNTIME_ENV_FILE}" "ENABLE_PREJOIN_PAGE" "0"
  upsert_env "${JITSI_RUNTIME_ENV_FILE}" "ENABLE_WELCOME_PAGE" "0"
}

main() {
  local lan_ip
  # Prefer HOST_IP from .env so we use the real Windows LAN IP.
  # detect_lan_ip() can return WSL's internal eth0 (172.x.x.x) which is wrong.
  lan_ip="$(read_env_value HOST_IP "${BASE_ENV_FILE}")"
  if [[ -z "${lan_ip}" ]]; then
    lan_ip="$(detect_lan_ip)"
    echo "Auto-detected LAN IP: ${lan_ip}"
  else
    echo "Using HOST_IP from .env: ${lan_ip}"
  fi

  # For WSL, we need to use the Windows host IP for external access
  # but the WSL IP for internal Docker networking
  local wsl_ip
  wsl_ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  
  # Always rebuild containers when IP changes to ensure proper networking
  echo "Detected IP change. Stopping existing containers..."
  docker compose --env-file "${APP_ENV_FILE}" -f "${ROOT_DIR}/docker-compose.prod.yml" down 2>/dev/null || true
  docker compose --env-file "${JITSI_RUNTIME_ENV_FILE}" -f "${ROOT_DIR}/docker/jitsi/docker-compose.yml" down 2>/dev/null || true
  
  prepare_app_env "${lan_ip}"
  prepare_jitsi_env "${wsl_ip}"
  generate_local_cert "${lan_ip}"

  echo "Starting app + postgres + https proxy..."
  docker compose --env-file "${APP_ENV_FILE}" -f "${ROOT_DIR}/docker-compose.prod.yml" up -d --build

  echo "Starting Jitsi stack..."
  docker compose --env-file "${JITSI_RUNTIME_ENV_FILE}" -f "${ROOT_DIR}/docker/jitsi/docker-compose.yml" up -d

  echo ""
  echo "Production stack is up."
  echo "App URL:   https://${lan_ip}:3000"
  echo "Jitsi URL: https://${lan_ip}:8443"
  echo "Runtime env: ${APP_ENV_FILE}"
  echo "Jitsi env:   ${JITSI_RUNTIME_ENV_FILE}"
  
  # Verify Jitsi domain is set correctly
  echo ""
  echo "Verifying Jitsi configuration..."
  local jitsi_domain
  jitsi_domain="$(read_env_value NEXT_PUBLIC_JITSI_DOMAIN "${APP_ENV_FILE}")"
  if [[ -n "${jitsi_domain}" ]]; then
    echo "✓ Jitsi domain configured: ${jitsi_domain}"
  else
    echo "✗ Jitsi domain not found in ${APP_ENV_FILE}"
    echo "Please check the environment file manually."
  fi
}

main "$@"
