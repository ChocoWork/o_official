/** @jest-environment node */
export {};

const { Client } = require('pg');

/**
 * ゲスト用 RPC の item_id の型（FREQ-403）。
 *
 * carts.item_id / wishlist.item_id は bigint だが、関数は RETURNS TABLE で integer と
 * 宣言していた。行を返す文の種類で結果が分かれる:
 *   - INSERT / UPDATE ... RETURNING → 42804（型の不一致）で失敗
 *   - 素の SELECT                    → 通ってしまう（宣言は誤りのまま）
 *
 * ここでは5本すべてを実際に呼んで、型の不一致で落ちないことを確かめる。
 *
 * 実行方法（ローカル Supabase を起動しておく: npm run db:start）:
 *   DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
 *     npx jest tests/integration/db/guest_rpc_item_id_type
 */

const DATABASE_URL = process.env.DATABASE_URL;

function isLocalDatabase(url: string): boolean {
  try {
    return ['localhost', '127.0.0.1', '::1'].includes(new URL(url).hostname);
  } catch {
    return false;
  }
}

describe('integration: ゲスト用 RPC の item_id の型', () => {
  if (!DATABASE_URL) {
    test.skip('DATABASE_URL 未設定のためスキップ', () => {});
    return;
  }

  if (!isLocalDatabase(DATABASE_URL)) {
    test('使い捨ての DB 以外では実行しない', () => {
      throw new Error('localhost 以外の DATABASE_URL では実行しない');
    });
    return;
  }

  let client: any;
  let itemId = 0;
  let sessionId = '';

  beforeAll(async () => {
    client = new Client({ connectionString: DATABASE_URL });
    await client.connect();
  });

  afterAll(async () => {
    if (client) await client.end();
  });

  beforeEach(async () => {
    await client.query('BEGIN');
    const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    sessionId = `guest-rpc-${suffix}`;
    const item = await client.query(
      `insert into public.items (name, description, price, category, image_url, status)
       values ('guest-rpc-' || $1::text, 'RPC 型テスト', 1000, 'TOPS', 'https://example.com/i.png', 'published')
       returning id`,
      [suffix],
    );
    itemId = Number(item.rows[0].id);
  });

  afterEach(async () => {
    await client.query('ROLLBACK');
  });

  test('戻り値の item_id は bigint で宣言されている', async () => {
    const res = await client.query(
      `select p.proname, pg_get_function_result(p.oid) as result
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname in ('add_guest_cart_item','update_guest_cart_item_quantity',
                            'add_guest_wishlist_item','list_guest_cart','list_guest_wishlist')
        order by 1`,
    );

    expect(res.rows).toHaveLength(5);
    for (const row of res.rows) {
      expect(row.result).toContain('item_id bigint');
    }
  });

  test('カートに追加できる（以前は 42804 で落ちていた）', async () => {
    const res = await client.query(
      `select id, item_id, quantity from public.add_guest_cart_item($1, $2::bigint, 2, 'BLACK', 'M')`,
      [sessionId, itemId],
    );

    expect(res.rows).toHaveLength(1);
    expect(Number(res.rows[0].item_id)).toBe(itemId);
    expect(res.rows[0].quantity).toBe(2);
  });

  test('同じ組み合わせを足すと数量が増える', async () => {
    await client.query(`select public.add_guest_cart_item($1, $2::bigint, 1, 'BLACK', 'M')`, [sessionId, itemId]);
    const res = await client.query(
      `select quantity from public.add_guest_cart_item($1, $2::bigint, 3, 'BLACK', 'M')`,
      [sessionId, itemId],
    );

    expect(res.rows[0].quantity).toBe(4);
  });

  test('カートの数量を変更できる（以前は 42804 で落ちていた）', async () => {
    const added = await client.query(
      `select id from public.add_guest_cart_item($1, $2::bigint, 1, null, null)`,
      [sessionId, itemId],
    );

    const res = await client.query(
      `select item_id, quantity from public.update_guest_cart_item_quantity($1, $2::uuid, 5)`,
      [sessionId, added.rows[0].id],
    );

    expect(Number(res.rows[0].item_id)).toBe(itemId);
    expect(res.rows[0].quantity).toBe(5);
  });

  test('ウィッシュリストに追加できる（以前は 42804 で落ちていた）', async () => {
    const res = await client.query(
      `select item_id from public.add_guest_wishlist_item($1, $2::bigint)`,
      [sessionId, itemId],
    );

    expect(Number(res.rows[0].item_id)).toBe(itemId);
  });

  test('カートとウィッシュリストの一覧を返せる', async () => {
    await client.query(`select public.add_guest_cart_item($1, $2::bigint, 1, null, null)`, [sessionId, itemId]);
    await client.query(`select public.add_guest_wishlist_item($1, $2::bigint)`, [sessionId, itemId]);

    const cart = await client.query(`select item_id from public.list_guest_cart($1)`, [sessionId]);
    const wishlist = await client.query(`select item_id from public.list_guest_wishlist($1)`, [sessionId]);

    expect(Number(cart.rows[0].item_id)).toBe(itemId);
    expect(Number(wishlist.rows[0].item_id)).toBe(itemId);
  });

  test('非公開の商品は追加できない', async () => {
    await client.query(`update public.items set status = 'private' where id = $1`, [itemId]);

    await expect(
      client.query(`select public.add_guest_cart_item($1, $2::bigint, 1, null, null)`, [sessionId, itemId]),
    ).rejects.toMatchObject({ code: 'P0002' });
  });

  /** 作り直した関数の既定は PUBLIC 実行可。REVOKE を忘れると匿名から呼べてしまう。 */
  test('匿名と認証済みからは実行できず、service_role からは実行できる', async () => {
    const res = await client.query(
      `select has_function_privilege('anon', $1, 'EXECUTE') as anon,
              has_function_privilege('authenticated', $1, 'EXECUTE') as authenticated,
              has_function_privilege('service_role', $1, 'EXECUTE') as service_role
         from unnest(array[
           'public.add_guest_cart_item(text, bigint, integer, text, text)',
           'public.update_guest_cart_item_quantity(text, uuid, integer)',
           'public.add_guest_wishlist_item(text, bigint)',
           'public.list_guest_cart(text)',
           'public.list_guest_wishlist(text)'
         ]) as t($1)`.replace(/\$1/g, 'fn'),
    );

    expect(res.rows).toHaveLength(5);
    for (const row of res.rows) {
      expect(row).toMatchObject({ anon: false, authenticated: false, service_role: true });
    }
  });
});
