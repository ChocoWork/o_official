/** @jest-environment node */
import { connectLocalDb, describeLocalDb, type PgClient } from './helpers/local-db';
import { createCatalogFixture, insertOrderWithStockLine, uniqueSuffix } from './helpers/order-fixtures';

/**
 * 注文のメールの表と関数（グループ D 設計書 3・4・6・7 章）。
 * 取り出しは表全体から古い順に選ぶので、1件ごとに取引の中で表を空にし、終わったら戻す（ほかの試験の行に邪魔されない）。
 * 同時の取り出しだけは2つの接続が要るので、別の describe で確定した行を使う。
 */
jest.setTimeout(30000);

type Row = Record<string, any>;

async function createOrder(db: PgClient, status: string): Promise<string> {
  const fx = await createCatalogFixture(db, { stock: 1 });
  const { orderId } = await insertOrderWithStockLine(db, {
    status, itemId: fx.itemId, variantId: fx.variantId, quantity: 1, reserved: false,
  });
  return orderId;
}

/** order_revisions.changed_by と requested_by は auth.users への外部キーなので、実在の行を作る */
async function createActor(db: PgClient): Promise<{ id: string; email: string }> {
  const email = `order-email-admin-${uniqueSuffix()}@example.com`;
  const res = await db.query(
    `insert into auth.users (id, email, raw_user_meta_data, created_at, updated_at)
     values (gen_random_uuid(), $1, '{}'::jsonb, now(), now()) returning id`,
    [email],
  );
  return { id: res.rows[0].id as string, email };
}

async function enqueue(db: PgClient, orderId: string, kind: string, variant: string | null = null): Promise<boolean> {
  const res = await db.query('select private.enqueue_order_email($1::uuid, $2::text, $3::text) as inserted', [orderId, kind, variant]);
  return res.rows[0].inserted as boolean;
}

async function claim(db: PgClient): Promise<Row | null> {
  const res = await db.query('select * from public.claim_order_email(300)');
  return res.rows[0] ?? null;
}

async function emailRow(db: PgClient, emailId: string): Promise<Row> {
  return (await db.query('select * from private.order_email_outbox where id = $1', [emailId])).rows[0];
}

async function sendState(db: PgClient): Promise<Row> {
  return (await db.query('select * from public.get_order_email_send_state()')).rows[0];
}

/** 取引の中では now() が止まっているので、次に試す時刻との差が待つ時間そのものになる */
async function waitSeconds(db: PgClient, emailId: string): Promise<number> {
  const res = await db.query(
    'select extract(epoch from next_attempt_at - now())::float8 as wait from private.order_email_outbox where id = $1',
    [emailId],
  );
  return Number(res.rows[0].wait);
}

function complete(db: PgClient, claimed: Row, messageId: string | null = null) {
  return db.query('select public.complete_order_email($1, $2, $3) as done', [claimed.email_id, claimed.lease_token, messageId]);
}

function fail(db: PgClient, claimed: Row, code: string, category: string, retryAfter: number | null = null) {
  return db.query('select public.fail_order_email($1, $2, $3, $4, $5) as status', [
    claimed.email_id, claimed.lease_token, code, category, retryAfter,
  ]);
}

/** 取引の中で、失敗する文を流した後に続けられるようにする */
async function expectRejected(db: PgClient, sql: string, params: unknown[], match: Record<string, unknown>) {
  await db.query('savepoint expect_rejected');
  await expect(db.query(sql, params)).rejects.toMatchObject(match);
  await db.query('rollback to savepoint expect_rejected');
}

