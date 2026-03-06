#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CERT_PATH="$ROOT_DIR/keys/cert.crt"
KEYCHAIN="${HOME}/Library/Keychains/login.keychain-db"

if [[ ! -f "$CERT_PATH" ]]; then
  echo "Missing cert: $CERT_PATH"
  echo "Generate it first:"
  echo "  ./docker/jitsi/generate-local-cert.sh 192.168.29.242"
  exit 1
fi

echo "Adding local Jitsi cert to login keychain trust store..."
security add-trusted-cert -d -r trustRoot -k "$KEYCHAIN" "$CERT_PATH"

echo "Done. Restart Chrome/Firefox and retry /meet/[token]."
