# o_official

このリポジトリは Next.js によるアプリケーションです。以下は開発、Supabase クライアントの配置、及び Vercel デプロイ時の注意点です。

はじめに（ローカル開発）

まず開発サーバーを起動します:

```bash
npm run dev
```

ブラウザで <http://localhost:3000> を開き、`app/page.tsx` を編集すると自動リロードされます。

Supabase クライアントの配置

- サーバー側初期化: `src/lib/supabase/server.ts` をサーバールートや Server Components で使用してください。サーバー専用のためブラウザにバンドルされません。
- クライアント側初期化: `src/lib/supabase/client.ts` をクライアントコンポーネントで使用してください。ブラウザでは `NEXT_PUBLIC_SUPABASE_URL` と `NEXT_PUBLIC_SUPABASE_ANON_KEY` のみ利用します。

必須の環境変数（例）:

- `NEXT_PUBLIC_SUPABASE_URL`（公開可）
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`（公開可）
- `SUPABASE_SERVICE_ROLE_KEY`（サーバー専用・秘密）

運用時の SUPABASE_SERVICE_ROLE_KEY の取り扱い

- **絶対にクライアントに露出させないこと**。`SUPABASE_SERVICE_ROLE_KEY` は最小限のアクセス権限を持つサービスアカウントではなく強力なキーのため、Secrets Manager や Vercel の環境変数で保護してください。
- **リリース時のチェック項目**:
  - Service role キーが環境変数に設定されていること（Vercel の Project Settings → Environment Variables）。
  - デプロイ前にキーが漏洩していないか確認し、疑いがある場合は即時ローテーションしてデプロイし直すこと。
  - キーのローテーション手順（発見時の対応）を運用ドキュメントに明記すること。

## Vercel にデプロイする際の具体的アクション（チェックリスト）

1. Vercel ダッシュボードの該当プロジェクト → `Settings` → `Environment Variables` に環境変数を登録:
   - `NEXT_PUBLIC_SUPABASE_URL` = `https://<project>.supabase.co`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY` = `<anon key>`
   - `SUPABASE_SERVICE_ROLE_KEY` = `<service role key>`（Value をプロダクションにのみ設定、Preview/Development 環境は別キーまたは未設定にする）

2. `SUPABASE_SERVICE_ROLE_KEY` は `Plaintext` 表示を避け、Vercel の Secrets 機能を使用して安全に保管する。
3. `Redirect URLs` や `Site URL` を Supabase 側で正しく設定し、`redirect_to` に関するオープンリダイレクト対策（ホワイトリスト）をサーバー側で実施する。
4. デプロイ後、ステージングでメールリンク E2E（メール受信 → リンククリック → 自動ログイン → Header が `ri-user-fill` に変わる）を確認する。

追加の注意点

- プレビュー環境では匿名キーとサービスキーの取り扱いに注意する（サービスキーをプレビューで共有しない）。
- 環境変数のローテーション手順と、万が一の漏洩時の対応手順（キー無効化、再発行、デプロイ）はリリース運用フローに含めてください。

参考ドキュメント: <https://supabase.com/docs/guides/auth/> と <https://vercel.com/docs>

## 未入金注文の掃除ジョブ（pg_cron）のセットアップ

**ローカル開発では不要。Vercel に本番デプロイするときに一度だけ行う。**

### これは何か

コンビニ払い・銀行振込のような時間差決済では、注文が成立してから入金までに数日空く。その間、在庫は確保済みとして引かれている。入金されないまま期限切れになった注文は、誰かが「失敗」にして在庫を戻さないと、売れていない商品の在庫が減ったままになる。

大半は Stripe からの webhook で処理されるが、通知が届かなかった取りこぼしが残る。それを毎時0分に照合し直すのが、このジョブ。支払いの前に注文を作る受付 API（グループ F）が入った後は、決済画面を開いてから30分を超えてまだ開いている決済をここで失効させ、放棄された決済の在庫は Webhook が届かなくても最長90分で戻る。今は注文を支払いの後に作るので、放棄された決済は在庫を押さえない。

```text
毎時0分
  Supabase の pg_cron
    → POST https://<本番ドメイン>/api/cron/expire-pending-orders
        Authorization: Bearer <CRON_SECRET>
      → 開いてから30分を超えた支払い手続き中の注文と入金待ちの注文を Stripe の現在値と照合し、注文と在庫を合わせる
```

