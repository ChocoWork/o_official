/** @jest-environment node */
import { describeLocalDb } from './helpers/local-db';
import { createCatalogFixture, insertOrderWithStockLine, revisionsOf } from './helpers/order-fixtures';

const fs = require('node:fs');
const path = require('node:path');

jest.setTimeout(30000);

describeLocalDb('integration: 知らせと定期処理の記録', (db) => {
  beforeAll(async () => {
    await db().query(fs.readFileSync(
      path.join(process.cwd(), 'supabase/migrations/20261007030336_ops_alerting.sql'),
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
    await db().query("delete from public.ops_alert_state where alert_key = 'webhook_signature_invalid'");
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
    await db().query("delete from public.ops_alert_state where alert_key = 'webhook_backlog'");
    const first = await db().query(
      `select claimed, claimed_at::text as claimed_at, previous_sent_at::text as previous_sent_at
       from public.claim_ops_alert('webhook_backlog', 3600)`,
    );
    expect(first.rows[0]).toMatchObject({ claimed: true, previous_sent_at: null });
    const second = await db().query("select * from public.claim_ops_alert('webhook_backlog', 3600)");
    expect(second.rows[0].claimed).toBe(false);

    // 他人が後から取った（時刻が違う）なら、元に戻さない
    const wrong = await db().query(
      "select public.release_ops_alert('webhook_backlog', now() - interval '1 day', null) as released",
    );
    expect(wrong.rows[0].released).toBe(false);

    const released = await db().query(
      "select public.release_ops_alert('webhook_backlog', $1::timestamptz, $2::timestamptz) as released",
      [first.rows[0].claimed_at, first.rows[0].previous_sent_at],
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

  test('bump の窓と claim の送信間隔は0秒を22023で断る', async () => {
    const errors: unknown[] = [];
    for (const sql of [
      "select public.bump_ops_signal('webhook_signature_invalid', 0)",
      "select * from public.claim_ops_alert('webhook_backlog', 0)",
    ]) {
      await db().query('savepoint invalid_seconds');
      try {
        await db().query(sql);
        errors.push(null);
      } catch (error) {
        errors.push(error);
      } finally {
        await db().query('rollback to savepoint invalid_seconds');
      }
    }
    expect(errors).toEqual([
      expect.objectContaining({ code: '22023' }),
      expect.objectContaining({ code: '22023' }),
    ]);
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
    expect(await revisionsOf(db(), plain.orderId)).toEqual([
      { reason: 'order_sweep_recovered_from_payment', sourceEventId: null, changedBy: null },
    ]);
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
    const stockRevisionsBefore = await revisionsOf(db(), stock.orderId);
    const kept = await db().query('select public.mark_order_recovered_from_payment($1::uuid) as reason', [
      stock.orderId,
    ]);
    expect(kept.rows[0].reason).toBe('stock_not_reserved');
    expect(await revisionsOf(db(), stock.orderId)).toEqual(stockRevisionsBefore);
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

    const catalog = await createCatalogFixture(db(), { stock: 0 });
    const order = await insertOrderWithStockLine(db(), {
      status: 'paid', itemId: catalog.itemId, variantId: catalog.variantId, quantity: 1, reserved: false,
    });
    await db().query('savepoint invalid_review_reason');
    await expect(db().query("update public.orders set review_reason = 'other' where id = $1", [
      order.orderId,
    ])).rejects.toMatchObject({ code: '23514' });
    await db().query('rollback to savepoint invalid_review_reason');
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
