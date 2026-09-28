/** @jest-environment node */
import { describeLocalDb, type PgClient } from './helpers/local-db';
import {
  createCatalogFixture,
  insertOrderWithStockLine,
  movementsOf,
  orderRow,
  revisionsOf,
  uniqueSuffix,
  variantStock,
} from './helpers/order-fixtures';

/**
 * 在庫を戻す RPC（設計書 4-1・4-5）。注文 ID で引き、明細ごとに確保した分だけ戻す（R-41）。
 * 実行者・理由・起因イベントを注文履歴に残す（R-18・R-43）。
 */
function release(
  db: PgClient,
  args: {
    orderId: string;
    expected: string;
    next: string;
    reason?: string;
    actor?: string | null;
    event?: string | null;
    cancelReason?: string | null;
    note?: string | null;
    notify?: boolean | null;
  },
) {
  return db.query(
    `select released, status::text as status
     from public.release_stock_for_unpaid_order(
       $1::uuid, $2::public.order_status, $3::public.order_status, $4::text,
       $5::uuid, $6::text, $7::text, $8::text, $9::boolean)`,
    [
      args.orderId,
      args.expected,
      args.next,
      args.reason ?? 'stripe_checkout_expired',
      args.actor ?? null,
      args.event ?? null,
      args.cancelReason ?? null,
      args.note ?? null,
      args.notify ?? null,
    ],
  );
}