この URL は誰でも叩けてしまうため、合言葉（`CRON_SECRET`）で認証する。cron 側は Supabase Vault に置いた値を送り、アプリ側は環境変数の値と照合する。**両方に同じ値を入れる必要がある**。ズレていると毎回 401 を返すだけのジョブになり、しかも 401 は監査ログを書く前に返るので、失敗に気づけない。

### 手順

- [ ] **1. 合言葉を生成する**

  ```bash
  node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
  ```

  出力を手元に控える。以降の 2 と 3 で同じ値を使う。

- [ ] **2. Vercel の環境変数に登録する**

  `Settings` → `Environment Variables`、対象は Production のみ。

  | 変数名 | 値 |
  |---|---|
  | `CRON_SECRET` | 手順1の文字列 |
  | `SHOP_ALERT_EMAIL` | 支払いの要対応（注文を作れない支払い・支払額の違いなど）を知らせる店のアドレス。未設定なら送らず、毎時の見回りが送り直す |

- [ ] **3. Supabase Vault に同じ値を登録する**

  Supabase ダッシュボード → SQL Editor で実行する。`<>` を置き換えること。

  ```sql
  select vault.create_secret('<手順1の文字列>', 'cron_secret');
  select vault.create_secret('https://<本番ドメイン>', 'app_base_url');
  ```

  `app_base_url` の**末尾にスラッシュを付けない**（マイグレーション側が `/api/cron/expire-pending-orders` を連結する）。

- [ ] **4. Stripe の webhook 購読イベントを確認する**

  Stripe ダッシュボード → 開発者 → Webhook → 本番エンドポイント。`src/lib/stripe/webhook-processor.ts` が処理する次の全イベントを購読する。

  | イベント | 用途 |
  | --- | --- |
  | `checkout.session.completed` | Checkout Session の現在値を照合し、注文・決済状態へ反映する |
  | `checkout.session.async_payment_succeeded` | 時間差決済の現在値を照合し、注文・決済状態へ反映する |
  | `checkout.session.async_payment_failed` | 時間差決済の現在値を照合し、注文・在庫へ反映する |
  | `checkout.session.expired` | 期限切れ Session を照合し、注文・在庫へ反映する |
  | `payment_intent.succeeded` | PaymentIntent を照合し、注文・決済状態と会計記録へ反映する |
  | `payment_intent.payment_failed` | PaymentIntent の現在値を照合し、注文・在庫へ反映する |
  | `refund.created` | 返金を注文へ反映し、返金の会計記録を同期する。注文が無い場合は監査に残し、失敗・取消なら要対応にして店へ知らせる |
  | `refund.updated` | 返金状態を注文へ反映し、返金の会計記録を同期する。注文が無い失敗・取消は要対応にして店へ知らせる |
  | `refund.failed` | 失敗返金を注文へ反映し、返金の会計記録を同期する。注文が無ければ要対応にして店へ知らせる |
  | `charge.refunded` | Charge の返金を注文へ反映する。注文が無い場合は監査に残して処理を続ける |
  | `payout.paid` | Stripe の Payout を会計記録へ同期する |
  | `payout.failed` | Payout の失敗を会計記録へ同期する |
  | `payout.reconciliation_completed` | Payout の照合結果を会計記録へ同期する |

  決済系6イベントが漏れると照合と注文・在庫の更新が遅れる。返金系が漏れると注文の返金状態・会計記録が更新されず、注文の無い失敗・取消返金も店へ通知されない。payout系が漏れると会計記録が更新されない。

- [ ] **5. マイグレーションを適用する（アプリのデプロイより先に）**

  保留中の `supabase/pending/schedule_expire_pending_orders.sql` を、新しい version で `supabase/migrations/` へ移して適用する（手順は [supabase/pending/README.md](supabase/pending/README.md)）。`pg_net` 拡張の作成と cron ジョブの登録を行う。

  手順3が済んでいないと、冒頭のガードが例外を投げて適用が中断する。これは意図した動作（合言葉なしでジョブを登録させないための歯止め）なので、エラーが出たら手順3に戻る。

  適用順は常に「マイグレーション → アプリのデプロイ」。逆にすると、照合関数が呼ぶ RPC（`place_order_from_checkout_draft` など）が無い状態で決済系の webhook イベントが届き、worker で失敗して再試行が続く（入金の反映と在庫の戻しが止まる）。

- [ ] **6. 登録を確認する**

  ```sql
  select jobname, schedule, active from cron.job where jobname = 'expire-pending-orders';
  ```

### ローカル DB（Supabase CLI）

