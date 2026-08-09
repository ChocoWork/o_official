#!/usr/bin/env python3
"""Cross-platform OWASP/ASVS security audit for Next.js projects."""

from __future__ import annotations

import argparse
from collections import Counter
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
from typing import Iterable, Sequence


SOURCE_SUFFIXES = {".ts", ".tsx", ".js", ".jsx", ".mjs"}
EXCLUDED_PARTS = {"node_modules", ".next", "dist", "build", "coverage"}
SEVERITIES = ("CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO")
DEFAULT_TARGETS = (
    "app", "src", "pages", "components", "lib", "hooks", "utils",
    "middleware.ts", "middleware.js", "src/middleware.ts", "proxy.ts",
    "src/proxy.ts", "next.config.js", "next.config.mjs", "next.config.ts",
)


@dataclass(frozen=True)
class Finding:
    severity: str
    id: str
    title: str
    file: str = ""
    line: int | None = None
    detail: str = ""
    owasp: str = "-"
    asvs: str = "-"
    cwe: str = "-"
    fix: str = ""


@dataclass(frozen=True)
class RegexRule:
    severity: str
    id: str
    title: str
    pattern: str
    detail: str
    owasp: str
    asvs: str
    cwe: str
    fix: str
    flags: int = 0


RULES = (
    RegexRule("CRITICAL", "A02-001", "Weak hash algorithm for password", r"createHash\(['\"](?:md5|sha1)['\"]", "MD5/SHA-1 detected", "A02:2021", "V2.4.1-V2.4.4", "CWE-327", "Use Argon2id, bcrypt, or scrypt", re.I),
    RegexRule("HIGH", "A02-002", "Math.random() used", r"Math\.random\(\)", "Math.random is not cryptographically secure", "A02:2021", "V6.3.1", "CWE-338", "Use crypto.randomBytes(), randomUUID(), or getRandomValues()"),
    RegexRule("HIGH", "A02-006", "Weak cipher algorithm", r"createCipher(?:iv)?\(['\"](?:des|3des|rc4|aes-128-ecb|aes-256-ecb)", "Weak cipher detected", "A02:2021", "V6.2.5", "CWE-327", "Use AES-256-GCM or ChaCha20-Poly1305", re.I),
    RegexRule("CRITICAL", "A03-001", "Code injection sink: eval/Function", r"(?:^|[^A-Za-z_.])eval\(|new\s+Function\s*\(", "eval() or new Function() allows arbitrary code execution", "A03:2021", "V5.2.4", "CWE-95", "Remove eval/new Function"),
    RegexRule("CRITICAL", "A03-002", "Possible SQL injection", r"(?:SELECT|INSERT|UPDATE|DELETE)\s+.+['\"]\s*\+|\$queryRawUnsafe\(", "SQL query appears to concatenate variables", "A03:2021", "V5.3.4", "CWE-89", "Use parameterized queries", re.I),
    RegexRule("HIGH", "A03-003", "Possible NoSQL injection", r"\$where\s*:", "MongoDB $where detected", "A03:2021", "V5.3.5", "CWE-943", "Use typed query operators with validated inputs"),
    RegexRule("HIGH", "A03-004", "Possible OS command injection", r"child_process.*\.exec\(|require\(['\"]child_process['\"]\)\.exec\(", "child_process.exec can invoke a shell", "A03:2021", "V5.3.7", "CWE-78", "Use execFile() with array arguments"),
    RegexRule("HIGH", "A03-006", "innerHTML assignment", r"\.(?:innerHTML|outerHTML)\s*=|insertAdjacentHTML", "Direct HTML assignment is a DOM XSS sink", "A03:2021", "V5.2.1", "CWE-79", "Use textContent or sanitize HTML"),
    RegexRule("HIGH", "A03-007", "document.write usage", r"document\.write\(", "document.write is XSS-prone", "A03:2021", "V5.2.1", "CWE-79", "Use modern DOM APIs"),
    RegexRule("HIGH", "A03-008", "javascript: URL scheme", r"(?:href|src)\s*=\s*[\"'`]javascript:", "javascript: is an XSS vector", "A03:2021", "V5.2.1", "CWE-79", "Allow-list safe URL schemes", re.I),
    RegexRule("CRITICAL", "A07-001", "JWT alg:none detected", r"['\"]none['\"]\s*}|alg\s*:\s*['\"]none['\"]", "Unsigned JWT may be accepted", "A07:2021", "V3.5.3", "CWE-347", "Require a signed JWT algorithm", re.I),
    RegexRule("CRITICAL", "A07-003", "Secret exposed via NEXT_PUBLIC_", r"NEXT_PUBLIC_[A-Z_]*(?:SECRET|PRIVATE|TOKEN|PASSWORD|API_KEY|JWT)", "NEXT_PUBLIC variables are bundled for clients", "A07:2021", "V14.3.2", "CWE-200", "Keep secrets server-side"),
    RegexRule("HIGH", "A08-002", "Insecure deserialization", r"vm\.runIn|serialize-javascript|node-serialize", "Unsafe deserialization mechanism detected", "A08:2021", "V5.5.1", "CWE-502", "Use JSON.parse with schema validation"),
    RegexRule("MEDIUM", "A09-001", "Possible sensitive data in console output", r"console\.(?:log|debug|info)\([^\n]*(?:password|token|secret|jwt|apiKey|api_key|authorization)", "Sensitive data may be logged", "A09:2021", "V7.1.1", "CWE-532", "Use a structured logger with redaction", re.I),
    RegexRule("MEDIUM", "A09-002", "Stack trace exposed to client", r"(?:NextResponse\.json|res\.(?:json|send|status)\()[^\n]*err(?:or)?\.(?:stack|message)", "Internal errors may be returned to clients", "A09:2021", "V7.4.1", "CWE-209", "Return a generic message and log server-side", re.I),
    RegexRule("HIGH", "MISC-002", "Sensitive data in localStorage", r"localStorage\.setItem\([^\n]*['\"]?(?:token|jwt|secret|password|auth|access_token)", "Browser storage is accessible to XSS", "-", "V3.5.2", "CWE-922", "Use httpOnly cookies", re.I),
    RegexRule("LOW", "MISC-003", "Possibly catastrophic regex", r"\([^)]*[+*][^)]*\)[+*]", "Nested quantifiers may cause ReDoS", "-", "V5.2.6", "CWE-1333", "Review regex complexity"),
)


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Cross-platform security audit")
    parser.add_argument("paths", nargs="*", help="Files or directories to scan")
    parser.add_argument("--json", action="store_true", dest="json_output")
    parser.add_argument("--report", type=Path)
    parser.add_argument("--files-only", action="store_true")
    return parser.parse_args(argv)


