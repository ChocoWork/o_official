# Stripe の知らせのキューと定期処理（グループ B・計画2）実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stripe の知らせ（Webhook）を取りこぼさず処理し、止まったら店が気づけるようにする。失敗は倍々の間隔で8回までやり直して退避し、注文の無い支払いは毎時の見回りが拾って要確認の注文にする。定期処理の合言葉をそろえ、開店のときに登録できる形にする。

**Architecture:** キューの状態と知らせの回数の上限は DB の関数（service_role 専用）で持つ。アプリ側は、取り出して処理する worker、点検して店へ知らせる ops、受け取り口の確かめ、見回りの拾い上げに分ける。定期処理は pg_cron＋pg_net＋Vault から POST で呼ばれ、合言葉は1つの確かめ方にそろえる。

**Tech Stack:** Next.js 16 App Router（`after()`）、TypeScript、Supabase（Postgres 17、pg_cron、pg_net、Vault、RLS、SECURITY DEFINER RPC）、Stripe（stripe 20.4.1）、Jest（ts-jest）＋`pg`、Playwright（計画1の手元の Supabase）

**Spec:** [docs/superpowers/specs/2026-10-05-webhook-queue-operations-design.md](../specs/2026-10-05-webhook-queue-operations-design.md)（第3〜6・8・9・10章）

**計画の分け方:** 本計画（計画2）は、計画1（[E2E を手元の Supabase で流す](2026-10-05-e2e-local-supabase.md)）の後に作る。E2E は計画1の手元の Supabase で流す。

## Global Constraints

- やり直し: 失敗した試行の回数を n とすると、次の試行は 2^(n-1) 分後（1・2・4・8・16・32・64・128分）。最初の試行と合わせて9回試し、9回目も失敗したら `dead`（退避）にして取り出さない。担当の期限は5分で、期限の切れた試行も1回の失敗として数える（原因 `lease_expired`）
- 原因の記号は `stripe_unavailable`・`db_unavailable`・`not_converged`・`lease_expired`・`invalid_payload`・`unexpected_error` の6つだけ。例外の文・スタック・個人情報は残さない
- worker は1回の起動で約45秒まで続けて処理する（`TIME_BUDGET_MS = 45_000`、`maxDuration = 60`）
- 店への知らせの宛先は `SHOP_ALERT_EMAIL`（今の要対応のメールと同じ）。種類ごとに1時間に1回まで。溜まりは「受け取ってから15分以上たって完了していない」、見回りの遅れは「最後の成功から2時間」、照合の遅れは「最後の成功から25時間」。一度も成功していない定期処理は遅れの点検の対象にしない。署名不正は「10分に5件以上」。モード違いは「1件でも」。支払いから作った注文は「見回り1回につき1通」。退避は「まとめて1通」。メールにお客様の名前・住所・メールアドレスを入れない
- 受け取り口が保存する知らせは次の13種だけ: `checkout.session.completed`・`checkout.session.async_payment_succeeded`・`checkout.session.async_payment_failed`・`checkout.session.expired`・`payment_intent.succeeded`・`payment_intent.payment_failed`・`refund.created`・`refund.updated`・`refund.failed`・`charge.refunded`・`payout.paid`・`payout.failed`・`payout.reconciliation_completed`
- モードは `STRIPE_SECRET_KEY` の頭で決める（`sk_live_`・`rk_live_` なら本番、`sk_test_`・`rk_test_` ならテスト）
- 要確認の値は `recovered_from_payment`、表示は「支払いから作った注文：お客様へ確認してください」。付けるのは見回りが注文を作ったときだけ。`stock_not_reserved` と重なれば在庫の理由を残す
- 定期処理: worker は毎分（`* * * * *`）、見回りは毎時0分（`0 * * * *`）、照合は毎日 18:00 UTC（`0 18 * * *`）、実行の記録の掃除は毎日 19:00 UTC（`0 19 * * *`）で7日を残す
- `CRON_SECRET` が32文字より短いときは、定期処理の入口を全部断る。照合の入口は POST
- DB: 新しい表は RLS を有効にし、`"deny direct client access"`（制限的な拒否）を置き、`REVOKE ALL ... FROM anon, authenticated, service_role` の後で要る分だけ GRANT する。関数は `SECURITY DEFINER`＋`SET search_path = ''`＋完全修飾名で、`PUBLIC`・`anon`・`authenticated` から EXECUTE を剥がし、`service_role` だけに与える。`private` の補助関数は `REVOKE ALL ... FROM PUBLIC`。cron スキーマへの grant は書かない。移行は `BEGIN;`〜`COMMIT;` で囲み、冪等に書く
- 本番 DB へは、計画の最後（Task 16）に、ユーザーの push の後で許可を得て Supabase MCP で当てる。`supabase/pending/` の SQL は当てない（開店のとき）
- E2E は計画1の手元の Supabase で、本番ビルドで流す。流す前に3000番に何も無いことを確かめる。前後の比べ方は `npm run e2e:compare`
- 画面と機能の変更は、実装と同じタスクで `docs/02_Requirements/requirements.md` に FREQ 行を足す。番号は `grep -oE "FREQ-[0-9]+" docs/02_Requirements/requirements.md | sort -t- -k2 -n | tail -1` の次（本計画の FREQ-415・416 は目安）。E2E の番号も `ls e2e | grep FR-ADMIN- | sort -V | tail -1` などで確かめる
- 実装は Codex（コミットしない）。controller がタスクのファイルだけを名指しでコミットし、レビューは Opus。master に直接コミットし、push しない。コミットメッセージは日本語の Conventional Commits、末尾に `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
- DB 結合テストは、`npx supabase db reset` の後に、フォルダ全体を `--runInBand` で流す（手順は README の「ローカル DB（Supabase CLI）」）

## Review Focus

本計画のタスクのテストで直接は確かめていないが、使う人が最も踏みやすい入力と状態。各行のテストは括弧内のタスクに足してある。

1. **DB が数時間止まった後、たくさんの知らせが同じ頃に退避する**: 店へのメールは1時間に1通で、載せるのは50件までと残りの件数（Task 5 の「退避が60件でも1通、載せるのは50件まで」）
2. **開店前（定期処理を登録していない）に、受け取り口の `after()` だけで worker が動く**: 見回りと照合の遅れの知らせを出さない（Task 5 の「一度も成功していない定期処理は対象にしない」）
3. **見回りの最中に、Webhook が同じ支払いで注文を作る**: 要確認を付けるのは、見回り自身が注文を作ったときだけ（Task 10 の「照合の結果が注文を作っていなければ印を付けない」）
4. **署名の合わない要求が毎秒届く**: DB の行は増えず、店へのメールは1時間に1通（Task 2 の「bump は同じ1行を更新する」と Task 7 の「5件目で1回だけ送る」）
5. **`CRON_SECRET` を短い値（例: 16文字）にしたまま開店する**: 定期処理が全部断られ、ログに設定の誤りが出る（Task 8 の「32文字未満は設定の誤りとして断る」）

---

## File Structure

| ファイル | 責務 |
|---|---|
| `supabase/migrations/20261005100000_webhook_queue_dead_letter.sql`（新規） | キューの受け取った時刻・退避・倍々のやり直し・期限切れの数え方・退避を知らせた印 |
| `supabase/migrations/20261005100100_ops_alerting.sql`（新規） | 定期処理の最後の成功、知らせの回数の上限、要確認の値、実行の記録の掃除 |
| `src/lib/stripe/webhook-events.ts` | キューの関数の呼び出し、原因の記号 |
| `src/lib/ops/ops-store.ts`（新規） | 知らせと定期処理の記録の関数の呼び出し、溜まり・退避の読み出し |
| `src/lib/ops/ops-alert-mail.ts`（新規） | 店への知らせのメールの文面と送信 |
| `src/lib/ops/ops-checks.ts`（新規） | 点検（溜まり・退避・遅れ） |
| `src/lib/stripe/webhook-drain.ts`（新規） | worker の本体（約45秒まで取り出して処理する） |
| `src/lib/stripe/webhook-worker.ts`（新規） | worker の1回の起動（処理・最後の成功の記録・点検）。毎分の定期処理と受け取り口の `after()` が呼ぶ |
| `src/lib/stripe/handled-webhook-events.ts`（新規） | 保存する13種とモードの判定 |
| `src/lib/ops/webhook-receiver-signals.ts`（新規） | 受け取り口の署名不正・モード違いを数えて知らせる |
| `src/lib/cron/auth.ts`（新規） | 定期処理の入口の合言葉の確かめ方（1つにそろえる） |
| `src/lib/stripe/orphan-payment-recovery.ts`（新規） | 見回りの「注文の無い支払い」の拾い上げ |
| `src/app/api/webhook/stripe/route.ts` | 受け取り口 |
| `src/app/api/cron/process-stripe-webhooks/route.ts` | worker の入口 |
| `src/app/api/cron/expire-pending-orders/route.ts` | 見回りの入口 |
| `src/app/api/cron/stripe-reconcile/route.ts` | 照合の入口（POST） |
| `src/app/api/cron/meta-kpi-sync/route.ts`・`src/lib/legal-archive/cron-auth.ts` | 合言葉の確かめ方をそろえる（法令アーカイブの入口は比べ方の関数を共有するだけで、触らない） |
| `src/lib/stripe/reconcile-orders.ts` | 照合の1件ずつの受け止め |
| `src/app/api/admin/order-attention/route.ts` | 要確認の文言 |
| `supabase/pending/schedule_stripe_webhook_worker.sql`・`supabase/pending/schedule_stripe_reconcile.sql`（新規）・`supabase/pending/README.md` | 開店のときに当てる定期処理の登録 |
| `docs/06_Operations/webhook-queue-operations.md`（新規） | 開店のときの手順・入れ替え・知らせが来たときの調べ方 |
| `e2e/FR-ADMIN-064-recovered-order-review.spec.ts`・`e2e/FR-CHECKOUT-035-webhook-signature-alert.spec.ts`（新規）、`docs/02_Requirements/requirements.md` | 要確認の文言と署名不正の知らせの要件（FREQ-415・416）と E2E |

---

### Task 1: キューの退避・倍々のやり直し・受け取った時刻（DB）

設計書 3-2・3-4・8-1。キューの関数を倍々のやり直しと退避に変え、受け取った時刻の列を足す。

**Files:**
- Create: `supabase/migrations/20261005100000_webhook_queue_dead_letter.sql`
- Modify: `tests/integration/db/stripe_webhook_queue.integration.test.ts`

**Interfaces:**
- Consumes: 既存のキュー（`20260925000303_add_stripe_webhook_queue.sql`）
- Produces（DB）:
  - `public.stripe_webhook_events` に `received_at timestamptz NOT NULL DEFAULT now()`・`dead_at timestamptz`・`dead_notified_at timestamptz`。`processing_status` に `'dead'`
  - `public.claim_stripe_webhook_event()`（形は今のまま。期限の切れた試行を先に失敗・退避にしてから取り出す）
  - `public.fail_stripe_webhook_event(_event_id text, _claim_token uuid, _error text) RETURNS boolean`（形は今のまま。9回目の失敗で `dead`）
  - `public.mark_stripe_webhook_dead_notified(_event_ids text[]) RETURNS integer`
  - `public.get_stripe_webhook_backlog(_older_than_seconds integer) RETURNS TABLE(processing_status text, event_count integer, oldest_received_at timestamptz, last_errors text[])`
  - `public.list_unnotified_dead_stripe_webhook_events(_limit integer) RETURNS TABLE(event_id text, event_type text, last_error text, received_at timestamptz, attempt_count integer, dead_at timestamptz, total_count integer)`
  - `private.stripe_webhook_max_attempts() RETURNS integer`（9）、`private.stripe_webhook_retry_delay(_failed_attempts integer) RETURNS interval`

- [ ] **Step 1: DB 結合テストを直し、足す**

`tests/integration/db/stripe_webhook_queue.integration.test.ts` の `beforeAll` の、古い移行のファイルを流す部分:

```ts
    await client.query(fs.readFileSync(
      path.join(process.cwd(), 'supabase/migrations/20260925000303_add_stripe_webhook_queue.sql'),
      'utf8',
    ));
```

を次に置き換える（古いファイルを流し直すと、関数が古い形に戻るため。新しい移行は何度流しても同じ結果になる）:

```ts
    await client.query(fs.readFileSync(
      path.join(process.cwd(), 'supabase/migrations/20261005100000_webhook_queue_dead_letter.sql'),
      'utf8',
    ));
```

同じファイルの `test('期限切れleaseを再claimし、旧workerの完了を拒否する', …)` の本体を次に置き換える:

```ts
  test('期限切れleaseは1回の失敗（lease_expired）として数え、次の取り出しで旧workerの完了を拒否する', async () => {
    await enqueue();
    const first = await claim();
    await client.query(
      `update public.stripe_webhook_events
       set lease_expires_at = now() - interval '1 second'
       where id=$1`,
      [eventId],
    );
    // 取り出しの最初に、期限の切れた試行を失敗にする。やり直しは1分後なので、この呼び出しでは取り出さない
    const reaped = await client.query('select * from public.claim_stripe_webhook_event()');
    expect(reaped.rows.find((row: { event_id: string }) => row.event_id === eventId)).toBeUndefined();
    const afterReap = await client.query(
      `select processing_status, last_error, claim_token,
              extract(epoch from (next_attempt_at - now()))::int as delay_seconds
       from public.stripe_webhook_events where id=$1`,
      [eventId],
    );
    expect(afterReap.rows[0]).toEqual({
      processing_status: 'failed',
      last_error: 'lease_expired',
      claim_token: null,
      delay_seconds: 60,
    });

    const second = await claim();
    expect(second.claim_token).not.toBe(first.claim_token);
    expect((await client.query(
      'select public.complete_stripe_webhook_event($1,$2::uuid) as completed',
      [eventId, first.claim_token],
    )).rows[0].completed).toBe(false);
  });
```

同じファイルの `test('authenticatedはキューの直接更新とservice-role RPCを実行できない', …)` の前に、次の4つのテストを足す:

```ts
  test('やり直しの間隔は1・2・4…128分で、9回目の失敗で dead になり、もう取り出さない', async () => {
    await enqueue();
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      const claimed = await claim();
      expect(claimed.event_id).toBe(eventId);
      await client.query('select public.fail_stripe_webhook_event($1,$2::uuid,$3)', [
        eventId, claimed.claim_token, 'stripe_unavailable',
      ]);
      const row = await client.query(
        `select processing_status, attempt_count, last_error, dead_at,
                extract(epoch from (next_attempt_at - now()))::int as delay_seconds
         from public.stripe_webhook_events where id=$1`,
        [eventId],
      );
      expect(row.rows[0]).toEqual({
        processing_status: 'failed',
        attempt_count: attempt,
        last_error: 'stripe_unavailable',
        dead_at: null,
        delay_seconds: 60 * 2 ** (attempt - 1),
      });
    }

    const ninth = await claim();
    expect(ninth.event_id).toBe(eventId);
    await client.query('select public.fail_stripe_webhook_event($1,$2::uuid,$3)', [
      eventId, ninth.claim_token, 'db_unavailable',
    ]);
    const dead = await client.query(
      `select processing_status, attempt_count, last_error, dead_at is not null as has_dead_at, claim_token
       from public.stripe_webhook_events where id=$1`,
      [eventId],
    );
    expect(dead.rows[0]).toEqual({
      processing_status: 'dead',
      attempt_count: 9,
      last_error: 'db_unavailable',
      has_dead_at: true,
      claim_token: null,
    });

    const again = await claim();
    expect(again).toBeUndefined();
  });

  test('9回目の試行の期限が切れたら、lease_expired で dead にする', async () => {
    await enqueue();
    await client.query(
      `update public.stripe_webhook_events
       set processing_status = 'processing', attempt_count = 9,
           claim_token = gen_random_uuid(), lease_expires_at = now() - interval '1 second'
       where id=$1`,
      [eventId],
    );
    await client.query('select * from public.claim_stripe_webhook_event()');
    const row = await client.query(
      'select processing_status, last_error, dead_at is not null as has_dead_at from public.stripe_webhook_events where id=$1',
      [eventId],
    );
    expect(row.rows[0]).toEqual({ processing_status: 'dead', last_error: 'lease_expired', has_dead_at: true });
  });

  test('受け取った時刻は、取り出しても変わらない', async () => {
    await enqueue();
    await client.query(
      `update public.stripe_webhook_events set received_at = '2026-01-01T00:00:00Z' where id=$1`,
      [eventId],
    );
    await claim();
    const row = await client.query(
      `select received_at = '2026-01-01T00:00:00Z'::timestamptz as kept, processed_at = now() as claimed_now
       from public.stripe_webhook_events where id=$1`,
      [eventId],
    );
    expect(row.rows[0]).toEqual({ kept: true, claimed_now: true });
  });

  test('退避を知らせた印は、dead でまだ知らせていない行にだけ付く', async () => {
    await enqueue();
    secondaryId = `${eventId}_second`;
    await client.query(
      'select public.enqueue_stripe_webhook_event($1,$2,$3::jsonb)',
      [secondaryId, payload.type, JSON.stringify({ ...payload, id: secondaryId })],
    );
    await client.query(
      `update public.stripe_webhook_events set processing_status = 'dead', dead_at = now() where id=$1`,
      [eventId],
    );
    const first = await client.query(
      'select public.mark_stripe_webhook_dead_notified($1::text[]) as marked',
      [[eventId, secondaryId]],
    );
    expect(first.rows[0].marked).toBe(1);
    const second = await client.query(
      'select public.mark_stripe_webhook_dead_notified($1::text[]) as marked',
      [[eventId, secondaryId]],
    );
    expect(second.rows[0].marked).toBe(0);
    const rows = await client.query(
      'select id, dead_notified_at is not null as notified from public.stripe_webhook_events where id = any($1::text[]) order by id',
      [[eventId, secondaryId]],
    );
    expect(rows.rows).toEqual([
      { id: eventId, notified: true },
      { id: secondaryId, notified: false },
    ]);
  });

  test('溜まりは、受け取ってから指定の秒数以上たって完了していない知らせを状態ごとに数え、中身は返さない', async () => {
    await enqueue();
    secondaryId = `${eventId}_second`;
    await client.query(
      'select public.enqueue_stripe_webhook_event($1,$2,$3::jsonb)',
      [secondaryId, payload.type, JSON.stringify({ ...payload, id: secondaryId })],
    );
    await client.query(
      `update public.stripe_webhook_events
       set received_at = now() - interval '20 minutes',
           processing_status = case when id = $1 then 'failed' else 'queued' end,
           last_error = case when id = $1 then 'stripe_unavailable' else null end
       where id in ($1, $2)`,
      [eventId, secondaryId],
    );
    const backlog = await client.query('select * from public.get_stripe_webhook_backlog(900)');
    const mine = backlog.rows.filter((row: { processing_status: string }) =>
      ['failed', 'queued'].includes(row.processing_status));
    expect(mine).toEqual([
      expect.objectContaining({ processing_status: 'failed', event_count: expect.any(Number), last_errors: expect.arrayContaining(['stripe_unavailable']) }),
      expect.objectContaining({ processing_status: 'queued', event_count: expect.any(Number) }),
    ]);
    expect(Object.keys(backlog.rows[0]).sort()).toEqual(['event_count', 'last_errors', 'oldest_received_at', 'processing_status']);

    const young = await client.query('select * from public.get_stripe_webhook_backlog(1800)');
    expect(young.rows.some((row: { oldest_received_at: Date }) =>
      row.oldest_received_at.getTime() >= Date.now() - 21 * 60 * 1000)).toBe(false);
  });

  test('まだ知らせていない退避を古い順に上限まで返し、全件の数も返す', async () => {
    await enqueue();
    secondaryId = `${eventId}_second`;
    await client.query(
      'select public.enqueue_stripe_webhook_event($1,$2,$3::jsonb)',
      [secondaryId, payload.type, JSON.stringify({ ...payload, id: secondaryId })],
    );
    await client.query(
      `update public.stripe_webhook_events
       set processing_status = 'dead', attempt_count = 9, last_error = 'unexpected_error',
           dead_at = case when id = $1 then now() - interval '2 hours' else now() - interval '1 hour' end
       where id in ($1, $2)`,
      [eventId, secondaryId],
    );
    const listed = await client.query('select * from public.list_unnotified_dead_stripe_webhook_events(1)');
    const total = listed.rows[0].total_count;
    expect(total).toBeGreaterThanOrEqual(2);
    expect(listed.rows).toHaveLength(1);
    const all = await client.query('select event_id from public.list_unnotified_dead_stripe_webhook_events(1000)');
    const order = all.rows.map((row: { event_id: string }) => row.event_id).filter((id: string) => [eventId, secondaryId].includes(id));
    expect(order).toEqual([eventId, secondaryId]);
  });
```

同じファイルの権限のテストの `grants` の問い合わせに、次の6列を足し、期待値にも足す:

```ts
              has_function_privilege('authenticated','public.mark_stripe_webhook_dead_notified(text[])','EXECUTE') as can_mark_dead,
              has_function_privilege('service_role','public.mark_stripe_webhook_dead_notified(text[])','EXECUTE') as service_can_mark_dead,
              has_function_privilege('anon','public.get_stripe_webhook_backlog(integer)','EXECUTE') as anon_can_read_backlog,
              has_function_privilege('service_role','public.get_stripe_webhook_backlog(integer)','EXECUTE') as service_can_read_backlog,
              has_function_privilege('authenticated','public.list_unnotified_dead_stripe_webhook_events(integer)','EXECUTE') as can_list_dead,
              has_function_privilege('service_role','public.list_unnotified_dead_stripe_webhook_events(integer)','EXECUTE') as service_can_list_dead`,
```

```ts
      can_mark_dead: false,
      service_can_mark_dead: true,
      anon_can_read_backlog: false,
      service_can_read_backlog: true,
      can_list_dead: false,
      service_can_list_dead: true,
```

（`service_can_enqueue` の行の後ろに足す。問い合わせの最後の行の `` ` `` と `,` の位置を合わせる）

- [ ] **Step 2: テストが落ちることを確かめる**

```bash
npx supabase db reset
eval "$(npx supabase status -o env | grep -E '^(API_URL|SERVICE_ROLE_KEY)=')"
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
  npx jest tests/integration/db/stripe_webhook_queue.integration.test.ts --runInBand
```

Expected: FAIL（`ENOENT ... 20261005100000_webhook_queue_dead_letter.sql`）

- [ ] **Step 3: 移行を書く**

`supabase/migrations/20261005100000_webhook_queue_dead_letter.sql`:

```sql
-- Stripe の知らせのキュー: 受け取った時刻・退避（dead）・倍々のやり直し（設計書 2026-10-05 グループ B の 3-2・3-4・8-1）
--
-- - received_at: 受け取った時刻。processed_at は取り出すたびに書き換わるので、溜まりの点検に使えない
-- - 失敗した試行の回数 n に対し、次の試行は 2^(n-1) 分後（1・2・4…128分）。最初の試行と合わせて9回試し、
--   9回目も失敗したら dead（退避）にして取り出さない（Shopify の「4時間で8回やり直す」に合わせた）
-- - 処理の途中で担当の期限（5分）が切れた試行も1回の失敗として数える（原因 lease_expired）
BEGIN;

ALTER TABLE public.stripe_webhook_events
  ADD COLUMN IF NOT EXISTS received_at timestamptz,
  ADD COLUMN IF NOT EXISTS dead_at timestamptz,
  ADD COLUMN IF NOT EXISTS dead_notified_at timestamptz;

-- 今ある行は、最後に取り出した時刻で埋める（それより前の受け取った時刻は残っていない）
UPDATE public.stripe_webhook_events SET received_at = processed_at WHERE received_at IS NULL;

ALTER TABLE public.stripe_webhook_events
  ALTER COLUMN received_at SET DEFAULT pg_catalog.now(),
  ALTER COLUMN received_at SET NOT NULL;

ALTER TABLE public.stripe_webhook_events
  DROP CONSTRAINT IF EXISTS stripe_webhook_events_processing_status_check,
  ADD CONSTRAINT stripe_webhook_events_processing_status_check
    CHECK (processing_status IN ('queued', 'processing', 'completed', 'failed', 'dead'));

-- 溜まりの点検（受け取ってから15分以上たって完了していない知らせ）
CREATE INDEX IF NOT EXISTS stripe_webhook_events_backlog_idx
  ON public.stripe_webhook_events (received_at)
  WHERE processing_status IN ('queued', 'processing', 'failed');

-- まだ店へ知らせていない退避
CREATE INDEX IF NOT EXISTS stripe_webhook_events_dead_unnotified_idx
  ON public.stripe_webhook_events (dead_at)
  WHERE processing_status = 'dead' AND dead_notified_at IS NULL;

CREATE OR REPLACE FUNCTION private.stripe_webhook_max_attempts()
RETURNS integer
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT 9
$$;

CREATE OR REPLACE FUNCTION private.stripe_webhook_retry_delay(_failed_attempts integer)
RETURNS interval
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT pg_catalog.make_interval(mins => (2 ^ GREATEST(_failed_attempts - 1, 0))::integer)
$$;

