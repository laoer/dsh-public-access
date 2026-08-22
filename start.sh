#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "=== DeepSeek Harness Reverse Proxy Mode ==="

# Detect public IP
PUBLIC_IP=$(curl -s --connect-timeout 3 ifconfig.me 2>/dev/null || echo "")
echo "Public IP: ${PUBLIC_IP:-unknown}"

# Detect LAN IPs
LAN_IPS=$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -v '^$' || echo "")
echo "LAN IPs: $LAN_IPS"

PORT="${DSH_PORT:-3080}"

# Build --trusted-host args
TRUSTED_HOST_ARGS=""
add_trusted() {
    TRUSTED_HOST_ARGS="$TRUSTED_HOST_ARGS --trusted-host $1 --trusted-host $1:$PORT"
}
add_trusted "127.0.0.1"
add_trusted "localhost"
[ -n "$PUBLIC_IP" ] && add_trusted "$PUBLIC_IP"
for ip in $LAN_IPS; do
    add_trusted "$ip"
done

echo "Port: $PORT"
echo "============================================="

exec dsh --profile web --no-open --port "$PORT" $TRUSTED_HOST_ARGS "$@"