```bash
npm run db:start   # ローカル Supabase を起動
npm run db:reset   # supabase/migrations を最初から適用し直す
```

未入金注文の掃除ジョブは `supabase/pending/` に保留しているため、`db:reset` では登録されない。ローカルで掃除ジョブまで動かしたい場合だけ、ローカル専用の値を登録してから `supabase/pending/schedule_expire_pending_orders.sql` をローカル DB に流す（本番の値は入れない）。秘密が無くても登録自体は通るが、揃うまでは実行のたびに失敗し（`cron.job_run_details` に理由が残る）、認証ヘッダの無い要求は送られない（FREQ-368）。

```sql
select vault.create_secret('local-dev-cron-secret', 'cron_secret');
select vault.create_secret('http://localhost:3000', 'app_base_url');
```

```bash
npx supabase migration list --local   # ファイルと DB の適用状況を確認
```

DB 結合テスト（`tests/integration/db/*.integration.test.ts`）は `DATABASE_URL` を渡したときだけ動く。試験用の注文や auth ユーザーを作るため、localhost 以外の接続先では動かないようにしてある。PostgREST を通す `reconciler_postgrest.integration.test.ts`・`refund_failure_exception_postgrest.integration.test.ts`・`reconciler_composed.integration.test.ts` は、ローカル Supabase の API URL とサービスロールキー（`LOCAL_SUPABASE_URL`・`LOCAL_SUPABASE_SERVICE_ROLE_KEY`）も必要とする。渡さない場合は、この3ファイルがエラーを出さずにスキップされる。ファイルどうしが同じローカル DB を共有するので、ディレクトリ全体を流すときは `--runInBand` を付ける。

`public.orders` に列を追加したら、同じ変更で公開列には `GRANT SELECT`、店内列は非公開の登録を行い、`tests/integration/db/order_internal_columns.integration.test.ts` を実行する。この DB 結合テストは CI で自動実行しないため、列の判断を実装へ反映するまで失敗する。

```bash
eval "$(npx supabase status -o env | grep -E '^(API_URL|SERVICE_ROLE_KEY)=')"
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
LOCAL_SUPABASE_URL="$API_URL" LOCAL_SUPABASE_SERVICE_ROLE_KEY="$SERVICE_ROLE_KEY" \
  npx jest tests/integration/db --runInBand
```

### 適用済みのマイグレーション（本番 DB）

`supabase/migrations/` のファイルと本番の台帳（`supabase_migrations.schema_migrations`）は、2026-09-21 時点で28本すべて version まで一致している（FREQ-380）。ベースライン以降の本は次のとおり。

