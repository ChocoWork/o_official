#!/usr/bin/env bash
# File: .claude/skills/security-check/scripts/audit.sh
#
# OWASP Top 10 / ASVS v4.0.3 / Secure Headers / Cheat Sheets / NIST SSDF / MDN
# 準拠の機械的セキュリティ監査スクリプト
#
# Usage:
#   bash audit.sh                    # プロジェクト全体を監査
#   bash audit.sh app/api            # 特定ディレクトリを監査
#   bash audit.sh --json             # JSON形式で結果出力
#   bash audit.sh --report report.md # Markdownレポート出力

set -uo pipefail

# ============================================================
# 設定
# ============================================================
RED='\033[0;31m'
ORANGE='\033[0;33m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
GRAY='\033[0;90m'
BOLD='\033[1m'
NC='\033[0m'

CRITICAL=0
HIGH=0
MEDIUM=0
LOW=0
INFO=0
PASS=0

declare -a FINDINGS

OUTPUT_FORMAT="text"
REPORT_FILE=""
FILES_ONLY=false
TARGETS=()

# ============================================================
# 引数処理
# ============================================================
while [[ $# -gt 0 ]]; do
  case "$1" in
    --json) OUTPUT_FORMAT="json"; shift ;;
    --report) REPORT_FILE="$2"; shift 2 ;;
    --files-only) FILES_ONLY=true; shift ;;
    --help|-h)
      cat <<EOF
Security Audit Script
Usage:
  bash audit.sh [options] [paths...]

Options:
  --json          Output in JSON format
  --report FILE   Generate Markdown report
  --help          Show this help

Examples:
  bash audit.sh
  bash audit.sh app components lib
  bash audit.sh --report security-report.md
EOF
      exit 0 ;;
    *) TARGETS+=("$1"); shift ;;
  esac
done

# デフォルトターゲット
if [ ${#TARGETS[@]} -eq 0 ]; then
  for dir in app src pages components lib hooks utils middleware.ts middleware.js src/middleware.ts proxy.ts src/proxy.ts next.config.js next.config.mjs next.config.ts; do
    [ -e "$dir" ] && TARGETS+=("$dir")
  done
fi

if [ ${#TARGETS[@]} -eq 0 ]; then
  echo -e "${RED}❌ No targets found. Specify a path or run from project root.${NC}"
  exit 1
fi

# ============================================================
# ヘルパー関数
# ============================================================
add_finding() {
  local severity="$1" id="$2" title="$3" file="$4" line="$5" detail="$6" owasp="$7" asvs="$8" cwe="$9" fix="${10}"

  case "$severity" in
    CRITICAL) CRITICAL=$((CRITICAL+1)); local color="$RED"; local icon="🔴" ;;
    HIGH)     HIGH=$((HIGH+1));         local color="$ORANGE"; local icon="🟠" ;;
    MEDIUM)   MEDIUM=$((MEDIUM+1));     local color="$YELLOW"; local icon="🟡" ;;
    LOW)      LOW=$((LOW+1));           local color="$BLUE"; local icon="🔵" ;;
    INFO)     INFO=$((INFO+1));         local color="$GRAY"; local icon="⚪" ;;
  esac

  echo -e "${color}${icon} [${severity}] ${id}: ${title}${NC}"
  if [ -n "$file" ]; then
    echo -e "   ${GRAY}└─ ${file}${line:+:$line}${NC}"
  fi
  if [ -n "$detail" ]; then
    echo -e "   ${GRAY}└─ ${detail}${NC}"
  fi
  echo -e "   ${GRAY}└─ OWASP: ${owasp} | ASVS: ${asvs} | CWE: ${cwe}${NC}"
  if [ -n "$fix" ]; then
    echo -e "   ${GREEN}└─ Fix: ${fix}${NC}"
  fi
  echo ""

  FINDINGS+=("${severity}|${id}|${title}|${file}|${line}|${detail}|${owasp}|${asvs}|${cwe}|${fix}")
}

pass_check() {
  PASS=$((PASS+1))
  echo -e "${GREEN}✅ ${1}${NC}"
}

print_section() {
  echo ""
  echo -e "${CYAN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${CYAN}${BOLD}  ${1}${NC}"
  echo -e "${CYAN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
}

# 対象ファイル列挙
get_source_files() {
  local files=()
  for target in "${TARGETS[@]}"; do
    if [ -f "$target" ]; then
      files+=("$target")
    elif [ -d "$target" ]; then
      while IFS= read -r f; do
        files+=("$f")
      done < <(find "$target" -type f \( -name "*.ts" -o -name "*.tsx" -o -name "*.js" -o -name "*.jsx" -o -name "*.mjs" \) \
              ! -path "*/node_modules/*" ! -path "*/.next/*" ! -path "*/dist/*" ! -path "*/build/*" 2>/dev/null)
    fi
  done
  printf '%s\n' "${files[@]}"
}

SOURCE_FILES=$(get_source_files)
FILE_COUNT=$(echo "$SOURCE_FILES" | grep -c . || true)

# ============================================================
# バナー
# ============================================================
clear 2>/dev/null || true
cat <<'BANNER'

╔══════════════════════════════════════════════════════════════╗
║  🛡️  Security Audit — OWASP / ASVS / NIST SSDF / MDN        ║
║  Standards: Top10 (2021), ASVS v4.0.3, SSDF v1.1            ║
╚══════════════════════════════════════════════════════════════╝

