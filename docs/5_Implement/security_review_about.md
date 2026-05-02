# about セキュリティレビュー

- 対象仕様: [docs/4_DetailDesign/08_about.md](../4_DetailDesign/08_about.md)
- レビュー観点: フロントエンド、バックエンド/API、DB/RLS を 3 パスで確認

| ファイル名 | よくない点 | 修正提案 | ステータス | 優先度 |
|---|---|---|---|---|
| [src/lib/supabase/server.ts](../../src/lib/supabase/server.ts) | Cookie ヘッダ先頭、認証系 Cookie 名、デコード後のトークン断片などを server log に出力しており、認証情報の情報露出になる | 認証トークンや Cookie 値のログ出力を削除し、必要なら件数や有無だけの非機微な構造化ログに置き換える | Closed | High |
| [src/app/api/auth/identify/route.ts](../../src/app/api/auth/identify/route.ts) | 未認証のリクエストで service role の admin.createUser を実行し、email_confirm: true で任意メールアドレスの確認済みユーザーを作成している | 事前の confirmed user 作成をやめ、メール所有権の検証完了後にのみ確認済み状態にする。OTP サインインまたは通常の sign-up フローに寄せる | Closed | High |
| [src/features/auth/middleware/rateLimit.ts](../../src/features/auth/middleware/rateLimit.ts) | レート制限の DB エラー時に fail-open でリクエストを通しており、認証導線の abuse 防止が無効化される | 認証系エンドポイントでは fail-closed に変更するか、少なくとも代替のメモリ/エッジレート制限を入れて防御を維持する | Closed | High |
| [src/features/auth/ratelimit/index.ts](../../src/features/auth/ratelimit/index.ts) | rate_limit_counters の更新が select → update/insert の非原子的実装で、同時実行時にカウントの取りこぼしが起き、実効レート制限を回避できる | 単一 SQL の upsert か DB 関数で原子的に加算する実装へ変更する | Closed | High |

> ※2026-04-19 時点レビュー: `src/lib/supabase/server.ts` のログ出力問題はコードを確認したところ該当箇所が存在しなかったため `Closed` と判断しました。`src/app/api/auth/identify/route.ts` の `email_confirm: true` は依然として確認済みです。`src/features/auth/middleware/rateLimit.ts` の fail-open は修正済みで `Closed` に変更しました。`src/features/auth/ratelimit/index.ts` の非原子的カウント更新は本対応で DB 関数に置き換え、`Closed` に更新しました。

---

## 追加レビュー追記（2026-04-29）

### サマリー

- High: 0件
- Medium: 1件
- Low: 3件

### セキュリティレビュー結果

| ファイル名 | よくない点 | 修正提案 | ステータス | 調査結果 | 優先度 |
|---|---|---|---|---|---|
| [src/app/api/auth/identify/route.ts](../../src/app/api/auth/identify/route.ts) | レート制限呼び出しを囲う例外処理で fail-open 化する余地が残る | 認証系 API は rate limit 障害時も fail-closed を徹底する | Open | レート制限本体は fail-closed 化済みだが、呼び出し側の例外処理次第で防御が弱まる可能性を確認 | Medium |
| [src/proxy.ts](../../src/proxy.ts) | CSP の許可オリジンが広く、about ページに不要な外部依存が含まれる | ページ特性に合わせて許可オリジンを最小化し、不要な CDN を削減する | Open | 直近の侵害兆候は未確認だが、A05 観点のハードニング余地として確認 | Low |
| [src/components/Header.tsx](../../src/components/Header.tsx) | `/ui` 導線が本番導線に残ると内部情報露出面になる | 本番で不要ならナビゲーションから除外またはアクセス制御を追加する | Open | 本番公開意図は要確認 | Low |
| [src/lib/turnstile.ts](../../src/lib/turnstile.ts) | エラー詳細が運用ログに残りやすく、情報最小化観点で余地がある | 外部可視ログは定型エラーコード化し、詳細は保護ログへ分離する | Open | 外部応答は抽象化されているが、内部ログ最適化余地あり | Low |

### 重点観点ごとの結論

1. about 本体は静的表示中心で重大な新規脆弱性は未検出。
2. 認証周辺のレート制限一貫性は継続監視が必要。
3. CSP 最小権限化と公開導線整理は運用リスク低減に有効。

### 推奨対応順序

1. `identify` の fail-open 余地を解消（Medium）
2. `proxy.ts` の CSP 許可範囲を縮小（Low）
3. `/ui` 導線の本番方針を確定（Low）
4. turnstile エラーログを最小化（Low）
