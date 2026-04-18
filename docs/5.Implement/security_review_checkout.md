# checkout セキュリティレビュー

- 対象仕様: [docs/4_DetailDesign/13_checkout.md](../4_DetailDesign/13_checkout.md), [docs/4_DetailDesign/01_auth_seq.md](../4_DetailDesign/01_auth_seq.md)
- レビュー観点: フロントエンド/PCI、バックエンド/API/Webhook、DB/注文整合 を 3 パスで確認

| ファイル名 | よくない点 | 修正提案 |
|---|---|---|
| [src/app/api/checkout/complete/route.ts](../../src/app/api/checkout/complete/route.ts) | 決済時点の不変スナップショットではなく現在の carts テーブルから注文内容を再構築しており、Stripe の支払額と現在カート総額の照合もない | 決済開始前に checkout draft を保存し、その draft_id を Stripe Session または PaymentIntent にバインドし、complete と webhook はそのスナップショットだけから orders と order_items を作成し、Stripe amount と currency を必ず照合する |
| [src/app/api/checkout/complete/route.ts](../../src/app/api/checkout/complete/route.ts) | 公開 complete API は bank と cod を受け付け、Stripe 確認なしで pending 注文を作成できる | 公開 schema から bank と cod を除外し、オフライン決済が必要なら別ルートに分離して明示的な認可と濫用対策を付ける |
| [src/app/api/checkout/create-session/route.ts](../../src/app/api/checkout/create-session/route.ts) | Cookie に依存する状態変更 API なのに CSRF 検証を通しておらず、クライアント側も X-CSRF-Token を送っていない | checkout の POST ルートに共通 CSRF middleware を適用し、checkout ページの送信は既存の CSRF cookie を使って X-CSRF-Token を送る形に統一する |
| [src/app/api/checkout/postal-code/route.ts](../../src/app/api/checkout/postal-code/route.ts) | create-session、payment-intent、complete、postal-code を含む公開 checkout API にレート制限がなく、Stripe object 作成と郵便番号外部 API 代理呼び出しを無制限に叩ける | すべての公開 checkout API に IP または session 単位の制限を入れ、postal_code_cache テーブルを使う共有キャッシュへ切り替える |
| [src/app/api/webhook/stripe/route.ts](../../src/app/api/webhook/stripe/route.ts) | 決済セッション作成、注文確定、Webhook 検証失敗、重複イベント無視が console 出力止まりで、支払い系の監査証跡が残らない | checkout 開始、注文確定成功と失敗、Webhook 署名失敗、duplicate skip、異常系 complete 呼び出しを構造化 audit_logs へ記録する |