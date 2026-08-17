# Cross-Platform Security Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bash専用のセキュリティ監査をPython本体と薄いOS別ラッパーへ移植する。

**Architecture:** Python標準ライブラリでファイル探索、正規表現検査、外部ツール連携、各出力形式を実装する。BashとPowerShellはPythonランタイムの検出と引数転送だけを担当する。

**Tech Stack:** Python 3、PowerShell、Bash、unittest

## Global Constraints

- 外部Pythonパッケージを追加しない。
- 既存CLIオプションと終了コードを維持する。
- `.claude` と `.codex` の監査スキルを同じ内容に保つ。
- 既存の未コミットアプリケーション変更へ触れない。

---

### Task 1: CLI契約テスト

**Files:**

- Create: `.codex/skills/security-check/tests/test_audit.py`

**Interfaces:**

- Consumes: `audit.py [--files-only] [--json] [--report FILE] [paths...]`
- Produces: 終了コード、JSON、Markdownレポート

- [ ] 脆弱なfixtureがHigh findingと終了コード1を返すテストを書く。
- [ ] 安全なfixtureが終了コード0を返すテストを書く。
- [ ] JSONとMarkdown出力を検証するテストを書く。
- [ ] `python -m unittest` を実行し、Python本体未実装で失敗することを確認する。

### Task 2: Python監査本体

**Files:**

- Create: `.codex/skills/security-check/scripts/audit.py`
- Create: `.claude/skills/security-check/scripts/audit.py` as a compatibility entry point delegating to the canonical implementation

**Interfaces:**

- Consumes: CLI引数とTypeScript/JavaScriptソース
- Produces: `Finding`一覧、集計、text/JSON/Markdown出力

- [ ] argparseで既存オプションを実装する。
- [ ] pathlibとreで既存OWASP検査を移植する。
- [ ] subprocessで任意の外部検査を実装する。
- [ ] `.claude` 側へ同一内容を反映する。
- [ ] unittestを実行して成功を確認する。

### Task 3: OS別ラッパーとスキル説明

**Files:**

- Modify: `.codex/skills/security-check/scripts/audit.sh`
- Modify: `.claude/skills/security-check/scripts/audit.sh`
- Create: `.codex/skills/security-check/scripts/audit.ps1`
- Create: `.claude/skills/security-check/scripts/audit.ps1`
- Modify: `.codex/skills/security-check/SKILL.md`
- Modify: `.claude/skills/security-check/SKILL.md`

**Interfaces:**

- Consumes: ラッパーに渡された全引数
- Produces: Python監査と同じ標準出力・終了コード

- [ ] Bashで `python3`、`python`、`py -3` の順に検出する。
- [ ] PowerShellで `py -3`、`python` の順に検出する。
- [ ] SKILL.mdへOS別コマンドを記載する。
- [ ] PowerShellラッパーと直接Python実行の結果を比較する。

### Task 4: 最終検証

**Files:**

- Test: `.codex/skills/security-check/tests/test_audit.py`

**Interfaces:**

- Consumes: 完成した監査スクリプト
- Produces: 再現可能な検証結果

- [ ] unittestを全件実行する。
- [ ] 実プロジェクトの変更対象へ `--files-only` 監査を実行する。
- [ ] `git diff --check` を実行する。
- [ ] skill validatorを実行する。
