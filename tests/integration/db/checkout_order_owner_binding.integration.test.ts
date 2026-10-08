/** @jest-environment node */
import { describeLocalDb, type PgClient } from './helpers/local-db';
import { createCatalogFixture, createDraft, uniqueSuffix } from './helpers/order-fixtures';

async function createMember(db: PgClient, label: string): Promise<string> {
  const result = await db.query(
    `insert into auth.users (id, email, raw_user_meta_data, created_at, updated_at)
     values (gen_random_uuid(), $1, '{}'::jsonb, now(), now()) returning id`,
    [`owner-binding-${label}-${uniqueSuffix()}@example.com`],
  );
  return result.rows[0].id as string;
}

async function placeFromFinalScreen(
  db: PgClient,
  draft: { draftId: string; cartSessionId: string; checkoutSessionId: string; totalAmount: number },
  buyerUserId: string | null,
) {
  const result = await db.query(
    `select * from public.place_order_from_checkout_draft(
       _draft_id => $1, _checkout_session_id => $2, _cart_session_id => $3,
       _stripe_amount_total => $4, _stripe_amount_discount => 0, _stripe_currency => 'jpy',
       _checkout_session_created_at => now(), _payment_intent_id => null,
       _shown_in_stock_variant_ids => array[]::bigint[], _buyer_user_id => $5)`,
    [draft.draftId, draft.checkoutSessionId, draft.cartSessionId, draft.totalAmount, buyerUserId],
  );
  return result.rows[0] as { order_id: string | null; order_status: string | null; created: boolean; rejection: string | null };
}

async function placeFromReconciler(
  db: PgClient,
  draft: { draftId: string; cartSessionId: string; checkoutSessionId: string; totalAmount: number },
) {
  const result = await db.query(
    `select * from public.place_order_from_checkout_draft(
       _draft_id => $1, _checkout_session_id => $2, _cart_session_id => $3,
       _stripe_amount_total => $4, _stripe_amount_discount => 0, _stripe_currency => 'jpy',
       _checkout_session_created_at => now(), _payment_intent_id => null)`,
    [draft.draftId, draft.checkoutSessionId, draft.cartSessionId, draft.totalAmount],
  );
  return result.rows[0] as { order_id: string | null; rejection: string | null };
}

async function ownerOf(db: PgClient, orderId: string): Promise<string | null> {
  const result = await db.query('select user_id from public.orders where id = $1', [orderId]);
  return (result.rows[0]?.user_id as string | null) ?? null;
}

