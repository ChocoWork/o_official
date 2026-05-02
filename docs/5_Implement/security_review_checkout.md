# checkout セキュリティレビュー

- 対象仕様: [docs/4_DetailDesign/13_checkout.md](../4_DetailDesign/13_checkout.md), [docs/4_DetailDesign/01_auth_seq.md](../4_DetailDesign/01_auth_seq.md)
- レビュー観点: Secure Coding と OWASP Top 10 の観点で、フロントエンド、API、Webhook、DB、テストを横断確認
- 確認対象実装: [src/app/checkout/page.tsx](../../src/app/checkout/page.tsx), [src/app/api/checkout/create-session/route.ts](../../src/app/api/checkout/create-session/route.ts), [src/app/api/checkout/complete/route.ts](../../src/app/api/checkout/complete/route.ts), [src/app/api/checkout/postal-code/route.ts](../../src/app/api/checkout/postal-code/route.ts), [src/app/api/webhook/stripe/route.ts](../../src/app/api/webhook/stripe/route.ts), [src/features/checkout/services/checkout-draft.service.ts](../../src/features/checkout/services/checkout-draft.service.ts), [src/features/checkout/services/checkout-pricing.service.ts](../../src/features/checkout/services/checkout-pricing.service.ts), [src/features/checkout/services/postal-code.service.ts](../../src/features/checkout/services/postal-code.service.ts), [src/lib/csrfMiddleware.ts](../../src/lib/csrfMiddleware.ts), [src/lib/client-fetch.ts](../../src/lib/client-fetch.ts), [src/lib/audit.ts](../../src/lib/audit.ts), [migrations/024_create_postal_code_cache.sql](../../migrations/024_create_postal_code_cache.sql), [migrations/040_create_checkout_drafts.sql](../../migrations/040_create_checkout_drafts.sql), [migrations/043_harden_finalize_order_from_checkout_draft_published_guard.sql](../../migrations/043_harden_finalize_order_from_checkout_draft_published_guard.sql), [e2e/FR-CHECKOUT-002-pci-compliance.spec.ts](../../e2e/FR-CHECKOUT-002-pci-compliance.spec.ts), [e2e/FR-CHECKOUT-007-inventory-check.spec.ts](../../e2e/FR-CHECKOUT-007-inventory-check.spec.ts), [e2e/FR-CHECKOUT-009-webhook-idempotency.spec.ts](../../e2e/FR-CHECKOUT-009-webhook-idempotency.spec.ts)

---

## ステータス凡例

|ステータス|意味|
|---|---|
| Open | 未修正 |
| Partially Fixed | 一部層のみ対処済み |
| Fixed | 修正済み |

---

## セキュリティレビュー結果

