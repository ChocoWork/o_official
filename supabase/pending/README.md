# 保留中のマイグレーション

## 概要

本番へ入れる時期がまだ来ていないマイグレーションを置く。`supabase/migrations/` に置くと、master への push で CI の `supabase db push` が本番へ流してしまうため、ここに分けている。

| ファイル                              | 内容                                                                                                              | 入れる時期                                                                  |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `schedule_expire_pending_orders.sql`  | 照合の見回り（毎時0分に `/api/cron/expire-pending-orders` を呼ぶ pg_cron）。開いてから30分を超えた決済の失効と、Webhook の取りこぼしの照合。FREQ-356 / FREQ-368 / FREQ-407 | 本番アプリ公開・決済手段の確認後。Vault に `cron_secret` と `app_base_url` を登録してから |
| `harden_order_state_transitions.sql`  | `orders`・`order_items`のData API直接更新・作成・削除を閉じ、入金・返金の不変条件と、変更理由の無い状態の変更・設計書 4-1 に無い遷移を拒否するトリガーを追加する第2段階（R-04） | 第1段階と対応アプリを本番確認後に、明示の承認を得て昇格・適用する |
| `harden_checkout_session_claims.sql`  | 既存下書きの要求IDを補完し、`checkout_drafts`への直接INSERTを剥奪する第2段階                                      | 互換段階と対応アプリを本番確認後に昇格・適用する（本依頼で承認済み）        |
| `schedule_stripe_webhook_worker.sql` | Vaultを使いworkerを10秒間隔で起動するpg_cronジョブ | キューRPC・worker・Vaultの稼働確認後、受信ルート公開前に適用する（条件付き承認済み） |

2026-09-25 に互換段階のCheckout・注文RPCとWebhookキューを本番へ適用済みです。SQLは本番の台帳versionで supabase/migrations/ へ移しました。

## 本番へ入れる手順

1. 新しい version でマイグレーションを作り、このファイルの中身を写す（日付は本番の最新より新しくなる）。

   ```bash
   npx supabase migration new schedule_expire_pending_orders
   ```

2. このフォルダのファイルを消し、表から行を外す。
3. master へ push する（CI の `db push` が適用する）。MCP の `apply_migration` で当てた場合は、本番の台帳に記録された version にファイル名を合わせる（[docs/06_Operations/db-migrations.md](../../docs/06_Operations/db-migrations.md)）。

**このフォルダのファイルを、元の日付のまま `supabase/migrations/` に戻さないこと。** 本番の最新より古い日付の未適用ファイルがあると、`db push` は止まる。`--include-all` で押し通すと適用順が崩れる。

## ローカルで試すとき

`npx supabase db reset` ではこのフォルダは流れない。Webhookのローカル動作確認ではキューmigrationを先に適用し、DBから到達できるアプリURLと`cron_secret`をVaultに用意してからworkerジョブを登録する。ジョブを登録しない場合、受信したイベントは`queued`のまま残る。結合テスト`tests/integration/db/stripe_webhook_queue.integration.test.ts`はキューmigrationをローカルDBに適用し、ジョブ登録だけはトランザクションをロールバックして検証する。未入金注文の掃除ジョブは`tests/integration/db/expire_pending_orders_job.integration.test.ts`で検証する。

Webhook受信ルートは`enqueue_stripe_webhook_event`が無ければ5xxになる。キューRPC、worker、Cronジョブを先に準備・確認してから受信ルートを公開する。失敗・滞留は`stripe_webhook_events`の`processing_status`、`attempt_count`、`next_attempt_at`、`last_error`と`cron.job_run_details`、`net._http_response`を確認する。
