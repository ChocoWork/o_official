# actions セキュリティレビュー

- 対象仕様: news 関連詳細設計 [docs/4_DetailDesign/02_news_list.md](../4_DetailDesign/02_news_list.md), [docs/4_DetailDesign/03_news_detail.md](../4_DetailDesign/03_news_detail.md)
- 主対象: [src/app/actions/news.ts](../../src/app/actions/news.ts)
- レビュー観点: フロントエンド連携、サーバアクション/API、DB/RLS を 3 パスで確認

| ファイル名 | よくない点 | 修正提案 |
|---|---|---|
| [src/lib/supabase/server.ts](../../src/lib/supabase/server.ts) | Cookie ヘッダー先頭や token 関連 Cookie の raw / decoded 値をサーバログへ出力しており、セッション秘密がログ経由で露出する | 認証情報の値は一切ログしない。必要なら有無・件数・ request id など非機密情報だけを構造化ログに残す |
| [src/app/api/admin/news/route.ts](../../src/app/api/admin/news/route.ts) | news_articles の読み書きに service role クライアントを使っており、RLS 防御を DB 層で効かせていない | news_articles の SELECT / INSERT / UPDATE / DELETE は request スコープの認証済みクライアントへ切り替え、service role は storage upload など本当に必要な用途に限定する |
| [src/app/api/admin/news/[id]/route.ts](../../src/app/api/admin/news/%5Bid%5D/route.ts) | News の更新・公開切替・削除でも service role 依存で DB 側の最終防衛線が弱い | request-scoped client か security definer RPC に寄せ、DB 側でも権限制御を強制する |
| [src/app/api/admin/news/route.ts](../../src/app/api/admin/news/route.ts) | News の作成・更新・公開切替・削除で監査ログが記録されない | [src/lib/audit.ts](../../src/lib/audit.ts) を使い、成功・失敗の双方で actor_id、action、resource、resource_id、outcome を記録する |
| [src/app/api/news/route.ts](../../src/app/api/news/route.ts) | 公開 API の limit に上限がなく、任意に大きい値で大量取得を誘発できる | limit を固定上限で clamp し、必要ならページネーションへ切り替える |