/** @jest-environment node */
export {};

const { Client } = require('pg');

/**
 * 商品行のロック順（FREQ-364、レビュー指摘⑮）。
 *
 * 注文確定（finalize_order_from_checkout_draft）と在庫復元（release_stock_for_unpaid_order）が
 * 同じ商品を別々の順でロックすると、同時に走ったときデッドロックになる。どちらも
 * 商品 id の昇順でロックすることを、実際にロックを取らせて確かめる。
 *
 * 確かめ方: k 番目の商品行を別セッションで先にロックしておき、関数を呼ぶ。関数はそこで
 * 止まるので、他の行を FOR UPDATE NOWAIT で突く。昇順なら「k より小さい行だけがロック済み、
 * 大きい行は空き」になる。k を変えて全件試せば、昇順であることが確定する。
 *
 * 実行方法（ローカル Supabase を起動しておく: npm run db:start）:
 *   DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
 *     npx jest tests/integration/db/item_lock_order
 *
 * 注意: 試験用の注文は削除禁止トリガーで消せない。使い捨てのローカル DB でだけ動かす。
 */

const DATABASE_URL = process.env.DATABASE_URL;
const ITEM_COUNT = 4;

function isLocalDatabase(url: string): boolean {
  try {
    return ['localhost', '127.0.0.1', '::1'].includes(new URL(url).hostname);
  } catch {
    return false;
  }
}

