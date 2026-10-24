/** @jest-environment node */
import { randomUUID } from 'node:crypto';
import { describeLocalDb } from '../helpers/local-db';

/**
 * 問い合わせの3つの表 contact_inquiries・contact_messages・contact_reply_templates の形（DATA-ADMIN-001）。
 * 手元の使い捨て DB でだけ流す。各試験は取引の中で動かし、最後に巻き戻して足した行を残さない。
 */
type ColumnShape = { type: string; nullable: boolean; default: string | null };

const TIMESTAMPTZ = 'timestamp with time zone';

const EXPECTED_COLUMNS: Record<string, Record<string, ColumnShape>> = {
  contact_inquiries: {
    id: { type: 'uuid', nullable: false, default: 'gen_random_uuid()' },
    created_at: { type: TIMESTAMPTZ, nullable: false, default: 'now()' },
    name: { type: 'text', nullable: false, default: null },
    email: { type: 'text', nullable: false, default: null },
    inquiry_type: { type: 'text', nullable: false, default: null },
    subject: { type: 'text', nullable: false, default: null },
    message: { type: 'text', nullable: false, default: null },
    submitted_ip: { type: 'text', nullable: true, default: null },
    user_agent: { type: 'text', nullable: true, default: null },
    status: { type: 'text', nullable: false, default: "'open'::text" },
    user_id: { type: 'uuid', nullable: true, default: null },
    order_id: { type: 'uuid', nullable: true, default: null },
    updated_at: { type: TIMESTAMPTZ, nullable: false, default: 'now()' },
    last_message_at: { type: TIMESTAMPTZ, nullable: false, default: 'now()' },
  },
  contact_messages: {
    id: { type: 'uuid', nullable: false, default: 'gen_random_uuid()' },
    inquiry_id: { type: 'uuid', nullable: false, default: null },
    sender_role: { type: 'text', nullable: false, default: null },
    author_id: { type: 'uuid', nullable: true, default: null },
    body: { type: 'text', nullable: false, default: null },
    channel: { type: 'text', nullable: false, default: "'web'::text" },
    inbound_provider_id: { type: 'text', nullable: true, default: null },
    created_at: { type: TIMESTAMPTZ, nullable: false, default: 'now()' },
  },
  contact_reply_templates: {
    id: { type: 'uuid', nullable: false, default: 'gen_random_uuid()' },
    title: { type: 'text', nullable: false, default: null },
    category: { type: 'text', nullable: true, default: null },
    body: { type: 'text', nullable: false, default: null },
    sort_order: { type: 'integer', nullable: false, default: '0' },
    created_at: { type: TIMESTAMPTZ, nullable: false, default: 'now()' },
    updated_at: { type: TIMESTAMPTZ, nullable: false, default: 'now()' },
  },
};

const EXPECTED_CHECKS: Record<string, string[]> = {
  contact_inquiries: ['contact_inquiries_inquiry_type_check', 'contact_inquiries_status_check'],
  contact_messages: ['contact_messages_channel_check', 'contact_messages_sender_role_check'],
  contact_reply_templates: ['contact_reply_templates_category_check'],
};

const EXPECTED_INDEXES: Record<string, string[]> = {
  contact_inquiries: [
    'contact_inquiries_created_at_idx',
    'contact_inquiries_email_idx',
    'contact_inquiries_last_message_at_idx',
    'contact_inquiries_pkey',
    'contact_inquiries_status_idx',
    'contact_inquiries_user_id_idx',
  ],
  contact_messages: [
    'contact_messages_inbound_provider_id_key',
    'contact_messages_inquiry_created_idx',
    'contact_messages_pkey',
  ],
  contact_reply_templates: [
    'contact_reply_templates_category_idx',
    'contact_reply_templates_pkey',
    'contact_reply_templates_sort_order_idx',
  ],
};

const TABLES = Object.keys(EXPECTED_COLUMNS);

