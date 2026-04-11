# 1.17 プライバシーポリシーページ（PRIVACY）詳細設計

## 機能要件対応表

| 要件ID | 要件内容 | 実装ID | 実装対象ファイル | 実装概要 | 実装ステータス |
|--------|----------|--------|----------------|----------|--------------|
| FR-PRIVACY-001 | `/privacy` ページはプライバシーポリシーの全文を見出し・本文構成で表示し個人情報の取り扱い・利用目的・第三者提供・お問い合わせを掲載する | IMPL-PRIVACY-001 | `src/app/privacy/page.tsx` | RSC として `h1` + セクション構成でプライバシーポリシー全文を表示。個人情報取扱い・利用目的・第三者提供・お問い合わせセクション含む | 済 |
| FR-PRIVACY-002 | `generateMetadata` を実装しページタイトル・OGP を設定する | IMPL-PRIVACY-002 | `src/app/privacy/page.tsx` | `generateMetadata` の export なし。`<title>` + OGP 未設定 | 未 |
