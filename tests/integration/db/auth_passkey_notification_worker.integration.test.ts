/** @jest-environment node */
import { randomUUID } from 'node:crypto';
import { describeLocalDb, type PgClient } from './helpers/local-db';

// Passkey stage 2 Task 9: the notification worker, run against the real DB functions of migration G (claim / recipients /
// complete / fail / skip) with a fake mail sender. DB suite: needs the local Supabase (DATABASE_URL). Every case runs in a
// transaction that is rolled back, so the worker's own claim/complete calls are rolled back with it.
jest.mock('server-only', () => ({}), { virtual: true });

const mockHolder: { db: PgClient | null } = { db: null };
const NAMED_ARGS: Record<string, string[]> = {
  claim_passkey_notification: ['_lease_seconds'],
  complete_passkey_notification: ['_id', '_lease_token'],
  fail_passkey_notification: ['_id', '_lease_token', '_error_code', '_retry_after_seconds'],
  skip_passkey_notification: ['_id', '_lease_token', '_reason'],
  passkey_notification_recipients: ['_id'],
};
const SCALAR_RESULT = new Set(['complete_passkey_notification', 'fail_passkey_notification', 'skip_passkey_notification']);

jest.mock('@/lib/supabase/server', () => ({
  createServiceRoleClient: async () => ({
    // supabase-js の rpc と同じ形（名前つきの引数）で、同じ接続の DB の関数を呼ぶ
    rpc: async (name: string, args: Record<string, unknown>) => {
      const keys = NAMED_ARGS[name];
      const placeholders = keys.map((_key, index) => `$${index + 1}`).join(', ');
      const result = await (mockHolder.db as PgClient).query(`select * from public.${name}(${placeholders})`, keys.map((key) => args[key]));
      // PostgREST は日時を文字列で返す（pg は Date にするので JSON を通して同じ形にする）
      return { data: SCALAR_RESULT.has(name) ? result.rows[0][name] : JSON.parse(JSON.stringify(result.rows)), error: null };
    },
  }),
}));

import { runPasskeyNotificationWorker, type PasskeyNotificationWorkerDeps } from '@/lib/auth/passkey-notification-worker';

