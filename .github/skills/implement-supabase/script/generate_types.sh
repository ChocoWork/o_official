#!/usr/bin/env bash
# File: generate_types.sh
set -euo pipefail

OUT="${1:-src/types/database.ts}"
PROJECT_REF="${SUPABASE_PROJECT_REF:?set SUPABASE_PROJECT_REF}"

mkdir -p "$(dirname "$OUT")"
supabase gen types typescript --project-id "$PROJECT_REF" --schema public > "$OUT"
echo "Generated: $OUT"