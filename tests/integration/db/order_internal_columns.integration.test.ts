/** @jest-environment node */
import { describeLocalDb, type PgClient } from './helpers/local-db';
import { createCatalogFixture, uniqueSuffix } from './helpers/order-fixtures';

/**
 * 店内の注文の列を、お客様の Data API（anon・authenticated）から隠す（グループ A 最終レビュー Important 1）。
 * 取消のメモ・理由・お知らせの有無と確認者は店内だけに残す（設計書 5-2）。注文の持ち主・ゲストは RLS で
 * 自分の注文の行を読めるので、行ではなく列の権限で止める。
 *
 * 列の権限は後から足した列に及ばない（足した列は何もしなければ隠れる）。orders に列を足すと、下の
 * 「ほかの列はすべて読める」が落ちるので、足した人が決める。お客様に見せる列なら、足す移行で anon・authenticated へ
 * SELECT を付ける。店内だけの列なら、INTERNAL_COLUMNS へ足す（20260927100900_hide_internal_order_columns.sql の冒頭を参照）。
 */
const INTERNAL_COLUMNS = ['cancel_note', 'cancel_reason', 'cancel_notify_customer', 'reviewed_by'];

type UserRole = 'anon' | 'authenticated';

async function ordersColumns(db: PgClient): Promise<string[]> {
  const res = await db.query(
    `select column_name
     from information_schema.columns
     where table_schema = 'public' and table_name = 'orders'
     order by ordinal_position`,
  );
  return res.rows.map((row) => row.column_name as string);
}

async function readableColumns(db: PgClient, role: string): Promise<string[]> {
  const res = await db.query(
    `select column_name
     from information_schema.columns
     where table_schema = 'public' and table_name = 'orders'
       and has_column_privilege($1, 'public.orders', column_name, 'SELECT')
     order by ordinal_position`,
    [role],
  );
  return res.rows.map((row) => row.column_name as string);
}

const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;

/**
 * 利用者の権限で問い合わせを1本だけ流して巻き戻し、行を返す。権限エラーは取引ごと壊すので、1本ごとに別の取引にする。
 * settings は PostgREST が取引ごとに入れる値（JWT のクレーム・ゲストの session_id）を再現する。
 */
async function queryAs(
  db: PgClient,
  role: UserRole,
  settings: Record<string, string>,
  sql: string,
  params: unknown[] = [],
): Promise<Record<string, unknown>[]> {
  await db.query('begin');
  try {
    await db.query(`set local role ${role}`);
    for (const [name, value] of Object.entries(settings)) {
      await db.query('select set_config($1, $2, true)', [name, value]);
    }
    return (await db.query(sql, params)).rows;
  } finally {
    await db.query('rollback');
  }
}

describeLocalDb('integration: 店内の注文の列を利用者の Data API から隠す', (db) => {
  test.each(['anon', 'authenticated'] as const)(
    '%s は店内の4列を読めず、ほかの列はすべて読める',
    async (role) => {
      const columns = await ordersColumns(db());

      // 列名の打ち間違いで、何も隠さないまま通ることを防ぐ
      expect(columns).toEqual(expect.arrayContaining(INTERNAL_COLUMNS));
      expect(await readableColumns(db(), role)).toEqual(
        columns.filter((column) => !INTERNAL_COLUMNS.includes(column)),
      );
    },
  );

  test('service_role はすべての列を読める', async () => {
    expect(await readableColumns(db(), 'service_role')).toEqual(await ordersColumns(db()));
  });

  describe('注文の持ち主・ゲストが実際に読む', () => {
    let ownerId: string;
    let sessionId: string;
    let orderId: string;

    // 持ち主の注文は orders.user_id が profiles への外部キーなので、実在の auth.users を使う
    // （profiles は auth.users への挿入で自動で作られる）。afterAll は describeLocalDb が接続を閉じる前に動く
    // よう、ここ（ネストした describe）に置く（tests/integration/db/release_stock_by_order.integration.test.ts と同じ）。
    beforeAll(async () => {
      const suffix = uniqueSuffix();
      const user = await db().query(
        `insert into auth.users (id, email, raw_user_meta_data, created_at, updated_at)
         values (gen_random_uuid(), $1, '{}'::jsonb, now(), now())
         returning id`,
        [`order-internal-columns-${suffix}@example.com`],
      );
      ownerId = user.rows[0].id as string;
      sessionId = `fx-internal-${suffix}`;

      const order = await db().query(
        `insert into public.orders
           (session_id, user_id, status, subtotal_amount, shipping_amount, total_amount, currency,
            cancel_reason, cancel_note, cancel_notify_customer, reviewed_by)
         values ($1, $2, 'cancelled'::public.order_status, 5000, 0, 5000, 'jpy',
                 'suspected_fraud', '店内だけのメモ', false, $2)
         returning id`,
        [sessionId, ownerId],
      );
      orderId = order.rows[0].id as string;

      const { itemId } = await createCatalogFixture(db(), { stock: 0 });
      await db().query(
        `insert into public.order_items (order_id, item_id, item_name, item_price, quantity, line_total)
         values ($1, $2, '照合テスト', 5000, 1, 5000)`,
        [orderId, itemId],
      );
    });

    afterAll(async () => {
      // profiles は ON DELETE CASCADE、orders.user_id は ON DELETE SET NULL。注文そのものは削除禁止トリガーで残る
      // （使い捨てのローカル DB 前提。local-db.ts の冒頭を参照）。
      await db().query('DELETE FROM auth.users WHERE id = $1', [ownerId]);
    });

    async function expectCustomerReadsOrder(role: UserRole, settings: Record<string, string>) {
      const visible = (await ordersColumns(db())).filter((column) => !INTERNAL_COLUMNS.includes(column));

      const order = await queryAs(
        db(), role, settings,
        `select ${visible.map(quote).join(', ')} from public.orders where id = $1`,
        [orderId],
      );
      expect(order).toHaveLength(1);
      expect(order[0]).toMatchObject({ id: orderId, user_id: ownerId, status: 'cancelled' });
      expect(Object.keys(order[0]!)).toEqual(visible);

      // 注文の明細は RLS が orders の id・user_id・session_id を読んで見せる。列の権限で壊れていないこと
      const items = await queryAs(
        db(), role, settings,
        'select item_name, quantity from public.order_items where order_id = $1',
        [orderId],
      );
      expect(items).toEqual([{ item_name: '照合テスト', quantity: 1 }]);

      for (const column of INTERNAL_COLUMNS) {
        await expect(
          queryAs(db(), role, settings, `select ${quote(column)} from public.orders where id = $1`, [orderId]),
        ).rejects.toMatchObject({ code: '42501' });
      }

      // `select *` は店内の列を含むので、利用者の権限では通らない（列を並べて読む）
      await expect(
        queryAs(db(), role, settings, 'select * from public.orders where id = $1', [orderId]),
      ).rejects.toMatchObject({ code: '42501' });
    }

    test('ログイン中の持ち主は、自分の注文の店内以外の列を読めて、店内の列は読めない（42501）', async () => {
      await expectCustomerReadsOrder('authenticated', {
        'request.jwt.claims': JSON.stringify({ sub: ownerId, role: 'authenticated' }),
      });
    });

    test('ゲストは、自分の session の注文の店内以外の列を読めて、店内の列は読めない（42501）', async () => {
      await expectCustomerReadsOrder('anon', { 'app.session_id': sessionId });
    });
  });
});
