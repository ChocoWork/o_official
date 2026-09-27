/** @jest-environment node */
export {};

const { Client } = require('pg');

/**
 * 同じ支払いの注文確定が並行したときの finalize_order_from_checkout_draft（FREQ-363）。
 *
 * 注文確定は3経路（画面の complete、webhook の checkout.session.completed、
 * payment_intent.succeeded）から同時に呼ばれる。後から来た呼び出しが、先の呼び出しの
 * 注文を返さずに INSUFFICIENT_STOCK で失敗すると、支払い済みの客に注文失敗を見せる。
 * これは SQL の文字列照合では検出できないので、実際に2セッションを競わせる。
 *
 * 実行方法（ローカル Supabase を起動しておく: npm run db:start）:
 *   DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
 *     npx jest tests/integration/db/finalize_order_concurrency
 *
 * 注意: 注文と明細には削除禁止トリガーがあり、作った試験データは後から消せない。
 * 使い捨てのローカル DB でだけ動かす。
 */

const DATABASE_URL = process.env.DATABASE_URL;

function isLocalDatabase(url: string): boolean {
  try {
    return ['localhost', '127.0.0.1', '::1'].includes(new URL(url).hostname);
  } catch {
    return false;
  }
}

describe('integration: 同じ支払いの注文確定が並行したとき', () => {
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

  // pg の型は any で受ける（既存の DB 結合テストに合わせる）。
  let clientA: any;
  let clientB: any;

  beforeAll(async () => {
    clientA = new Client({ connectionString: DATABASE_URL });
    clientB = new Client({ connectionString: DATABASE_URL });
    await clientA.connect();
    await clientB.connect();
  });

  afterAll(async () => {
    if (clientA) await clientA.end();
    if (clientB) await clientB.end();
  });

  /** 商品1点だけを含む draft を作る（在庫はバリアント側なのでここでは持たない）。 */
  async function createFixture(client: any) {
    const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const itemName = `race-test-${suffix}`;

    const item = await client.query(
      `insert into public.items (name, description, price, category, image_url, status)
       values ($1, '並行実行テスト用', 1000, 'TOPS', 'https://example.com/item.png', 'published')
       returning id`,
      [itemName],
    );
    const itemId = Number(item.rows[0].id);

    const itemsSnapshot = [
      {
        item_id: itemId,
        item_name: itemName,
        item_price: 1000,
        item_image_url: 'https://example.com/item.png',
        color: null,
        size: null,
        quantity: 1,
        line_total: 1000,
      },
    ];

    const draft = await client.query(
      `insert into public.checkout_drafts
         (session_id, payment_method, subtotal_amount, shipping_amount, total_amount, currency,
          shipping_snapshot, items_snapshot)
       values ($1, 'stripe_card', 1000, 0, 1000, 'jpy', $2::jsonb, $3::jsonb)
       returning id`,
      [
        `race-session-${suffix}`,
        JSON.stringify({
          email: 'race@example.com',
          fullName: 'テスト太郎',
          postalCode: '1000001',
          prefecture: '東京都',
          city: '千代田区',
          address: '1-1-1',
          building: null,
          phone: '0300000000',
        }),
        JSON.stringify(itemsSnapshot),
      ],
    );

    return {
      itemId,
      draftId: draft.rows[0].id,
      paymentIntentId: `pi_race_${suffix}`,
      checkoutSessionId: `cs_race_${suffix}`,
    };
  }

  function finalize(client: any, fixture: any) {
    return client.query(
      `select order_id, order_status
       from public.finalize_order_from_checkout_draft(
         $1::uuid, $2::text, $3::text, $4::public.order_status, $5::integer, $6::text)`,
      [fixture.draftId, fixture.paymentIntentId, fixture.checkoutSessionId, 'paid', 1000, 'jpy'],
    );
  }

  /** 後発が行ロック待ちに入るまで待つ（先発が確定処理を終えた状態を作るため）。 */
  async function waitUntilWaitingForLock(observer: any, pid: number) {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const res = await observer.query(
        'select wait_event_type from pg_stat_activity where pid = $1',
        [pid],
      );
      if (res.rows[0]?.wait_event_type === 'Lock') return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('後発の呼び出しがロック待ちにならなかった');
  }

  test('後発は先発の注文を返す', async () => {
    const fixture = await createFixture(clientA);
    const bPid = (await clientB.query('select pg_backend_pid() as pid')).rows[0].pid;

    await clientA.query('begin');
    const first = await finalize(clientA, fixture);
    const firstOrderId = first.rows[0].order_id;

    // 後発。既存注文の確認では何も見つからず（先発が未コミット）、draft 行のロックで待つ。
    const secondOutcome = finalize(clientB, fixture).then(
      (res: any) => ({ status: 'fulfilled', orderId: res.rows[0]?.order_id }),
      (error: any) => ({ status: `rejected: ${error.message}`, orderId: null }),
    );

    let committed = false;
    try {
      await waitUntilWaitingForLock(clientA, bPid);
      await clientA.query('commit');
      committed = true;
    } finally {
      if (!committed) await clientA.query('rollback').catch(() => {});
    }

    const second: any = await secondOutcome;

    expect(second.status).toBe('fulfilled');
    expect(second.orderId).toBe(firstOrderId);

    const after = await clientA.query(
      `select (select count(*)::int from public.orders where payment_intent_id = $1) as orders,
              (select count(*)::int from public.order_items where order_id = $2) as order_items`,
      [fixture.paymentIntentId, firstOrderId],
    );
    expect(after.rows[0]).toEqual({ orders: 1, order_items: 1 });
  }, 60000);

  test('順番に2回呼んでも注文は1件だけ', async () => {
    const fixture = await createFixture(clientA);

    const first = await finalize(clientA, fixture);
    const second = await finalize(clientA, fixture);

    expect(second.rows[0].order_id).toBe(first.rows[0].order_id);

    const after = await clientA.query(
      `select (select count(*)::int from public.orders where payment_intent_id = $1) as orders`,
      [fixture.paymentIntentId],
    );
    expect(after.rows[0]).toEqual({ orders: 1 });
  }, 60000);
});