CREATE OR REPLACE FUNCTION public.claim_stripe_webhook_event()
RETURNS TABLE (
  event_id text,
  event_type text,
  raw_payload jsonb,
  claim_token uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  -- 処理の途中で担当の期限が切れた試行は、1回の失敗として数える。9回目なら退避にする。
  UPDATE public.stripe_webhook_events AS e
  SET processing_status = CASE
        WHEN e.attempt_count >= private.stripe_webhook_max_attempts() THEN 'dead'
        ELSE 'failed'
      END,
      dead_at = CASE
        WHEN e.attempt_count >= private.stripe_webhook_max_attempts() THEN pg_catalog.now()
        ELSE NULL
      END,
      claim_token = NULL,
      lease_expires_at = NULL,
      last_error = 'lease_expired',
      next_attempt_at = pg_catalog.now() + private.stripe_webhook_retry_delay(e.attempt_count)
  WHERE e.processing_status = 'processing'
    AND COALESCE(e.lease_expires_at, e.processed_at + interval '5 minutes') <= pg_catalog.now();

  RETURN QUERY
  WITH candidate AS (
    SELECT e.id
    FROM public.stripe_webhook_events e
    WHERE e.raw_payload IS NOT NULL
      AND e.processing_status IN ('queued', 'failed')
      AND e.next_attempt_at <= pg_catalog.now()
    ORDER BY e.next_attempt_at, e.received_at, e.id
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  )
  UPDATE public.stripe_webhook_events AS e
  SET processing_status = 'processing',
      attempt_count = e.attempt_count + 1,
      processed_at = pg_catalog.now(),
      claim_token = pg_catalog.gen_random_uuid(),
      lease_expires_at = pg_catalog.now() + interval '5 minutes',
      last_error = NULL
  FROM candidate c
  WHERE e.id = c.id
  RETURNING e.id, e.event_type, e.raw_payload, e.claim_token;
END;
$$;

CREATE OR REPLACE FUNCTION public.fail_stripe_webhook_event(
  _event_id text,
  _claim_token uuid,
  _error text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  UPDATE public.stripe_webhook_events AS e
  SET processing_status = CASE
        WHEN e.attempt_count >= private.stripe_webhook_max_attempts() THEN 'dead'
        ELSE 'failed'
      END,
      dead_at = CASE
        WHEN e.attempt_count >= private.stripe_webhook_max_attempts() THEN pg_catalog.now()
        ELSE NULL
      END,
      claim_token = NULL,
      lease_expires_at = NULL,
      completed_at = NULL,
      last_error = pg_catalog.left(COALESCE(_error, 'unexpected_error'), 1000),
      next_attempt_at = pg_catalog.now() + private.stripe_webhook_retry_delay(e.attempt_count)
  WHERE e.id = _event_id
    AND e.processing_status = 'processing'
    AND e.claim_token = _claim_token;

  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.mark_stripe_webhook_dead_notified(_event_ids text[])
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_count integer;
BEGIN
  UPDATE public.stripe_webhook_events AS e
  SET dead_notified_at = pg_catalog.now()
  WHERE e.id = ANY(_event_ids)
    AND e.processing_status = 'dead'
    AND e.dead_notified_at IS NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- 溜まりの点検: 受け取ってから _older_than_seconds 以上たって完了していない知らせを、状態ごとに数える。
-- 中身（raw_payload）は返さない。原因の記号だけを返す。
CREATE OR REPLACE FUNCTION public.get_stripe_webhook_backlog(_older_than_seconds integer)
RETURNS TABLE (
  processing_status text,
  event_count integer,
  oldest_received_at timestamptz,
  last_errors text[]
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT e.processing_status,
         pg_catalog.count(*)::integer,
         pg_catalog.min(e.received_at),
         pg_catalog.array_remove(pg_catalog.array_agg(DISTINCT e.last_error), NULL)
  FROM public.stripe_webhook_events e
  WHERE e.processing_status IN ('queued', 'processing', 'failed')
    AND e.received_at <= pg_catalog.now() - pg_catalog.make_interval(secs => _older_than_seconds)
  GROUP BY e.processing_status
  ORDER BY e.processing_status
$$;

-- まだ店へ知らせていない退避を、古い順に _limit 件まで返す。total_count は上限に関係なく全件の数。
CREATE OR REPLACE FUNCTION public.list_unnotified_dead_stripe_webhook_events(_limit integer)
RETURNS TABLE (
  event_id text,
  event_type text,
  last_error text,
  received_at timestamptz,
  attempt_count integer,
  dead_at timestamptz,
  total_count integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT e.id, e.event_type, e.last_error, e.received_at, e.attempt_count, e.dead_at,
         (pg_catalog.count(*) OVER ())::integer
  FROM public.stripe_webhook_events e
  WHERE e.processing_status = 'dead'
    AND e.dead_notified_at IS NULL
  ORDER BY e.dead_at, e.id
  LIMIT _limit
$$;

REVOKE ALL ON FUNCTION private.stripe_webhook_max_attempts() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.stripe_webhook_retry_delay(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_stripe_webhook_event() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fail_stripe_webhook_event(text, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mark_stripe_webhook_dead_notified(text[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_stripe_webhook_backlog(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.list_unnotified_dead_stripe_webhook_events(integer) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.claim_stripe_webhook_event() TO service_role;
GRANT EXECUTE ON FUNCTION public.fail_stripe_webhook_event(text, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_stripe_webhook_dead_notified(text[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_stripe_webhook_backlog(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.list_unnotified_dead_stripe_webhook_events(integer) TO service_role;

COMMIT;
```

- [ ] **Step 4: テストが通ることを確かめる**

```bash
npx supabase db reset
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
  npx jest tests/integration/db/stripe_webhook_queue.integration.test.ts --runInBand
```

Expected: PASS（13件。最後の「Vaultを参照する10秒間隔のworkerジョブ」は Task 13 で毎分に変える）

フォルダ全体も流す（ほかの結合テストがキューの古い形に頼っていないことを確かめる）:

```bash
eval "$(npx supabase status -o env | grep -E '^(API_URL|SERVICE_ROLE_KEY)=')"
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
LOCAL_SUPABASE_URL="$API_URL" LOCAL_SUPABASE_SERVICE_ROLE_KEY="$SERVICE_ROLE_KEY" \
  npx jest tests/integration/db --runInBand
```

Expected: 全件 PASS

- [ ] **Step 5: コミットの文を書く**

`.superpowers/sdd/2026-10-05-webhook-queue-operations/task-1-commit-msg.txt` に次を書く（controller がコミットする）:

```text
feat(db): Stripe の知らせのキューに退避と倍々のやり直しと受け取った時刻を足す

失敗した試行の回数 n に対し次の試行を 2^(n-1) 分後にし、9回目の失敗で dead に
する。担当の期限が切れた試行も lease_expired として数える。受け取った時刻の列
received_at と、退避を知らせた印を付ける関数を足した。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

---

### Task 2: 知らせと定期処理の記録・要確認の値・実行の記録の掃除（DB）

設計書 4-4・4-6・5-2・6・8-1・8-2。定期処理の最後の成功、知らせの回数の上限、署名不正の数え方を DB の関数で持つ。要確認の理由に `recovered_from_payment` を足し、実行の記録の掃除を登録する。

**Files:**
- Create: `supabase/migrations/20261005100100_ops_alerting.sql`
- Create: `tests/integration/db/ops_alerting.integration.test.ts`

**Interfaces:**
- Consumes: なし（`public.orders` の `review_reason`・`review_marked_at`・`reviewed_at` はグループ A で作った）
- Produces（DB）:
  - `public.ops_job_heartbeats(job text PK, last_succeeded_at, last_failed_at, last_error_code, updated_at)`。`job` は `'webhook_worker' | 'order_sweep' | 'stripe_reconcile'`
  - `public.ops_alert_state(alert_key text PK, window_started_at, window_count, last_sent_at, updated_at)`
  - 2つの表は、service_role も直接は読み書きできない（関数だけ）
  - `public.get_ops_heartbeats() RETURNS TABLE(job text, last_succeeded_at timestamptz, last_failed_at timestamptz, last_error_code text)`
  - `public.record_ops_heartbeat(_job text, _succeeded boolean, _error_code text DEFAULT NULL) RETURNS void`
  - `public.bump_ops_signal(_alert_key text, _window_seconds integer) RETURNS integer`（今の窓の件数）
  - `public.claim_ops_alert(_alert_key text, _cooldown_seconds integer) RETURNS TABLE(claimed boolean, claimed_at timestamptz, previous_sent_at timestamptz)`
  - `public.release_ops_alert(_alert_key text, _claimed_at timestamptz, _previous_sent_at timestamptz) RETURNS boolean`
  - `public.mark_order_recovered_from_payment(_order_id uuid) RETURNS text`（付けた後の `review_reason`）
  - `orders_review_reason_check` に `'recovered_from_payment'`
  - pg_cron のジョブ `cron-job-run-details-retention`（`0 19 * * *`）

- [ ] **Step 1: DB 結合テストを書く**

`tests/integration/db/ops_alerting.integration.test.ts`:

```ts
/** @jest-environment node */
import { describeLocalDb } from './helpers/local-db';
import { createCatalogFixture, insertOrderWithStockLine } from './helpers/order-fixtures';

const fs = require('node:fs');
const path = require('node:path');

jest.setTimeout(30000);

describeLocalDb('integration: 知らせと定期処理の記録', (db) => {
  beforeAll(async () => {
    await db().query(fs.readFileSync(
      path.join(process.cwd(), 'supabase/migrations/20261005100100_ops_alerting.sql'),
      'utf8',
    ));
  });

  beforeEach(async () => {
    await db().query('begin');
  });

  afterEach(async () => {
    await db().query('rollback');
  });

  test('成功と失敗を記録する。失敗は最後の成功の時刻を消さない。読むのは関数から', async () => {
    await db().query("select public.record_ops_heartbeat('order_sweep', true)");
    await db().query("select public.record_ops_heartbeat('order_sweep', false, 'stripe_unavailable')");
    const row = await db().query(
      `select last_succeeded_at is not null as succeeded, last_failed_at is not null as failed, last_error_code
       from public.get_ops_heartbeats() where job = 'order_sweep'`,
    );
    expect(row.rows[0]).toEqual({ succeeded: true, failed: true, last_error_code: 'stripe_unavailable' });
  });

  test('知らない定期処理の名前は断る', async () => {
    await db().query('savepoint unknown_job');
    await expect(db().query("select public.record_ops_heartbeat('unknown_job', true)")).rejects.toMatchObject({
      code: '23514',
    });
    await db().query('rollback to savepoint unknown_job');
  });

  test('bump は窓の中なら数を足し、窓が過ぎたら1から数え直す。行は1つだけ', async () => {
    const counts: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      const res = await db().query("select public.bump_ops_signal('webhook_signature_invalid', 600) as n");
      counts.push(res.rows[0].n);
    }
    expect(counts).toEqual([1, 2, 3]);

    await db().query(
      `update public.ops_alert_state set window_started_at = now() - interval '601 seconds'
       where alert_key = 'webhook_signature_invalid'`,
    );
    const reset = await db().query("select public.bump_ops_signal('webhook_signature_invalid', 600) as n");
    expect(reset.rows[0].n).toBe(1);

    const rows = await db().query(
      "select count(*)::int as n from public.ops_alert_state where alert_key = 'webhook_signature_invalid'",
    );
    expect(rows.rows[0].n).toBe(1);
  });

  test('claim は1時間に1回だけ取れる。release は自分の取った分だけ元に戻す', async () => {
    const first = await db().query("select * from public.claim_ops_alert('webhook_backlog', 3600)");
    expect(first.rows[0]).toMatchObject({ claimed: true, previous_sent_at: null });
    const second = await db().query("select * from public.claim_ops_alert('webhook_backlog', 3600)");
    expect(second.rows[0].claimed).toBe(false);

    // 他人が後から取った（時刻が違う）なら、元に戻さない
    const wrong = await db().query(
      "select public.release_ops_alert('webhook_backlog', now() - interval '1 day', null) as released",
    );
    expect(wrong.rows[0].released).toBe(false);

    const released = await db().query(
      "select public.release_ops_alert('webhook_backlog', $1::timestamptz, null) as released",
      [first.rows[0].claimed_at],
    );
    expect(released.rows[0].released).toBe(true);
    const again = await db().query("select * from public.claim_ops_alert('webhook_backlog', 3600)");
    expect(again.rows[0].claimed).toBe(true);

    await db().query(
      "update public.ops_alert_state set last_sent_at = now() - interval '3601 seconds' where alert_key = 'webhook_backlog'",
    );
    const afterCooldown = await db().query("select * from public.claim_ops_alert('webhook_backlog', 3600)");
    expect(afterCooldown.rows[0].claimed).toBe(true);
  });

  test('支払いから作った注文の印は、理由の無い注文にだけ付き、在庫の理由は残す', async () => {
    const catalog = await createCatalogFixture(db(), { stock: 1 });
    const plain = await insertOrderWithStockLine(db(), {
      status: 'paid', itemId: catalog.itemId, variantId: catalog.variantId, quantity: 1, reserved: true,
    });
    const marked = await db().query('select public.mark_order_recovered_from_payment($1::uuid) as reason', [
      plain.orderId,
    ]);
    expect(marked.rows[0].reason).toBe('recovered_from_payment');
    const plainRow = await db().query(
      'select review_reason, review_marked_at is not null as marked_at from public.orders where id = $1',
      [plain.orderId],
    );
    expect(plainRow.rows[0]).toEqual({ review_reason: 'recovered_from_payment', marked_at: true });

    const stock = await insertOrderWithStockLine(db(), {
      status: 'paid', itemId: catalog.itemId, variantId: catalog.variantId, quantity: 1, reserved: false,
    });
    await db().query(
      "update public.orders set review_reason = 'stock_not_reserved', review_marked_at = now() where id = $1",
      [stock.orderId],
    );
    const kept = await db().query('select public.mark_order_recovered_from_payment($1::uuid) as reason', [
      stock.orderId,
    ]);
    expect(kept.rows[0].reason).toBe('stock_not_reserved');
  });

  test('無い注文には印を付けず、P0002 で断る', async () => {
    await db().query('savepoint missing_order');
    await expect(
      db().query("select public.mark_order_recovered_from_payment('00000000-0000-0000-0000-000000000000')"),
    ).rejects.toMatchObject({ code: 'P0002' });
    await db().query('rollback to savepoint missing_order');
  });

  test('要確認の理由は2つの値だけを受け付ける', async () => {
    const constraint = await db().query(
      "select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'orders_review_reason_check'",
    );
    expect(constraint.rows[0].def).toContain('stock_not_reserved');
    expect(constraint.rows[0].def).toContain('recovered_from_payment');
  });

  test('anon・authenticated は表も関数も使えない。service_role も表は触れず、関数だけを使える', async () => {
    const res = await db().query(
      `select
         has_table_privilege('anon', 'public.ops_job_heartbeats', 'SELECT') as anon_hb,
         has_table_privilege('authenticated', 'public.ops_alert_state', 'SELECT') as auth_alert,
         has_table_privilege('service_role', 'public.ops_job_heartbeats', 'SELECT') as svc_hb_select,
         has_table_privilege('service_role', 'public.ops_job_heartbeats', 'UPDATE') as svc_hb_update,
         has_table_privilege('service_role', 'public.ops_alert_state', 'SELECT') as svc_alert_select,
         has_function_privilege('anon', 'public.get_ops_heartbeats()', 'EXECUTE') as anon_read_hb,
         has_function_privilege('service_role', 'public.get_ops_heartbeats()', 'EXECUTE') as svc_read_hb,
         has_function_privilege('authenticated', 'public.bump_ops_signal(text, integer)', 'EXECUTE') as auth_bump,
         has_function_privilege('anon', 'public.claim_ops_alert(text, integer)', 'EXECUTE') as anon_claim,
         has_function_privilege('authenticated', 'public.mark_order_recovered_from_payment(uuid)', 'EXECUTE') as auth_mark,
         has_function_privilege('service_role', 'public.record_ops_heartbeat(text, boolean, text)', 'EXECUTE') as svc_hb,
         has_function_privilege('service_role', 'public.release_ops_alert(text, timestamptz, timestamptz)', 'EXECUTE') as svc_release,
         has_function_privilege('service_role', 'public.mark_order_recovered_from_payment(uuid)', 'EXECUTE') as svc_mark`,
    );
    expect(res.rows[0]).toEqual({
      anon_hb: false,
      auth_alert: false,
      svc_hb_select: false,
      svc_hb_update: false,
      svc_alert_select: false,
      anon_read_hb: false,
      svc_read_hb: true,
      auth_bump: false,
      anon_claim: false,
      auth_mark: false,
      svc_hb: true,
      svc_release: true,
      svc_mark: true,
    });
  });

  test('実行の記録の掃除を毎日 19:00 UTC に登録し、7日を残す', async () => {
    const job = await db().query(
      "select schedule, command from cron.job where jobname = 'cron-job-run-details-retention'",
    );
    expect(job.rows).toHaveLength(1);
    expect(job.rows[0].schedule).toBe('0 19 * * *');
    expect(job.rows[0].command).toContain('cron.job_run_details');
    expect(job.rows[0].command).toContain("interval '7 days'");
  });
});
```

- [ ] **Step 2: テストが落ちることを確かめる**

```bash
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
  npx jest tests/integration/db/ops_alerting.integration.test.ts --runInBand
```

Expected: FAIL（`ENOENT ... 20261005100100_ops_alerting.sql`）

- [ ] **Step 3: 移行を書く**

`supabase/migrations/20261005100100_ops_alerting.sql`:

```sql
-- 定期処理の最後の成功と、店への知らせの回数の上限（設計書 2026-10-05 グループ B の 4-6・5-2・6・8-1）。
-- あわせて、要確認の理由に「支払いから作った注文」を足し、定期処理の実行の記録を7日で消す（4-4）。
BEGIN;

CREATE TABLE IF NOT EXISTS public.ops_job_heartbeats (
  job text PRIMARY KEY CHECK (job IN ('webhook_worker', 'order_sweep', 'stripe_reconcile')),
  last_succeeded_at timestamptz,
  last_failed_at timestamptz,
  last_error_code text CHECK (last_error_code IS NULL OR last_error_code ~ '^[a-z0-9_]{1,64}$'),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now()
);

CREATE TABLE IF NOT EXISTS public.ops_alert_state (
  alert_key text PRIMARY KEY CHECK (alert_key ~ '^[a-z0-9_]{1,64}$'),
  window_started_at timestamptz,
  window_count integer NOT NULL DEFAULT 0 CHECK (window_count >= 0),
  last_sent_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now()
);

ALTER TABLE public.ops_job_heartbeats ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ops_alert_state ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "deny direct client access" ON public.ops_job_heartbeats;
CREATE POLICY "deny direct client access" ON public.ops_job_heartbeats
  AS RESTRICTIVE FOR ALL TO anon, authenticated
  USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS "deny direct client access" ON public.ops_alert_state;
CREATE POLICY "deny direct client access" ON public.ops_alert_state
  AS RESTRICTIVE FOR ALL TO anon, authenticated
  USING (false) WITH CHECK (false);

-- このプロジェクトは public の新しい表に anon・authenticated の全権限を自動で付けるので、先に剥がす。
-- 読むのも書くのも関数だけ（service_role にも表の権限を与えない）。
REVOKE ALL ON TABLE public.ops_job_heartbeats FROM anon, authenticated, service_role;
REVOKE ALL ON TABLE public.ops_alert_state FROM anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_ops_heartbeats()
RETURNS TABLE (job text, last_succeeded_at timestamptz, last_failed_at timestamptz, last_error_code text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT h.job, h.last_succeeded_at, h.last_failed_at, h.last_error_code
  FROM public.ops_job_heartbeats h
  ORDER BY h.job
$$;

CREATE OR REPLACE FUNCTION public.record_ops_heartbeat(
  _job text,
  _succeeded boolean,
  _error_code text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.ops_job_heartbeats AS h (job, last_succeeded_at, last_failed_at, last_error_code, updated_at)
  VALUES (
    _job,
    CASE WHEN _succeeded THEN pg_catalog.now() END,
    CASE WHEN _succeeded THEN NULL ELSE pg_catalog.now() END,
    CASE WHEN _succeeded THEN NULL ELSE _error_code END,
    pg_catalog.now()
  )
  ON CONFLICT (job) DO UPDATE SET
    last_succeeded_at = CASE WHEN _succeeded THEN pg_catalog.now() ELSE h.last_succeeded_at END,
    last_failed_at = CASE WHEN _succeeded THEN h.last_failed_at ELSE pg_catalog.now() END,
    last_error_code = CASE WHEN _succeeded THEN h.last_error_code ELSE _error_code END,
    updated_at = pg_catalog.now();
END;
$$;

-- 短い間の件数を数える（署名不正・モード違い）。1件ずつ行を足さず、同じ1行を更新する（R-05）。
CREATE OR REPLACE FUNCTION public.bump_ops_signal(_alert_key text, _window_seconds integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_count integer;
BEGIN
  INSERT INTO public.ops_alert_state AS s (alert_key, window_started_at, window_count, updated_at)
  VALUES (_alert_key, pg_catalog.now(), 1, pg_catalog.now())
  ON CONFLICT (alert_key) DO UPDATE SET
    window_started_at = CASE
      WHEN s.window_started_at IS NULL
        OR s.window_started_at <= pg_catalog.now() - pg_catalog.make_interval(secs => _window_seconds)
      THEN pg_catalog.now()
      ELSE s.window_started_at
    END,
    window_count = CASE
      WHEN s.window_started_at IS NULL
        OR s.window_started_at <= pg_catalog.now() - pg_catalog.make_interval(secs => _window_seconds)
      THEN 1
      ELSE s.window_count + 1
    END,
    updated_at = pg_catalog.now()
  RETURNING s.window_count INTO v_count;
  RETURN v_count;
END;
$$;

-- 知らせを送る権利を取る。最後に送ってから _cooldown_seconds 以内なら取れない（同時に動いても2通にならない）。
CREATE OR REPLACE FUNCTION public.claim_ops_alert(_alert_key text, _cooldown_seconds integer)
RETURNS TABLE (claimed boolean, claimed_at timestamptz, previous_sent_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_previous timestamptz;
BEGIN
  INSERT INTO public.ops_alert_state (alert_key) VALUES (_alert_key)
  ON CONFLICT (alert_key) DO NOTHING;

  SELECT s.last_sent_at INTO v_previous
  FROM public.ops_alert_state s
  WHERE s.alert_key = _alert_key
  FOR UPDATE;

  IF v_previous IS NOT NULL
     AND v_previous > pg_catalog.now() - pg_catalog.make_interval(secs => _cooldown_seconds) THEN
    RETURN QUERY SELECT false, NULL::timestamptz, v_previous;
    RETURN;
  END IF;

  UPDATE public.ops_alert_state
  SET last_sent_at = pg_catalog.now(), updated_at = pg_catalog.now()
  WHERE alert_key = _alert_key;

  RETURN QUERY SELECT true, pg_catalog.now(), v_previous;
END;
$$;

-- 送れなかったとき、取った権利を返す。後から別の誰かが取っていたら（時刻が違えば）何もしない。
CREATE OR REPLACE FUNCTION public.release_ops_alert(
  _alert_key text,
  _claimed_at timestamptz,
  _previous_sent_at timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  UPDATE public.ops_alert_state
  SET last_sent_at = _previous_sent_at, updated_at = pg_catalog.now()
  WHERE alert_key = _alert_key
    AND last_sent_at = _claimed_at;
  RETURN FOUND;
END;
$$;

ALTER TABLE public.orders
  DROP CONSTRAINT IF EXISTS orders_review_reason_check,
  ADD CONSTRAINT orders_review_reason_check
    CHECK (review_reason IN ('stock_not_reserved', 'recovered_from_payment'));

-- 見回りが「注文の無い支払い」から作った注文に、要確認を付ける（設計書 3-6）。
-- 在庫の理由（stock_not_reserved）が先に付いていれば、それを残す。付けた後の理由を返す。
CREATE OR REPLACE FUNCTION public.mark_order_recovered_from_payment(_order_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_reason text;
BEGIN
  UPDATE public.orders AS o
  SET review_reason = 'recovered_from_payment',
      review_marked_at = pg_catalog.now()
  WHERE o.id = _order_id
    AND o.review_reason IS NULL
    AND o.reviewed_at IS NULL;

  SELECT o.review_reason INTO v_reason FROM public.orders o WHERE o.id = _order_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ORDER_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  RETURN v_reason;
END;
$$;

REVOKE ALL ON FUNCTION public.get_ops_heartbeats() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_ops_heartbeat(text, boolean, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.bump_ops_signal(text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_ops_alert(text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_ops_alert(text, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mark_order_recovered_from_payment(uuid) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.get_ops_heartbeats() TO service_role;
GRANT EXECUTE ON FUNCTION public.record_ops_heartbeat(text, boolean, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.bump_ops_signal(text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_ops_alert(text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_ops_alert(text, timestamptz, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_order_recovered_from_payment(uuid) TO service_role;

-- 定期処理の実行の記録は自動では消えない。Supabase の例どおり、7日を残して毎日消す（R-32）。
-- 同名のジョブは置き換わる（cron.schedule はジョブ名で upsert する）。cron スキーマへの grant は書かない。
SELECT cron.schedule(
  'cron-job-run-details-retention',
  '0 19 * * *',
  $$ DELETE FROM cron.job_run_details WHERE end_time < now() - interval '7 days' $$
);

COMMIT;
```

- [ ] **Step 4: テストが通ることを確かめる**

```bash
npx supabase db reset
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
  npx jest tests/integration/db/ops_alerting.integration.test.ts --runInBand
```

Expected: PASS（9件）

フォルダ全体も流す（Task 1 の Step 4 と同じコマンド）。Expected: 全件 PASS

- [ ] **Step 5: コミットの文を書く**

`.superpowers/sdd/2026-10-05-webhook-queue-operations/task-2-commit-msg.txt`:

```text
feat(db): 定期処理の最後の成功と知らせの回数の上限を DB に持つ

ops_job_heartbeats・ops_alert_state と、記録・数え上げ・送る権利を取る／返す
関数を足した。要確認の理由に recovered_from_payment を足し、見回りが作った
注文に印を付ける関数を足した。定期処理の実行の記録は7日を残して毎日消す。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

---

### Task 3: キューと知らせの関数の呼び出し・原因の記号（TS）

設計書 3-3・4-6・6。Task 1・2 の DB の関数を呼ぶ薄い層を作る。失敗に残す値を、原因の記号の6つにそろえる。

**Files:**
- Modify: `src/lib/stripe/webhook-events.ts`（原因の記号、失敗の記録）
- Create: `src/lib/ops/ops-store.ts`
- Modify: `tests/unit/lib/stripe/webhook-events.test.ts`
- Create: `tests/unit/lib/ops/ops-store.test.ts`

**Interfaces:**
- Consumes: Task 1・2 の DB の関数（名前と引数は Task 1・2 の Interfaces）
- Produces:
  - `src/lib/stripe/webhook-events.ts`: `export type WebhookFailureCause = 'stripe_unavailable' | 'db_unavailable' | 'not_converged' | 'lease_expired' | 'invalid_payload' | 'unexpected_error'`、`export class InvalidWebhookPayloadError extends Error`、`export function webhookFailureCause(error: unknown): WebhookFailureCause`。`failWebhookEvent` は `_error` に原因の記号を渡す（`webhookErrorCategory` はログ用に残す）
  - `src/lib/ops/ops-store.ts`: `OpsStore`、`OpsJob = 'webhook_worker' | 'order_sweep' | 'stripe_reconcile'`、`OpsAlertKey = 'webhook_backlog' | 'webhook_dead' | 'webhook_signature_invalid' | 'webhook_mode_mismatch' | 'job_stale_order_sweep' | 'job_stale_stripe_reconcile'`、`Heartbeat`、`AlertClaim = { key: OpsAlertKey; claimedAt: string; previousSentAt: string | null }`、`BacklogRow = { status: 'queued' | 'processing' | 'failed'; count: number; oldestReceivedAt: Date; lastErrors: string[] }`、`DeadEvent = { eventId; eventType; cause: string | null; receivedAt: Date; attemptCount: number; deadAt: Date }`、`RecoveredReviewReason = 'recovered_from_payment' | 'stock_not_reserved'`、`class OpsStoreError`、関数 `readHeartbeats(store)`・`recordHeartbeat(store, job, succeeded, errorCode?)`・`bumpSignal(store, key, windowSeconds): Promise<number>`・`claimAlert(store, key, cooldownSeconds): Promise<AlertClaim | null>`・`releaseAlert(store, claim)`・`readWebhookBacklog(store, olderThanSeconds): Promise<BacklogRow[]>`・`listUnnotifiedDeadEvents(store, limit): Promise<{ events: DeadEvent[]; total: number }>`・`markDeadEventsNotified(store, eventIds): Promise<number>`・`markOrderRecoveredFromPayment(store, orderId): Promise<RecoveredReviewReason>`

- [ ] **Step 1: テストを書く**

`tests/unit/lib/stripe/webhook-events.test.ts` の import を次に置き換える:

```ts
import {
  enqueueWebhookEvent,
  claimWebhookEvent,
  completeWebhookEvent,
  failWebhookEvent,
  webhookErrorCategory,
  webhookFailureCause,
  InvalidWebhookPayloadError,
  type WebhookEventStore,
} from '@/lib/stripe/webhook-events';
import { ReconcileTransientError } from '@/lib/stripe/checkout-payment-reader';
```

同じファイルの「完了と失敗をclaim tokenで条件付き更新し、claim喪失を検知する」のテストの期待値 `_error: 'Error',` を `_error: 'unexpected_error',` に変える。

同じファイルの最後の `});` の前に、次を足す:

```ts
  describe('webhookFailureCause（失敗に残す原因の記号）', () => {
    it.each(['stripe_unavailable', 'db_unavailable', 'not_converged'] as const)('照合の一時的な失敗 %s はその記号', (code) => {
      expect(webhookFailureCause(new ReconcileTransientError(code))).toBe(code);
    });

    it('保存した中身が壊れていれば invalid_payload', () => {
      expect(webhookFailureCause(new InvalidWebhookPayloadError())).toBe('invalid_payload');
    });

    it('Stripe の通信・5xx・回数制限は stripe_unavailable', () => {
      expect(webhookFailureCause({ type: 'StripeConnectionError' })).toBe('stripe_unavailable');
      expect(webhookFailureCause({ statusCode: 503 })).toBe('stripe_unavailable');
      expect(webhookFailureCause({ statusCode: 429 })).toBe('stripe_unavailable');
    });

    it('それ以外は unexpected_error。例外の文や DB のコードは残さない', () => {
      expect(webhookFailureCause(new Error('buyer@example.com'))).toBe('unexpected_error');
      expect(webhookFailureCause(Object.assign(new Error('x'), { code: '23505' }))).toBe('unexpected_error');
      expect(webhookFailureCause('string error')).toBe('unexpected_error');
      expect(webhookFailureCause(null)).toBe('unexpected_error');
    });
  });
```

`tests/unit/lib/ops/ops-store.test.ts`:

```ts
import {
  OpsStoreError,
  bumpSignal,
  claimAlert,
  listUnnotifiedDeadEvents,
  markDeadEventsNotified,
  markOrderRecoveredFromPayment,
  readHeartbeats,
  readWebhookBacklog,
  recordHeartbeat,
  releaseAlert,
  type OpsStore,
} from '@/lib/ops/ops-store';

function storeReturning(data: unknown, error: { message?: string } | null = null) {
  const rpc = jest.fn().mockResolvedValue({ data, error });
  return { store: { rpc } as unknown as OpsStore, rpc };
}

describe('ops-store（知らせと定期処理の記録の関数の呼び出し）', () => {
  it('最後の成功を読み、定期処理ごとにまとめる', async () => {
    const { store, rpc } = storeReturning([
      { job: 'order_sweep', last_succeeded_at: '2026-10-05T00:00:00Z', last_failed_at: null, last_error_code: null },
      { job: 'stripe_reconcile', last_succeeded_at: null, last_failed_at: '2026-10-05T01:00:00Z', last_error_code: 'stripe_unavailable' },
    ]);
    const heartbeats = await readHeartbeats(store);
    expect(rpc).toHaveBeenCalledWith('get_ops_heartbeats', undefined);
    expect(heartbeats.order_sweep).toEqual({
      lastSucceededAt: new Date('2026-10-05T00:00:00Z'), lastFailedAt: null, lastErrorCode: null,
    });
    expect(heartbeats.stripe_reconcile?.lastErrorCode).toBe('stripe_unavailable');
    expect(heartbeats.webhook_worker).toBeUndefined();
  });

  it('成功・失敗の記録に、名前と原因の記号を渡す', async () => {
    const { store, rpc } = storeReturning(null);
    await recordHeartbeat(store, 'webhook_worker', true);
    await recordHeartbeat(store, 'order_sweep', false, 'db_unavailable');
    expect(rpc).toHaveBeenNthCalledWith(1, 'record_ops_heartbeat', { _job: 'webhook_worker', _succeeded: true, _error_code: null });
    expect(rpc).toHaveBeenNthCalledWith(2, 'record_ops_heartbeat', { _job: 'order_sweep', _succeeded: false, _error_code: 'db_unavailable' });
  });

  it('件数を数え、今の窓の件数を返す', async () => {
    const { store, rpc } = storeReturning(3);
    await expect(bumpSignal(store, 'webhook_signature_invalid', 600)).resolves.toBe(3);
    expect(rpc).toHaveBeenCalledWith('bump_ops_signal', { _alert_key: 'webhook_signature_invalid', _window_seconds: 600 });
  });

  it('送る権利が取れたら claim を返し、取れなければ null', async () => {
    const taken = storeReturning([{ claimed: true, claimed_at: '2026-10-05T02:00:00Z', previous_sent_at: null }]);
    await expect(claimAlert(taken.store, 'webhook_backlog', 3600)).resolves.toEqual({
      key: 'webhook_backlog', claimedAt: '2026-10-05T02:00:00Z', previousSentAt: null,
    });
    expect(taken.rpc).toHaveBeenCalledWith('claim_ops_alert', { _alert_key: 'webhook_backlog', _cooldown_seconds: 3600 });

    const busy = storeReturning([{ claimed: false, claimed_at: null, previous_sent_at: '2026-10-05T01:30:00Z' }]);
    await expect(claimAlert(busy.store, 'webhook_backlog', 3600)).resolves.toBeNull();
  });

  it('権利を返すときは、取った時刻と前の時刻を渡す', async () => {
    const { store, rpc } = storeReturning(true);
    await releaseAlert(store, { key: 'webhook_dead', claimedAt: '2026-10-05T02:00:00Z', previousSentAt: '2026-10-04T23:00:00Z' });
    expect(rpc).toHaveBeenCalledWith('release_ops_alert', {
      _alert_key: 'webhook_dead', _claimed_at: '2026-10-05T02:00:00Z', _previous_sent_at: '2026-10-04T23:00:00Z',
    });
  });

  it('溜まりを読む', async () => {
    const { store, rpc } = storeReturning([
      { processing_status: 'failed', event_count: 2, oldest_received_at: '2026-10-05T00:00:00Z', last_errors: ['stripe_unavailable'] },
    ]);
    await expect(readWebhookBacklog(store, 900)).resolves.toEqual([
      { status: 'failed', count: 2, oldestReceivedAt: new Date('2026-10-05T00:00:00Z'), lastErrors: ['stripe_unavailable'] },
    ]);
    expect(rpc).toHaveBeenCalledWith('get_stripe_webhook_backlog', { _older_than_seconds: 900 });
  });

  it('まだ知らせていない退避を読み、全件の数を返す。無ければ0件', async () => {
    const { store, rpc } = storeReturning([
      {
        event_id: 'evt_1', event_type: 'refund.updated', last_error: 'unexpected_error',
        received_at: '2026-10-05T00:00:00Z', attempt_count: 9, dead_at: '2026-10-05T04:15:00Z', total_count: 60,
      },
    ]);
    await expect(listUnnotifiedDeadEvents(store, 50)).resolves.toEqual({
      total: 60,
      events: [{
        eventId: 'evt_1', eventType: 'refund.updated', cause: 'unexpected_error',
        receivedAt: new Date('2026-10-05T00:00:00Z'), attemptCount: 9, deadAt: new Date('2026-10-05T04:15:00Z'),
      }],
    });
    expect(rpc).toHaveBeenCalledWith('list_unnotified_dead_stripe_webhook_events', { _limit: 50 });
    await expect(listUnnotifiedDeadEvents(storeReturning([]).store, 50)).resolves.toEqual({ total: 0, events: [] });
  });

  it('退避を知らせた印を付ける。空なら呼ばない', async () => {
    const { store, rpc } = storeReturning(2);
    await expect(markDeadEventsNotified(store, ['evt_1', 'evt_2'])).resolves.toBe(2);
    expect(rpc).toHaveBeenCalledWith('mark_stripe_webhook_dead_notified', { _event_ids: ['evt_1', 'evt_2'] });
    const empty = storeReturning(0);
    await expect(markDeadEventsNotified(empty.store, [])).resolves.toBe(0);
    expect(empty.rpc).not.toHaveBeenCalled();
  });

  it('支払いから作った注文の印を付け、付けた後の理由を返す。知らない値は失敗にする', async () => {
    const { store, rpc } = storeReturning('stock_not_reserved');
    await expect(markOrderRecoveredFromPayment(store, 'order-1')).resolves.toBe('stock_not_reserved');
    expect(rpc).toHaveBeenCalledWith('mark_order_recovered_from_payment', { _order_id: 'order-1' });
    await expect(markOrderRecoveredFromPayment(storeReturning(null).store, 'order-2')).rejects.toBeInstanceOf(OpsStoreError);
  });

  it('DB の失敗は OpsStoreError にし、中身を出さない', async () => {
    const { store } = storeReturning(null, { message: 'buyer@example.com' });
    const error = await recordHeartbeat(store, 'webhook_worker', true).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OpsStoreError);
    expect((error as Error).message).toBe('ops store failed: record_ops_heartbeat');
  });
});
```

- [ ] **Step 2: テストが落ちることを確かめる**

Run: `npx jest tests/unit/lib/stripe/webhook-events.test.ts tests/unit/lib/ops/ops-store.test.ts`
Expected: FAIL（`webhookFailureCause` が無い、`@/lib/ops/ops-store` が無い）

- [ ] **Step 3: 原因の記号を足す**

`src/lib/stripe/webhook-events.ts` の先頭に import を足す:

```ts
import { isTransientStripeError } from '@/lib/stripe/checkout-payment-reader';
```

同じファイルの `webhookErrorCategory` の関数の後ろ（`export async function failWebhookEvent` の前）に足す:

```ts

/** 失敗に残す原因の記号（設計書 2026-10-05 グループ B の 3-3）。例外の文・スタック・個人情報は残さない。 */
export type WebhookFailureCause =
  | 'stripe_unavailable'
  | 'db_unavailable'
  | 'not_converged'
  | 'lease_expired'
  | 'invalid_payload'
  | 'unexpected_error';

/** 保存した知らせの中身が壊れている（worker が投げる。やり直しても直らない）。 */
export class InvalidWebhookPayloadError extends Error {
  constructor() {
    super('Persisted Stripe event is invalid');
    this.name = 'InvalidWebhookPayloadError';
  }
}

const RECONCILE_TRANSIENT_CAUSES: ReadonlySet<string> = new Set(['stripe_unavailable', 'db_unavailable', 'not_converged']);

export function webhookFailureCause(error: unknown): WebhookFailureCause {
  if (error instanceof InvalidWebhookPayloadError) return 'invalid_payload';
  const code = error && typeof error === 'object' && 'code' in error ? (error as { code?: unknown }).code : null;
  if (typeof code === 'string' && RECONCILE_TRANSIENT_CAUSES.has(code)) return code as WebhookFailureCause;
  if (isTransientStripeError(error)) return 'stripe_unavailable';
  return 'unexpected_error';
}
```

同じファイルの `failWebhookEvent` の本体の `const message = webhookErrorCategory(error);` と `_error: message,` を、次に変える:

```ts
  const cause = webhookFailureCause(error);
```

```ts
      _error: cause,
```

- [ ] **Step 4: 知らせと記録の関数の呼び出しを作る**

`src/lib/ops/ops-store.ts`:

```ts
/**
 * 知らせと定期処理の記録を DB の関数で読み書きする（設計書 2026-10-05 グループ B の 4-6・5-2・6）。
 * 表は service_role からも直接は触れない（関数だけ）。失敗は OpsStoreError にして投げる（DB の中身は残さない）。
 */
type QueryError = { message?: string; code?: string } | null;

export type OpsRpcName =
  | 'get_ops_heartbeats'
  | 'record_ops_heartbeat'
  | 'bump_ops_signal'
  | 'claim_ops_alert'
  | 'release_ops_alert'
  | 'get_stripe_webhook_backlog'
  | 'list_unnotified_dead_stripe_webhook_events'
  | 'mark_stripe_webhook_dead_notified'
  | 'mark_order_recovered_from_payment';

export type OpsStore = {
  rpc(name: OpsRpcName, params?: Record<string, unknown>): Promise<{ data: unknown; error: QueryError }>;
};

export type OpsJob = 'webhook_worker' | 'order_sweep' | 'stripe_reconcile';

export type OpsAlertKey =
  | 'webhook_backlog'
  | 'webhook_dead'
  | 'webhook_signature_invalid'
  | 'webhook_mode_mismatch'
  | 'job_stale_order_sweep'
  | 'job_stale_stripe_reconcile';

export type Heartbeat = { lastSucceededAt: Date | null; lastFailedAt: Date | null; lastErrorCode: string | null };

export type AlertClaim = { key: OpsAlertKey; claimedAt: string; previousSentAt: string | null };

export type BacklogRow = {
  status: 'queued' | 'processing' | 'failed';
  count: number;
  oldestReceivedAt: Date;
  lastErrors: string[];
};

export type DeadEvent = {
  eventId: string;
  eventType: string;
  cause: string | null;
  receivedAt: Date;
  attemptCount: number;
  deadAt: Date;
};

export type RecoveredReviewReason = 'recovered_from_payment' | 'stock_not_reserved';

export class OpsStoreError extends Error {
  constructor(operation: OpsRpcName) {
    super(`ops store failed: ${operation}`);
    this.name = 'OpsStoreError';
  }
}

async function call(store: OpsStore, name: OpsRpcName, params?: Record<string, unknown>): Promise<unknown> {
  const { data, error } = await store.rpc(name, params);
  if (error) throw new OpsStoreError(name);
  return data;
}

function rowsOf(data: unknown): Record<string, unknown>[] {
  return Array.isArray(data) ? (data as Record<string, unknown>[]) : [];
}

function dateOrNull(value: unknown): Date | null {
  return typeof value === 'string' ? new Date(value) : null;
}

export async function readHeartbeats(store: OpsStore): Promise<Partial<Record<OpsJob, Heartbeat>>> {
  const result: Partial<Record<OpsJob, Heartbeat>> = {};
  for (const row of rowsOf(await call(store, 'get_ops_heartbeats'))) {
    result[row.job as OpsJob] = {
      lastSucceededAt: dateOrNull(row.last_succeeded_at),
      lastFailedAt: dateOrNull(row.last_failed_at),
      lastErrorCode: typeof row.last_error_code === 'string' ? row.last_error_code : null,
    };
  }
  return result;
}

export async function recordHeartbeat(
  store: OpsStore,
  job: OpsJob,
  succeeded: boolean,
  errorCode: string | null = null,
): Promise<void> {
  await call(store, 'record_ops_heartbeat', { _job: job, _succeeded: succeeded, _error_code: errorCode });
}

export async function bumpSignal(store: OpsStore, key: OpsAlertKey, windowSeconds: number): Promise<number> {
  const data = await call(store, 'bump_ops_signal', { _alert_key: key, _window_seconds: windowSeconds });
  if (typeof data !== 'number') throw new OpsStoreError('bump_ops_signal');
  return data;
}

export async function claimAlert(store: OpsStore, key: OpsAlertKey, cooldownSeconds: number): Promise<AlertClaim | null> {
  const row = rowsOf(await call(store, 'claim_ops_alert', { _alert_key: key, _cooldown_seconds: cooldownSeconds }))[0];
  if (!row || row.claimed !== true || typeof row.claimed_at !== 'string') return null;
  return {
    key,
    claimedAt: row.claimed_at,
    previousSentAt: typeof row.previous_sent_at === 'string' ? row.previous_sent_at : null,
  };
}

export async function releaseAlert(store: OpsStore, claim: AlertClaim): Promise<void> {
  await call(store, 'release_ops_alert', {
    _alert_key: claim.key,
    _claimed_at: claim.claimedAt,
    _previous_sent_at: claim.previousSentAt,
  });
}

export async function readWebhookBacklog(store: OpsStore, olderThanSeconds: number): Promise<BacklogRow[]> {
  const data = await call(store, 'get_stripe_webhook_backlog', { _older_than_seconds: olderThanSeconds });
  return rowsOf(data).map((row) => ({
    status: row.processing_status as BacklogRow['status'],
    count: Number(row.event_count),
    oldestReceivedAt: new Date(String(row.oldest_received_at)),
    lastErrors: Array.isArray(row.last_errors)
      ? (row.last_errors as unknown[]).filter((value): value is string => typeof value === 'string')
      : [],
  }));
}

export async function listUnnotifiedDeadEvents(
  store: OpsStore,
  limit: number,
): Promise<{ events: DeadEvent[]; total: number }> {
  const list = rowsOf(await call(store, 'list_unnotified_dead_stripe_webhook_events', { _limit: limit }));
  return {
    total: list.length > 0 ? Number(list[0].total_count) : 0,
    events: list.map((row) => ({
      eventId: String(row.event_id),
      eventType: String(row.event_type),
      cause: typeof row.last_error === 'string' ? row.last_error : null,
      receivedAt: new Date(String(row.received_at)),
      attemptCount: Number(row.attempt_count),
      deadAt: new Date(String(row.dead_at)),
    })),
  };
}

export async function markDeadEventsNotified(store: OpsStore, eventIds: string[]): Promise<number> {
  if (eventIds.length === 0) return 0;
  const data = await call(store, 'mark_stripe_webhook_dead_notified', { _event_ids: eventIds });
  return typeof data === 'number' ? data : 0;
}

export async function markOrderRecoveredFromPayment(store: OpsStore, orderId: string): Promise<RecoveredReviewReason> {
  const data = await call(store, 'mark_order_recovered_from_payment', { _order_id: orderId });
  if (data !== 'recovered_from_payment' && data !== 'stock_not_reserved') {
    throw new OpsStoreError('mark_order_recovered_from_payment');
  }
  return data;
}
```

- [ ] **Step 5: テストが通ることを確かめる**

Run: `npx jest tests/unit/lib/stripe/webhook-events.test.ts tests/unit/lib/ops/ops-store.test.ts tests/unit/api/cron/process-stripe-webhooks-route.test.ts`
Expected: PASS（worker の入口のテストは `failWebhookEvent` をモックしているので今のまま通る）

Run: `npm run typecheck`
Expected: エラー0

- [ ] **Step 6: コミットの文を書く**

`.superpowers/sdd/2026-10-05-webhook-queue-operations/task-3-commit-msg.txt`:

```text
feat(ops): キューの失敗に原因の記号を残し、知らせと記録の関数の呼び出しを足す

失敗に残す値を stripe_unavailable などの6つの記号にそろえ、例外の文や DB の
コードを残さないようにした。定期処理の最後の成功・知らせの回数の上限・溜まり・
退避・支払いから作った注文の印を DB の関数で読み書きする ops-store を足した。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

---

### Task 4: 店への知らせのメール（文面と送信）

設計書 6。6種類の知らせの文面を、副作用の無い関数で組み立てる。送信は今の要対応のメールと同じく `SHOP_ALERT_EMAIL` へ送り、送れなければ `false` を返す（呼び出し側が送る権利を返す）。お客様の名前・住所・メールアドレスは入れない。

**Files:**
- Create: `src/lib/ops/ops-alert-mail.ts`
- Test: `tests/unit/lib/ops/ops-alert-mail.test.ts`

**Interfaces:**
- Consumes: Task 3 の `BacklogRow`・`DeadEvent`・`RecoveredReviewReason`
- Produces（`src/lib/ops/ops-alert-mail.ts`）:
  - `export type OpsAlertKind = 'webhook_backlog' | 'webhook_dead' | 'job_stale' | 'webhook_signature_invalid' | 'webhook_mode_mismatch' | 'orders_recovered_from_payment'`
  - `export type OpsAlertMail = { kind: OpsAlertKind; subject: string; lines: string[] }`
  - `export type RecoveredOrderSummary = { orderId: string; reviewReason: RecoveredReviewReason; totalAmount: number | null; currency: string | null }`
  - `backlogAlertMail(rows: BacklogRow[]): OpsAlertMail`、`deadDigestMail(events: DeadEvent[], total: number): OpsAlertMail`、`staleJobMail(job: 'order_sweep' | 'stripe_reconcile', lastSucceededAt: Date): OpsAlertMail`、`signatureAlertMail(count: number): OpsAlertMail`、`modeMismatchMail(eventLivemode: boolean, keyLivemode: boolean | null): OpsAlertMail`、`recoveredOrdersMail(orders: RecoveredOrderSummary[]): OpsAlertMail`
  - `export async function sendOpsAlertMail(mail: OpsAlertMail): Promise<boolean>`

- [ ] **Step 1: テストを書く**

`tests/unit/lib/ops/ops-alert-mail.test.ts`:

```ts
jest.mock('@/lib/mail', () => ({ sendMail: jest.fn() }));
jest.mock('@/lib/audit', () => ({ logAudit: jest.fn() }));

import { sendMail } from '@/lib/mail';
import { logAudit } from '@/lib/audit';
import {
  backlogAlertMail,
  deadDigestMail,
  modeMismatchMail,
  recoveredOrdersMail,
  sendOpsAlertMail,
  signatureAlertMail,
  staleJobMail,
} from '@/lib/ops/ops-alert-mail';
import type { DeadEvent } from '@/lib/ops/ops-store';

const mockSendMail = sendMail as jest.Mock;
const mockLogAudit = logAudit as jest.Mock;

function deadEvent(n: number): DeadEvent {
  return {
    eventId: `evt_${n}`,
    eventType: 'refund.updated',
    cause: 'unexpected_error',
    receivedAt: new Date('2026-10-05T00:00:00Z'),
    attemptCount: 9,
    deadAt: new Date('2026-10-05T04:15:00Z'),
  };
}

describe('店への知らせのメールの文面', () => {
  it('溜まり: 状態ごとの件数・いちばん古い受け取り・原因の記号を書く', () => {
    const mail = backlogAlertMail([
      { status: 'failed', count: 2, oldestReceivedAt: new Date('2026-10-05T00:00:00Z'), lastErrors: ['stripe_unavailable'] },
      { status: 'queued', count: 1, oldestReceivedAt: new Date('2026-10-05T00:10:00Z'), lastErrors: [] },
    ]);
    expect(mail.kind).toBe('webhook_backlog');
    expect(mail.subject).toBe('【要確認】Stripe の知らせの処理が遅れています');
    const body = mail.lines.join('\n');
    expect(body).toContain('やり直し待ち: 2件');
    expect(body).toContain('原因: stripe_unavailable');
    expect(body).toContain('処理待ち: 1件');
    expect(body).toContain('2026/10/05 9:00');
  });

  it('退避: 50件まで並べ、残りの件数と、見回りと照合が合わせることを書く', () => {
    const events = Array.from({ length: 50 }, (_, i) => deadEvent(i + 1));
    const mail = deadDigestMail(events, 60);
    expect(mail.kind).toBe('webhook_dead');
    expect(mail.subject).toBe('【要対応】処理を止めた Stripe の知らせ（60件）');
    const body = mail.lines.join('\n');
    expect(mail.lines.filter((line) => line.startsWith('- evt_'))).toHaveLength(50);
    expect(body).toContain('- evt_1（refund.updated） 原因: unexpected_error');
    expect(body).toContain('（ほかに 10 件。次の知らせで送ります）');
    expect(body).toContain('注文の状態は毎時の見回りが、返金と会計は毎晩の照合が Stripe に合わせます。');
  });

  it('遅れ: 定期処理の名前と、最後の成功の時刻を書く', () => {
    const sweep = staleJobMail('order_sweep', new Date('2026-10-05T01:00:00Z'));
    expect(sweep.kind).toBe('job_stale');
    expect(sweep.subject).toBe('【要確認】定期処理が止まっています（毎時の見回り）');
    expect(sweep.lines.join('\n')).toContain('2時間以上');
    const reconcile = staleJobMail('stripe_reconcile', new Date('2026-10-05T01:00:00Z'));
    expect(reconcile.subject).toBe('【要確認】定期処理が止まっています（毎晩の照合）');
    expect(reconcile.lines.join('\n')).toContain('25時間以上');
  });

  it('署名不正: 10分の件数と、合言葉を確かめる案内を書く', () => {
    const mail = signatureAlertMail(5);
    expect(mail.kind).toBe('webhook_signature_invalid');
    expect(mail.subject).toBe('【要確認】署名の合わない Stripe の知らせが届いています');
    const body = mail.lines.join('\n');
    expect(body).toContain('10分の間に、署名の合わない知らせが5件届きました');
    expect(body).toContain('設定が正しければ、外からの偽の知らせを断っているだけです。');
  });

  it('モード違い: 届いたモードと鍵のモードを書く', () => {
    const mail = modeMismatchMail(false, true);
    expect(mail.kind).toBe('webhook_mode_mismatch');
    expect(mail.subject).toBe('【要対応】Stripe の本番とテストの知らせが混ざっています');
    expect(mail.lines.join('\n')).toContain('届いた知らせ: テスト、このアプリの鍵: 本番');
    expect(modeMismatchMail(true, null).lines.join('\n')).toContain('このアプリの鍵: 不明');
  });

  it('支払いから作った注文: 注文番号と金額、在庫の理由が重なったことを書く', () => {
    const mail = recoveredOrdersMail([
      { orderId: '11111111-2222-3333-4444-555555555555', reviewReason: 'recovered_from_payment', totalAmount: 89000, currency: 'jpy' },
      { orderId: '66666666-7777-8888-9999-000000000000', reviewReason: 'stock_not_reserved', totalAmount: null, currency: null },
    ]);
    expect(mail.kind).toBe('orders_recovered_from_payment');
    expect(mail.subject).toBe('【要確認】支払いから作った注文（2件）');
    const body = mail.lines.join('\n');
    expect(body).toContain('89,000');
    expect(body).toContain('（在庫も確保できていません）');
    expect(body).toContain('お客様へ確認してください');
  });

  it('どの文面にもメールアドレスを入れない', () => {
    const mails = [
      backlogAlertMail([{ status: 'queued', count: 1, oldestReceivedAt: new Date(), lastErrors: [] }]),
      deadDigestMail([deadEvent(1)], 1),
      staleJobMail('order_sweep', new Date()),
      signatureAlertMail(5),
      modeMismatchMail(true, false),
      recoveredOrdersMail([{ orderId: '11111111-2222-3333-4444-555555555555', reviewReason: 'recovered_from_payment', totalAmount: 100, currency: 'jpy' }]),
    ];
    for (const mail of mails) {
      expect(`${mail.subject}\n${mail.lines.join('\n')}`).not.toMatch(/@/);
    }
  });
});

describe('sendOpsAlertMail', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv, SHOP_ALERT_EMAIL: 'shop-alert@e2e.test', MAIL_FROM_ADDRESS: 'no-reply@e2e.test' };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('SHOP_ALERT_EMAIL に件名と本文を送り、true を返す', async () => {
    mockSendMail.mockResolvedValueOnce({});
    await expect(sendOpsAlertMail(signatureAlertMail(5))).resolves.toBe(true);
    expect(mockSendMail).toHaveBeenCalledWith({
      to: 'shop-alert@e2e.test',
      subject: '【要確認】署名の合わない Stripe の知らせが届いています',
      text: signatureAlertMail(5).lines.join('\n'),
    });
  });

  it('宛先か差出人が無ければ送らずに false', async () => {
    delete process.env.SHOP_ALERT_EMAIL;
    await expect(sendOpsAlertMail(signatureAlertMail(5))).resolves.toBe(false);
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it('送れなければ false を返し、種類だけを監査に残す', async () => {
    mockSendMail.mockRejectedValueOnce(new Error('send failed'));
    await expect(sendOpsAlertMail(signatureAlertMail(5))).resolves.toBe(false);
    expect(mockLogAudit).toHaveBeenCalledWith({
      action: 'ops.alert_mail',
      outcome: 'error',
      resource: 'ops_alert',
      detail: 'mail_send_failed',
      metadata: { kind: 'webhook_signature_invalid' },
    });
  });
});
```

- [ ] **Step 2: テストが落ちることを確かめる**

Run: `npx jest tests/unit/lib/ops/ops-alert-mail.test.ts`
Expected: FAIL（`@/lib/ops/ops-alert-mail` が無い）

- [ ] **Step 3: 文面と送信を作る**

`src/lib/ops/ops-alert-mail.ts`:

```ts
import { sendMail } from '@/lib/mail';
import { logAudit } from '@/lib/audit';
import { toOrderNumber } from '@/lib/orders/order-number';
import type { BacklogRow, DeadEvent, RecoveredReviewReason } from '@/lib/ops/ops-store';

/**
 * 店への知らせのメール（設計書 2026-10-05 グループ B の第6章）。
 * 宛先は SHOP_ALERT_EMAIL（今の要対応のメールと同じ）。お客様の名前・住所・メールアドレスは入れない。
 */
export type OpsAlertKind =
  | 'webhook_backlog'
  | 'webhook_dead'
  | 'job_stale'
  | 'webhook_signature_invalid'
  | 'webhook_mode_mismatch'
  | 'orders_recovered_from_payment';

export type OpsAlertMail = { kind: OpsAlertKind; subject: string; lines: string[] };

export type RecoveredOrderSummary = {
  orderId: string;
  reviewReason: RecoveredReviewReason;
  totalAmount: number | null;
  currency: string | null;
};

const RUNBOOK = '手順書（docs/06_Operations/webhook-queue-operations.md）';

const STATUS_LABELS: Record<BacklogRow['status'], string> = {
  queued: '処理待ち',
  processing: '処理中',
  failed: 'やり直し待ち',
};

const STALE_JOBS = {
  order_sweep: { label: '毎時の見回り', hours: 2 },
  stripe_reconcile: { label: '毎晩の照合', hours: 25 },
} as const;

function formatJst(date: Date): string {
  return new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

function formatAmount(amount: number | null, currency: string | null): string {
  if (amount === null || !currency) return '金額不明';
  return new Intl.NumberFormat('ja-JP', { style: 'currency', currency: currency.toUpperCase() }).format(amount);
}

export function backlogAlertMail(rows: BacklogRow[]): OpsAlertMail {
  return {
    kind: 'webhook_backlog',
    subject: '【要確認】Stripe の知らせの処理が遅れています',
    lines: [
      '受け取ってから15分以上たっても、処理が終わっていない Stripe の知らせがあります。',
      '',
      ...rows.map((row) => {
        const causes = row.lastErrors.length > 0 ? ` 原因: ${row.lastErrors.join('、')}` : '';
        return `${STATUS_LABELS[row.status]}: ${row.count}件（いちばん古い受け取り: ${formatJst(row.oldestReceivedAt)}）${causes}`;
      }),
      '',
      `次にやること: ${RUNBOOK}の「知らせが溜まったとき」に沿って、定期処理（worker）が動いているかを確かめてください。`,
    ],
  };
}

export function deadDigestMail(events: DeadEvent[], total: number): OpsAlertMail {
  const rest = total - events.length;
  return {
    kind: 'webhook_dead',
    subject: `【要対応】処理を止めた Stripe の知らせ（${total}件）`,
    lines: [
      '8回やり直しても処理できなかった Stripe の知らせを退避しました（これ以上やり直しません）。',
      '',
      ...events.map((event) =>
        `- ${event.eventId}（${event.eventType}） 原因: ${event.cause ?? 'unexpected_error'} `
        + `受け取り: ${formatJst(event.receivedAt)} 試行: ${event.attemptCount}回`),
      ...(rest > 0 ? [`（ほかに ${rest} 件。次の知らせで送ります）`] : []),
      '',
      '注文の状態は毎時の見回りが、返金と会計は毎晩の照合が Stripe に合わせます。',
      `同じ原因が続くときは、${RUNBOOK}の「退避の知らせが来たとき」に沿って開発者に連絡してください。`,
    ],
  };
}

export function staleJobMail(job: keyof typeof STALE_JOBS, lastSucceededAt: Date): OpsAlertMail {
  const { label, hours } = STALE_JOBS[job];
  return {
    kind: 'job_stale',
    subject: `【要確認】定期処理が止まっています（${label}）`,
    lines: [
      `${label}が、${hours}時間以上成功していません。`,
      `最後の成功: ${formatJst(lastSucceededAt)}`,
      '',
      `次にやること: ${RUNBOOK}の「定期処理が止まったとき」に沿って、定期処理の実行の記録を確かめてください。`,
    ],
  };
}

export function signatureAlertMail(count: number): OpsAlertMail {
  return {
    kind: 'webhook_signature_invalid',
    subject: '【要確認】署名の合わない Stripe の知らせが届いています',
    lines: [
      `10分の間に、署名の合わない知らせが${count}件届きました（すべて断っています）。`,
      '',
      'Stripe の署名の合言葉（STRIPE_WEBHOOK_SECRET）の設定を確かめてください。設定が正しければ、外からの偽の知らせを断っているだけです。',
      `${RUNBOOK}の「署名不正の知らせが来たとき」も確かめてください。`,
    ],
  };
}

export function modeMismatchMail(eventLivemode: boolean, keyLivemode: boolean | null): OpsAlertMail {
  const keyLabel = keyLivemode === null ? '不明' : keyLivemode ? '本番' : 'テスト';
  return {
    kind: 'webhook_mode_mismatch',
    subject: '【要対応】Stripe の本番とテストの知らせが混ざっています',
    lines: [
      `届いた知らせ: ${eventLivemode ? '本番' : 'テスト'}、このアプリの鍵: ${keyLabel}`,
      '',
      'この知らせは処理していません。',
      `Stripe の知らせの宛先と、STRIPE_SECRET_KEY・STRIPE_WEBHOOK_SECRET の組み合わせを確かめてください（${RUNBOOK}の「モード違いの知らせが来たとき」）。`,
    ],
  };
}

export function recoveredOrdersMail(orders: RecoveredOrderSummary[]): OpsAlertMail {
  return {
    kind: 'orders_recovered_from_payment',
    subject: `【要確認】支払いから作った注文（${orders.length}件）`,
    lines: [
      'Stripe に支払いがあったのに注文が無かったため、毎時の見回りが注文を作りました。',
      'お客様は注文の完了を見ていない可能性があります。注文の内容をお客様へ確認してください。',
      '',
      ...orders.map((order) =>
        `- 注文番号 ${toOrderNumber(order.orderId)} ${formatAmount(order.totalAmount, order.currency)}`
        + (order.reviewReason === 'stock_not_reserved' ? '（在庫も確保できていません）' : '')),
      '',
      '管理画面の ORDER タブの「要対応・要確認」で、確認したら確認済みにしてください。',
    ],
  };
}

export async function sendOpsAlertMail(mail: OpsAlertMail): Promise<boolean> {
  const to = process.env.SHOP_ALERT_EMAIL;
  if (!to || !process.env.MAIL_FROM_ADDRESS) {
    console.warn('[ops-alert] SHOP_ALERT_EMAIL or MAIL_FROM_ADDRESS is not configured');
    return false;
  }
  try {
    await sendMail({ to, subject: mail.subject, text: mail.lines.join('\n') });
    return true;
  } catch (error) {
    console.warn('[ops-alert] send failed', error instanceof Error ? error.name : 'UnknownError');
    await logAudit({
      action: 'ops.alert_mail',
      outcome: 'error',
      resource: 'ops_alert',
      detail: 'mail_send_failed',
      metadata: { kind: mail.kind },
    });
    return false;
  }
}
```

- [ ] **Step 4: テストが通ることを確かめる**

Run: `npx jest tests/unit/lib/ops/ops-alert-mail.test.ts`
Expected: PASS（10件）。日時の書式が `2026/10/05 9:00` でなく落ちたときは、今の `order-lifecycle-emails.ts` の `formatJst` と同じ書式であることを確かめ、テストの期待値の方を実際の書式に合わせる（同じ `Intl.DateTimeFormat` の設定なので、店への今のメールと同じ見え方になる）

Run: `npm run typecheck`
Expected: エラー0

- [ ] **Step 5: コミットの文を書く**

`.superpowers/sdd/2026-10-05-webhook-queue-operations/task-4-commit-msg.txt`:

```text
feat(ops): 店への知らせのメールの文面と送信を足す

溜まり・退避・定期処理の遅れ・署名不正・モード違い・支払いから作った注文の
6種類の文面を組み立て、SHOP_ALERT_EMAIL へ送る。お客様の情報は入れない。
送れなければ false を返し、種類だけを監査に残す。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

---

### Task 5: 点検（溜まり・退避・遅れ）

設計書 4-6。worker と見回りの終わりに同じ点検を行い、条件に当たれば店へ知らせる。種類ごとに1時間に1回まで。送れなければ送る権利を返す。点検の1つが失敗しても、残りの点検は続ける。

**Files:**
- Create: `src/lib/ops/ops-checks.ts`
- Test: `tests/unit/lib/ops/ops-checks.test.ts`

**Interfaces:**
- Consumes: Task 3 の `OpsStore`・`readWebhookBacklog`・`listUnnotifiedDeadEvents`・`markDeadEventsNotified`・`readHeartbeats`・`claimAlert`・`releaseAlert`、Task 4 の `backlogAlertMail`・`deadDigestMail`・`staleJobMail`・`OpsAlertMail`
- Produces（`src/lib/ops/ops-checks.ts`）:
  - `export const OPS_CHECK_LIMITS = { backlogAgeSeconds: 900, alertCooldownSeconds: 3600, deadDigestLimit: 50, staleAfterSeconds: { order_sweep: 7200, stripe_reconcile: 90000 } } as const`
  - `export type OpsCheckDeps = { store: OpsStore; send: (mail: OpsAlertMail) => Promise<boolean>; now: () => Date }`
  - `export type OpsCheckResult = { backlogAlerted: boolean; deadNotified: number; staleAlerted: Array<'order_sweep' | 'stripe_reconcile'>; failedChecks: Array<'backlog' | 'dead' | 'stale'> }`
  - `export async function runOpsChecks(deps: OpsCheckDeps): Promise<OpsCheckResult>`

- [ ] **Step 1: テストを書く**

`tests/unit/lib/ops/ops-checks.test.ts`:

```ts
import { OPS_CHECK_LIMITS, runOpsChecks } from '@/lib/ops/ops-checks';
import type { OpsStore } from '@/lib/ops/ops-store';
import type { OpsAlertMail } from '@/lib/ops/ops-alert-mail';

const NOW = new Date('2026-10-05T12:00:00Z');

type FakeState = {
  backlog: unknown[];
  dead: unknown[];
  heartbeats: unknown[];
  sentAt: Record<string, string | null>;
  failOn?: string;
};

/** DB の関数を、送る権利の時刻まで含めてまねる */
function fakeStore(state: FakeState) {
  const calls: Array<{ name: string; params?: Record<string, unknown> }> = [];
  const rpc = jest.fn(async (name: string, params?: Record<string, unknown>) => {
    calls.push({ name, params });
    if (state.failOn === name) return { data: null, error: { message: 'db down' } };
    switch (name) {
      case 'get_stripe_webhook_backlog':
        return { data: state.backlog, error: null };
      case 'list_unnotified_dead_stripe_webhook_events':
        return { data: state.dead.slice(0, Number(params?._limit)), error: null };
      case 'mark_stripe_webhook_dead_notified':
        return { data: (params?._event_ids as string[]).length, error: null };
      case 'get_ops_heartbeats':
        return { data: state.heartbeats, error: null };
      case 'claim_ops_alert': {
        const key = String(params?._alert_key);
        const previous = state.sentAt[key] ?? null;
        const cooldownMs = Number(params?._cooldown_seconds) * 1000;
        if (previous && NOW.getTime() - new Date(previous).getTime() < cooldownMs) {
          return { data: [{ claimed: false, claimed_at: null, previous_sent_at: previous }], error: null };
        }
        state.sentAt[key] = NOW.toISOString();
        return { data: [{ claimed: true, claimed_at: NOW.toISOString(), previous_sent_at: previous }], error: null };
      }
      case 'release_ops_alert': {
        const key = String(params?._alert_key);
        if (state.sentAt[key] === params?._claimed_at) state.sentAt[key] = (params?._previous_sent_at as string | null) ?? null;
        return { data: true, error: null };
      }
      default:
        return { data: null, error: null };
    }
  });
  return { store: { rpc } as unknown as OpsStore, calls };
}

function emptyState(): FakeState {
  return { backlog: [], dead: [], heartbeats: [], sentAt: {} };
}

function deadRow(n: number, total: number) {
  return {
    event_id: `evt_${n}`, event_type: 'refund.updated', last_error: 'unexpected_error',
    received_at: '2026-10-05T00:00:00Z', attempt_count: 9, dead_at: '2026-10-05T04:15:00Z', total_count: total,
  };
}

function heartbeat(job: string, lastSucceededAt: string | null) {
  return { job, last_succeeded_at: lastSucceededAt, last_failed_at: null, last_error_code: null };
}

describe('runOpsChecks', () => {
  it('何も無ければ知らせない', async () => {
    const send = jest.fn();
    const { store } = fakeStore(emptyState());
    await expect(runOpsChecks({ store, send, now: () => NOW })).resolves.toEqual({
      backlogAlerted: false, deadNotified: 0, staleAlerted: [], failedChecks: [],
    });
    expect(send).not.toHaveBeenCalled();
  });

  it('溜まりがあれば知らせ、1時間以内はもう知らせない', async () => {
    const state = emptyState();
    state.backlog = [{ processing_status: 'queued', event_count: 3, oldest_received_at: '2026-10-05T11:30:00Z', last_errors: [] }];
    const { store, calls } = fakeStore(state);
    const send = jest.fn<Promise<boolean>, [OpsAlertMail]>().mockResolvedValue(true);

    const first = await runOpsChecks({ store, send, now: () => NOW });
    expect(first.backlogAlerted).toBe(true);
    expect(send.mock.calls[0][0].kind).toBe('webhook_backlog');
    expect(calls.find((call) => call.name === 'get_stripe_webhook_backlog')?.params).toEqual({ _older_than_seconds: 900 });

    const second = await runOpsChecks({ store, send, now: () => NOW });
    expect(second.backlogAlerted).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('溜まりのメールが送れなければ、送る権利を返し、次の点検でまた送れる', async () => {
    const state = emptyState();
    state.backlog = [{ processing_status: 'failed', event_count: 1, oldest_received_at: '2026-10-05T11:00:00Z', last_errors: ['db_unavailable'] }];
    const { store, calls } = fakeStore(state);
    const send = jest.fn<Promise<boolean>, [OpsAlertMail]>().mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    expect((await runOpsChecks({ store, send, now: () => NOW })).backlogAlerted).toBe(false);
    expect(calls.some((call) => call.name === 'release_ops_alert')).toBe(true);
    expect((await runOpsChecks({ store, send, now: () => NOW })).backlogAlerted).toBe(true);
  });

  it('退避が60件でも1通、載せるのは50件まで。送れた50件に印を付ける', async () => {
    const state = emptyState();
    state.dead = Array.from({ length: 60 }, (_, i) => deadRow(i + 1, 60));
    const { store, calls } = fakeStore(state);
    const send = jest.fn<Promise<boolean>, [OpsAlertMail]>().mockResolvedValue(true);

    const result = await runOpsChecks({ store, send, now: () => NOW });
    expect(send).toHaveBeenCalledTimes(1);
    const mail = send.mock.calls[0][0];
    expect(mail.kind).toBe('webhook_dead');
    expect(mail.lines.filter((line) => line.startsWith('- evt_'))).toHaveLength(OPS_CHECK_LIMITS.deadDigestLimit);
    expect(mail.lines.join('\n')).toContain('ほかに 10 件');
    const mark = calls.find((call) => call.name === 'mark_stripe_webhook_dead_notified');
    expect((mark?.params?._event_ids as string[])).toHaveLength(50);
    expect(result.deadNotified).toBe(50);
  });

  it('退避のメールが送れなければ印を付けず、権利を返す', async () => {
    const state = emptyState();
    state.dead = [deadRow(1, 1)];
    const { store, calls } = fakeStore(state);
    const send = jest.fn<Promise<boolean>, [OpsAlertMail]>().mockResolvedValue(false);

    const result = await runOpsChecks({ store, send, now: () => NOW });
    expect(result.deadNotified).toBe(0);
    expect(calls.some((call) => call.name === 'mark_stripe_webhook_dead_notified')).toBe(false);
    expect(calls.some((call) => call.name === 'release_ops_alert')).toBe(true);
  });

  it.each([
    ['order_sweep', '2026-10-05T10:00:00Z', true],
    ['order_sweep', '2026-10-05T10:00:01Z', false],
    ['stripe_reconcile', '2026-10-04T11:00:00Z', true],
    ['stripe_reconcile', '2026-10-04T11:00:01Z', false],
  ])('%s の最後の成功が %s なら、遅れの知らせは %s', async (job, lastSucceededAt, expected) => {
    const state = emptyState();
    state.heartbeats = [heartbeat(job, lastSucceededAt)];
    const { store } = fakeStore(state);
    const send = jest.fn<Promise<boolean>, [OpsAlertMail]>().mockResolvedValue(true);

    const result = await runOpsChecks({ store, send, now: () => NOW });
    expect(result.staleAlerted.includes(job as 'order_sweep' | 'stripe_reconcile')).toBe(expected);
  });

  it('一度も成功していない定期処理は、遅れの対象にしない（開店前）', async () => {
    const state = emptyState();
    state.heartbeats = [heartbeat('order_sweep', null), heartbeat('webhook_worker', '2026-10-05T11:59:00Z')];
    const { store } = fakeStore(state);
    const send = jest.fn();

    const result = await runOpsChecks({ store, send, now: () => NOW });
    expect(result.staleAlerted).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });

  it('溜まりの読み出しが失敗しても、退避と遅れの点検は続ける', async () => {
    const state = emptyState();
    state.failOn = 'get_stripe_webhook_backlog';
    state.dead = [deadRow(1, 1)];
    state.heartbeats = [heartbeat('order_sweep', '2026-10-05T09:00:00Z')];
    const { store } = fakeStore(state);
    const send = jest.fn<Promise<boolean>, [OpsAlertMail]>().mockResolvedValue(true);

    const result = await runOpsChecks({ store, send, now: () => NOW });
    expect(result.failedChecks).toEqual(['backlog']);
    expect(result.deadNotified).toBe(1);
    expect(result.staleAlerted).toEqual(['order_sweep']);
  });
});
```

- [ ] **Step 2: テストが落ちることを確かめる**

Run: `npx jest tests/unit/lib/ops/ops-checks.test.ts`
Expected: FAIL（`@/lib/ops/ops-checks` が無い）

- [ ] **Step 3: 点検を作る**

`src/lib/ops/ops-checks.ts`:

```ts
import {
  claimAlert,
  listUnnotifiedDeadEvents,
  markDeadEventsNotified,
  readHeartbeats,
  readWebhookBacklog,
  releaseAlert,
  type OpsAlertKey,
  type OpsStore,
} from '@/lib/ops/ops-store';
import {
  backlogAlertMail,
  deadDigestMail,
  staleJobMail,
  type OpsAlertMail,
} from '@/lib/ops/ops-alert-mail';

/**
 * 点検（設計書 2026-10-05 グループ B の 4-6）。worker と見回りの終わりに同じ点検を行う。
 * - 溜まり: 受け取ってから15分以上たって完了していない知らせ
 * - 退避: まだ知らせていない退避（まとめて1通、50件まで）
 * - 遅れ: 見回りは最後の成功から2時間、照合は25時間（一度も成功していない処理は対象にしない）
 * 種類ごとに1時間に1回まで。送れなければ送る権利を返す。点検の1つが失敗しても、残りは続ける。
 * アプリや DB ごと止まったときは知らせが出ない（外からの見張りは入れないと決めた）。
 */
export const OPS_CHECK_LIMITS = {
  backlogAgeSeconds: 15 * 60,
  alertCooldownSeconds: 60 * 60,
  deadDigestLimit: 50,
  staleAfterSeconds: { order_sweep: 2 * 60 * 60, stripe_reconcile: 25 * 60 * 60 },
} as const;

export type OpsCheckDeps = {
  store: OpsStore;
  send: (mail: OpsAlertMail) => Promise<boolean>;
  now: () => Date;
};

export type OpsCheckResult = {
  backlogAlerted: boolean;
  deadNotified: number;
  staleAlerted: Array<'order_sweep' | 'stripe_reconcile'>;
  failedChecks: Array<'backlog' | 'dead' | 'stale'>;
};

const STALE_JOBS = ['order_sweep', 'stripe_reconcile'] as const;

async function sendOnce(deps: OpsCheckDeps, key: OpsAlertKey, mail: () => OpsAlertMail): Promise<boolean> {
  const claim = await claimAlert(deps.store, key, OPS_CHECK_LIMITS.alertCooldownSeconds);
  if (!claim) return false;
  if (await deps.send(mail())) return true;
  await releaseAlert(deps.store, claim);
  return false;
}

function logFailure(check: string, error: unknown): void {
  console.error(`[ops-checks] ${check} check failed`, error instanceof Error ? error.name : 'UnknownError');
}

export async function runOpsChecks(deps: OpsCheckDeps): Promise<OpsCheckResult> {
  const result: OpsCheckResult = { backlogAlerted: false, deadNotified: 0, staleAlerted: [], failedChecks: [] };

  try {
    const backlog = await readWebhookBacklog(deps.store, OPS_CHECK_LIMITS.backlogAgeSeconds);
    if (backlog.length > 0) {
      result.backlogAlerted = await sendOnce(deps, 'webhook_backlog', () => backlogAlertMail(backlog));
    }
  } catch (error) {
    result.failedChecks.push('backlog');
    logFailure('backlog', error);
  }

  try {
    const { events, total } = await listUnnotifiedDeadEvents(deps.store, OPS_CHECK_LIMITS.deadDigestLimit);
    if (events.length > 0) {
      const claim = await claimAlert(deps.store, 'webhook_dead', OPS_CHECK_LIMITS.alertCooldownSeconds);
      if (claim) {
        if (await deps.send(deadDigestMail(events, total))) {
          result.deadNotified = await markDeadEventsNotified(deps.store, events.map((event) => event.eventId));
        } else {
          await releaseAlert(deps.store, claim);
        }
      }
    }
  } catch (error) {
    result.failedChecks.push('dead');
    logFailure('dead', error);
  }

  try {
    const heartbeats = await readHeartbeats(deps.store);
    for (const job of STALE_JOBS) {
      const lastSucceededAt = heartbeats[job]?.lastSucceededAt;
      if (!lastSucceededAt) continue;
      const elapsedMs = deps.now().getTime() - lastSucceededAt.getTime();
      if (elapsedMs < OPS_CHECK_LIMITS.staleAfterSeconds[job] * 1000) continue;
      if (await sendOnce(deps, `job_stale_${job}`, () => staleJobMail(job, lastSucceededAt))) {
        result.staleAlerted.push(job);
      }
    }
  } catch (error) {
    result.failedChecks.push('stale');
    logFailure('stale', error);
  }

  return result;
}
```

- [ ] **Step 4: テストが通ることを確かめる**

Run: `npx jest tests/unit/lib/ops/ops-checks.test.ts`
Expected: PASS（11件）

Run: `npm run typecheck`
Expected: エラー0

- [ ] **Step 5: コミットの文を書く**

`.superpowers/sdd/2026-10-05-webhook-queue-operations/task-5-commit-msg.txt`:

```text
feat(ops): 溜まり・退避・定期処理の遅れを点検して店へ知らせる

worker と見回りの終わりに呼ぶ点検を足した。種類ごとに1時間に1回まで送り、
送れなければ送る権利を返す。退避はまとめて1通（50件まで）にし、送れた分に
印を付ける。一度も成功していない定期処理は遅れの対象にしない。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

---

### Task 6: worker（約45秒まで続けて処理し、記録して点検する）

設計書 3-1・3-2・4-6。worker を「1回の起動で取り出せる知らせが無くなるか約45秒たつまで処理する」形にする（R-35）。処理の終わりに最後の成功を記録し、点検（Task 5）を行う。毎分の定期処理と、受け取り口の `after()`（Task 7）の両方から同じ関数を呼ぶ。

**Files:**
- Create: `src/lib/stripe/webhook-drain.ts`（取り出して処理する繰り返し。外の関数は差し替えられる）
- Create: `src/lib/stripe/webhook-worker.ts`（1回の起動の組み立て）
- Modify: `src/app/api/cron/process-stripe-webhooks/route.ts`（全体）
- Create: `tests/unit/lib/stripe/webhook-drain.test.ts`、`tests/unit/lib/stripe/webhook-worker.test.ts`
- Modify: `tests/unit/api/cron/process-stripe-webhooks-route.test.ts`（全体）

**Interfaces:**
- Consumes: Task 3 の `claimWebhookEvent`・`completeWebhookEvent`・`failWebhookEvent`・`webhookErrorCategory`・`webhookFailureCause`・`InvalidWebhookPayloadError`・`recordHeartbeat`・`OpsStore`、Task 4 の `sendOpsAlertMail`、Task 5 の `runOpsChecks`・`OpsCheckResult`
- Produces:
  - `src/lib/stripe/webhook-drain.ts`: `export type DrainResult = { processed: number; failed: number; stoppedBy: 'empty' | 'budget' | 'claim_error' }`、`export function toStripeEvent(claim: ClaimedWebhookEvent): Stripe.Event`（壊れていれば `InvalidWebhookPayloadError`）、`export async function drainWebhookQueue(deps: { store: WebhookEventStore; process: (event: Stripe.Event) => Promise<void>; now: () => number; budgetMs: number }): Promise<DrainResult>`
  - `src/lib/stripe/webhook-worker.ts`: `export const WORKER_TIME_BUDGET_MS = 45_000`、`export type WorkerRunResult = DrainResult & { checks: OpsCheckResult }`、`export async function runWebhookWorker(options: { requestUrl: string; budgetMs?: number }): Promise<WorkerRunResult>`
  - worker の入口: 200 `{ processed, failed, stoppedBy }`、取り出しの DB の失敗は 502

- [ ] **Step 1: 繰り返しのテストを書く**

`tests/unit/lib/stripe/webhook-drain.test.ts`:

```ts
import { drainWebhookQueue, toStripeEvent } from '@/lib/stripe/webhook-drain';
import { InvalidWebhookPayloadError, type WebhookEventStore } from '@/lib/stripe/webhook-events';

function claimRow(id: string, payload?: Record<string, unknown>) {
  return {
    event_id: id,
    event_type: 'checkout.session.completed',
    raw_payload: payload ?? { id, type: 'checkout.session.completed', data: { object: { id: `cs_${id}` } } },
    claim_token: `token-${id}`,
  };
}

/** claim は順に返し、尽きたら空。complete・fail は成功を返す */
function fakeStore(claims: unknown[]) {
  const queue = [...claims];
  const rpc = jest.fn(async (name: string) => {
    if (name === 'claim_stripe_webhook_event') return { data: queue.length > 0 ? [queue.shift()] : [], error: null };
    return { data: true, error: null };
  });
  return { store: { rpc } as unknown as WebhookEventStore, rpc };
}

describe('drainWebhookQueue', () => {
  beforeEach(() => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('取り出せる知らせが無くなるまで続けて処理し、1件ずつ完了にする', async () => {
    const { store, rpc } = fakeStore([claimRow('evt_1'), claimRow('evt_2')]);
    const process = jest.fn().mockResolvedValue(undefined);

    const result = await drainWebhookQueue({ store, process, now: () => 0, budgetMs: 45_000 });

    expect(result).toEqual({ processed: 2, failed: 0, stoppedBy: 'empty' });
    expect(process).toHaveBeenCalledTimes(2);
    expect(rpc).toHaveBeenCalledWith('complete_stripe_webhook_event', { _event_id: 'evt_1', _claim_token: 'token-evt_1' });
    expect(rpc).toHaveBeenCalledWith('complete_stripe_webhook_event', { _event_id: 'evt_2', _claim_token: 'token-evt_2' });
  });

  it('時間の予算を使い切ったら、新しく取り出さずに止める', async () => {
    const { store } = fakeStore([claimRow('evt_1'), claimRow('evt_2'), claimRow('evt_3')]);
    let clock = 0;
    const process = jest.fn(async () => {
      clock += 30_000;
    });

    const result = await drainWebhookQueue({ store, process, now: () => clock, budgetMs: 45_000 });

    expect(result).toEqual({ processed: 2, failed: 0, stoppedBy: 'budget' });
    expect(process).toHaveBeenCalledTimes(2);
  });

  it('処理に失敗した知らせは失敗として記録し、次の知らせへ進む', async () => {
    const { store, rpc } = fakeStore([claimRow('evt_1'), claimRow('evt_2')]);
    const process = jest.fn()
      .mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'stripe_unavailable' }))
      .mockResolvedValueOnce(undefined);

    const result = await drainWebhookQueue({ store, process, now: () => 0, budgetMs: 45_000 });

    expect(result).toEqual({ processed: 1, failed: 1, stoppedBy: 'empty' });
    expect(rpc).toHaveBeenCalledWith('fail_stripe_webhook_event', {
      _event_id: 'evt_1', _claim_token: 'token-evt_1', _error: 'stripe_unavailable',
    });
  });

  it('保存した中身が壊れていれば処理へ渡さず、invalid_payload で失敗にする', async () => {
    const { store, rpc } = fakeStore([claimRow('evt_1', { id: 'evt_other', type: 'checkout.session.completed', data: { object: {} } })]);
    const process = jest.fn();

    const result = await drainWebhookQueue({ store, process, now: () => 0, budgetMs: 45_000 });

    expect(process).not.toHaveBeenCalled();
    expect(result).toEqual({ processed: 0, failed: 1, stoppedBy: 'empty' });
    expect(rpc).toHaveBeenCalledWith('fail_stripe_webhook_event', {
      _event_id: 'evt_1', _claim_token: 'token-evt_1', _error: 'invalid_payload',
    });
  });

  it('取り出しの DB の失敗では止め、claim_error を返す', async () => {
    const rpc = jest.fn().mockResolvedValue({ data: null, error: { message: 'db down' } });
    const result = await drainWebhookQueue({
      store: { rpc } as unknown as WebhookEventStore, process: jest.fn(), now: () => 0, budgetMs: 45_000,
    });
    expect(result).toEqual({ processed: 0, failed: 0, stoppedBy: 'claim_error' });
  });

  it('失敗の記録そのものが失敗しても、繰り返しは続ける', async () => {
    const queue = [claimRow('evt_1'), claimRow('evt_2')];
    const rpc = jest.fn(async (name: string) => {
      if (name === 'claim_stripe_webhook_event') return { data: queue.length > 0 ? [queue.shift()] : [], error: null };
      if (name === 'fail_stripe_webhook_event') return { data: null, error: { message: 'db down' } };
      return { data: true, error: null };
    });
    const process = jest.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(undefined);

    const result = await drainWebhookQueue({
      store: { rpc } as unknown as WebhookEventStore, process, now: () => 0, budgetMs: 45_000,
    });

    expect(result).toEqual({ processed: 1, failed: 1, stoppedBy: 'empty' });
  });

  it('toStripeEvent は番号・種類・data.object がそろったときだけ返す', () => {
    const good = { eventId: 'evt_1', eventType: 'refund.updated', claimToken: 't', rawPayload: { id: 'evt_1', type: 'refund.updated', data: { object: { id: 're_1' } } } };
    expect(toStripeEvent(good)).toEqual(good.rawPayload);
    expect(() => toStripeEvent({ ...good, rawPayload: { ...good.rawPayload, type: 'other' } })).toThrow(InvalidWebhookPayloadError);
    expect(() => toStripeEvent({ ...good, rawPayload: { id: 'evt_1', type: 'refund.updated', data: {} } })).toThrow(InvalidWebhookPayloadError);
  });
});
```

- [ ] **Step 2: 1回の起動のテストを書く**

`tests/unit/lib/stripe/webhook-worker.test.ts`:

```ts
const mockStore = { rpc: jest.fn() };
jest.mock('@/lib/supabase/server', () => ({
  createServiceRoleClient: jest.fn(async () => mockStore),
}));
const mockDrain = jest.fn();
jest.mock('@/lib/stripe/webhook-drain', () => ({
  drainWebhookQueue: (...args: unknown[]) => mockDrain(...args),
}));
const mockProcess = jest.fn();
jest.mock('@/lib/stripe/webhook-processor', () => ({
  processStripeWebhookEvent: (...args: unknown[]) => mockProcess(...args),
}));
const mockRecordHeartbeat = jest.fn();
jest.mock('@/lib/ops/ops-store', () => ({
  recordHeartbeat: (...args: unknown[]) => mockRecordHeartbeat(...args),
}));
const mockRunOpsChecks = jest.fn();
jest.mock('@/lib/ops/ops-checks', () => ({
  runOpsChecks: (...args: unknown[]) => mockRunOpsChecks(...args),
}));
const mockSendOpsAlertMail = jest.fn();
jest.mock('@/lib/ops/ops-alert-mail', () => ({
  sendOpsAlertMail: (...args: unknown[]) => mockSendOpsAlertMail(...args),
}));

import { runWebhookWorker, WORKER_TIME_BUDGET_MS } from '@/lib/stripe/webhook-worker';

const CHECKS = { backlogAlerted: false, deadNotified: 0, staleAlerted: [], failedChecks: [] };

describe('runWebhookWorker', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRunOpsChecks.mockResolvedValue(CHECKS);
    mockRecordHeartbeat.mockResolvedValue(undefined);
  });

  it('約45秒の予算で処理し、成功を記録して点検する', async () => {
    mockDrain.mockResolvedValue({ processed: 2, failed: 0, stoppedBy: 'empty' });

    const result = await runWebhookWorker({ requestUrl: 'http://localhost/api/cron/process-stripe-webhooks' });

    expect(WORKER_TIME_BUDGET_MS).toBe(45_000);
    expect(mockDrain).toHaveBeenCalledWith(expect.objectContaining({ store: mockStore, budgetMs: 45_000 }));
    expect(mockRecordHeartbeat).toHaveBeenCalledWith(mockStore, 'webhook_worker', true, null);
    expect(mockRunOpsChecks).toHaveBeenCalledWith(expect.objectContaining({ store: mockStore }));
    expect(result).toEqual({ processed: 2, failed: 0, stoppedBy: 'empty', checks: CHECKS });
  });

  it('知らせの処理は、受け取り口の住所の空の要求で監査する', async () => {
    mockDrain.mockResolvedValue({ processed: 0, failed: 0, stoppedBy: 'empty' });
    await runWebhookWorker({ requestUrl: 'http://localhost/api/cron/process-stripe-webhooks' });
    const { process } = mockDrain.mock.calls[0][0] as { process: (event: unknown) => Promise<void> };
    await process({ id: 'evt_1' });
    const auditRequest = mockProcess.mock.calls[0][1] as Request;
    expect(new URL(auditRequest.url).pathname).toBe('/api/webhook/stripe');
  });

  it('取り出しの DB の失敗は、失敗（db_unavailable）として記録する', async () => {
    mockDrain.mockResolvedValue({ processed: 0, failed: 0, stoppedBy: 'claim_error' });
    await runWebhookWorker({ requestUrl: 'http://localhost/x' });
    expect(mockRecordHeartbeat).toHaveBeenCalledWith(mockStore, 'webhook_worker', false, 'db_unavailable');
  });

  it('記録に失敗しても点検は行う', async () => {
    mockDrain.mockResolvedValue({ processed: 1, failed: 0, stoppedBy: 'empty' });
    mockRecordHeartbeat.mockRejectedValue(new Error('db down'));
    jest.spyOn(console, 'error').mockImplementation(() => {});
    await expect(runWebhookWorker({ requestUrl: 'http://localhost/x' })).resolves.toMatchObject({ processed: 1 });
    expect(mockRunOpsChecks).toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: worker の入口のテストを書き直す**

`tests/unit/api/cron/process-stripe-webhooks-route.test.ts` を次の内容に置き換える:

```ts
jest.mock('next/server', () => {
  const actual = jest.requireActual('next/server');
  return {
    ...actual,
    NextResponse: {
      json: (body: unknown, init?: { status?: number }) => ({
        status: init?.status ?? 200,
        body,
      }),
    },
  };
});

const mockRunWebhookWorker = jest.fn();
jest.mock('@/lib/stripe/webhook-worker', () => ({
  runWebhookWorker: (...args: unknown[]) => mockRunWebhookWorker(...args),
}));

import { POST } from '@/app/api/cron/process-stripe-webhooks/route';

const CHECKS = { backlogAlerted: false, deadNotified: 0, staleAlerted: [], failedChecks: [] };
// Task 8 で32文字以上を求めるので、はじめから32文字以上にしておく
const CRON_SECRET = 'cron-secret-for-unit-tests-0123456789';

function request(authorization = `Bearer ${CRON_SECRET}`): Request {
  return new Request('http://localhost/api/cron/process-stripe-webhooks', {
    method: 'POST',
    headers: { authorization },
  });
}

describe('POST /api/cron/process-stripe-webhooks', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.CRON_SECRET = CRON_SECRET;
    mockRunWebhookWorker.mockResolvedValue({ processed: 2, failed: 1, stoppedBy: 'empty', checks: CHECKS });
  });

  it('認証されない呼出しと未設定secretを拒否し、worker を動かさない', async () => {
    expect((await POST(request(`Bearer ${CRON_SECRET.slice(0, -1)}X`))).status).toBe(401);
    delete process.env.CRON_SECRET;
    expect((await POST(request())).status).toBe(401);
    expect(mockRunWebhookWorker).not.toHaveBeenCalled();
  });

  it('worker を1回動かし、件数と止まった理由を返す', async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ processed: 2, failed: 1, stoppedBy: 'empty' });
    expect(mockRunWebhookWorker).toHaveBeenCalledWith({ requestUrl: 'http://localhost/api/cron/process-stripe-webhooks' });
  });

  it('取り出しの DB 障害は成功扱いにしない（502）', async () => {
    mockRunWebhookWorker.mockResolvedValue({ processed: 0, failed: 0, stoppedBy: 'claim_error', checks: CHECKS });
    const response = await POST(request());
    expect(response.status).toBe(502);
  });
});
```

- [ ] **Step 4: テストが落ちることを確かめる**

Run: `npx jest tests/unit/lib/stripe/webhook-drain.test.ts tests/unit/lib/stripe/webhook-worker.test.ts tests/unit/api/cron/process-stripe-webhooks-route.test.ts`
Expected: FAIL（`@/lib/stripe/webhook-drain`・`@/lib/stripe/webhook-worker` が無い）

- [ ] **Step 5: 繰り返しを作る**

`src/lib/stripe/webhook-drain.ts`:

```ts
import type Stripe from 'stripe';
import {
  claimWebhookEvent,
  completeWebhookEvent,
  failWebhookEvent,
  InvalidWebhookPayloadError,
  webhookErrorCategory,
  webhookFailureCause,
  type ClaimedWebhookEvent,
  type WebhookEventStore,
} from '@/lib/stripe/webhook-events';

/**
 * キューから知らせを取り出して処理する繰り返し（設計書 2026-10-05 グループ B の 3-1・3-2）。
 * 取り出せる知らせが無くなるか、時間の予算を使い切るまで1件ずつ処理する（R-35）。
 * 1件の失敗は失敗として記録して次へ進む。同時に動いても、DB の取り出し（SKIP LOCKED と担当の印）で二重に取らない。
 */
export type DrainResult = { processed: number; failed: number; stoppedBy: 'empty' | 'budget' | 'claim_error' };

export type DrainDeps = {
  store: WebhookEventStore;
  process: (event: Stripe.Event) => Promise<void>;
  now: () => number;
  budgetMs: number;
};

export function toStripeEvent(claim: ClaimedWebhookEvent): Stripe.Event {
  const payload = claim.rawPayload;
  const data = payload.data;
  if (
    payload.id !== claim.eventId
    || payload.type !== claim.eventType
    || !data
    || typeof data !== 'object'
    || !('object' in data)
  ) {
    throw new InvalidWebhookPayloadError();
  }
  return payload as unknown as Stripe.Event;
}

export async function drainWebhookQueue(deps: DrainDeps): Promise<DrainResult> {
  const startedAt = deps.now();
  const result: DrainResult = { processed: 0, failed: 0, stoppedBy: 'budget' };

  while (deps.now() - startedAt < deps.budgetMs) {
    let claim: ClaimedWebhookEvent | null;
    try {
      claim = await claimWebhookEvent(deps.store);
    } catch (error) {
      console.error('[stripe-webhook-worker] Claim failed', webhookErrorCategory(error));
      return { ...result, stoppedBy: 'claim_error' };
    }
    if (!claim) return { ...result, stoppedBy: 'empty' };

    try {
      await deps.process(toStripeEvent(claim));
      await completeWebhookEvent(deps.store, claim.eventId, claim.claimToken);
      result.processed += 1;
    } catch (error) {
      result.failed += 1;
      console.error('[stripe-webhook-worker] Event processing failed', claim.eventId, webhookFailureCause(error));
      try {
        await failWebhookEvent(deps.store, claim.eventId, claim.claimToken, error);
      } catch (stateError) {
        console.error(
          '[stripe-webhook-worker] Failed to persist event failure',
          claim.eventId,
          webhookErrorCategory(stateError),
        );
      }
    }
  }
  return result;
}
```

- [ ] **Step 6: 1回の起動を作る**

`src/lib/stripe/webhook-worker.ts`:

```ts
import { NextRequest } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { processStripeWebhookEvent } from '@/lib/stripe/webhook-processor';
import type { WebhookEventStore } from '@/lib/stripe/webhook-events';
import { drainWebhookQueue, type DrainResult } from '@/lib/stripe/webhook-drain';
import { recordHeartbeat, type OpsStore } from '@/lib/ops/ops-store';
import { runOpsChecks, type OpsCheckResult } from '@/lib/ops/ops-checks';
import { sendOpsAlertMail } from '@/lib/ops/ops-alert-mail';

/** 1回の起動で続けて処理する時間（設計書 2026-10-05 グループ B の 3-1。入口の maxDuration 60 秒に余裕を持たせる） */
export const WORKER_TIME_BUDGET_MS = 45_000;

export type WorkerRunResult = DrainResult & { checks: OpsCheckResult };

/**
 * worker の1回の起動。毎分の定期処理と、受け取り口の after() の両方から呼ぶ。
 * 取り出して処理し、最後の成功を記録し、点検して店へ知らせる（設計書 4-6）。
 */
export async function runWebhookWorker(options: { requestUrl: string; budgetMs?: number }): Promise<WorkerRunResult> {
  const store = (await createServiceRoleClient()) as unknown as WebhookEventStore & OpsStore;
  // 監査の IP・User-Agent を定期処理のものと誤らないよう、空のヘッダーの要求で処理する（今までどおり）
  const auditRequest = new NextRequest(new URL('/api/webhook/stripe', options.requestUrl));

  const drain = await drainWebhookQueue({
    store,
    process: (event) => processStripeWebhookEvent(event, auditRequest),
    now: () => Date.now(),
    budgetMs: options.budgetMs ?? WORKER_TIME_BUDGET_MS,
  });

  const claimFailed = drain.stoppedBy === 'claim_error';
  try {
    await recordHeartbeat(store, 'webhook_worker', !claimFailed, claimFailed ? 'db_unavailable' : null);
  } catch (error) {
    console.error('[stripe-webhook-worker] Failed to record heartbeat', error instanceof Error ? error.name : 'UnknownError');
  }

  const checks = await runOpsChecks({ store, send: sendOpsAlertMail, now: () => new Date() });
  return { ...drain, checks };
}
```

`src/app/api/cron/process-stripe-webhooks/route.ts` を次の内容に置き換える（合言葉の確かめ方は Task 8 でそろえる）:

```ts
import { NextResponse } from 'next/server';
import { authorizeCronBearer } from '@/lib/legal-archive/cron-auth';
import { runWebhookWorker } from '@/lib/stripe/webhook-worker';

export const maxDuration = 60;

/** 毎分の定期処理（pg_cron＋pg_net）から呼ばれる worker の入口（設計書 2026-10-05 グループ B の 3-1・4-1） */
export async function POST(request: Request): Promise<NextResponse> {
  if (!authorizeCronBearer(request.headers.get('authorization'), process.env.CRON_SECRET)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const result = await runWebhookWorker({ requestUrl: request.url });
  return NextResponse.json(
    { processed: result.processed, failed: result.failed, stoppedBy: result.stoppedBy },
    { status: result.stoppedBy === 'claim_error' ? 502 : 200 },
  );
}
```

- [ ] **Step 7: テストが通ることを確かめる**

Run: `npx jest tests/unit/lib/stripe/webhook-drain.test.ts tests/unit/lib/stripe/webhook-worker.test.ts tests/unit/api/cron/process-stripe-webhooks-route.test.ts`
Expected: PASS（7＋4＋3＝14件）

Run: `npm run typecheck`
Expected: エラー0

- [ ] **Step 8: コミットの文を書く**

`.superpowers/sdd/2026-10-05-webhook-queue-operations/task-6-commit-msg.txt`:

```text
feat(stripe): worker が1回の起動で約45秒まで続けて処理し、記録して点検する

キューから取り出せる知らせが無くなるか約45秒たつまで1件ずつ処理する（R-35）。
1件の失敗は原因の記号で記録して次へ進む。処理の終わりに最後の成功を記録し、
溜まり・退避・遅れを点検する。毎分の定期処理と受け取り口の両方から呼べる形にした。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

---

### Task 7: 受け取り口（署名不正を数える・13種だけ保存・モードを確かめる・その場で worker）

設計書 3-1・5-1・5-2。署名の欠落・不一致は400で断り、監査ログに1件ずつ書かずに数える（R-05）。13種以外とモードの違う知らせは保存せずに200を返す。保存したら200を返し、`after()` で worker を1回動かす（R-07）。

**Files:**
- Create: `src/lib/stripe/handled-webhook-events.ts`、`src/lib/ops/webhook-receiver-signals.ts`
- Modify: `src/app/api/webhook/stripe/route.ts`（全体）
- Create: `tests/unit/lib/stripe/handled-webhook-events.test.ts`、`tests/unit/lib/ops/webhook-receiver-signals.test.ts`
- Modify: `tests/unit/api/webhook/stripe-ingest.test.ts`

**Interfaces:**
- Consumes: Task 3 の `bumpSignal`・`claimAlert`・`releaseAlert`・`OpsStore`、Task 4 の `signatureAlertMail`・`modeMismatchMail`・`sendOpsAlertMail`・`OpsAlertMail`、Task 6 の `runWebhookWorker`
- Produces:
  - `src/lib/stripe/handled-webhook-events.ts`: `export const HANDLED_STRIPE_EVENT_TYPES`（13種の読み取り専用の配列）、`export function isHandledStripeEventType(type: string): boolean`、`export function stripeKeyLivemode(secretKey: string | undefined): boolean | null`
  - `src/lib/ops/webhook-receiver-signals.ts`: `export const SIGNATURE_ALERT = { key: 'webhook_signature_invalid', windowSeconds: 600, threshold: 5, cooldownSeconds: 3600 }`、`export const MODE_MISMATCH_ALERT = { key: 'webhook_mode_mismatch', windowSeconds: 3600, threshold: 1, cooldownSeconds: 3600 }`、`export type SignalDeps = { store: OpsStore; send: (mail: OpsAlertMail) => Promise<boolean> }`、`recordSignatureFailure(deps): Promise<void>`、`recordModeMismatch(deps, eventLivemode: boolean, keyLivemode: boolean | null): Promise<void>`（どちらも例外を外へ出さない）
  - 受け取り口: 署名の欠落・不一致 400、13種以外 200 `{ received: true, ignored: true }`、モード違い 200 `{ received: true, ignored: true }`、保存 200 `{ received: true, duplicate }`、保存の失敗 500。`export const maxDuration = 60`

- [ ] **Step 1: 13種とモードのテストを書く**

`tests/unit/lib/stripe/handled-webhook-events.test.ts`:

```ts
import fs from 'node:fs';
import path from 'node:path';
import {
  HANDLED_STRIPE_EVENT_TYPES,
  isHandledStripeEventType,
  stripeKeyLivemode,
} from '@/lib/stripe/handled-webhook-events';

describe('受け取り口が保存する知らせの種類', () => {
  it('13種だけ', () => {
    expect([...HANDLED_STRIPE_EVENT_TYPES].sort()).toEqual([
      'charge.refunded',
      'checkout.session.async_payment_failed',
      'checkout.session.async_payment_succeeded',
      'checkout.session.completed',
      'checkout.session.expired',
      'payment_intent.payment_failed',
      'payment_intent.succeeded',
      'payout.failed',
      'payout.paid',
      'payout.reconciliation_completed',
      'refund.created',
      'refund.failed',
      'refund.updated',
    ]);
    expect(isHandledStripeEventType('checkout.session.completed')).toBe(true);
    expect(isHandledStripeEventType('customer.created')).toBe(false);
  });

  it('処理する側（webhook-processor）が分ける種類と、13種が一致する', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src/lib/stripe/webhook-processor.ts'), 'utf8');
    const cases = new Set([...source.matchAll(/case '([a-z_.]+)':/g)].map((match) => match[1]));
    expect([...cases].sort()).toEqual([...HANDLED_STRIPE_EVENT_TYPES].sort());
  });
});

describe('stripeKeyLivemode', () => {
  it.each([
    ['sk_live_abc', true],
    ['rk_live_abc', true],
    ['sk_test_abc', false],
    ['rk_test_abc', false],
    ['pk_live_abc', null],
    ['', null],
    [undefined, null],
  ])('%s は %s', (key, expected) => {
    expect(stripeKeyLivemode(key)).toBe(expected);
  });
});
```

- [ ] **Step 2: 数えて知らせる仕組みのテストを書く**

`tests/unit/lib/ops/webhook-receiver-signals.test.ts`:

```ts
import {
  MODE_MISMATCH_ALERT,
  SIGNATURE_ALERT,
  recordModeMismatch,
  recordSignatureFailure,
} from '@/lib/ops/webhook-receiver-signals';
import type { OpsStore } from '@/lib/ops/ops-store';
import type { OpsAlertMail } from '@/lib/ops/ops-alert-mail';

function store(responses: { bump?: number; claimed?: boolean; bumpError?: boolean }) {
  const rpc = jest.fn(async (name: string) => {
    if (name === 'bump_ops_signal') {
      return responses.bumpError ? { data: null, error: { message: 'db down' } } : { data: responses.bump ?? 1, error: null };
    }
    if (name === 'claim_ops_alert') {
      return responses.claimed
        ? { data: [{ claimed: true, claimed_at: '2026-10-05T00:00:00Z', previous_sent_at: null }], error: null }
        : { data: [{ claimed: false, claimed_at: null, previous_sent_at: '2026-10-05T00:00:00Z' }], error: null };
    }
    return { data: true, error: null };
  });
  return { store: { rpc } as unknown as OpsStore, rpc };
}

describe('受け取り口の署名不正とモード違い', () => {
  it('数の決まり: 署名不正は10分に5件、モード違いは1件でも。どちらも1時間に1回まで', () => {
    expect(SIGNATURE_ALERT).toEqual({ key: 'webhook_signature_invalid', windowSeconds: 600, threshold: 5, cooldownSeconds: 3600 });
    expect(MODE_MISMATCH_ALERT).toEqual({ key: 'webhook_mode_mismatch', windowSeconds: 3600, threshold: 1, cooldownSeconds: 3600 });
  });

  it('署名不正が4件目までは数えるだけで、送る権利も取らない', async () => {
    const { store: s, rpc } = store({ bump: 4 });
    const send = jest.fn();
    await recordSignatureFailure({ store: s, send });
    expect(rpc).toHaveBeenCalledWith('bump_ops_signal', { _alert_key: 'webhook_signature_invalid', _window_seconds: 600 });
    expect(rpc).not.toHaveBeenCalledWith('claim_ops_alert', expect.anything());
    expect(send).not.toHaveBeenCalled();
  });

  it('5件目で権利が取れれば1回だけ送る', async () => {
    const { store: s } = store({ bump: 5, claimed: true });
    const send = jest.fn<Promise<boolean>, [OpsAlertMail]>().mockResolvedValue(true);
    await recordSignatureFailure({ store: s, send });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].kind).toBe('webhook_signature_invalid');
    expect(send.mock.calls[0][0].lines.join('\n')).toContain('5件');
  });

  it('1時間以内に送っていれば送らない', async () => {
    const { store: s } = store({ bump: 9, claimed: false });
    const send = jest.fn();
    await recordSignatureFailure({ store: s, send });
    expect(send).not.toHaveBeenCalled();
  });

  it('送れなければ権利を返す', async () => {
    const { store: s, rpc } = store({ bump: 5, claimed: true });
    await recordSignatureFailure({ store: s, send: jest.fn().mockResolvedValue(false) });
    expect(rpc).toHaveBeenCalledWith('release_ops_alert', expect.objectContaining({ _alert_key: 'webhook_signature_invalid' }));
  });

  it('モード違いは1件目で送り、届いたモードと鍵のモードを書く', async () => {
    const { store: s } = store({ bump: 1, claimed: true });
    const send = jest.fn<Promise<boolean>, [OpsAlertMail]>().mockResolvedValue(true);
    await recordModeMismatch({ store: s, send }, false, true);
    expect(send.mock.calls[0][0].kind).toBe('webhook_mode_mismatch');
    expect(send.mock.calls[0][0].lines.join('\n')).toContain('届いた知らせ: テスト、このアプリの鍵: 本番');
  });

  it('DB の失敗は外へ出さない（受け取り口の返事を壊さない）', async () => {
    const { store: s } = store({ bumpError: true });
    jest.spyOn(console, 'error').mockImplementation(() => {});
    await expect(recordSignatureFailure({ store: s, send: jest.fn() })).resolves.toBeUndefined();
    await expect(recordModeMismatch({ store: s, send: jest.fn() }, true, false)).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 3: 受け取り口のテストを直し、足す**

`tests/unit/api/webhook/stripe-ingest.test.ts` の先頭の `process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';` の次の行に足す:

```ts
process.env.STRIPE_SECRET_KEY = 'sk_test_ingest';
```

同じファイルの `jest.mock('next/server', …)` の塊を次に置き換える（`after` を記録する）:

```ts
const mockAfterCallbacks: Array<() => unknown> = [];
jest.mock('next/server', () => {
  const original = jest.requireActual('next/server');
  return {
    ...original,
    after: (callback: () => unknown) => {
      mockAfterCallbacks.push(callback);
    },
    NextResponse: {
      json: jest.fn((body: unknown, init?: { status?: number }) => ({
        body,
        status: init?.status ?? 200,
      })),
    },
  };
});
```

同じファイルの `jest.mock('@/lib/audit', …)` の塊を次に置き換える:

```ts
const mockLogAudit = jest.fn().mockResolvedValue(undefined);
jest.mock('@/lib/audit', () => ({
  logAudit: (...args: unknown[]) => mockLogAudit(...args),
}));

const mockRunWebhookWorker = jest.fn().mockResolvedValue(undefined);
jest.mock('@/lib/stripe/webhook-worker', () => ({
  runWebhookWorker: (...args: unknown[]) => mockRunWebhookWorker(...args),
}));

const mockRecordSignatureFailure = jest.fn().mockResolvedValue(undefined);
const mockRecordModeMismatch = jest.fn().mockResolvedValue(undefined);
jest.mock('@/lib/ops/webhook-receiver-signals', () => ({
  recordSignatureFailure: (...args: unknown[]) => mockRecordSignatureFailure(...args),
  recordModeMismatch: (...args: unknown[]) => mockRecordModeMismatch(...args),
}));

async function runAfterCallbacks(): Promise<void> {
  for (const callback of mockAfterCallbacks.splice(0)) await callback();
}
```

同じファイルの `beforeEach` の本体の最初に `mockAfterCallbacks.length = 0;` を足す。

同じファイルで `mockConstructEvent.mockReturnValue(event)` に渡している知らせの3か所（`evt_fast_ack`・`evt_store_failed`・`evt_duplicate`）すべてに `livemode: false` を足す（例: `const event = { id: 'evt_fast_ack', type: 'refund.failed', livemode: false, data: { … } };`）。`evt_store_failed` の `type: 'payment_intent.succeeded'` は13種に入っているのでそのままにする。

同じファイルの「署名が無効ならキューへ保存しない」のテストの最後に足す:

```ts
    expect(mockLogAudit).not.toHaveBeenCalled();
    await runAfterCallbacks();
    expect(mockRecordSignatureFailure).toHaveBeenCalledTimes(1);
```

同じファイルの「署名ヘッダー欠落ならStripeとDBを呼ばない」のテストの最後に足す:

```ts
    await runAfterCallbacks();
    expect(mockRecordSignatureFailure).toHaveBeenCalledTimes(1);
```

同じファイルの最後の `});` の前に、次の3つのテストを足す:

```ts
  it('13種以外の知らせは保存せずに200を返す', async () => {
    const event = { id: 'evt_other', type: 'customer.created', livemode: false, data: { object: { id: 'cus_1' } } };
    mockConstructEvent.mockReturnValue(event);
    const response = await POST(request(event));
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ received: true, ignored: true });
    expect(mockEnqueueRpc).not.toHaveBeenCalled();
  });

  it('モードの違う知らせは保存せず、200を返して数える', async () => {
    const event = { id: 'evt_live', type: 'checkout.session.completed', livemode: true, data: { object: { id: 'cs_1' } } };
    mockConstructEvent.mockReturnValue(event);
    const response = await POST(request(event));
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ received: true, ignored: true });
    expect(mockEnqueueRpc).not.toHaveBeenCalled();
    await runAfterCallbacks();
    expect(mockRecordModeMismatch).toHaveBeenCalledWith(expect.anything(), true, false);
  });

  it('保存したら、返事の後にその場で worker を1回動かす', async () => {
    const event = { id: 'evt_after', type: 'checkout.session.completed', livemode: false, data: { object: { id: 'cs_2' } } };
    mockConstructEvent.mockReturnValue(event);
    const response = await POST(request(event));
    expect(response.status).toBe(200);
    expect(mockRunWebhookWorker).not.toHaveBeenCalled();
    await runAfterCallbacks();
    expect(mockRunWebhookWorker).toHaveBeenCalledWith({ requestUrl: 'http://localhost/api/webhook/stripe' });
  });
```

- [ ] **Step 4: テストが落ちることを確かめる**

Run: `npx jest tests/unit/lib/stripe/handled-webhook-events.test.ts tests/unit/lib/ops/webhook-receiver-signals.test.ts tests/unit/api/webhook/stripe-ingest.test.ts`
Expected: FAIL（新しいモジュールが無い。受け取り口の新しいテストが落ちる）

- [ ] **Step 5: 13種とモードの判定を作る**

`src/lib/stripe/handled-webhook-events.ts`:

```ts
/**
 * 受け取り口が保存する Stripe の知らせの種類（設計書 2026-10-05 グループ B の 5-1）。
 * Stripe 側の購読も同じ13種にする（手順書）。処理する側（webhook-processor）の分け方と一致させる（テストが確かめる）。
 */
export const HANDLED_STRIPE_EVENT_TYPES = [
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'checkout.session.async_payment_failed',
  'checkout.session.expired',
  'payment_intent.succeeded',
  'payment_intent.payment_failed',
  'refund.created',
  'refund.updated',
  'refund.failed',
  'charge.refunded',
  'payout.paid',
  'payout.failed',
  'payout.reconciliation_completed',
] as const;

const HANDLED: ReadonlySet<string> = new Set(HANDLED_STRIPE_EVENT_TYPES);

export function isHandledStripeEventType(type: string): boolean {
  return HANDLED.has(type);
}

/** 秘密鍵の頭でモードを決める。本番の鍵なら true、テストの鍵なら false、どちらでもなければ null。 */
export function stripeKeyLivemode(secretKey: string | undefined): boolean | null {
  if (!secretKey) return null;
  if (/^(sk|rk)_live_/.test(secretKey)) return true;
  if (/^(sk|rk)_test_/.test(secretKey)) return false;
  return null;
}
```

- [ ] **Step 6: 数えて知らせる仕組みを作る**

`src/lib/ops/webhook-receiver-signals.ts`:

```ts
import { bumpSignal, claimAlert, releaseAlert, type OpsStore } from '@/lib/ops/ops-store';
import { modeMismatchMail, signatureAlertMail, type OpsAlertMail } from '@/lib/ops/ops-alert-mail';

/**
 * 受け取り口の署名不正とモード違いを数え、多いときだけ店へ知らせる（設計書 2026-10-05 グループ B の 5-2・6）。
 * 1件ずつ監査ログに書かず、同じ1行の件数を進める（R-05）。受け取り口の返事を壊さないよう、例外は外へ出さない。
 */
export const SIGNATURE_ALERT = {
  key: 'webhook_signature_invalid',
  windowSeconds: 600,
  threshold: 5,
  cooldownSeconds: 3600,
} as const;

export const MODE_MISMATCH_ALERT = {
  key: 'webhook_mode_mismatch',
  windowSeconds: 3600,
  threshold: 1,
  cooldownSeconds: 3600,
} as const;

export type SignalDeps = { store: OpsStore; send: (mail: OpsAlertMail) => Promise<boolean> };

type Signal = typeof SIGNATURE_ALERT | typeof MODE_MISMATCH_ALERT;

async function countAndAlert(deps: SignalDeps, signal: Signal, mail: (count: number) => OpsAlertMail): Promise<void> {
  const count = await bumpSignal(deps.store, signal.key, signal.windowSeconds);
  if (count < signal.threshold) return;
  const claim = await claimAlert(deps.store, signal.key, signal.cooldownSeconds);
  if (!claim) return;
  if (!(await deps.send(mail(count)))) await releaseAlert(deps.store, claim);
}

function logFailure(what: string, error: unknown): void {
  console.error(`[webhook] Failed to record ${what}`, error instanceof Error ? error.name : 'UnknownError');
}

export async function recordSignatureFailure(deps: SignalDeps): Promise<void> {
  try {
    await countAndAlert(deps, SIGNATURE_ALERT, (count) => signatureAlertMail(count));
  } catch (error) {
    logFailure('signature failure', error);
  }
}

export async function recordModeMismatch(
  deps: SignalDeps,
  eventLivemode: boolean,
  keyLivemode: boolean | null,
): Promise<void> {
  try {
    await countAndAlert(deps, MODE_MISMATCH_ALERT, () => modeMismatchMail(eventLivemode, keyLivemode));
  } catch (error) {
    logFailure('mode mismatch', error);
  }
}
```

- [ ] **Step 7: 受け取り口を書き換える**

`src/app/api/webhook/stripe/route.ts` を次の内容に置き換える:

```ts
import { after, NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import Stripe from 'stripe';
import { getStripeServerClient } from '@/lib/stripe/server';
import {
  enqueueWebhookEvent,
  webhookErrorCategory,
  type WebhookEventStore,
} from '@/lib/stripe/webhook-events';
import { isHandledStripeEventType, stripeKeyLivemode } from '@/lib/stripe/handled-webhook-events';
import { recordModeMismatch, recordSignatureFailure, type SignalDeps } from '@/lib/ops/webhook-receiver-signals';
import { sendOpsAlertMail } from '@/lib/ops/ops-alert-mail';
import type { OpsStore } from '@/lib/ops/ops-store';
import { runWebhookWorker } from '@/lib/stripe/webhook-worker';

// 返事の後に after() で worker を約45秒まで動かすため
export const maxDuration = 60;

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const signalDeps: SignalDeps = {
  store: supabase as unknown as OpsStore,
  send: sendOpsAlertMail,
};

/**
 * PUBLIC: Stripe の知らせの受け取り口（設計書 2026-10-05 グループ B の 5-1）。
 * 1 署名（時刻の差は5分まで）→ 2 13種か → 3 モードが鍵と合うか → 4 保存（同じ番号は1回だけ）→ 5 200 を返し、after() で worker。
 * 署名の欠落・不一致は400。監査ログに1件ずつ書かず、件数だけ数える（R-05）。
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error('[webhook] STRIPE_WEBHOOK_SECRET is not set');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }

  const signature = req.headers.get('stripe-signature');
  if (!signature) {
    console.warn('[webhook] Missing stripe-signature header');
    after(() => recordSignatureFailure(signalDeps));
    return NextResponse.json({ error: 'Missing stripe-signature header' }, { status: 400 });
  }

  const rawBody = Buffer.from(await req.arrayBuffer());
  let event: Stripe.Event;

  try {
    event = getStripeServerClient().webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch {
    console.warn('[webhook] Signature verification failed');
    after(() => recordSignatureFailure(signalDeps));
    return NextResponse.json(
      { error: 'Webhook signature verification failed' },
      { status: 400 },
    );
  }

  if (!isHandledStripeEventType(event.type)) {
    console.info('[webhook] Ignored event type', event.type);
    return NextResponse.json({ received: true, ignored: true });
  }

  const keyLivemode = stripeKeyLivemode(process.env.STRIPE_SECRET_KEY);
  if (keyLivemode === null || event.livemode !== keyLivemode) {
    console.warn('[webhook] Event mode does not match the secret key', event.id);
    after(() => recordModeMismatch(signalDeps, event.livemode, keyLivemode));
    return NextResponse.json({ received: true, ignored: true });
  }

  let inserted: boolean;
  try {
    inserted = await enqueueWebhookEvent(
      supabase as unknown as WebhookEventStore,
      {
        id: event.id,
        type: event.type,
        payload: event as unknown as Record<string, unknown>,
      },
    );
  } catch (error) {
    console.error('[webhook] Failed to persist verified event', event.id, webhookErrorCategory(error));
    return NextResponse.json(
      { error: 'Failed to persist webhook event' },
      { status: 500 },
    );
  }

  // 返事の後に続けて処理する。失敗しても、毎分の定期処理が拾う
  after(() => runWebhookWorker({ requestUrl: req.url }).catch((error: unknown) => {
    console.error('[webhook] Inline worker run failed', webhookErrorCategory(error));
  }));
  return NextResponse.json({ received: true, duplicate: !inserted });
}
```

- [ ] **Step 8: テストが通ることを確かめる**

Run: `npx jest tests/unit/lib/stripe/handled-webhook-events.test.ts tests/unit/lib/ops/webhook-receiver-signals.test.ts tests/unit/api/webhook`
Expected: PASS（`stripe-route.test.ts` は処理する側のテストで、受け取り口の変更の影響を受けない）

Run: `npm run typecheck`
Expected: エラー0

- [ ] **Step 9: コミットの文を書く**

`.superpowers/sdd/2026-10-05-webhook-queue-operations/task-7-commit-msg.txt`:

```text
feat(stripe): 受け取り口で署名不正を数え、13種だけを保存し、モードを確かめる

署名の欠落・不一致は400で断り、監査ログに1件ずつ書かずに件数を数える（R-05）。
10分に5件で店へ知らせる。13種以外とモードの違う知らせは保存せずに200を返す。
保存したら返事の後に after() で worker を1回動かす（R-07）。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

---

### Task 8: 定期処理の入口の合言葉を1つの確かめ方にそろえる

設計書 4-3（X-4）。合言葉を SHA-256 にしてから `timingSafeEqual` で比べる今の `authorizeCronBearer` を `src/lib/cron/auth.ts` に置き直す。`CRON_SECRET` で守る4つの入口は、32文字未満を設定の誤りとして断る同じ関数を使う。照合の入口は GET から POST に変える。法令アーカイブの2つの入口（`LEGAL_ARCHIVE_CRON_SECRET`）は、比べ方の関数を共有するだけで、長さの決まりは足さない（グループ B の範囲外。法令対応は後回し）。

**Files:**
- Create: `src/lib/cron/auth.ts`、`tests/unit/lib/cron/auth.test.ts`、`tests/unit/api/cron/meta-kpi-sync-route.test.ts`
- Modify: `src/lib/legal-archive/cron-auth.ts`（置き直した関数を出し直すだけ）
- Modify: `src/app/api/cron/process-stripe-webhooks/route.ts`、`src/app/api/cron/expire-pending-orders/route.ts`、`src/app/api/cron/stripe-reconcile/route.ts`、`src/app/api/cron/meta-kpi-sync/route.ts`
- Modify: `tests/unit/api/cron/process-stripe-webhooks-route.test.ts`、`tests/unit/api/cron/expire-pending-orders-route.test.ts`、`tests/unit/api/cron/stripe-reconcile-route.test.ts`

**Interfaces:**
- Consumes: Task 6 の worker の入口（`runWebhookWorker` を呼ぶ形）
- Produces: `src/lib/cron/auth.ts`: `export const MIN_CRON_SECRET_LENGTH = 32`、`export type CronAuthFailure`（4つの理由の文）、`export type CronAuthResult = { ok: true } | { ok: false; reason: CronAuthFailure; misconfigured: boolean }`、`export function authorizeCronBearer(authorization: string | null, configuredSecret: string | undefined): boolean`、`export function authorizeCronRequest(request: Request, endpoint: string, configuredSecret?: string): CronAuthResult`（省略時は `process.env.CRON_SECRET`。断ったときはログに `[cron] <endpoint> unauthorized` と理由の1行）。照合の入口は `export async function POST`（GET は無くなる）

- [ ] **Step 1: 確かめ方のテストを書く**

`tests/unit/lib/cron/auth.test.ts`:

```ts
/** @jest-environment node */
import fs from 'node:fs';
import path from 'node:path';
import { authorizeCronBearer, authorizeCronRequest, MIN_CRON_SECRET_LENGTH } from '@/lib/cron/auth';

const SECRET = 'cron-secret-for-unit-tests-0123456789';

function request(authorization?: string): Request {
  return new Request('http://localhost/api/cron/x', {
    method: 'POST',
    headers: authorization ? { authorization } : {},
  });
}

describe('authorizeCronBearer（合言葉の比べ方）', () => {
  it('同じ合言葉だけを通す', () => {
    expect(authorizeCronBearer(`Bearer ${SECRET}`, SECRET)).toBe(true);
  });

  it.each([null, '', 'Bearer wrong', `Basic ${SECRET}`, `Bearer ${SECRET} `])('違うヘッダー %p は通さない', (value) => {
    expect(authorizeCronBearer(value, SECRET)).toBe(false);
  });

  it('合言葉が空なら通さない', () => {
    expect(authorizeCronBearer('Bearer ', '')).toBe(false);
    expect(authorizeCronBearer('Bearer ', undefined)).toBe(false);
  });
});

describe('authorizeCronRequest（CRON_SECRET で守る入口）', () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('32文字以上で一致すれば通し、ログを出さない', () => {
    expect(MIN_CRON_SECRET_LENGTH).toBe(32);
    expect(authorizeCronRequest(request(`Bearer ${SECRET}`), 'worker', SECRET)).toEqual({ ok: true });
    expect(warn).not.toHaveBeenCalled();
  });

  it('ちょうど32文字は通す', () => {
    const secret = 'a'.repeat(32);
    expect(authorizeCronRequest(request(`Bearer ${secret}`), 'worker', secret)).toEqual({ ok: true });
  });

  it('未設定は設定の誤りとして断り、ログに1行出す', () => {
    expect(authorizeCronRequest(request(`Bearer ${SECRET}`), 'worker', undefined)).toEqual({
      ok: false, reason: 'CRON_SECRET is not configured', misconfigured: true,
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('[cron] worker unauthorized', 'CRON_SECRET is not configured');
  });

  it('32文字未満は、ヘッダーが一致していても設定の誤りとして断る', () => {
    const secret = 'a'.repeat(31);
    expect(authorizeCronRequest(request(`Bearer ${secret}`), 'worker', secret)).toEqual({
      ok: false, reason: 'CRON_SECRET is shorter than 32 characters', misconfigured: true,
    });
  });

  it('ヘッダーが無い・一致しないときは断り、ヘッダーの値をログに出さない', () => {
    expect(authorizeCronRequest(request(), 'worker', SECRET)).toEqual({
      ok: false, reason: 'Missing Authorization header', misconfigured: false,
    });
    expect(authorizeCronRequest(request('Bearer attacker-supplied-value'), 'worker', SECRET)).toEqual({
      ok: false, reason: 'Authorization header does not match CRON_SECRET', misconfigured: false,
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('attacker-supplied-value');
  });

  it('合言葉を渡さなければ process.env.CRON_SECRET を読む', () => {
    process.env.CRON_SECRET = SECRET;
    try {
      expect(authorizeCronRequest(request(`Bearer ${SECRET}`), 'worker')).toEqual({ ok: true });
    } finally {
      delete process.env.CRON_SECRET;
    }
  });
});

describe('CRON_SECRET で守る入口は、同じ確かめ方だけを使う', () => {
  it.each([
    'src/app/api/cron/process-stripe-webhooks/route.ts',
    'src/app/api/cron/expire-pending-orders/route.ts',
    'src/app/api/cron/stripe-reconcile/route.ts',
    'src/app/api/cron/meta-kpi-sync/route.ts',
  ])('%s', (file) => {
    const source = fs.readFileSync(path.join(process.cwd(), file), 'utf8');
    expect(source).toContain("from '@/lib/cron/auth'");
    expect(source).toMatch(/authorizeCronRequest\(request, '[a-z-]+'\)/);
    expect(source).not.toMatch(/timingSafeEqual|process\.env\.CRON_SECRET|!==\s*`Bearer/);
  });
});
```

- [ ] **Step 2: 入口のテストを直し、足す**

`tests/unit/api/cron/process-stripe-webhooks-route.test.ts` の「認証されない呼出しと未設定secretを拒否し、worker を動かさない」のテストの後ろに足す:

```ts
  it('CRON_SECRET が32文字未満なら、ヘッダーが一致していても断る', async () => {
    process.env.CRON_SECRET = 'short-secret';
    expect((await POST(request('Bearer short-secret'))).status).toBe(401);
    expect(mockRunWebhookWorker).not.toHaveBeenCalled();
  });
```

`tests/unit/api/cron/expire-pending-orders-route.test.ts` を次のように直す:

1. `import { POST } from '@/app/api/cron/expire-pending-orders/route';` の次の行に足す:

```ts

// 定期処理の合言葉は32文字以上（設計書 2026-10-05 グループ B の 4-3）
const CRON_SECRET = 'cron-secret-for-unit-tests-0123456789';
```

2. `async function sweep(authorization = 'Bearer cron-secret'): Promise<SweepResponse> {` の行を次に置き換える:

```ts
async function sweep(authorization = `Bearer ${CRON_SECRET}`): Promise<SweepResponse> {
```

3. `beforeEach` の `process.env.CRON_SECRET = 'cron-secret';` を `process.env.CRON_SECRET = CRON_SECRET;` に変える。
4. 「長さが同じでも値が違う secret は 401」のテストの `expect((await sweep('Bearer cron-secreX')).status).toBe(401);` の行を次に置き換える:

```ts
    expect((await sweep(`Bearer ${CRON_SECRET.slice(0, -1)}X`)).status).toBe(401);
```

5. 「CRON_SECRET が未設定なら 401 で、理由付きの監査ログを残す」のテストの後ろに足す:

```ts
  it('CRON_SECRET が32文字未満なら、設定の誤りとして 401 にし、理由付きの監査ログを残す', async () => {
    process.env.CRON_SECRET = 'short-secret';

    const response = await sweep('Bearer short-secret');

    expect(response.status).toBe(401);
    expect(mockReconcile).not.toHaveBeenCalled();
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'checkout.pending_orders.expire',
      outcome: 'failure',
      detail: 'Unauthorized: CRON_SECRET is shorter than 32 characters',
    }));
  });
```

`tests/unit/api/cron/stripe-reconcile-route.test.ts` を次のように直す:

1. `import { GET } from '@/app/api/cron/stripe-reconcile/route';` を次に置き換える:

```ts
import * as reconcileRoute from '@/app/api/cron/stripe-reconcile/route';
```

2. `const mockReconcilePayouts = reconcileStripePayouts as jest.Mock;` の次の行に足す:

```ts
const { POST } = reconcileRoute;
// 定期処理の合言葉は32文字以上（設計書 2026-10-05 グループ B の 4-3）
const CRON_SECRET = 'cron-secret-for-unit-tests-0123456789';
```

3. `authorizedRequest` を次に置き換える:

```ts
function authorizedRequest(): Request {
  return new Request('http://localhost/api/cron/stripe-reconcile', {
    method: 'POST',
    headers: { authorization: `Bearer ${CRON_SECRET}` },
  });
}
```

4. `describe('GET /api/cron/stripe-reconcile', () => {` を `describe('POST /api/cron/stripe-reconcile', () => {` に、`process.env.CRON_SECRET = 'cron-secret';` を `process.env.CRON_SECRET = CRON_SECRET;` に変え、ファイルの中の `await GET(` をすべて `await POST(` に変える。
5. 「rejects requests without the cron bearer token」のテストの `new Request('http://localhost/api/cron/stripe-reconcile')` を `new Request('http://localhost/api/cron/stripe-reconcile', { method: 'POST' })` に変え、そのテストの後ろに足す:

```ts
  it('rejects a CRON_SECRET shorter than 32 characters even when the header matches', async () => {
    process.env.CRON_SECRET = 'short-secret';
    const response = await POST(new Request('http://localhost/api/cron/stripe-reconcile', {
      method: 'POST',
      headers: { authorization: 'Bearer short-secret' },
    }));
    expect(response.status).toBe(401);
    expect(reconcileStripeOrders).not.toHaveBeenCalled();
  });

  it('is called with POST only (pg_net sends POST)', () => {
    expect('GET' in reconcileRoute).toBe(false);
  });
```

`tests/unit/api/cron/meta-kpi-sync-route.test.ts`:

```ts
jest.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, body }),
  },
}));

const mockMaybeSingle = jest.fn();
const mockServiceClient = {
  from: () => ({
    select: () => ({ eq: () => ({ maybeSingle: () => mockMaybeSingle() }) }),
  }),
};
const mockCreateServiceRoleClient = jest.fn(async () => mockServiceClient);
jest.mock('@/lib/supabase/server', () => ({
  createServiceRoleClient: () => mockCreateServiceRoleClient(),
}));
jest.mock('@/lib/meta/sync-kpi', () => ({ syncMetaKpis: jest.fn() }));
jest.mock('@/lib/kpi/monthly-metrics', () => ({ currentSeasonKey: () => '2026-AW' }));

import { POST } from '@/app/api/cron/meta-kpi-sync/route';

const CRON_SECRET = 'cron-secret-for-unit-tests-0123456789';

function request(authorization?: string): Request {
  return new Request('http://localhost/api/cron/meta-kpi-sync', {
    method: 'POST',
    headers: authorization ? { authorization } : {},
  });
}

describe('POST /api/cron/meta-kpi-sync の合言葉', () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.CRON_SECRET = CRON_SECRET;
    mockMaybeSingle.mockResolvedValue({ data: null, error: null });
  });

  afterEach(() => {
    // restoreAllMocks は jest.fn の実装まで消すので使わない（Jest 29）
    warn.mockRestore();
    delete process.env.CRON_SECRET;
  });

  it('一致しなければ 401 で、DB を触らない', async () => {
    const response = (await POST(request(`Bearer ${CRON_SECRET.slice(0, -1)}X`))) as unknown as { status: number };
    expect(response.status).toBe(401);
    expect(mockCreateServiceRoleClient).not.toHaveBeenCalled();
  });

  it('CRON_SECRET が32文字未満なら、一致していても 401', async () => {
    process.env.CRON_SECRET = 'short-secret';
    const response = (await POST(request('Bearer short-secret'))) as unknown as { status: number };
    expect(response.status).toBe(401);
    expect(mockCreateServiceRoleClient).not.toHaveBeenCalled();
  });

  it('一致すれば処理に進む（つながりが無ければ skipped）', async () => {
    const response = (await POST(request(`Bearer ${CRON_SECRET}`))) as unknown as { status: number; body: unknown };
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: { skipped: true } });
  });
});
```

- [ ] **Step 3: テストが落ちることを確かめる**

Run: `npx jest tests/unit/lib/cron/auth.test.ts tests/unit/api/cron`
Expected: FAIL（`@/lib/cron/auth` が無い。照合の入口に POST が無い。32文字未満を断らない）

- [ ] **Step 4: 確かめ方を作る**

`src/lib/cron/auth.ts`:

```ts
import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * 定期処理の入口の合言葉の確かめ方（設計書 2026-10-05 グループ B の 4-3。X-4）。
 * 合言葉を SHA-256 にしてから timingSafeEqual で比べる（長さの違いも時間に出ない）。
 */
export const MIN_CRON_SECRET_LENGTH = 32;

export type CronAuthFailure =
  | 'CRON_SECRET is not configured'
  | 'CRON_SECRET is shorter than 32 characters'
  | 'Missing Authorization header'
  | 'Authorization header does not match CRON_SECRET';

export type CronAuthResult =
  | { ok: true }
  | { ok: false; reason: CronAuthFailure; misconfigured: boolean };

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/** Bearer の合言葉が一致するか。合言葉の長さは問わない（法令アーカイブの入口も使う）。 */
export function authorizeCronBearer(
  authorization: string | null,
  configuredSecret: string | undefined,
): boolean {
  if (!configuredSecret) return false;
  return timingSafeEqual(digest(`Bearer ${configuredSecret}`), digest(authorization ?? ''));
}

function checkCronRequest(request: Request, configuredSecret: string | undefined): CronAuthResult {
  if (!configuredSecret) {
    return { ok: false, reason: 'CRON_SECRET is not configured', misconfigured: true };
  }
  if (configuredSecret.length < MIN_CRON_SECRET_LENGTH) {
    return { ok: false, reason: 'CRON_SECRET is shorter than 32 characters', misconfigured: true };
  }
  const header = request.headers.get('authorization');
  if (!header) {
    return { ok: false, reason: 'Missing Authorization header', misconfigured: false };
  }
  if (!authorizeCronBearer(header, configuredSecret)) {
    return { ok: false, reason: 'Authorization header does not match CRON_SECRET', misconfigured: false };
  }
  return { ok: true };
}

/**
 * CRON_SECRET で守る定期処理の入口の確かめ方。32文字未満は設定の誤りとして断る。
 * 断ったときはログに1行だけ出す（ヘッダーの値は出さない）。
 */
export function authorizeCronRequest(
  request: Request,
  endpoint: string,
  configuredSecret: string | undefined = process.env.CRON_SECRET,
): CronAuthResult {
  const result = checkCronRequest(request, configuredSecret);
  if (!result.ok) console.warn(`[cron] ${endpoint} unauthorized`, result.reason);
  return result;
}
```

`src/lib/legal-archive/cron-auth.ts` を次の内容に置き換える:

```ts
// 定期処理の合言葉の比べ方は src/lib/cron/auth.ts に置き直した（設計書 2026-10-05 グループ B の 4-3）
export { authorizeCronBearer } from '@/lib/cron/auth';
```

- [ ] **Step 5: 4つの入口を置き換える**

`src/app/api/cron/process-stripe-webhooks/route.ts`: `import { authorizeCronBearer } from '@/lib/legal-archive/cron-auth';` を `import { authorizeCronRequest } from '@/lib/cron/auth';` に変え、`if (!authorizeCronBearer(request.headers.get('authorization'), process.env.CRON_SECRET)) {` を次に変える:

```ts
  if (!authorizeCronRequest(request, 'process-stripe-webhooks').ok) {
```

`src/app/api/cron/expire-pending-orders/route.ts`:

1. `import { timingSafeEqual } from 'node:crypto';` を消し、`import { logAudit } from '@/lib/audit';` の次の行に `import { authorizeCronRequest } from '@/lib/cron/auth';` を足す。
2. `type AuthorizationResult = …;` と `function checkAuthorization(request: Request): AuthorizationResult { … }` の2つを消す。
3. `recordUnauthorized` の説明と本体を次に置き換える（ログの1行は `authorizeCronRequest` が出す）:

```ts
/**
 * 認証に失敗した要求を記録する（FREQ-370）。
 * ヘッダの欠落・不一致はアプリのログにだけ残す（authorizeCronRequest が1行出す。ヘッダの値は出さない）。
 * CRON_SECRET の未設定・32文字未満（運用側の設定ミス）は監査ログにも残す。ただし全体で10分に1回まで。
 */
async function recordUnauthorized(
  request: Request,
  auth: { reason: string; misconfigured: boolean },
): Promise<void> {
  if (!auth.misconfigured) return;

  const throttled = await enforceRateLimit({ request, ...MISCONFIGURED_AUDIT_THROTTLE });
  if (throttled) return;

  await logAudit({
    action: 'checkout.pending_orders.expire',
    resource: 'orders',
    outcome: 'failure',
    detail: `Unauthorized: ${auth.reason}`,
  });
}
```

4. `POST` の先頭の `const auth = checkAuthorization(request);` を `const auth = authorizeCronRequest(request, 'expire-pending-orders');` に変える。

`src/app/api/cron/stripe-reconcile/route.ts`:

1. `import { NextResponse } from 'next/server';` の次の行に `import { authorizeCronRequest } from '@/lib/cron/auth';` を足す。
2. `export async function GET(request: Request) {` を `export async function POST(request: Request) {` に変え、その次の4行（`const secret = process.env.CRON_SECRET;` から `}` まで）を次に置き換える:

```ts
  if (!authorizeCronRequest(request, 'stripe-reconcile').ok) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
```

3. ファイルの先頭の import の前に足す:

```ts
// 毎日 18:00 UTC（日本時間 3:00）に pg_cron＋pg_net から POST で呼ばれる（設計書 2026-10-05 グループ B の 4-1）
```

`src/app/api/cron/meta-kpi-sync/route.ts`: `import { NextResponse } from 'next/server';` の次の行に `import { authorizeCronRequest } from '@/lib/cron/auth';` を足し、`POST` の先頭の5行（`const expected = process.env.CRON_SECRET;` から `}` まで）を次に置き換える（このファイルのインデントはタブ）:

```ts
	if (!authorizeCronRequest(request, 'meta-kpi-sync').ok) {
		return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
	}
```

- [ ] **Step 6: テストが通ることを確かめる**

Run: `npx jest tests/unit/lib/cron/auth.test.ts tests/unit/lib/legal-archive/cron-auth.test.ts tests/unit/api/cron`
Expected: PASS（`auth.test.ts` は17件、`meta-kpi-sync-route.test.ts` は3件。法令アーカイブの入口のテストは今のまま通る）

Run: `npm run typecheck`
Expected: エラー0

Run: `npx eslint src/lib/cron src/app/api/cron src/lib/legal-archive/cron-auth.ts`
Expected: エラー0

- [ ] **Step 7: コミットの文を書く**

`.superpowers/sdd/2026-10-05-webhook-queue-operations/task-8-commit-msg.txt`:

```text
fix(cron): 定期処理の入口の合言葉を1つの確かめ方にそろえ、短い合言葉を断る

合言葉を SHA-256 にしてから比べる関数を src/lib/cron/auth.ts に置き直し、
worker・見回り・照合・Meta の同期の入口で同じ関数を使う（X-4）。
CRON_SECRET が32文字より短いときは設定の誤りとして全部断り、ログに1行出す。
照合の入口は pg_net から呼べるように POST にした。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

---

### Task 9: 照合（支払いごとに失敗を受け止め、記録する）

設計書 4-5・4-6・3-3。今の照合は、返金の同期の1件の失敗で、その回の残りが止まる。支払いごとに失敗を受け止め、原因の記号を残して次へ進む。その回の結果を監査に1行残し、最後の成功（または失敗）を記録する。失敗に例外の文を残さない（今は `error.message` を返している）。

**Files:**
- Modify: `src/lib/stripe/reconcile-orders.ts`（全体）
- Modify: `src/app/api/cron/stripe-reconcile/route.ts`（全体）
- Modify: `tests/unit/lib/stripe/reconcile-orders.test.ts`、`tests/unit/api/cron/stripe-reconcile-route.test.ts`

**Interfaces:**
- Consumes: Task 3 の `webhookFailureCause`・`WebhookFailureCause`・`recordHeartbeat`・`OpsStore`、Task 8 の `authorizeCronRequest`
- Produces: `StripeReconciliationError = { sourceId: string; reason: WebhookFailureCause }`（`reason` は原因の記号だけ）。注文の読み込みの DB の失敗は `ReconcileTransientError('db_unavailable')`。照合の入口は、終わったら監査 `stripe.reconcile` を1行残し、`ops_job_heartbeats` の `stripe_reconcile` を記録する

- [ ] **Step 1: 照合のテストを直し、足す**

`tests/unit/lib/stripe/reconcile-orders.test.ts` を次のように直す:

1. 「records an accounting failure without aborting the remaining payments」のテストの `expect(report.errors).toEqual([{ sourceId: 'pi_a', reason: 'stripe unavailable' }]);` を、次に変える（例外の文は残さず、原因の記号にする）:

```ts
    expect(report.errors).toEqual([{ sourceId: 'pi_a', reason: 'unexpected_error' }]);
```

2. 「records a payout failure and continues」のテストの `expect(report.errors).toEqual([{ sourceId: 'po_1', reason: 'payout sync failed' }]);` を、次に変える:

```ts
    expect(report.errors).toEqual([{ sourceId: 'po_1', reason: 'unexpected_error' }]);
```

3. `describe('reconcileStripeOrders', () => {` の塊の最後の `});` の前に足す:

```ts

  it('records a refund sync failure without aborting the remaining payments（設計書 4-5）', async () => {
    const orders = [
      { payment_intent_id: 'pi_a', refunded_amount: 0 },
      { payment_intent_id: 'pi_b', refunded_amount: 0 },
    ];
    const database = { from: () => ({ select: async () => ({ data: orders, error: null }) }) };
    const stripe = {
      paymentIntents: {
        list: () => [
          { id: 'pi_a', status: 'succeeded', amount: 1000 },
          { id: 'pi_b', status: 'succeeded', amount: 1000 },
        ],
      },
      refunds: { list: () => [{ status: 'succeeded', amount: 500, created: 1 }] },
    };
    const syncRefunds = jest
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('Stripe is down for buyer@example.com'), { statusCode: 503 }))
      .mockResolvedValueOnce(undefined);
    const syncAccounting = jest.fn().mockResolvedValue({ disposition: 'inserted' });

    const report = await reconcileStripeOrders({ database, stripe, syncRefunds, syncAccounting });

    expect(syncRefunds).toHaveBeenCalledTimes(2);
    expect(report.syncedRefunds).toBe(1);
    expect(report.errors).toEqual([{ sourceId: 'pi_a', reason: 'stripe_unavailable' }]);
    expect(JSON.stringify(report)).not.toContain('buyer@example.com');
    expect(syncAccounting).toHaveBeenCalledWith('pi_a');
    expect(syncAccounting).toHaveBeenCalledWith('pi_b');
  });

  it('records a refund listing failure and continues with the next payment', async () => {
    const orders = [{ payment_intent_id: 'pi_b', refunded_amount: 0 }];
    const database = { from: () => ({ select: async () => ({ data: orders, error: null }) }) };
    const stripe = {
      paymentIntents: {
        list: () => [
          { id: 'pi_a', status: 'succeeded', amount: 1000 },
          { id: 'pi_b', status: 'succeeded', amount: 1000 },
        ],
      },
      refunds: {
        list: ({ payment_intent }: { payment_intent: string }) => {
          if (payment_intent === 'pi_a') {
            throw Object.assign(new Error('connection reset'), { type: 'StripeConnectionError' });
          }
          return [];
        },
      },
    };

    const report = await reconcileStripeOrders({ database, stripe, syncRefunds: jest.fn() });

    expect(report.checkedPayments).toBe(2);
    expect(report.errors).toEqual([{ sourceId: 'pi_a', reason: 'stripe_unavailable' }]);
    expect(report.unmatchedActivePayments).toEqual([]);
  });

  it('reports a database failure while loading orders as db_unavailable', async () => {
    const database = {
      from: () => ({ select: async () => ({ data: null, error: { message: 'connection refused' } }) }),
    };
    const stripe = { paymentIntents: { list: () => [] }, refunds: { list: () => [] } };

    await expect(reconcileStripeOrders({ database, stripe, syncRefunds: jest.fn() }))
      .rejects.toMatchObject({ code: 'db_unavailable' });
  });
```

- [ ] **Step 2: 照合の入口のテストを足す**

`tests/unit/api/cron/stripe-reconcile-route.test.ts` を次のように直す（Task 8 の直しの後）:

1. `jest.mock('@/lib/supabase/server', () => ({ createServiceRoleClient: jest.fn() }));` の次の行に足す:

```ts
const mockLogAudit = jest.fn().mockResolvedValue(undefined);
jest.mock('@/lib/audit', () => ({ logAudit: (...args: unknown[]) => mockLogAudit(...args) }));
const mockRecordHeartbeat = jest.fn();
jest.mock('@/lib/ops/ops-store', () => ({
  recordHeartbeat: (...args: unknown[]) => mockRecordHeartbeat(...args),
}));
```

2. `import { reconcileStripeOrders, reconcileStripePayouts } from '@/lib/stripe/reconcile-orders';` の次の行に足す:

```ts
import { createServiceRoleClient } from '@/lib/supabase/server';

const mockDatabase = { name: 'service-role-client' };
```

3. `describe('POST /api/cron/stripe-reconcile', () => {` の `beforeEach` の本体の最後に足す:

```ts
    (createServiceRoleClient as jest.Mock).mockResolvedValue(mockDatabase);
    mockRecordHeartbeat.mockResolvedValue(undefined);
```

4. 同じ `describe` の最後の `});` の前に足す:

```ts

  it('records the run as succeeded and audits the counts with failure causes only', async () => {
    mockReconcileOrders.mockResolvedValue({
      checkedPayments: 2,
      unmatchedActivePayments: [],
      refundMismatches: [],
      syncedBalanceTransactions: 1,
      syncedRefunds: 0,
      errors: [{ sourceId: 'pi_1', reason: 'stripe_unavailable' }],
    });
    mockReconcilePayouts.mockResolvedValue({ syncedPayouts: 1, payoutMismatches: 0, errors: [] });

    const response = await POST(authorizedRequest());

    expect(response.status).toBe(200);
    expect(mockRecordHeartbeat).toHaveBeenCalledWith(mockDatabase, 'stripe_reconcile', true, null);
    expect(mockLogAudit).toHaveBeenCalledTimes(1);
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'stripe.reconcile',
      resource: 'stripe',
      outcome: 'error',
      metadata: expect.objectContaining({
        failed: 1,
        errors: [{ sourceId: 'pi_1', reason: 'stripe_unavailable' }],
      }),
    }));
  });

  it('records the run as failed with a cause code when reconciliation throws', async () => {
    mockReconcileOrders.mockRejectedValue(Object.assign(new Error('x'), { code: 'db_unavailable' }));
    mockReconcilePayouts.mockResolvedValue({ syncedPayouts: 0, payoutMismatches: 0, errors: [] });
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});

    const response = await POST(authorizedRequest());

    expect(response.status).toBe(502);
    expect(mockRecordHeartbeat).toHaveBeenCalledWith(mockDatabase, 'stripe_reconcile', false, 'db_unavailable');
    // ログには原因の記号だけを出す（例外そのものを渡さない）
    expect(error).toHaveBeenCalledWith('[stripe-reconcile] Reconciliation failed', 'db_unavailable');
    error.mockRestore();
  });

  it('still answers 200 when the heartbeat cannot be recorded', async () => {
    mockReconcileOrders.mockResolvedValue({
      checkedPayments: 0,
      unmatchedActivePayments: [],
      refundMismatches: [],
      syncedBalanceTransactions: 0,
      syncedRefunds: 0,
      errors: [],
    });
    mockReconcilePayouts.mockResolvedValue({ syncedPayouts: 0, payoutMismatches: 0, errors: [] });
    mockRecordHeartbeat.mockRejectedValue(new Error('db down'));
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});

    expect((await POST(authorizedRequest())).status).toBe(200);
    error.mockRestore();
  });
```

- [ ] **Step 3: テストが落ちることを確かめる**

Run: `npx jest tests/unit/lib/stripe/reconcile-orders.test.ts tests/unit/api/cron/stripe-reconcile-route.test.ts`
Expected: FAIL（原因の記号でなく例外の文が残る。返金の同期の失敗でその回が止まる。最後の成功を記録しない）

- [ ] **Step 4: 照合を直す**

`src/lib/stripe/reconcile-orders.ts` を次の内容に置き換える:

```ts
import { calculateSucceededRefundTotal, type RefundSnapshot } from './order-refund-sync';
import { ReconcileTransientError } from './checkout-payment-reader';
import { webhookFailureCause, type WebhookFailureCause } from './webhook-events';

type OrderState = { payment_intent_id: string; refunded_amount: number | null };
type ReconcileDatabase = {
  from(table: 'orders'): {
    select(columns: string): Promise<{ data: OrderState[] | null; error: { message?: string } | null }>;
  };
};
type PaymentIntentSnapshot = { id: string; status: string; amount: number };
type ReconcileStripe = {
  paymentIntents: { list(params: { limit: number }): AsyncIterable<PaymentIntentSnapshot> | Iterable<PaymentIntentSnapshot> };
  refunds: { list(params: { payment_intent: string; limit: number }): AsyncIterable<RefundSnapshot> | Iterable<RefundSnapshot> };
};

/** 照合の1件ずつの失敗。原因の記号だけを残す（設計書 2026-10-05 グループ B の 3-3・4-5） */
export type StripeReconciliationError = { sourceId: string; reason: WebhookFailureCause };

export type StripeOrderReconciliationReport = {
  checkedPayments: number;
  unmatchedActivePayments: string[];
  refundMismatches: Array<{ paymentIntentId: string; stripe: number; database: number }>;
  syncedBalanceTransactions: number;
  syncedRefunds: number;
  errors: StripeReconciliationError[];
};

function failureOf(sourceId: string, error: unknown): StripeReconciliationError {
  return { sourceId, reason: webhookFailureCause(error) };
}

export async function reconcileStripeOrders({
  database,
  stripe,
  syncRefunds,
  syncAccounting,
}: {
  database: ReconcileDatabase;
  stripe: ReconcileStripe;
  syncRefunds: (paymentIntentId: string) => Promise<unknown>;
  syncAccounting?: (paymentIntentId: string) => Promise<unknown>;
}): Promise<StripeOrderReconciliationReport> {
  const { data: orders, error } = await database.from('orders').select('payment_intent_id, refunded_amount');
  if (error) throw new ReconcileTransientError('db_unavailable');
  const ordersByPayment = new Map((orders ?? []).map((order) => [order.payment_intent_id, order]));
  const report: StripeOrderReconciliationReport = {
    checkedPayments: 0,
    unmatchedActivePayments: [],
    refundMismatches: [],
    syncedBalanceTransactions: 0,
    syncedRefunds: 0,
    errors: [],
  };

  for await (const payment of stripe.paymentIntents.list({ limit: 100 })) {
    if (payment.status !== 'succeeded') continue;
    report.checkedPayments += 1;
    const order = ordersByPayment.get(payment.id);

    // 支払いごとに失敗を受け止め、その回の残りを止めない（設計書 4-5）
    try {
      const refunds: RefundSnapshot[] = [];
      for await (const refund of stripe.refunds.list({ payment_intent: payment.id, limit: 100 })) refunds.push(refund);
      const stripeRefunded = calculateSucceededRefundTotal(refunds).amount;
      if (!order) {
        if (stripeRefunded < payment.amount) report.unmatchedActivePayments.push(payment.id);
      } else {
        const databaseRefunded = order.refunded_amount ?? 0;
        if (stripeRefunded !== databaseRefunded) {
          report.refundMismatches.push({ paymentIntentId: payment.id, stripe: stripeRefunded, database: databaseRefunded });
          await syncRefunds(payment.id);
          report.syncedRefunds += 1;
        }
      }
    } catch (refundError) {
      report.errors.push(failureOf(payment.id, refundError));
    }

    if (!order || !syncAccounting) continue;
    try {
      await syncAccounting(payment.id);
      report.syncedBalanceTransactions += 1;
    } catch (accountingError) {
      report.errors.push(failureOf(payment.id, accountingError));
    }
  }
  return report;
}

type PayoutSnapshot = { id: string };
type ReconcilePayoutStripe = {
  payouts: { list(params?: { limit: number }): AsyncIterable<PayoutSnapshot> | Iterable<PayoutSnapshot> };
};

export type StripePayoutReconciliationReport = {
  syncedPayouts: number;
  payoutMismatches: number;
  errors: StripeReconciliationError[];
};

export async function reconcileStripePayouts({
  stripe,
  syncPayout,
}: {
  stripe: ReconcilePayoutStripe;
  syncPayout: (payoutId: string) => Promise<{ reconciliationStatus: string }>;
}): Promise<StripePayoutReconciliationReport> {
  const report: StripePayoutReconciliationReport = {
    syncedPayouts: 0,
    payoutMismatches: 0,
    errors: [],
  };

  for await (const payout of stripe.payouts.list({ limit: 100 })) {
    try {
      const result = await syncPayout(payout.id);
      report.syncedPayouts += 1;
      if (result.reconciliationStatus === 'mismatch') report.payoutMismatches += 1;
    } catch (error) {
      report.errors.push(failureOf(payout.id, error));
    }
  }
  return report;
}

export type { ReconcileDatabase, ReconcileStripe, ReconcilePayoutStripe };
```

- [ ] **Step 5: 照合の入口に記録を足す**

`src/app/api/cron/stripe-reconcile/route.ts` を次の内容に置き換える（Task 8 の直しを含む）:

```ts
// 毎日 18:00 UTC（日本時間 3:00）に pg_cron＋pg_net から POST で呼ばれる（設計書 2026-10-05 グループ B の 4-1）
import { NextResponse } from 'next/server';
import { authorizeCronRequest } from '@/lib/cron/auth';
import { logAudit } from '@/lib/audit';
import { recordHeartbeat, type OpsStore } from '@/lib/ops/ops-store';
import {
  reconcileStripeOrders,
  reconcileStripePayouts,
  type ReconcileDatabase,
  type ReconcilePayoutStripe,
  type ReconcileStripe,
  type StripeReconciliationError,
} from '@/lib/stripe/reconcile-orders';
import { syncOrderRefunds, type OrderRefundDatabase, type RefundListClient } from '@/lib/stripe/order-refund-sync';
import { syncPaymentIntentAccounting, syncPayoutAccounting } from '@/lib/stripe/accounting-sync';
import { createStripeAccountingDatabase } from '@/lib/stripe/supabase-accounting-database';
import { getStripeServerClient } from '@/lib/stripe/server';
import { webhookFailureCause } from '@/lib/stripe/webhook-events';
import { createServiceRoleClient } from '@/lib/supabase/server';

type AccountingStripeClient = Parameters<typeof syncPayoutAccounting>[0]['stripe'];

export type StripeReconcileResponse = {
  matchedOrders: number;
  unmatchedPayments: number;
  syncedBalanceTransactions: number;
  syncedRefunds: number;
  syncedPayouts: number;
  payoutMismatches: number;
  errors: StripeReconciliationError[];
};

/** 監査の1行に載せる失敗の数（行が大きくならないように） */
const MAX_AUDITED_ERRORS = 20;

/** 最後の成功・失敗を記録する（照合の遅れの点検が読む。設計書 4-6）。記録の失敗で応答を変えない。 */
async function recordRun(store: OpsStore | null, succeeded: boolean, errorCode: string | null): Promise<void> {
  if (!store) return;
  try {
    await recordHeartbeat(store, 'stripe_reconcile', succeeded, errorCode);
  } catch (error) {
    console.error('[stripe-reconcile] Failed to record heartbeat', error instanceof Error ? error.name : 'UnknownError');
  }
}

export async function POST(request: Request) {
  if (!authorizeCronRequest(request, 'stripe-reconcile').ok) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let store: OpsStore | null = null;
  try {
    const database = await createServiceRoleClient();
    store = database as unknown as OpsStore;
    const stripe = getStripeServerClient();
    const accountingDatabase = createStripeAccountingDatabase(database);
    const accountingStripe = stripe as unknown as AccountingStripeClient;

    const orderReport = await reconcileStripeOrders({
      database: database as unknown as ReconcileDatabase,
      stripe: stripe as unknown as ReconcileStripe,
      syncRefunds: (paymentIntentId) => syncOrderRefunds({
        database: database as unknown as OrderRefundDatabase,
        stripe: stripe as unknown as RefundListClient,
        paymentIntentId,
      }),
      syncAccounting: (paymentIntentId) => syncPaymentIntentAccounting({
        stripe: accountingStripe,
        database: accountingDatabase,
        paymentIntentId,
      }),
    });

    const payoutReport = await reconcileStripePayouts({
      stripe: stripe as unknown as ReconcilePayoutStripe,
      syncPayout: (payoutId) => syncPayoutAccounting({
        stripe: accountingStripe,
        database: accountingDatabase,
        payoutId,
      }),
    });

    const data: StripeReconcileResponse = {
      matchedOrders: orderReport.checkedPayments - orderReport.unmatchedActivePayments.length,
      unmatchedPayments: orderReport.unmatchedActivePayments.length,
      syncedBalanceTransactions: orderReport.syncedBalanceTransactions,
      syncedRefunds: orderReport.syncedRefunds,
      syncedPayouts: payoutReport.syncedPayouts,
      payoutMismatches: payoutReport.payoutMismatches,
      errors: [...orderReport.errors, ...payoutReport.errors],
    };

    // 1件ずつの失敗は止めずに数え、支払いの ID と原因の記号を監査に残す（設計書 4-5）
    await logAudit({
      action: 'stripe.reconcile',
      resource: 'stripe',
      outcome: data.errors.length > 0 ? 'error' : 'success',
      detail: 'Stripe reconciliation',
      metadata: {
        matchedOrders: data.matchedOrders,
        unmatchedPayments: data.unmatchedPayments,
        syncedBalanceTransactions: data.syncedBalanceTransactions,
        syncedRefunds: data.syncedRefunds,
        syncedPayouts: data.syncedPayouts,
        payoutMismatches: data.payoutMismatches,
        failed: data.errors.length,
        errors: data.errors.slice(0, MAX_AUDITED_ERRORS),
      },
    });
    await recordRun(store, true, null);
    return NextResponse.json({ data });
  } catch (error) {
    const cause = webhookFailureCause(error);
    console.error('[stripe-reconcile] Reconciliation failed', cause);
    await recordRun(store, false, cause);
    return NextResponse.json({ error: 'Reconciliation failed' }, { status: 502 });
  }
}
```

- [ ] **Step 6: テストが通ることを確かめる**

Run: `npx jest tests/unit/lib/stripe/reconcile-orders.test.ts tests/unit/api/cron/stripe-reconcile-route.test.ts tests/unit/lib/cron/auth.test.ts`
Expected: PASS

Run: `npm run typecheck`
Expected: エラー0

- [ ] **Step 7: コミットの文を書く**

`.superpowers/sdd/2026-10-05-webhook-queue-operations/task-9-commit-msg.txt`:

```text
fix(stripe): 照合で支払いごとに失敗を受け止め、原因の記号と実行の結果を残す

返金の同期の1件の失敗で、その回の残りの照合が止まっていた。支払いごとに
失敗を受け止めて次へ進み、失敗には例外の文ではなく原因の記号だけを残す。
その回の結果を監査に1行残し、最後の成功・失敗を記録する（照合の遅れの点検が読む）。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

---

### Task 10: 注文の無い支払いの拾い上げ（部品）

設計書 3-5・3-6。直近24時間に作られた完了済みの Checkout Session のうち、注文の無いものを照合関数に渡す。照合関数がその呼び出しで注文を作ったときだけ（`place_and_mark_paid`・`place_and_mark_awaiting`）、要確認「支払いから作った注文」を付ける。見回りへの組み込みは Task 11。

**Files:**
- Create: `src/lib/stripe/orphan-payment-recovery.ts`
- Create: `tests/unit/lib/stripe/orphan-payment-recovery.test.ts`

**Interfaces:**
- Consumes: グループ A の `reconcileCheckoutPayment(deps, { checkoutSessionId })`・`ReconcileResult`・`ReconcilerDeps`（`@/lib/stripe/checkout-payment-reconciler`）、`ReconcileTransientError`（`@/lib/stripe/checkout-payment-reader`）、Task 3 の `markOrderRecoveredFromPayment`・`OpsStore`・`RecoveredReviewReason`・`webhookFailureCause`、Task 4 の `RecoveredOrderSummary`
- Produces（`src/lib/stripe/orphan-payment-recovery.ts`）:
  - `export const ORPHAN_LOOKBACK_SECONDS = 86400`、`export const ORDER_LOOKUP_BATCH_SIZE = 100`
  - `export type RecoveredOrder = { orderId: string; reviewReason: RecoveredReviewReason }`
  - `export type OrphanRecoveryDeps = { listCompletedSessionIds(createdGteSeconds: number): AsyncIterable<string>; findSessionIdsWithOrders(sessionIds: string[]): Promise<Set<string>>; reconcile(checkoutSessionId: string): Promise<ReconcileResult>; markRecovered(orderId: string): Promise<RecoveredReviewReason>; now(): number; deadline: number }`
  - `export type OrphanRecoveryResult = { checkedSessions: number; recovered: RecoveredOrder[]; failed: number; timeBudgetExhausted: boolean }`
  - `export function placedOrderId(result: ReconcileResult): string | null`
  - `export async function recoverOrphanPayments(deps: OrphanRecoveryDeps): Promise<OrphanRecoveryResult>`
  - `export type OrdersQueryClient`・`export type CheckoutSessionLister`（DB と Stripe の必要な形だけ）
  - `export function createOrphanRecoveryDeps(options: { db: OrdersQueryClient; opsStore: OpsStore; stripe: CheckoutSessionLister; reconcilerDeps: ReconcilerDeps; deadline: number }): OrphanRecoveryDeps`
  - `export async function loadRecoveredOrderSummaries(db: OrdersQueryClient, recovered: RecoveredOrder[]): Promise<RecoveredOrderSummary[]>`（金額を読めなければ `null` のまま返す）

- [ ] **Step 1: テストを書く**

`tests/unit/lib/stripe/orphan-payment-recovery.test.ts`:

```ts
const mockReconcileCheckoutPayment = jest.fn();
jest.mock('@/lib/stripe/checkout-payment-reconciler', () => ({
  reconcileCheckoutPayment: (...args: unknown[]) => mockReconcileCheckoutPayment(...args),
}));

import {
  ORDER_LOOKUP_BATCH_SIZE,
  ORPHAN_LOOKBACK_SECONDS,
  createOrphanRecoveryDeps,
  loadRecoveredOrderSummaries,
  placedOrderId,
  recoverOrphanPayments,
  type OrdersQueryClient,
  type OrphanRecoveryDeps,
} from '@/lib/stripe/orphan-payment-recovery';
import type { ReconcileResult, ReconcilerDeps } from '@/lib/stripe/checkout-payment-reconciler';
import type { OpsStore } from '@/lib/ops/ops-store';

const NOW = Date.parse('2026-10-05T03:00:00.000Z');
const RECONCILER_DEPS = { name: 'reconciler-deps' } as unknown as ReconcilerDeps;

function placed(orderId: string, type: 'place_and_mark_paid' | 'place_and_mark_awaiting' = 'place_and_mark_paid'): ReconcileResult {
  return { kind: 'ok', action: { type }, orderId, orderStatus: type === 'place_and_mark_paid' ? 'paid' : 'pending' };
}

async function* sessions(ids: string[]): AsyncIterable<string> {
  for (const id of ids) yield id;
}

/** 呼び出しを確かめられるよう、外の関数を jest.fn にした形 */
type MockedDeps = Omit<OrphanRecoveryDeps, 'listCompletedSessionIds' | 'findSessionIdsWithOrders' | 'reconcile' | 'markRecovered'> & {
  listCompletedSessionIds: jest.Mock;
  findSessionIdsWithOrders: jest.Mock;
  reconcile: jest.Mock;
  markRecovered: jest.Mock;
};

function recoveryDeps(overrides: Partial<MockedDeps> = {}): MockedDeps {
  return {
    listCompletedSessionIds: jest.fn(() => sessions(['cs_1', 'cs_2', 'cs_3'])),
    findSessionIdsWithOrders: jest.fn(async () => new Set<string>()),
    reconcile: jest.fn(async (sessionId: string) => placed(`order-${sessionId}`)),
    markRecovered: jest.fn(async () => 'recovered_from_payment' as const),
    now: () => NOW,
    deadline: NOW + 45_000,
    ...overrides,
  };
}

describe('recoverOrphanPayments（注文の無い支払いの拾い上げ）', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('直近24時間の完了済みの Session を読み、注文の無いものだけを照合関数に渡して印を付ける', async () => {
    const deps = recoveryDeps({ findSessionIdsWithOrders: jest.fn(async () => new Set(['cs_2'])) });

    const result = await recoverOrphanPayments(deps);

    expect(ORPHAN_LOOKBACK_SECONDS).toBe(86400);
    expect(deps.listCompletedSessionIds).toHaveBeenCalledWith(Math.floor(NOW / 1000) - 86400);
    expect(deps.findSessionIdsWithOrders).toHaveBeenCalledWith(['cs_1', 'cs_2', 'cs_3']);
    expect(deps.reconcile.mock.calls.map(([sessionId]) => sessionId)).toEqual(['cs_1', 'cs_3']);
    expect(deps.markRecovered.mock.calls.map(([orderId]) => orderId)).toEqual(['order-cs_1', 'order-cs_3']);
    expect(result).toEqual({
      checkedSessions: 3,
      recovered: [
        { orderId: 'order-cs_1', reviewReason: 'recovered_from_payment' },
        { orderId: 'order-cs_3', reviewReason: 'recovered_from_payment' },
      ],
      failed: 0,
      timeBudgetExhausted: false,
    });
  });

  it('照合の結果が注文を作っていなければ印を付けない（Webhook が先に作った・対象外・要対応）', async () => {
    const results: ReconcileResult[] = [
      { kind: 'ok', action: { type: 'none' }, orderId: 'order-webhook', orderStatus: 'paid' },
      { kind: 'ok', action: { type: 'record_only', note: 'not_applicable' }, orderId: null, orderStatus: null },
      { kind: 'needs_action', exceptionId: 'exception-1', reason: 'order_not_creatable', orderId: null, orderStatus: null },
    ];
    const deps = recoveryDeps({ reconcile: jest.fn(async () => results.shift()!) });

    const result = await recoverOrphanPayments(deps);

    expect(deps.markRecovered).not.toHaveBeenCalled();
    expect(result.recovered).toEqual([]);
  });

  it('在庫を確保できなかった注文は、在庫の理由のまま返す', async () => {
    const deps = recoveryDeps({
      listCompletedSessionIds: jest.fn(() => sessions(['cs_1'])),
      reconcile: jest.fn(async (): Promise<ReconcileResult> => ({
        kind: 'needs_review', action: { type: 'place_and_mark_paid' }, orderId: 'order-1', orderStatus: 'paid',
      })),
      markRecovered: jest.fn(async () => 'stock_not_reserved' as const),
    });

    const result = await recoverOrphanPayments(deps);

    expect(result.recovered).toEqual([{ orderId: 'order-1', reviewReason: 'stock_not_reserved' }]);
  });

  it('1件の失敗で残りを止めず、失敗の数に入れる', async () => {
    const deps = recoveryDeps({
      listCompletedSessionIds: jest.fn(() => sessions(['cs_1', 'cs_2'])),
      reconcile: jest.fn()
        .mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'stripe_unavailable' }))
        .mockResolvedValueOnce(placed('order-cs_2')),
    });

    const result = await recoverOrphanPayments(deps);

    expect(result.failed).toBe(1);
    expect(result.recovered).toEqual([{ orderId: 'order-cs_2', reviewReason: 'recovered_from_payment' }]);
  });

  it('時間の予算を過ぎたら新しく照合せず、残りは次の回に回す', async () => {
    let clock = NOW;
    const deps = recoveryDeps({
      now: () => clock,
      reconcile: jest.fn(async (sessionId: string) => {
        clock += 30_000;
        return placed(`order-${sessionId}`);
      }),
    });

    const result = await recoverOrphanPayments(deps);

    expect(deps.reconcile).toHaveBeenCalledTimes(2);
    expect(result.timeBudgetExhausted).toBe(true);
    expect(result.recovered).toHaveLength(2);
  });

  it('注文の有無は100件ごとにまとめて確かめる', async () => {
    const ids = Array.from({ length: 150 }, (_, index) => `cs_${index}`);
    const deps = recoveryDeps({
      listCompletedSessionIds: jest.fn(() => sessions(ids)),
      findSessionIdsWithOrders: jest.fn(async (batch: string[]) => new Set(batch)),
    });

    const result = await recoverOrphanPayments(deps);

    expect(ORDER_LOOKUP_BATCH_SIZE).toBe(100);
    expect(deps.findSessionIdsWithOrders.mock.calls.map(([batch]) => batch.length)).toEqual([100, 50]);
    expect(deps.reconcile).not.toHaveBeenCalled();
    expect(result.checkedSessions).toBe(150);
  });

  it('注文の有無を確かめられなければ、その回の拾い上げをやめる（呼び出し側で失敗として数える）', async () => {
    const deps = recoveryDeps({
      findSessionIdsWithOrders: jest.fn(async () => {
        throw Object.assign(new Error('down'), { code: 'db_unavailable' });
      }),
    });

    await expect(recoverOrphanPayments(deps)).rejects.toMatchObject({ code: 'db_unavailable' });
    expect(deps.reconcile).not.toHaveBeenCalled();
  });
});

describe('placedOrderId', () => {
  it('注文を作る行動のときだけ注文の ID を返す', () => {
    expect(placedOrderId(placed('order-1'))).toBe('order-1');
    expect(placedOrderId(placed('order-2', 'place_and_mark_awaiting'))).toBe('order-2');
    expect(placedOrderId({ kind: 'ok', action: { type: 'mark_awaiting' }, orderId: 'order-3', orderStatus: 'pending' })).toBeNull();
    expect(placedOrderId({ kind: 'needs_action', exceptionId: 'e', reason: 'order_not_creatable', orderId: null, orderStatus: null })).toBeNull();
  });
});

describe('createOrphanRecoveryDeps', () => {
  function ordersClient(responses: Array<{ data: unknown; error: unknown }>) {
    const inFn = jest.fn();
    for (const response of responses) inFn.mockResolvedValueOnce(response);
    const select = jest.fn(() => ({ in: inFn }));
    return { db: { from: jest.fn(() => ({ select })) } as unknown as OrdersQueryClient, select, inFn };
  }

  it('Stripe から直近の完了済みの Session を読み、ID を返す', async () => {
    const list = jest.fn(() => (async function* () {
      yield { id: 'cs_1' };
      yield { id: 'cs_2' };
    })());
    const deps = createOrphanRecoveryDeps({
      db: ordersClient([]).db,
      opsStore: { rpc: jest.fn() } as unknown as OpsStore,
      stripe: { checkout: { sessions: { list } } },
      reconcilerDeps: RECONCILER_DEPS,
      deadline: NOW,
    });

    const seen: string[] = [];
    for await (const sessionId of deps.listCompletedSessionIds(1_000)) seen.push(sessionId);

    expect(list).toHaveBeenCalledWith({ created: { gte: 1_000 }, status: 'complete', limit: 100 });
    expect(seen).toEqual(['cs_1', 'cs_2']);
    expect(deps.deadline).toBe(NOW);
  });

  it('注文のある Session の ID を集め、DB の失敗は db_unavailable にする', async () => {
    const { db, select, inFn } = ordersClient([
      { data: [{ checkout_session_id: 'cs_1' }], error: null },
      { data: null, error: { message: 'down' } },
    ]);
    const deps = createOrphanRecoveryDeps({
      db,
      opsStore: { rpc: jest.fn() } as unknown as OpsStore,
      stripe: { checkout: { sessions: { list: jest.fn() } } },
      reconcilerDeps: RECONCILER_DEPS,
      deadline: NOW,
    });

    await expect(deps.findSessionIdsWithOrders(['cs_1', 'cs_2'])).resolves.toEqual(new Set(['cs_1']));
    expect(select).toHaveBeenCalledWith('checkout_session_id');
    expect(inFn).toHaveBeenCalledWith('checkout_session_id', ['cs_1', 'cs_2']);
    await expect(deps.findSessionIdsWithOrders(['cs_3'])).rejects.toMatchObject({ code: 'db_unavailable' });
  });

  it('照合関数には Session ID だけを渡し、印は DB の関数で付ける', async () => {
    mockReconcileCheckoutPayment.mockResolvedValue(placed('order-1'));
    const rpc = jest.fn().mockResolvedValue({ data: 'recovered_from_payment', error: null });
    const deps = createOrphanRecoveryDeps({
      db: ordersClient([]).db,
      opsStore: { rpc } as unknown as OpsStore,
      stripe: { checkout: { sessions: { list: jest.fn() } } },
      reconcilerDeps: RECONCILER_DEPS,
      deadline: NOW,
    });

    await expect(deps.reconcile('cs_1')).resolves.toEqual(placed('order-1'));
    expect(mockReconcileCheckoutPayment).toHaveBeenCalledWith(RECONCILER_DEPS, { checkoutSessionId: 'cs_1' });
    await expect(deps.markRecovered('order-1')).resolves.toBe('recovered_from_payment');
    expect(rpc).toHaveBeenCalledWith('mark_order_recovered_from_payment', { _order_id: 'order-1' });
  });
});

describe('loadRecoveredOrderSummaries', () => {
  it('拾った注文の金額を読む。読めなければ金額不明（null）のまま返す', async () => {
    const inFn = jest.fn()
      .mockResolvedValueOnce({ data: [{ id: 'order-1', total_amount: 12000, currency: 'jpy' }], error: null })
      .mockResolvedValueOnce({ data: null, error: { message: 'down' } });
    const db = { from: () => ({ select: () => ({ in: inFn }) }) } as unknown as OrdersQueryClient;
    const recovered = [
      { orderId: 'order-1', reviewReason: 'recovered_from_payment' as const },
      { orderId: 'order-2', reviewReason: 'stock_not_reserved' as const },
    ];

    await expect(loadRecoveredOrderSummaries(db, recovered)).resolves.toEqual([
      { orderId: 'order-1', reviewReason: 'recovered_from_payment', totalAmount: 12000, currency: 'jpy' },
      { orderId: 'order-2', reviewReason: 'stock_not_reserved', totalAmount: null, currency: null },
    ]);
    expect(inFn).toHaveBeenCalledWith('id', ['order-1', 'order-2']);
    await expect(loadRecoveredOrderSummaries(db, recovered.slice(0, 1))).resolves.toEqual([
      { orderId: 'order-1', reviewReason: 'recovered_from_payment', totalAmount: null, currency: null },
    ]);
  });

  it('拾った注文が無ければ DB を読まない', async () => {
    const from = jest.fn();
    await expect(loadRecoveredOrderSummaries({ from } as unknown as OrdersQueryClient, [])).resolves.toEqual([]);
    expect(from).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: テストが落ちることを確かめる**

Run: `npx jest tests/unit/lib/stripe/orphan-payment-recovery.test.ts`
Expected: FAIL（`@/lib/stripe/orphan-payment-recovery` が無い）

- [ ] **Step 3: 部品を作る**

`src/lib/stripe/orphan-payment-recovery.ts`:

```ts
import {
  reconcileCheckoutPayment,
  type ReconcileResult,
  type ReconcilerDeps,
} from '@/lib/stripe/checkout-payment-reconciler';
import { ReconcileTransientError } from '@/lib/stripe/checkout-payment-reader';
import { webhookFailureCause } from '@/lib/stripe/webhook-events';
import { markOrderRecoveredFromPayment, type OpsStore, type RecoveredReviewReason } from '@/lib/ops/ops-store';
import type { RecoveredOrderSummary } from '@/lib/ops/ops-alert-mail';

/**
 * 注文の無い支払いの拾い上げ（設計書 2026-10-05 グループ B の 3-5・3-6）。毎時の見回りの最後に動く。
 * 直近24時間に作られた完了済みの Checkout Session のうち、注文の無いものを照合関数に渡す。
 * 照合関数がその呼び出しで注文を作ったときだけ、要確認「支払いから作った注文」を付ける
 * （同じ頃に Webhook が作った注文には付けない）。読む範囲は毎回24時間で重なるので、
 * 1回失敗しても次の回で拾える。同じ Session を何度渡しても、照合関数は同じ結果に収まる（グループ A）。
 */
export const ORPHAN_LOOKBACK_SECONDS = 24 * 60 * 60;

/** 注文の有無を1回の問い合わせで確かめる Session の数 */
export const ORDER_LOOKUP_BATCH_SIZE = 100;

export type RecoveredOrder = { orderId: string; reviewReason: RecoveredReviewReason };

export type OrphanRecoveryDeps = {
  listCompletedSessionIds(createdGteSeconds: number): AsyncIterable<string>;
  findSessionIdsWithOrders(sessionIds: string[]): Promise<Set<string>>;
  reconcile(checkoutSessionId: string): Promise<ReconcileResult>;
  markRecovered(orderId: string): Promise<RecoveredReviewReason>;
  now(): number;
  /** この時刻（ミリ秒）を過ぎたら新しく照合しない */
  deadline: number;
};

export type OrphanRecoveryResult = {
  checkedSessions: number;
  recovered: RecoveredOrder[];
  failed: number;
  timeBudgetExhausted: boolean;
};

const PLACE_ACTIONS: ReadonlySet<string> = new Set(['place_and_mark_paid', 'place_and_mark_awaiting']);

/** 照合関数がこの呼び出しで注文を作ったなら、その注文の ID */
export function placedOrderId(result: ReconcileResult): string | null {
  if (result.kind === 'needs_action' || !PLACE_ACTIONS.has(result.action.type)) return null;
  return result.orderId;
}

export async function recoverOrphanPayments(deps: OrphanRecoveryDeps): Promise<OrphanRecoveryResult> {
  const result: OrphanRecoveryResult = { checkedSessions: 0, recovered: [], failed: 0, timeBudgetExhausted: false };
  const createdGte = Math.floor(deps.now() / 1000) - ORPHAN_LOOKBACK_SECONDS;

  /** 時間切れなら false */
  const recoverBatch = async (sessionIds: string[]): Promise<boolean> => {
    const withOrders = await deps.findSessionIdsWithOrders(sessionIds);
    for (const sessionId of sessionIds) {
      if (withOrders.has(sessionId)) continue;
      if (deps.now() >= deps.deadline) return false;
      try {
        const orderId = placedOrderId(await deps.reconcile(sessionId));
        if (orderId) result.recovered.push({ orderId, reviewReason: await deps.markRecovered(orderId) });
      } catch (error) {
        // 1件の失敗で残りを止めない。次の回も同じ Session を読むので、そこで拾い直す
        result.failed += 1;
        console.error('[orphan-recovery] Failed to recover a payment', sessionId, webhookFailureCause(error));
      }
    }
    return true;
  };

  let batch: string[] = [];
  for await (const sessionId of deps.listCompletedSessionIds(createdGte)) {
    if (deps.now() >= deps.deadline) {
      result.timeBudgetExhausted = true;
      return result;
    }
    result.checkedSessions += 1;
    batch.push(sessionId);
    if (batch.length < ORDER_LOOKUP_BATCH_SIZE) continue;
    if (!(await recoverBatch(batch))) {
      result.timeBudgetExhausted = true;
      return result;
    }
    batch = [];
  }
  if (batch.length > 0 && !(await recoverBatch(batch))) result.timeBudgetExhausted = true;
  return result;
}

/** 注文の表の、拾い上げに要る読み方だけ */
export type OrdersQueryClient = {
  from(table: 'orders'): {
    select(columns: string): {
      in(column: string, values: string[]): PromiseLike<{
        data: Array<Record<string, unknown>> | null;
        error: { message?: string } | null;
      }>;
    };
  };
};

/** Stripe の Checkout Session の一覧の、拾い上げに要る読み方だけ */
export type CheckoutSessionLister = {
  checkout: {
    sessions: {
      list(params: { created: { gte: number }; status: 'complete'; limit: number }): AsyncIterable<{ id: string }>;
    };
  };
};

async function* completedSessionIds(stripe: CheckoutSessionLister, createdGteSeconds: number): AsyncIterable<string> {
  const list = stripe.checkout.sessions.list({ created: { gte: createdGteSeconds }, status: 'complete', limit: 100 });
  for await (const session of list) yield session.id;
}

export function createOrphanRecoveryDeps(options: {
  db: OrdersQueryClient;
  opsStore: OpsStore;
  stripe: CheckoutSessionLister;
  reconcilerDeps: ReconcilerDeps;
  deadline: number;
}): OrphanRecoveryDeps {
  return {
    listCompletedSessionIds: (createdGteSeconds) => completedSessionIds(options.stripe, createdGteSeconds),
    findSessionIdsWithOrders: async (sessionIds) => {
      const { data, error } = await options.db
        .from('orders')
        .select('checkout_session_id')
        .in('checkout_session_id', sessionIds);
      if (error) throw new ReconcileTransientError('db_unavailable');
      return new Set((data ?? []).map((row) => String(row.checkout_session_id)));
    },
    reconcile: (checkoutSessionId) => reconcileCheckoutPayment(options.reconcilerDeps, { checkoutSessionId }),
    markRecovered: (orderId) => markOrderRecoveredFromPayment(options.opsStore, orderId),
    now: () => Date.now(),
    deadline: options.deadline,
  };
}

/** 店へのメールに載せる金額を読む。読めなくてもメールは送る（金額は「金額不明」になる）。 */
export async function loadRecoveredOrderSummaries(
  db: OrdersQueryClient,
  recovered: RecoveredOrder[],
): Promise<RecoveredOrderSummary[]> {
  if (recovered.length === 0) return [];
  const { data, error } = await db
    .from('orders')
    .select('id, total_amount, currency')
    .in('id', recovered.map((order) => order.orderId));
  const rows = new Map((error ? [] : data ?? []).map((row) => [String(row.id), row]));
  return recovered.map(({ orderId, reviewReason }) => {
    const row = rows.get(orderId);
    return {
      orderId,
      reviewReason,
      totalAmount: typeof row?.total_amount === 'number' ? row.total_amount : null,
      currency: typeof row?.currency === 'string' ? row.currency : null,
    };
  });
}
```

- [ ] **Step 4: テストが通ることを確かめる**

Run: `npx jest tests/unit/lib/stripe/orphan-payment-recovery.test.ts`
Expected: PASS（13件）

Run: `npm run typecheck`
Expected: エラー0

- [ ] **Step 5: コミットの文を書く**

`.superpowers/sdd/2026-10-05-webhook-queue-operations/task-10-commit-msg.txt`:

```text
feat(stripe): 注文の無い支払いを拾って注文にし、要確認の印を付ける部品を足す

直近24時間に作られた完了済みの Checkout Session のうち、注文の無いものを
照合関数に渡す。照合関数がその呼び出しで注文を作ったときだけ、要確認
「支払いから作った注文」を付ける。1件の失敗で残りを止めず、時間の予算を
過ぎたら次の回に回す。見回りへの組み込みは次のコミット。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

---

### Task 11: 見回りに拾い上げ・知らせ・記録・点検を組み込む

設計書 3-5・4-6・6。毎時の見回りの今の処理（未入金の注文の照合、要対応のメールの送り直し）の後に、Task 10 の拾い上げを今の45秒の予算の残りで行う。拾って作った注文は、その回の1通にまとめて店へ知らせる。最後に、最後の成功（または失敗）を記録し、点検する。

**Files:**
- Modify: `src/app/api/cron/expire-pending-orders/route.ts`
- Modify: `tests/unit/api/cron/expire-pending-orders-route.test.ts`

**Interfaces:**
- Consumes: Task 3 の `recordHeartbeat`・`OpsStore`、Task 4 の `recoveredOrdersMail`・`sendOpsAlertMail`、Task 5 の `runOpsChecks`、Task 8 の `authorizeCronRequest`（入口は Task 8 で置き換え済み）、Task 10 の `recoverOrphanPayments`・`createOrphanRecoveryDeps`・`loadRecoveredOrderSummaries`・`OrphanRecoveryResult`・`OrdersQueryClient`・`CheckoutSessionLister`
- Produces: 見回りの応答と監査の `metadata` に `checkedSessions`・`recoveredOrders`・`recoveredOrdersNotified` が加わる。`ops_job_heartbeats` の `order_sweep` を記録する（候補の数え・一覧の DB の失敗は `db_unavailable` の失敗）

- [ ] **Step 1: テストを足す**

`tests/unit/api/cron/expire-pending-orders-route.test.ts` を次のように直す（Task 8 の直しの後）:

1. `jest.mock('@/features/auth/middleware/rateLimit', …);` の塊の次に足す:

```ts

const mockRecoverOrphanPayments = jest.fn();
const mockCreateOrphanRecoveryDeps = jest.fn((options: unknown) => ({ options }));
const mockLoadRecoveredOrderSummaries = jest.fn();
jest.mock('@/lib/stripe/orphan-payment-recovery', () => ({
  recoverOrphanPayments: (...args: unknown[]) => mockRecoverOrphanPayments(...args),
  createOrphanRecoveryDeps: (...args: unknown[]) => mockCreateOrphanRecoveryDeps(...args),
  loadRecoveredOrderSummaries: (...args: unknown[]) => mockLoadRecoveredOrderSummaries(...args),
}));

const mockRecordHeartbeat = jest.fn();
jest.mock('@/lib/ops/ops-store', () => ({
  recordHeartbeat: (...args: unknown[]) => mockRecordHeartbeat(...args),
}));

const mockRunOpsChecks = jest.fn();
jest.mock('@/lib/ops/ops-checks', () => ({
  runOpsChecks: (...args: unknown[]) => mockRunOpsChecks(...args),
}));

const mockSendOpsAlertMail = jest.fn();
jest.mock('@/lib/ops/ops-alert-mail', () => ({
  sendOpsAlertMail: (...args: unknown[]) => mockSendOpsAlertMail(...args),
  recoveredOrdersMail: (orders: unknown[]) => ({
    kind: 'orders_recovered_from_payment',
    subject: 'recovered',
    lines: [String(orders.length)],
  }),
}));
```

2. `beforeEach` の本体の最後（`candidates([]);` の後）に足す:

```ts
    mockRecoverOrphanPayments.mockResolvedValue({ checkedSessions: 0, recovered: [], failed: 0, timeBudgetExhausted: false });
    mockLoadRecoveredOrderSummaries.mockResolvedValue([]);
    mockRecordHeartbeat.mockResolvedValue(undefined);
    mockRunOpsChecks.mockResolvedValue({ backlogAlerted: false, deadNotified: 0, staleAlerted: [], failedChecks: [] });
    mockSendOpsAlertMail.mockResolvedValue(true);
```

3. 「45秒の時間予算を超えたら残りを打ち切り、店への送り直しもしない」のテストの `expect(mockListUnsentShopAlerts).not.toHaveBeenCalled();` の次の行に足す:

```ts
    expect(mockRecoverOrphanPayments).not.toHaveBeenCalled();
```

4. ファイルの最後の `});` の前に足す:

```ts

  it('注文の無い支払いの拾い上げを、見回りの45秒の残りで行う（設計書 3-5）', async () => {
    await sweep();

    expect(mockCreateOrphanRecoveryDeps).toHaveBeenCalledWith(expect.objectContaining({
      db: mockServiceClient,
      opsStore: mockServiceClient,
      stripe: mockStripe,
      reconcilerDeps: mockDeps,
      deadline: NOW + 45_000,
    }));
    expect(mockRecoverOrphanPayments).toHaveBeenCalledTimes(1);
  });

  it('拾って作った注文を、その回の1通にまとめて店へ知らせる', async () => {
    const recovered = [
      { orderId: 'order-r1', reviewReason: 'recovered_from_payment' },
      { orderId: 'order-r2', reviewReason: 'stock_not_reserved' },
    ];
    mockRecoverOrphanPayments.mockResolvedValue({ checkedSessions: 5, recovered, failed: 0, timeBudgetExhausted: false });
    mockLoadRecoveredOrderSummaries.mockResolvedValue(
      recovered.map((order) => ({ ...order, totalAmount: 12000, currency: 'jpy' })),
    );

    const response = await sweep();

    expect(mockLoadRecoveredOrderSummaries).toHaveBeenCalledWith(mockServiceClient, recovered);
    expect(mockSendOpsAlertMail).toHaveBeenCalledTimes(1);
    expect(mockSendOpsAlertMail).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'orders_recovered_from_payment',
      lines: ['2'],
    }));
    expect(response.body).toMatchObject({ checkedSessions: 5, recoveredOrders: 2, recoveredOrdersNotified: true });
  });

  it('拾って作った注文が無ければ、そのメールを送らない', async () => {
    const response = await sweep();

    expect(mockSendOpsAlertMail).not.toHaveBeenCalled();
    expect(response.body).toMatchObject({ recoveredOrders: 0, recoveredOrdersNotified: false });
  });

  it('拾い上げが失敗しても見回りは最後まで進み、失敗の数に入れる', async () => {
    mockRecoverOrphanPayments.mockRejectedValue(Object.assign(new Error('x'), { type: 'StripeConnectionError' }));
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});

    const response = await sweep();

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ failed: 1, recoveredOrders: 0 });
    expect(error).toHaveBeenCalledWith('[cron] failed to recover orphan payments', 'stripe_unavailable');
    expect(mockRecordHeartbeat).toHaveBeenCalledWith(mockServiceClient, 'order_sweep', true, null);
    error.mockRestore();
  });

  it('見回りの最後に最後の成功を記録し、点検する（設計書 4-6）', async () => {
    await sweep();

    expect(mockRecordHeartbeat).toHaveBeenCalledWith(mockServiceClient, 'order_sweep', true, null);
    expect(mockRunOpsChecks).toHaveBeenCalledWith(expect.objectContaining({ store: mockServiceClient }));
    expect(mockRunOpsChecks.mock.invocationCallOrder[0]).toBeGreaterThan(mockRecordHeartbeat.mock.invocationCallOrder[0]);
  });

  it('候補を数えられなければ、失敗（db_unavailable）を記録して 500', async () => {
    mockSelect.mockImplementation(() => ({
      or: () => Promise.resolve({ count: null, error: { message: 'down' } }),
    }));
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});

    const response = await sweep();

    expect(response.status).toBe(500);
    expect(mockRecordHeartbeat).toHaveBeenCalledWith(mockServiceClient, 'order_sweep', false, 'db_unavailable');
    expect(mockRunOpsChecks).toHaveBeenCalled();
    error.mockRestore();
  });

  it('最後の成功を記録できなくても、点検と応答は変わらない', async () => {
    mockRecordHeartbeat.mockRejectedValue(new Error('db down'));
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});

    const response = await sweep();

    expect(response.status).toBe(200);
    expect(mockRunOpsChecks).toHaveBeenCalled();
    error.mockRestore();
  });
```

- [ ] **Step 2: テストが落ちることを確かめる**

Run: `npx jest tests/unit/api/cron/expire-pending-orders-route.test.ts`
Expected: FAIL（拾い上げ・記録・点検を呼ばない）

- [ ] **Step 3: 見回りを直す**

`src/app/api/cron/expire-pending-orders/route.ts` を次のように直す（Task 8 の直しの後）:

1. `import { authorizeCronRequest } from '@/lib/cron/auth';` の次の行に足す:

```ts
import { recordHeartbeat, type OpsStore } from '@/lib/ops/ops-store';
import { runOpsChecks } from '@/lib/ops/ops-checks';
import { recoveredOrdersMail, sendOpsAlertMail } from '@/lib/ops/ops-alert-mail';
import {
  createOrphanRecoveryDeps,
  loadRecoveredOrderSummaries,
  recoverOrphanPayments,
  type CheckoutSessionLister,
  type OrdersQueryClient,
  type OrphanRecoveryResult,
} from '@/lib/stripe/orphan-payment-recovery';
import { webhookFailureCause } from '@/lib/stripe/webhook-events';
```

2. 先頭の説明の `// pg_cron + pg_net から呼ばれる。net.http_post は POST しか送れないため POST。` の行の前に、次の3行を足す:

```ts
// 最後に、直近24時間の完了済みの決済のうち注文の無いものを拾って注文にし、要確認「支払いから作った注文」を付ける。
// 拾った注文はその回の1通にまとめて店へ知らせる。最後の成功を記録し、溜まり・退避・遅れを点検する
// （設計書 2026-10-05 グループ B の 3-5・4-6）。
```

3. `function resolveHourlyBatchOffset(` の関数の後ろに足す:

```ts

/** 最後の成功・失敗を記録し、点検する（設計書 2026-10-05 グループ B の 4-6）。どちらの失敗も応答を変えない。 */
async function finishSweep(store: OpsStore, succeeded: boolean, errorCode: string | null): Promise<void> {
  try {
    await recordHeartbeat(store, 'order_sweep', succeeded, errorCode);
  } catch (error) {
    console.error('[cron] failed to record the sweep heartbeat', error instanceof Error ? error.name : 'UnknownError');
  }
  await runOpsChecks({ store, send: sendOpsAlertMail, now: () => new Date() });
}
```

4. `const supabase = await createServiceRoleClient();` の次の行に足す:

```ts
  const opsStore = supabase as unknown as OpsStore;
```

5. 候補を数える失敗の `if (countError) {` の塊と、一覧の失敗の `if (error) {` の塊の、それぞれの `return NextResponse.json({ error: 'Failed to list orders' }, { status: 500 });` の直前に、次の1行を足す:

```ts
    await finishSweep(opsStore, false, 'db_unavailable');
```

6. 要対応のメールの送り直しの `if (!timeBudgetExhausted) { … }` の塊の後ろ（`const summary = {` の前）に足す:

```ts

  // 注文の無い支払いの拾い上げ（設計書 3-5）。今の45秒の予算の残りで行い、読み切れない分は次の回に回す
  let recovery: OrphanRecoveryResult | null = null;
  if (!timeBudgetExhausted) {
    try {
      recovery = await recoverOrphanPayments(createOrphanRecoveryDeps({
        db: supabase as unknown as OrdersQueryClient,
        opsStore,
        stripe: stripe as unknown as CheckoutSessionLister,
        reconcilerDeps: deps,
        deadline: startedAt + TIME_BUDGET_MS,
      }));
      failed += recovery.failed;
      timeBudgetExhausted = recovery.timeBudgetExhausted;
    } catch (recoveryError) {
      console.error('[cron] failed to recover orphan payments', webhookFailureCause(recoveryError));
      failed += 1;
    }
  }

  // 拾って作った注文は、その回の1通にまとめて店へ知らせる（見回り1回につき1通。設計書 6）
  let recoveredOrdersNotified = false;
  if (recovery && recovery.recovered.length > 0) {
    try {
      const summaries = await loadRecoveredOrderSummaries(supabase as unknown as OrdersQueryClient, recovery.recovered);
      recoveredOrdersNotified = await sendOpsAlertMail(recoveredOrdersMail(summaries));
    } catch (mailError) {
      console.error('[cron] failed to notify recovered orders', webhookFailureCause(mailError));
    }
  }
```

7. `const summary = {` の中の `shopAlertsSent,` の次の行に足す:

```ts
    checkedSessions: recovery?.checkedSessions ?? 0,
    recoveredOrders: recovery?.recovered.length ?? 0,
    recoveredOrdersNotified,
```

8. 最後の `return NextResponse.json(summary);` の直前に足す:

```ts
  await finishSweep(opsStore, true, null);
```

- [ ] **Step 4: テストが通ることを確かめる**

Run: `npx jest tests/unit/api/cron/expire-pending-orders-route.test.ts tests/unit/lib/cron/auth.test.ts`
Expected: PASS

Run: `npm run typecheck`
Expected: エラー0

- [ ] **Step 5: コミットの文を書く**

`.superpowers/sdd/2026-10-05-webhook-queue-operations/task-11-commit-msg.txt`:

```text
feat(cron): 毎時の見回りで注文の無い支払いを拾い、記録して点検する

見回りの今の処理の後に、直近24時間の完了済みの決済のうち注文の無いものを
45秒の予算の残りで拾い、要確認「支払いから作った注文」を付ける。拾った注文は
その回の1通にまとめて店へ知らせる。最後の成功を記録し、溜まり・退避・遅れを
点検する。候補を読めないときは失敗として記録する。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

---

### Task 12: 要確認「支払いから作った注文」の文言と画面（FREQ-415）

設計書 3-6。管理画面の要対応・要確認の欄に「支払いから作った注文：お客様へ確認してください」を出す。欄・一覧の要確認の印・サイドメニューの件数・「確認済みにする」は今の仕組みのまま使う（`review_reason` を持つ注文は全部そこに出る）。要求管理のルールに従い、FREQ と E2E を足す。

**Files:**
- Modify: `src/app/api/admin/order-attention/route.ts`（`REVIEW_REASON_LABELS`）
- Modify: `tests/unit/api/admin/order-attention-route.test.ts`
- Modify: `docs/02_Requirements/requirements.md`（FREQ-415 の行）、`docs/04_DetailDesign/pages/16_admin.md`（要確認の説明）
- Create: `e2e/FR-ADMIN-064-recovered-order-review.spec.ts`

**Interfaces:**
- Consumes: Task 2 の `orders.review_reason` の値 `recovered_from_payment`、Task 11 の見回り（印を付ける側）
- Produces: `GET /api/admin/order-attention` の `reviews[].reviewReasonLabel` が `recovered_from_payment` のとき「支払いから作った注文：お客様へ確認してください」

- [ ] **Step 1: 番号を確かめる**

Run: `grep -oE "FREQ-[0-9]+" docs/02_Requirements/requirements.md | sort -t- -k2 -n | tail -1` と `ls e2e | grep "FR-ADMIN-" | sort -V | tail -1`
Expected: `FREQ-414` と `FR-ADMIN-063-order-cancel-dialog.spec.ts`。違えば、以下の FREQ-415・FR-ADMIN-064 を次の番号に読み替える（Task 13 の FREQ-416 も1つずつずらす）

- [ ] **Step 2: テストを書く**

`tests/unit/api/admin/order-attention-route.test.ts` の「未解決の要対応と未確認の要確認を、件数と一緒に返す」のテストの後ろに足す:

```ts

  it('支払いから作った注文の要確認を、お客様へ確認する文言で返す（FREQ-415）', async () => {
    reviewRows = [{
      id: ORDER_ID,
      status: 'paid',
      review_reason: 'recovered_from_payment',
      review_marked_at: '2026-10-05T01:00:00.000Z',
    }];

    const res = (await getAttention(new Request('http://localhost/api/admin/order-attention'))) as unknown as RouteResponse;

    expect(res.status).toBe(200);
    expect(res.body.data.reviews[0]).toEqual({
      orderId: ORDER_ID,
      orderNumber: 'ORD-A1B2C3D4',
      orderStatus: 'paid',
      reviewReason: 'recovered_from_payment',
      reviewReasonLabel: '支払いから作った注文：お客様へ確認してください',
      reviewMarkedAt: '2026-10-05T01:00:00.000Z',
    });
  });
```

`e2e/FR-ADMIN-064-recovered-order-review.spec.ts`:

```ts
import { test, expect, Page } from '@playwright/test';
import { mockAdminBackgroundApis } from './admin-test-utils';

// FREQ-415: 毎時の見回りが支払いから作った注文に要確認「支払いから作った注文」を付け、
// ORDER タブの要対応・要確認の欄に出す。お客様へ確認したら「確認済みにする」で欄から消す。
const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 900 },
];

const LABEL = '支払いから作った注文：お客様へ確認してください';

const REVIEW = {
  orderId: 'd1b2c3d4-1111-2222-8333-444455556666',
  orderNumber: 'ORD-D1B2C3D4',
  orderStatus: 'paid',
  reviewReason: 'recovered_from_payment',
  reviewReasonLabel: LABEL,
  reviewMarkedAt: '2026-10-05T01:00:00.000Z',
};

type AttentionState = { reviews: unknown[] };

async function mockAdminApis(page: Page, state: AttentionState): Promise<void> {
  await mockAdminBackgroundApis(page);
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        authenticated: true,
        user: { id: 'a', email: 'a@e.com', role: 'admin', mfaVerified: true },
      }),
    }),
  );
  await page.route('**/api/admin/kpi', (route) =>
    route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'not mocked' }) }),
  );
  await page.route('**/api/admin/order-attention', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          exceptions: [],
          reviews: state.reviews,
          counts: { exceptions: 0, reviews: state.reviews.length },
        },
      }),
    }),
  );
  await page.route('**/api/admin/orders?**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: [], pagination: { page: 1, pageSize: 20, total: 0, totalPages: 1 } }),
    }),
  );
  await page.route(`**/api/admin/orders/${REVIEW.orderId}/review`, (route) => {
    state.reviews = [];
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) });
  });
}