describeLocalDb('integration: 注文のメールの表と関数', (db) => {
  beforeEach(async () => {
    await db().query('begin');
    await db().query('delete from private.order_email_outbox');
    await db().query('update private.order_email_send_pause set paused = false, reason = null, paused_at = null, next_probe_at = null');
  });

  afterEach(async () => {
    await db().query('rollback');
  });

  describe('表の決まり', () => {
    test('自動の行は1注文1種類1行。2回目は何もしない', async () => {
      const orderId = await createOrder(db(), 'paid');

      expect(await enqueue(db(), orderId, 'paid', 'order_confirmed')).toBe(true);
      expect(await enqueue(db(), orderId, 'paid', 'payment_received')).toBe(false);

      const rows = await db().query('select kind, variant, origin, status from private.order_email_outbox where order_id = $1', [orderId]);
      expect(rows.rows).toEqual([{ kind: 'paid', variant: 'order_confirmed', origin: 'auto', status: 'pending' }]);
    });

    test('書き分けは種類に合うものだけ。入金済みと取消は書き分けが要る', async () => {
      const orderId = await createOrder(db(), 'paid');
      await expectRejected(db(), 'select private.enqueue_order_email($1, $2, $3)', [orderId, 'paid', null], { code: '23514' });
      await expectRejected(db(), 'select private.enqueue_order_email($1, $2, $3)', [orderId, 'canceled', null], { code: '23514' });
      await expectRejected(db(), 'select private.enqueue_order_email($1, $2, $3)', [orderId, 'canceled', 'paid'], { code: '23514' });
      await expectRejected(db(), 'select private.enqueue_order_email($1, $2, $3)', [orderId, 'shipped', 'order_confirmed'], { code: '23514' });
      await expectRejected(db(), 'select private.enqueue_order_email($1, $2, $3)', [orderId, 'refund', null], { code: '23514' });
    });

    test('知らないメールの種類は表の種類の CHECK で断る', async () => {
      const orderId = await createOrder(db(), 'paid');

      await expectRejected(db(), 'select private.enqueue_order_email($1, $2, $3)', [orderId, 'unknown', null], {
        code: '23514', constraint: 'order_email_outbox_kind_check',
      });
    });
  });

  describe('取り出し', () => {
    test.each([null, 29, 901])('担当の秒数 %s は INVALID_LEASE_SECONDS で断る', async (seconds) => {
      await expectRejected(db(), 'select * from public.claim_order_email($1::integer)', [seconds], {
        code: '22023', message: 'INVALID_LEASE_SECONDS',
      });
    });

    test('担当の印を付けて1行取り出し、試した回数を数える', async () => {
      const orderId = await createOrder(db(), 'paid');
      await enqueue(db(), orderId, 'paid', 'order_confirmed');

      const claimed = await claim(db());

      expect(claimed).toMatchObject({
        order_id: orderId, kind: 'paid', variant: 'order_confirmed', origin: 'auto', attempts: 1,
        subject: null, body_text: null, payment_expired_sent: false,
      });
      expect(claimed?.lease_token).toEqual(expect.any(String));
      expect(await emailRow(db(), claimed!.email_id)).toMatchObject({ status: 'sending' });
      expect(await claim(db())).toBeNull();
    });

    test('同じ注文の後の行は、前の行が片付くまで取り出さない', async () => {
      const orderId = await createOrder(db(), 'pending');
      await enqueue(db(), orderId, 'awaiting_payment');
      await enqueue(db(), orderId, 'paid', 'payment_received');

      const first = await claim(db());
      expect(first?.kind).toBe('awaiting_payment');
      expect(await claim(db())).toBeNull();

      await db().query('select public.skip_order_email($1, $2, $3)', [first!.email_id, first!.lease_token, 'superseded']);
      const second = await claim(db());
      expect(second?.kind).toBe('paid');
    });

    test('期限切れのメールを送っていれば payment_expired_sent が true', async () => {
      const orderId = await createOrder(db(), 'failed');
      await enqueue(db(), orderId, 'payment_expired');
      const expired = await claim(db());
      await complete(db(), expired!, `re_${uniqueSuffix()}`);
      await enqueue(db(), orderId, 'paid', 'payment_received_after_expiry');

      expect(await claim(db())).toMatchObject({ kind: 'paid', payment_expired_sent: true });
    });

    test('中身は送る前に一度だけ控え、控えは取り出しで返る', async () => {
      const orderId = await createOrder(db(), 'paid');
      await enqueue(db(), orderId, 'paid', 'order_confirmed');
      const claimed = await claim(db());

      const saved = await db().query('select public.save_order_email_content($1, $2, $3, $4) as saved', [
        claimed!.email_id, claimed!.lease_token, '件名', '本文',
      ]);
      const again = await db().query('select public.save_order_email_content($1, $2, $3, $4) as saved', [
        claimed!.email_id, claimed!.lease_token, '別の件名', '別の本文',
      ]);

      expect(saved.rows[0].saved).toBe(true);
      expect(again.rows[0].saved).toBe(false);
      expect(await emailRow(db(), claimed!.email_id)).toMatchObject({ subject: '件名', body_text: '本文' });
    });

    test('担当の期限が切れた行は1回の失敗として数え、控えた中身は残す', async () => {
      const orderId = await createOrder(db(), 'paid');
      await enqueue(db(), orderId, 'paid', 'order_confirmed');
      const claimed = await claim(db());
      await db().query('select public.save_order_email_content($1, $2, $3, $4)', [claimed!.email_id, claimed!.lease_token, '件名', '本文']);
      await db().query("update private.order_email_outbox set lease_expires_at = now() - interval '1 second' where id = $1", [claimed!.email_id]);

      expect(await claim(db())).toBeNull();
      const row = await emailRow(db(), claimed!.email_id);
      expect(row).toMatchObject({ status: 'retry_wait', attempts: 1, last_error_code: 'lease_expired', subject: '件名', body_text: '本文' });
      const wait = await waitSeconds(db(), claimed!.email_id);
      expect(wait).toBeGreaterThanOrEqual(48);
      expect(wait).toBeLessThanOrEqual(72);

      await db().query('update private.order_email_outbox set next_attempt_at = now() where id = $1', [claimed!.email_id]);
      expect(await claim(db())).toMatchObject({ email_id: claimed!.email_id, attempts: 2, subject: '件名', body_text: '本文' });
    });

    test('担当の印が違えば、送信済みにも失敗にもできない', async () => {
      const orderId = await createOrder(db(), 'paid');
      await enqueue(db(), orderId, 'paid', 'order_confirmed');
      const claimed = await claim(db());
      const wrong = { ...claimed, lease_token: '00000000-0000-4000-8000-000000000000' };

      expect((await complete(db(), wrong)).rows[0].done).toBe(false);
      expect((await fail(db(), wrong, 'network_error', 'transient')).rows[0].status).toBeNull();
      expect(await emailRow(db(), claimed!.email_id)).toMatchObject({ status: 'sending' });
    });

    test('9回目の担当の期限が切れた行は、次の取り出しで送れなかったにし、控えた本文を消す', async () => {
      const orderId = await createOrder(db(), 'paid');
      await enqueue(db(), orderId, 'paid', 'order_confirmed');
      await db().query('update private.order_email_outbox set attempts = 8 where order_id = $1', [orderId]);
      const claimed = await claim(db());
      expect(claimed).toMatchObject({ order_id: orderId, attempts: 9 });
      await db().query('select public.save_order_email_content($1, $2, $3, $4)', [claimed!.email_id, claimed!.lease_token, '件名', '本文']);
      await db().query("update private.order_email_outbox set lease_expires_at = now() - interval '1 second' where id = $1", [claimed!.email_id]);

      expect(await claim(db())).toBeNull();
      expect(await emailRow(db(), claimed!.email_id)).toMatchObject({
        status: 'dead', attempts: 9, last_error_code: 'lease_expired',
        subject: null, body_text: null, lease_token: null, lease_expires_at: null,
      });
      const erased = await db().query(
        `select finished_at = now() as finished, body_erased_at = now() as erased
         from private.order_email_outbox where id = $1`,
        [claimed!.email_id],
      );
      expect(erased.rows[0]).toEqual({ finished: true, erased: true });
    });
  });

  describe('やり直しと送れなかった', () => {
    test('一時的な失敗はやり直し待ちにし、1分の前後2割だけ待つ', async () => {
      const orderId = await createOrder(db(), 'paid');
      await enqueue(db(), orderId, 'paid', 'order_confirmed');
      const claimed = await claim(db());

      expect((await fail(db(), claimed!, 'provider_unavailable', 'transient')).rows[0].status).toBe('retry_wait');
      const wait = await waitSeconds(db(), claimed!.email_id);
      expect(wait).toBeGreaterThanOrEqual(48);
      expect(wait).toBeLessThanOrEqual(72);
      expect(await emailRow(db(), claimed!.email_id)).toMatchObject({ last_error_code: 'provider_unavailable', attempts: 1 });
    });

    test('待つ時間の指示が長ければ、そちらに従う', async () => {
      const orderId = await createOrder(db(), 'paid');
      await enqueue(db(), orderId, 'paid', 'order_confirmed');
      const claimed = await claim(db());

      await fail(db(), claimed!, 'rate_limited', 'transient', 600);

      expect(await waitSeconds(db(), claimed!.email_id)).toBeCloseTo(600, 0);
    });

    test('待つ時間の指示が2日でも、待つ時間は1日で打ち切る', async () => {
      const orderId = await createOrder(db(), 'paid');
      await enqueue(db(), orderId, 'paid', 'order_confirmed');
      const claimed = await claim(db());

      expect((await fail(db(), claimed!, 'rate_limited', 'transient', 172800)).rows[0].status).toBe('retry_wait');
      expect(await waitSeconds(db(), claimed!.email_id)).toBe(86400);
    });

    test('9回目の失敗で送れなかったにし、控えた本文を消す', async () => {
      const orderId = await createOrder(db(), 'paid');
      await enqueue(db(), orderId, 'paid', 'order_confirmed');
      await db().query('update private.order_email_outbox set attempts = 8 where order_id = $1', [orderId]);
      const claimed = await claim(db());
      await db().query('select public.save_order_email_content($1, $2, $3, $4)', [claimed!.email_id, claimed!.lease_token, '件名', '本文']);

      expect((await fail(db(), claimed!, 'provider_unavailable', 'transient')).rows[0].status).toBe('dead');
      const row = await emailRow(db(), claimed!.email_id);
      expect(row).toMatchObject({ status: 'dead', attempts: 9, subject: null, body_text: null });
      expect(row.finished_at).not.toBeNull();
      expect(row.body_erased_at).not.toBeNull();
    });

    test('このメールだけの問題はすぐに送れなかったにする', async () => {
      const orderId = await createOrder(db(), 'paid');
      await enqueue(db(), orderId, 'paid', 'order_confirmed');
      const claimed = await claim(db());

      expect((await fail(db(), claimed!, 'invalid_message', 'permanent')).rows[0].status).toBe('dead');
    });

    test('知らない分け方と形の違う記号は断る', async () => {
      const orderId = await createOrder(db(), 'paid');
      await enqueue(db(), orderId, 'paid', 'order_confirmed');
      const claimed = await claim(db());
      await expectRejected(db(), 'select public.fail_order_email($1, $2, $3, $4, null)', [claimed!.email_id, claimed!.lease_token, 'network_error', 'retry'], { code: '22023' });
      await expectRejected(db(), 'select public.fail_order_email($1, $2, $3, $4, null)', [claimed!.email_id, claimed!.lease_token, 'Error: secret', 'transient'], { code: '22023' });
    });

    test('取りやめは理由を残し、控えた本文を消す', async () => {
      const orderId = await createOrder(db(), 'paid');
      await enqueue(db(), orderId, 'awaiting_payment');
      const claimed = await claim(db());
      await db().query('select public.save_order_email_content($1, $2, $3, $4)', [claimed!.email_id, claimed!.lease_token, '件名', '本文']);

      await db().query('select public.skip_order_email($1, $2, $3)', [claimed!.email_id, claimed!.lease_token, 'superseded']);

      expect(await emailRow(db(), claimed!.email_id)).toMatchObject({
        status: 'skipped', last_error_code: 'superseded', subject: null, body_text: null,
      });
      await expectRejected(db(), 'select public.skip_order_email($1, $2, $3)', [claimed!.email_id, claimed!.lease_token, 'other'], { code: '22023' });
    });

    test('入金済みのメールは superseded で取りやめにできず、no_recipient ならできる', async () => {
      const orderId = await createOrder(db(), 'paid');
      await enqueue(db(), orderId, 'paid', 'order_confirmed');
      const claimed = await claim(db());
      await db().query('select public.save_order_email_content($1, $2, $3, $4)', [claimed!.email_id, claimed!.lease_token, '件名', '本文']);

      await expectRejected(db(), 'select public.skip_order_email($1, $2, $3)', [claimed!.email_id, claimed!.lease_token, 'superseded'], {
        code: '22023', message: 'SUPERSEDE_NOT_ALLOWED',
      });
      expect(await emailRow(db(), claimed!.email_id)).toMatchObject({
        status: 'sending', lease_token: claimed!.lease_token, subject: '件名', body_text: '本文', last_error_code: null,
      });

      const skipped = await db().query('select public.skip_order_email($1, $2, $3) as skipped', [claimed!.email_id, claimed!.lease_token, 'no_recipient']);
      expect(skipped.rows[0].skipped).toBe(true);
      expect(await emailRow(db(), claimed!.email_id)).toMatchObject({
        status: 'skipped', last_error_code: 'no_recipient', subject: null, body_text: null, lease_token: null, lease_expires_at: null,
      });
    });
  });

  describe('送信の一時停止', () => {
    test('設定の問題は回数を数えずに戻し、送信全体を止め、15分後に1件だけ試す', async () => {
      const first = await createOrder(db(), 'paid');
      const second = await createOrder(db(), 'paid');
      await enqueue(db(), first, 'paid', 'order_confirmed');
      await enqueue(db(), second, 'paid', 'order_confirmed');
      const claimed = await claim(db());

      expect((await fail(db(), claimed!, 'config_api_key', 'config')).rows[0].status).toBe('retry_wait');

      expect(await emailRow(db(), claimed!.email_id)).toMatchObject({ status: 'retry_wait', attempts: 0, last_error_code: 'config_api_key' });
      expect(await sendState(db())).toMatchObject({ paused: true, reason: 'config_api_key' });
      const probe = await db().query("select next_probe_at = now() + interval '15 minutes' as ok from public.get_order_email_send_state()");
      expect(probe.rows[0].ok).toBe(true);
      expect(await claim(db())).toBeNull();

      await db().query("update private.order_email_send_pause set next_probe_at = now() - interval '1 second'");
      const tried = await claim(db());
      expect(tried).not.toBeNull();
      expect(await claim(db())).toBeNull();
      const moved = await db().query("select next_probe_at = now() + interval '15 minutes' as ok from public.get_order_email_send_state()");
      expect(moved.rows[0].ok).toBe(true);

      await complete(db(), tried!);
      expect(await sendState(db())).toMatchObject({ paused: false, reason: null, paused_at: null, next_probe_at: null });
      expect(await claim(db())).not.toBeNull();
    });

    test('1日の上限は次の UTC 0時まで試さない', async () => {
      await db().query("select public.pause_order_email_sending('quota_daily')");

      const res = await db().query(
        `select next_probe_at > now() as future,
                next_probe_at <= now() + interval '1 day' as within_day,
                extract(hour from next_probe_at at time zone 'UTC')::int as utc_hour,
                extract(minute from next_probe_at at time zone 'UTC')::int as utc_minute,
                extract(second from next_probe_at at time zone 'UTC')::float8 as utc_second
         from public.get_order_email_send_state()`,
      );
      expect(res.rows[0].future).toBe(true);
      expect(res.rows[0].within_day).toBe(true);
      expect(res.rows[0].utc_hour).toBe(0);
      expect(res.rows[0].utc_minute).toBe(0);
      expect(res.rows[0].utc_second).toBe(0);
    });

    test('止めた時刻は最初のまま。知らない理由は断る', async () => {
      const firstPause = await db().query("select public.pause_order_email_sending('config_provider') as newly");
      await db().query(
        "update private.order_email_send_pause set paused_at = now() - interval '1 hour', next_probe_at = now() - interval '1 minute'",
      );
      const secondPause = await db().query("select public.pause_order_email_sending('config_provider') as newly");

      expect(firstPause.rows[0].newly).toBe(true);
      expect(secondPause.rows[0].newly).toBe(false);
      const state = await db().query(
        `select paused_at = now() - interval '1 hour' as kept,
                next_probe_at = now() + interval '15 minutes' as rescheduled
         from public.get_order_email_send_state()`,
      );
      expect(state.rows[0].kept).toBe(true);
      expect(state.rows[0].rescheduled).toBe(true);
      await expectRejected(db(), "select public.pause_order_email_sending('network_error')", [], { code: '22023' });
    });
  });

  describe('手の再送', () => {
    async function sentPaidEmail(status = 'paid'): Promise<{ orderId: string; emailId: string }> {
      const orderId = await createOrder(db(), status);
      await enqueue(db(), orderId, 'paid', 'order_confirmed');
      const claimed = await claim(db());
      await complete(db(), claimed!, `re_${uniqueSuffix()}`);
      return { orderId, emailId: claimed!.email_id };
    }

    test('知らない再送の種類は INVALID_EMAIL_KIND で断る', async () => {
      const orderId = await createOrder(db(), 'paid');
      const actor = await createActor(db());

      await expectRejected(db(), 'select public.request_order_email_resend($1, $2, $3)', [orderId, 'unknown', actor.id], {
        code: '22023', message: 'INVALID_EMAIL_KIND',
      });
    });

    test.each(['注文', '種類', '管理者'])('再送の%sが NULL なら RESEND_ARGUMENT_REQUIRED で断る', async (missing) => {
      const orderId = await createOrder(db(), 'paid');
      const actor = await createActor(db());
      const args = [missing === '注文' ? null : orderId, missing === '種類' ? null : 'paid', missing === '管理者' ? null : actor.id];

      await expectRejected(db(), 'select public.request_order_email_resend($1, $2, $3)', args, {
        code: '22023', message: 'RESEND_ARGUMENT_REQUIRED',
      });
    });

    test('送信済みのメールを、同じ書き分けの手の行として足し、管理者を記録する', async () => {
      const actor = await createActor(db());
      const { orderId } = await sentPaidEmail();

      const res = await db().query('select public.request_order_email_resend($1, $2, $3) as email_id', [orderId, 'paid', actor.id]);

      expect(await emailRow(db(), res.rows[0].email_id)).toMatchObject({
        kind: 'paid', variant: 'order_confirmed', origin: 'manual', requested_by: actor.id, status: 'pending',
      });
    });

    test('同じ種類の手の再送が送信待ちの間は、次を断る。送った後はまた足せる', async () => {
      const actor = await createActor(db());
      const { orderId } = await sentPaidEmail();
      await db().query('select public.request_order_email_resend($1, $2, $3)', [orderId, 'paid', actor.id]);

      await expectRejected(db(), 'select public.request_order_email_resend($1, $2, $3)', [orderId, 'paid', actor.id], {
        code: '23505', message: expect.stringContaining('RESEND_ALREADY_QUEUED'),
      });

      const manual = await claim(db());
      await complete(db(), manual!, `re_${uniqueSuffix()}`);
      await expect(db().query('select public.request_order_email_resend($1, $2, $3)', [orderId, 'paid', actor.id])).resolves.toBeTruthy();
    });

    test('今の注文の状態で意味の無い種類と、送信済み・送れなかったの行が無い種類は断る', async () => {
      const actor = await createActor(db());
      const { orderId } = await sentPaidEmail();
      await expectRejected(db(), 'select public.request_order_email_resend($1, $2, $3)', [orderId, 'awaiting_payment', actor.id], {
        code: '22023', message: expect.stringContaining('RESEND_NOT_ALLOWED'),
      });
      await expectRejected(db(), 'select public.request_order_email_resend($1, $2, $3)', [orderId, 'shipped', actor.id], {
        code: '22023', message: expect.stringContaining('RESEND_NOT_ALLOWED'),
      });

      const pendingOrder = await createOrder(db(), 'pending');
      await enqueue(db(), pendingOrder, 'awaiting_payment');
      await expectRejected(db(), 'select public.request_order_email_resend($1, $2, $3)', [pendingOrder, 'awaiting_payment', actor.id], {
        code: '22023', message: expect.stringContaining('RESEND_NOT_ALLOWED'),
      });
      await expectRejected(db(), 'select public.request_order_email_resend($1, $2, $3)', ['00000000-0000-4000-8000-000000000000', 'paid', actor.id], {
        code: 'P0002',
      });
    });

    test('送れなかったメールも再送できる', async () => {
      const actor = await createActor(db());
      const orderId = await createOrder(db(), 'paid');
      await enqueue(db(), orderId, 'paid', 'order_confirmed');
      const claimed = await claim(db());
      await fail(db(), claimed!, 'invalid_message', 'permanent');

      await expect(db().query('select public.request_order_email_resend($1, $2, $3)', [orderId, 'paid', actor.id])).resolves.toBeTruthy();
    });
  });

  describe('管理画面の履歴と中身', () => {
    test('メールの履歴は新しい順で、本文は返さず、手の再送の管理者のメールアドレスを返す', async () => {
      const actor = await createActor(db());
      const orderId = await createOrder(db(), 'paid');
      await enqueue(db(), orderId, 'paid', 'order_confirmed');
      const auto = await claim(db());
      await db().query('select public.save_order_email_content($1, $2, $3, $4)', [auto!.email_id, auto!.lease_token, '件名', '本文']);
      await complete(db(), auto!, `re_${uniqueSuffix()}`);
      await db().query('select public.request_order_email_resend($1, $2, $3)', [orderId, 'paid', actor.id]);

      const res = await db().query('select * from public.list_order_email_history($1)', [orderId]);

      expect(res.rows.map((row) => [row.origin, row.status, row.requested_by_email, row.has_body])).toEqual([
        ['manual', 'pending', actor.email, false],
        ['auto', 'sent', null, true],
      ]);
      expect(Object.keys(res.rows[0])).not.toContain('body_text');
    });

    test('注文の状態の変化を、変えた管理者と取消の理由つきで新しい順に返す', async () => {
      const actor = await createActor(db());
      const orderId = await createOrder(db(), 'payment_in_progress');
      await db().query(
        `select public.release_stock_for_unpaid_order($1, 'payment_in_progress', 'cancelled', 'admin_cancel', $2, null, 'customer_request', null, false)`,
        [orderId, actor.id],
      );

      const res = await db().query('select * from public.list_order_status_history($1)', [orderId]);

      expect(res.rows).toEqual([
        expect.objectContaining({
          from_status: 'payment_in_progress', to_status: 'cancelled', change_reason: 'admin_cancel',
          actor_email: actor.email, cancel_reason: 'customer_request', shipping_carrier: null, tracking_number: null,
        }),
      ]);
    });

    test('一部の返金は状態の履歴を増やさず、全額の返金による取消は履歴に返す', async () => {
      const orderId = await createOrder(db(), 'paid');
      const orderStateSql = `select status::text as status, total_amount, refunded_amount,
                                   payment_status_updated_at::text as payment_status_updated_at
                            from public.orders where id = $1`;
      // 期待する更新時刻は文字列で読み、PostgreSQL の秒未満の精度を保つ。
      const initial = (await db().query(orderStateSql, [orderId])).rows[0];
      const partialAmount = Math.floor(Number(initial.total_amount) / 2);
      expect(partialAmount).toBeGreaterThan(0);
      expect(partialAmount).toBeLessThan(Number(initial.total_amount));
      const before = await db().query('select * from public.list_order_status_history($1)', [orderId]);
      expect(before.rows).toEqual([]);

      const partial = await db().query(
        `select * from public.apply_order_refund_projection(
          $1::uuid, $2::public.order_status, $3::integer, $4::timestamptz, $5::integer, now(), now(), null
        )`,
        [orderId, initial.status, initial.refunded_amount, initial.payment_status_updated_at, partialAmount],
      );
      expect(partial.rows).toEqual([{ id: orderId, status: 'paid', refunded_amount: partialAmount }]);
      expect((await db().query('select * from public.list_order_status_history($1)', [orderId])).rows).toEqual(before.rows);

      const afterPartial = (await db().query(orderStateSql, [orderId])).rows[0];
      const full = await db().query(
        `select * from public.apply_order_refund_projection(
          $1::uuid, $2::public.order_status, $3::integer, $4::timestamptz, $5::integer, now(), now(), null
        )`,
        [orderId, afterPartial.status, afterPartial.refunded_amount, afterPartial.payment_status_updated_at, afterPartial.total_amount],
      );
      expect(full.rows).toEqual([{ id: orderId, status: 'cancelled', refunded_amount: Number(afterPartial.total_amount) }]);
      expect((await db().query('select * from public.list_order_status_history($1)', [orderId])).rows).toEqual([
        expect.objectContaining({ from_status: 'paid', to_status: 'cancelled', change_reason: 'stripe_refund_projection' }),
      ]);
    });

    test('中身は送信済みの行だけ返し、本文を消した後は消したことだけ返す', async () => {
      const orderId = await createOrder(db(), 'paid');
      await enqueue(db(), orderId, 'paid', 'order_confirmed');
      const claimed = await claim(db());
      await db().query('select public.save_order_email_content($1, $2, $3, $4)', [claimed!.email_id, claimed!.lease_token, '件名', '本文']);

      const beforeSent = await db().query('select * from public.get_order_email_content($1, $2)', [orderId, claimed!.email_id]);
      expect(beforeSent.rows).toEqual([]);

      await complete(db(), claimed!, `re_${uniqueSuffix()}`);
      const sent = await db().query('select subject, body_text, body_erased from public.get_order_email_content($1, $2)', [orderId, claimed!.email_id]);
      expect(sent.rows).toEqual([{ subject: '件名', body_text: '本文', body_erased: false }]);

      const otherOrder = await createOrder(db(), 'paid');
      const wrongOrder = await db().query('select * from public.get_order_email_content($1, $2)', [otherOrder, claimed!.email_id]);
      expect(wrongOrder.rows).toEqual([]);

      await db().query("update private.order_email_outbox set sent_at = now() - interval '46 days' where id = $1", [claimed!.email_id]);
      await db().query('select private.purge_order_email_data()');
      const erased = await db().query('select subject, body_text, body_erased from public.get_order_email_content($1, $2)', [orderId, claimed!.email_id]);
      expect(erased.rows).toEqual([{ subject: null, body_text: null, body_erased: true }]);
    });
  });

  describe('配達の状態', () => {
    async function sentWithMessage(messageId: string): Promise<string> {
      const orderId = await createOrder(db(), 'paid');
      await enqueue(db(), orderId, 'paid', 'order_confirmed');
      const claimed = await claim(db());
      await complete(db(), claimed!, messageId);
      return claimed!.email_id as string;
    }

    function record(svixId: string | null, messageId: string, status: string, eventAt: string) {
      return db().query('select public.record_order_email_delivery($1, $2, $3, $4::timestamptz) as result', [svixId, messageId, status, eventAt]);
    }

    test('新しい知らせだけ記録し、同じ知らせの番号は1回だけ処理する', async () => {
      const messageId = `re_${uniqueSuffix()}`;
      const emailId = await sentWithMessage(messageId);
      const svix = `msg_${uniqueSuffix()}`;

      expect((await record(svix, messageId, 'delivered', '2026-10-09T01:00:00Z')).rows[0].result).toBe('updated');
      expect((await record(svix, messageId, 'delivered', '2026-10-09T01:00:00Z')).rows[0].result).toBe('duplicate');
      expect((await record(`msg_${uniqueSuffix()}`, messageId, 'delayed', '2026-10-09T00:59:00Z')).rows[0].result).toBe('stale');
      expect(await emailRow(db(), emailId)).toMatchObject({ delivery_status: 'delivered' });
    });

    test('届かなかった知らせは店へ知らせる印を空にし、知らないメールは何もしない', async () => {
      const messageId = `re_${uniqueSuffix()}`;
      const emailId = await sentWithMessage(messageId);
      await db().query('update private.order_email_outbox set delivery_alert_notified_at = now() where id = $1', [emailId]);

      expect((await record(null, messageId, 'bounced', '2026-10-09T02:00:00Z')).rows[0].result).toBe('updated');
      expect(await emailRow(db(), emailId)).toMatchObject({ delivery_status: 'bounced', delivery_alert_notified_at: null });
      expect((await record(`msg_${uniqueSuffix()}`, `re_unknown_${uniqueSuffix()}`, 'delivered', '2026-10-09T02:00:00Z')).rows[0].result).toBe('unknown_email');
      await expectRejected(db(), 'select public.record_order_email_delivery($1, $2, $3, now())', [null, messageId, 'opened'], { code: '22023' });
    });

    test('見回りの対象は、送ってから3日以内で配達の状態が決まっていないメールだけ', async () => {
      const waiting = await sentWithMessage(`re_${uniqueSuffix()}`);
      const delayed = await sentWithMessage(`re_${uniqueSuffix()}`);
      const delivered = await sentWithMessage(`re_${uniqueSuffix()}`);
      const old = await sentWithMessage(`re_${uniqueSuffix()}`);
      await db().query("update private.order_email_outbox set delivery_status = 'delayed', delivery_event_at = now() where id = $1", [delayed]);
      await db().query("update private.order_email_outbox set delivery_status = 'delivered', delivery_event_at = now() where id = $1", [delivered]);
      await db().query("update private.order_email_outbox set sent_at = now() - interval '4 days' where id = $1", [old]);

      const res = await db().query('select email_id from public.list_order_emails_awaiting_delivery(50)');

      expect(res.rows.map((row) => row.email_id).sort()).toEqual([waiting, delayed].sort());
    });
  });

  describe('点検', () => {
    test('15分以上送れていないメールを状態ごとに数える', async () => {
      const orderId = await createOrder(db(), 'paid');
      await enqueue(db(), orderId, 'paid', 'order_confirmed');
      await db().query("update private.order_email_outbox set created_at = now() - interval '20 minutes' where order_id = $1", [orderId]);

      const res = await db().query('select * from public.get_order_email_backlog(900)');

      expect(res.rows).toEqual([expect.objectContaining({ status: 'pending', email_count: 1, last_errors: [] })]);
    });

    test('まだ知らせていない送れなかったメールを返し、印を付けると返さない', async () => {
      const orderId = await createOrder(db(), 'paid');
      await enqueue(db(), orderId, 'paid', 'order_confirmed');
      const claimed = await claim(db());
      await fail(db(), claimed!, 'invalid_message', 'permanent');

      const listed = await db().query('select * from public.list_unnotified_dead_order_emails(50)');
      expect(listed.rows).toEqual([expect.objectContaining({ email_id: claimed!.email_id, kind: 'paid', last_error_code: 'invalid_message', total_count: 1 })]);

      const marked = await db().query('select public.mark_order_emails_dead_notified($1::uuid[]) as count', [[claimed!.email_id]]);
      expect(marked.rows[0].count).toBe(1);
      expect((await db().query('select * from public.list_unnotified_dead_order_emails(50)')).rows).toEqual([]);
    });

    test('まだ知らせていない届かなかったメールを返し、印を付けると返さない', async () => {
      const messageId = `re_${uniqueSuffix()}`;
      const orderId = await createOrder(db(), 'paid');
      await enqueue(db(), orderId, 'paid', 'order_confirmed');
      const claimed = await claim(db());
      await complete(db(), claimed!, messageId);
      await db().query("select public.record_order_email_delivery(null, $1, 'suppressed', now())", [messageId]);

      const listed = await db().query('select * from public.list_unnotified_order_email_delivery_problems(50)');
      expect(listed.rows).toEqual([expect.objectContaining({ email_id: claimed!.email_id, delivery_status: 'suppressed', total_count: 1 })]);

      await db().query('select public.mark_order_email_delivery_problems_notified($1::uuid[])', [[claimed!.email_id]]);
      expect((await db().query('select * from public.list_unnotified_order_email_delivery_problems(50)')).rows).toEqual([]);
    });

    test.each([null, -1])('未通知の一覧の件数が %s でも例外にならず0行を返す', async (limit) => {
      const deadOrder = await createOrder(db(), 'paid');
      await enqueue(db(), deadOrder, 'paid', 'order_confirmed');
      const dead = await claim(db());
      await fail(db(), dead!, 'invalid_message', 'permanent');

      const deliveryOrder = await createOrder(db(), 'paid');
      const messageId = `re_${uniqueSuffix()}`;
      await enqueue(db(), deliveryOrder, 'paid', 'order_confirmed');
      const sent = await claim(db());
      await complete(db(), sent!, messageId);
      await db().query("select public.record_order_email_delivery(null, $1, 'bounced', now())", [messageId]);

      // 対象の行があることを先に確かめ、空の表で偶然通る試験にしない。
      expect((await db().query('select email_id from public.list_unnotified_dead_order_emails(50)')).rows).toEqual([{ email_id: dead!.email_id }]);
      expect((await db().query('select email_id from public.list_unnotified_order_email_delivery_problems(50)')).rows).toEqual([{ email_id: sent!.email_id }]);
      expect((await db().query('select * from public.list_unnotified_dead_order_emails($1::integer)', [limit])).rows).toEqual([]);
      expect((await db().query('select * from public.list_unnotified_order_email_delivery_problems($1::integer)', [limit])).rows).toEqual([]);
    });

    test('注文のメールの定期処理の名前を記録できる', async () => {
      await db().query("select public.record_ops_heartbeat('order_email_worker', true)");
      await db().query("select public.record_ops_heartbeat('order_email_delivery_check', false, 'config_api_key')");
      const res = await db().query("select job from public.get_ops_heartbeats() where job like 'order_email%' order by job");
      expect(res.rows.map((row) => row.job)).toEqual(['order_email_delivery_check', 'order_email_worker']);
    });
  });

  describe('片付けと守り', () => {
    test.each([
      'public.claim_order_email(integer)',
      'public.save_order_email_content(uuid, uuid, text, text)',
      'public.complete_order_email(uuid, uuid, text)',
      'public.fail_order_email(uuid, uuid, text, text, integer)',
      'public.skip_order_email(uuid, uuid, text)',
      'public.pause_order_email_sending(text)',
      'public.get_order_email_send_state()',
      'public.request_order_email_resend(uuid, text, uuid)',
      'public.list_order_email_history(uuid)',
      'public.list_order_status_history(uuid)',
      'public.get_order_email_content(uuid, uuid)',
      'public.record_order_email_delivery(text, text, text, timestamptz)',
      'public.list_order_emails_awaiting_delivery(integer)',
      'public.get_order_email_backlog(integer)',
      'public.list_unnotified_dead_order_emails(integer)',
      'public.mark_order_emails_dead_notified(uuid[])',
      'public.list_unnotified_order_email_delivery_problems(integer)',
      'public.mark_order_email_delivery_problems_notified(uuid[])',
    ])('%s の実行権限は service_role だけにある', async (signature) => {
      for (const role of ['anon', 'authenticated', 'service_role']) {
        const privilege = await db().query("select has_function_privilege($1::text, $2::text, 'EXECUTE') as allowed", [role, signature]);
        expect({ role, allowed: privilege.rows[0].allowed }).toEqual({ role, allowed: role === 'service_role' });
      }
    });

    test.each([
      'private.order_email_max_attempts()',
      'private.order_email_retry_delay(integer)',
      'private.enqueue_order_email(uuid, text, text)',
      'private.set_order_email_pause(text)',
      'private.purge_order_email_data()',
    ])('%s の実行権限は anon・authenticated・service_role のどれにも無い', async (signature) => {
      for (const role of ['anon', 'authenticated', 'service_role']) {
        const privilege = await db().query("select has_function_privilege($1::text, $2::text, 'EXECUTE') as allowed", [role, signature]);
        expect({ role, allowed: privilege.rows[0].allowed }).toEqual({ role, allowed: false });
      }
    });

    test('毎日の片付けは、45日を過ぎた送信済みの本文と3日を過ぎた受付済みの番号を消す', async () => {
      const orderId = await createOrder(db(), 'paid');
      await enqueue(db(), orderId, 'paid', 'order_confirmed');
      const claimed = await claim(db());
      await db().query('select public.save_order_email_content($1, $2, $3, $4)', [claimed!.email_id, claimed!.lease_token, '件名', '本文']);
      await complete(db(), claimed!, `re_${uniqueSuffix()}`);
      const recentSvix = `msg_${uniqueSuffix()}`;
      const oldSvix = `msg_${uniqueSuffix()}`;
      await db().query(
        "insert into private.resend_webhook_receipts (svix_id, received_at) values ($1, now()), ($2, now() - interval '4 days')",
        [recentSvix, oldSvix],
      );

      await db().query('select private.purge_order_email_data()');
      expect(await emailRow(db(), claimed!.email_id)).toMatchObject({ subject: '件名' });

      await db().query("update private.order_email_outbox set sent_at = now() - interval '46 days' where id = $1", [claimed!.email_id]);
      await db().query('select private.purge_order_email_data()');

      const row = await emailRow(db(), claimed!.email_id);
      expect(row).toMatchObject({ subject: null, body_text: null, status: 'sent' });
      expect(row.body_erased_at).not.toBeNull();
      const receipts = await db().query('select svix_id from private.resend_webhook_receipts where svix_id = any($1)', [[recentSvix, oldSvix]]);
      expect(receipts.rows).toEqual([{ svix_id: recentSvix }]);
      const job = await db().query("select count(*)::int as count from cron.job where jobname = 'order-email-retention'");
      expect(job.rows[0].count).toBe(1);
    });

    test.each(['anon', 'authenticated', 'service_role'])('%s は3つの表を直接読めない', async (role) => {
      for (const table of ['private.order_email_outbox', 'private.order_email_send_pause', 'private.resend_webhook_receipts']) {
        await db().query('savepoint denied');
        await db().query(`set local role ${role}`);
        await expect(db().query(`select * from ${table}`)).rejects.toMatchObject({ code: '42501' });
        await db().query('rollback to savepoint denied');
      }
    });

    test.each(['anon', 'authenticated'])('%s は関数を呼べない', async (role) => {
      await db().query('savepoint denied');
      await db().query(`set local role ${role}`);
      await expect(db().query('select * from public.claim_order_email(300)')).rejects.toMatchObject({ code: '42501' });
      await db().query('rollback to savepoint denied');
      await db().query('savepoint denied');
      await db().query(`set local role ${role}`);
      await expect(db().query("select public.request_order_email_resend(gen_random_uuid(), 'paid', gen_random_uuid())")).rejects.toMatchObject({ code: '42501' });
      await db().query('rollback to savepoint denied');
    });

    test('service_role は関数を呼べるが、行を書く private の関数は呼べない', async () => {
      const orderId = await createOrder(db(), 'paid');
      await db().query('savepoint service');
      await db().query('set local role service_role');
      await expect(db().query('select * from public.claim_order_email(300)')).resolves.toBeTruthy();
      await expect(db().query("select private.enqueue_order_email($1, 'shipped', null)", [orderId])).rejects.toMatchObject({ code: '42501' });
      await db().query('rollback to savepoint service');
    });
  });
});

