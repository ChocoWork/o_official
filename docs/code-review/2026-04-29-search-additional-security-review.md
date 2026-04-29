# Code Review: search 追加セキュリティレビュー
**Ready for Production**: No
**Critical Issues**: 0

## 対象

- src/app/search/page.tsx
- src/app/api/search/route.ts
- src/app/api/suggest/route.ts
- src/features/search/components/SearchPageClient.tsx
- src/features/search/services/search.service.ts

## サマリー

- High: 0
- Medium: 2
- Low: 1

既存レビューに未記載の差分として、Referrer 制御不足による検索語漏えい余地、raw error ログの過記録、サジェスト連打時の可用性リスクを確認。

## Priority 2 (Should Fix)

### 1. Referrer 制御不足で検索語が外部送信されうる
- Files: src/app/search/page.tsx, src/features/search/components/SearchPageClient.tsx
- Issue: `/search?q=...` を仕様で保持しているが、検索ページに明示的な `Referrer-Policy` がなく、外部遷移時にクエリ付き URL が `Referer` として送信される余地がある。
- Why this matters: 個人情報入力があった場合に検索語が第三者オリジンへ漏えいするリスクがある（OWASP A01/A05）。
- Suggested fix: `Referrer-Policy: strict-origin-when-cross-origin` または `no-referrer` を適用し、必要に応じメタタグでも補完する。

### 2. 検索例外の raw error ログ出力
- Files: src/app/api/search/route.ts, src/app/api/suggest/route.ts, src/features/search/services/search.service.ts
- Issue: 例外オブジェクトをそのまま `console.error` 出力しており、運用環境によっては検索語や SQL 実行情報がログに残る可能性がある。
- Why this matters: ログ経由の情報露出と監査ノイズ増大を招く（OWASP A09）。
- Suggested fix: 外部ログを最小化した構造化ログに変更し、機微情報をマスク。詳細は内部監査ログへ分離。

## Recommended Changes

### 3. サジェスト API 呼び出しのクライアント側抑制不足
- Files: src/features/search/components/SearchPageClient.tsx
- Issue: 入力ごとに `/api/suggest` を即時呼び出しし、デバウンスと最小入力長がない。
- Why this matters: Bot/自動入力で容易に高頻度トラフィックを誘発し、可用性劣化を起こしやすい（A04: Insecure Design）。
- Suggested fix: 250-400ms デバウンス、2文字以上で発火、同一クエリ再送抑止を実装する。

## Residual Risks

- 既存 Open の `rateLimit` IP 信頼境界と `Cache-Control` 未指定は、引き続き優先度高で追跡が必要。