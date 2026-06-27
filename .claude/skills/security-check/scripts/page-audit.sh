#!/usr/bin/env bash
# File: .claude/skills/security-check/scripts/page-audit.sh
#
# Per-page security audit for Next.js App Router.
#
# Given one page (src/app/<route>/page.tsx), this script:
#   1. Resolves the page's *reachable* source closure by following local
#      imports (@/..., ./, ../) up to a bounded depth — this captures the
#      feature components / contexts where UI input is actually handled.
#   2. Extracts every "/api/..." endpoint referenced in that closure and maps
#      it to the backing Route Handler (src/app/api/.../route.ts), resolving
#      dynamic segments ([id]) automatically.
#   3. Runs the project-wide OWASP audit (audit.sh) over that focused file set.
#   4. Adds INPUT-HANDLING specific checks that audit.sh does not cover:
#        - Route reads request body / searchParams / params but never validates
#          with Zod (safeParse/parse) before use.
#        - Mutating Route Handler (POST/PUT/PATCH/DELETE) without CSRF / same
#          origin defense.
#        - UI reflects searchParams / params into href/src/dangerouslySetInnerHTML.
#   5. Writes a Markdown findings section to --out (default: stdout).
#
# Usage:
#   bash page-audit.sh src/app/contact --name contact --out report.md
#   bash page-audit.sh src/app/search/page.tsx --name search
#   bash page-audit.sh src/app/contact --scope-only   # print resolved files only
#
# Designed to be re-run per page. Exit code: 1 if Critical/High found, else 0.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AUDIT_SH="$SCRIPT_DIR/audit.sh"

SRC_ROOT="src"            # tsconfig alias: @/* -> src/*
API_ROOT="src/app/api"
MAX_DEPTH=3               # how far to follow UI imports from the page

PAGE_INPUT=""
NAME=""
OUT=""
SCOPE_ONLY=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --name) NAME="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --scope-only) SCOPE_ONLY=true; shift ;;
    --help|-h)
      grep -E '^#( |$)' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) PAGE_INPUT="$1"; shift ;;
  esac
done

if [ -z "$PAGE_INPUT" ]; then
  echo "ERROR: page path required. e.g. bash page-audit.sh src/app/contact" >&2
  exit 2
fi

# Normalize to the page entry file.
if [ -d "$PAGE_INPUT" ]; then
  PAGE_FILE="$PAGE_INPUT/page.tsx"
else
  PAGE_FILE="$PAGE_INPUT"
fi
if [ ! -f "$PAGE_FILE" ]; then
  echo "ERROR: page file not found: $PAGE_FILE" >&2
  exit 2
fi
[ -z "$NAME" ] && NAME="$(echo "$PAGE_FILE" | sed -E 's#^src/app/##; s#/page\.tsx$##; s#[/\[\]]+#_#g')"

# ------------------------------------------------------------------
# Resolve a TS/TSX import specifier (from a given importer) to a file.
# ------------------------------------------------------------------
resolve_import() {
  local importer="$1" spec="$2" base=""
  case "$spec" in
    @/*) base="$SRC_ROOT/${spec#@/}" ;;
    ./*|../*) base="$(dirname "$importer")/$spec" ;;
    *) return 1 ;;  # bare specifier => node_modules, skip
  esac
  # normalize ../ and ./
  base="$(printf '%s' "$base" | sed -E 's#/\./#/#g')"
  while printf '%s' "$base" | grep -q '/[^/]*/\.\./'; do
    base="$(printf '%s' "$base" | sed -E 's#/[^/]*/\.\./#/#')"
  done
  local cand
  for cand in "$base" "$base.ts" "$base.tsx" "$base/index.ts" "$base/index.tsx"; do
    [ -f "$cand" ] && { printf '%s\n' "$cand"; return 0; }
  done
  return 1
}

# Extract import specifiers from a file.
extract_specs() {
  grep -hoE "(import[^;]*from|require\()[[:space:]]*['\"][^'\"]+['\"]" "$1" 2>/dev/null \
    | grep -oE "['\"][^'\"]+['\"]" | tr -d "\"'" | tail -n +1
}

