/** @jest-environment node */
import { randomUUID } from 'node:crypto';
import { describeLocalDb } from '../helpers/local-db';

/**
 * 問い合わせの状態 open・pending・answered・closed の値と行き来（STATE-ADMIN-001）。
 * 手元の使い捨て DB でだけ流す。各試験は取引の中で動かし、最後に巻き戻して足した行を残さない。
 * 状態の変更の窓口（API-ADMIN-007）と返信の窓口（API-ADMIN-008）が表に流す更新の文を、そのまま表へ流して確かめる。
 */
const STATES = ['open', 'pending', 'answered', 'closed'];
const TRANSITIONS = STATES.flatMap((from) => STATES.map((to) => [from, to]));

describeLocalDb('integration: 問い合わせの状態', (db) => {
  let marker: string;

  beforeEach(async () => {
    await db().query('begin');
    marker = `integration-admin-contact-state-${randomUUID()}`;
  });
  afterEach(async () => {
    await db().query('rollback');
  });

  async function insertInquiry(status?: string): Promise<string> {
    const result = await db().query(
      `insert into public.contact_inquiries (name, email, inquiry_type, subject, message, status)
       values ($1, 'integration@example.invalid', 'other', $2, 'integration message', coalesce($3::text, 'open'))
       returning id::text as id`,
      [marker, `${marker} ${status ?? 'default'}`, status ?? null],
    );
    return result.rows[0].id;
  }

  async function inquiry(id: string): Promise<{ status: string; updated_at: Date; last_message_at: Date; subject: string } | undefined> {
    const result = await db().query(
      'select status, updated_at, last_message_at, subject from public.contact_inquiries where id = $1', [id],
    );
    return result.rows[0];
  }

  /** 状態の変更の窓口が流す更新と同じ形。 */
  async function changeStatus(id: string, status: string, updatedAt = new Date().toISOString()): Promise<number> {
    return (await db().query(
      'update public.contact_inquiries set status = $2, updated_at = $3 where id = $1', [id, status, updatedAt],
    )).rowCount;
  }

  /** 返信の窓口が流す、メッセージの追加と状態の更新と同じ形。 */
  async function reply(id: string, nowIso: string): Promise<number> {
    await db().query(
      `insert into public.contact_messages (inquiry_id, sender_role, body, channel) values ($1, 'admin', 'reply', 'web')`,
      [id],
    );
    return (await db().query(
      `update public.contact_inquiries set status = 'answered', last_message_at = $2, updated_at = $2 where id = $1`,
      [id, nowIso],
    )).rowCount;
  }

  /** 失敗が取引全体を壊さないよう、savepoint の中で流して SQLSTATE と制約名を返す。 */
  async function failure(sql: string, params: unknown[] = []): Promise<{ code?: string; constraint?: string }> {
    await db().query('savepoint expected_failure');
    try {
      await db().query(sql, params);
      return {};
    } catch (caught) {
      const error = caught as { code?: string; constraint?: string };
      return { code: error.code, constraint: error.constraint };
    } finally {
      await db().query('rollback to savepoint expected_failure');
    }
  }

  test('STATE-ADMIN-001 状態の CHECK は open・pending・answered・closed の4つだけを許す', async () => {
    const result = await db().query(
      `select pg_get_constraintdef(oid) as definition from pg_constraint
       where conrelid = 'public.contact_inquiries'::regclass and conname = 'contact_inquiries_status_check'`,
    );

    expect(result.rows).toHaveLength(1);
    const allowed = [...(result.rows[0].definition as string).matchAll(/'([^']*)'::text/g)].map((match) => match[1]);
    expect(allowed.sort()).toEqual([...STATES].sort());
  });

  test.each(STATES)('STATE-ADMIN-001 作成で %s を入れられる', async (status) => {
    const id = await insertInquiry(status);

    expect((await inquiry(id))?.status).toBe(status);
  });

  test.each(['resolved', 'OPEN', 'Closed', 'archived', ''])('STATE-ADMIN-001 状態 "%s" の作成は CHECK の違反で落ちる', async (status) => {
    const result = await failure(
      `insert into public.contact_inquiries (name, email, inquiry_type, subject, message, status)
       values ($1, 'a@example.invalid', 'other', 's', 'm', $2)`,
      [marker, status],
    );

    expect(result).toEqual({ code: '23514', constraint: 'contact_inquiries_status_check' });
  });

  test('STATE-ADMIN-001 DB の初めの値は open で、状態を省いた作成は open の問い合わせになる', async () => {
    const defaults = await db().query(
      `select column_default from information_schema.columns
       where table_schema = 'public' and table_name = 'contact_inquiries' and column_name = 'status'`,
    );
    expect(defaults.rows).toEqual([{ column_default: "'open'::text" }]);

    const inserted = await db().query(
      `insert into public.contact_inquiries (name, email, inquiry_type, subject, message)
       values ($1, 'a@example.invalid', 'product', 's', 'm') returning status`,
      [marker],
    );

    expect(inserted.rows).toEqual([{ status: 'open' }]);
  });

  test.each(TRANSITIONS)('STATE-ADMIN-001 %s から %s への変更は1行の更新として通る（組み合わせの決まりは表に無い）', async (from, to) => {
    const id = await insertInquiry(from);

    expect(await changeStatus(id, to)).toBe(1);

    expect((await inquiry(id))?.status).toBe(to);
  });

  test.each(STATES)('STATE-ADMIN-001 %s から CHECK に無い値へは変えられず、状態は元のまま', async (from) => {
    const id = await insertInquiry(from);

    const result = await failure("update public.contact_inquiries set status = 'resolved' where id = $1", [id]);

    expect(result).toEqual({ code: '23514', constraint: 'contact_inquiries_status_check' });
    expect((await inquiry(id))?.status).toBe(from);
  });

  test('STATE-ADMIN-001 状態の変更は updated_at だけを動かし、last_message_at と他の列は変えない', async () => {
    const id = await insertInquiry('open');
    await db().query(
      `update public.contact_inquiries
       set updated_at = '2020-01-01T00:00:00Z', last_message_at = '2020-01-02T00:00:00Z' where id = $1`,
      [id],
    );
    const before = await inquiry(id);

    await changeStatus(id, 'closed', '2026-10-24T00:00:00Z');

    const after = await inquiry(id);
    expect(after?.status).toBe('closed');
    expect(after?.updated_at.toISOString()).toBe('2026-10-24T00:00:00.000Z');
    expect(after?.last_message_at).toEqual(before?.last_message_at);
    expect(after?.subject).toBe(before?.subject);
  });

  test.each(STATES)('STATE-ADMIN-001 %s の問い合わせに返信すると answered になり、最後のやり取りの時刻が進む', async (from) => {
    const id = await insertInquiry(from);
    await db().query(
      `update public.contact_inquiries set last_message_at = '2020-01-01T00:00:00Z' where id = $1`, [id],
    );

    expect(await reply(id, '2026-10-24T09:00:00Z')).toBe(1);

    const after = await inquiry(id);
    expect(after?.status).toBe('answered');
    expect(after?.last_message_at.toISOString()).toBe('2026-10-24T09:00:00.000Z');
    expect(after?.updated_at.toISOString()).toBe('2026-10-24T09:00:00.000Z');
    const messages = await db().query(
      `select sender_role, channel from public.contact_messages where inquiry_id = $1`, [id],
    );
    expect(messages.rows).toEqual([{ sender_role: 'admin', channel: 'web' }]);
  });

  test('STATE-ADMIN-001 answered に返信しても answered のまま、closed に返信しても開き直す印は付かない', async () => {
    const answered = await insertInquiry('answered');
    const closed = await insertInquiry('closed');

    await reply(answered, '2026-10-24T09:00:00Z');
    await reply(closed, '2026-10-24T09:00:00Z');

    expect((await inquiry(answered))?.status).toBe('answered');
    expect((await inquiry(closed))?.status).toBe('answered');
  });

  test.each(STATES)('STATE-ADMIN-001 %s の問い合わせにお客様のメッセージが付いても、表は状態も時刻も自動では変えない', async (from) => {
    const id = await insertInquiry(from);
    const before = await inquiry(id);

    await db().query(
      `insert into public.contact_messages (inquiry_id, sender_role, body, channel, inbound_provider_id)
       values ($1, 'user', 'customer reply', 'email', $2)`,
      [id, `${marker}-${from}`],
    );

    expect(await inquiry(id)).toEqual(before);
  });

  test('STATE-ADMIN-001 状態で絞ると、その状態の問い合わせだけが最後のやり取りの新しい順に返る', async () => {
    const older = await insertInquiry('pending');
    const newer = await insertInquiry('pending');
    const other = await insertInquiry('closed');
    await db().query(
      `update public.contact_inquiries set last_message_at = '2020-01-01T00:00:00Z' where id = $1`, [older],
    );
    await db().query(
      `update public.contact_inquiries set last_message_at = '2021-01-01T00:00:00Z' where id = $1`, [newer],
    );

    const filtered = await db().query(
      `select id::text as id from public.contact_inquiries where name = $1 and status = $2 order by last_message_at desc`,
      [marker, 'pending'],
    );

    expect(filtered.rows.map((row) => row.id)).toEqual([newer, older]);
    expect(filtered.rows.map((row) => row.id)).not.toContain(other);
  });

  test('STATE-ADMIN-001 無い id の状態の変更は0行で、エラーにならない', async () => {
    expect(await changeStatus(randomUUID(), 'closed')).toBe(0);
  });

  test.each(STATES)('STATE-ADMIN-001 %s の問い合わせも削除で行が消え、消した問い合わせは更新の対象にもならない', async (status) => {
    const id = await insertInquiry(status);

    const deleted = await db().query('delete from public.contact_inquiries where id = $1', [id]);

    expect(deleted.rowCount).toBe(1);
    expect(await inquiry(id)).toBeUndefined();
    expect(await changeStatus(id, 'open')).toBe(0);
  });
});