async function openOrders(page: Page) {
  await page.goto('/admin');
  await page.getByRole('button', { name: 'ORDER' }).click();
}

for (const viewport of viewports) {
  test.describe(`FR-ADMIN-064 recovered order review (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    test('支払いから作った注文が、お客様へ確認する文言で要確認の欄に出る', async ({ page }) => {
      // FREQ-415-AC-01
      await mockAdminApis(page, { reviews: [REVIEW] });
      await openOrders(page);

      await expect(page.getByRole('heading', { name: '要対応 0件・要確認 1件' })).toBeVisible();
      await expect(page.getByText(`${LABEL}（ORD-D1B2C3D4）`)).toBeVisible();
    });

    test('「確認済みにする」を押すと欄から消える', async ({ page }) => {
      // FREQ-415-AC-02
      await mockAdminApis(page, { reviews: [REVIEW] });
      await openOrders(page);

      await page.getByRole('button', { name: '確認済みにする' }).click();

      await expect(page.getByText(`${LABEL}（ORD-D1B2C3D4）`)).toHaveCount(0);
    });
  });
}
```

- [ ] **Step 3: テストが落ちることを確かめる**

Run: `npx jest tests/unit/api/admin/order-attention-route.test.ts`
Expected: FAIL（`reviewReasonLabel` が `recovered_from_payment` のまま）

E2E はモックの応答で文言を渡すので、この時点でも通る（画面が文言と注文番号を並べて出し、「確認済みにする」で消えることを確かめるテスト）。

- [ ] **Step 4: 文言を足す**

`src/app/api/admin/order-attention/route.ts` の `REVIEW_REASON_LABELS` を次に置き換える:

```ts
const REVIEW_REASON_LABELS: Record<string, string> = {
  stock_not_reserved: '在庫を確保できなかった注文',
  // 毎時の見回りが、注文の無い支払いから作った注文（設計書 2026-10-05 グループ B の 3-6。FREQ-415）
  recovered_from_payment: '支払いから作った注文：お客様へ確認してください',
};
```

`docs/02_Requirements/requirements.md` の `| FREQ-414 |` で始まる行の次の行に、次の1行を足す:

```markdown
| FREQ-415 | 毎時の見回りが、注文の無い Stripe の支払いを注文にしたとき、要確認「支払いから作った注文」を付けて管理画面に出し、店へメールで知らせること（設計書 2026-10-05 グループ B の 3-5・3-6） | FREQ-415-REQ-01<br>FREQ-415-REQ-02<br>FREQ-415-REQ-03 | ・毎時の見回りは、直近24時間に作られた完了済みの Checkout Session のうち注文の無いものを照合関数に渡し、照合関数がその呼び出しで注文を作ったときだけ要確認（`recovered_from_payment`）を付けること。Webhook の経路で作った注文には付けないこと。在庫を確保できなかった注文にも当たるときは、在庫の理由を残すこと<br>・ORDER タブの要対応・要確認の欄に「支払いから作った注文：お客様へ確認してください」と注文番号を出し、「確認済みにする」で欄から消すこと<br>・拾って作った注文は、見回り1回につき1通のメールで店（`SHOP_ALERT_EMAIL`）へ知らせること。注文番号と金額を載せ、お客様の名前・住所・メールアドレスは載せないこと | FREQ-415-AC-01<br>FREQ-415-AC-02 | ・支払いから作った注文が、要対応・要確認の欄に「支払いから作った注文：お客様へ確認してください（注文番号）」と表示されること<br>・「確認済みにする」を押すと、その注文が欄から消えること |
```

`docs/04_DetailDesign/pages/16_admin.md` を次のように直す:

1. `## ORDER タブの要対応・要確認と取消の画面（ADMIN-ORDER-ATTENTION / FREQ-411〜413）` を `## ORDER タブの要対応・要確認と取消の画面（ADMIN-ORDER-ATTENTION / FREQ-411〜413・415）` に変える。
2. 次の行を:

```markdown
- 要確認（`orders.review_reason`）: 在庫を確保できなかった注文（`stock_not_reserved`）。「確認済みにする」で欄から消す
```

次に置き換える:

```markdown
- 要確認（`orders.review_reason`）: 在庫を確保できなかった注文（`stock_not_reserved`）と、毎時の見回りが注文の無い支払いから作った注文（`recovered_from_payment`。表示は「支払いから作った注文：お客様へ確認してください」。FREQ-415）。両方に当たる注文は在庫の理由を残す。「確認済みにする」で欄から消す
```

- [ ] **Step 5: テストが通ることを確かめる**

Run: `npx jest tests/unit/api/admin/order-attention-route.test.ts`
Expected: PASS

Run: `npm run typecheck`
Expected: エラー0

E2E は Task 13 の Step 5 で、Task 13 の E2E と一緒に流す（本番ビルドを作り直すのを1回にするため）。

- [ ] **Step 6: コミットの文を書く**

`.superpowers/sdd/2026-10-05-webhook-queue-operations/task-12-commit-msg.txt`:

```text
feat(admin): 要確認「支払いから作った注文：お客様へ確認してください」を出す

毎時の見回りが注文の無い支払いから作った注文を、要対応・要確認の欄に
お客様へ確認する文言で出す（FREQ-415）。欄・印・件数・確認済みにする
操作は今の仕組みを使う。要件定義書と詳細設計に足し、E2E を作った。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

---

### Task 13: 署名不正の知らせの E2E（FREQ-416）

設計書 5-2・9-1。署名の合わない要求を5回送ると、どれも400が返り、手元のメール受け（Mailpit）に店への知らせが1通だけ届くことを、手元の Supabase と本番ビルドで確かめる。1時間に1回の上限があるので、画面幅ごとに手元の DB の知らせの状態を消してから送る。

**Files:**
- Modify: `docs/02_Requirements/requirements.md`（FREQ-416 の行）
- Create: `e2e/FR-CHECKOUT-035-webhook-signature-alert.spec.ts`

**Interfaces:**
- Consumes: 計画1の E2E の環境（`process.env.MAIL_LOCAL_URL`・`process.env.SHOP_ALERT_EMAIL` は `playwright.config.ts` が手元の値で上書きする。`isLocalUrl` は `scripts/e2e/environment.ts`）、Task 2 の `public.ops_alert_state`、Task 4 の件名「【要確認】署名の合わない Stripe の知らせが届いています」、Task 7 の受け取り口
- Produces: なし

- [ ] **Step 1: 番号を確かめる**

Run: `ls e2e | grep "FR-CHECKOUT-" | sort -V | tail -1`
Expected: `FR-CHECKOUT-034-session-error-keeps-message.spec.ts`。違えば、次の番号に読み替える

- [ ] **Step 2: E2E を書く**

`e2e/FR-CHECKOUT-035-webhook-signature-alert.spec.ts`:

```ts
import { expect, test, type APIRequestContext } from '@playwright/test';
import { Client } from 'pg';
import { isLocalUrl } from '../scripts/e2e/environment';

// FREQ-416: 署名の合わない Stripe の知らせは400で断って数えるだけにし、10分に5件で店へ1通だけ知らせる（R-05）。
// 手元の Supabase の DB と手元のメール受け（Mailpit）だけを使う。1時間に1回の上限があるので、
// 画面幅ごとに知らせの状態を消してから送る。同じ1行を使うので、このファイルのテストは順に流す。
test.describe.configure({ mode: 'serial' });

const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 900 },
];