def resolve_targets(raw_targets: Sequence[str], root: Path) -> list[Path]:
    candidates = [Path(value) for value in raw_targets] if raw_targets else [Path(value) for value in DEFAULT_TARGETS]
    targets = [(path if path.is_absolute() else root / path).resolve() for path in candidates]
    return [path for path in targets if path.exists()]


def source_files(targets: Iterable[Path]) -> list[Path]:
    files: set[Path] = set()
    for target in targets:
        if target.is_file() and target.suffix.lower() in SOURCE_SUFFIXES:
            files.add(target)
        elif target.is_dir():
            for path in target.rglob("*"):
                if path.is_file() and path.suffix.lower() in SOURCE_SUFFIXES and not EXCLUDED_PARTS.intersection(path.parts):
                    files.add(path)
    return sorted(files, key=lambda path: str(path).lower())


def display_path(path: Path, root: Path) -> str:
    try:
        return path.relative_to(root).as_posix()
    except ValueError:
        return str(path)


def add_regex_findings(path: Path, text: str, root: Path, findings: list[Finding]) -> None:
    name = display_path(path, root)
    lines = text.splitlines()
    for rule in RULES:
        regex = re.compile(rule.pattern, rule.flags)
        for line_number, line in enumerate(lines, 1):
            if regex.search(line):
                findings.append(Finding(rule.severity, rule.id, rule.title, name, line_number, rule.detail, rule.owasp, rule.asvs, rule.cwe, rule.fix))
                if rule.id == "MISC-003" and sum(item.id == rule.id and item.file == name for item in findings) >= 5:
                    break