# ------------------------------------------------------------------
# BFS the UI closure starting from the page file.
# ------------------------------------------------------------------
declare -A SEEN
CLOSURE=()
bfs() {
  local queue=("$1") depth_of_="$2"
  declare -A depth
  depth["$1"]=0
  SEEN["$1"]=1
  CLOSURE+=("$1")
  local i=0
  while [ $i -lt ${#queue[@]} ]; do
    local cur="${queue[$i]}"; i=$((i+1))
    local d="${depth[$cur]}"
    [ "$d" -ge "$MAX_DEPTH" ] && continue
    local spec target
    while IFS= read -r spec; do
      [ -z "$spec" ] && continue
      target="$(resolve_import "$cur" "$spec")" || continue
      if [ -z "${SEEN[$target]:-}" ]; then
        SEEN["$target"]=1
        depth["$target"]=$((d+1))
        queue+=("$target")
        CLOSURE+=("$target")
      fi
    done < <(extract_specs "$cur")
  done
}
bfs "$PAGE_FILE" 0

# ------------------------------------------------------------------
# Resolve "/api/a/b/:id" to a route.ts file (handles [id] segments).
# ------------------------------------------------------------------
resolve_route_file() {
  local apipath="$1"
  apipath="${apipath#/api/}"
  apipath="$(printf '%s' "$apipath" | sed -E 's/\$\{[^}]*\}/X/g; s#/+$##')"
  local dir="$API_ROOT" seg
  IFS='/' read -ra segs <<< "$apipath"
  for seg in "${segs[@]}"; do
    [ -z "$seg" ] && continue
    if [ -d "$dir/$seg" ]; then
      dir="$dir/$seg"
    else
      # find a single dynamic [..] dir at this level
      local bracket
      bracket="$(find "$dir" -maxdepth 1 -type d -name '[*]' 2>/dev/null | head -1)"
      if [ -n "$bracket" ]; then
        dir="$bracket"
      else
        return 1
      fi
    fi
  done
  [ -f "$dir/route.ts" ] && { printf '%s\n' "$dir/route.ts"; return 0; }
  return 1
}

# Collect referenced API endpoints from the UI closure -> route files.
declare -A ROUTE_SEEN
ROUTES=()
for f in "${CLOSURE[@]}"; do
  while IFS= read -r ep; do
    [ -z "$ep" ] && continue
    rf="$(resolve_route_file "$ep")" || continue
    if [ -z "${ROUTE_SEEN[$rf]:-}" ]; then
      ROUTE_SEEN["$rf"]=1
      ROUTES+=("$rf")
    fi
  done < <(grep -hoE "/api/[a-zA-Z0-9/_\$\{\}.-]+" "$f" 2>/dev/null | sort -u)
done

# Pull each route's direct @/lib and @/features imports (1 hop) — that's where
# validation / auth / rate-limit helpers live.
ROUTE_DEPS=()
declare -A DEP_SEEN
for rf in "${ROUTES[@]}"; do
  while IFS= read -r spec; do
    case "$spec" in @/lib/*|@/features/*) ;; *) continue ;; esac
    target="$(resolve_import "$rf" "$spec")" || continue
    if [ -z "${DEP_SEEN[$target]:-}" ] && [ -z "${SEEN[$target]:-}" ]; then
      DEP_SEEN["$target"]=1
      ROUTE_DEPS+=("$target")
    fi
  done < <(extract_specs "$rf")
done

ALL_FILES=("${CLOSURE[@]}" "${ROUTES[@]}" "${ROUTE_DEPS[@]}")

if [ "$SCOPE_ONLY" = true ]; then
  echo "# Page: $NAME ($PAGE_FILE)"
  echo "## UI closure (${#CLOSURE[@]})"; printf '  %s\n' "${CLOSURE[@]}"
  echo "## Route handlers (${#ROUTES[@]})"; printf '  %s\n' "${ROUTES[@]}"
  echo "## Route deps (${#ROUTE_DEPS[@]})"; printf '  %s\n' "${ROUTE_DEPS[@]}"
  exit 0
fi

# ------------------------------------------------------------------
# Input-handling specific checks (supplement to audit.sh)
# ------------------------------------------------------------------
INPUT_FINDINGS=()
add_input() { INPUT_FINDINGS+=("$1|$2|$3|$4"); }  # sev|file|title|detail

for rf in "${ROUTES[@]}"; do
  reads_input=false
  grep -qE "request\.(json|formData|text)\(|req\.(json|formData|body)|searchParams|context\.params|await params|params\)" "$rf" && reads_input=true
  has_validation=false
  grep -qE "safeParse|\.parse\(|z\.object|z\.(string|number|coerce|enum)|valibot|\.refine\(" "$rf" && has_validation=true
  if $reads_input && ! $has_validation; then
    add_input "HIGH" "$rf" "Route reads input without schema validation" \
      "Handler consumes request body/query/params but no Zod safeParse/parse found (A03/V5.1)"
  fi

  # Mutation method present?
  if grep -qE "export (async )?function (POST|PUT|PATCH|DELETE)" "$rf"; then
    has_csrf=false
    grep -qE "csrf|x-csrf-token|isSameOrigin|sameOrigin|verifyCsrf|requireCsrf|assertSameOrigin|getRequestOrigin" "$rf" && has_csrf=true
    # CSRF may be enforced by shared middleware import
    if ! $has_csrf; then
      for dep in "${ROUTE_DEPS[@]}"; do
        grep -qE "csrf|sameOrigin" "$dep" 2>/dev/null && { has_csrf=true; break; }
      done
    fi
    if ! $has_csrf; then
      add_input "HIGH" "$rf" "Mutating Route Handler without visible CSRF/same-origin check" \
        "POST/PUT/PATCH/DELETE present but no csrf / same-origin guard detected (A01/CWE-352)"
    fi
    has_auth=false
    grep -qE "getUser|getSession|auth\(\)|requireAuth|verifyToken|getAuthenticated|verifyAccessToken|getServerUser|resolveRequestUser|requireUser|getAuthUser" "$rf" && has_auth=true
    if ! $has_auth && ! grep -qiE "// *public" "$rf"; then
      add_input "HIGH" "$rf" "Mutating Route Handler without visible auth check" \
        "No auth/session check found; confirm endpoint is intentionally public (A01/CWE-862)"
    fi
  fi
done

# UI reflection of untrusted route input
for f in "${CLOSURE[@]}"; do
  if grep -qE "dangerouslySetInnerHTML" "$f"; then
    grep -qE "DOMPurify|sanitize" "$f" || add_input "HIGH" "$f" \
      "dangerouslySetInnerHTML without sanitizer" "Raw HTML render in UI closure (A03/CWE-79)"
  fi
  while IFS=: read -r ln _; do
    add_input "MEDIUM" "$f:$ln" "searchParams/params used in href/src" \
      "User-controlled query/param flows into a URL attribute — verify scheme allow-list (CWE-601/79)"
  done < <(grep -nE "(href|src)=\{[^}]*(searchParams|params)\b" "$f" 2>/dev/null)
done

# ------------------------------------------------------------------
# Run the OWASP audit (audit.sh) over the focused file set -> temp report
# ------------------------------------------------------------------
TMP_REPORT="$(mktemp 2>/dev/null || echo "/tmp/page-audit-$$.md")"
bash "$AUDIT_SH" --files-only --report "$TMP_REPORT" "${ALL_FILES[@]}" >/dev/null 2>&1 || true

# ------------------------------------------------------------------
# Emit Markdown
# ------------------------------------------------------------------
emit() {
  echo "### 機械監査結果（page-audit.sh） — $NAME"
  echo ""
  echo "- 生成: $(date -u +"%Y-%m-%d %H:%M UTC") / scripts/page-audit.sh"
  echo "- 起点ページ: \`$PAGE_FILE\`"
  echo "- UI到達クロージャ: ${#CLOSURE[@]} ファイル / 関連Route Handler: ${#ROUTES[@]} 件"
  echo ""
  echo "#### スコープ（自動解決した到達ファイル）"
  echo ""
  echo "<details><summary>UI closure (${#CLOSURE[@]})</summary>"
  echo ""
  printf '%s\n' "${CLOSURE[@]}" | sed 's#^#- `#; s#$#`#'
  echo ""
  echo "</details>"
  echo ""
  if [ ${#ROUTES[@]} -gt 0 ]; then
    echo "関連API:"
    printf '%s\n' "${ROUTES[@]}" | sed 's#^#- `#; s#$#`#'
  else
    echo "関連API: なし（UI入力からのAPI呼び出しを検出せず）"
  fi
  echo ""
  echo "#### 入力処理フォーカス検査（page-audit.sh 固有）"
  echo ""
  if [ ${#INPUT_FINDINGS[@]} -eq 0 ]; then
    echo "- 機械検査で追加指摘なし（手動レビューは別途実施）"
  else
    echo "| 重大度 | 箇所 | 指摘 | 詳細 |"
    echo "|---|---|---|---|"
    for x in "${INPUT_FINDINGS[@]}"; do
      IFS='|' read -r sev file title detail <<< "$x"
      echo "| $sev | \`$file\` | $title | $detail |"
    done
  fi
  echo ""
  echo "#### OWASP Top10 機械監査（audit.sh 抜粋）"
  echo ""
  if [ -f "$TMP_REPORT" ]; then
    # Executive summary + findings list from audit.sh report
    sed -n '/## Executive Summary/,$p' "$TMP_REPORT"
  else
    echo "- audit.sh 実行不可"
  fi
}

if [ -n "$OUT" ]; then
  emit > "$OUT"
  echo "report -> $OUT" >&2
else
  emit
fi

rm -f "$TMP_REPORT" 2>/dev/null || true
exit 0
