# NIST SP 800-218 SSDF v1.1 マッピング

Secure Software Development Framework — 28 のプラクティスを 4 グループに整理。

## PO: Prepare the Organization

| プラクティス | 内容 | 検査観点 |
|---|---|---|
| PO.1 | セキュリティ要件の定義 | プロジェクトに脅威モデル/要件文書あり |
| PO.2 | 役割と責任 | セキュリティ責任者の指名 |
| PO.3 | サポートツール整備 | SAST/DAST/SCA ツール導入 |
| PO.4 | セキュリティ基準定義 | コーディング規約・レビュー基準 |
| PO.5 | セキュアな開発環境 | Dev環境の認証/最小権限 |

## PS: Protect the Software

| プラクティス | 内容 | 検査観点 |
|---|---|---|
| PS.1 | コード改ざん保護 | Git リポジトリ保護、保護ブランチ |
| PS.2 | 完全性検証メカニズム | リリース成果物の署名・ハッシュ |
| PS.3 | ソフトウェア保管 | アーティファクトレジストリの認証 |

## PW: Produce Well-Secured Software

| プラクティス | 内容 | 検査観点 |
|---|---|---|
| PW.1 | セキュリティ要件への適合設計 | 設計レビュー記録 |
| PW.2 | サードパーティ評価 | 依存関係の評価記録 |
| PW.3 | 再利用可能なセキュアコード | 共通ライブラリの利用 |
| PW.4 | セキュアコーディング標準 | ESLint security plugin、規約遵守 |
| PW.5 | リスクベースのレビュー | コードレビュープロセス |
| PW.6 | コンパイラ・ビルド設定 | strict mode、警告解消 |
| PW.7 | コードレビュー/分析 | SAST 実行、PR レビュー |
| PW.8 | テスト | セキュリティテスト含む |
| PW.9 | デフォルト設定のセキュア化 | Secure by default |

## RV: Respond to Vulnerabilities

| プラクティス | 内容 | 検査観点 |
|---|---|---|
| RV.1 | 脆弱性の継続検知 | 依存関係スキャン、SECURITY.md |
| RV.2 | 脆弱性の評価・優先順位付け | CVSS 評価プロセス |
| RV.3 | 根本原因分析 | ポストモーテム実施 |

## CI/CD パイプラインへの組み込み例

```yaml
# .github/workflows/security.yml
name: Security Audit
on: [push, pull_request]
jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - name: SCA - npm audit
        run: npm audit --production --audit-level=high
      - name: SAST - Semgrep
        uses: semgrep/semgrep-action@v1
      - name: Secret Scan - Gitleaks
        uses: gitleaks/gitleaks-action@v2
      - name: Custom Audit
        run: bash .claude/skills/security-check/scripts/audit.sh
      - name: License Check
        run: npx license-checker --production --failOn 'GPL'
```