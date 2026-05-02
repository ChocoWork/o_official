# wishlist セキュリティレビュー

- 対象仕様: [docs/4_DetailDesign/11_wishlist.md](../4_DetailDesign/11_wishlist.md)
- レビュー対象: `src/app/wishlist/**`, `src/app/api/wishlist/**`, 関連する auth/cart/items/migrations
- 実施日: 2026-04-29
- レビュー基準: Secure Coding / OWASP Top 10（A01, A03, A05 を重点）

---

## ステータス凡例

| ステータス | 意味 |
|---|---|
| Open | 未修正 |
| Partially Fixed | 一部レイヤのみ対処済み |
| Fixed | 修正済み |
| N/A | 現時点で問題なし |

---

## サマリー

- **High: 1件（Open）**
- **Medium: 3件（Open）**
- **Low: 3件（Open）**
- **Fixed/N/A: 8件**

重点確認した `private item 混入 / CSRF / レート制限 / RLS / セッション境界 / キャッシュ / 入力検証` のうち、`private item 混入`、`RLS`、`session_id 境界`、`入力検証` は概ね対処されています。一方で、**レート制限のIP信頼境界**、**wishlist mutation のCSRF防御不整合**、**セッション依存レスポンスのキャッシュ制御不足** は未対処です。

---

## セキュリティレビュー結果

| ファイル名 | よくない点 | 修正提案 | ステータス | 調査結果 | 優先度 |
|---|---|---|---|---|---|
| [src/features/auth/middleware/rateLimit.ts](../../src/features/auth/middleware/rateLimit.ts) | `x-forwarded-for` / `x-real-ip` を無条件信頼しており、ヘッダ偽装可能な経路では IP ベース制限を回避できる | 信頼プロキシ経由時のみ forwarded ヘッダを採用し、それ以外はプラットフォーム提供の接続元IPに限定する。あわせて subject 前提の制限を主にし、IP 制限は補助に下げる | Open | wishlist の `GET/POST/DELETE` は `enforceRateLimit` を共通利用。識別子信頼境界の欠陥が横断で波及 | High |
| [src/app/api/wishlist/route.ts](../../src/app/api/wishlist/route.ts) | `POST /api/wishlist` が CSRF 検証を行わず、認証セッション保有時に checkout/profile と防御レベルが不一致 | `requireCsrfOrDeny()` を mutation 開始前に適用し、必要に応じ `x-csrf-token` を必須化する。少なくとも認証済みユーザー経路は同等ポリシーに統一する | Open | checkout は CSRF middleware を適用済みだが wishlist mutation は未適用。対策の一貫性欠如 | Medium |
| [src/app/api/wishlist/[id]/route.ts](../../src/app/api/wishlist/%5Bid%5D/route.ts) | `DELETE /api/wishlist/[id]` も CSRF 検証未適用で、状態変更APIのガードが統一されていない | `POST` と同様に CSRF middleware を適用し、403 を明確化する | Open | UUID 検証・rate limit はあるが CSRF だけ抜けている | Medium |
| [src/app/api/wishlist/route.ts](../../src/app/api/wishlist/route.ts) | セッション依存の `GET /api/wishlist` 応答に `Cache-Control` 明示がない | `Cache-Control: private, no-store` を付与し、中間キャッシュによる誤配信を回避する | Open | wishlist はセッション単位データ。現状はヘッダ未指定でプロキシ挙動依存 | Medium |
| [src/app/wishlist/client.tsx](../../src/app/wishlist/client.tsx) | mutation 呼び出しに `clientFetch` を使わず、将来サーバ側で CSRF必須化した際にヘッダ付与漏れが起こりやすい | `fetch` を `clientFetch` に統一し `x-csrf-token` 自動付与へ寄せる | Open | 現時点では動作するが、防御強化時の運用事故余地が残る | Low |
| [src/app/api/wishlist/route.ts](../../src/app/api/wishlist/route.ts) | `getClientIp()` を API 内で重複実装しており、信頼境界修正時の更新漏れリスクがある | IP 抽出は共通化し、全APIで同じ信頼判定ロジックを使う | Open | wishlist / cart / 他APIで類似実装が散在 | Low |
| [src/lib/storage/item-images.ts](../../src/lib/storage/item-images.ts) | 署名URLのデフォルト有効期限が7日と長く、漏えい時の再利用期間が長い | 要件に合わせて短縮（例: 数分〜数時間）し、必要なら都度再署名で補う | Open | 機密データではないが private bucket 運用との整合で短命化が望ましい | Low |
| [src/app/api/wishlist/route.ts](../../src/app/api/wishlist/route.ts) | private item 混入 | `items` 参照時の `status = 'published'` 条件を維持 | Fixed | `POST` は追加前に `published` を検証、`GET` も `published` のみ join し未公開は結果から除外 | High |
| [src/app/api/cart/route.ts](../../src/app/api/cart/route.ts) | wishlist から cart へ遷移時の private item 混入 | `POST /api/cart` の `status='published'` 検証維持 | Fixed | wishlist からの「カートに追加」でも cart 側で公開状態を再検証 | High |
| [migrations/021_create_wishlist_table.sql](../../migrations/021_create_wishlist_table.sql) | wishlist RLS | `auth.uid()` + `current_setting('app.session_id', true)` 条件を維持 | Fixed | SELECT/INSERT/DELETE すべてで user/session 境界を強制 | High |
| [migrations/049_set_wishlist_session_context_pre_request.sql](../../migrations/049_set_wishlist_session_context_pre_request.sql) | `app.session_id` コンテキスト供給 | pre-request フックを維持し、運用で無効化しない | Fixed | `x-session-id` / cookie から `app.session_id` を設定し、RLS評価に接続 | High |
| [src/lib/supabase/server.ts](../../src/lib/supabase/server.ts) | request scoped client + `x-session-id` 連携 | wishlist 系では request scoped client 継続 | Fixed | API request から session を抽出しヘッダ注入。RLS境界を維持 | Medium |
| [src/features/auth/services/register.ts](../../src/features/auth/services/register.ts) | セッション境界（ログイン時ローテーション） | `session_id` rotate を維持 | Fixed | 認証確立時に `session_id` を再発行 | Medium |
| [src/app/api/auth/logout/route.ts](../../src/app/api/auth/logout/route.ts) | セッション境界（ログアウト時消去） | `session_id` clear を維持 | Fixed | logout で `session_id` を明示的に削除 | Medium |
| [src/app/api/wishlist/[id]/route.ts](../../src/app/api/wishlist/%5Bid%5D/route.ts) | 入力検証 | UUID 検証を維持 | Fixed | `wishlistIdSchema = z.string().uuid()` で fail-fast | Medium |
| [src/app/api/wishlist/route.ts](../../src/app/api/wishlist/route.ts) | 入力検証 | `item_id` の Zod 検証を維持 | Fixed | `z.coerce.number().int().positive()` で不正入力拒否 | Medium |

