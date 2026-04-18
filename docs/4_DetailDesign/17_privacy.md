# 1.17 プライバシーポリシーページ（PRIVACY）詳細設計

## 機能要件対応表

| 要件ID | 要件内容 | 実装ID | 実装対象ファイル | 実装概要 | 実装ステータス |
|--------|----------|--------|----------------|----------|--------------|
| FR-PRIVACY-001 | `/privacy` ページはプライバシーポリシーの全文を見出し・本文構成で表示し個人情報の取り扱い・利用目的・第三者提供・お問い合わせを掲載する | IMPL-PRIVACY-001 | `src/app/privacy/page.tsx` | RSC として `h1` + セクション構成でプライバシーポリシー全文を表示。個人情報取扱い・利用目的・第三者提供・お問い合わせセクション含む | 済 |
| FR-PRIVACY-002 | `generateMetadata` を実装しページタイトル・OGP を設定する | IMPL-PRIVACY-002 | `src/app/privacy/page.tsx` | `generateMetadata` を実装し、title / description / Open Graph を設定 | 済 |

---

## TODO（PRIVACY-01）

- [x] FR-PRIVACY-001: Playwright 試験 `e2e/FR-PRIVACY-001-policy-content.spec.ts` を追加する
- [x] FR-PRIVACY-002: `generateMetadata` を実装し、Playwright 試験 `e2e/FR-PRIVACY-002-metadata.spec.ts` を追加する

## 修正計画（実装前）

1. `src/app/privacy/page.tsx` は RSC のまま維持し、同ファイルに `generateMetadata` を追加する
2. E2E は本文表示と metadata を要件単位で分離し、表示崩れとメタ情報欠落を個別検知できるようにする