describeLocalDb('integration: 問い合わせの表の形', (db) => {
  let marker: string;

  beforeEach(async () => {
    await db().query('begin');
    marker = `integration-admin-contact-${randomUUID()}`;
  });
  afterEach(async () => {
    await db().query('rollback');
  });

  async function insertInquiry(overrides: Partial<Record<'inquiry_type' | 'status', string>> = {}): Promise<string> {
    const result = await db().query(
      `insert into public.contact_inquiries (name, email, inquiry_type, subject, message, status)
       values ($1, 'integration@example.invalid', $2, $3, 'integration message', coalesce($4::text, 'open'))
       returning id::text as id`,
      [marker, overrides.inquiry_type ?? 'other', `${marker} subject`, overrides.status ?? null],
    );
    return result.rows[0].id;
  }

  async function insertMessage(inquiryId: string, inboundProviderId: string | null = null): Promise<string> {
    const result = await db().query(
      `insert into public.contact_messages (inquiry_id, sender_role, body, inbound_provider_id)
       values ($1, 'user', 'integration body', $2) returning id::text as id`,
      [inquiryId, inboundProviderId],
    );
    return result.rows[0].id;
  }

  /** 失敗が取引全体を壊さないよう、savepoint の中で流して SQLSTATE と制約名を返す。 */
  async function failure(sql: string, params: unknown[] = []): Promise<{ code?: string; constraint?: string; column?: string }> {
    await db().query('savepoint expected_failure');
    try {
      await db().query(sql, params);
      return {};
    } catch (caught) {
      const error = caught as { code?: string; constraint?: string; column?: string };
      return { code: error.code, constraint: error.constraint, column: error.column };
    } finally {
      await db().query('rollback to savepoint expected_failure');
    }
  }

  async function count(table: string, where: string, params: unknown[]): Promise<number> {
    const result = await db().query(`select count(*)::int as count from public.${table} where ${where}`, params);
    return result.rows[0].count;
  }

  function allowedValues(definition: string): string[] {
    return [...definition.matchAll(/'([^']*)'::text/g)].map((match) => match[1]).sort();
  }

  async function checkDefinition(table: string, name: string): Promise<string> {
    const result = await db().query(
      `select pg_get_constraintdef(oid) as definition from pg_constraint
       where conrelid = $1::regclass and conname = $2 and contype = 'c'`,
      [`public.${table}`, name],
    );
    expect(result.rows).toHaveLength(1);
    return result.rows[0].definition;
  }

  test.each(TABLES)('DATA-ADMIN-001 %s は public にあり、RLS が有効になっている', async (table) => {
    const result = await db().query(
      'select relkind, relrowsecurity from pg_class where oid = $1::regclass', [`public.${table}`],
    );

    expect(result.rows).toEqual([{ relkind: 'r', relrowsecurity: true }]);
  });

  test.each(TABLES)('DATA-ADMIN-001 %s の列は設計の名前・型・NULL可否・初めの値と一致し、余分な列が無い', async (table) => {
    const result = await db().query(
      `select column_name, data_type, is_nullable, column_default
       from information_schema.columns where table_schema = 'public' and table_name = $1`,
      [table],
    );

    const actual = Object.fromEntries(
      result.rows.map((row) => [
        row.column_name,
        { type: row.data_type, nullable: row.is_nullable === 'YES', default: row.column_default },
      ]),
    );
    expect(actual).toEqual(EXPECTED_COLUMNS[table]);
  });

  test.each(TABLES)('DATA-ADMIN-001 %s の CHECK は設計の物だけで、主キーは id', async (table) => {
    const checks = await db().query(
      `select conname from pg_constraint where conrelid = $1::regclass and contype = 'c' order by conname`,
      [`public.${table}`],
    );
    const primary = await db().query(
      `select a.attname from pg_constraint c
       join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
       where c.conrelid = $1::regclass and c.contype = 'p'`,
      [`public.${table}`],
    );

    expect(checks.rows.map((row) => row.conname)).toEqual(EXPECTED_CHECKS[table]);
    expect(primary.rows).toEqual([{ attname: 'id' }]);
  });

  test.each(TABLES)('DATA-ADMIN-001 %s の索引は設計の物と一致する', async (table) => {
    const result = await db().query(
      `select indexname from pg_indexes where schemaname = 'public' and tablename = $1 order by indexname`,
      [table],
    );

    expect(result.rows.map((row) => row.indexname)).toEqual(EXPECTED_INDEXES[table]);
  });

  test('DATA-ADMIN-001 状態の CHECK は open・pending・answered・closed の4つだけを許す', async () => {
    expect(allowedValues(await checkDefinition('contact_inquiries', 'contact_inquiries_status_check')))
      .toEqual(['answered', 'closed', 'open', 'pending']);
  });

  test('DATA-ADMIN-001 種別の CHECK は product・order・other の3つだけを許す', async () => {
    expect(allowedValues(await checkDefinition('contact_inquiries', 'contact_inquiries_inquiry_type_check')))
      .toEqual(['order', 'other', 'product']);
  });

  test('DATA-ADMIN-001 送り手の役の CHECK は user・admin の2つ、経路の CHECK は web・email の2つだけを許す', async () => {
    expect(allowedValues(await checkDefinition('contact_messages', 'contact_messages_sender_role_check')))
      .toEqual(['admin', 'user']);
    expect(allowedValues(await checkDefinition('contact_messages', 'contact_messages_channel_check')))
      .toEqual(['email', 'web']);
  });

  test('DATA-ADMIN-001 テンプレートの分類の CHECK は product・order・other・general の4つだけを許す', async () => {
    expect(allowedValues(await checkDefinition('contact_reply_templates', 'contact_reply_templates_category_check')))
      .toEqual(['general', 'order', 'other', 'product']);
  });

  test.each(['product', 'order', 'other'])('DATA-ADMIN-001 種別 %s の問い合わせを作れる', async (inquiryType) => {
    const id = await insertInquiry({ inquiry_type: inquiryType });

    expect(await count('contact_inquiries', 'id = $1 and inquiry_type = $2', [id, inquiryType])).toBe(1);
  });

  test.each(['Product', 'inquiry', 'general', ''])('DATA-ADMIN-001 種別 "%s" の作成は CHECK の違反で落ちる', async (inquiryType) => {
    const result = await failure(
      `insert into public.contact_inquiries (name, email, inquiry_type, subject, message)
       values ($1, 'a@example.invalid', $2, 's', 'm')`,
      [marker, inquiryType],
    );

    expect(result).toMatchObject({ code: '23514', constraint: 'contact_inquiries_inquiry_type_check' });
  });

  test.each(['open', 'pending', 'answered', 'closed'])('DATA-ADMIN-001 状態 %s の問い合わせを作れる', async (status) => {
    const id = await insertInquiry({ status });

    expect(await count('contact_inquiries', 'id = $1 and status = $2', [id, status])).toBe(1);
  });

  test.each(['OPEN', 'resolved', 'done', ''])('DATA-ADMIN-001 状態 "%s" の作成は CHECK の違反で落ちる', async (status) => {
    const result = await failure(
      `insert into public.contact_inquiries (name, email, inquiry_type, subject, message, status)
       values ($1, 'a@example.invalid', 'other', 's', 'm', $2)`,
      [marker, status],
    );

    expect(result).toMatchObject({ code: '23514', constraint: 'contact_inquiries_status_check' });
  });

  test('DATA-ADMIN-001 状態と時刻を省いて作ると、状態は open で3つの時刻は今になる', async () => {
    const result = await db().query(
      `insert into public.contact_inquiries (name, email, inquiry_type, subject, message)
       values ($1, 'a@example.invalid', 'order', 's', 'm')
       returning status, created_at, updated_at, last_message_at, now() as now, user_id, order_id, submitted_ip, user_agent`,
      [marker],
    );

    const row = result.rows[0];
    expect(row.status).toBe('open');
    for (const column of ['created_at', 'updated_at', 'last_message_at']) {
      expect((row[column] as Date).toISOString()).toBe((row.now as Date).toISOString());
    }
    expect([row.user_id, row.order_id, row.submitted_ip, row.user_agent]).toEqual([null, null, null, null]);
  });

  test.each(['name', 'email', 'inquiry_type', 'subject', 'message', 'status'])(
    'DATA-ADMIN-001 問い合わせの %s を NULL にした作成は NOT NULL の違反で落ちる',
    async (column) => {
      const values: Record<string, string | null> = {
        name: marker, email: 'a@example.invalid', inquiry_type: 'other', subject: 's', message: 'm', status: 'open',
      };
      values[column] = null;

      const result = await failure(
        `insert into public.contact_inquiries (name, email, inquiry_type, subject, message, status)
         values ($1, $2, $3, $4, $5, $6)`,
        [values.name, values.email, values.inquiry_type, values.subject, values.message, values.status],
      );

      expect(result).toMatchObject({ code: '23502', column });
    },
  );

  test.each(['user', 'admin'])('DATA-ADMIN-001 送り手の役 %s のメッセージを作れる', async (senderRole) => {
    const inquiryId = await insertInquiry();

    const result = await db().query(
      `insert into public.contact_messages (inquiry_id, sender_role, body) values ($1, $2, 'b') returning id::text as id`,
      [inquiryId, senderRole],
    );

    expect(await count('contact_messages', 'id = $1 and sender_role = $2', [result.rows[0].id, senderRole])).toBe(1);
  });

  test.each(['customer', 'staff', 'User', ''])('DATA-ADMIN-001 送り手の役 "%s" のメッセージは CHECK の違反で落ちる', async (senderRole) => {
    const inquiryId = await insertInquiry();

    const result = await failure(
      `insert into public.contact_messages (inquiry_id, sender_role, body) values ($1, $2, 'b')`,
      [inquiryId, senderRole],
    );

    expect(result).toMatchObject({ code: '23514', constraint: 'contact_messages_sender_role_check' });
  });

  test('DATA-ADMIN-001 経路を省いたメッセージは web になり、email も作れて、ほかの値は CHECK の違反で落ちる', async () => {
    const inquiryId = await insertInquiry();
    const byDefault = await insertMessage(inquiryId);
    const byEmail = await db().query(
      `insert into public.contact_messages (inquiry_id, sender_role, body, channel) values ($1, 'user', 'b', 'email') returning id::text as id`,
      [inquiryId],
    );

    expect(await count('contact_messages', "id = $1 and channel = 'web'", [byDefault])).toBe(1);
    expect(await count('contact_messages', "id = $1 and channel = 'email'", [byEmail.rows[0].id])).toBe(1);
    const invalid = await failure(
      `insert into public.contact_messages (inquiry_id, sender_role, body, channel) values ($1, 'user', 'b', 'sms')`,
      [inquiryId],
    );
    expect(invalid).toMatchObject({ code: '23514', constraint: 'contact_messages_channel_check' });
  });

  test.each(['inquiry_id', 'sender_role', 'body'])(
    'DATA-ADMIN-001 メッセージの %s を NULL にした作成は NOT NULL の違反で落ちる',
    async (column) => {
      const inquiryId = await insertInquiry();
      const values: Record<string, string | null> = { inquiry_id: inquiryId, sender_role: 'user', body: 'b' };
      values[column] = null;

      const result = await failure(
        'insert into public.contact_messages (inquiry_id, sender_role, body) values ($1, $2, $3)',
        [values.inquiry_id, values.sender_role, values.body],
      );

      expect(result).toMatchObject({ code: '23502', column });
    },
  );

  test('DATA-ADMIN-001 受信の送り手の id は一意で、同じ値の2回目は落ち、NULL は何件でも入る', async () => {
    const inquiryId = await insertInquiry();
    const providerId = `${marker}-provider`;
    await insertMessage(inquiryId, providerId);

    const duplicate = await failure(
      `insert into public.contact_messages (inquiry_id, sender_role, body, inbound_provider_id) values ($1, 'user', 'b', $2)`,
      [inquiryId, providerId],
    );
    await insertMessage(inquiryId, null);
    await insertMessage(inquiryId, null);

    expect(duplicate).toMatchObject({ code: '23505', constraint: 'contact_messages_inbound_provider_id_key' });
    expect(await count('contact_messages', 'inquiry_id = $1 and inbound_provider_id is null', [inquiryId])).toBe(2);
    expect(await count('contact_messages', 'inbound_provider_id = $1', [providerId])).toBe(1);
  });

  test('DATA-ADMIN-001 存在しない問い合わせへのメッセージは外部キーの違反で落ちる', async () => {
    const result = await failure(
      `insert into public.contact_messages (inquiry_id, sender_role, body) values ($1, 'user', 'b')`,
      [randomUUID()],
    );

    expect(result).toMatchObject({ code: '23503', constraint: 'contact_messages_inquiry_id_fkey' });
  });

  test('DATA-ADMIN-001 問い合わせを消すと、そのメッセージだけが一緒に消える', async () => {
    const target = await insertInquiry();
    const other = await insertInquiry();
    await insertMessage(target);
    await insertMessage(target);
    await insertMessage(other);

    const deleted = await db().query('delete from public.contact_inquiries where id = $1', [target]);

    expect(deleted.rowCount).toBe(1);
    expect(await count('contact_messages', 'inquiry_id = $1', [target])).toBe(0);
    expect(await count('contact_messages', 'inquiry_id = $1', [other])).toBe(1);
  });

  test('DATA-ADMIN-001 問い合わせの注文の id は orders への外部キーで、注文を消すと空になる設定', async () => {
    const result = await db().query(
      `select confrelid = 'public.orders'::regclass as target_is_orders, confdeltype, confupdtype,
              (select attname from pg_attribute where attrelid = conrelid and attnum = conkey[1]) as column_name
       from pg_constraint
       where conrelid = 'public.contact_inquiries'::regclass and conname = 'contact_inquiries_order_id_fkey'`,
    );

    // confdeltype: n = SET NULL
    expect(result.rows).toEqual([
      { target_is_orders: true, confdeltype: 'n', confupdtype: 'a', column_name: 'order_id' },
    ]);
  });

  test('DATA-ADMIN-001 存在しない注文を結んだ問い合わせは外部キーの違反で落ち、注文を結ばない作成は通る', async () => {
    const orphan = await failure(
      `insert into public.contact_inquiries (name, email, inquiry_type, subject, message, order_id)
       values ($1, 'a@example.invalid', 'order', 's', 'm', $2)`,
      [marker, randomUUID()],
    );
    const id = await insertInquiry();

    expect(orphan).toMatchObject({ code: '23503', constraint: 'contact_inquiries_order_id_fkey' });
    expect(await count('contact_inquiries', 'id = $1 and order_id is null', [id])).toBe(1);
  });

  test('DATA-ADMIN-001 会員の id には外部キーが無く、どの会員でもない id でも問い合わせを作れる', async () => {
    const foreignKeys = await db().query(
      `select conname from pg_constraint where conrelid = 'public.contact_inquiries'::regclass and contype = 'f'`,
    );
    const id = await db().query(
      `insert into public.contact_inquiries (name, email, inquiry_type, subject, message, user_id)
       values ($1, 'a@example.invalid', 'other', 's', 'm', $2) returning id::text as id`,
      [marker, randomUUID()],
    );

    expect(foreignKeys.rows.map((row) => row.conname)).toEqual(['contact_inquiries_order_id_fkey']);
    expect(await count('contact_inquiries', 'id = $1 and user_id is not null', [id.rows[0].id])).toBe(1);
  });

  test('DATA-ADMIN-001 テンプレートは分類を省くと NULL、並び順を省くと 0 で作れ、4つの分類も通る', async () => {
    const result = await db().query(
      `insert into public.contact_reply_templates (title, body) values ($1, 'b') returning category, sort_order`,
      [marker],
    );
    expect(result.rows).toEqual([{ category: null, sort_order: 0 }]);

    for (const category of ['product', 'order', 'other', 'general']) {
      const inserted = await db().query(
        `insert into public.contact_reply_templates (title, body, category) values ($1, 'b', $2) returning category`,
        [marker, category],
      );
      expect(inserted.rows).toEqual([{ category }]);
    }
  });

  test.each(['shipping', 'General', ''])('DATA-ADMIN-001 テンプレートの分類 "%s" は CHECK の違反で落ちる', async (category) => {
    const result = await failure(
      `insert into public.contact_reply_templates (title, body, category) values ($1, 'b', $2)`,
      [marker, category],
    );

    expect(result).toMatchObject({ code: '23514', constraint: 'contact_reply_templates_category_check' });
  });

  test.each(['title', 'body', 'sort_order'])(
    'DATA-ADMIN-001 テンプレートの %s を NULL にした作成は NOT NULL の違反で落ちる',
    async (column) => {
      const values: Record<string, string | number | null> = { title: marker, body: 'b', sort_order: 1 };
      values[column] = null;

      const result = await failure(
        'insert into public.contact_reply_templates (title, body, sort_order) values ($1, $2, $3)',
        [values.title, values.body, values.sort_order],
      );

      expect(result).toMatchObject({ code: '23502', column });
    },
  );

  test('DATA-ADMIN-001 長さの上限は表に無く、返信 5000 字・題 120 字を超える値も表では通る', async () => {
    const inquiryId = await insertInquiry();

    const longMessage = await db().query(
      `insert into public.contact_messages (inquiry_id, sender_role, body) values ($1, 'admin', $2) returning length(body) as length`,
      [inquiryId, 'あ'.repeat(5001)],
    );
    const longTitle = await db().query(
      `insert into public.contact_reply_templates (title, body) values ($1, 'b') returning length(title) as length`,
      ['題'.repeat(121)],
    );

    expect(longMessage.rows).toEqual([{ length: 5001 }]);
    expect(longTitle.rows).toEqual([{ length: 121 }]);
  });

  test.each(TABLES)('DATA-ADMIN-001 %s には利用者の定義したトリガーが無い', async (table) => {
    const triggers = await db().query(
      `select tgname from pg_trigger where tgrelid = $1::regclass and not tgisinternal`, [`public.${table}`],
    );

    expect(triggers.rows).toEqual([]);
  });

  test('DATA-ADMIN-001 問い合わせの updated_at は状態の更新で自動では動かず、窓口が書いた値が入る', async () => {
    const id = await insertInquiry();

    const updated = await db().query(
      `update public.contact_inquiries set status = 'pending', updated_at = '2020-01-01T00:00:00Z' where id = $1
       returning status, updated_at`,
      [id],
    );

    expect(updated.rows[0].status).toBe('pending');
    expect((updated.rows[0].updated_at as Date).toISOString()).toBe('2020-01-01T00:00:00.000Z');
  });
});