describe('integration: 商品行のロック順', () => {
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

  // 呼び出す側・先にロックしておく側・空きを突く側の3接続。
  let runner: any;
  let blocker: any;
  let prober: any;
  let runnerPid = 0;

  beforeAll(async () => {
    runner = new Client({ connectionString: DATABASE_URL });
    blocker = new Client({ connectionString: DATABASE_URL });
    prober = new Client({ connectionString: DATABASE_URL });
    await runner.connect();
    await blocker.connect();
    await prober.connect();
    runnerPid = (await runner.query('select pg_backend_pid() as pid')).rows[0].pid;
  });

  afterAll(async () => {
    if (runner) await runner.end();
    if (blocker) await blocker.end();
    if (prober) await prober.end();
  });

  /** 昇順の id を持つ商品を作る。物理的な並び順は入れ替えておく（並び順に依存しないことを見るため）。 */
  async function createItems(count: number): Promise<number[]> {
    const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const inserted = await prober.query(
      `insert into public.items (name, description, price, category, image_url, status)
       select 'lockorder-' || $1::text || '-' || g::text, 'ロック順テスト', 1000, 'TOPS',
              'https://example.com/item.png', 'published'
       from generate_series(1, $2::int) g
       returning id`,
      [suffix, count],
    );
    const ids = inserted.rows.map((row: { id: string }) => Number(row.id)).sort((a: number, b: number) => a - b);

    // 更新した行はテーブルの末尾へ移るので、id 順とは違う物理順にできる。
    for (const index of [2, 0, 3, 1].filter((i) => i < ids.length)) {
      await prober.query('update public.items set updated_at = now() where id = $1', [ids[index]]);
    }

    return ids;
  }

  async function createDraft(ids: number[]): Promise<{ draftId: string; paymentIntentId: string }> {
    const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    // draft の明細は id の降順で並べる（入力順にも依存しないことを見るため）。
    const itemsSnapshot = [...ids].reverse().map((itemId) => ({
      item_id: itemId,
      item_name: 'ロック順テスト',
      item_price: 1000,
      item_image_url: 'https://example.com/item.png',
      color: null,
      size: null,
      quantity: 1,
      line_total: 1000,
    }));

    const draft = await prober.query(
      `insert into public.checkout_drafts
         (session_id, payment_method, subtotal_amount, shipping_amount, total_amount, currency,
          shipping_snapshot, items_snapshot)
       values ($1, 'stripe_card', $2, 0, $2, 'jpy', $3::jsonb, $4::jsonb)
       returning id`,
      [
        `lockorder-session-${suffix}`,
        1000 * ids.length,
        JSON.stringify({ email: 'lockorder@example.com', fullName: 'テスト太郎' }),
        JSON.stringify(itemsSnapshot),
      ],
    );

    return { draftId: draft.rows[0].id, paymentIntentId: `pi_lockorder_${suffix}` };
  }

  async function createPendingOrder(ids: number[]): Promise<string> {
    const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const total = 1000 * ids.length;
    const order = await prober.query(
      `insert into public.orders
         (session_id, payment_intent_id, status, subtotal_amount, shipping_amount, total_amount, currency)
       values ($1, $2, 'pending', $3, 0, $3, 'jpy')
       returning id, payment_intent_id`,
      [`lockorder-session-${suffix}`, `pi_lockorder_pending_${suffix}`, total],
    );

    await prober.query(
      `insert into public.order_items (order_id, item_id, item_name, item_price, quantity, line_total)
       select $1, x, 'ロック順テスト', 1000, 1, 1000 from unnest($2::bigint[]) x`,
      [order.rows[0].id, ids],
    );

    return order.rows[0].payment_intent_id;
  }

  async function waitUntilWaitingForLock(pid: number) {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const res = await prober.query(
        'select wait_event_type from pg_stat_activity where pid = $1',
        [pid],
      );
      if (res.rows[0]?.wait_event_type === 'Lock') return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('関数の呼び出しがロック待ちにならなかった');
  }

  /** ロック済みの行と空いている行を調べる。 */
  async function probeLocks(ids: number[], blockedId: number) {
    const locked: number[] = [];
    const free: number[] = [];

    for (const id of ids) {
      if (id === blockedId) continue;
      try {
        await prober.query('begin');
        await prober.query('select 1 from public.items where id = $1 for update nowait', [id]);
        free.push(id);
        await prober.query('rollback');
      } catch (error: any) {
        await prober.query('rollback').catch(() => {});
        if (error.code !== '55P03') throw error;
        locked.push(id);
      }
    }

    return { locked, free };
  }

  /**
   * k 番目の行を先にロックした状態で関数を呼び、k より小さい行だけがロック済みであることを
   * すべての k について確かめる。これが成り立つことと「id の昇順でロックする」ことは同値。
   */
  async function expectAscendingLockOrder(ids: number[], call: () => Promise<unknown>) {
    for (let k = 0; k < ids.length; k += 1) {
      await blocker.query('begin');
      await blocker.query('select 1 from public.items where id = $1 for update', [ids[k]]);

      const running = call().catch((error: unknown) => error);
      await waitUntilWaitingForLock(runnerPid);

      const { locked, free } = await probeLocks(ids, ids[k]);

      // 呼び出しを途中で打ち切る（注文を作らせない）。
      await prober.query('select pg_cancel_backend($1)', [runnerPid]);
      await running;
      await blocker.query('rollback');

      expect({ k, locked, free }).toEqual({
        k,
        locked: ids.slice(0, k),
        free: ids.slice(k + 1),
      });
    }
  }

  test('注文確定は商品 id の昇順でロックする', async () => {
    const ids = await createItems(ITEM_COUNT);
    const { draftId, paymentIntentId } = await createDraft(ids);

    await expectAscendingLockOrder(ids, () =>
      runner.query(
        `select order_id from public.finalize_order_from_checkout_draft(
           $1::uuid, $2::text, $3::text, $4::public.order_status, $5::integer, $6::text)`,
        [draftId, paymentIntentId, 'cs_lockorder', 'paid', 1000 * ids.length, 'jpy'],
      ),
    );
  }, 120000);

  /**
   * 在庫復元は items を書かなくなったのでロックも取らない（FREQ-401）。
   * 在庫の正はバリアントなので、戻すのは台帳への追記だけ。
   */
  test('在庫復元は商品行をロックしない', async () => {
    const ids = await createItems(ITEM_COUNT);
    const paymentIntentId = await createPendingOrder(ids);

    // 別の接続で全商品行を占有したまま在庫復元を呼び、待たずに終わることを確かめる。
    try {
      await blocker.query('BEGIN');
      await blocker.query(`select id from public.items where id = any($1::bigint[]) for update`, [ids]);

      const released = await runner.query(
        `select released from public.release_stock_for_unpaid_order($1::text, $2::public.order_status)`,
        [paymentIntentId, 'failed'],
      );

      expect(released.rows[0].released).toBe(true);
    } finally {
      await blocker.query('ROLLBACK');
    }
  }, 120000);
});
