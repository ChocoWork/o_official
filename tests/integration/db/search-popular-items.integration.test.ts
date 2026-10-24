/** @jest-environment node */
import { randomUUID } from 'node:crypto';
import { describeLocalDb } from './helpers/local-db';
import {
  PRICE,
  createCatalogFixture,
  createShippedOrderFixture,
  insertOrderWithLines,
  insertReturnRecord,
  orderRow,
  uniqueSuffix,
} from './helpers/order-fixtures';

/**
 * 人気商品の関数 get_popular_items（DATA-SEARCH-002）。
 * 1つのテストを1つの取引にして最後に巻き戻すので、足した商品・注文は残らない。
 * 関数は商品の表全体を並べるので、手元の DB にある別の商品と混ざらないよう、足した商品の番号だけを取り出して見る。
 */
jest.setTimeout(30000);

type Role = 'anon' | 'authenticated' | 'service_role';
type Outcome = { rows: any[]; rowCount: number } | { code: string };

/** 足した商品が全部入る件数。手元の DB の商品数より十分に大きくする */
const ALL = 100000;

describeLocalDb('integration: get_popular_items', (db) => {
  let token: string;

  beforeEach(async () => {
    await db().query('begin');
    token = `pop${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  });
  afterEach(async () => {
    await db().query('rollback');
  });

  /** 色・サイズ・在庫つきの商品を作り、並びの確かめのために作った日時を決める */
  async function newItem(options: { createdAt?: string; status?: 'published' | 'private' } = {}) {
    const fx = await createCatalogFixture(db(), { stock: 0, itemStatus: options.status });
    if (options.createdAt) {
      await db().query('update public.items set created_at = $2::timestamptz where id = $1', [fx.itemId, options.createdAt]);
    }
    return fx;
  }

  /** 受注生産の1行だけの注文（在庫の確保を使わない）。状態と数量を決める */
  async function order(fx: { itemId: number; variantId: number }, quantity: number, status: string) {
    return insertOrderWithLines(db(), {
      status,
      paidAmount: status === 'paid' ? PRICE * quantity : null,
      paymentIntentId: status === 'paid' ? `pi_${uniqueSuffix()}` : null,
      lines: [{ itemId: fx.itemId, variantId: fx.variantId, quantity, fulfillmentType: 'backorder' }],
    });
  }

  async function attempt(role: Role, sql: string, params: unknown[] = []): Promise<Outcome> {
    await db().query('savepoint popular_attempt');
    try {
      await db().query(`set local role ${role}`);
      const res = await db().query(sql, params);
      return { rows: res.rows, rowCount: res.rowCount };
    } catch (caught) {
      return { code: (caught as { code?: string }).code ?? 'unknown' };
    } finally {
      await db().query('rollback to savepoint popular_attempt');
      await db().query('release savepoint popular_attempt');
    }
  }

  async function popular(limit?: number | null): Promise<any[]> {
    const res = limit === undefined
      ? await db().query('select * from public.get_popular_items()')
      : await db().query('select * from public.get_popular_items($1::integer)', [limit]);
    return res.rows;
  }

  /** 指定した商品だけを、関数が返した順のまま取り出す */
  async function mine(ids: number[]): Promise<Array<{ id: number; count: string }>> {
    return (await popular(ALL))
      .filter((row) => ids.includes(Number(row.id)))
      .map((row) => ({ id: Number(row.id), count: String(row.purchase_count) }));
  }

  test('DATA-SEARCH-002 get_popular_items は支払いの済んだ注文の数量を商品ごとに足し、買われていない公開の商品も 0 として返す', async () => {
    const popularItem = await newItem();
    const singleItem = await newItem();
    const unboughtItem = await newItem();
    await order(popularItem, 2, 'paid');
    await order(popularItem, 3, 'paid');
    await order(singleItem, 1, 'paid');

    const rows = await mine([popularItem.itemId, singleItem.itemId, unboughtItem.itemId]);

    expect(rows).toEqual([
      { id: popularItem.itemId, count: '5' },
      { id: singleItem.itemId, count: '1' },
      { id: unboughtItem.itemId, count: '0' },
    ]);
  });

  test('DATA-SEARCH-002 get_popular_items は支払いの済んでいない注文と発送を終えた注文の数量を数えない', async () => {
    const pendingItem = await newItem();
    const failedItem = await newItem();
    await order(pendingItem, 4, 'pending');
    await order(failedItem, 2, 'failed');
    const shipped = await createShippedOrderFixture(db(), { lines: [{ quantity: 3 }] });
    expect((await orderRow(db(), shipped.orderId)).status).toBe('shipped');

    const rows = await mine([pendingItem.itemId, failedItem.itemId, shipped.itemIds[0]]);

    expect(rows.map((row) => row.count)).toEqual(['0', '0', '0']);
  });

  test('DATA-SEARCH-002 get_popular_items は交換の品の行を数えず、元の注文の行の数量だけを数える', async () => {
    // 3つ頼んで1つだけ送った注文は、全部を送り終えていないので支払い済みのまま
    const fixture = await createShippedOrderFixture(db(), {
      lines: [{ quantity: 3 }],
      shipments: [{ lines: [{ lineIndex: 0, quantity: 1 }] }],
    });
    expect((await orderRow(db(), fixture.orderId)).status).toBe('paid');
    const returned = await insertReturnRecord(db(), {
      orderId: fixture.orderId,
      lines: [{ fulfillmentId: fixture.fulfillments[0].id, orderItemId: fixture.orderItemIds[0], quantity: 1, resolution: 'exchange', exchangeVariantId: fixture.variantIds[0] }],
    });
    await db().query(
      `insert into public.order_items
         (order_id, item_id, item_name, item_price, color, size, quantity, line_total, variant_id, fulfillment_type,
          line_kind, exchange_return_line_id, exchange_paid_amount)
       values ($1, $2, '照合テスト', 0, 'BLACK', 'M', 4, 0, $3, 'backorder', 'exchange', $4, 0)`,
      [fixture.orderId, fixture.itemIds[0], fixture.variantIds[0], returned.lineIds[0]],
    );

    expect(await mine([fixture.itemIds[0]])).toEqual([{ id: fixture.itemIds[0], count: '3' }]);
  });

  test('DATA-SEARCH-002 get_popular_items は非公開の商品を、買われていても返さない', async () => {
    const privateItem = await newItem({ status: 'private' });
    const publicItem = await newItem();
    await order(privateItem, 9, 'paid');
    await order(publicItem, 1, 'paid');

    expect(await mine([privateItem.itemId, publicItem.itemId])).toEqual([{ id: publicItem.itemId, count: '1' }]);
  });

  test('DATA-SEARCH-002 get_popular_items は購入数の多い順に並べ、同じ購入数なら作った日時の新しい順に並べる', async () => {
    const topItem = await newItem({ createdAt: '2026-01-01T00:00:00Z' });
    const newerTie = await newItem({ createdAt: '2026-03-01T00:00:00Z' });
    const olderTie = await newItem({ createdAt: '2026-02-01T00:00:00Z' });
    const newerUnbought = await newItem({ createdAt: '2026-06-01T00:00:00Z' });
    const olderUnbought = await newItem({ createdAt: '2026-05-01T00:00:00Z' });
    await order(topItem, 5, 'paid');
    await order(newerTie, 2, 'paid');
    await order(olderTie, 2, 'paid');

    const rows = await mine([
      olderUnbought.itemId, olderTie.itemId, newerUnbought.itemId, topItem.itemId, newerTie.itemId,
    ]);

    expect(rows.map((row) => row.id)).toEqual([
      topItem.itemId, newerTie.itemId, olderTie.itemId, newerUnbought.itemId, olderUnbought.itemId,
    ]);
  });

  test('DATA-SEARCH-002 get_popular_items は件数を既定で 4 にし、渡した数を上限に丸めずに返す', async () => {
    await db().query(
      `insert into public.items (name, description, price, category, image_url, status)
       select $1 || ' bulk ' || n, 'bulk', 1000, 'TOPS', 'items/bulk.png', 'published'
       from generate_series(1, 25) as n`,
      [token],
    );

    expect(await popular()).toHaveLength(4);
    expect(await popular(2)).toHaveLength(2);
    expect(await popular(0)).toHaveLength(0);
    expect(await popular(25)).toHaveLength(25);
    expect((await popular(null)).length).toBeGreaterThanOrEqual(25);
    expect(await attempt('service_role', 'select * from public.get_popular_items($1::integer)', [-1])).toEqual({ code: '2201W' });
  });

  test('DATA-SEARCH-002 get_popular_items は検索の部品が読む列と購入数を返す', async () => {
    const fx = await newItem();
    await order(fx, 2, 'paid');

    const row = (await popular(ALL)).find((candidate) => Number(candidate.id) === fx.itemId);

    expect(row).toEqual({
      id: String(fx.itemId),
      name: expect.stringMatching(/^fx-/),
      description: '照合テスト',
      category: 'TOPS',
      image_url: 'https://example.com/item.png',
      price: PRICE,
      purchase_count: '2',
    });
  });

  test('DATA-SEARCH-002 get_popular_items は service_role だけが呼べ、anon・authenticated には実行を許さない', async () => {
    const fx = await newItem();
    await order(fx, 1, 'paid');
    const call = 'select id from public.get_popular_items($1::integer)';

    const asServiceRole = await attempt('service_role', call, [ALL]);
    expect('rows' in asServiceRole && asServiceRole.rows.map((row) => Number(row.id))).toContain(fx.itemId);
    expect(await attempt('anon', call, [4])).toEqual({ code: '42501' });
    expect(await attempt('authenticated', call, [4])).toEqual({ code: '42501' });
  });

  test('DATA-SEARCH-002 get_popular_items は作成者の権限で動き、search_path を空にして、PUBLIC・anon・authenticated から実行を外す', async () => {
    const res = await db().query(
      `select p.prosecdef as definer, p.provolatile as volatility, p.proconfig as config,
              exists (
                select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) as a
                where a.grantee = 0 and a.privilege_type = 'EXECUTE'
              ) as public_execute,
              has_function_privilege('anon', p.oid, 'EXECUTE') as anon_execute,
              has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_execute,
              has_function_privilege('service_role', p.oid, 'EXECUTE') as service_role_execute
       from pg_proc as p
       join pg_namespace as n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'get_popular_items'`,
    );

    expect(res.rows).toEqual([{
      definer: true,
      volatility: 's',
      config: ['search_path=""'],
      public_execute: false,
      anon_execute: false,
      authenticated_execute: false,
      service_role_execute: true,
    }]);
  });
});