BANNER

echo -e "${BOLD}Targets:${NC} ${TARGETS[*]}"
echo -e "${BOLD}Files:${NC}   ${FILE_COUNT}"
echo ""

# ============================================================
# [A01] Broken Access Control
# ============================================================
print_section "A01:2021 — Broken Access Control"

echo "$SOURCE_FILES" | while IFS= read -r file; do
  [ -z "$file" ] && continue

  # Server Action 検出
  if grep -lE "'use server'|\"use server\"" "$file" > /dev/null 2>&1; then
    # 認証チェックの有無
    if ! grep -qE "auth\(\)|getSession|getServerSession|currentUser\(|requireAuth|getUser\(\)" "$file"; then
      add_finding "CRITICAL" "A01-001" \
        "Server Action without authentication" \
        "$file" "" \
        "Server Action does not perform authentication check" \
        "A01:2021" "V4.1.1, V4.1.5" "CWE-862" \
        "Add 'const session = await auth(); if (!session?.user) throw new Error(\"Unauthorized\");' at the top"
    fi

    # 認可チェック（リソース所有者検証）の有無
    if ! grep -qE "userId|ownerId|authorId|session\.user\.id|\.id ===|\.userId ===" "$file"; then
      add_finding "HIGH" "A01-002" \
        "Server Action without ownership check" \
        "$file" "" \
        "Server Action may lack resource ownership verification (IDOR risk)" \
        "A01:2021" "V4.2.1" "CWE-639" \
        "Verify that the resource belongs to session.user.id before mutation"
    fi
  fi

  # Route Handler 検出
  if [[ "$file" == *"/route.ts" || "$file" == *"/route.tsx" || "$file" == *"/route.js" ]]; then
    if ! grep -qE "auth\(\)|getSession|getServerSession|Authorization|verifyToken" "$file"; then
      # public エンドポイントを示すコメントがあるかチェック
      if ! grep -qiE "// public|// no-auth|// public endpoint" "$file"; then
        add_finding "HIGH" "A01-003" \
          "Route Handler without authentication" \
          "$file" "" \
          "Route Handler does not perform authentication check" \
          "A01:2021" "V4.1.1" "CWE-862" \
          "Add authentication check or document why this is public with '// PUBLIC: <reason>'"
      fi
    fi
  fi

  # CORS のワイルドカード
  while IFS=: read -r ln content; do
    add_finding "HIGH" "A01-004" \
      "CORS allows any origin" \
      "$file" "$ln" \
      "Access-Control-Allow-Origin: '*' detected" \
      "A01:2021" "V14.5.3" "CWE-942" \
      "Use an allow-list of trusted origins instead of '*'"
  done < <(grep -nE "['\"]Access-Control-Allow-Origin['\"][[:space:]]*[:,][[:space:]]*['\"]\\*['\"]" "$file" 2>/dev/null)

  # Middleware のみで認可していないか（簡易ヒューリスティック）
  if [[ "$(basename "$file")" == "middleware.ts" || "$(basename "$file")" == "middleware.js" || "$(basename "$file")" == "proxy.ts" ]]; then
    if grep -qE "auth|session" "$file"; then
      add_finding "INFO" "A01-005" \
        "Middleware-based auth detected" \
        "$file" "" \
        "Middleware can be bypassed in some scenarios. Always verify auth in pages/actions/handlers as well" \
        "A01:2021" "V4.1.1" "CWE-863" \
        "Re-verify authentication inside Server Actions and Route Handlers"
    fi
  fi
done

# ============================================================
# [A02] Cryptographic Failures
# ============================================================
print_section "A02:2021 — Cryptographic Failures"

