/** @jest-environment node */
export {};

const { Client } = require('pg');

/**
 * 注文メールの送信権（FREQ-386、チップ: 注文確認メールの重複）。
 *
 * 同じ注文・同じ種類で権利を取れるのは1回だけ。取れた経路だけがメールを送る。
 * 送信に失敗したら戻して、あとの経路（webhook の再送・掃除ジョブ）に譲れるようにする。
 *
 * 実行方法（ローカル Supabase を起動しておく: npm run db:start）:
 *   DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
 *     npx jest tests/integration/db/order_email_claims
 *
 * 注意: 試験用の注文は削除禁止トリガーで消せない。使い捨てのローカル DB でだけ動かす。
 */

const DATABASE_URL = process.env.DATABASE_URL;

function isLocalDatabase(url: string): boolean {
  try {
    return ['localhost', '127.0.0.1', '::1'].includes(new URL(url).hostname);
  } catch {
    return false;
  }
}

describe('integration: 注文メールの送信権', () => {
  if (!DATABASE_URL) {
    test.skip('DATABASE_URL 未設定のためスキップ', () => {});
    return;
  }

  if (!isLocalDatabase(DATABASE_URL)) {
    test('使い捨ての DB 以外では実行しない', () => {
      throw new Error(
        '消せない試験注文が残るため、localhost 以外の DATABASE_URL では実行しない',
      );
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

  async function createOrder(): Promise<string> {
    const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const order = await client.query(
      `insert into public.orders
         (session_id, payment_intent_id, status, subtotal_amount, shipping_amount, total_amount, currency)
       values ($1, $2, 'pending', 1000, 0, 1000, 'jpy')
       returning id`,
      [`mailclaim-session-${suffix}`, `pi_mailclaim_${suffix}`],
    );
    return order.rows[0].id;
  }

  async function claim(orderId: string, kind: string): Promise<boolean> {
    const res = await client.query('select public.claim_order_email($1::uuid, $2::text) as claimed', [orderId, kind]);
    return res.rows[0].claimed;
  }

  async function release(orderId: string, kind: string): Promise<boolean> {
    const res = await client.query('select public.release_order_email($1::uuid, $2::text) as released', [orderId, kind]);
    return res.rows[0].released;
  }

  test('同じ注文・同じ種類で取れるのは1回だけ', async () => {
    const orderId = await createOrder();

    expect(await claim(orderId, 'awaiting_payment')).toBe(true);
    expect(await claim(orderId, 'awaiting_payment')).toBe(false);
  });

  test('種類が違えば別に取れる（お支払い待ちと入金確認で2通が正しい）', async () => {
    const orderId = await createOrder();

    expect(await claim(orderId, 'awaiting_payment')).toBe(true);
    expect(await claim(orderId, 'paid')).toBe(true);
  });

  test('戻すと、もう一度取れる', async () => {
    const orderId = await createOrder();

    expect(await claim(orderId, 'paid')).toBe(true);
    expect(await release(orderId, 'paid')).toBe(true);
    expect(await claim(orderId, 'paid')).toBe(true);
  });

  test('取っていないものを戻しても false', async () => {
    const orderId = await createOrder();

    expect(await release(orderId, 'paid')).toBe(false);
  });

  test('知らない種類は受け付けない', async () => {
    const orderId = await createOrder();

    await expect(claim(orderId, 'shipped')).rejects.toMatchObject({ code: '23514' });
  });

  test('存在しない注文では取れない', async () => {
    await expect(claim('00000000-0000-0000-0000-000000000000', 'paid')).rejects.toMatchObject({ code: '23503' });
  });

  test('利用者の権限からは実行できない', async () => {
    const orderId = await createOrder();

    for (const role of ['anon', 'authenticated']) {
      await client.query('begin');
      await client.query(`set local role ${role}`);
      await expect(claim(orderId, 'paid')).rejects.toMatchObject({ code: '42501' });
      await client.query('rollback');
    }
  });
});