describeLocalDb('integration: 注文 ID で引いて在庫を戻す', (db) => {
  test('支払い手続き中を放棄にし、確保した分だけ台帳へ戻して、履歴に理由と起因イベントを残す', async () => {
    const fx = await createCatalogFixture(db(), { stock: 5 });
    const { orderId } = await insertOrderWithStockLine(db(), {
      status: 'payment_in_progress', itemId: fx.itemId, variantId: fx.variantId, quantity: 2, reserved: true,
    });
    expect(await variantStock(db(), fx.variantId)).toBe(3);

    const res = await release(db(), { orderId, expected: 'payment_in_progress', next: 'abandoned', event: 'evt_expired_1' });

    expect(res.rows[0]).toEqual({ released: true, status: 'abandoned' });
    expect(await variantStock(db(), fx.variantId)).toBe(5);
    expect(await movementsOf(db(), fx.variantId)).toEqual([
      { delta: 5, reason: 'restock' },
      { delta: -2, reason: 'purchase' },
      { delta: 2, reason: 'cancel' },
    ]);
    expect(await revisionsOf(db(), orderId)).toEqual([
      { reason: 'stripe_checkout_expired', sourceEventId: 'evt_expired_1', changedBy: null },
    ]);
  });

  test('確保の記録が無い古い明細は戻さない（R-41）', async () => {
    const fx = await createCatalogFixture(db(), { stock: 1 });
    const { orderId } = await insertOrderWithStockLine(db(), {
      status: 'pending', itemId: fx.itemId, variantId: fx.variantId, quantity: 2, reserved: false,
      checkoutSessionId: null, paymentIntentId: `pi_${uniqueSuffix()}`,
    });

    const res = await release(db(), { orderId, expected: 'pending', next: 'failed', reason: 'stripe_voucher_expired' });

    expect(res.rows[0]).toEqual({ released: true, status: 'failed' });
    expect(await variantStock(db(), fx.variantId)).toBe(1);
    expect(await movementsOf(db(), fx.variantId)).toEqual([{ delta: 1, reason: 'restock' }]);
  });

  test('2回呼んでも2回目は released=false で、台帳は1回分だけ', async () => {
    const fx = await createCatalogFixture(db(), { stock: 3 });
    const { orderId } = await insertOrderWithStockLine(db(), {
      status: 'payment_in_progress', itemId: fx.itemId, variantId: fx.variantId, quantity: 1, reserved: true,
    });

    await release(db(), { orderId, expected: 'payment_in_progress', next: 'abandoned' });
    const second = await release(db(), { orderId, expected: 'payment_in_progress', next: 'abandoned' });

    expect(second.rows[0]).toEqual({ released: false, status: 'abandoned' });
    expect(await movementsOf(db(), fx.variantId)).toEqual([
      { delta: 3, reason: 'restock' },
      { delta: -1, reason: 'purchase' },
      { delta: 1, reason: 'cancel' },
    ]);
  });

  test('入金待ちからは放棄にできない（払込票を発行済みのため）', async () => {
    const fx = await createCatalogFixture(db(), { stock: 1 });
    const { orderId } = await insertOrderWithStockLine(db(), {
      status: 'pending', itemId: fx.itemId, variantId: fx.variantId, quantity: 1, reserved: true,
    });
    await expect(release(db(), { orderId, expected: 'pending', next: 'abandoned' }))
      .rejects.toMatchObject({ code: '22023', message: expect.stringContaining('ABANDON_REQUIRES_PAYMENT_IN_PROGRESS') });
    expect((await orderRow(db(), orderId)).status).toBe('pending');
  });

  // 実行者を使う2件だけをネストした describe にまとめる。order_revisions.changed_by は
  // auth.users への外部キーなので、架空の uuid ではなく実在の行を使う
  // （tests/integration/db/order_state_transition_hardening.integration.test.ts と同じやり方）。
  // afterAll は同じ階層内では登録順に実行される（describeLocalDb の afterAll が先に登録済み）ため、
  // ここに afterAll を置くと describeLocalDb が接続を閉じた後に動いてしまう。
  // ネストした describe の afterAll は親の afterAll より先に実行される（Jest の入れ子の順序）ので、
  // ここへ置いて後片付けが接続が閉じる前に必ず終わるようにする。
  describe('取消（実行者を使う）', () => {
    let ACTOR: string;

    beforeAll(async () => {
      const user = await db().query(
        `insert into auth.users (id, email, raw_user_meta_data, created_at, updated_at)
         values (gen_random_uuid(), $1, '{}'::jsonb, now(), now())
         returning id`,
        [`release-stock-by-order-${uniqueSuffix()}@example.com`],
      );
      ACTOR = user.rows[0].id as string;
    });

    afterAll(async () => {
      // profiles は ON DELETE CASCADE、order_revisions.changed_by は ON DELETE SET NULL なので、
      // このテストの検証が終わった後にここで削除すれば両方きれいに片付く。
      await db().query('DELETE FROM auth.users WHERE id = $1', [ACTOR]);
    });

    test('取消は実行者と理由が要り、理由・メモ・お知らせの有無と実行者が残る', async () => {
      const fx = await createCatalogFixture(db(), { stock: 2 });
      const { orderId } = await insertOrderWithStockLine(db(), {
        status: 'payment_in_progress', itemId: fx.itemId, variantId: fx.variantId, quantity: 1, reserved: true,
      });

      await expect(release(db(), { orderId, expected: 'payment_in_progress', next: 'cancelled' }))
        .rejects.toMatchObject({ code: '22023', message: expect.stringContaining('CANCEL_REQUIRES_ACTOR_AND_REASON') });

      const res = await release(db(), {
        orderId, expected: 'payment_in_progress', next: 'cancelled', reason: 'admin_cancel',
        actor: ACTOR, cancelReason: 'customer_request', note: '電話で依頼', notify: false,
      });

      expect(res.rows[0]).toEqual({ released: true, status: 'cancelled' });
      expect(await orderRow(db(), orderId)).toMatchObject({
        status: 'cancelled', cancel_reason: 'customer_request', cancel_note: '電話で依頼', cancel_notify_customer: false,
      });
      expect(await revisionsOf(db(), orderId)).toEqual([
        { reason: 'admin_cancel', sourceEventId: null, changedBy: ACTOR },
      ]);
    });

    test('取消の理由が「その他」ならメモが要る', async () => {
      const fx = await createCatalogFixture(db(), { stock: 1 });
      const { orderId } = await insertOrderWithStockLine(db(), {
        status: 'payment_in_progress', itemId: fx.itemId, variantId: fx.variantId, quantity: 1, reserved: true,
      });

      await expect(release(db(), {
        orderId, expected: 'payment_in_progress', next: 'cancelled', reason: 'admin_cancel',
        actor: ACTOR, cancelReason: 'other', note: '  ', notify: true,
      })).rejects.toMatchObject({ code: '22023', message: expect.stringContaining('CANCEL_NOTE_REQUIRED') });
      expect((await orderRow(db(), orderId)).status).toBe('payment_in_progress');
    });
  });

  test('期待する状態と違えば何もしない', async () => {
    const fx = await createCatalogFixture(db(), { stock: 1 });
    const { orderId } = await insertOrderWithStockLine(db(), {
      status: 'paid', itemId: fx.itemId, variantId: fx.variantId, quantity: 1, reserved: true,
      paymentIntentId: `pi_${uniqueSuffix()}`,
    });
    const res = await release(db(), { orderId, expected: 'pending', next: 'failed' });
    expect(res.rows[0]).toEqual({ released: false, status: 'paid' });
    expect(await variantStock(db(), fx.variantId)).toBe(0);
  });

  test.each([['pending'], ['paid'], ['shipped'], ['payment_in_progress'], [null]])(
    '行き先 %s は拒否し、注文も在庫も変えない',
    async (next) => {
      const fx = await createCatalogFixture(db(), { stock: 1 });
      const { orderId } = await insertOrderWithStockLine(db(), {
        status: 'payment_in_progress', itemId: fx.itemId, variantId: fx.variantId, quantity: 1, reserved: true,
      });

      await expect(release(db(), { orderId, expected: 'payment_in_progress', next: next as string }))
        .rejects.toMatchObject({ code: '22023', message: expect.stringContaining('INVALID_NEXT_STATUS') });
      expect((await orderRow(db(), orderId)).status).toBe('payment_in_progress');
      expect(await variantStock(db(), fx.variantId)).toBe(0);
    },
  );

  test('anon・authenticated は実行できない', async () => {
    const signature =
      'public.release_stock_for_unpaid_order(uuid,public.order_status,public.order_status,text,uuid,text,text,text,boolean)';
    for (const role of ['anon', 'authenticated']) {
      const res = await db().query('select has_function_privilege($1, $2, $3) as allowed', [role, signature, 'EXECUTE']);
      expect(res.rows[0].allowed).toBe(false);
    }
  });
});