echo "$SOURCE_FILES" | while IFS= read -r file; do
  [ -z "$file" ] && continue

  # 弱いハッシュアルゴリズム
  while IFS=: read -r ln content; do
    add_finding "CRITICAL" "A02-001" \
      "Weak hash algorithm for password" \
      "$file" "$ln" \
      "MD5/SHA-1 detected (insecure for password hashing)" \
      "A02:2021" "V2.4.1-V2.4.4" "CWE-327" \
      "Use Argon2id (preferred), bcrypt(cost>=12), or scrypt"
  done < <(grep -niE "createHash\(['\"]md5['\"]|createHash\(['\"]sha1['\"]" "$file" 2>/dev/null)

  # Math.random で乱数（暗号用途）
  while IFS=: read -r ln content; do
    add_finding "HIGH" "A02-002" \
      "Math.random() used (insecure randomness)" \
      "$file" "$ln" \
      "Math.random is not cryptographically secure" \
      "A02:2021" "V6.3.1" "CWE-338" \
      "Use crypto.randomBytes() or crypto.randomUUID() / globalThis.crypto.getRandomValues()"
  done < <(grep -nE "Math\.random\(\)" "$file" 2>/dev/null)

  # Cookie 属性の検証
  while IFS=: read -r ln content; do
    if echo "$content" | grep -qE "cookies\(\)\.set|setHeader\(['\"]Set-Cookie|res\.cookie\("; then
      if ! echo "$content" | grep -qE "httpOnly[[:space:]]*:[[:space:]]*true|HttpOnly"; then
        add_finding "HIGH" "A02-003" \
          "Cookie without HttpOnly" \
          "$file" "$ln" \
          "Cookie may be accessible from JavaScript (XSS theft risk)" \
          "A02:2021" "V3.4.2" "CWE-1004" \
          "Set httpOnly: true on cookies containing session/auth data"
      fi
      if ! echo "$content" | grep -qE "secure[[:space:]]*:[[:space:]]*true|Secure"; then
        add_finding "HIGH" "A02-004" \
          "Cookie without Secure flag" \
          "$file" "$ln" \
          "Cookie may be transmitted over HTTP" \
          "A02:2021" "V3.4.1" "CWE-614" \
          "Set secure: true on all cookies in production"
      fi
      if ! echo "$content" | grep -qE "sameSite|SameSite"; then
        add_finding "MEDIUM" "A02-005" \
          "Cookie without SameSite" \
          "$file" "$ln" \
          "Cookie lacks SameSite attribute (CSRF risk)" \
          "A02:2021" "V3.4.3" "CWE-1275" \
          "Set sameSite: 'lax' or 'strict'"
      fi
    fi
  done < <(grep -nE "cookies\(\)\.set|setHeader\(['\"]Set-Cookie|res\.cookie\(" "$file" 2>/dev/null)

  # 弱い暗号アルゴリズム
  while IFS=: read -r ln content; do
    add_finding "HIGH" "A02-006" \
      "Weak cipher algorithm" \
      "$file" "$ln" \
      "DES/3DES/RC4 detected" \
      "A02:2021" "V6.2.5" "CWE-327" \
      "Use AES-256-GCM or ChaCha20-Poly1305"
  done < <(grep -niE "createCipher(iv)?\(['\"](des|3des|rc4|aes-128-ecb|aes-256-ecb)" "$file" 2>/dev/null)
done

# ============================================================
# [A03] Injection
# ============================================================
print_section "A03:2021 — Injection"

echo "$SOURCE_FILES" | while IFS= read -r file; do
  [ -z "$file" ] && continue

  # eval / new Function
  while IFS=: read -r ln content; do
    add_finding "CRITICAL" "A03-001" \
      "Code injection sink: eval/Function" \
      "$file" "$ln" \
      "eval() or new Function() allows arbitrary code execution" \
      "A03:2021" "V5.2.4" "CWE-95" \
      "Remove eval/new Function. Use JSON.parse for data, or safe alternatives"
  done < <(grep -nE "(^|[^a-zA-Z_.])eval\(|new[[:space:]]+Function[[:space:]]*\(" "$file" 2>/dev/null)

  # SQL 文字列連結（簡易検出）
  while IFS=: read -r ln content; do
    add_finding "CRITICAL" "A03-002" \
      "Possible SQL injection (string concatenation)" \
      "$file" "$ln" \
      "SQL query appears to use string concatenation with variables" \
      "A03:2021" "V5.3.4" "CWE-89" \
      "Use parameterized queries (Prisma/Drizzle) or tagged template \$queryRaw\`...\${var}\`"
  done < <(grep -nE "(SELECT|INSERT|UPDATE|DELETE)[[:space:]].+['\"][[:space:]]*\\+|\\\$queryRawUnsafe\\(" "$file" 2>/dev/null)

  # NoSQL injection ($where with user input)
  while IFS=: read -r ln content; do
    add_finding "HIGH" "A03-003" \
      "Possible NoSQL injection" \
      "$file" "$ln" \
      "MongoDB \$where with potentially user-controlled value" \
      "A03:2021" "V5.3.5" "CWE-943" \
      "Avoid \$where; use typed query operators with validated inputs"
  done < <(grep -nE "\\\$where[[:space:]]*:" "$file" 2>/dev/null)

  # OS Command injection
  while IFS=: read -r ln content; do
    add_finding "HIGH" "A03-004" \
      "Possible OS command injection" \
      "$file" "$ln" \
      "child_process.exec with shell=true is dangerous with user input" \
      "A03:2021" "V5.3.7" "CWE-78" \
      "Use execFile() with array arguments instead of exec()"
  done < <(grep -nE "child_process.*\.exec\(|require\(['\"]child_process['\"]\)\.exec\(" "$file" 2>/dev/null)

  # dangerouslySetInnerHTML without DOMPurify
  if grep -q "dangerouslySetInnerHTML" "$file"; then
    if ! grep -qE "DOMPurify|sanitize|isomorphic-dompurify" "$file"; then
      while IFS=: read -r ln content; do
        add_finding "HIGH" "A03-005" \
          "dangerouslySetInnerHTML without sanitization" \
          "$file" "$ln" \
          "XSS risk: rendering raw HTML without DOMPurify" \
          "A03:2021" "V5.2.1" "CWE-79" \
          "Wrap HTML with DOMPurify.sanitize() before passing"
      done < <(grep -n "dangerouslySetInnerHTML" "$file" 2>/dev/null)
    fi
  fi

  # innerHTML 代入
  while IFS=: read -r ln content; do
    add_finding "HIGH" "A03-006" \
      "innerHTML assignment (DOM XSS sink)" \
      "$file" "$ln" \
      "Direct innerHTML assignment is a DOM XSS sink" \
      "A03:2021" "V5.2.1" "CWE-79" \
      "Use textContent for text, or DOMPurify for HTML"
  done < <(grep -nE "\\.innerHTML[[:space:]]*=|\\.outerHTML[[:space:]]*=|insertAdjacentHTML" "$file" 2>/dev/null)

  # document.write
  while IFS=: read -r ln content; do
    add_finding "HIGH" "A03-007" \
      "document.write usage" \
      "$file" "$ln" \
      "document.write is XSS-prone and deprecated" \
      "A03:2021" "V5.2.1" "CWE-79" \
      "Use modern DOM APIs (createElement, appendChild)"
  done < <(grep -nE "document\.write\(" "$file" 2>/dev/null)

  # javascript: scheme in href
  while IFS=: read -r ln content; do
    add_finding "HIGH" "A03-008" \
      "javascript: URL scheme" \
      "$file" "$ln" \
      "javascript: scheme in href/src is XSS vector" \
      "A03:2021" "V5.2.1" "CWE-79" \
      "Validate URLs against allow-list of safe schemes (http/https/mailto)"
  done < <(grep -nE "(href|src)[[:space:]]*=[[:space:]]*[\"'\`]javascript:" "$file" 2>/dev/null)
