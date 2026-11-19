/**
 * FR-LOGIN-077 パスキーの知らせの行が dead になると、店の知らせの宛先に1通だけ届く。アドレスは入らず、続けて動かしても2通目は出ない
 * 対応: FR-AUTH-049-AC-02（設計: DD-AUTH-089。ADR-0474）
 *
 * 送り箱（private.passkey_notification_outbox）は全体で1つで、点検は全体の dead の行をまとめて1通にするので、
 * FR-LOGIN-062・071 と同じ serial の `isolated-global` で流す。先に手元の DB だけで、
 * 未送信の行を取り下げ、すでにある dead の行を知らせ済みにし、冷却の行（ops_alert_state の passkey_notification_dead）を消す。
 * 毎分の定期処理（POST /api/cron/process-stripe-webhooks）を叩き直して、届くまで待つ（sleep で決めない）。
 * メールは手元の Mailpit だけ（宛先は E2E の SHOP_ALERT_EMAIL）。終わりに、この試験の行と冷却の行を消す。
 */
import { expect, test } from '@playwright/test';
import { mailsTo, runWorkerOnce, runWorkerUntil, withLocalDb } from './order-email-test-utils';

test.use({ trace: 'off' });

const SUBJECT = 'パスキーの知らせが届きませんでした';
const SEED_ADDRESS = 'dead-seed-subject@example.com';

const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
] as const;

function shopAlertEmail(): string {
  const value = process.env.SHOP_ALERT_EMAIL;
  if (!value) throw new Error('SHOP_ALERT_EMAIL が無い');
  return value;
}

async function resetState(): Promise<void> {
  await withLocalDb(async (db) => {
    await db.query(
      `update private.passkey_notification_outbox
          set status = 'skipped', finished_at = now(), last_error_code = 'e2e_skipped', lease_token = null, lease_expires_at = null
        where status in ('pending', 'retry_wait', 'sending')`,
    );
    await db.query(`update private.passkey_notification_outbox set dead_notified_at = now() where status = 'dead' and dead_notified_at is null`);
    await db.query(`delete from public.ops_alert_state where alert_key = 'passkey_notification_dead'`);
  });
}

async function seedDeadRow(): Promise<string> {
  return withLocalDb(async (db) => {
    const result = await db.query(
      `insert into private.passkey_notification_outbox
         (user_id, kind, subject_is_staff, notify_subject, subject_email, status, attempts, last_error_code, finished_at)
       values (gen_random_uuid(), 'staff_invited', false, false, $1, 'dead', 9, 'resend_rejected', now())
       returning id::text as id`,
      [SEED_ADDRESS],
    );
    return result.rows[0].id as string;
  });
}

async function cleanup(rowId: string | null): Promise<void> {
  await withLocalDb(async (db) => {
    if (rowId) await db.query('delete from private.passkey_notification_outbox where id = $1::uuid', [rowId]);
    await db.query(`delete from public.ops_alert_state where alert_key = 'passkey_notification_dead'`);
  });
}

for (const viewport of viewports) {
  test.describe(`FR-LOGIN-077 passkey dead notification alert (${viewport.name})`, () => {
    let seeded: string | null = null;

    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    test.afterEach(async () => {
      const rowId = seeded;
      seeded = null;
      await cleanup(rowId);
    });

    test(`FR-AUTH-049-AC-02 ${viewport.name}: dead の行が1つあると、店へ1通だけ届き、アドレスは入らず、続けて動かしても2通目は出ない`, async ({ request }) => {
      test.setTimeout(180_000);
      await resetState();
      const shop = shopAlertEmail();
      // 一覧は50件までなので、件数でなく、見えている届いたメールの ID の集合で比べる（新しいメールは一覧の先頭に出る）
      const alertIds = async () => new Set((await mailsTo(request, shop)).filter((message) => message.Subject === SUBJECT).map((message) => message.ID));
      const known = await alertIds();
      const newIds = async () => [...(await alertIds())].filter((id) => !known.has(id));

      seeded = await seedDeadRow();
      await runWorkerUntil(request, async () => (await newIds()).length >= 1, 'dead の知らせが店に届くこと');
      const arrived = await newIds();
      expect(arrived).toHaveLength(1);

      const response = await request.get(new URL(`/api/v1/message/${encodeURIComponent(arrived[0])}`, process.env.MAIL_LOCAL_URL).toString(), { timeout: 5_000 });
      expect(response.ok()).toBe(true);
      const latest = { Text: ((await response.json()) as { Text: string }).Text.replace(/\r/g, '') };
      expect(latest.Text).toContain('1件の知らせが、再試行の上限を越えて届きませんでした。種類・失敗の理由・時刻は次のとおりです。');
      expect(latest.Text).toContain('店員の招待／resend_rejected／');
      expect(latest.Text).not.toContain('@');
      expect(latest.Text).not.toContain(SEED_ADDRESS);

      // 続けて点検が動いても、印が付いているので2通目は出ない（冷却の1時間も効く）。動かした後の件数で確かめる
      for (let run = 0; run < 3; run += 1) await runWorkerOnce(request);
      expect(await newIds()).toEqual(arrived);

      const marked = await withLocalDb(async (db) => (await db.query(
        'select dead_notified_at is not null as marked from private.passkey_notification_outbox where id = $1::uuid', [seeded],
      )).rows[0].marked as boolean);
      expect(marked).toBe(true);
    });
  });
}
