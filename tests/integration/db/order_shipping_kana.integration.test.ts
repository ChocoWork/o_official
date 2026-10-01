/** @jest-environment node */
export {};

const { Client } = require('pg');

/**
 * 注文にフリガナを残す（FREQ-384、レビュー指摘⑬）。
 *
 * 受付（place_order_from_checkout_draft）が、配送先の写しの kanaName を
 * orders.shipping_kana に書くこと、書いた後は法定の変更禁止トリガーで書き換えられないことを、
 * 実 DB で確かめる。
 *
 * 実行方法（ローカル Supabase を起動しておく: npm run db:start）:
 *   DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
 *     npx jest tests/integration/db/order_shipping_kana
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

describe('integration: 注文のフリガナ', () => {
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

  /** 商品1点の draft を作り、注文確定まで走らせて注文 id を返す。 */
  async function finalizeOrder(kanaName: string | null): Promise<string> {
    const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const item = await client.query(
      `insert into public.items (name, description, price, category, image_url, status)
       values ('kana-' || $1::text, 'フリガナ保存テスト', $2, 'TOPS', 'https://example.com/item.png', 'published')
       returning id`,
      [suffix, PRICE],
    );

    const draft = await client.query(
      `insert into public.checkout_drafts
         (session_id, payment_method, subtotal_amount, shipping_amount, total_amount, currency,
          shipping_snapshot, items_snapshot, checkout_session_id)
       values ($1, 'stripe_card', $2, 0, $2, 'jpy', $3::jsonb, $4::jsonb, $5)
       returning id`,
      [
        `kana-session-${suffix}`,
        PRICE,
        JSON.stringify({
          email: 'kana@example.com',
          fullName: '山田 花子',
          kanaName,
          postalCode: '1500001',
          prefecture: '東京都',
          city: '渋谷区',
          address: '神宮前1-1-1',
          building: null,
          phone: '0311112222',
        }),
        JSON.stringify([
          {
            item_id: Number(item.rows[0].id),
            item_name: 'フリガナ保存テスト',
            item_price: PRICE,
            item_image_url: 'https://example.com/item.png',
            color: null,
            size: null,
            quantity: 1,
            line_total: PRICE,
          },
        ]),
        `cs_kana_${suffix}`,
      ],
    );

    const placed = await client.query(
      `select order_id from public.place_order_from_checkout_draft(
         $1::uuid, $2::text, $3::text, $4::integer, 0, 'jpy', now(), null)`,
      [draft.rows[0].id, `cs_kana_${suffix}`, `kana-session-${suffix}`, PRICE],
    );

    return placed.rows[0].order_id;
  }

  async function shippingKanaOf(orderId: string): Promise<string | null> {
    const res = await client.query('select shipping_kana from public.orders where id = $1', [orderId]);
    return res.rows[0].shipping_kana;
  }

  test('受付で配送先の写しのフリガナが注文に入る', async () => {
    const orderId = await finalizeOrder('ヤマダ ハナコ');
    expect(await shippingKanaOf(orderId)).toBe('ヤマダ ハナコ');
  });

  test('フリガナの無い draft でも受付は通り、注文のフリガナは空になる', async () => {
    const orderId = await finalizeOrder(null);
    expect(await shippingKanaOf(orderId)).toBeNull();
  });

  test('注文に入ったフリガナは後から書き換えられない', async () => {
    const orderId = await finalizeOrder('ヤマダ ハナコ');

    await expect(
      client.query('update public.orders set shipping_kana = $2 where id = $1', [orderId, 'サトウ タロウ']),
    ).rejects.toMatchObject({ code: '23001' });

    expect(await shippingKanaOf(orderId)).toBe('ヤマダ ハナコ');
  });
});