done

# ============================================================
# [A04-A06] Project-global checks (skipped with --files-only)
# ============================================================
if [ "$FILES_ONLY" != true ]; then

# ============================================================
# [A04] Insecure Design
# ============================================================
print_section "A04:2021 — Insecure Design"

# レート制限の存在チェック
RATE_LIMIT_FOUND=false
echo "$SOURCE_FILES" | while IFS= read -r file; do
  [ -z "$file" ] && continue
  if grep -qE "rateLimit|@upstash/ratelimit|express-rate-limit|rate-limiter" "$file" 2>/dev/null; then
    RATE_LIMIT_FOUND=true
    break
  fi
done

if [ "$RATE_LIMIT_FOUND" = "false" ]; then
  # ログイン/認証エンドポイントが存在する場合のみ警告
  if echo "$SOURCE_FILES" | xargs grep -l -E "signIn|login|authenticate" 2>/dev/null | head -1 > /dev/null; then
    add_finding "HIGH" "A04-001" \
      "No rate limiting detected" \
      "" "" \
      "Authentication endpoints found but no rate limiting library detected" \
      "A04:2021" "V2.2.5, V11.1.4" "CWE-307" \
      "Add @upstash/ratelimit or similar to login/auth endpoints"
  fi
fi

# ============================================================
# [A05] Security Misconfiguration
# ============================================================
print_section "A05:2021 — Security Misconfiguration"

# next.config の検査
for config in next.config.js next.config.mjs next.config.ts; do
  if [ -f "$config" ]; then
    if ! grep -qE "poweredByHeader[[:space:]]*:[[:space:]]*false" "$config"; then
      add_finding "MEDIUM" "A05-001" \
        "X-Powered-By header not disabled" \
        "$config" "" \
        "Next.js exposes 'X-Powered-By: Next.js' by default" \
        "A05:2021" "V14.3.2" "CWE-200" \
        "Set 'poweredByHeader: false' in next.config"
    else
      pass_check "next.config: poweredByHeader disabled"
    fi

    # セキュリティヘッダの存在確認（next.config だけでなく proxy/middleware も対象）
    HEADER_SRC=("$config" proxy.ts src/proxy.ts middleware.ts src/middleware.ts)
    if ! grep -rqsE "Content-Security-Policy" "${HEADER_SRC[@]}"; then
      add_finding "HIGH" "A05-002" \
        "CSP header not configured" \
        "$config" "" \
        "No Content-Security-Policy found in next.config / proxy / middleware" \
        "A05:2021" "V14.4.3" "CWE-693" \
        "Add CSP header in headers() function or proxy/middleware"
    else
      pass_check "CSP configured (next.config / proxy / middleware)"
    fi

    if ! grep -rqsE "Strict-Transport-Security" "${HEADER_SRC[@]}"; then
      add_finding "HIGH" "A05-003" \
        "HSTS header not configured" \
        "$config" "" \
        "Strict-Transport-Security header not found in next.config / proxy / middleware" \
        "A05:2021" "V14.4.5, V9.1.3" "CWE-319" \
        "Add HSTS: 'max-age=63072000; includeSubDomains; preload'"
    else
      pass_check "HSTS configured (next.config / proxy / middleware)"
    fi

    # CSP unsafe-inline / unsafe-eval
    if grep -qE "['\"]unsafe-inline['\"]|'unsafe-inline'" "$config"; then
      add_finding "HIGH" "A05-004" \
        "CSP allows 'unsafe-inline'" \
        "$config" "" \
        "unsafe-inline disables XSS protection of CSP" \
        "A05:2021" "V14.4.3" "CWE-693" \
        "Use nonce or hash with 'strict-dynamic' instead"
    fi
    if grep -qE "['\"]unsafe-eval['\"]|'unsafe-eval'" "$config"; then
      add_finding "HIGH" "A05-005" \
        "CSP allows 'unsafe-eval'" \
        "$config" "" \
        "unsafe-eval allows runtime code execution" \
        "A05:2021" "V14.4.3" "CWE-693" \
        "Remove unsafe-eval; refactor code to avoid eval()"
    fi
  fi
done

