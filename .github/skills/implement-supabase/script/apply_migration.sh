#!/usr/bin/env bash
# File: apply_migration.sh
# 安全なマイグレーション適用スクリプト
set -euo pipefail

ENV="${1:-local}"  # local | branch | prod
NAME="${2:?migration name required}"

if [[ "$ENV" == "prod" ]]; then
  echo "⚠️  PRODUCTION migration. Type 'APPLY' to continue:"
  read -r CONFIRM
  [[ "$CONFIRM" == "APPLY" ]] || { echo "Aborted."; exit 1; }
fi

case "$ENV" in
  local)
    supabase migration new "$NAME"
    echo "Edit the new file under supabase/migrations/, then run: supabase db reset"
    ;;
  branch)
    supabase db push --linked
    ;;
  prod)
    # ブランチで検証済み前提
    supabase db push --linked
    supabase inspect db long-running-queries
    ;;
  *)
    echo "Unknown env: $ENV"; exit 1 ;;
esac