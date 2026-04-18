# cart セキュリティレビュー

- 対象仕様: [docs/4_DetailDesign/12_cart.md](../4_DetailDesign/12_cart.md)
- レビュー観点: フロントエンド状態管理、バックエンド/API、DB/在庫整合 を 3 パスで確認

| ファイル名 | よくない点 | 修正提案 |
|---|---|---|
| [src/app/api/checkout/complete/route.ts](../../src/app/api/checkout/complete/route.ts) | checkoutSessionId から取得した決済を現在の cart と十分に結び付けておらず、別決済の流用で現在の cart を paid 扱いにできる余地がある | Checkout Session と PaymentIntent の両方に session_id を保持し、complete で cookie の session_id、Stripe metadata、amount、currency の一致を必須検証する |
| [src/app/api/cart/route.ts](../../src/app/api/cart/route.ts) | 数量の上限と在庫整合の検証が不十分で、在庫超過や同時購入での oversell を防げない | cart POST/PATCH と checkout 開始/完了時に quantity <= stock_quantity を必須検証し、注文確定と在庫減算を DB トランザクションまたは RPC で原子的に実行する |
| [src/app/api/cart/[id]/route.ts](../../src/app/api/cart/%5Bid%5D/route.ts) | 公開 cart API が service role で carts テーブルを操作しており、DB の RLS が実運用経路で効いていない | guest 向け cart CRUD では service role を使わず、RLS が効く request-scoped client か session_id を検証する security definer RPC に寄せる |
| [src/proxy.ts](../../src/proxy.ts) | cookie ベースの state-changing API に対して、数量上限、レート制限、Origin/Referer 追加検証が不足している | Zod で item_id・quantity・color・size を厳密検証し、数量上限を設け、session_id と IP 単位のレート制限を追加する |