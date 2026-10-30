#!/bin/bash
set -euo pipefail

echo "=== DeepSeek Harness Public Access Mode ==="

# Authentication is owned by the plugin's credential file, NOT by environment
# variables. On first start the plugin generates a random administrator
# password, prints it, and saves it to:
#     $DSH_HOME/dsh-public-access.initial-password   (default ~/.dsh/...)
# Change it under Settings -> Auth (or `dsh --profile web auth-reset`); the file
# is deleted automatically once you do. Do not set a default password here:
# it would be readable by every local user through the process environment.
if [ -n "${DSH_AUTH_PASS:-}" ]; then
    echo "WARNING: DSH_AUTH_PASS is deprecated and only used to seed the credential" >&2
    echo "         file on first start. Remove it and rotate the password in" >&2
    echo "         Settings -> Auth instead." >&2
fi

HOST="${DSH_HOST:-0.0.0.0}"
PORT="${DSH_PORT:-3080}"

# Detect the public IP. NAT deployments still need this authority declared so
# dsh's /api Host/Origin fence accepts requests addressed to the public IP;
# LAN authorities are derived by the plugin's web-startup row.
PUBLIC_IP=""
if command -v curl >/dev/null 2>&1; then
    DETECTED=$(curl -4 -s --connect-timeout 3 ifconfig.me 2>/dev/null | tr -d '[:space:]' || true)
    if [[ "$DETECTED" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]]; then
        PUBLIC_IP="$DETECTED"
    fi
fi
echo "Public IP: ${PUBLIC_IP:-unknown}"
echo "Bind host: $HOST"
echo "Port: $PORT"

ARGS=(--profile web --no-open --host "$HOST" --port "$PORT")

# Explicit trusted hosts (space-separated). The plugin derives LAN addresses
# itself, so this is only for public IPs/domains and NAT front ends.
if [ -n "${DSH_TRUSTED_HOSTS:-}" ]; then
    for authority in $DSH_TRUSTED_HOSTS; do
        ARGS+=(--trusted-host "$authority")
    done
fi
if [ -n "$PUBLIC_IP" ]; then
    ARGS+=(--trusted-host "$PUBLIC_IP")
fi

# Advertise the URL browsers actually use. Set DSH_PUBLIC_URL for a domain or
# a prefix-stripping proxy; otherwise the public IP is a reasonable default.
SCHEME="http"
if [ -n "${DSH_TLS_CERT:-}" ] && [ -n "${DSH_TLS_KEY:-}" ]; then
    SCHEME="https"
fi
if [ -n "${DSH_PUBLIC_URL:-}" ]; then
    ARGS+=(--public-url "$DSH_PUBLIC_URL")
elif [ -n "$PUBLIC_IP" ] && [ "$PORT" != "0" ]; then
    ARGS+=(--public-url "${SCHEME}://${PUBLIC_IP}:${PORT}/")
fi

# Direct HTTPS termination by dsh. Both files are required together.
if [ -n "${DSH_TLS_CERT:-}" ] || [ -n "${DSH_TLS_KEY:-}" ]; then
    if [ -z "${DSH_TLS_CERT:-}" ] || [ -z "${DSH_TLS_KEY:-}" ]; then
        echo "ERROR: DSH_TLS_CERT and DSH_TLS_KEY must be set together." >&2
        exit 1
    fi
    ARGS+=(--tls-cert "$DSH_TLS_CERT" --tls-key "$DSH_TLS_KEY")
fi

if [ -n "${DSH_PUBLIC_URL:-}" ]; then
    echo "Public URL: $DSH_PUBLIC_URL"
elif [ -n "$PUBLIC_IP" ] && [ "$PORT" != "0" ]; then
    echo "Public URL: ${SCHEME}://${PUBLIC_IP}:${PORT}/"
fi
echo "============================================="

exec dsh "${ARGS[@]}" "$@"