# Middleware / proxy (Next.js 16 renamed middleware -> proxy) での CSP nonce 実装確認
for mw in middleware.ts middleware.js src/middleware.ts proxy.ts src/proxy.ts; do
  if [ -f "$mw" ]; then
    if grep -qE "Content-Security-Policy" "$mw"; then
      if grep -qE "nonce|randomUUID|randomBytes" "$mw"; then
        pass_check "middleware: CSP with nonce detected"
      else
        add_finding "MEDIUM" "A05-006" \
          "CSP without nonce in middleware" \
          "$mw" "" \
          "Static CSP is less secure than nonce-based" \
          "A05:2021" "V14.4.3" "CWE-693" \
          "Generate per-request nonce and use 'strict-dynamic'"
      fi
    fi
  fi
done

# tsconfig strict
if [ -f "tsconfig.json" ]; then
  if grep -qE "['\"]strict['\"][[:space:]]*:[[:space:]]*true" tsconfig.json; then
    pass_check "tsconfig: strict mode enabled"
  else
    add_finding "MEDIUM" "A05-007" \
      "TypeScript strict mode not enabled" \
      "tsconfig.json" "" \
      "Type safety is the first line of defense" \
      "A05:2021" "—" "CWE-1126" \
      "Set 'strict: true' in compilerOptions"
  fi
fi

# .env files in git
if [ -d ".git" ]; then
  if git ls-files 2>/dev/null | grep -E "^\.env(\..*)?$" | grep -v "\.env\.example\|\.env\.sample\|\.env\.template" > /dev/null; then
    add_finding "CRITICAL" "A05-008" \
      ".env file committed to git" \
      "" "" \
      "Environment files containing secrets must not be in git" \
      "A05:2021" "V14.1.3" "CWE-200" \
      "Remove from git, add to .gitignore, rotate all secrets"
  else
    pass_check ".env files not in git"
  fi
fi

# .gitignore に .env が含まれているか
if [ -f ".gitignore" ]; then
  if grep -qE "^\.env" .gitignore; then
    pass_check ".gitignore excludes .env files"
  else
    add_finding "HIGH" "A05-009" \
      ".env not in .gitignore" \
      ".gitignore" "" \
      ".env files may be accidentally committed" \
      "A05:2021" "V14.1.3" "CWE-200" \
      "Add '.env*' to .gitignore (except .env.example)"
  fi
fi

# ============================================================
# [A06] Vulnerable and Outdated Components
# ============================================================
print_section "A06:2021 — Vulnerable and Outdated Components"

# package.json / lockfile
if [ -f "package.json" ]; then
  if [ -f "package-lock.json" ] || [ -f "pnpm-lock.yaml" ] || [ -f "yarn.lock" ]; then
    pass_check "Lockfile present"
  else
    add_finding "HIGH" "A06-001" \
      "No lockfile found" \
      "package.json" "" \
      "Lockfile ensures reproducible and auditable builds" \
      "A06:2021" "V14.2.4" "CWE-1357" \
      "Run npm/pnpm/yarn install to generate lockfile and commit it"
  fi

  # npm audit (if available)
  if command -v npm >/dev/null 2>&1 && [ -f "package-lock.json" ]; then
    AUDIT_RESULT=$(npm audit --production --audit-level=high --json 2>/dev/null || echo '{}')
    HIGH_VULNS=$(echo "$AUDIT_RESULT" | grep -oE '"high":[0-9]+' | head -1 | grep -oE '[0-9]+' || echo "0")
    CRITICAL_VULNS=$(echo "$AUDIT_RESULT" | grep -oE '"critical":[0-9]+' | head -1 | grep -oE '[0-9]+' || echo "0")

    if [ "${CRITICAL_VULNS:-0}" -gt 0 ]; then
      add_finding "CRITICAL" "A06-002" \
        "Critical vulnerabilities in dependencies" \
        "package.json" "" \
        "${CRITICAL_VULNS} critical vulnerabilities detected by npm audit" \
        "A06:2021" "V14.2.1" "CWE-1104" \
        "Run 'npm audit fix' or update affected packages"
    fi

    if [ "${HIGH_VULNS:-0}" -gt 0 ]; then
      add_finding "HIGH" "A06-003" \
        "High severity vulnerabilities in dependencies" \
        "package.json" "" \
        "${HIGH_VULNS} high severity vulnerabilities detected" \
        "A06:2021" "V14.2.1" "CWE-1104" \
        "Run 'npm audit fix' or update affected packages"
    fi

    if [ "${HIGH_VULNS:-0}" -eq 0 ] && [ "${CRITICAL_VULNS:-0}" -eq 0 ]; then
      pass_check "npm audit: no high/critical vulnerabilities"
    fi
  fi

  # 古い Next.js
  NEXT_VERSION=$(grep -oE '"next"[[:space:]]*:[[:space:]]*"[^"]*"' package.json | head -1 | grep -oE '[0-9]+\.[0-9]+' | head -1 || echo "0")
  if [ -n "$NEXT_VERSION" ]; then
    MAJOR=$(echo "$NEXT_VERSION" | cut -d. -f1)
    if [ "${MAJOR:-0}" -lt 13 ]; then
      add_finding "HIGH" "A06-004" \
        "Outdated Next.js version" \
        "package.json" "" \
        "Next.js ${NEXT_VERSION} is outdated (security patches may be missing)" \
        "A06:2021" "V14.2.1" "CWE-1104" \
        "Upgrade to latest stable Next.js"
    fi
  fi
fi

