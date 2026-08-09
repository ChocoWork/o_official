#!/usr/bin/env bash
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AUDIT_SCRIPT="$SCRIPT_DIR/audit.py"

if command -v python3 >/dev/null 2>&1; then
  exec python3 "$AUDIT_SCRIPT" "$@"
elif command -v python >/dev/null 2>&1; then
  exec python "$AUDIT_SCRIPT" "$@"
elif command -v py >/dev/null 2>&1; then
  exec py -3 "$AUDIT_SCRIPT" "$@"
fi

echo "Python 3 is required to run the security audit." >&2
exit 2