| ファイル | 内容 |
|---|---|
| `20260901120426_lock_down_guest_cart_rpc.sql` | ゲストカートの RPC を anon から外す |
| `20260911235714_add_checkout_drafts_retention_job.sql` | 未完了 draft を30日で削除する日次ジョブ |
| `20260913005807_add_release_stock_for_failed_order.sql` | 未入金注文の在庫を戻す RPC |
| `20260913005917_fix_finalize_order_stock_decrement.sql` | 在庫減算を item_id で合算する（同一商品が複数明細のときの引き漏らし修正） |
| `20260913132105_fix_rate_limit_counters_subject_counting.sql` | 回数制限の数え方を直す（FREQ-360） |
| `20260913132437_add_rate_limit_counters_retention_job.sql` | 回数制限の記録を2時間で削除する毎時ジョブ |
| `20260914140221_revoke_redundant_pg_cron_self_grants.sql` | pg_cron の自己付与を取り消す（`create extension` の失敗を解消） |
| `20260916003746_recheck_finalize_order_after_draft_lock.sql` | 並行した注文確定で、後発が先発の注文を返すようにする（FREQ-363） |
| `20260916034433_lock_items_in_id_order.sql` | 注文確定と在庫復元の商品行ロックを id の昇順に揃える（FREQ-364） |
| `20260916042338_add_checkout_draft_shipping_revision.sql` | 配送先スナップショットの版番号を追加し、古い書き込みで上書きされないようにする（FREQ-365） |
| `20260919065336`〜`20260919065518`（6本） | サイズ×カラーのバリアント在庫の土台（表・追記専用の在庫台帳・検算関数・既存商品からの生成・注文明細のバリアント参照と受注区分・受注数の集計） |
| `20260919130048_harden_variant_trigger_functions_and_fk_indexes.sql` | 上の6本で出た Supabase advisor の指摘を直す。トリガー関数3つの `search_path` を空に固定し、外部キー3本に索引を足す（FREQ-381） |
| `20260919141000_fix_rls_initplan_and_permissive_policies.sql` | Supabase advisor の性能 WARN 2種を直す。RLS 15本の `auth.uid()` / `current_setting()` を `(SELECT ...)` で包み、会計3表の FOR ALL の manage を INSERT / UPDATE / DELETE に分ける。見える行・書ける行は変えない（FREQ-382） |
| `20260919233113_restrict_release_stock_next_status.sql` | 未入金注文の在庫を戻す RPC の遷移先を `failed` / `cancelled` に限る。ほかの値と NULL は行ロックの前に `INVALID_NEXT_STATUS`（22023）で止める（FREQ-383） |
| `20260920001357_add_order_shipping_kana.sql` | 注文にフリガナの列を足す。注文確定が配送先の写しの `kanaName` を書き、法定の変更禁止の対象に加える（FREQ-384） |
| `20260920064241_add_order_email_claims.sql` | 注文メールの送信権（`private.order_emails` と `claim_order_email` / `release_order_email`）。同じ注文・同じ種類で送れる経路を1つに絞る（FREQ-386） |
| `20260920070833_reject_missing_item_on_finalize.sql` | 商品が引けないときの注文確定を `ITEM_NOT_PUBLISHED` で止める。削除済み商品で公開判定を素通りし、外部キー違反で落ちていた（FREQ-387） |
| `20260921011455_add_checkout_draft_discount_amount.sql` | `checkout_drafts` に `discount_amount` を足し、注文確定が下書きの値引額を注文へ引き写す。無いと割引付きの注文がすべて `CHECKOUT_TOTAL_MISMATCH` で落ちる（FREQ-389） |
| `20260921011535_harden_security_definer_search_path.sql` | SECURITY DEFINER 関数20本の `search_path` の末尾に `pg_temp` を足し、`anon` から `has_permission` の実行権限を外す（FREQ-390） |
| `20260921035818_wire_variant_stock_on_order.sql` | 注文明細に `variant_id` と引当区分を記録し、在庫で賄える分だけ在庫台帳（`stock_movements`）で引き当てる。在庫が無い組み合わせは受注生産として受ける（FREQ-398） |
| `20260921121038_retire_item_stock_quantity.sql` | `items.stock_quantity` を削除し、これを読んでいた関数6本（カート追加・数量変更2種・注文確定・在庫戻し・バリアント生成）から商品単位の在庫判定を外す（FREQ-401） |
| `20260921133624_fix_guest_rpc_item_id_type.sql` | ゲスト用 RPC 5本の `item_id` を bigint にそろえる。`carts` / `wishlist` の列は bigint で、`integer` の宣言のまま行を返すと 42804 で落ちていた（FREQ-403） |

- 保留中: 未入金注文の掃除ジョブは本番の公開時に入れる。`supabase/pending/` に置いている（[supabase/pending/README.md](supabase/pending/README.md)）
- 在庫の単位は色 × サイズ（`item_variants`）。在庫は在庫台帳（`stock_movements`）への追記でだけ動く。商品単位の `items.stock_quantity` は廃止済み（FREQ-401）。在庫の有無は「買えるか」ではなく「納期」を分ける（在庫なしは受注生産。FREQ-400）（設計: [docs/superpowers/specs/2026-09-06-variant-inventory-and-cart-ownership-design.md](docs/superpowers/specs/2026-09-06-variant-inventory-and-cart-ownership-design.md)）

### 注意: 本番のマイグレーション台帳と揃え続ける

- MCP の `apply_migration` で当てると、当てた時刻が version として台帳に記録される。**当てた後、ファイル名をその version に直す。** 直さないと `db push` が「台帳にある version がローカルに無い」で止まる
- 本番の最新より古い日付の未適用ファイルを `supabase/migrations/` に置かない。`db push` は止まる。**`--include-all` で押し通さない**（適用順が崩れ、適用済みの SQL が二重に流れることがある）
- まだ本番に入れないマイグレーションは `supabase/pending/` に置く
- 確認: `npx supabase migration list`（ローカルとリモートが1対1で並ぶこと）と `npx supabase db push --dry-run`（適用対象なし）

## Turnstile の導入 (bot対策)

- [ ] Cloudflare ダッシュボードで Turnstile サイトを登録
- [ ] Vercel の env に 以下を設定する
  - [ ] NEXT_PUBLIC_TURNSTILE_SITE_KEY を設定する
  - [ ] TURNSTILE_SECRET_KEY を設定する