def add_context_findings(path: Path, text: str, root: Path, findings: list[Finding]) -> None:
    name = display_path(path, root)
    normalized = name.replace("\\", "/")
    auth_pattern = r"auth\(\)|getSession|getServerSession|currentUser\(|requireAuth|getUser\(\)|authorize|Authorization|verifyToken"
    if re.search(r"['\"]use server['\"]", text) and not re.search(auth_pattern, text):
        findings.append(Finding("CRITICAL", "A01-001", "Server Action without authentication", name, detail="No authentication check detected", owasp="A01:2021", asvs="V4.1.1, V4.1.5", cwe="CWE-862", fix="Authenticate at the start of the action"))
    if re.search(r"['\"]use server['\"]", text) and not re.search(r"userId|ownerId|authorId|session\.user\.id|\.id ===|\.userId ===", text):
        findings.append(Finding("HIGH", "A01-002", "Server Action without ownership check", name, detail="Resource ownership verification was not detected", owasp="A01:2021", asvs="V4.2.1", cwe="CWE-639", fix="Verify resource ownership before mutation"))
    if re.search(r"/(?:route)\.(?:ts|tsx|js)$", normalized) and not re.search(auth_pattern, text) and not re.search(r"//\s*(?:PUBLIC|public|no-auth)", text):
        findings.append(Finding("HIGH", "A01-003", "Route Handler without authentication", name, detail="No authentication check or PUBLIC marker detected", owasp="A01:2021", asvs="V4.1.1", cwe="CWE-862", fix="Authenticate the request or document the public endpoint"))
    if Path(normalized).name in {"middleware.ts", "middleware.js", "proxy.ts"} and re.search(r"auth|session", text, re.I):
        findings.append(Finding("INFO", "A01-005", "Middleware-based auth detected", name, detail="Re-verify access inside handlers and actions", owasp="A01:2021", asvs="V4.1.1", cwe="CWE-863", fix="Do not rely only on middleware authorization"))
    for number, line in enumerate(text.splitlines(), 1):
        if re.search(r"['\"]Access-Control-Allow-Origin['\"]\s*[:,]\s*['\"]\*['\"]", line):
            findings.append(Finding("HIGH", "A01-004", "CORS allows any origin", name, number, "Wildcard origin detected", "A01:2021", "V14.5.3", "CWE-942", "Use an allow-list"))
        if re.search(r"cookies\(\)\.set|setHeader\(['\"]Set-Cookie|res\.cookie\(", line):
            for field, identifier, title, severity, cwe, fix in (
                (r"httpOnly\s*:\s*true|HttpOnly", "A02-003", "Cookie without HttpOnly", "HIGH", "CWE-1004", "Set httpOnly: true"),
                (r"secure\s*:\s*true|Secure", "A02-004", "Cookie without Secure", "HIGH", "CWE-614", "Set secure: true in production"),
                (r"sameSite|SameSite", "A02-005", "Cookie without SameSite", "MEDIUM", "CWE-1275", "Set sameSite to lax or strict"),
            ):
                if not re.search(field, line):
                    findings.append(Finding(severity, identifier, title, name, number, owasp="A02:2021", asvs="V3.4", cwe=cwe, fix=fix))
        if "target=\"_blank\"" in line and not re.search(r"rel=\"[^\"]*(?:noopener[^\"]*noreferrer|noreferrer[^\"]*noopener)", line):
            findings.append(Finding("MEDIUM", "MISC-001", "target=_blank without noopener noreferrer", name, number, owasp="-", asvs="-", cwe="CWE-1022", fix="Add rel=\"noopener noreferrer\""))
        if re.search(r"<script[^>]+src=['\"]https?://", line, re.I) and "integrity=" not in line:
            findings.append(Finding("MEDIUM", "A08-001", "External script without SRI", name, number, "External script lacks an integrity hash", "A08:2021", "V14.2.3, V10.3.2", "CWE-353", "Add integrity and crossorigin attributes"))
        has_url_allowlist = bool(
            re.search(r"ALLOWED_[A-Z_]*HOST", text)
            and re.search(r"\.hostname", text)
            and re.search(r"\.has\(", text)
        )
        if (
            re.search(r"fetch\(", line)
            and re.search(r"fetch\([^)]*(?:\$\{|[A-Za-z_]+\.url|req\.|params\.|searchParams|\burl\b)", line)
            and not has_url_allowlist
        ):
            findings.append(Finding("HIGH", "A10-001", "Possible SSRF: dynamic fetch URL", name, number, "Dynamic fetch target detected", "A10:2021", "V12.6.1", "CWE-918", "Validate against an allow-list and block private addresses"))
        if re.search(r"redirect\(|location\s*=", line) and re.search(r"(?:query|params|searchParams|body)", line):
            findings.append(Finding("HIGH", "MISC-004", "Possible open redirect", name, number, "Redirect target may derive from user input", "-", "V5.1.5", "CWE-601", "Allow only internal paths or trusted hosts"))
    if "dangerouslySetInnerHTML" in text and not re.search(r"DOMPurify|sanitize|isomorphic-dompurify", text):
        for match in re.finditer("dangerouslySetInnerHTML", text):
            findings.append(Finding("HIGH", "A03-005", "dangerouslySetInnerHTML without sanitization", name, text.count("\n", 0, match.start()) + 1, "Raw HTML rendering detected", "A03:2021", "V5.2.1", "CWE-79", "Sanitize HTML before rendering"))
    secret = re.compile(r"(?:api[_-]?key|secret|password|token|jwt[_-]?secret)\s*[:=]\s*['\"][A-Za-z0-9_-]{20,}['\"]", re.I)
    for number, line in enumerate(text.splitlines(), 1):
        if secret.search(line) and not re.search(r"NEXT_PUBLIC_|example|sample|test|placeholder|xxx+", line, re.I):
            findings.append(Finding("CRITICAL", "A07-002", "Possible hardcoded secret", name, number, "Credential-like literal detected", "A07:2021", "V2.10.4", "CWE-798", "Move it to an environment variable and rotate it"))


