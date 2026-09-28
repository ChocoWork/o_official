/** @jest-environment node */
import { describeLocalDb } from './helpers/local-db';

/**
 * 注文の状態に「支払い手続き中」「放棄」を足す（グループ A 設計書 4-2・4-8）。
 *
 * 実行方法:
 *   DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
 *     npx jest tests/integration/db/order_payment_statuses
 */
describeLocalDb('integration: 注文の状態の値', (db) => {
  test('order_status は受付・入金・失敗・放棄・取消・発送の順に並ぶ', async () => {
    const res = await db().query(
      `select unnest(enum_range(null::public.order_status))::text as value`,
    );
    expect(res.rows.map((row) => row.value)).toEqual([
      'payment_in_progress',
      'pending',
      'paid',
      'failed',
      'abandoned',
      'cancelled',
      'shipped',
    ]);
  });
});