| ファイル名 | よくない点 | 修正提案 | ステータス | 調査結果 | 優先度 |
|---|---|---|---|---|---|
| [src/app/api/checkout/create-session/route.ts](../../src/app/api/checkout/create-session/route.ts), [src/app/api/checkout/complete/route.ts](../../src/app/api/checkout/complete/route.ts), [src/app/api/webhook/stripe/route.ts](../../src/app/api/webhook/stripe/route.ts), [migrations/040_create_checkout_drafts.sql](../../migrations/040_create_checkout_drafts.sql) | 金額整合性が崩れると過少請求または過大請求のリスクがある | checkout draft と Stripe 金額と DB 最終確定額を三重照合する | Fixed | create-session で displayedAmounts とサーバ計算を照合し、complete と webhook は draft total と Stripe amount と currency を RPC で照合していることを確認 | High |
| [src/app/api/checkout/create-session/route.ts](../../src/app/api/checkout/create-session/route.ts), [src/app/api/checkout/complete/route.ts](../../src/app/api/checkout/complete/route.ts), [src/app/checkout/page.tsx](../../src/app/checkout/page.tsx), [src/lib/csrfMiddleware.ts](../../src/lib/csrfMiddleware.ts) | create-session は CSRF 防御済みだが complete には CSRF 検証がなく、Cookie 依存更新 API として防御の一貫性が不足 | complete にも requireCsrfOrDeny を適用し、checkout 側の complete 呼び出しを clientFetch に統一する | Partially Fixed | create-session は x-csrf-token 検証あり。complete は CSRF ヘッダ未送信かつサーバ検証未実装で部分対応止まり | High |
| [src/app/checkout/page.tsx](../../src/app/checkout/page.tsx), [e2e/FR-CHECKOUT-002-pci-compliance.spec.ts](../../e2e/FR-CHECKOUT-002-pci-compliance.spec.ts) | PCI 境界は Stripe Elements で満たしているが、E2E が iframe 件数 0 でも通るため回帰検知が弱い | iframe 存在を 1 以上で厳格確認し、カード情報を自サーバに送らない API 契約テストを追加する | Open | 実装自体は PaymentElement 使用で PCI 境界は維持。テストは paymentIframes >= 0 のため実質アサートになっていない | Medium |
| [src/app/api/webhook/stripe/route.ts](../../src/app/api/webhook/stripe/route.ts) | Webhook 署名検証はあるが、イベント永続化 insert が失敗しても処理続行するため並行時の重複処理抑止が弱い | stripe_webhook_events への挿入失敗時は fail-close で 500 を返すか、DB 側一意制約エラー時のみ duplicate 扱いに分岐する | Partially Fixed | stripe.webhooks.constructEvent による署名検証は実装済み。重複確認は pre-check と insert の二段だが persistError 後も switch 続行する | High |
| [src/app/api/checkout/create-session/route.ts](../../src/app/api/checkout/create-session/route.ts), [migrations/043_harden_finalize_order_from_checkout_draft_published_guard.sql](../../migrations/043_harden_finalize_order_from_checkout_draft_published_guard.sql) | private item 混入時の防御が不足すると非公開商品が決済対象になる | API と DB の両層で published ガードを維持し、不一致時は明示エラーで停止する | Fixed | create-session で items.status = published を条件化し、DB 関数でも ITEM_NOT_PUBLISHED を送出する実装を確認 | High |
| [src/app/api/checkout/create-session/route.ts](../../src/app/api/checkout/create-session/route.ts), [migrations/040_create_checkout_drafts.sql](../../migrations/040_create_checkout_drafts.sql), [e2e/FR-CHECKOUT-007-inventory-check.spec.ts](../../e2e/FR-CHECKOUT-007-inventory-check.spec.ts) | 在庫整合性が崩れると oversell が発生する | API 事前チェックと DB 行ロックでの最終在庫検証を継続し、409 応答を UI で明示する | Fixed | create-session の在庫検証と finalize RPC の FOR UPDATE + INSUFFICIENT_STOCK を確認。E2E でも 409 表示導線を確認 | High |
| [src/app/api/checkout/create-session/route.ts](../../src/app/api/checkout/create-session/route.ts), [src/app/api/checkout/complete/route.ts](../../src/app/api/checkout/complete/route.ts), [src/app/api/checkout/postal-code/route.ts](../../src/app/api/checkout/postal-code/route.ts), [src/app/api/checkout/payment-intent/route.ts](../../src/app/api/checkout/payment-intent/route.ts) | checkout 公開 API が無制限だと総当たりや外部 API 悪用の踏み台になる | endpoint ごとに IP と session 単位の制限を維持し、閾値超過の監査を追加する | Fixed | create-session、complete、postal-code、deprecated payment-intent に enforceRateLimit を確認 | Medium |
| [src/features/checkout/services/postal-code.service.ts](../../src/features/checkout/services/postal-code.service.ts), [migrations/024_create_postal_code_cache.sql](../../migrations/024_create_postal_code_cache.sql) | 郵便番号キャッシュは個人識別性が低いが、保持期間や削除方針が未定義だとデータ管理リスクが残る | postal_code_cache の保持期間と削除ジョブを定義し、更新日時ベースで定期削除する | Open | DB キャッシュとメモリキャッシュの二層化は実装済み。TTL は読み取り判定のみで、古い行の物理削除は未実装 | Low |
| [src/app/api/webhook/stripe/route.ts](../../src/app/api/webhook/stripe/route.ts), [migrations/025_create_orders.sql](../../migrations/025_create_orders.sql) | stripe_webhook_events.raw_payload に Stripe イベント全体を保存しており、不要な PII の長期保持につながる | raw_payload は最小項目のみ保存し、詳細ペイロードは短期保管か暗号化保管へ変更する | Open | raw_payload にイベントオブジェクト全体を insert していることを確認。保持期間ポリシーは文書化されていない | Medium |
| [src/lib/audit.ts](../../src/lib/audit.ts), [src/app/api/checkout/create-session/route.ts](../../src/app/api/checkout/create-session/route.ts), [src/app/api/checkout/complete/route.ts](../../src/app/api/checkout/complete/route.ts), [src/app/api/webhook/stripe/route.ts](../../src/app/api/webhook/stripe/route.ts) | 監査ログのマスキングがキー名依存で、shipping_email など PII を metadata に入れた場合に自動秘匿されない | metadata 許可キーを allowlist 化し、email phone address 系キーを明示マスクする | Partially Fixed | token card 系のマスクはあるが、PII 一般語への包括マスクは未実装。checkout 監査では現時点で重大漏えいは未確認 | Low |
| [src/app/api/checkout/complete/route.ts](../../src/app/api/checkout/complete/route.ts), [e2e/FR-CHECKOUT-009-webhook-idempotency.spec.ts](../../e2e/FR-CHECKOUT-009-webhook-idempotency.spec.ts) | 冪等性テストが Stripe 署名失敗 400 を確認するだけで、実際の重複イベント処理を検証できていない | Stripe CLI 署名付きイベントで duplicate path を検証する統合テストを追加する | Open | 現行 E2E は両リクエスト 400 を期待しており、冪等ロジック本体の回帰検知には不足 | Low |