describeLocalDb('integration: 注文の持ち主の確かめ（グループ C）', (db) => {
  // 会員を消す後片付けは、describeLocalDb が DB 接続を閉じる前に動かすためネストに置く。
  describe('買い手と持ち主の決まり', () => {
    const members: string[] = [];
    afterAll(async () => {
      for (const id of members) await db().query('delete from auth.users where id = $1', [id]);
    });
    async function member(label: string) {
      const id = await createMember(db(), label);
      members.push(id);
      return id;
    }

    test('「注文する」の買い手が下書きと同じなら、注文を作るのと同時に持ち主を書く', async () => {
      const buyer = await member('same');
      const { itemId } = await createCatalogFixture(db(), { stock: 0 });
      const draft = await createDraft(db(), { itemId, buyerUserId: buyer });
      const row = await placeFromFinalScreen(db(), draft, buyer);
      expect(row.rejection).toBeNull();
      expect(row.created).toBe(true);
      expect(row.order_id).not.toBeNull();
      expect(await ownerOf(db(), row.order_id as string)).toBe(buyer);
    });

    test('ゲストなら持ち主は空', async () => {
      const { itemId } = await createCatalogFixture(db(), { stock: 0 });
      const draft = await createDraft(db(), { itemId });
      const row = await placeFromFinalScreen(db(), draft, null);
      expect(row.rejection).toBeNull();
      expect(row.order_id).not.toBeNull();
      expect(await ownerOf(db(), row.order_id as string)).toBeNull();
    });

    test('買い手が違えば login_changed で断り、注文も在庫の確保も作らない', async () => {
      const recorded = await member('recorded');
      const other = await member('other');
      const { itemId, variantId } = await createCatalogFixture(db(), { stock: 3 });
      const draft = await createDraft(db(), { itemId, buyerUserId: recorded });
      for (const buyer of [other, null]) {
        const row = await placeFromFinalScreen(db(), draft, buyer);
        expect(row).toMatchObject({ order_id: null, created: false, rejection: 'login_changed' });
      }
      const guestDraft = await createDraft(db(), { itemId });
      expect((await placeFromFinalScreen(db(), guestDraft, recorded)).rejection).toBe('login_changed');
      const orders = await db().query('select count(*)::int as n from public.orders where checkout_session_id = any($1)', [[draft.checkoutSessionId, guestDraft.checkoutSessionId]]);
      expect(orders.rows[0].n).toBe(0);
      const stock = await db().query('select stock_quantity from public.item_variants where id = $1', [variantId]);
      expect(stock.rows[0].stock_quantity).toBe(3);
    });

    test('同じ買い手の2回目は同じ注文を返し、違う買い手には注文の ID を返さない', async () => {
      const buyer = await member('retry');
      const other = await member('retry-other');
      const { itemId } = await createCatalogFixture(db(), { stock: 0 });
      const draft = await createDraft(db(), { itemId, buyerUserId: buyer });
      const first = await placeFromFinalScreen(db(), draft, buyer);
      expect(first).toMatchObject({ created: true, rejection: null });
      expect(first.order_id).not.toBeNull();
      const second = await placeFromFinalScreen(db(), draft, buyer);
      expect(second).toMatchObject({ order_id: first.order_id, created: false, rejection: null });
      expect(second.order_id).not.toBeNull();
      expect(await placeFromFinalScreen(db(), draft, other)).toMatchObject({ order_id: null, rejection: 'login_changed' });
    });

    test('下書きの行が無い時は、既にある注文の持ち主と比べる', async () => {
      const buyer = await member('no-draft');
      const other = await member('no-draft-other');
      const { itemId } = await createCatalogFixture(db(), { stock: 0 });
      const draft = await createDraft(db(), { itemId, buyerUserId: buyer });
      const first = await placeFromFinalScreen(db(), draft, buyer);
      expect(first).toMatchObject({ created: true, rejection: null });
      expect(first.order_id).not.toBeNull();
      await db().query('delete from public.checkout_drafts where id = $1', [draft.draftId]);
      expect(await placeFromFinalScreen(db(), draft, other)).toMatchObject({ order_id: null, rejection: 'login_changed' });
      const retried = await placeFromFinalScreen(db(), draft, buyer);
      expect(retried).toMatchObject({ order_id: first.order_id, created: false, rejection: null });
      expect(retried.order_id).not.toBeNull();
    });

    test('下書きと Session・カートの組み合わせが違う時は、既存注文の持ち主と比べて別の買い手に ID を返さない', async () => {
      const buyer = await member('mixed-draft');
      const other = await member('mixed-draft-other');
      const { itemId } = await createCatalogFixture(db(), { stock: 0 });
      const firstDraft = await createDraft(db(), { itemId, buyerUserId: buyer });
      const first = await placeFromFinalScreen(db(), firstDraft, buyer);
      expect(first).toMatchObject({ created: true, rejection: null });
      expect(first.order_id).not.toBeNull();
      expect(await ownerOf(db(), first.order_id as string)).toBe(buyer);
      const secondDraft = await createDraft(db(), { itemId, buyerUserId: buyer });
      const otherDraft = await createDraft(db(), { itemId, buyerUserId: other });

      // 同じ買い手の別の下書きと、別の買い手の下書きのどちらでも、Session 1 の注文の持ち主を基準にする。
      for (const mismatchedDraft of [
        { ...secondDraft, checkoutSessionId: firstDraft.checkoutSessionId },
        { ...otherDraft, checkoutSessionId: firstDraft.checkoutSessionId },
        { ...firstDraft, cartSessionId: secondDraft.cartSessionId },
      ]) {
        expect(await placeFromFinalScreen(db(), mismatchedDraft, other)).toMatchObject({
          order_id: null, order_status: null, created: false, rejection: 'login_changed',
        });
        const retried = await placeFromFinalScreen(db(), mismatchedDraft, buyer);
        expect(retried).toMatchObject({ order_id: first.order_id, created: false, rejection: null });
        expect(retried.order_id).not.toBeNull();
      }

      // 照合で作った注文が後から会員に紐付いた場合も、カートが違えば下書きの買い手を使わない。
      const reconciled = await placeFromReconciler(db(), otherDraft);
      expect(reconciled.rejection).toBeNull();
      expect(reconciled.order_id).not.toBeNull();
      expect(await ownerOf(db(), reconciled.order_id as string)).toBeNull();
      await db().query('update public.orders set user_id = $1 where id = $2', [buyer, reconciled.order_id]);
      expect(await ownerOf(db(), reconciled.order_id as string)).toBe(buyer);
      const mismatchedCart = { ...otherDraft, cartSessionId: secondDraft.cartSessionId };
      expect(await placeFromFinalScreen(db(), mismatchedCart, other)).toMatchObject({
        order_id: null, order_status: null, created: false, rejection: 'login_changed',
      });
      const retried = await placeFromFinalScreen(db(), mismatchedCart, buyer);
      expect(retried).toMatchObject({ order_id: reconciled.order_id, created: false, rejection: null });
      expect(retried.order_id).not.toBeNull();
    });

    test('照合の経路（「注文する」を通らない支払い）では、下書きに買い手があっても持ち主を付けない', async () => {
      const buyer = await member('reconciler');
      const { itemId } = await createCatalogFixture(db(), { stock: 0 });
      const draft = await createDraft(db(), { itemId, buyerUserId: buyer });
      const row = await placeFromReconciler(db(), draft);
      expect(row.rejection).toBeNull();
      expect(row.order_id).not.toBeNull();
      expect(await ownerOf(db(), row.order_id as string)).toBeNull();
    });

    test('照合の経路に買い手を渡すと、既存注文があっても 22023 の例外で断る', async () => {
      const buyer = await member('reconciler-buyer');
      const { itemId } = await createCatalogFixture(db(), { stock: 0 });
      const draft = await createDraft(db(), { itemId, buyerUserId: buyer });
      const ordered = await placeFromFinalScreen(db(), draft, buyer);
      expect(ordered).toMatchObject({ created: true, rejection: null });
      expect(ordered.order_id).not.toBeNull();
      await expect(db().query(
        `select * from public.place_order_from_checkout_draft(
           _draft_id => $1, _checkout_session_id => $2, _cart_session_id => $3,
           _stripe_amount_total => $4, _stripe_amount_discount => 0, _stripe_currency => 'jpy',
           _checkout_session_created_at => now(), _payment_intent_id => null,
           _shown_in_stock_variant_ids => null, _buyer_user_id => $5)`,
        [draft.draftId, draft.checkoutSessionId, draft.cartSessionId, draft.totalAmount, buyer],
      )).rejects.toMatchObject({ message: 'PLACE_ORDER_ARGUMENT_REQUIRED', code: '22023' });
    });

    test('15引数の claim と10引数の受付は anon・authenticated が実行できず service_role だけ実行できる', async () => {
      const signatures = [
        'public.claim_checkout_draft(text,smallint,text,text,text,text,text,integer,integer,integer,integer,jsonb,jsonb,uuid,uuid)',
        'public.place_order_from_checkout_draft(uuid,text,text,integer,integer,text,timestamptz,text,bigint[],uuid)',
      ];
      for (const signature of signatures) {
        const result = await db().query(
          `select has_function_privilege('anon', $1::text, 'EXECUTE') as anon,
                  has_function_privilege('authenticated', $1::text, 'EXECUTE') as authenticated,
                  has_function_privilege('service_role', $1::text, 'EXECUTE') as service_role`,
          [signature],
        );
        expect(result.rows[0]).toEqual({ anon: false, authenticated: false, service_role: true });
      }
    });

    test('下書きの買い手は後から変えられない（空から会員へも）', async () => {
      const buyer = await member('immutable');
      const { itemId } = await createCatalogFixture(db(), { stock: 0 });
      const guestDraft = await createDraft(db(), { itemId });
      await expect(
        db().query('update public.checkout_drafts set buyer_user_id = $1 where id = $2', [buyer, guestDraft.draftId]),
      ).rejects.toThrow('CHECKOUT_DRAFT_BUYER_IMMUTABLE');
      const memberDraft = await createDraft(db(), { itemId, buyerUserId: buyer });
      await expect(
        db().query('update public.checkout_drafts set buyer_user_id = null where id = $1', [memberDraft.draftId]),
      ).rejects.toThrow('CHECKOUT_DRAFT_BUYER_IMMUTABLE');
    });

    test('注文の持ち主: 空から会員へは書け、別の会員へも空へも付け替えられない', async () => {
      const owner = await member('owner');
      const other = await member('owner-other');
      const { itemId } = await createCatalogFixture(db(), { stock: 0 });
      const row = await placeFromFinalScreen(db(), await createDraft(db(), { itemId }), null);
      expect(row).toMatchObject({ created: true, rejection: null });
      expect(row.order_id).not.toBeNull();
      const orderId = row.order_id as string;
      await db().query('update public.orders set user_id = $1 where id = $2', [owner, orderId]);
      expect(await ownerOf(db(), orderId)).toBe(owner);
      await expect(db().query('update public.orders set user_id = $1 where id = $2', [other, orderId])).rejects.toThrow('ORDER_OWNER_IMMUTABLE');
      await expect(db().query('update public.orders set user_id = null where id = $1', [orderId])).rejects.toThrow('ORDER_OWNER_IMMUTABLE');
    });

    test('profiles の行だけを消そうとしても auth.users が残る間は断り、注文の持ち主を保つ', async () => {
      const buyer = await member('profile-only');
      const { itemId } = await createCatalogFixture(db(), { stock: 0 });
      const ordered = await placeFromFinalScreen(db(), await createDraft(db(), { itemId, buyerUserId: buyer }), buyer);
      expect(ordered).toMatchObject({ created: true, rejection: null });
      expect(ordered.order_id).not.toBeNull();

      await expect(db().query('delete from public.profiles where user_id = $1', [buyer]))
        .rejects.toMatchObject({ message: 'ORDER_OWNER_IMMUTABLE', code: '23514' });

      expect(await ownerOf(db(), ordered.order_id as string)).toBe(buyer);
      const remaining = await db().query(
        `select exists(select 1 from auth.users where id = $1) as account_exists,
                exists(select 1 from public.profiles where user_id = $1) as profile_exists`,
        [buyer],
      );
      expect(remaining.rows[0]).toEqual({ account_exists: true, profile_exists: true });
    });

    test('会員を消すと注文の持ち主は空になり、その会員の下書きでは誰も注文できない', async () => {
      const leaving = await createMember(db(), 'leaving');
      const { itemId } = await createCatalogFixture(db(), { stock: 0 });
      const ordered = await placeFromFinalScreen(db(), await createDraft(db(), { itemId, buyerUserId: leaving }), leaving);
      expect(ordered).toMatchObject({ created: true, rejection: null });
      expect(ordered.order_id).not.toBeNull();
      expect(await ownerOf(db(), ordered.order_id as string)).toBe(leaving);
      const pendingDraft = await createDraft(db(), { itemId, buyerUserId: leaving });
      await db().query('delete from auth.users where id = $1', [leaving]);
      const remaining = await db().query('select count(*)::int as n from public.orders where id = $1', [ordered.order_id]);
      expect(remaining.rows[0].n).toBe(1);
      expect(await ownerOf(db(), ordered.order_id as string)).toBeNull();
      expect((await placeFromFinalScreen(db(), pendingDraft, null)).rejection).toBe('login_changed');
    });

    test('下書きを取る関数は買い手を書き、同じ見分けの値で買い手が違えば例外', async () => {
      const buyer = await member('claim');
      const other = await member('claim-other');
      const sessionId = `fx-claim-${uniqueSuffix()}`;
      const fingerprint = `v3:${'a'.repeat(64)}`;
      const claim = (buyerUserId: string | null) => db().query(
        `select * from public.claim_checkout_draft(
           $1, 3::smallint, $2, 'custom', 'http://localhost:3000', 'stripe_card', 'jpy',
           5000, 0, 0, 5000, '{}'::jsonb,
           '[{"item_id":1,"item_name":"x","item_price":5000,"quantity":1,"line_total":5000}]'::jsonb, $3, _cart_id => null)`,
        [sessionId, fingerprint, buyerUserId],
      );
      const created = await claim(buyer);
      const draftId = created.rows[0].id as string;
      const stored = await db().query('select buyer_user_id from public.checkout_drafts where id = $1', [draftId]);
      expect(stored.rows[0].buyer_user_id).toBe(buyer);
      expect((await claim(buyer)).rows[0].id).toBe(draftId);
      await expect(claim(other)).rejects.toThrow('CHECKOUT_DRAFT_BUYER_MISMATCH');
      await expect(claim(null)).rejects.toThrow('CHECKOUT_DRAFT_BUYER_MISMATCH');
    });
  });
});
