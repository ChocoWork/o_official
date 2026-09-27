/** @jest-environment node */
export {};

const { Client } = require('pg');

/**
 * 割引が付いた注文の確定（FREQ-389）。
 *
 * チェックアウト画面にはプロモーションコードの入力欄があるのに、本番の checkout_drafts には
 * discount_amount 列が無く、割引後の実請求額を書き戻す更新が列ごと弾かれていた。下書きは
 * 割引前の合計のまま残り、注文確定は割引後の期待額と比べて CHECKOUT_TOTAL_MISMATCH で落ちる。
 * 列を足し、注文確定が下書きの値引額を注文へ引き写すことを実 DB で確かめる。
 *
 * 実行方法（ローカル Supabase を起動しておく: npm run db:start）:
 *   DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
 *     npx jest tests/integration/db/checkout_draft_discount
 *
 * 注意: 試験用の注文は削除禁止トリガーで消せない。使い捨てのローカル DB でだけ動かす。
 */

const DATABASE_URL = process.env.DATABASE_URL;
const SUBTOTAL = 5000;
const SHIPPING = 500;
const DISCOUNT = 1000;

function isLocalDatabase(url: string): boolean {
  try {
    return ['localhost', '127.0.0.1', '::1'].includes(new URL(url).hostname);
  } catch {
    return false;
  }
}

describe('integration: 割引が付いた注文の確定', () => {
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

  /** 割引後の合計を持つ draft を作る（アプリが書き戻したあとの状態）。 */
  async function createDraft(discountAmount: number): Promise<{
    draftId: string;
    paymentIntentId: string;
    totalAmount: number;
  }> {
    const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const item = await client.query(
      `insert into public.items (name, description, price, category, image_url, status)
       values ('discount-' || $1::text, '割引テスト', $2, 'TOPS', 'https://example.com/item.png', 'published')
       returning id`,
      [suffix, SUBTOTAL],
    );
    const itemId = Number(item.rows[0].id);
    const totalAmount = SUBTOTAL + SHIPPING - discountAmount;

    const draft = await client.query(
      `insert into public.checkout_drafts
         (session_id, payment_method, subtotal_amount, shipping_amount, discount_amount,
          total_amount, currency, shipping_snapshot, items_snapshot)
       values ($1, 'stripe_card', $2, $3, $4, $5, 'jpy', $6::jsonb, $7::jsonb)
       returning id`,
      [
        `discount-session-${suffix}`,
        SUBTOTAL,
        SHIPPING,
        discountAmount,
        totalAmount,
        JSON.stringify({
          email: 'discount@example.com',
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
            item_name: '割引テスト',
            item_price: SUBTOTAL,
            item_image_url: 'https://example.com/item.png',
            color: null,
            size: null,
            quantity: 1,
            line_total: SUBTOTAL,
          },
        ]),
      ],
    );

    return { draftId: draft.rows[0].id, paymentIntentId: `pi_discount_${suffix}`, totalAmount };
  }

  function finalize(draftId: string, paymentIntentId: string, expectedTotal: number) {
    return client.query(
      `select order_id from public.finalize_order_from_checkout_draft(
         $1::uuid, $2::text, $3::text, $4::public.order_status, $5::integer, $6::text)`,
      [draftId, paymentIntentId, `cs_${paymentIntentId}`, 'paid', expectedTotal, 'jpy'],
    );
  }

  test('checkout_drafts は discount_amount を持ち、既定は 0', async () => {
    const res = await client.query(
      `select column_default, is_nullable, data_type
       from information_schema.columns
       where table_schema = 'public' and table_name = 'checkout_drafts' and column_name = 'discount_amount'`,
    );

    expect(res.rowCount).toBe(1);
    expect(res.rows[0].is_nullable).toBe('NO');
    expect(res.rows[0].data_type).toBe('integer');
    expect(String(res.rows[0].column_default)).toContain('0');
  });

  test('負の値引額は入れられない', async () => {
    await expect(createDraft(-1)).rejects.toMatchObject({ code: '23514' });
  });

  test('割引後の合計で注文ができ、値引額が注文に残る', async () => {
    const { draftId, paymentIntentId, totalAmount } = await createDraft(DISCOUNT);

    const res = await finalize(draftId, paymentIntentId, totalAmount);
    expect(res.rows[0].order_id).toEqual(expect.any(String));

    const order = await client.query(
      'select discount_amount, total_amount, subtotal_amount, shipping_amount from public.orders where payment_intent_id = $1',
      [paymentIntentId],
    );
    expect(order.rows[0]).toMatchObject({
      discount_amount: DISCOUNT,
      total_amount: totalAmount,
      subtotal_amount: SUBTOTAL,
      shipping_amount: SHIPPING,
    });
  });

  test('割引が無い注文は、これまで通り値引額 0 で作られる', async () => {
    const { draftId, paymentIntentId, totalAmount } = await createDraft(0);

    await finalize(draftId, paymentIntentId, totalAmount);

    const order = await client.query(
      'select discount_amount, total_amount from public.orders where payment_intent_id = $1',
      [paymentIntentId],
    );
    expect(order.rows[0]).toMatchObject({ discount_amount: 0, total_amount: totalAmount });
  });

  test('下書きの合計と期待額がずれていれば、これまで通り止まる', async () => {
    const { draftId, paymentIntentId, totalAmount } = await createDraft(DISCOUNT);

    await expect(finalize(draftId, paymentIntentId, totalAmount + 1)).rejects.toMatchObject({
      code: 'P0001',
      message: expect.stringContaining('CHECKOUT_TOTAL_MISMATCH'),
    });
  });
});