def read_source(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        return path.read_text(encoding="utf-8", errors="replace")


def add_project_findings(root: Path, findings: list[Finding], passes: list[str]) -> None:
    configs = [root / name for name in ("next.config.js", "next.config.mjs", "next.config.ts") if (root / name).exists()]
    header_sources = configs + [root / name for name in ("proxy.ts", "src/proxy.ts", "middleware.ts", "src/middleware.ts") if (root / name).exists()]
    combined_headers = "\n".join(read_source(path) for path in header_sources)
    all_source_text = "\n".join(read_source(path) for path in source_files([root / "src"])) if (root / "src").exists() else ""
    if re.search(r"signIn|login|authenticate", all_source_text, re.I) and not re.search(r"rateLimit|@upstash/ratelimit|express-rate-limit|rate-limiter", all_source_text):
        findings.append(Finding("HIGH", "A04-001", "No rate limiting detected", detail="Authentication code exists but no rate limiter was detected", owasp="A04:2021", asvs="V2.2.5, V11.1.4", cwe="CWE-307", fix="Rate-limit authentication endpoints"))
    for config in configs:
        text = read_source(config)
        name = display_path(config, root)
        if not re.search(r"poweredByHeader\s*:\s*false", text):
            findings.append(Finding("MEDIUM", "A05-001", "X-Powered-By header not disabled", name, owasp="A05:2021", asvs="V14.3.2", cwe="CWE-200", fix="Set poweredByHeader: false"))
        else:
            passes.append("next.config: poweredByHeader disabled")
        if "Content-Security-Policy" not in combined_headers:
            findings.append(Finding("HIGH", "A05-002", "CSP header not configured", name, owasp="A05:2021", asvs="V14.4.3", cwe="CWE-693", fix="Add Content-Security-Policy"))
        else:
            passes.append("CSP configured")
        if "Strict-Transport-Security" not in combined_headers:
            findings.append(Finding("HIGH", "A05-003", "HSTS header not configured", name, owasp="A05:2021", asvs="V14.4.5", cwe="CWE-319", fix="Add Strict-Transport-Security"))
        else:
            passes.append("HSTS configured")
        for identifier, token, title in (("A05-004", "unsafe-inline", "CSP allows unsafe-inline"), ("A05-005", "unsafe-eval", "CSP allows unsafe-eval")):
            if token in text:
                findings.append(Finding("HIGH", identifier, title, name, owasp="A05:2021", asvs="V14.4.3", cwe="CWE-693", fix=f"Remove {token}"))
    for middleware in [root / name for name in ("middleware.ts", "middleware.js", "src/middleware.ts", "proxy.ts", "src/proxy.ts") if (root / name).exists()]:
        text = read_source(middleware)
        if "Content-Security-Policy" in text and not re.search(r"nonce|randomUUID|randomBytes", text):
            findings.append(Finding("MEDIUM", "A05-006", "CSP without nonce", display_path(middleware, root), owasp="A05:2021", asvs="V14.4.3", cwe="CWE-693", fix="Generate a per-request nonce"))
    tsconfig = root / "tsconfig.json"
    if tsconfig.exists() and re.search(r"['\"]strict['\"]\s*:\s*true", read_source(tsconfig)):
        passes.append("tsconfig: strict mode enabled")
    elif tsconfig.exists():
        findings.append(Finding("MEDIUM", "A05-007", "TypeScript strict mode not enabled", "tsconfig.json", owasp="A05:2021", asvs="V14.1.2", cwe="CWE-1126", fix="Set strict: true"))
    gitignore = root / ".gitignore"
    if gitignore.exists() and re.search(r"^\.env", read_source(gitignore), re.M):
        passes.append(".gitignore excludes .env files")
    elif gitignore.exists():
        findings.append(Finding("HIGH", "A05-009", ".env not in .gitignore", ".gitignore", owasp="A05:2021", asvs="V14.1.3", cwe="CWE-200", fix="Add .env* to .gitignore"))
    git = shutil.which("git")
    if git and (root / ".git").exists():
        tracked = subprocess.run([git, "-c", f"safe.directory={root.as_posix()}", "ls-files"], cwd=root, capture_output=True, text=True, check=False)
        committed_env = [line for line in tracked.stdout.splitlines() if re.fullmatch(r"\.env(?:\..*)?", line) and not re.search(r"\.(?:example|sample|template)$", line)]
        if committed_env:
            findings.append(Finding("CRITICAL", "A05-008", ".env file committed to git", committed_env[0], owasp="A05:2021", asvs="V14.1.3", cwe="CWE-200", fix="Remove it from git and rotate secrets"))
        else:
            passes.append(".env files not in git")
    package = root / "package.json"
    if package.exists():
        if any((root / name).exists() for name in ("package-lock.json", "pnpm-lock.yaml", "yarn.lock")):
            passes.append("Lockfile present")
        else:
            findings.append(Finding("HIGH", "A06-001", "No lockfile found", "package.json", owasp="A06:2021", asvs="V14.2.4", cwe="CWE-1357", fix="Generate and commit a lockfile"))
        package_data = json.loads(package.read_text(encoding="utf-8"))
        next_spec = str((package_data.get("dependencies") or {}).get("next", ""))
        version_match = re.search(r"(\d+)\.(\d+)", next_spec)
        if version_match and int(version_match.group(1)) < 13:
            findings.append(Finding("HIGH", "A06-004", "Outdated Next.js version", "package.json", detail=f"Next.js {next_spec} is below version 13", owasp="A06:2021", asvs="V14.2.1", cwe="CWE-1104", fix="Upgrade Next.js"))
    for config in configs:
        text = read_source(config)
        if re.search(r"hostname\s*:\s*['\"]\*\*?['\"]", text):
            findings.append(Finding("HIGH", "A10-002", "Wildcard hostname in next/image", display_path(config, root), owasp="A10:2021", asvs="V12.6.1", cwe="CWE-918", fix="Use exact hostnames"))


def run_optional_tools(root: Path, targets: Sequence[Path], findings: list[Finding], passes: list[str]) -> None:
    package = root / "package.json"
    relative_targets = [display_path(path, root) for path in targets]
    npx = shutil.which("npx.cmd") or shutil.which("npx")
    if npx and package.exists():
        eslint = subprocess.run([npx, "--no-install", "eslint", *relative_targets, "--quiet"], cwd=root, capture_output=True, text=True, check=False)
        if eslint.returncode == 0:
            passes.append("ESLint: no errors")
        else:
            findings.append(Finding("INFO", "TOOL-001", "ESLint reported issues", detail="Run ESLint for details", fix="Fix ESLint errors"))
        if (root / "tsconfig.json").exists():
            tsc = subprocess.run([npx, "--no-install", "tsc", "--noEmit"], cwd=root, capture_output=True, text=True, check=False)
            if tsc.returncode == 0:
                passes.append("TypeScript: no type errors")
            else:
                findings.append(Finding("MEDIUM", "TOOL-002", "TypeScript type errors", detail="tsc --noEmit failed", asvs="V14.1.2", cwe="CWE-1126", fix="Fix type errors"))
    npm = shutil.which("npm.cmd") or shutil.which("npm")
    if npm and (root / "package-lock.json").exists():
        try:
            audit = subprocess.run([npm, "audit", "--omit=dev", "--audit-level=high", "--json"], cwd=root, capture_output=True, text=True, check=False, timeout=120)
            payload = json.loads(audit.stdout or "{}")
            vulnerabilities = (payload.get("metadata") or {}).get("vulnerabilities") or {}
            critical = int(vulnerabilities.get("critical", 0))
            high = int(vulnerabilities.get("high", 0))
            if critical:
                findings.append(Finding("CRITICAL", "A06-002", "Critical vulnerabilities in dependencies", "package.json", detail=f"{critical} critical vulnerabilities detected", owasp="A06:2021", asvs="V14.2.1", cwe="CWE-1104", fix="Update affected packages"))
            if high:
                findings.append(Finding("HIGH", "A06-003", "High vulnerabilities in dependencies", "package.json", detail=f"{high} high vulnerabilities detected", owasp="A06:2021", asvs="V14.2.1", cwe="CWE-1104", fix="Update affected packages"))
            if not critical and not high:
                passes.append("npm audit: no high/critical vulnerabilities")
        except (subprocess.TimeoutExpired, json.JSONDecodeError):
            findings.append(Finding("INFO", "TOOL-005", "npm audit could not complete", detail="Dependency audit timed out or returned invalid JSON", fix="Run npm audit manually"))
    for executable, args, identifier, title, severity in (
        ("gitleaks", ["detect", "--no-git", "--source", ".", "--quiet"], "TOOL-003", "Secrets detected by gitleaks", "CRITICAL"),
        ("semgrep", ["--config", "auto", "--error", "--quiet", *relative_targets], "TOOL-004", "Semgrep found issues", "INFO"),
    ):
        command = shutil.which(executable)
        if command:
            result = subprocess.run([command, *args], cwd=root, capture_output=True, text=True, check=False)
            if result.returncode == 0:
                passes.append(f"{executable}: no findings")
            else:
                findings.append(Finding(severity, identifier, title, detail=f"{executable} returned {result.returncode}", fix=f"Review {executable} output"))


def summary(findings: Sequence[Finding], passes: Sequence[str], file_count: int) -> dict[str, int | str]:
    counts = Counter(item.severity for item in findings)
    total = len(findings)
    decision = "NO-GO" if counts["CRITICAL"] or counts["HIGH"] else "CONDITIONAL GO" if counts["MEDIUM"] else "GO"
    return {**{severity.lower(): counts[severity] for severity in SEVERITIES}, "passed": len(passes), "total_findings": total, "files_scanned": file_count, "release_decision": decision}


def markdown_report(targets: Sequence[Path], findings: Sequence[Finding], result: dict[str, int | str]) -> str:
    rows = [
        "# Security Audit Report", "", "## Overview", "",
        f"- **Date**: {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}",
        f"- **Targets**: {', '.join(str(path) for path in targets)}",
        f"- **Files Scanned**: {result['files_scanned']}",
        "- **Standards**: OWASP Top 10 (2021), ASVS v4.0.3, NIST SSDF v1.1, OWASP Secure Headers, MDN Web Security",
        "", "## Executive Summary", "", "| Severity | Count |", "|---|---|",
    ]
    rows.extend(f"| {severity.title()} | {result[severity.lower()]} |" for severity in SEVERITIES)
    rows.extend(["", f"**Release Decision**: **{result['release_decision']}**", "", "## Findings", ""])
    if not findings:
        rows.append("No actionable findings.")
    for finding in findings:
        rows.extend([f"### [{finding.severity}] {finding.id}: {finding.title}", ""])
        if finding.file:
            location = f"{finding.file}:{finding.line}" if finding.line else finding.file
            rows.append(f"- **Location**: `{location}`")
        if finding.detail:
            rows.append(f"- **Detail**: {finding.detail}")
        rows.append(f"- **OWASP**: {finding.owasp} / **ASVS**: {finding.asvs} / **CWE**: {finding.cwe}")
        if finding.fix:
            rows.append(f"- **Fix**: {finding.fix}")
        rows.append("")
    return "\n".join(rows) + "\n"


def print_text(targets: Sequence[Path], findings: Sequence[Finding], passes: Sequence[str], result: dict[str, int | str]) -> None:
    print("Security Audit - OWASP / ASVS / NIST SSDF / MDN")
    print(f"Targets: {' '.join(str(path) for path in targets)}")
    print(f"Files: {result['files_scanned']}\n")
    for finding in findings:
        location = f" {finding.file}:{finding.line}" if finding.file and finding.line else f" {finding.file}" if finding.file else ""
        print(f"[{finding.severity}] {finding.id}: {finding.title}{location}")
        if finding.detail:
            print(f"  {finding.detail}")
        if finding.fix:
            print(f"  Fix: {finding.fix}")
    for item in passes:
        print(f"[PASS] {item}")
    print("\nAudit Summary")
    for severity in SEVERITIES:
        print(f"  {severity.title():8}: {result[severity.lower()]}")
    print(f"  Passed  : {result['passed']}")
    print(f"Release Decision: {result['release_decision']}")


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    root = Path.cwd().resolve()
    targets = resolve_targets(args.paths, root)
    if not targets:
        print("No targets found. Specify a path or run from the project root.", file=sys.stderr)
        return 2
    files = source_files(targets)
    findings: list[Finding] = []
    passes: list[str] = []
    for path in files:
        text = read_source(path)
        add_regex_findings(path, text, root, findings)
        add_context_findings(path, text, root, findings)
    if not args.files_only:
        add_project_findings(root, findings, passes)
        run_optional_tools(root, targets, findings, passes)
    result = summary(findings, passes, len(files))
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(markdown_report(targets, findings, result), encoding="utf-8")
    if args.json_output:
        print(json.dumps({"summary": result, "findings": [asdict(item) for item in findings], "passes": passes}, ensure_ascii=False, indent=2))
    else:
        print_text(targets, findings, passes, result)
        if args.report:
            print(f"Markdown report written to: {args.report}")
    return 1 if result["critical"] or result["high"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
