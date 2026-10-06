/** @jest-environment node */
export {};

const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL;

jest.setTimeout(30000);

function isLocalDatabase(url: string): boolean {
  try {
    return ['localhost', '127.0.0.1', '::1'].includes(new URL(url).hostname);
  } catch {
    return false;
  }
}

describe('integration: durable Stripe webhook queue', () => {
  if (!DATABASE_URL) {
    test.skip('DATABASE_URL 未設定のためスキップ', () => {});
    return;
  }

  if (!isLocalDatabase(DATABASE_URL)) {
    test('localhost 以外の DATABASE_URL では実行しない', () => {
      throw new Error('localhost 以外の DATABASE_URL では実行しない');
    });
    return;
  }

  let client: any;
  let eventId: string;
  let secondaryId: string | null;
  let payload: Record<string, unknown>;

  beforeAll(async () => {
    client = new Client({ connectionString: DATABASE_URL });
    await client.connect();
    await client.query(fs.readFileSync(
      path.join(process.cwd(), 'supabase/migrations/20261005100000_webhook_queue_dead_letter.sql'),
      'utf8',
    ));
  });

  afterAll(async () => {
    if (client) await client.end();
  });

  beforeEach(async () => {
    eventId = `evt_queue_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    secondaryId = null;
    payload = {
      id: eventId,
      type: 'checkout.session.expired',
      data: { object: { id: 'cs_queue_test' } },
    };
    await client.query('begin');
  });

  afterEach(async () => {
    await client.query('rollback');
    await client.query('delete from public.stripe_webhook_events where id = any($1::text[])', [
      [eventId, secondaryId].filter(Boolean),
    ]);
  });

  async function enqueue() {
    return client.query(
      'select public.enqueue_stripe_webhook_event($1,$2,$3::jsonb) as inserted',
      [eventId, payload.type, JSON.stringify(payload)],
    );
  }

  async function claim() {
    await client.query(
      `update public.stripe_webhook_events
       set next_attempt_at = '1970-01-01'::timestamptz
       where id = $1`,
      [eventId],
    );
    const result = await client.query('select * from public.claim_stripe_webhook_event()');
    return result.rows[0];
  }

  test('永続化の後だけ重複を認識し、同一IDを再実行しない', async () => {
    expect((await enqueue()).rows[0].inserted).toBe(true);
    expect((await enqueue()).rows[0].inserted).toBe(false);
    const result = await client.query(
      'select processing_status, attempt_count, raw_payload from public.stripe_webhook_events where id=$1',
      [eventId],
    );
    expect(result.rows[0]).toMatchObject({
      processing_status: 'queued',
      attempt_count: 0,
      raw_payload: payload,
    });
  });

  test('配信メタデータだけが変わった再送は重複、dataの差異は衝突として拒否する', async () => {
    await enqueue();
    const redelivery = { ...payload, pending_webhooks: 0 };
    expect((await client.query(
      'select public.enqueue_stripe_webhook_event($1,$2,$3::jsonb) as inserted',
      [eventId, payload.type, JSON.stringify(redelivery)],
    )).rows[0].inserted).toBe(false);

    await client.query('savepoint changed_data');
    await expect(client.query(
      'select public.enqueue_stripe_webhook_event($1,$2,$3::jsonb)',
      [eventId, payload.type, JSON.stringify({
        ...payload,
        data: { object: { id: 'cs_different' } },
      })],
    )).rejects.toMatchObject({ code: '23505' });
    await client.query('rollback to savepoint changed_data');
  });
  test('claim tokenが一致する場合だけ失敗・完了でき、失敗後は遅延再試行する', async () => {
    await enqueue();
    const first = await claim();
    expect(first.event_id).toBe(eventId);
    expect(first.claim_token).toBeTruthy();
    expect((await client.query(
      'select public.complete_stripe_webhook_event($1,$2::uuid) as completed',
      [eventId, '00000000-0000-0000-0000-000000000000'],
    )).rows[0].completed).toBe(false);

    expect((await client.query(
      'select public.fail_stripe_webhook_event($1,$2::uuid,$3) as failed',
      [eventId, first.claim_token, 'transient error'],
    )).rows[0].failed).toBe(true);
    const failed = await client.query(
      'select processing_status, attempt_count, next_attempt_at > now() as delayed from public.stripe_webhook_events where id=$1',
      [eventId],
    );
    expect(failed.rows[0]).toMatchObject({
      processing_status: 'failed',
      attempt_count: 1,
      delayed: true,
    });
    const second = await claim();
    expect(second.event_id).toBe(eventId);
    expect(second.claim_token).not.toBe(first.claim_token);
    expect((await client.query(
      'select public.complete_stripe_webhook_event($1,$2::uuid) as completed',
      [eventId, second.claim_token],
    )).rows[0].completed).toBe(true);
    const completed = await client.query(
      'select processing_status, attempt_count from public.stripe_webhook_events where id=$1',
      [eventId],
    );
    expect(completed.rows[0]).toMatchObject({ processing_status: 'completed', attempt_count: 2 });
  });

  test('同時workerはSKIP LOCKEDで異なるイベントだけをclaimする', async () => {
    await enqueue();
    secondaryId = `${eventId}_second`;
    await client.query(
      'select public.enqueue_stripe_webhook_event($1,$2,$3::jsonb)',
      [secondaryId, payload.type, JSON.stringify({ ...payload, id: secondaryId })],
    );
    await client.query(
      `update public.stripe_webhook_events
       set next_attempt_at = case when id = $1
         then '1970-01-01'::timestamptz
         else '1970-01-02'::timestamptz end
       where id in ($1,$2)`,
      [eventId, secondaryId],
    );
    await client.query('commit');

    const firstWorker = new Client({ connectionString: DATABASE_URL });
    const secondWorker = new Client({ connectionString: DATABASE_URL });
    await firstWorker.connect();
    await secondWorker.connect();
    try {
      await firstWorker.query('begin');
      await secondWorker.query('begin');
      const first = await firstWorker.query('select * from public.claim_stripe_webhook_event()');
      const second = await secondWorker.query('select * from public.claim_stripe_webhook_event()');
      expect(first.rows[0].event_id).toBe(eventId);
      expect(second.rows[0].event_id).toBe(secondaryId);
      expect(second.rows[0].claim_token).not.toBe(first.rows[0].claim_token);
    } finally {
      await firstWorker.query('rollback');
      await secondWorker.query('rollback');
      await firstWorker.end();
      await secondWorker.end();
    }
  });
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

  test('authenticatedはキューの直接更新とservice-role RPCを実行できない', async () => {
    const grants = await client.query(
      `select has_table_privilege('authenticated','public.stripe_webhook_events','UPDATE') as can_update,
              has_table_privilege('authenticated','public.stripe_webhook_events','SELECT') as can_select,
              has_function_privilege('authenticated','public.enqueue_stripe_webhook_event(text,text,jsonb)','EXECUTE') as can_enqueue,
              has_function_privilege('authenticated','public.claim_stripe_webhook_event()','EXECUTE') as can_claim,
              has_function_privilege('service_role','public.enqueue_stripe_webhook_event(text,text,jsonb)','EXECUTE') as service_can_enqueue,
              has_function_privilege('authenticated','public.mark_stripe_webhook_dead_notified(text[])','EXECUTE') as can_mark_dead,
              has_function_privilege('service_role','public.mark_stripe_webhook_dead_notified(text[])','EXECUTE') as service_can_mark_dead,
              has_function_privilege('anon','public.get_stripe_webhook_backlog(integer)','EXECUTE') as anon_can_read_backlog,
              has_function_privilege('service_role','public.get_stripe_webhook_backlog(integer)','EXECUTE') as service_can_read_backlog,
              has_function_privilege('authenticated','public.list_unnotified_dead_stripe_webhook_events(integer)','EXECUTE') as can_list_dead,
              has_function_privilege('service_role','public.list_unnotified_dead_stripe_webhook_events(integer)','EXECUTE') as service_can_list_dead`,
    );
    expect(grants.rows[0]).toEqual({
      can_update: false,
      can_select: false,
      can_enqueue: false,
      can_claim: false,
      service_can_enqueue: true,
      can_mark_dead: false,
      service_can_mark_dead: true,
      anon_can_read_backlog: false,
      service_can_read_backlog: true,
      can_list_dead: false,
      service_can_list_dead: true,
    });

    await client.query('set local role authenticated');
    await client.query('savepoint denied_rpc');
    await expect(enqueue()).rejects.toMatchObject({ code: '42501' });
    await client.query('rollback to savepoint denied_rpc');
    await expect(
      client.query('update public.stripe_webhook_events set last_error=null where false'),
    ).rejects.toMatchObject({ code: '42501' });
  });
  test('Vaultを参照する10秒間隔のworkerジョブを登録できる', async () => {
    await client.query(fs.readFileSync(
      path.join(process.cwd(), 'supabase/pending/schedule_stripe_webhook_worker.sql'),
      'utf8',
    ));
    const result = await client.query(
      "select schedule, command from cron.job where jobname = 'process-stripe-webhooks'",
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].schedule).toBe('10 seconds');
    expect(result.rows[0].command).toContain('/api/cron/process-stripe-webhooks');
    expect(result.rows[0].command).toContain('vault.decrypted_secrets');
    expect(result.rows[0].command).not.toContain('cron-secret');
  });
});