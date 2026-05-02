# cart セキュリティレビュー

- 対象仕様: [docs/4_DetailDesign/12_cart.md](../4_DetailDesign/12_cart.md)
- レビュー観点: フロントエンド状態管理、バックエンド/API、DB/在庫整合 を 3 パスで確認
- 確認対象実装: [src/app/cart/page.tsx](../../src/app/cart/page.tsx), [src/app/api/cart/route.ts](../../src/app/api/cart/route.ts), [src/app/api/cart/[id]/route.ts](../../src/app/api/cart/%5Bid%5D/route.ts), [src/proxy.ts](../../src/proxy.ts), [src/contexts/CartContext.tsx](../../src/contexts/CartContext.tsx), [migrations/020_create_cart_table.sql](../../migrations/020_create_cart_table.sql)

| ファイル名 | よくない点 | 修正提案 | ステータス | 優先度 |
|---|---|---|---|---|
| [src/app/api/checkout/complete/route.ts](../../src/app/api/checkout/complete/route.ts) | checkoutSessionId ベースの注文確定において、Stripe Checkout Session を現行 cart session と正しく結び付ける必要がある | complete で cookie の session_id、Stripe metadata、amount、currency、payment_status / status の一致を必須検証し、Checkout Session に基づく注文確定を行う | Fixed | High |
| [src/app/api/cart/route.ts](../../src/app/api/cart/route.ts) | 数量の上限と在庫整合の検証が不十分で、在庫超過や同時購入での oversell を防げない | cart POST/PATCH と checkout 開始/完了時に同一 `item_id` 合算で quantity <= stock_quantity を検証し、注文確定と在庫減算は `finalize_order_from_cart` RPC で原子的に実行する | Fixed | High |
| [src/app/api/cart/[id]/route.ts](../../src/app/api/cart/%5Bid%5D/route.ts) | 公開 cart API が service role で carts テーブルを操作しており、DB の RLS が実運用経路で効いていない | request-scoped client で `update_cart_item_quantity_secure` / `delete_cart_item_secure` RPC を呼び出す形へ変更し、session_id 検証を DB 関数側へ集約した | Fixed | High |
| [src/proxy.ts](../../src/proxy.ts) | cookie ベースの state-changing API に対して、数量上限、レート制限、Origin/Referer 追加検証が不足している | cart の Zod スキーマに数量上限を追加し、cart 変更 API で session_id + IP レート制限を適用。加えて `proxy.ts` で state-changing API への Origin/Referer 同一オリジン検証を追加した | Fixed | High |
| [src/app/api/cart/route.ts](../../src/app/api/cart/route.ts) | item の存在確認と取得で items.status='published' を見ておらず、非公開商品でも item_id を知っていれば cart に追加し、商品名・価格・画像 URL を service role 経由で取得できる | cart API と checkout 開始時の item 参照に `published` 条件を必須化し、非公開商品は明示的にエラー化する | Fixed | Medium |
| [src/app/api/cart/route.ts](../../src/app/api/cart/route.ts), [src/app/api/cart/[id]/route.ts](../../src/app/api/cart/%5Bid%5D/route.ts) | リクエストボディを Zod 等で厳密検証しておらず、quantity に小数や極端に大きい値、color/size に無制限長の文字列を通せるため、DB エラー誘発や不要なデータ肥大化の余地がある | `addCartItemSchema` / `updateCartQuantitySchema` を強化し、quantity 上限と color/size の許容文字・長さ制限を統一適用した | Fixed | Medium |
| [src/app/api/cart/route.ts](../../src/app/api/cart/route.ts), [src/app/api/cart/[id]/route.ts](../../src/app/api/cart/%5Bid%5D/route.ts) | cart の追加・更新・削除に構造化 audit log がなく、session_id ベースの濫用や大量更新の調査が困難 | cart add/update/delete の主要分岐で `logAudit` を呼び出し、session_id・item_id・quantity・結果・IP・user-agent を `audit_logs` に記録するようにした | Fixed | Medium |
| [src/app/cart/page.tsx](../../src/app/cart/page.tsx) | 数量更新は楽観的 UI だが失敗時のロールバックがなく、画面上の数量とサーバ状態が乖離したまま checkout に進める | 楽観更新時の確定値トラッキングを導入し、PATCH 失敗時は即ロールバック。加えて「再試行」「最新状態を再取得」UI を追加してサーバ状態へ再同期できるようにした | Fixed | Low |
| [src/app/api/cart/[id]/route.ts](../../src/app/api/cart/%5Bid%5D/route.ts) | 存在しない id や他 session の id に対する PATCH が 404/403 ではなく 500 扱いになり、運用上の異常検知と攻撃判定がしづらい | RPC エラーマッピングを補強し、`CART_ITEM_NOT_FOUND` は 404、permission denied は 403、不正 UUID は 400 を返却するようにした | Fixed | Low |

---

## 追加レビュー追記（2026-04-29）

### サマリー

- High: 1件
- Medium: 3件
- Low: 2件

### セキュリティレビュー結果

| ファイル名 | よくない点 | 修正提案 | ステータス | 調査結果 | 優先度 |
|---|---|---|---|---|---|
| [src/features/auth/middleware/rateLimit.ts](../../src/features/auth/middleware/rateLimit.ts), [src/app/api/cart/route.ts](../../src/app/api/cart/route.ts), [src/app/api/cart/[id]/route.ts](../../src/app/api/cart/%5Bid%5D/route.ts) | IP 識別が forwarded ヘッダ依存で、環境次第ではレート制限回避余地がある | trusted proxy 条件を明示し、session 主体制限を主軸化する | Open | cart 系でも同論点が横断残存 | High |
| [src/app/api/cart/route.ts](../../src/app/api/cart/route.ts) | セッション依存 GET の Cache-Control 明示が不足 | `private, no-store` を付与する | Open | キャッシュ挙動が環境依存 | Medium |
| [src/app/api/cart/route.ts](../../src/app/api/cart/route.ts), [src/app/api/cart/[id]/route.ts](../../src/app/api/cart/%5Bid%5D/route.ts) | 在庫不足応答で実在庫数を返し、推定可能性がある | 公開 API は段階化メッセージへ変更し、実数は内部限定 | Open | availableQuantity 露出を確認 | Medium |
| [src/app/api/cart/route.ts](../../src/app/api/cart/route.ts) | service role 直操作が残り、最終防衛の設計一貫性を弱める | request client + secure RPC に寄せる | Open | 一部経路で直操作余地を確認 | Medium |
| [src/app/api/cart/route.ts](../../src/app/api/cart/route.ts) | 署名失敗時の URL フォールバックが情報露出面になる | プレースホルダへフォールバックし、生 URL を返さない | Open | 直ちに高リスクではないが改善余地 | Low |
| [src/proxy.ts](../../src/proxy.ts) | forwarded ヘッダ由来 origin 判定の前提が環境依存 | 信頼境界を明文化し、未信頼時の採用を制限 | Open | インフラ依存のため要確認 | Low |

### 重点観点ごとの結論

1. cart の最優先はレート制限識別子の信頼境界。
2. 在庫情報最小化とキャッシュ明示で情報露出面を縮小可能。
3. 低優先度は運用前提の明文化で事故確率を下げられる。

### 推奨対応順序

1. IP 信頼境界修正（High）
2. 在庫実数の非返却化（Medium）
3. GET /api/cart の no-store 明示（Medium）
4. 残り Medium/Low を順次解消