fi  # end FILES_ONLY guard for [A04-A06]

# ============================================================
# [A07] Identification and Authentication Failures
# ============================================================
print_section "A07:2021 — Identification and Authentication Failures"

echo "$SOURCE_FILES" | while IFS= read -r file; do
  [ -z "$file" ] && continue

  # JWT alg:none
  while IFS=: read -r ln content; do
    add_finding "CRITICAL" "A07-001" \
      "JWT alg:none detected" \
      "$file" "$ln" \
      "Unsigned JWT accepts forged tokens" \
      "A07:2021" "V3.5.3" "CWE-347" \
      "Always require signed JWT with HS256/RS256/ES256"
  done < <(grep -nE "['\"]none['\"][[:space:]]*}|alg[[:space:]]*:[[:space:]]*['\"]none['\"]" "$file" 2>/dev/null)

  # ハードコードされたシークレット
  while IFS=: read -r ln content; do
    # NEXT_PUBLIC_ ではないこと、テストデータでないことを確認
    if ! echo "$content" | grep -qE "NEXT_PUBLIC_|example|sample|test|placeholder|xxx+"; then
      add_finding "CRITICAL" "A07-002" \
        "Possible hardcoded secret" \
        "$file" "$ln" \
        "Hardcoded credential/key/token detected" \
        "A07:2021" "V2.10.4" "CWE-798" \
        "Move to environment variable; rotate the exposed value"
    fi
  done < <(grep -nE "(api[_-]?key|secret|password|token|jwt[_-]?secret)[[:space:]]*[:=][[:space:]]*['\"][A-Za-z0-9_\-]{20,}['\"]" "$file" 2>/dev/null)

  # NEXT_PUBLIC_ にシークレット
  while IFS=: read -r ln content; do
    add_finding "CRITICAL" "A07-003" \
      "Secret exposed via NEXT_PUBLIC_" \
      "$file" "$ln" \
      "NEXT_PUBLIC_* variables are bundled to client-side JS" \
      "A07:2021" "V14.3.2" "CWE-200" \
      "Remove NEXT_PUBLIC_ prefix; access secrets only in Server Components/Actions"
  done < <(grep -nE "NEXT_PUBLIC_[A-Z_]*(SECRET|PRIVATE|TOKEN|PASSWORD|API_KEY|JWT)" "$file" 2>/dev/null)
done

# ============================================================
# [A08] Software and Data Integrity Failures
# ============================================================
print_section "A08:2021 — Software and Data Integrity Failures"

echo "$SOURCE_FILES" | while IFS= read -r file; do
  [ -z "$file" ] && continue

  # 外部 <script src=...> without integrity
  while IFS=: read -r ln content; do
    if echo "$content" | grep -qE '<script[^>]+src=["\x27]https?://'; then
      if ! echo "$content" | grep -qE 'integrity='; then
        add_finding "MEDIUM" "A08-001" \
          "External script without SRI" \
          "$file" "$ln" \
          "External script lacks Subresource Integrity hash" \
          "A08:2021" "V14.2.3, V10.3.2" "CWE-353" \
          "Add integrity=\"sha384-...\" and crossorigin=\"anonymous\""
      fi
    fi
  done < <(grep -nE '<script[^>]+src=["\x27]https?://' "$file" 2>/dev/null)

  # 危険な逆シリアライズ
  while IFS=: read -r ln content; do
    add_finding "HIGH" "A08-002" \
      "Insecure deserialization" \
      "$file" "$ln" \
      "Deserializing untrusted data with vm/serialize-javascript" \
      "A08:2021" "V5.5.1" "CWE-502" \
      "Use JSON.parse with schema validation (Zod)"
  done < <(grep -nE "vm\.runIn|serialize-javascript|node-serialize" "$file" 2>/dev/null)
done

# ============================================================
# [A09] Security Logging and Monitoring Failures
# ============================================================
print_section "A09:2021 — Security Logging and Monitoring Failures"

echo "$SOURCE_FILES" | while IFS= read -r file; do
  [ -z "$file" ] && continue

  # console.log で機密情報を出していないか
  while IFS=: read -r ln content; do
    add_finding "MEDIUM" "A09-001" \
      "Possible sensitive data in console.log" \
      "$file" "$ln" \
      "console.log of password/token/secret detected" \
      "A09:2021" "V7.1.1" "CWE-532" \
      "Remove or use structured logger with PII redaction"
  done < <(grep -niE "console\.(log|debug|info)\([^)]*(password|token|secret|jwt|apiKey|api_key|authorization)" "$file" 2>/dev/null)

  # エラーレスポンスにスタックトレース
  while IFS=: read -r ln content; do
    add_finding "MEDIUM" "A09-002" \
      "Stack trace exposed to client" \
      "$file" "$ln" \
      "err.stack returned in HTTP response" \
      "A09:2021" "V7.4.1" "CWE-209" \
      "Return generic error message; log full error server-side"
  done < <(grep -nE "(NextResponse\.json|res\.(json|send|status)\([^)]*err(or)?\.(stack|message))" "$file" 2>/dev/null)
done

# ============================================================
# [A10] Server-Side Request Forgery (SSRF)
# ============================================================
print_section "A10:2021 — Server-Side Request Forgery"