const LOCAL_DB_URL = process.env.E2E_LOCAL_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const ALERT_SUBJECT = '【要確認】署名の合わない Stripe の知らせが届いています';

/** 手元の DB の「署名不正」の数と送った時刻を消す（表は関数からしか触れないので、DB の管理者で消す） */
async function resetSignatureAlert(): Promise<void> {
  if (!isLocalUrl(LOCAL_DB_URL)) throw new Error('手元の DB 以外では知らせの状態を消さない');
  const client = new Client({ connectionString: LOCAL_DB_URL });
  await client.connect();
  try {
    await client.query("delete from public.ops_alert_state where alert_key = 'webhook_signature_invalid'");
  } finally {
    await client.end();
  }
}

type MailpitMessage = { Subject: string; To: Array<{ Address: string }> };

/** 手元のメール受けに届いた、店への署名不正の知らせの数 */
async function countAlertMails(request: APIRequestContext): Promise<number> {
  const mailUrl = process.env.MAIL_LOCAL_URL;
  const shopAlertEmail = process.env.SHOP_ALERT_EMAIL;
  if (!mailUrl || !isLocalUrl(mailUrl)) throw new Error('手元のメール受け（MAIL_LOCAL_URL）が無い');
  if (!shopAlertEmail) throw new Error('SHOP_ALERT_EMAIL が無い');
  const response = await request.get(new URL('/api/v1/messages?limit=500', mailUrl).toString());
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as { messages: MailpitMessage[] };
  return body.messages.filter((message) =>
    message.Subject === ALERT_SUBJECT
    && message.To.some((to) => to.Address === shopAlertEmail)).length;
}

