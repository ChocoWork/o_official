/** @jest-environment node */
export {};

const { Client } = require('pg');

/**
 * 商品が消えている・公開されていない注文確定の止まり方（FREQ-387）。
 *
 * 管理画面の商品削除は実削除で、カートや checkout draft は止めない。削除された商品を含む
 * draft で注文確定を呼ぶと、以前は公開判定を素通りして注文明細の外部キー違反で落ちていた。
 * 支払いは済んでいるので、客には理由の分からない 500 が返る。
 * どちらの場合も ITEM_NOT_PUBLISHED で止め、注文を作らないことを実 DB で確かめる。
 *
 * 実行方法（ローカル Supabase を起動しておく: npm run db:start）:
 *   DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
 *     npx jest tests/integration/db/finalize_missing_item
 *
 * 注意: 試験用の注文は削除禁止トリガーで消せない。使い捨てのローカル DB でだけ動かす。
 */

const DATABASE_URL = process.env.DATABASE_URL;
const PRICE = 1000;

function isLocalDatabase(url: string): boolean {
  try {
    return ['localhost', '127.0.0.1', '::1'].includes(new URL(url).hostname);
  } catch {
    return false;
  }
}

describe('integration: 商品が引けないときの注文確定', () => {
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

  /** 商品1点の draft を作る。返り値の itemId は、テスト側で消したり非公開にしたりする。 */
  async function createDraft(status: 'published' | 'private'): Promise<{
    itemId: number;
    draftId: string;
    paymentIntentId: string;
  }> {
    const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const item = await client.query(
      `insert into public.items (name, description, price, category, image_url, status)
       values ('missing-' || $1::text, '削除済み商品テスト', $2, 'TOPS', 'https://example.com/item.png', $3)
       returning id`,
      [suffix, PRICE, status],
    );
    const itemId = Number(item.rows[0].id);

    const draft = await client.query(
      `insert into public.checkout_drafts
         (session_id, payment_method, subtotal_amount, shipping_amount, total_amount, currency,
          shipping_snapshot, items_snapshot)
       values ($1, 'stripe_card', $2, 0, $2, 'jpy', $3::jsonb, $4::jsonb)
       returning id`,
      [
        `missing-session-${suffix}`,
        PRICE,
        JSON.stringify({
          email: 'missing@example.com',
          fullName: '山田 花子',
          postalCode: '1500001',
          prefecture: '東京都',
          city: '渋谷区',
          address: '神宮前1-1-1',
          building: null,
          phone: '0311112222',
        }),
        JSON.stringify([
          {
            item_id: itemId,
            item_name: '削除済み商品テスト',
            item_price: PRICE,
            item_image_url: 'https://example.com/item.png',
            color: null,
            size: null,
            quantity: 1,
            line_total: PRICE,
          },
        ]),
      ],
    );

    return { itemId, draftId: draft.rows[0].id, paymentIntentId: `pi_missing_${suffix}` };
  }

  function finalize(draftId: string, paymentIntentId: string) {
    return client.query(
      `select order_id from public.finalize_order_from_checkout_draft(
         $1::uuid, $2::text, $3::text, $4::public.order_status, $5::integer, $6::text)`,
      // checkout_session_id は一意。試験のたびに違う値にする
      [draftId, paymentIntentId, `cs_${paymentIntentId}`, 'paid', PRICE, 'jpy'],
    );
  }

  async function orderCount(paymentIntentId: string): Promise<number> {
    const res = await client.query('select count(*)::int as n from public.orders where payment_intent_id = $1', [
      paymentIntentId,
    ]);
    return res.rows[0].n;
  }

  test('商品が削除されていたら ITEM_NOT_PUBLISHED で止まり、注文を作らない', async () => {
    const { itemId, draftId, paymentIntentId } = await createDraft('published');
    await client.query('delete from public.items where id = $1', [itemId]);

    await expect(finalize(draftId, paymentIntentId)).rejects.toMatchObject({
      code: 'P0001',
      message: expect.stringContaining(`ITEM_NOT_PUBLISHED:${itemId}`),
    });

    expect(await orderCount(paymentIntentId)).toBe(0);
  });

  test('商品が非公開でも、これまで通り ITEM_NOT_PUBLISHED で止まる', async () => {
    const { itemId, draftId, paymentIntentId } = await createDraft('private');

    await expect(finalize(draftId, paymentIntentId)).rejects.toMatchObject({
      code: 'P0001',
      message: expect.stringContaining(`ITEM_NOT_PUBLISHED:${itemId}`),
    });

    expect(await orderCount(paymentIntentId)).toBe(0);
  });

  test('公開中の商品なら、これまで通り注文ができる', async () => {
    const { draftId, paymentIntentId } = await createDraft('published');

    const res = await finalize(draftId, paymentIntentId);

    expect(res.rows[0].order_id).toEqual(expect.any(String));
    expect(await orderCount(paymentIntentId)).toBe(1);
  });
});
