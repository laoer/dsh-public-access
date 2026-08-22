#!/bin/bash
set -euo pipefail

PORT="${DSH_PORT:-3080}"
exec dsh web --host 0.0.0.0 --port "$PORT" "$@"