echo "$SOURCE_FILES" | while IFS= read -r file; do
  [ -z "$file" ] && continue

  # fetch にユーザー入力を直接渡している可能性
  while IFS=: read -r ln content; do
    if echo "$content" | grep -qE "fetch\([^)]*\\\$\{|fetch\([^)]*[a-zA-Z_]+\.url|fetch\([^)]*req\.|fetch\([^)]*params\.|fetch\([^)]*searchParams"; then
      add_finding "HIGH" "A10-001" \
        "Possible SSRF: dynamic fetch URL" \
        "$file" "$ln" \
        "fetch URL appears to use user-controlled input without allow-list" \
        "A10:2021" "V12.6.1" "CWE-918" \
        "Validate URL against allow-list of trusted hosts; block private IPs"
    fi
  done < <(grep -nE "fetch\(" "$file" 2>/dev/null)
done

# images.remotePatterns の wildcard
if [ "$FILES_ONLY" != true ]; then
for cfg in next.config.js next.config.mjs next.config.ts; do
  if [ -f "$cfg" ]; then
    if grep -qE "hostname[[:space:]]*:[[:space:]]*['\"]\\*\\*?['\"]" "$cfg"; then
      add_finding "HIGH" "A10-002" \
        "Wildcard hostname in next/image" \
        "$cfg" "" \
        "images.remotePatterns allows any host (SSRF/abuse risk)" \
        "A10:2021" "V12.6.1" "CWE-918" \
        "Specify exact hostnames in remotePatterns"
    fi
  fi
done
fi  # end FILES_ONLY guard for images.remotePatterns

# ============================================================
# [Bonus] CSRF / File Upload / その他
# ============================================================
print_section "Additional Checks (CSRF / Upload / Misc)"

echo "$SOURCE_FILES" | while IFS= read -r file; do
  [ -z "$file" ] && continue

  # target="_blank" without rel
  if grep -qE 'target="_blank"' "$file"; then
    while IFS=: read -r ln content; do
      if ! echo "$content" | grep -qE 'rel="[^"]*noopener[^"]*noreferrer|rel="[^"]*noreferrer[^"]*noopener'; then
        add_finding "MEDIUM" "MISC-001" \
          "target=_blank without noopener noreferrer" \
          "$file" "$ln" \
          "Reverse tabnabbing risk" \
          "—" "—" "CWE-1022" \
          "Add rel=\"noopener noreferrer\""
      fi
    done < <(grep -nE 'target="_blank"' "$file")
  fi

  # localStorage に機密情報
  while IFS=: read -r ln content; do
    add_finding "HIGH" "MISC-002" \
      "Sensitive data in localStorage" \
      "$file" "$ln" \
      "Tokens/secrets in localStorage are vulnerable to XSS" \
      "—" "V3.5.2" "CWE-922" \
      "Use httpOnly cookies for session tokens"
  done < <(grep -nE "localStorage\.setItem\([^)]*['\"]?(token|jwt|secret|password|auth|access_token)" "$file" 2>/dev/null)

  # ReDoS の疑いがある正規表現
  while IFS=: read -r ln content; do
    add_finding "LOW" "MISC-003" \
      "Possibly catastrophic regex (ReDoS)" \
      "$file" "$ln" \
      "Nested quantifiers can cause catastrophic backtracking" \
      "—" "V5.2.6" "CWE-1333" \
      "Review regex complexity; use safe-regex library to validate"
  done < <(grep -nE "\\([^)]*[+*][^)]*\\)[+*]" "$file" 2>/dev/null | head -5)

  # Open redirect
  while IFS=: read -r ln content; do
    if echo "$content" | grep -qE "(redirect|location|location\.href|window\.location)[[:space:]]*\\(?[[:space:]]*[a-zA-Z_]+\\.(query|params|searchParams|body)"; then
      add_finding "HIGH" "MISC-004" \
        "Possible open redirect" \
        "$file" "$ln" \
        "Redirect target derived from user input" \
        "—" "V5.1.5" "CWE-601" \
        "Validate redirect URL against allow-list of internal paths/hosts"
    fi
  done < <(grep -nE "redirect\(|location[[:space:]]*=" "$file" 2>/dev/null)
done

# ============================================================
# 静的解析ツール統合（任意）
# ============================================================
if [ "$FILES_ONLY" != true ]; then
print_section "Static Analysis Tools (if available)"

# ESLint
if command -v npx >/dev/null 2>&1 && [ -f "package.json" ]; then
  if npx --no-install eslint --version >/dev/null 2>&1; then
    echo -e "${CYAN}Running ESLint...${NC}"
    if npx --no-install eslint "${TARGETS[@]}" --quiet 2>/dev/null; then
      pass_check "ESLint: no errors"
    else
      add_finding "INFO" "TOOL-001" \
        "ESLint reported issues" \
        "" "" \
        "Run 'npx eslint <path>' for details" \
        "—" "—" "—" \
        "Fix ESLint errors"
    fi
  fi

  # TypeScript
  if [ -f "tsconfig.json" ] && npx --no-install tsc --version >/dev/null 2>&1; then
    echo -e "${CYAN}Running tsc --noEmit...${NC}"
    if npx --no-install tsc --noEmit 2>/dev/null; then
      pass_check "TypeScript: no type errors"
    else
      add_finding "MEDIUM" "TOOL-002" \
        "TypeScript type errors" \
        "" "" \
        "Type errors may indicate runtime bugs" \
        "—" "V14.1.2" "CWE-1126" \
        "Run 'npx tsc --noEmit' and fix errors"
    fi
  fi
