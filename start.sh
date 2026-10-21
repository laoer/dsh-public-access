#!/bin/bash
set -euo pipefail

echo "=== DeepSeek Harness Public Access Mode ==="

# Plugin auth (username/password) configuration. The dsh launch token printed
# below is an alternative auth path; either logging in via the login page or
# opening the token URL grants access.
export DSH_AUTH_USER="${DSH_AUTH_USER:-admin}"
export DSH_AUTH_PASS="${DSH_AUTH_PASS:-admin}"
echo "Auth user: $DSH_AUTH_USER"

HOST="${DSH_HOST:-0.0.0.0}"
PORT="${DSH_PORT:-3080}"

if [ "$HOST" = "0.0.0.0" ] || [ "$HOST" = "::" ]; then
    if [ "$DSH_AUTH_USER" = "admin" ] && [ "$DSH_AUTH_PASS" = "admin" ]; then
        echo "WARNING: exposing a wildcard bind with the default admin/admin password." >&2
        echo "         Set DSH_AUTH_USER and DSH_AUTH_PASS before using this on a network." >&2
    fi
fi

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