describeLocalDb('integration: 注文のメールの同時の取り出し', (db) => {
  let other: PgClient;
  const created: string[] = [];

  beforeAll(async () => {
    other = await connectLocalDb();
  });

  afterAll(async () => {
    try {
      if (created.length > 0) {
        await other.query('delete from private.order_email_outbox where order_id = any($1::uuid[])', [created]);
      }
    } finally {
      await other.end();
    }
  });

  test('2つの worker が同時に取り出しても、同じ行を取らない', async () => {
    // ほかの試験が残した未完了の行に邪魔されないよう、先に片付けてから確定した2行を用意する（使い捨ての手元の DB だけ）
    await db().query(
      `update private.order_email_outbox
       set status = 'skipped', finished_at = now(), lease_token = null, lease_expires_at = null, last_error_code = 'superseded'
       where status in ('pending', 'sending', 'retry_wait')`,
    );
    await db().query('update private.order_email_send_pause set paused = false, reason = null, paused_at = null, next_probe_at = null');
    for (let index = 0; index < 2; index += 1) {
      const orderId = await createOrder(db(), 'paid');
      created.push(orderId);
      await enqueue(db(), orderId, 'paid', 'order_confirmed');
    }

    await db().query('begin');
    await other.query('begin');
    try {
      const first = await claim(db());
      const second = await claim(other);
      expect(first).not.toBeNull();
      expect(second).not.toBeNull();
      expect(second!.email_id).not.toBe(first!.email_id);
    } finally {
      await db().query('rollback');
      await other.query('rollback');
    }
  });

  test('前の行の取り出しが未確定の間は、別の接続も同じ注文の後の行を取り出さない', async () => {
    // ほかの未完了の行を先に片付け、同じ注文の確定した2行だけを対象にする。
    await db().query(
      `update private.order_email_outbox
       set status = 'skipped', finished_at = now(), lease_token = null, lease_expires_at = null, last_error_code = 'superseded'
       where status in ('pending', 'sending', 'retry_wait')`,
    );
    await db().query('update private.order_email_send_pause set paused = false, reason = null, paused_at = null, next_probe_at = null');
    const orderId = await createOrder(db(), 'pending');
    created.push(orderId);
    await enqueue(db(), orderId, 'awaiting_payment');
    await enqueue(db(), orderId, 'paid', 'payment_received');

    await db().query('begin');
    await other.query('begin');
    try {
      const first = await claim(db());
      expect(first).toMatchObject({ order_id: orderId, kind: 'awaiting_payment' });
      expect(await claim(other)).toBeNull();
      const later = await other.query(
        "select status, attempts from private.order_email_outbox where order_id = $1 and kind = 'paid'",
        [orderId],
      );
      expect(later.rows).toEqual([{ status: 'pending', attempts: 0 }]);
    } finally {
      await db().query('rollback');
      await other.query('rollback');
    }
  });
});