fi

# secret scan (gitleaks)
if command -v gitleaks >/dev/null 2>&1; then
  echo -e "${CYAN}Running gitleaks...${NC}"
  if gitleaks detect --no-git --source . --quiet 2>/dev/null; then
    pass_check "gitleaks: no secrets detected"
  else
    add_finding "CRITICAL" "TOOL-003" \
      "Secrets detected by gitleaks" \
      "" "" \
      "Hardcoded secrets found" \
      "A07:2021" "V2.10.4" "CWE-798" \
      "Run 'gitleaks detect --source .' and remediate"
  fi
fi

# semgrep
if command -v semgrep >/dev/null 2>&1; then
  echo -e "${CYAN}Running semgrep (auto config)...${NC}"
  if semgrep --config auto --error --quiet "${TARGETS[@]}" 2>/dev/null; then
    pass_check "semgrep: no findings"
  else
    add_finding "INFO" "TOOL-004" \
      "Semgrep found issues" \
      "" "" \
      "Run 'semgrep --config auto' for details" \
      "—" "—" "—" \
      "Review semgrep findings"
  fi
fi

fi  # end FILES_ONLY guard for Static Analysis Tools

# ============================================================
# サマリ
# ============================================================
TOTAL=$((CRITICAL + HIGH + MEDIUM + LOW + INFO))

echo ""
echo -e "${CYAN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${CYAN}${BOLD}  📊 Audit Summary${NC}"
echo -e "${CYAN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "  ${RED}🔴 Critical : ${CRITICAL}${NC}"
echo -e "  ${ORANGE}🟠 High     : ${HIGH}${NC}"
echo -e "  ${YELLOW}🟡 Medium   : ${MEDIUM}${NC}"
echo -e "  ${BLUE}🔵 Low      : ${LOW}${NC}"
echo -e "  ${GRAY}⚪ Info     : ${INFO}${NC}"
echo -e "  ${GREEN}✅ Passed   : ${PASS}${NC}"
echo ""
echo -e "  ${BOLD}Total findings : ${TOTAL}${NC}"
echo -e "  ${BOLD}Files scanned  : ${FILE_COUNT}${NC}"
echo ""

# Go/No-Go
if [ "$CRITICAL" -gt 0 ] || [ "$HIGH" -gt 0 ]; then
  echo -e "${RED}${BOLD}🚫 RELEASE DECISION: NO-GO${NC}"
  echo -e "${RED}   Critical/High issues must be resolved before release.${NC}"
  RESULT_CODE=1
elif [ "$MEDIUM" -gt 0 ]; then
  echo -e "${YELLOW}${BOLD}⚠️  RELEASE DECISION: CONDITIONAL GO${NC}"
  echo -e "${YELLOW}   Medium issues should be addressed.${NC}"
  RESULT_CODE=0
else
  echo -e "${GREEN}${BOLD}✅ RELEASE DECISION: GO${NC}"
  RESULT_CODE=0
fi

# ============================================================
# Markdown レポート生成
# ============================================================
if [ -n "$REPORT_FILE" ]; then
  {
    echo "# Security Audit Report"
    echo ""
    echo "- **Date**: $(date -u +"%Y-%m-%d %H:%M:%S UTC")"
    echo "- **Targets**: ${TARGETS[*]}"
    echo "- **Files Scanned**: ${FILE_COUNT}"
    echo "- **Standards**: OWASP Top 10 (2021), ASVS v4.0.3, NIST SSDF v1.1, OWASP Secure Headers, MDN Web Security"
    echo ""
    echo "## Executive Summary"
    echo ""
    echo "| Severity | Count |"
    echo "|---|---|"
    echo "| 🔴 Critical | ${CRITICAL} |"
    echo "| 🟠 High | ${HIGH} |"
    echo "| 🟡 Medium | ${MEDIUM} |"
    echo "| 🔵 Low | ${LOW} |"
    echo "| ⚪ Info | ${INFO} |"
    echo ""
    if [ "$CRITICAL" -gt 0 ] || [ "$HIGH" -gt 0 ]; then
      echo "**Release Decision**: 🚫 **NO-GO**"
    elif [ "$MEDIUM" -gt 0 ]; then
      echo "**Release Decision**: ⚠️ **CONDITIONAL GO**"
    else
      echo "**Release Decision**: ✅ **GO**"
    fi
    echo ""
    echo "## Findings"
    echo ""
    for finding in "${FINDINGS[@]}"; do
      IFS='|' read -r sev id title file line detail owasp asvs cwe fix <<< "$finding"
      echo "### [${sev}] ${id}: ${title}"
      echo ""
      [ -n "$file" ] && echo "- **Location**: \`${file}${line:+:$line}\`"
      [ -n "$detail" ] && echo "- **Detail**: ${detail}"
      echo "- **OWASP**: ${owasp} / **ASVS**: ${asvs} / **CWE**: ${cwe}"
      [ -n "$fix" ] && echo "- **Fix**: ${fix}"
      echo ""
    done
  } > "$REPORT_FILE"
  echo ""
  echo -e "${GREEN}📄 Markdown report written to: ${REPORT_FILE}${NC}"
fi

echo ""
exit $RESULT_CODE
