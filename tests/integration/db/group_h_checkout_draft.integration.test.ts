/** @jest-environment node */
import { createHash, randomUUID } from 'node:crypto';
import { describeLocalDb } from './helpers/local-db';
import { createCatalogFixture } from './helpers/order-fixtures';
import { hDiscount, hRpc, hFailure, seedHDiscount, seedHMember } from './helpers/group-h-fixtures';
import { calculateDiscounts } from '@/lib/discounts/discount-engine';
import type { DiscountDefinition, DiscountFacts, DiscountRefusal } from '@/lib/discounts/discount-types';
import type { CheckoutDiscountClaim, CheckoutDiscountDraft } from '@/features/checkout/services/checkout-draft.service';
import { checkoutDiscountSnapshotHash } from '@/features/checkout/services/checkout-discounts.service';
jest.mock('server-only', () => ({}), { virtual: true });
jest.mock('@/lib/audit', () => ({ logAudit: jest.fn() }));

describeLocalDb('H3 frozen checkout draft (controller only)', db => {
  beforeEach(async () => { await db().query('begin'); await db().query('select pg_advisory_xact_lock(190521,1)'); });
  afterEach(async () => { await db().query('rollback'); });

  async function fixture(withDiscount = true) {
    const catalog = await createCatalogFixture(db());
    await db().query('update public.items set price=20000 where id=$1', [catalog.itemId]);
    const sessionId = `h3-${randomUUID()}`;
    const cartId = (await db().query('insert into public.carts(guest_token_hash) values($1) returning id', [createHash('sha256').update(sessionId).digest('hex')])).rows[0].id as string;
    const lineId = (await db().query('insert into public.cart_lines(cart_id,variant_id,quantity) values($1,$2,2) returning id', [cartId, catalog.variantId])).rows[0].id as string;
    if (withDiscount) await seedHDiscount(db(), hDiscount({ method: 'automatic', allowGuests: true, kind: 'order_amount', value: { type: 'amount', value: 3000 }, minimum: { type: 'amount', value: 40000 } }));
    const context = await hRpc<{ discounts: DiscountDefinition[]; facts: DiscountFacts; refusals: DiscountRefusal[] }>(db(), 'get_checkout_discount_context', [null, 'buyer@example.invalid', [], [catalog.itemId], '2026-10-29T00:00:00Z', 'confirm']);
    const result = calculateDiscounts({ lines: [{ lineKey: lineId, itemId: catalog.itemId, unitPrice: 20000, quantity: 2, lineKind: 'order' }], codes: [], ...context });
    const claim: CheckoutDiscountClaim = { sessionId, requestVersion: 4, requestFingerprint: `v4:${'a'.repeat(64)}`, checkoutUiMode: 'custom', checkoutOrigin: 'https://shop.example.invalid', paymentMethod: 'stripe_card', currency: 'jpy', subtotalAmount: 40000, taxAmount: 0, shippingAmount: 0, totalAmount: 40000,
      shippingSnapshot: { email: 'buyer@example.invalid', fullName: 'Fixture', kanaName: null, postalCode: '1000001', prefecture: 'Tokyo', city: 'City', address: '1-1', building: null, phone: '0312345678' },
      itemsSnapshot: [{ source_cart_line_id: lineId, item_id: catalog.itemId, item_name: 'Fixture', item_price: 20000, quantity: 2, line_total: 40000, color: 'BLACK', size: 'M', item_image_url: null }], buyerUserId: null, cartId };
    return { claim, result, facts: context.facts, definitions: context.discounts };
  }
  async function freeze(f: Awaited<ReturnType<typeof fixture>>): Promise<CheckoutDiscountDraft> {
    await db().query('set local role service_role');
    const row = (await db().query('select public.claim_checkout_discount_draft($1::jsonb,$2::jsonb,$3::jsonb) as result', [JSON.stringify(f.claim), JSON.stringify(f.result), JSON.stringify(f.facts)])).rows[0].result as CheckoutDiscountDraft;
    await db().query('reset role'); return row;
  }
  async function attach(id: string, hash: string, coupon: string): Promise<boolean> {
    await db().query('set local role service_role');
    const row = (await db().query('select public.attach_checkout_discount_coupon($1::uuid,$2::text,$3::text) as result', [id,hash,coupon])).rows[0].result as boolean;
    await db().query('reset role'); return row;
  }

  test('FREQ-548-AC-02: 固定後の割引はJSONだけにありdiscount_amountを先に入れる改変をCHECKとassertが拒む', async () => {
    const f = await fixture(); const first = await freeze(f);
    expect(first.discountResult).toMatchObject({ discountAmount: 3000, totalAmount: 37000, version: 1 });
    expect(first.discountSnapshotHash).toBe(checkoutDiscountSnapshotHash(f.claim.itemsSnapshot, [], f.definitions, f.facts, f.result));
    const row = (await db().query('select total_amount,discount_amount,discount_engine_version,discount_facts from public.checkout_drafts where id=$1', [first.draftId])).rows[0];
    expect(row).toMatchObject({ total_amount: 40000, discount_amount: 0, discount_engine_version: 1 });
    expect(row.total_amount + row.discount_amount).toBe(37000+3000);
    const retry = await freeze({ ...f, facts: { ...f.facts, at: '2026-10-29T00:00:01Z', usage: f.facts.usage.map(u => ({ ...u, confirmed: u.confirmed + 1 })) } });
    expect(retry).toEqual({ ...first, claimCreated: false });
    expect((await db().query('select discount_facts from public.checkout_drafts where id=$1', [first.draftId])).rows[0].discount_facts).toEqual(row.discount_facts);
    expect(await hFailure(db(), () => db().query('update public.checkout_drafts set discount_amount=3000 where id=$1', [first.draftId]))).toMatchObject({ code: '23514' });
    const zero = await fixture(false); zero.facts.usage = []; zero.definitions = []; zero.result = calculateDiscounts({ lines: zero.claim.itemsSnapshot.map(i => ({ lineKey: i.source_cart_line_id, itemId: i.item_id, unitPrice: i.item_price, quantity: i.quantity, lineKind: 'order' as const })), codes: [], discounts: [], facts: zero.facts });
    const zeroDraft = await freeze(zero); expect(zeroDraft.discountResult.discountAmount).toBe(0);
    expect((await db().query('select discount_engine_version from public.checkout_drafts where id=$1',[zeroDraft.draftId])).rows[0].discount_engine_version).toBe(1);
  });

  test('FREQ-548-AC-02: 会員の２コードと２行を逆順にしてもTSとSQLの固定hashが一致する', async () => {
    const f = await fixture(false);
    const memberId = await seedHMember(db(), 'buyer@example.invalid');
    await db().query('update public.carts set user_id=$2,guest_token_hash=null where id=$1', [f.claim.cartId, memberId]);
    const catalog = await createCatalogFixture(db());
    await db().query('update public.items set price=10000 where id=$1', [catalog.itemId]);
    const lineId = (await db().query('insert into public.cart_lines(cart_id,variant_id,quantity) values($1,$2,1) returning id', [f.claim.cartId, catalog.variantId])).rows[0].id as string;
    f.claim.itemsSnapshot.push({ source_cart_line_id: lineId, item_id: catalog.itemId, item_name: 'Second', item_price: 10000, quantity: 1, line_total: 10000, color: 'BLACK', size: 'M', item_image_url: null });
    f.claim.itemsSnapshot.sort((a, b) => a.source_cart_line_id < b.source_cart_line_id ? 1 : -1);
    f.claim.buyerUserId = memberId;
    f.claim.subtotalAmount = f.claim.totalAmount = 50000;
    const prefix = `H3-${randomUUID().slice(0, 8).toUpperCase()}`;
    const codes = [`${prefix}-BBBB`, `${prefix}-AAAA`];
    const discountId = await seedHDiscount(db(), hDiscount({ method: 'code' }));
    const batchId = randomUUID();
    for (const code of codes) await db().query("insert into public.discount_codes(discount_id,code,audience,allow_guests,single_use,batch_id) values($1,$2,'anyone',false,true,$3)", [discountId, code, batchId]);
    const context = await hRpc<{ discounts: DiscountDefinition[]; facts: DiscountFacts; refusals: DiscountRefusal[] }>(db(), 'get_checkout_discount_context', [memberId, null, codes, f.claim.itemsSnapshot.map(i => i.item_id), '2026-10-29T00:00:00Z', 'confirm']);
    expect(context.refusals).toEqual([]);
    expect(context.facts.usage.filter(u => u.discountId === discountId)).toHaveLength(2);
    f.definitions = context.discounts;
    f.facts = { ...context.facts, usage: [...context.facts.usage].reverse() };
    f.result = calculateDiscounts({ lines: f.claim.itemsSnapshot.map(i => ({ lineKey: i.source_cart_line_id, itemId: i.item_id, unitPrice: i.item_price, quantity: i.quantity, lineKind: 'order' as const })), codes, discounts: f.definitions, facts: f.facts });
    const hash = checkoutDiscountSnapshotHash(f.claim.itemsSnapshot, codes, f.definitions, f.facts, f.result);
    expect((await freeze(f)).discountSnapshotHash).toBe(hash);
    expect(checkoutDiscountSnapshotHash([...f.claim.itemsSnapshot].reverse(), [...codes].reverse(), [...f.definitions].reverse(), { ...f.facts, usage: [...f.facts.usage].reverse() }, f.result)).toBe(hash);
  });

  test('FREQ-542-AC-03: 固定のlineKeyと数量と配分と１着の総和が違えばdraftを残さない', async () => {
    const f = await fixture();
    const changes = [
      { ...f.result, unitAmounts: f.result.unitAmounts.slice(1) },
      { ...f.result, unitAmounts: f.result.unitAmounts.map((u,i) => i === 0 ? { ...u, lineKey: randomUUID() } : u) },
      { ...f.result, unitAmounts: f.result.unitAmounts.map(u => ({ ...u, unitIndex: 0 })) },
      { ...f.result, allocations: f.result.allocations.map(a => ({ ...a, amount: a.amount+1 })) },
      { ...f.result, totalAmount: 49 }, { ...f.result, provisional: true },
      { ...f.result, applied: f.result.applied.map(e => ({ ...e, codeId: randomUUID() })) },
    ];
    for (const result of changes) {
      expect(await hFailure(db(), () => freeze({ ...f, result }))).toEqual({ code: '22023', message: 'GROUP_H_ARGUMENT_INVALID' });
      expect((await db().query('select count(*)::int n from public.checkout_drafts where session_id=$1',[f.claim.sessionId])).rows[0].n).toBe(0);
    }
    expect(await hFailure(db(), () => freeze({ ...f, facts: { ...f.facts, hasPreviousOrder: null } }))).toEqual({ code: '22023', message: 'GROUP_H_ARGUMENT_INVALID' });
  });

  test('FREQ-548-AC-03: couponの結付けはhashと未完成draftを検査し同じidの再送だけ通す', async () => {
    const f = await fixture(); const saved = await freeze(f);
    expect(await attach(saved.draftId,saved.discountSnapshotHash,'coupon_h3')).toBe(true);
    expect(await attach(saved.draftId,saved.discountSnapshotHash,'coupon_h3')).toBe(true);
    expect((await freeze(f)).stripeDiscountCouponId).toBe('coupon_h3');
    for (const [hash,coupon] of [[saved.discountSnapshotHash,'other'],['b'.repeat(64),'coupon_h3']]) expect(await hFailure(db(), () => attach(saved.draftId,hash,coupon))).toEqual({ code: '22023', message: 'GROUP_H_DRAFT_SNAPSHOT_CONFLICT' });
    await db().query("update public.checkout_drafts set status='completed',discount_amount=3000 where id=$1",[saved.draftId]);
    expect(await hFailure(db(), () => attach(saved.draftId,saved.discountSnapshotHash,'coupon_h3'))).toEqual({ code: '22023', message: 'GROUP_H_DRAFT_SNAPSHOT_CONFLICT' });
  });

  test('FREQ-548-AC-02: 固定hash変更と未知claimキーと別所有者を拒否する', async () => {
    const f = await fixture(); const saved = await freeze(f);
    const changed = { ...f, facts: { ...f.facts, hasPreviousOrder: true } };
    expect(await hFailure(db(), () => freeze(changed))).toEqual({ code: '22023', message: 'GROUP_H_DRAFT_SNAPSHOT_CONFLICT' });
    expect(await hFailure(db(), () => freeze({ ...f, claim: { ...f.claim, unknown: true } as CheckoutDiscountClaim }))).toEqual({ code: '22023', message: 'GROUP_H_ARGUMENT_INVALID' });
    expect(await hFailure(db(), () => db().query('update public.checkout_drafts set discount_snapshot_hash=$2 where id=$1',[saved.draftId,'c'.repeat(64)]))).toEqual({ code: '22023', message: 'GROUP_H_DRAFT_SNAPSHOT_CONFLICT' });
  });

  test.each(['anon','authenticated'])('FREQ-548-AC-02: %sは固定とcouponの公開入口を実行できない', async role => {
    const f = await fixture();
    expect(await hFailure(db(), async () => { await db().query(`set local role ${role}`); return db().query('select public.claim_checkout_discount_draft($1::jsonb,$2::jsonb,$3::jsonb)',[JSON.stringify(f.claim),JSON.stringify(f.result),JSON.stringify(f.facts)]); })).toMatchObject({ code: '42501' });
    expect(await hFailure(db(), async () => { await db().query(`set local role ${role}`); return db().query('select public.attach_checkout_discount_coupon($1::uuid,$2,$3)',[randomUUID(),'a'.repeat(64),'coupon']); })).toMatchObject({ code: '42501' });
  });
});
