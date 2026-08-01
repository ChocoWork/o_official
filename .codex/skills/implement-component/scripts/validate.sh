```bash
#!/usr/bin/env bash
# File: .claude/skills/generate-component/scripts/validate.sh
# 生成されたファイルが規約・セキュリティ要件を満たすかを機械的に検証する。
# 使い方: bash validate.sh <ファイルパス1> [ファイルパス2 ...]

set -uo pipefail

# ============================================================
# カラー出力
# ============================================================
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

PASS_COUNT=0
FAIL_COUNT=0
WARN_COUNT=0
FAILED_RULES=()

# ============================================================
# ヘルパー
# ============================================================
print_header() {
  echo ""
  echo -e "${CYAN}========================================${NC}"
  echo -e "${CYAN} 🔍 Validating: $1${NC}"
  echo -e "${CYAN}========================================${NC}"
}

pass() {
  echo -e "  ${GREEN}✅ PASS${NC} : $1"
  PASS_COUNT=$((PASS_COUNT + 1))
}

fail() {
  echo -e "  ${RED}❌ FAIL${NC} : $1"
  FAIL_COUNT=$((FAIL_COUNT + 1))
  FAILED_RULES+=("$1")
}

warn() {
  echo -e "  ${YELLOW}⚠️  WARN${NC} : $1"
  WARN_COUNT=$((WARN_COUNT + 1))
}

# pattern が見つかったら fail
assert_not_match() {
  local file=$1 pattern=$2 rule=$3
  if grep -nE "$pattern" "$file" > /dev/null 2>&1; then
    fail "$rule"
    grep -nE "$pattern" "$file" | head -3 | sed 's/^/         /'
  else
    pass "$rule"
  fi
}

# pattern が必要だが見つからない場合 fail
assert_match() {
  local file=$1 pattern=$2 rule=$3
  if grep -nE "$pattern" "$file" > /dev/null 2>&1; then
    pass "$rule"
  else
    fail "$rule"
  fi
}

# pattern が見つかったら warn のみ
assert_not_match_warn() {
  local file=$1 pattern=$2 rule=$3
  if grep -nE "$pattern" "$file" > /dev/null 2>&1; then
    warn "$rule"
    grep -nE "$pattern" "$file" | head -3 | sed 's/^/         /'
  else
    pass "$rule"
  fi
}

# ============================================================
# 各ファイルへの検証
# ============================================================
validate_file() {
  local file=$1

  if [ ! -f "$file" ]; then
    echo -e "${RED}❌ File not found: $file${NC}"
    FAIL_COUNT=$((FAIL_COUNT + 1))
    return
  fi

  print_header "$file"

  # 拡張子取得
  local ext="${file##*.}"
  local basename
  basename=$(basename "$file")

  # ----------------------------------------------------------
  # [Section 1] TypeScript 規約
  # ----------------------------------------------------------
  echo -e "${CYAN}-- TypeScript Rules --${NC}"

  # any 禁止（コメント行は除外）
  if grep -nE "^[^/]*: *any( |,|\)|>|;|=|\[)" "$file" | grep -v "// *eslint-disable" > /dev/null 2>&1; then
    fail "TS001: 'any' type is forbidden (use 'unknown' + type guard)"
    grep -nE "^[^/]*: *any( |,|\)|>|;|=|\[)" "$file" | head -3 | sed 's/^/         /'
  else
    pass "TS001: no 'any' type usage"
  fi

  # Non-null assertion 禁止（!. または !; など）
  assert_not_match "$file" "[a-zA-Z_)\]]+![\.\;\,\)\[ ]" \
    "TS002: Non-null assertion '!' is forbidden"

  # var 禁止
  assert_not_match "$file" "^[[:space:]]*var[[:space:]]+" \
    "TS003: 'var' is forbidden (use const/let)"

  # enum 禁止
  assert_not_match "$file" "^[[:space:]]*(export[[:space:]]+)?enum[[:space:]]+" \
    "TS004: 'enum' is forbidden (use 'as const' object or union type)"

  # @ts-ignore 禁止（@ts-expect-error は理由付きで許容）
  assert_not_match "$file" "@ts-ignore" \
    "TS005: '@ts-ignore' is forbidden (use '@ts-expect-error' with reason)"

  # console.log 禁止（warn/error は許可）
  assert_not_match "$file" "console\.log\(" \
    "TS006: 'console.log' is forbidden in production code"

  # ----------------------------------------------------------
  # [Section 2] React 規約
  # ----------------------------------------------------------
  if [[ "$ext" == "tsx" ]]; then
    echo -e "${CYAN}-- React Rules --${NC}"

    # React.FC 禁止
    assert_not_match "$file" ":[[:space:]]*React\.FC|:[[:space:]]*FC<" \
      "RC001: 'React.FC' is forbidden (declare Props type explicitly)"

    # クラスコンポーネント禁止
    assert_not_match "$file" "extends[[:space:]]+(React\.)?Component" \
      "RC002: Class components are forbidden (use function components)"

    # dangerouslySetInnerHTML 警告
    if grep -n "dangerouslySetInnerHTML" "$file" > /dev/null 2>&1; then
      if grep -n "DOMPurify\|sanitize" "$file" > /dev/null 2>&1; then
        warn "RC003: 'dangerouslySetInnerHTML' is used. Confirm DOMPurify is applied to all user inputs."
      else
        fail "RC003: 'dangerouslySetInnerHTML' detected without DOMPurify/sanitize. SECURITY RISK (XSS)"
      fi
    else
      pass "RC003: no dangerouslySetInnerHTML usage"
    fi

    # target="_blank" には rel="noopener noreferrer"
    if grep -nE 'target="_blank"' "$file" > /dev/null 2>&1; then
      while IFS= read -r line; do
        if ! echo "$line" | grep -qE 'rel="[^"]*noopener[^"]*noreferrer|rel="[^"]*noreferrer[^"]*noopener'; then
          fail "RC004: target=\"_blank\" without rel=\"noopener noreferrer\" found"
          echo "         $line" | head -c 200
          echo ""
        fi
      done < <(grep -nE 'target="_blank"' "$file")
    fi
    [ -z "$(grep -nE 'target="_blank"' "$file")" ] && pass "RC004: target=\"_blank\" rel attribute check"

    # key に index 使用警告
    assert_not_match_warn "$file" "key=\{[a-zA-Z_]*[Ii]ndex\}|key=\{i\}" \
      "RC005: array index used as 'key' (use stable unique id if possible)"

    # img には alt 必須
    if grep -nE "<img[[:space:]]" "$file" > /dev/null 2>&1; then
      while IFS= read -r line; do
        if ! echo "$line" | grep -qE 'alt='; then
          fail "RC006: <img> without 'alt' attribute (a11y violation)"
        fi
      done < <(grep -nE "<img[[:space:]]" "$file")
    fi

    # eslint-disable のチェック（警告のみ）
    assert_not_match_warn "$file" "eslint-disable" \
      "RC007: eslint-disable detected (verify justification)"
  fi

  # ----------------------------------------------------------
  # [Section 3] Next.js 規約
  # ----------------------------------------------------------
  echo -e "${CYAN}-- Next.js Rules --${NC}"

  # 'use client' と 'server-only' の同居禁止
  if grep -q "'use client'" "$file" && grep -q "'server-only'" "$file"; then
    fail "NX001: 'use client' and 'server-only' cannot coexist"
  else
    pass "NX001: client/server boundary integrity"
  fi

  # Server Action ('use server') の検証
  if grep -q "'use server'" "$file" || grep -q "\"use server\"" "$file"; then
    echo -e "${CYAN}-- Server Action Detected → Strict Checks --${NC}"

    # Zod 等のバリデーションが含まれているか
    if grep -nE "z\.(object|string|number)|safeParse|valibot|yup\." "$file" > /dev/null 2>&1; then
      pass "NX002: Server Action has schema validation"
    else
      fail "NX002: Server Action MUST include input validation (Zod/Valibot/Yup)"
    fi

    # 認証チェックが含まれているか
    if grep -nE "auth\(\)|getSession|getServerSession|currentUser\(|requireAuth" "$file" > /dev/null 2>&1; then
      pass "NX003: Server Action has authentication check"
    else
      fail "NX003: Server Action MUST include authentication check"
    fi

    # 認可（ownership）の痕跡
    if grep -nE "userId|ownerId|session\.user|forbidden|Unauthorized" "$file" > /dev/null 2>&1; then
      pass "NX004: Server Action references authorization context"
    else
      warn "NX004: Server Action may lack ownership/authorization check (manual review required)"
    fi
  fi

  # Route Handler の検証
  if [[ "$basename" == "route.ts" || "$basename" == "route.tsx" ]]; then
    echo -e "${CYAN}-- Route Handler Detected → Strict Checks --${NC}"

    if grep -nE "z\.(object|string|number)|safeParse" "$file" > /dev/null 2>&1; then
      pass "NX005: Route Handler has schema validation"
    else
      fail "NX005: Route Handler MUST validate input"
    fi

    if grep -nE "auth\(\)|getSession|getServerSession|Authorization" "$file" > /dev/null 2>&1; then
      pass "NX006: Route Handler has auth check"
    else
      warn "NX006: Route Handler may lack auth (verify if endpoint is public)"
    fi
  fi

  # lib/ 配下は server-only 推奨
  if [[ "$file" == *"/lib/"* ]] && [[ "$ext" == "ts" ]]; then
    if grep -qE "^import 'server-only'|^import \"server-only\"" "$file"; then
      pass "NX007: lib/ file declares 'server-only'"
    else
      warn "NX007: lib/ file should consider 'import \"server-only\"' if it contains secrets/DB access"
    fi
  fi

  # ----------------------------------------------------------
  # [Section 4] セキュリティ規約 (OWASP)
  # ----------------------------------------------------------
  echo -e "${CYAN}-- Security Rules (OWASP) --${NC}"

  # eval / Function コンストラクタ禁止
  assert_not_match "$file" "(^|[^a-zA-Z_])eval\(|new Function\(" \
    "SEC001: eval/new Function is forbidden (code injection risk)"

  # NEXT_PUBLIC_*_SECRET / KEY / TOKEN / PASSWORD 禁止
  assert_not_match "$file" "NEXT_PUBLIC_[A-Z_]*(SECRET|PRIVATE|TOKEN|PASSWORD|API_KEY)" \
    "SEC002: Secrets MUST NOT be exposed via NEXT_PUBLIC_* env vars"

  # ハードコードされたシークレット検知
  assert_not_match "$file" "(api[_-]?key|secret|password|token)[[:space:]]*[:=][[:space:]]*['\"][A-Za-z0-9_\-]{16,}['\"]" \
    "SEC003: Possible hardcoded secret detected"

  # http:// (https以外) の外部URL警告
  assert_not_match_warn "$file" "[\"']http://(?!localhost|127\.0\.0\.1)" \
    "SEC004: Non-HTTPS URL detected (use HTTPS in production)"

  # SQL文字列連結の警告
  assert_not_match "$file" "(SELECT|INSERT|UPDATE|DELETE)[[:space:]].+\+[[:space:]]*[a-zA-Z_]+" \
    "SEC005: Possible SQL string concatenation (use parameterized queries / ORM)"

  # document.write 禁止
  assert_not_match "$file" "document\.write\(" \
    "SEC006: document.write is forbidden"

  # innerHTML への代入警告
  assert_not_match_warn "$file" "\.innerHTML[[:space:]]*=" \
    "SEC007: innerHTML assignment detected (XSS risk - use textContent or sanitize)"

  # localStorage に sensitive 名のものを書いていないか
  assert_not_match_warn "$file" "localStorage\.setItem\([\"'].*(token|secret|password|jwt)" \
    "SEC008: Storing sensitive data in localStorage (vulnerable to XSS, prefer httpOnly cookie)"

  # ----------------------------------------------------------
  # [Section 5] コード品質
  # ----------------------------------------------------------
  echo -e "${CYAN}-- Code Quality Rules --${NC}"

  # 行数チェック
  line_count=$(wc -l < "$file" | tr -d ' ')
  if [ "$line_count" -gt 300 ]; then
    warn "Q001: File has ${line_count} lines (>300). Consider splitting."
  else
    pass "Q001: file size acceptable (${line_count} lines)"
  fi

  # 深い相対パス禁止
  assert_not_match "$file" "from[[:space:]]+['\"]\.\./\.\./\.\./" \
    "Q002: Deep relative imports forbidden (use '@/' alias)"

  # TODO / FIXME 警告
  assert_not_match_warn "$file" "(TODO|FIXME|XXX|HACK)" \
    "Q003: TODO/FIXME/XXX/HACK comments detected"

  # ファイル先頭にファイルパスコメントがあるか
  if head -3 "$file" | grep -qE "^// File:|^/\* File:|^// file:|^// @file"; then
    pass "Q004: file path comment present"
  else
    warn "Q004: file should start with '// File: <path>' comment"
  fi
}

# ============================================================
# メイン処理
# ============================================================
if [ $# -eq 0 ]; then
  echo "Usage: $0 <file1> [file2 ...]"
  echo "Example: $0 app/dashboard/page.tsx components/UserCard.tsx"
  exit 1
fi

echo ""
echo -e "${CYAN}╔════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║  Secure Component Validation Suite v1.0    ║${NC}"
echo -e "${CYAN}║  Next.js / React / TypeScript / OWASP      ║${NC}"
echo -e "${CYAN}╚════════════════════════════════════════════╝${NC}"

for target in "$@"; do
  validate_file "$target"
done

# ============================================================
# サマリ
# ============================================================
echo ""
echo -e "${CYAN}========================================${NC}"
echo -e "${CYAN} 📊 Summary${NC}"
echo -e "${CYAN}========================================${NC}"
echo -e "  ${GREEN}✅ Passed : ${PASS_COUNT}${NC}"
echo -e "  ${YELLOW}⚠️  Warned : ${WARN_COUNT}${NC}"
echo -e "  ${RED}❌ Failed : ${FAIL_COUNT}${NC}"

if [ ${#FAILED_RULES[@]} -gt 0 ]; then
  echo ""
  echo -e "${RED}Failed Rules:${NC}"
  for rule in "${FAILED_RULES[@]}"; do
    echo -e "  ${RED}- ${rule}${NC}"
  done
fi

echo ""

# ============================================================
# 追加ツール実行（任意・存在すれば）
# ============================================================
if command -v npx >/dev/null 2>&1; then
  echo -e "${CYAN}-- Optional: ESLint + tsc --${NC}"

  if [ -f "package.json" ] && [ -f ".eslintrc.json" ] || [ -f "eslint.config.mjs" ] || [ -f "eslint.config.js" ]; then
    if npx --no-install eslint "$@" 2>/dev/null; then
      pass "ESLint: passed"
    else
      warn "ESLint: issues detected (run 'npx eslint <file>' for details)"
    fi
  fi

  if [ -f "tsconfig.json" ]; then
    if npx --no-install tsc --noEmit 2>/dev/null; then
      pass "tsc --noEmit: passed"
    else
      warn "tsc: type errors detected (run 'npx tsc --noEmit')"
    fi
  fi
fi

echo ""

if [ $FAIL_COUNT -gt 0 ]; then
  echo -e "${RED}❌ Validation FAILED. Fix the above issues before completion.${NC}"
  echo ""
  exit 1
else
  echo -e "${GREEN}✅ All critical checks PASSED.${NC}"
  if [ $WARN_COUNT -gt 0 ]; then
    echo -e "${YELLOW}   (${WARN_COUNT} warnings - manual review recommended)${NC}"
  fi
  echo ""
  exit 0
fi