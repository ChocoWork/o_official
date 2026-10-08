/** @jest-environment node */
import { createHash } from 'crypto';
import { describeLocalDb, type PgClient } from './helpers/local-db';
import { createCatalogFixture, createDraft, PRICE, uniqueSuffix } from './helpers/order-fixtures';

function fingerprint(seed: string): string {
  return `v3:${createHash('sha256').update(seed).digest('hex')}`;
}

function claim(db: PgClient, params: { sessionId: string; seed: string; cartId: string | null; items: unknown[] }) {
  return db.query(
    `select * from public.claim_checkout_draft(
       _session_id => $1, _request_version => 3::smallint, _request_fingerprint => $2,
       _checkout_ui_mode => 'custom', _checkout_origin => 'http://localhost:3000', _payment_method => 'stripe_card',
       _currency => 'jpy', _subtotal_amount => $3, _tax_amount => 0, _shipping_amount => 0, _total_amount => $3,
       _shipping_snapshot => '{}'::jsonb, _items_snapshot => $4::jsonb, _buyer_user_id => null, _cart_id => $5)`,
    [params.sessionId, fingerprint(params.seed), PRICE, JSON.stringify(params.items), params.cartId],
  );
}

function placeFromFinalScreen(db: PgClient, draft: { draftId: string; cartSessionId: string; checkoutSessionId: string; totalAmount: number }) {
  return db.query(
    `select * from public.place_order_from_checkout_draft(
       _draft_id => $1, _checkout_session_id => $2, _cart_session_id => $3,
       _stripe_amount_total => $4, _stripe_amount_discount => 0, _stripe_currency => 'jpy',
       _checkout_session_created_at => now(), _payment_intent_id => null,
       _shown_in_stock_variant_ids => array[]::bigint[], _buyer_user_id => null)`,
    [draft.draftId, draft.checkoutSessionId, draft.cartSessionId, draft.totalAmount],
  );
}

describeLocalDb('integration: 新しいカートと決済の関数', (db) => {
  test('下書きを取る関数は cart_id を記録し、同じ下書きを違うカートで取ると断る', async () => {
    const fx = await createCatalogFixture(db(), { stock: 0 });
    const first = await db().query("insert into public.carts (guest_token_hash) values (encode(sha256(convert_to($1, 'UTF8')), 'hex')) returning id", [`a-${uniqueSuffix()}`]);
    const second = await db().query("insert into public.carts (guest_token_hash) values (encode(sha256(convert_to($1, 'UTF8')), 'hex')) returning id", [`b-${uniqueSuffix()}`]);
    const items = [{ item_id: fx.itemId, item_name: '照合テスト', item_price: PRICE, item_image_url: null, color: fx.colorName, size: fx.sizeLabel, quantity: 1, line_total: PRICE, source_cart_line_id: null }];
    const sessionId = `claim-cart-${uniqueSuffix()}`;
    const claimed = await claim(db(), { sessionId, seed: sessionId, cartId: first.rows[0].id, items });
    const draft = await db().query('select cart_id from public.checkout_drafts where id = $1', [claimed.rows[0].id]);
    expect(draft.rows[0].cart_id).toBe(first.rows[0].id);
    await expect(claim(db(), { sessionId, seed: sessionId, cartId: second.rows[0].id, items })).rejects.toMatchObject({ message: 'CHECKOUT_DRAFT_CART_MISMATCH' });
  });

  test('下書きを取る関数は15引数の1本だけで、service_role だけが実行できる', async () => {
    const versions = await db().query(
      `select p.oid::regprocedure::text as signature
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'claim_checkout_draft'`,
    );
    expect(versions.rows.map((row) => row.signature)).toEqual([
      'claim_checkout_draft(text,smallint,text,text,text,text,text,integer,integer,integer,integer,jsonb,jsonb,uuid,uuid)',
    ]);
    const signature = 'public.claim_checkout_draft(text,smallint,text,text,text,text,text,integer,integer,integer,integer,jsonb,jsonb,uuid,uuid)';
    const privileges = await db().query(
      `select has_function_privilege('anon', $1, 'EXECUTE') as anon,
              has_function_privilege('authenticated', $1, 'EXECUTE') as authenticated,
              has_function_privilege('service_role', $1, 'EXECUTE') as service`,
      [signature],
    );
    expect(privileges.rows[0]).toEqual({ anon: false, authenticated: false, service: true });
  });

  test('「注文する」は、下書きの明細がカートに残っていれば受け付け、消えていれば cart_changed', async () => {
    const fx = await createCatalogFixture(db(), { stock: 2 });
    const kept = await createDraft(db(), { itemId: fx.itemId, quantity: 1 });
    const keptResult = await placeFromFinalScreen(db(), kept);
    expect(keptResult.rows[0]).toMatchObject({ created: true, rejection: null });

    const removed = await createDraft(db(), { itemId: fx.itemId, quantity: 1 });
    await db().query('delete from public.cart_lines where id = $1', [removed.cartLineId]);
    const removedResult = await placeFromFinalScreen(db(), removed);
    expect(removedResult.rows[0]).toMatchObject({ order_id: null, created: false, rejection: 'cart_changed' });
  });

  test('cart_id の無い下書きで明細の参照があれば cart_changed', async () => {
    const fx = await createCatalogFixture(db(), { stock: 2 });
    const draft = await createDraft(db(), { itemId: fx.itemId, quantity: 1 });
    await db().query('update public.checkout_drafts set cart_id = null where id = $1', [draft.draftId]);
    const result = await placeFromFinalScreen(db(), draft);
    expect(result.rows[0]).toMatchObject({ created: false, rejection: 'cart_changed' });
  });

  test('支払いの後は、下書きのカートから写しの明細だけを消し、後から足した明細は残す', async () => {
    const fx = await createCatalogFixture(db(), { stock: 2 });
    const later = await createCatalogFixture(db(), { stock: 0 });
    const draft = await createDraft(db(), { itemId: fx.itemId, quantity: 1 });
    const extra = await db().query('insert into public.cart_lines (cart_id, variant_id, quantity) values ($1, $2, 1) returning id', [draft.cartId, later.variantId]);
    const placed = await placeFromFinalScreen(db(), draft);
    await db().query(
      "select updated from public.mark_order_awaiting_payment($1::uuid, $2::text, $3::text)",
      [placed.rows[0].order_id, `pi_${uniqueSuffix()}`, null],
    );
    const lines = await db().query('select id from public.cart_lines where cart_id = $1', [draft.cartId]);
    expect(lines.rows.map((row) => row.id)).toEqual([extra.rows[0].id]);
  });
});
