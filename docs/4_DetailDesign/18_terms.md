# 1.18 特定商取引法ページ（TERMS）詳細設計

## 機能要件対応表

| 要件ID | 要件内容 | 実装ID | 実装対象ファイル | 実装概要 | 実装ステータス |
|--------|----------|--------|----------------|----------|--------------|
| FR-TERMS-001 | `/terms` ページは特定商取引法に基づく表記を見出し・本文構成で表示し販売事業者・代表者・所在地・電話番号・販売価格・支払方法・返品条件等を掲載する | IMPL-TERMS-001 | `src/app/terms/page.tsx` | RSC として `h1 "Terms of Service"` + セクション構成で特定商取引法全文を表示。販売事業者・支払方法・返品条件等を含む | 済 |
| FR-TERMS-002 | `generateMetadata` を実装しページタイトル・OGP を設定する | IMPL-TERMS-002 | `src/app/terms/page.tsx` | `generateMetadata` の export なし。`<title>` + OGP 未設定 | 未 |