---

## 追加レビュー追記（2026-04-29）

### サマリー

- High: 1件
- Medium: 3件
- Low: 1件

### セキュリティレビュー結果

| ファイル名 | よくない点 | 修正提案 | ステータス | 調査結果 | 優先度 |
|---|---|---|---|---|---|
| [src/app/api/webhook/stripe/route.ts](../../src/app/api/webhook/stripe/route.ts) | 決済成功系イベントで必須情報欠落時に fail-open 分岐が残る | 欠落時は再送可能な 5xx か再処理キューへ送る | Open | 一部条件で 200 到達余地を確認 | High |
| [src/app/api/checkout/create-session/route.ts](../../src/app/api/checkout/create-session/route.ts), [src/app/api/checkout/complete/route.ts](../../src/app/api/checkout/complete/route.ts) | `session_id` を Stripe metadata に含め、内部識別子の外部露出面がある | metadata から session_id を除去し、draft_id など最小連携へ寄せる | Open | 現行連携で session_id が外部へ渡る経路を確認 | Medium |
| [src/features/auth/middleware/rateLimit.ts](../../src/features/auth/middleware/rateLimit.ts), [src/app/api/checkout/create-session/route.ts](../../src/app/api/checkout/create-session/route.ts) | checkout の IP 抽出がヘッダ依存で回避余地 | trusted proxy 条件下のみ採用し、多層制限へ | Open | cart と同様の横断課題 | Medium |
| [src/app/api/checkout/create-session/route.ts](../../src/app/api/checkout/create-session/route.ts) | redirect origin を req 由来で組み立てるため、構成不備時に誤誘導リスク | 固定許可オリジン（APP_BASE_URL 等）を使用する | Open | 悪用可否はプロキシ設定依存 | Medium |
| [src/app/api/webhook/stripe/route.ts](../../src/app/api/webhook/stripe/route.ts) | 署名失敗時レスポンスの詳細メッセージが過剰 | 外部向けは固定文言にし、詳細は内部ログへ | Open | 情報最小化余地あり | Low |

### 重点観点ごとの結論

1. checkout 追加レビューの最重要は webhook fail-open。
2. metadata 最小化と origin 固定化で信頼境界を強化できる。
3. 低優先度は情報最小化として早期対応が望ましい。

### 推奨対応順序

1. webhook fail-open 是正（High）
2. metadata から session_id 除去（Medium）
3. IP 信頼境界と redirect origin 固定化（Medium）
4. webhook エラーメッセージ最小化（Low）
