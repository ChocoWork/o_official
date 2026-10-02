/** @jest-environment node */
export {};

const { Client } = require('pg');

/**
 * 下書きの値引額の列（FREQ-389）。
 *
 * チェックアウト画面にはプロモーションコードの入力欄があるのに、本番の checkout_drafts には
 * discount_amount 列が無く、割引後の実請求額を書き戻す更新が列ごと弾かれていた。
 * 列を足したので、列の定義（整数・NOT NULL・既定 0）と、負の値を入れられないことを実 DB で確かめる。
 * 割引が付いた注文の受付（Stripe の値を注文へ引き写す・割引後の合計へ書き換え済みの古い下書き・
 * 金額の違い）は place_order_from_checkout_draft.integration.test.ts が確かめる。
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

function isLocalDatabase(url: string): boolean {
  try {
    return ['localhost', '127.0.0.1', '::1'].includes(new URL(url).hostname);
  } catch {
    return false;
  }
}

describe('integration: 下書きの値引額の列', () => {
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

  /** 値引額を指定した draft を作り、その id を返す（値引額の検査を確かめるため）。 */
  async function createDraft(discountAmount: number): Promise<string> {
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

    return draft.rows[0].id;
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
});
