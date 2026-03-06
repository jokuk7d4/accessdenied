#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$ROOT_DIR/.env"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing $ENV_FILE. Create it first (copy from env.sample)."
  exit 1
fi

IP_ARG="${1:-}"
if [[ -z "$IP_ARG" ]]; then
  IP_ARG="$(grep -E '^PUBLIC_URL=' "$ENV_FILE" | head -n1 | sed -E 's#^PUBLIC_URL=https?://([^:/]+).*$#\1#')"
fi

if [[ -z "$IP_ARG" ]]; then
  echo "Could not determine IP/host. Pass it explicitly:"
  echo "  ./docker/jitsi/generate-local-cert.sh 192.168.29.242"
  exit 1
fi

CERT_DIR="$ROOT_DIR/keys"
mkdir -p "$CERT_DIR"

OPENSSL_CNF="$CERT_DIR/openssl.cnf"
cat > "$OPENSSL_CNF" <<EOF
[req]
default_bits = 2048
prompt = no
default_md = sha256
distinguished_name = dn
x509_extensions = v3_req

[dn]
C = IN
ST = Local
L = Local
O = FullInterview
OU = Jitsi Local
CN = ${IP_ARG}

[v3_req]
subjectAltName = @alt_names

[alt_names]
IP.1 = ${IP_ARG}
DNS.1 = localhost
DNS.2 = ${IP_ARG}.nip.io
EOF

openssl req -x509 -nodes -newkey rsa:2048 \
  -keyout "$CERT_DIR/cert.key" \
  -out "$CERT_DIR/cert.crt" \
  -days 3650 \
  -config "$OPENSSL_CNF" \
  -extensions v3_req

chmod 600 "$CERT_DIR/cert.key"
chmod 644 "$CERT_DIR/cert.crt"

echo "Generated:"
echo "  $CERT_DIR/cert.crt"
echo "  $CERT_DIR/cert.key"
echo "Certificate SAN includes:"
echo "  IP: ${IP_ARG}"
echo "  DNS: localhost"
echo "  DNS: ${IP_ARG}.nip.io"