---

## 重点観点ごとの結論

1. private item 混入: **概ね防止できている（Fixed）**
2. CSRF: **wishlist mutation で防御の一貫性不足（Open）**
3. レート制限: **機構はあるが IP 識別子の信頼境界に課題（Open）**
4. RLS: **wishlist テーブルは session/user 境界で有効（Fixed）**
5. セッション境界: **login rotate + logout clear で改善済み（Fixed）**
6. キャッシュ: **session 依存レスポンスに no-store 明示が不足（Open）**
7. 入力検証: **POST/DELETE は妥当（Fixed）**

---

## 推奨対応順序

1. `rateLimit` の IP 信頼境界修正（High）
2. wishlist mutation (`POST`/`DELETE`) へ CSRF middleware 適用（Medium）
3. `GET /api/wishlist` に `Cache-Control: private, no-store` 明示（Medium）
4. wishlist クライアントを `clientFetch` 統一（Low）
5. 署名URL TTL と IP 抽出ロジックの共通化（Low）

---

## 追加レビュー追記（2026-04-29）

### サマリー

- High: 0件
- Medium: 1件（Open）
- Low: 2件（Open）
- 既存レビューとの差分: 可用性観点（A04）と監査観点（A09）を追加

### 追加指摘一覧

| ファイル名 | よくない点 | 修正提案 | ステータス | 優先度 |
|---|---|---|---|---|
| [src/app/api/wishlist/route.ts](../../src/app/api/wishlist/route.ts#L107) | wishlist 件数上限がなく、`GET` で全件に対して `signItemImageUrl` を `Promise.all` 実行しているため、1セッション内の大量登録で署名処理を増幅できる（A04: Insecure Design、可用性リスク） | 1セッションあたり wishlist 上限（例: 100件）を導入し、`GET` はページング/件数制限を適用する。署名生成は上限付き並列化（p-limit等）でスパイクを抑制する | Open | Medium |
| [src/app/api/wishlist/route.ts](../../src/app/api/wishlist/route.ts#L172) | `POST /api/wishlist` の rate limit 超過時は即 return しており、`GET` と異なり監査ログが残らない。攻撃検知の粒度が不均一（A09: Security Logging and Monitoring Failures） | `rateLimitByIp` / `rateLimitBySession` 分岐でも `logAudit` を記録し、endpoint・subject・しきい値をメタデータ化する | Open | Low |
| [src/app/api/wishlist/[id]/route.ts](../../src/app/api/wishlist/%5Bid%5D/route.ts#L52) | `DELETE /api/wishlist/[id]` の rate limit 超過時も監査ログが残らず、mutation系の異常トラフィック追跡が弱い（A09: Security Logging and Monitoring Failures） | `POST` と同様に rate limit 発火時の監査ログを追加し、wishlist mutation で同一運用基準に統一する | Open | Low |

### 重点結論

1. 既存の High 指摘（IP 信頼境界、CSRF、キャッシュ制御）は依然として優先対応が必要。
2. 追加観点では、wishlist の大量登録と画像署名の組み合わせが可用性上の主要リスク。
3. 監査ログは `GET` に比べ `POST`/`DELETE` が弱く、検知品質の均一化が必要。

### 推奨対応順序

1. wishlist 件数上限 + GET ページング + 署名処理の並列上限制御（Medium）
2. `POST /api/wishlist` の rate limit 発火時監査ログ追加（Low）
3. `DELETE /api/wishlist/[id]` の rate limit 発火時監査ログ追加（Low）