for (const viewport of viewports) {
  test.describe(`FR-CHECKOUT-035 webhook signature alert (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    test('署名の合わない要求を5回送ると、どれも400が返り、店への知らせが1通だけ届く', async ({ request }) => {
      // FREQ-416-AC-01, FREQ-416-AC-02
      await resetSignatureAlert();
      const before = await countAlertMails(request);

      for (let attempt = 0; attempt < 5; attempt += 1) {
        const response = await request.post('/api/webhook/stripe', {
          headers: { 'stripe-signature': 't=1,v1=00', 'content-type': 'application/json' },
          data: { id: `evt_e2e_bad_signature_${viewport.name}_${attempt}`, type: 'checkout.session.completed' },
        });
        expect(response.status()).toBe(400);
      }

      // 数えて送るのは応答の後（after()）なので、届くまで待つ
      await expect.poll(() => countAlertMails(request), { timeout: 15_000 }).toBe(before + 1);
      // 余分に届かないこと（少し待ってから数え直す）
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      expect(await countAlertMails(request)).toBe(before + 1);
    });
  });
}
```

- [ ] **Step 3: 要件を足す**

`docs/02_Requirements/requirements.md` の `| FREQ-415 |` で始まる行の次の行に、次の1行を足す:

```markdown
| FREQ-416 | Stripe の知らせの受け取り口で、署名の合わない要求を数えるだけにし、多いときだけ店へメールで知らせること（R-05。設計書 2026-10-05 グループ B の 5-2） | FREQ-416-REQ-01<br>FREQ-416-REQ-02 | ・署名の欠落・不一致は400で断り、監査ログ（`audit_logs`）に1件ずつ書かず、外へも送らないこと。件数は `ops_alert_state` の1行で数え、行を増やさないこと<br>・10分に5件以上で店（`SHOP_ALERT_EMAIL`）へメールを1通送ること。同じ知らせは1時間に1回までにすること。送れなかったら次の機会にもう一度試すこと | FREQ-416-AC-01<br>FREQ-416-AC-02 | ・署名の合わない要求を5回送ると、どれも400が返ること<br>・5回目の後、店の宛先に「【要確認】署名の合わない Stripe の知らせが届いています」のメールが1通だけ届くこと |
```

- [ ] **Step 4: 手元の DB に Task 1・2 の移行を当てる**

Run: `npx supabase db reset`
Expected: 最後に `Finished supabase db reset`。移行（`20261005100000_webhook_queue_dead_letter.sql`・`20261005100100_ops_alerting.sql` を含む）と見本データが入る

- [ ] **Step 5: E2E を流す（Task 12 の分も一緒に）**

3000番に何も無いことを確かめる（あれば止める。作り直したコードで流すため）:

Run（PowerShell）: `Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue`
Expected: 何も出ない

Run: `E2E_STRICT=1 npx playwright test e2e/FR-CHECKOUT-035 e2e/FR-ADMIN-064 e2e/FR-CHECKOUT-009 e2e/FR-ADMIN-060`
Expected: すべて通過（FR-CHECKOUT-035 は3件、FR-ADMIN-064 は6件。FR-CHECKOUT-009 は署名ヘッダーの無い要求が今までどおり400になること、FR-ADMIN-060 は要対応・要確認の欄が今までどおり動くことを確かめる）

- [ ] **Step 6: コミットの文を書く**

`.superpowers/sdd/2026-10-05-webhook-queue-operations/task-13-commit-msg.txt`:

```text
test(e2e): 署名の合わない知らせで、400と店への知らせ1通を確かめる

署名の合わない要求を5回送ると、どれも400が返り、手元のメール受けに店への
知らせが1通だけ届くことを、手元の Supabase と本番ビルドで確かめる（FREQ-416）。
1時間に1回の上限があるので、画面幅ごとに手元の DB の知らせの状態を消してから送る。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

---

### Task 14: 開店のときに当てる定期処理の登録（保留中の SQL）

設計書 4-1・4-2・8-3。worker の登録を10秒ごとから毎分にし（R-32）、照合の登録を足す。どちらも `supabase/pending/` に置き、今は当てない（開店のとき、手順書の順番どおり）。実行の記録の掃除は Task 2 の移行に入っている。

**Files:**
- Modify: `supabase/pending/schedule_stripe_webhook_worker.sql`
- Create: `supabase/pending/schedule_stripe_reconcile.sql`
- Modify: `supabase/pending/README.md`
- Create: `tests/unit/migrations/schedule-stripe-cron-jobs.test.ts`
- Modify: `tests/integration/db/stripe_webhook_queue.integration.test.ts`（worker の登録のテスト）
- Create: `tests/integration/db/stripe_reconcile_job.integration.test.ts`

**Interfaces:**
- Consumes: Task 6 の worker の入口（POST、`maxDuration = 60`）、Task 8・9 の照合の入口（POST）
- Produces: pg_cron のジョブ `process-stripe-webhooks`（`* * * * *`）と `stripe-reconcile`（`0 18 * * *`）。どちらも Vault の `app_base_url` と `cron_secret` を実行のときに読み、無ければ送る前に例外で止める

- [ ] **Step 1: 単体テストを書く**

`tests/unit/migrations/schedule-stripe-cron-jobs.test.ts`:

```ts
import fs from 'node:fs';
import path from 'node:path';

/**
 * 開店のときに当てる定期処理の登録（設計書 2026-10-05 グループ B の 4-1・8-3）。
 * 見回りの登録（schedule_expire_pending_orders.sql）と同じ形: マイグレーション本体は止めず、
 * ジョブ本体は Vault の秘密が欠けていれば送る前に止める。
 */
function readPending(file: string): string {
  return fs.readFileSync(path.join(process.cwd(), 'supabase/pending', file), 'utf8');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

describe.each([
  {
    file: 'schedule_stripe_webhook_worker.sql',
    job: 'process-stripe-webhooks',
    schedule: '* * * * *',
    endpoint: '/api/cron/process-stripe-webhooks',
  },
  {
    file: 'schedule_stripe_reconcile.sql',
    job: 'stripe-reconcile',
    schedule: '0 18 * * *',
    endpoint: '/api/cron/stripe-reconcile',
  },
])('$file', ({ file, job, schedule, endpoint }) => {
  const sql = readPending(file);
  const beforeSchedule = sql.slice(0, sql.search(/cron\.schedule\(/i));
  const jobBody = sql.match(/cron\.schedule\([\s\S]*?\$\$([\s\S]*?)\$\$\s*\)/i)?.[1] ?? '';

  it(`${job} を ${schedule} で登録する`, () => {
    expect(sql).toMatch(new RegExp(`cron\\.schedule\\(\\s*'${escapeRegExp(job)}'\\s*,\\s*'${escapeRegExp(schedule)}'`, 'i'));
  });

  it('pg_net を用意し、秘密が無くてもマイグレーション本体は止めずに警告する', () => {
    expect(sql).toMatch(/create extension if not exists pg_net/i);
    expect(beforeSchedule).not.toMatch(/raise\s+exception/i);
    expect(beforeSchedule).toMatch(/raise\s+warning/i);
  });

  it('秘密は実行のときに Vault から読み、欠けていれば送る前に止める', () => {
    expect(jobBody).toMatch(/vault\.decrypted_secrets/i);
    expect(jobBody).toMatch(/name = 'app_base_url'/);
    expect(jobBody).toMatch(/name = 'cron_secret'/);
    const raiseIndex = jobBody.search(/raise\s+exception/i);
    const postIndex = jobBody.search(/net\.http_post/i);
    expect(raiseIndex).toBeGreaterThan(-1);
    expect(raiseIndex).toBeLessThan(postIndex);
  });

  it('入口へ Bearer の合言葉を付けて POST し、60秒まで待つ', () => {
    expect(jobBody).toContain(endpoint);
    expect(jobBody).toMatch(/'Authorization',\s*'Bearer '\s*\|\|\s*v_cron_secret/);
    expect(jobBody).toMatch(/timeout_milliseconds\s*:=\s*60000/);
  });
});

describe('worker の登録（R-32）', () => {
  it('10秒ごとの登録を残さない', () => {
    expect(readPending('schedule_stripe_webhook_worker.sql')).not.toMatch(/'10 seconds'/);
  });
});
```

- [ ] **Step 2: 結合テストを直し、足す**

`tests/integration/db/stripe_webhook_queue.integration.test.ts` の `test('Vaultを参照する10秒間隔のworkerジョブを登録できる', async () => {` を `test('Vaultを参照する毎分のworkerジョブを登録できる', async () => {` に、その中の `expect(result.rows[0].schedule).toBe('10 seconds');` を `expect(result.rows[0].schedule).toBe('* * * * *');` に変える。

`tests/integration/db/stripe_reconcile_job.integration.test.ts`:

```ts
/** @jest-environment node */
export {};

const { Client } = require('pg');
const fs = require('node:fs');
const path = require('node:path');

/**
 * 照合の定期処理の登録（設計書 2026-10-05 グループ B の 4-1・8-3）。
 * Vault に秘密が無くても登録は通ること、揃っていれば照合の入口へ POST を1件積むことを、
 * 実際の DB で確かめる。すべてロールバックするので、HTTP の要求は送られない（pg_net はコミットされた行だけを送る）。
 *
 * 実行方法（ローカル Supabase を起動しておく: npm run db:start）:
 *   DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
 *     npx jest tests/integration/db/stripe_reconcile_job
 */

const DATABASE_URL = process.env.DATABASE_URL;

const MIGRATION_SQL = fs.readFileSync(
  path.join(process.cwd(), 'supabase/pending/schedule_stripe_reconcile.sql'),
  'utf8',
);

function isLocalDatabase(url: string): boolean {
  try {
    return ['localhost', '127.0.0.1', '::1'].includes(new URL(url).hostname);
  } catch {
    return false;
  }
}

describe('integration: stripe-reconcile の登録', () => {
  if (!DATABASE_URL) {
    test.skip('DATABASE_URL 未設定のためスキップ', () => {});
    return;
  }

  if (!isLocalDatabase(DATABASE_URL)) {
    test('使い捨ての DB 以外では実行しない', () => {
      throw new Error('Vault の秘密を消すため、localhost 以外の DATABASE_URL では実行しない');
    });
    return;
  }

  let client: any;

  beforeAll(async () => {
    client = new Client({ connectionString: DATABASE_URL });
    await client.connect();
  });

  afterAll(async () => {
    if (client) await client.end();
  });

  beforeEach(async () => {
    await client.query('begin');
  });

  afterEach(async () => {
    // 送信も登録も残さない
    await client.query('rollback');
  });

  async function dropVaultSecrets() {
    await client.query("delete from vault.secrets where name in ('cron_secret', 'app_base_url')");
  }

  test('Vault の秘密が無くても登録は通り、毎日 18:00 UTC のジョブができる', async () => {
    await dropVaultSecrets();

    await client.query(MIGRATION_SQL);

    const job = await client.query(
      "select schedule, active, command from cron.job where jobname = 'stripe-reconcile'",
    );
    expect(job.rowCount).toBe(1);
    expect(job.rows[0].schedule).toBe('0 18 * * *');
    expect(job.rows[0].active).toBe(true);
    expect(job.rows[0].command).toContain('/api/cron/stripe-reconcile');
  }, 60000);

  test('秘密が揃っていれば、照合の入口へ Authorization 付きの POST を1件積む', async () => {
    await dropVaultSecrets();
    await client.query("select vault.create_secret('test-cron-secret-0123456789abcdef', 'cron_secret')");
    await client.query("select vault.create_secret('http://localhost:3000/', 'app_base_url')");
    await client.query(MIGRATION_SQL);
    const command = (await client.query(
      "select command from cron.job where jobname = 'stripe-reconcile'",
    )).rows[0].command;

    const before = (await client.query('select count(*)::int as count from net.http_request_queue')).rows[0].count;
    await client.query(command);

    const after = (await client.query('select count(*)::int as count from net.http_request_queue')).rows[0].count;
    expect(after).toBe(before + 1);
    const queued = await client.query(
      'select method, url, headers from net.http_request_queue order by id desc limit 1',
    );
    expect(queued.rows[0].method).toBe('POST');
    // 住所の最後の「/」は落とす
    expect(queued.rows[0].url).toBe('http://localhost:3000/api/cron/stripe-reconcile');
    expect(queued.rows[0].headers.Authorization).toBe('Bearer test-cron-secret-0123456789abcdef');
  }, 60000);
});
```

- [ ] **Step 3: テストが落ちることを確かめる**

Run: `npx jest tests/unit/migrations/schedule-stripe-cron-jobs.test.ts`
Expected: FAIL（`schedule_stripe_reconcile.sql` が無い。worker が10秒ごと）

- [ ] **Step 4: 登録の SQL を直し、足す**

`supabase/pending/schedule_stripe_webhook_worker.sql` の先頭の3行（`-- 署名検証済みイベントを…` から `-- app_base_url と cron_secret は…` まで）を次に置き換える:

```sql
-- 署名検証済みイベントをDBへ保存した後に処理するworkerを毎分起動する（設計書 2026-10-05 グループ B の 4-1。R-32）。
-- 受け取り口は保存の後にその場で1回 worker を動かす（after()）ので、毎分の起動は取りこぼしを拾う役目。
-- 10秒ごとだと実行の記録（cron.job_run_details）が1日8,640行溜まるので、毎分（1,440行）にした。
-- 本番適用は開店のとき、手順書（docs/06_Operations/webhook-queue-operations.md）の順番どおり、明示承認後。
-- app_base_url と cron_secret は既存のVault secretを再利用し、値をジョブに埋め込まない。
```

同じファイルの `'10 seconds',` を `'* * * * *',` に変える。

`supabase/pending/schedule_stripe_reconcile.sql`:

```sql
-- Stripe との照合（入金・返金・会計・Stripe からの入金）を毎日 18:00 UTC（日本時間 3:00）に呼ぶ
-- （設計書 2026-10-05 グループ B の 4-1）。照合の入口は POST（pg_net は POST で呼ぶ）。
--
-- 【保留中】本番の公開時に入れる。supabase/migrations/ に置くと CI の db push が本番へ流すので、
-- ここ（supabase/pending/）に置いている。入れる手順は supabase/pending/README.md と
-- docs/06_Operations/webhook-queue-operations.md。
--
-- CRON_SECRET と本番URL は Vault に置き、ジョブの実行時に復号して使う（worker・見回りと同じ）。

create extension if not exists pg_net with schema extensions;

-- 秘密が無い環境（ローカル・CI・プレビュー）でも、マイグレーションはここで止めない。
-- 足りないことは警告で知らせるだけにして、実際の保護はジョブ本体で行う。
do $$
begin
  if not exists (select 1 from vault.decrypted_secrets where name = 'cron_secret')
     or not exists (select 1 from vault.decrypted_secrets where name = 'app_base_url') then
    raise warning 'vault secrets (cron_secret / app_base_url) are missing; stripe-reconcile will fail on every run until they are set';
  end if;
end $$;

-- 秘密が欠けたまま送ると、認証ヘッダの無い要求が毎回 401 になる。送る前に例外で止め、
-- cron.job_run_details に status=failed と理由を残す。文言には秘密の名前だけを書き、値は出さない。
select cron.schedule(
  'stripe-reconcile',
  '0 18 * * *',
  $$
    do $job$
    declare
      v_base_url text;
      v_cron_secret text;
    begin
      select decrypted_secret into v_base_url
      from vault.decrypted_secrets
      where name = 'app_base_url';

      select decrypted_secret into v_cron_secret
      from vault.decrypted_secrets
      where name = 'cron_secret';

      if v_base_url is null or v_cron_secret is null then
        raise exception 'stripe-reconcile: vault secrets (app_base_url / cron_secret) are missing';
      end if;

      perform net.http_post(
        url := pg_catalog.rtrim(v_base_url, '/') || '/api/cron/stripe-reconcile',
        headers := pg_catalog.jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || v_cron_secret
        ),
        -- 照合は Stripe の一覧を順に読むので時間がかかる。pg_net の既定（2秒）では応答を待てない
        timeout_milliseconds := 60000
      );
    end
    $job$;
  $$
);
```

`supabase/pending/README.md` を次のように直す:

1. 表の `| \`schedule_stripe_webhook_worker.sql\` |` の行を、次の2行に置き換える:

```markdown
| `schedule_stripe_webhook_worker.sql` | Vaultを使いworkerを毎分起動するpg_cronジョブ（受け取り口が保存の後にその場で1回動かすので、毎分の起動は取りこぼしを拾う役目。R-32 で10秒ごとから変更） | 開店のとき。[手順書](../../docs/06_Operations/webhook-queue-operations.md)の順番どおり、Stripe の知らせの宛先を登録する前に当てる |
| `schedule_stripe_reconcile.sql` | 照合（毎日 18:00 UTC＝日本時間 3:00 に `/api/cron/stripe-reconcile` を POST で呼ぶ pg_cron）。入金・返金・会計・Stripe からの入金を照合する | 開店のとき。手順書の順番どおり |
```

2. 最後の段落の `失敗・滞留は` で始まる文を、次に置き換える:

```markdown
失敗・滞留は`stripe_webhook_events`の`processing_status`（`dead`は9回目の試行も失敗して退避したもの）、`attempt_count`、`next_attempt_at`、`received_at`、`last_error`（原因の記号）と、`ops_job_heartbeats`（定期処理ごとの最後の成功）、`cron.job_run_details`、`net._http_response`を確認する。調べ方は[手順書](../../docs/06_Operations/webhook-queue-operations.md)。
```

- [ ] **Step 5: テストが通ることを確かめる**

Run: `npx jest tests/unit/migrations/schedule-stripe-cron-jobs.test.ts tests/unit/migrations/schedule-expire-pending-orders.test.ts`
Expected: PASS（新しいファイルは9件）

Run: `npx supabase db reset` の後に `DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres npx jest tests/integration/db --runInBand`
Expected: PASS（`stripe_reconcile_job` の2件と、worker の登録のテストを含む）

- [ ] **Step 6: コミットの文を書く**

`.superpowers/sdd/2026-10-05-webhook-queue-operations/task-14-commit-msg.txt`:

```text
chore(db): 開店のときに当てる worker を毎分にし、照合の登録を足す

保留中の worker の登録を10秒ごとから毎分にした（R-32。受け取り口がその場で
1回動かすので、毎分の起動は取りこぼしを拾う役目）。照合を毎日 18:00 UTC に
POST で呼ぶ登録を足した。どちらも Vault の秘密を実行のときに読み、無ければ
送る前に止める。開店のときに手順書の順番どおり当てる。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

---

### Task 15: 手順書と文書

設計書 10-3。開店のときの順番、合言葉の入れ替え、Stripe の購読、知らせが届いたときの調べ方を手順書にする。今の動きを書いた文書（API の一覧、決済の詳細設計、秘密の扱い、`.env.example`、レビュー台帳）を新しい動きに合わせる。

**Files:**
- Create: `docs/06_Operations/webhook-queue-operations.md`
- Modify: `docs/06_Operations/README.md`、`docs/06_Operations/secrets.md`、`.env.example`
- Modify: `docs/03_BasicDesign/api/api-spec.md`、`docs/04_DetailDesign/pages/13_checkout.md`
- Modify: `docs/05_Quality/reviews/code/2026-09-25-working-diff-security-review.md`（対処計画の B の行）

**Interfaces:**
- Consumes: Task 1〜14 の名前と値（件名・原因の記号・定期処理の名前と時刻・入口・表と列）
- Produces: なし（文書だけ）

- [ ] **Step 1: 手順書を書く**

`docs/06_Operations/webhook-queue-operations.md`:

````markdown
# Stripe の知らせのキューと定期処理の手順書

> 対象: Stripe の知らせ（Webhook）の受け取り口・キュー・worker、毎時の見回り、毎晩の照合、店への知らせ
> 設計: [グループ B 設計書](../superpowers/specs/2026-10-05-webhook-queue-operations-design.md)、保留中の SQL: [supabase/pending/README.md](../../supabase/pending/README.md)

---

## 概要

開店のときに定期処理を登録する順番、合言葉の入れ替え、Stripe の購読の設定、店へ知らせのメールが届いたときの調べ方をまとめる。値（合言葉・鍵）はこの文書にもチャットにもコミットにも残さない。

| 場面 | 見る節 |
|---|---|
| 開店のとき | 1 |
| `CRON_SECRET` を入れ替える | 2 |
| Stripe の署名の合言葉を入れ替える | 3 |
| Stripe の知らせの購読を設定する | 4 |
| 店へ知らせのメールが届いた | 5 |
| 状態を確かめる | 6 |

| 定期処理 | 時刻（日本時間・UTC） | 入口 |
|---|---|---|
| worker | 毎分 | POST `/api/cron/process-stripe-webhooks` |
| 見回り | 毎時0分 | POST `/api/cron/expire-pending-orders` |
| 照合 | 毎日 3:00（18:00 UTC） | POST `/api/cron/stripe-reconcile` |
| 実行の記録の掃除 | 毎日 4:00（19:00 UTC） | DB の中だけ（7日を残す） |

---

## 1. 開店のときの順番

```mermaid
flowchart TD
    A["1 Vercel に公開し、環境変数を入れる"] --> B["2 本番 DB で pg_net を有効にし、Vault に合言葉と住所を入れる"]
    B --> C["3 保留中の SQL を当て、定期処理を登録する"]
    C --> D["4 定期処理が成功しているのを確かめる"]
    D --> E["5 Stripe の知らせの宛先を登録する（13種）"]
    E --> F["6 最初の知らせが処理されたのを確かめる"]
    F --> G["7 普段の開発を手元の DB に切り替える"]
```

| 順 | やること | 誰が | 確かめ方 |
|---|---|---|---|
| 1 | Vercel に公開し、環境変数を入れる。`CRON_SECRET` は32文字以上のランダムな値（例: `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`）。`SHOP_ALERT_EMAIL`・`MAIL_FROM_ADDRESS`・`STRIPE_SECRET_KEY`（本番の鍵）も入れる | ユーザー | 公開した URL で画面が開く |
| 2 | 本番 DB で `create extension if not exists pg_net with schema extensions;` を流し、Vault に `cron_secret`（Vercel の `CRON_SECRET` と同じ値）と `app_base_url`（公開した URL）を入れる | 合言葉はユーザー、それ以外は Claude（許可を得て） | `select name from vault.decrypted_secrets where name in ('cron_secret', 'app_base_url');` が2行 |
| 3 | `supabase/pending/` の `schedule_stripe_webhook_worker.sql`・`schedule_expire_pending_orders.sql`・`schedule_stripe_reconcile.sql` を、新しい version の移行にして当てる（[README](../../supabase/pending/README.md)） | Claude（許可を得て） | `select jobname, schedule, active from cron.job order by jobname;` に4つ（掃除を含む）が `active` |
| 4 | 定期処理が成功しているのを確かめる | Claude | 6 の SQL。worker は数分後、見回りは次の毎時0分の後、照合は次の 18:00 UTC の後、掃除は次の 19:00 UTC の後。`ops_job_heartbeats` に成功の時刻が入る |
| 5 | Stripe の管理画面で知らせの宛先（`<公開した URL>/api/webhook/stripe`）を作り、4 の13種を購読し、署名の合言葉を Vercel の `STRIPE_WEBHOOK_SECRET` に入れて出し直す | ユーザー | Stripe の管理画面で宛先が有効 |
| 6 | 最初の知らせ（テストの決済など）が処理されたのを確かめる | Claude | `stripe_webhook_events` の新しい行が `completed` |
| 7 | 普段の開発を手元の DB に切り替える（設計書 第7章） | Claude とユーザー | `npm run dev` の画面が手元の見本データを出す |

- 3・4 を 5 より先にする。worker が動いているのを確かめてから、受け取り口を開ける（R-07）。
- 一度も成功していない定期処理は、遅れの知らせの対象にならない。4 の確かめを省かない。

## 2. `CRON_SECRET` の入れ替え

入れ替えの間の数分は、定期処理が401で断られる。見回り（毎時0分）の直後に行う。

1. 新しい値を作る（32文字以上。短いと全部の入口が断る）。
2. Vercel の `CRON_SECRET` を更新し、出し直す。
3. 本番 DB の Vault を更新する: `select vault.update_secret((select id from vault.secrets where name = 'cron_secret'), '<新しい値>');`（値はその場で入れ、どこにも残さない）
4. 次の worker の実行（1分以内）の応答が200になるのを、6 の `net._http_response` で確かめる。

## 3. Stripe の署名の合言葉の入れ替え

1. Stripe の管理画面で、宛先の署名の合言葉を入れ替える（古い合言葉も最大24時間は通る）。
2. その間に Vercel の `STRIPE_WEBHOOK_SECRET` を新しい値にして出し直す。
3. 署名不正の知らせ（5）が来ないこと、`stripe_webhook_events` に新しい行が `completed` で入ることを確かめる。

## 4. Stripe の知らせの購読（13種）

受け取り口は次の13種だけを保存する（`src/lib/stripe/handled-webhook-events.ts`）。ほかの種類は保存せずに200を返す。Stripe の宛先も同じ13種を購読する。

`checkout.session.completed`・`checkout.session.async_payment_succeeded`・`checkout.session.async_payment_failed`・`checkout.session.expired`・`payment_intent.succeeded`・`payment_intent.payment_failed`・`refund.created`・`refund.updated`・`refund.failed`・`charge.refunded`・`payout.paid`・`payout.failed`・`payout.reconciliation_completed`

本番の鍵（`sk_live_`・`rk_live_`）のアプリには本番の宛先、テストの鍵（`sk_test_`・`rk_test_`）のアプリにはテストの宛先をつなぐ。食い違うと「モード違い」の知らせが届き、その知らせは処理されない。

## 5. 店へ知らせのメールが届いたとき

宛先は `SHOP_ALERT_EMAIL`。同じ種類は1時間に1回まで（支払いから作った注文は見回り1回につき1通）。

| 件名 | 何が起きたか | やること |
|---|---|---|
| 【要対応】処理を止めた Stripe の知らせ（N件） | 9回試しても処理できず、退避した（これ以上やり直さない） | メールの原因の記号（下の表）を見る。注文の状態は毎時の見回りが、返金と会計は毎晩の照合が Stripe に合わせるので、知らせのやり直しは要らない。同じ原因が続くときは開発者へ |
| 【要確認】Stripe の知らせの処理が遅れています | 受け取ってから15分以上たって完了していない知らせがある | 6 の SQL で worker の実行の記録と応答、`ops_job_heartbeats` の `webhook_worker` を見る。401 なら合言葉（2）、404・5xx ならアプリの公開を確かめる |
| 【要確認】定期処理が止まっています（毎時の見回り） | 見回りが2時間以上成功していない | 6 の SQL で `expire-pending-orders` の実行の記録と応答を見る |
| 【要確認】定期処理が止まっています（毎晩の照合） | 照合が25時間以上成功していない | 6 の SQL で `stripe-reconcile` の実行の記録と応答、`ops_job_heartbeats` の `last_error_code` を見る |
| 【要確認】署名の合わない Stripe の知らせが届いています | 10分に5件以上、署名の合わない要求を断った | Vercel の `STRIPE_WEBHOOK_SECRET` と Stripe の宛先の合言葉が同じかを確かめる（入れ替えの途中なら 3）。同じなら外からの偽の知らせを断っているだけで、対応は要らない |
| 【要対応】Stripe の本番とテストの知らせが混ざっています | 鍵と違うモードの知らせが届いた（処理していない） | メールの「届いた知らせ」と「このアプリの鍵」を見て、Stripe の宛先と `STRIPE_SECRET_KEY`・`STRIPE_WEBHOOK_SECRET` の組み合わせを直す（4） |
| 【要確認】支払いから作った注文（N件） | Stripe に支払いがあったのに注文が無く、見回りが注文を作った | 管理画面の ORDER タブの「要対応・要確認」で注文を確かめ、お客様へ注文の内容を確認する。確認したら「確認済みにする」。メールが届かなかった回も、管理画面には出る |

| 原因の記号 | 意味 |
|---|---|
| `stripe_unavailable` | Stripe の通信の失敗・5xx・回数制限 |
| `db_unavailable` | DB の接続・タイムアウト・デッドロック |
| `not_converged` | 書いた後の読み直しが3回で収まらない |
| `lease_expired` | 処理の途中で担当の期限（5分）が切れた |
| `invalid_payload` | 保存した知らせの中身が壊れている |
| `unexpected_error` | 上のどれにも当たらない（開発者へ） |

アプリや DB ごと止まったときは、知らせのメールは出ない（外からの見張りは入れていない）。

## 6. 状態を確かめる（本番は読むだけ）

```sql
-- 定期処理の登録
select jobid, jobname, schedule, active from cron.job order by jobname;

-- 直近の実行の記録（7日を残して毎日消える）
select j.jobname, d.status, d.return_message, d.start_time
from cron.job_run_details d join cron.job j using (jobid)
order by d.start_time desc limit 20;

-- アプリの応答（pg_net。既定で6時間残る）
select id, status_code, timed_out, error_msg, created
from net._http_response order by created desc limit 20;

-- 定期処理ごとの最後の成功・失敗
select job, last_succeeded_at, last_failed_at, last_error_code
from public.ops_job_heartbeats order by job;

-- キューの状態ごとの件数と、いちばん古い受け取り
select processing_status, count(*), min(received_at) as oldest_received_at
from public.stripe_webhook_events group by processing_status order by processing_status;

-- 退避した知らせ
select event_id, event_type, last_error, attempt_count, received_at, dead_at, dead_notified_at
from public.stripe_webhook_events where processing_status = 'dead'
order by dead_at desc limit 50;
```
````

- [ ] **Step 2: 運用文書の入口と秘密の扱いを直す**

`docs/06_Operations/README.md` の表で、`secrets.md` の行の次の行に足す:

```markdown
| `docs/06_Operations/webhook-queue-operations.md` | Stripe の知らせのキューと定期処理（開店のときの順番・合言葉の入れ替え・知らせが届いたときの調べ方） | 本番は読むだけの SQL で確かめる |
```

`docs/06_Operations/secrets.md` を次のように直す:

1. `` `STRIPE_WEBHOOK_SECRET` としてサーバー環境だけに保存します。`src/lib/stripe/webhook-processor.ts` が処理する次の全イベントを購読します。 `` の文を、次に置き換える:

```markdown
`STRIPE_WEBHOOK_SECRET` としてサーバー環境だけに保存します。受け取り口が保存する次の13種（`src/lib/stripe/handled-webhook-events.ts`）を購読します。ほかの種類は保存しません。本番の鍵のアプリには本番の宛先、テストの鍵のアプリにはテストの宛先をつなぎます（食い違うと処理せず、店へ知らせます）。
```

2. 「定期照合は」で始まる段落（3行。最後は「修復します。」）を、次に置き換える:

```markdown
定期照合は毎日 18:00 UTC（日本時間 3:00）に pg_cron＋pg_net が `POST /api/cron/stripe-reconcile` を呼び出し、`Authorization: Bearer
${CRON_SECRET}` を付与します。Stripeだけに存在する未返金の成功決済は報告対象になり、照合では注文を作りません
（注文の無い支払いは毎時の見回りが拾います）。既存注文との返金額差分だけをStripeの成功済み返金から修復します。

## CRON_SECRET

定期処理の入口（worker・見回り・照合・Meta の同期）の合言葉です。32文字以上のランダムな値にします。短いと全部の入口が設定の誤りとして断ります。Vercel の環境変数と、本番 DB の Vault（`cron_secret`）にだけ置きます。入れ替えは[手順書](webhook-queue-operations.md)の2に従います。
```

`.env.example` の `# Used by POST /api/cron/meta-kpi-sync` の行を、次に置き換える:

```bash
# 定期処理の入口（worker・見回り・照合・Meta の同期）の合言葉。32文字以上のランダムな値（短いと全部断る）
```

- [ ] **Step 3: API の一覧と決済の詳細設計を直す**

`docs/03_BasicDesign/api/api-spec.md` を次のように直す:

1. 53行目の `[authorizeCronBearer](../../../src/lib/legal-archive/cron-auth.ts)を使う3ルートはhashを定時間比較、expire-pending-ordersは長さ確認と直接定時間比較、meta-kpi-sync/stripe-reconcileは文字列一致。` を、次に置き換える:

```markdown
どのルートも合言葉をSHA-256にしてから定時間比較する（[auth.ts](../../../src/lib/cron/auth.ts)）。CRON_SECRETのルートは、32文字未満の設定を設定ミスとして401にする。
```

2. `` | `POST /api/cron/expire-pending-orders` | `` で始まる行を、次に置き換える:

```markdown
| `POST /api/cron/expire-pending-orders` | CRON_SECRET Bearer J（hash定時間比較・32文字以上） | 本文なし | 200 `{processed,candidateCount,batchOffset,expiredSessions,actions,needsReview,needsAction,failed,shopAlertsSent,capped,timeBudgetExhausted,checkedSessions,recoveredOrders,recoveredOrdersNotified}` | 401 認証/設定欠落; 500 注文候補取得 | 期限切れsession処理、Stripe照合、注文遷移/要確認/要対応記録、未送信店舗alert再送、直近24時間の注文の無い支払いの拾い上げ（要確認`recovered_from_payment`・店へ1通）、最後の成功の記録と点検。個別失敗はsummaryへ [実装](../../../src/app/api/cron/expire-pending-orders/route.ts) |
```

3. `` | `POST /api/cron/meta-kpi-sync` | CRON_SECRET Bearer J（文字列一致） | `` を `` | `POST /api/cron/meta-kpi-sync` | CRON_SECRET Bearer J（hash定時間比較・32文字以上） | `` に変える。

4. `` | `POST /api/cron/process-stripe-webhooks` | `` で始まる行を、次に置き換える:

```markdown
| `POST /api/cron/process-stripe-webhooks` | CRON_SECRET Bearer J（hash定時間比較・32文字以上） | 本文なし | 200 `{processed,failed,stoppedBy}` | 401 認証/設定欠落; 502 claimのDB障害 | queueから取り出せる知らせが無くなるか約45秒たつまで処理。失敗は原因の記号で記録し、2^(n-1)分後に再試行、9回目の失敗で退避（`dead`）。最後の成功の記録と点検（溜まり・退避・遅れを店へ） [実装](../../../src/app/api/cron/process-stripe-webhooks/route.ts) |
```

5. `` | `GET /api/cron/stripe-reconcile` | `` で始まる行を、次に置き換える:

```markdown
| `POST /api/cron/stripe-reconcile` | CRON_SECRET Bearer J（hash定時間比較・32文字以上） | 本文なし | 200 `{data:{matchedOrders,unmatchedPayments,syncedBalanceTransactions,syncedRefunds,syncedPayouts,payoutMismatches,errors}}`（`errors[].reason` は原因の記号） | 401 認証/設定欠落; 502 Reconciliation failed | Stripe注文/返金/Payout照合と会計同期。支払いごとに失敗を受け止め、監査`stripe.reconcile`と最後の成功を記録 [実装](../../../src/app/api/cron/stripe-reconcile/route.ts) |
```

6. `` | `POST /api/webhook/stripe` | `` で始まる行を、次に置き換える:

```markdown
| `POST /api/webhook/stripe` | Stripe署名 W | raw body bytes + `stripe-signature` | 200 `{received:true,duplicate:boolean}`、13種以外とモード違いは200 `{received:true,ignored:true}` | 400 header/署名（監査には書かず件数だけ数え、10分に5件で店へ）; 500 設定/queue保存 | 13種だけを永続queueへenqueueし、応答の後に`after()`でworkerを1回動かす。鍵と違うモードの知らせは保存せず店へ知らせる [実装](../../../src/app/api/webhook/stripe/route.ts) |
```

`docs/04_DetailDesign/pages/13_checkout.md` を次のように直す:

1. `  F --> G[pg_cron: 10秒ごとにworker起動]` を `  F --> G[pg_cron: 毎分worker起動・受け取り口もその場で1回]` に変える。
2. `worker（[route.ts](../../../src/app/api/cron/process-stripe-webhooks/route.ts)）は` で始まる段落を、次に置き換える:

```markdown
worker（[route.ts](../../../src/app/api/cron/process-stripe-webhooks/route.ts)）は`CRON_SECRET`で認証し、取り出せる知らせが無くなるか約45秒たつまで1件ずつ処理する（受け取り口も保存の後に`after()`で1回動かす）。DBのclaimは`FOR UPDATE SKIP LOCKED`、5分lease、claim tokenを使う。処理に失敗したイベントは原因の記号（`stripe_unavailable`など6つ）を残し、失敗した試行の回数をnとして2^(n-1)分後に再試行する。9回目の試行も失敗したら`dead`（退避）にして店へまとめて知らせる。leaseの切れた試行も1回の失敗として数える（`lease_expired`）。古いworkerは完了を確定できない。注文確定とメール送信は既存の冪等処理を維持する（グループ B 設計書 3-1〜3-4）。
```

3. `` `stripe_webhook_events`には`queued / processing / completed / failed`、 `` で始まる段落の最初の文を、次に置き換える:

```markdown
`stripe_webhook_events`には`queued / processing / completed / failed / dead`、`attempt_count`、`next_attempt_at`、`claim_token`、`lease_expires_at`、`received_at`（受け取った時刻）、`dead_at`、`dead_notified_at`を保持する。
```

- [ ] **Step 4: レビュー台帳の B の行を直す**

`docs/05_Quality/reviews/code/2026-09-25-working-diff-security-review.md` の対処計画の表の `| 3 | B キューと worker の運用基盤 |` で始まる行の最後の列（`設計書を作成・ユーザーの確認待ち（…）`）を、次に置き換える:

```markdown
実装済み・push 待ち（[設計書](../../../superpowers/specs/2026-10-05-webhook-queue-operations-design.md)、[実装計画1（E2E）](../../../superpowers/plans/2026-10-05-e2e-local-supabase.md)、[実装計画2](../../../superpowers/plans/2026-10-05-webhook-queue-operations.md)。DB の変更は push の後に本番へ当てる。定期処理の登録は開店のとき（[手順書](../../../06_Operations/webhook-queue-operations.md)）） |
```

- [ ] **Step 5: 文書の書き方を確かめる**

Run: `npx markdownlint-cli2 docs/06_Operations/webhook-queue-operations.md 2>&1 | tail -5`（入っていなければ飛ばす）
Expected: エラー0、または「command not found」

Run: `grep -n "10秒\|10 seconds\|GET /api/cron/stripe-reconcile" docs/03_BasicDesign/api/api-spec.md docs/04_DetailDesign/pages/13_checkout.md docs/06_Operations/secrets.md supabase/pending/README.md`
Expected: 何も出ない

- [ ] **Step 6: コミットの文を書く**

`.superpowers/sdd/2026-10-05-webhook-queue-operations/task-15-commit-msg.txt`:

```text
docs(ops): Stripe の知らせのキューと定期処理の手順書を足し、文書を今の動きに合わせる

開店のときの順番、CRON_SECRET と署名の合言葉の入れ替え、Stripe の13種の購読、
店へ知らせのメールが届いたときの調べ方を手順書にした。API の一覧・決済の詳細設計・
秘密の扱い・.env.example を、毎分の worker・退避・照合の POST・32文字以上の合言葉に
合わせ、レビュー台帳の B を実装済みにした。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

---

### Task 16: 最後の確かめと、本番の DB への適用

設計書 9-3・10-1。全部のテストを通し、E2E を計画1の比べ方で判断する。その後、ユーザーの push を待ち、許可を得て Task 1・2 の移行を Supabase MCP で本番の DB に当てる（CI は鍵の権限の問題で止まっている）。`supabase/pending/` は当てない。

**Files:**
- なし（確かめと、本番の DB への適用だけ。移行のファイル名を本番の台帳の version に合わせるときだけ `supabase/migrations/` の2つの名前を変える）

**Interfaces:**
- Consumes: Task 1〜15 のすべて
- Produces: 本番の DB に `stripe_webhook_events` の新しい列と状態、`ops_job_heartbeats`・`ops_alert_state`、関数、`review_reason` の新しい値、実行の記録の掃除の定期処理

- [ ] **Step 1: 型・lint・単体テスト**

Run: `npm run typecheck && npm run lint && npx jest tests/unit`
Expected: エラー0、単体テストはすべて PASS

- [ ] **Step 2: DB の結合テスト**

```bash
npx supabase db reset
eval "$(npx supabase status -o env | grep -E '^(API_URL|SERVICE_ROLE_KEY)=')"
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
LOCAL_SUPABASE_URL="$API_URL" LOCAL_SUPABASE_SERVICE_ROLE_KEY="$SERVICE_ROLE_KEY" \
  npx jest tests/integration/db --runInBand
```

Expected: 全件 PASS（スキップ無し）

- [ ] **Step 3: E2E の全件（手元の Supabase・本番ビルド）**

3000番に何も無いことを確かめてから（PowerShell: `Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue` が何も出さない）:

Run: `E2E_STRICT=1 npx playwright test`
Expected: 終わる（失敗があってもよい）。`test-results/e2e-results.json` ができる

Run: `npm run e2e:compare`
Expected: 「前に通っていて後で通らない」が0件。0件でなければ、計画1の Task 7 の Step 5 の決まり（見本データかコードを直して通す。直せないものは理由を報告に書く）で直してから、もう一度流す

- [ ] **Step 4: 本番の DB の行が増えていないこと（読むだけ）**

Step 3 の E2E の前と後に、Supabase MCP の `execute_sql`（本番、読むだけ）で次を流す（計画1の Task 7 と同じ SQL）:

```sql
select 'carts' as t, count(*) as n from public.carts
union all select 'checkout_drafts', count(*) from public.checkout_drafts
union all select 'contact_inquiries', count(*) from public.contact_inquiries
union all select 'contact_messages', count(*) from public.contact_messages
union all select 'wishlist', count(*) from public.wishlist
union all select 'orders', count(*) from public.orders
union all select 'audit_logs', count(*) from public.audit_logs
union all select 'stripe_webhook_events', count(*) from public.stripe_webhook_events;
```

Expected: どの表も E2E の前から増えていない（保持期間の掃除で減るのはよい）

- [ ] **Step 5: ユーザーに push を頼む**

push はユーザーが行う（pre-push の検査も手元の Supabase で流れる）。push が済んだと聞くまで次へ進まない。

- [ ] **Step 6: 本番の DB に移行を当てる（許可を得て、1本ずつ）**

ユーザーに「`20261005100000_webhook_queue_dead_letter.sql` と `20261005100100_ops_alerting.sql` を本番の DB に当ててよいか」を聞き、許可を得てから、Supabase MCP の `apply_migration` で1本ずつ当てる（name は `webhook_queue_dead_letter`・`ops_alerting`、query はファイルの中身そのまま）。当てた後に `list_migrations` で本番の台帳の version を読み、`supabase/migrations/` のファイル名の version と違えば、ファイル名を本番の version に合わせる（[docs/06_Operations/db-migrations.md](../../06_Operations/db-migrations.md)）。

確かめ（本番、読むだけ）:

```sql
select column_name from information_schema.columns
where table_schema = 'public' and table_name = 'stripe_webhook_events'
  and column_name in ('received_at', 'dead_at', 'dead_notified_at');
select to_regclass('public.ops_job_heartbeats') is not null as heartbeats,
       to_regclass('public.ops_alert_state') is not null as alert_state;
select jobname, schedule from cron.job where jobname = 'cron-job-run-details-retention';
select pg_get_constraintdef(oid) from pg_constraint where conname = 'orders_review_reason_check';
```

Expected: 3列、両方 true、`0 19 * * *` の1行、`recovered_from_payment` を含む制約

Supabase MCP の `get_advisors`（security）で、新しい表と関数に関する指摘が無いことを確かめる。

- [ ] **Step 7: 名前を合わせたらコミットする**

ファイル名を変えたときだけ:

```bash
git add -A supabase/migrations
git commit -m "$(cat <<'EOF'
chore(db): グループ B の移行のファイル名を本番の台帳の version に合わせる

Supabase MCP で本番に当てた2本の移行（キューの退避・知らせと記録）の
ファイル名を、本番の台帳に記録された version に合わせた。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 8: ユーザーに報告する**

報告に入れるもの: 作ったもの（タスクごとに1行）、テストの結果（型・lint・単体・結合・E2E の比べ方）、本番の DB に当てたもの、開店のときに残っていること（手順書の1の順番、`SHOP_ALERT_EMAIL`・Vercel のプラン・CI の鍵の権限）。


