# actions セキュリティレビュー

- 対象仕様: news 関連詳細設計 [docs/4_DetailDesign/02_news_list.md](../4_DetailDesign/02_news_list.md), [docs/4_DetailDesign/03_news_detail.md](../4_DetailDesign/03_news_detail.md)
- 主対象: [src/app/actions/news.ts](../../src/app/actions/news.ts)
- レビュー観点: フロントエンド連携、サーバアクション/API、DB/RLS を 3 パスで確認

| ファイル名 | よくない点 | 修正提案 | ステータス | 優先度 |
|---|---|---|---|---|
| [src/lib/supabase/server.ts](../../src/lib/supabase/server.ts) | Cookie ヘッダー先頭や token 関連 Cookie の raw / decoded 値をサーバログへ出力しており、セッション秘密がログ経由で露出する | 認証情報の値は一切ログしない。必要なら有無・件数・ request id など非機密情報だけを構造化ログに残す | Fixed | High |
| [src/app/api/admin/news/route.ts](../../src/app/api/admin/news/route.ts) | news_articles の読み書きに service role クライアントを使っており、RLS 防御を DB 層で効かせていない | news_articles の SELECT / INSERT / UPDATE / DELETE は request スコープの認証済みクライアントへ切り替え、service role は storage upload など本当に必要な用途に限定する | Fixed | High |
| [src/app/api/admin/news/[id]/route.ts](../../src/app/api/admin/news/%5Bid%5D/route.ts) | News の更新・公開切替・削除でも service role 依存で DB 側の最終防衛線が弱い | request-scoped client か security definer RPC に寄せ、DB 側でも権限制御を強制する | Fixed | High |
| [src/app/api/admin/news/route.ts](../../src/app/api/admin/news/route.ts) | News の作成・更新・公開切替・削除で監査ログが記録されない | [src/lib/audit.ts](../../src/lib/audit.ts) を使い、成功・失敗の双方で actor_id、action、resource、resource_id、outcome を記録する | Fixed | High |
| [src/app/api/news/route.ts](../../src/app/api/news/route.ts) | 公開 API の limit に上限がなく、任意に大きい値で大量取得を誘発できる | limit を固定上限で clamp し、必要ならページネーションへ切り替える | Fixed | High |

---

## 追加レビュー追記（2026-04-29）

### サマリー

- High: 0件
- Medium: 2件
- Low: 2件

### セキュリティレビュー結果

| ファイル名 | よくない点 | 修正提案 | ステータス | 調査結果 | 優先度 |
|---|---|---|---|---|---|
| [src/features/news/services/public.ts](../../src/features/news/services/public.ts), [src/app/news/page.tsx](../../src/app/news/page.tsx) | サービス層で limit 上限が強制されず、呼び出し条件次第で大量取得余地がある | サービス層で clamp し、安全なデフォルト上限を固定する | Open | 一覧呼び出しで未指定時全件に近づく余地を確認 | Medium |
| [src/features/news/services/public.ts](../../src/features/news/services/public.ts) | 公開系で service role 初期化を常時伴い、最小権限の境界が曖昧 | 署名専用境界へ分離し、公開読取と権限を分離する | Open | 直近侵害は未確認だが設計上のリスク | Medium |
| [src/app/actions/news.ts](../../src/app/actions/news.ts) | 未使用 Server Action が残り、監視/テスト対象から漏れやすい | 未使用なら削除、残すなら用途とテストを明示する | Open | 参照箇所なしを確認 | Low |
| [src/features/news/services/public.ts](../../src/features/news/services/public.ts) | category/id 入力の明示スキーマ検証が薄い | Zod 等で許可値検証を追加する | Open | 直接注入兆候はないが多層防御不足 | Low |

### 重点観点ごとの結論

1. actions 由来の新規 High は未検出。
2. 可用性と最小権限（Medium）が中心課題。
3. 未使用コード整理は運用安全性向上に有効。

### 推奨対応順序

1. limit 上限のサービス層固定（Medium）
2. service role 境界の分離（Medium）
3. 未使用 action の整理（Low）
4. 入力スキーマの追加（Low）
