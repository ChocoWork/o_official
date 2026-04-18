# search セキュリティレビュー

- 対象仕様: [docs/4_DetailDesign/19_search.md](../4_DetailDesign/19_search.md)
- レビュー観点: フロントエンド検索 UI、バックエンド/API、DB/検索インデックス を 3 パスで確認

| ファイル名 | よくない点 | 修正提案 |
|---|---|---|
| [src/lib/supabase/server.ts](../../src/lib/supabase/server.ts) | 検索 API が内部で呼ぶ Supabase サーバークライアント初期化処理で、Cookie ヘッダ先頭や認証 Cookie の生値・デコード値断片をサーバーログに出力している | 認証ヘッダと Cookie 値のログ出力を削除し、必要な診断ログは完全マスク済みのメタ情報だけに限定する |
| [src/features/search/services/search.service.ts](../../src/features/search/services/search.service.ts) | ユーザー入力を PostgREST の .or(...) フィルタ文字列へ直接連結しており、検索条件を改変できる余地がある | 生の .or(...) 文字列組み立てをやめ、RPC/SQL 関数にパラメータとして渡す実装へ変更する |
| [src/app/api/search/route.ts](../../src/app/api/search/route.ts) | 未認証の search / suggest API にレート制限も abuse 監査もなく、スクレイピングや語彙列挙を低コストで継続できる | IP 単位の 429 制御と異常頻度・拒否イベントの監査記録を追加する |
| [src/app/api/suggest/route.ts](../../src/app/api/suggest/route.ts) | 仕様では過長・禁止文字は 400 を求めているが、現状は trim と最大長だけで、制御文字やフィルタ構文記号を拒否していない | q に対して許可文字セット、制御文字拒否、最小長、連続空白制御を含む Zod スキーマを追加し、禁止文字は API 境界で即時 400 にする |