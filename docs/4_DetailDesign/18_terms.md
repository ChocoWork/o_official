# 1.18 特定商取引法ページ（TERMS）詳細設計

## 機能要件対応表

| 要件ID | 要件内容 | 実装ID | 実装対象ファイル | 実装概要 | 実装ステータス |
|--------|----------|--------|----------------|----------|--------------|
| FR-TERMS-001 | `/terms` ページは利用規約の全文を見出し・本文構成で表示し会員登録・注文・支払方法・配送・返品条件・免責事項等を掲載する | IMPL-TERMS-001 | `src/app/terms/page.tsx` | RSC として `h1 "Terms of Service"` + セクション構成で利用規約全文を表示。会員登録・支払方法・返品条件等を含む | 済 |
| FR-TERMS-002 | `generateMetadata` を実装しページタイトル・OGP を設定する | IMPL-TERMS-002 | `src/app/terms/page.tsx` | `generateMetadata` を実装し、title / description / Open Graph を設定 | 済 |

---

## TODO（TERMS-01）

- [x] FR-TERMS-001: Playwright 試験 `e2e/FR-TERMS-001-terms-content.spec.ts` を追加する
- [x] FR-TERMS-002: `generateMetadata` を実装し、Playwright 試験 `e2e/FR-TERMS-002-metadata.spec.ts` を追加する
- [x] TERMS-SEC-01: Playwright 試験 `e2e/FR-TERMS-003-security-headers.spec.ts` を追加し、`/terms` のセキュリティヘッダー回帰を検知する

## 修正計画（実装前）

1. `src/app/terms/page.tsx` に `generateMetadata` を追加し、利用規約ページ固有の title / description / Open Graph を返す
2. 詳細設計の FR-TERMS-001 文言を現在の実装と上位仕様に合わせて「利用規約ページ」へ同期する
3. E2E は本文表示と metadata を別ファイルに分けて回帰確認する
