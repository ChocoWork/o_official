---
name: implement-stripe
description: Use this skill when the user asks to work with Stripe — including payment integration, Checkout/Payment Intents/Subscriptions/Connect/Invoicing, webhook handling, API debugging, or referencing Stripe documentation. Trigger on explicit mentions of "Stripe", "stripe-cli", "pk_test_/sk_test_/whsec_" prefixes, or Stripe-specific objects (customer, charge, invoice, subscription, price, product). Do NOT trigger for generic "payment" questions without Stripe context.
license: MIT
allowed-tools:
  - mcp__stripe__*
  - Read
  - Write
  - Edit
  - Bash
---

# Implement Stripe Skill

## 1. 起動時チェックリスト

このSkillが起動したら、**必ず最初に**以下を順に確認する。

1. ユーザーの意図が「ドキュメント参照」か「API実行（リソース変更）」かを判別する
2. 環境が **テストモード（`sk_test_*`）** か **本番モード（`sk_live_*`）** かを確認する
3. 本番モードでの**書き込み系操作**（`POST`/`DELETE`/状態遷移）は、必ずユーザーに**英語で要約した実行計画**を提示し、明示的な承認を得る
4. シークレットキーをチャット出力・コードコメント・ログに**絶対に書かない**

## 2. 利用するMCPツール

Stripe MCP server が提供する代表的ツール（実環境のツール名は `mcp__stripe__*` で列挙されたものを優先使用）:

- `search_documentation` — Stripe公式ドキュメントの検索（**最優先で参照**）
- `list_customers` / `create_customer` / `update_customer`
- `list_products` / `create_product`
- `list_prices` / `create_price`
- `create_payment_link`
- `list_invoices` / `create_invoice` / `finalize_invoice`
- `list_subscriptions` / `cancel_subscription`
- `list_disputes`
- `retrieve_balance`

> ツール名がMCPサーバーのバージョンで異なる場合は、まず `ListMcpResourcesTool` で実際のツール一覧を取得し、その名前空間に追従する。

## 3. 標準ワークフロー

### A. 「やり方を知りたい」系の質問

1. `search_documentation` でユーザーの質問キーワードを検索
2. 上位3件のドキュメントから根拠を引用
3. 最小実装サンプル（Node/Python/cURLのいずれか、ユーザーの文脈に合わせる）を提示
4. **テストカードと検証手順**を必ず添える（例: `4242 4242 4242 4242`、3DSは `4000 0027 6000 3184`）

### B. 「実装して」系の依頼

1. 既存コードベースを `Read` で確認しスタックを特定
2. `references/api_conventions.md` のチェックリストを適用
3. 以下を**必ず**含める:
   - **Idempotency-Key**（書き込みAPI全て、UUID v4推奨）
   - **APIバージョン固定**（`Stripe-Version` ヘッダ or SDK初期化時）
   - **Webhook署名検証**（`scripts/verify_webhook.py` パターン参照）
   - **エラーハンドリング**（`StripeError` のサブクラス別 retry/no-retry 判定）
4. シークレットは環境変数（`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`）からのみ読み込むコードを生成

### C. 「データを操作して」系（MCP経由実行）

1. **必ずテストモード**で実行（live keyは拒否、ユーザーが明示的に live を指定しても再確認）
2. 実行前: 対象リソース・パラメータ・期待結果を箇条書きで提示し承認を得る
3. 実行後: 戻り値の `id` と主要フィールドのみ要約。秘密情報を含むレスポンスは伏せる
4. 失敗時は `code` / `decline_code` / `request_log_url` を提示して原因切り分け

## 4. Webhook 実装の必須要件

`scripts/verify_webhook.py` を雛形として使用し、以下を満たすこと。

- 署名検証は **SDKの `construct_event` を使用**（自前HMAC実装禁止）
- タイムスタンプ許容差は**5分以内**
- `event.id` を**Supabase等のDB**に保存し、重複処理を防ぐ（at-least-once配信前提）
- 処理は**2xxを5秒以内**に返却。重い処理はキューに退避
- 失敗時は **5xx**（4xxを返すと自動リトライされない）

## 5. 危険操作リスト（実行前に二重確認）

- `subscription.cancel`（即時 vs 期間末）
- `invoice.void` / `refund.create`
- `customer.delete`（PIIの完全削除）
- `payout.create`
- `account.delete`（Connect）
- 本番モードでの`price`の`active=false`化（チェックアウト失敗の連鎖を起こす）

## 6. 参照ファイル

- `references/api_conventions.md` — APIバージョニング、冪等性、ページング、リトライ戦略
- `references/webhook_events.md` — 主要イベントタイプと処理パターン
- `references/testing_guide.md` — テストカード、Clock、CLI fixtures

## 7. 出力フォーマット

- コード提示時はファイル名コメントを1行目に付与
- 環境変数は `.env.example` を別途生成
- API呼び出し例には**期待される成功レスポンスの抜粋**を併記