describeLocalDb('passkey notification worker with the real DB functions', (db) => {
  beforeEach(async () => {
    mockHolder.db = db();
    await db().query('begin');
    await db().query('delete from private.passkey_notification_outbox');
    await db().query(
      `update public.user_roles set active = false where role_id in (select id from public.roles where code in ('admin', 'supporter'))`,
    );
  });
  afterEach(async () => {
    await db().query('rollback');
    mockHolder.db = null;
  });

  async function user(email: string): Promise<string> {
    const r = await db().query(
      `insert into auth.users (id, email, raw_user_meta_data, created_at, updated_at)
       values (gen_random_uuid(), $1, '{}'::jsonb, now(), now()) returning id::text as id`,
      [email],
    );
    return r.rows[0].id;
  }
  async function role(userId: string, code: 'admin' | 'supporter'): Promise<void> {
    await db().query(
      `insert into public.user_roles (user_id, role_id, active, expires_at)
       select $1, r.id, true, null from public.roles r where r.code = $2`,
      [userId, code],
    );
  }
  async function staffRow(email: string, userId: string): Promise<string> {
    const r = await db().query(
      `insert into private.passkey_notification_outbox (user_id, kind, friendly_name, subject_is_staff, notify_subject, subject_email)
       values ($1, 'passkey_added', 'iPhone', true, true, $2) returning id::text as id`,
      [userId, email],
    );
    return r.rows[0].id;
  }
  const rowOf = async (id: string) => (await db().query('select * from private.passkey_notification_outbox where id = $1', [id])).rows[0];

  function deps(send: jest.Mock): Partial<PasskeyNotificationWorkerDeps> {
    return { send, disabledReason: () => null, checkConfig: () => null, contactUrl: () => 'https://example.com/contact' };
  }

  test('ARC-AUTH-011 a staff row is sent to the subject (staff wording) and to every active admin (admin wording), never to a supporter, and ends as sent', async () => {
    const tag = randomUUID().slice(0, 8);
    const staffEmail = `staff-${tag}@example.com`;
    const adminEmail = `admin-${tag}@example.com`;
    const supporterEmail = `supporter-${tag}@example.com`;
    const staffId = await user(staffEmail);
    await role(staffId, 'admin');
    await role(await user(adminEmail), 'admin');
    await role(await user(supporterEmail), 'supporter');
    const id = await staffRow(staffEmail, staffId);

    const send = jest.fn(async (_message: unknown) => ({ ok: true, providerMessageId: null }));
    const result = await runPasskeyNotificationWorker({ deps: deps(send) });

    expect(result).toMatchObject({ claimed: 1, sent: 1, retried: 0, stopped: 'idle' });
    const messages = send.mock.calls.map((call) => call[0] as { to: string; subject: string; text: string; idempotencyKey: string });
    expect(messages.map((message) => message.to)).toEqual([staffEmail, adminEmail]);
    expect(messages[0].text).toContain('すぐに店長へお知らせください。');
    expect(messages[0].text).not.toContain(staffEmail);
    expect(messages[1].subject).toBe('店員のパスキーが追加されました');
    expect(messages[1].text).toContain(`${staffEmail} のパスキーが追加されました。`);
    expect(new Set(messages.map((message) => message.idempotencyKey)).size).toBe(2);
    expect(messages.every((message) => message.idempotencyKey.startsWith(`passkey-notification/${id}/`))).toBe(true);
    expect((await rowOf(id)).status).toBe('sent');
  });

  test('ARC-AUTH-011 a transient failure for one recipient still tries the others, then puts the row in retry_wait with the first error code', async () => {
    const tag = randomUUID().slice(0, 8);
    const staffEmail = `staff-${tag}@example.com`;
    const staffId = await user(staffEmail);
    await role(staffId, 'admin');
    await role(await user(`admin-${tag}@example.com`), 'admin');
    const id = await staffRow(staffEmail, staffId);

    const send = jest
      .fn()
      .mockResolvedValueOnce({ ok: false, failure: { category: 'transient', code: 'rate_limited', retryAfterSeconds: 120 } })
      .mockResolvedValueOnce({ ok: true, providerMessageId: null });
    const result = await runPasskeyNotificationWorker({ deps: deps(send) });

    expect(send).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ claimed: 1, sent: 0, retried: 1 });
    const row = await rowOf(id);
    expect(row.status).toBe('retry_wait');
    expect(row.last_error_code).toBe('rate_limited');
    expect(row.attempts).toBe(1);
  });

  test('ARC-AUTH-011 a permanent failure skips only that recipient and the row ends as sent; a row with no recipient is skipped', async () => {
    const tag = randomUUID().slice(0, 8);
    const staffEmail = `staff-${tag}@example.com`;
    const staffId = await user(staffEmail);
    await role(staffId, 'admin');
    await role(await user(`admin-${tag}@example.com`), 'admin');
    const sentId = await staffRow(staffEmail, staffId);
    const orphan = await db().query(
      `insert into private.passkey_notification_outbox (user_id, kind, subject_is_staff, notify_subject, subject_email)
       values (gen_random_uuid(), 'passkey_removed', false, false, null) returning id::text as id`,
    );

    const send = jest
      .fn()
      .mockResolvedValueOnce({ ok: false, failure: { category: 'permanent', code: 'invalid_message', retryAfterSeconds: null } })
      .mockResolvedValueOnce({ ok: true, providerMessageId: null });
    const result = await runPasskeyNotificationWorker({ deps: deps(send) });

    expect(result).toMatchObject({ claimed: 2, sent: 1, skipped: 1, retried: 0 });
    expect((await rowOf(sentId)).status).toBe('sent');
    expect((await rowOf(orphan.rows[0].id)).status).toBe('skipped');
  });
});
