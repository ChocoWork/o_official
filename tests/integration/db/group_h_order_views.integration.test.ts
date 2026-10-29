/** @jest-environment node */
import { randomUUID } from 'node:crypto';
import { describeLocalDb } from './helpers/local-db';
import { acceptHCheckout, hDiscount, hFailure, seedHCheckout, seedHDiscount, seedHMember, seedHOrderUnits } from './helpers/group-h-fixtures';
import { createPurchaseFlow } from './helpers/purchase-order-flow';

type Breakdown = { rows: Array<{ name: string; amount: number; discountId: string | null; code: string | null; lineAllocations: Array<{ orderItemId: string; amount: number }> }>; legacy: boolean };

describeLocalDb('H6 order discount breakdown views (controller only)', db => {
  const flow = createPurchaseFlow(db);
  beforeEach(async () => { await db().query('begin'); await db().query('select pg_advisory_xact_lock(190521,1)'); });
  afterEach(async () => { await db().query('rollback'); });

  /** Execute as the real service role; a failure leaves the role to the caller's savepoint. */
  async function asService<T>(sql: string, args: unknown[]): Promise<T> {
    await db().query('set local role service_role');
    const row = (await db().query(sql, args)).rows[0];
    await db().query('reset role');
    return row.r as T;
  }
  const breakdown = (orderId: string | null) => asService<Breakdown>('select public.get_order_discount_breakdown($1) as r', [orderId]);
  const material = (orderId: string | null) => asService<Record<string, unknown> | null>('select public.get_order_status_public_material($1) as r', [orderId]);
  const detail = (orderId: string, actor: string) => asService<Record<string, any>>('select public.get_admin_order_detail($1,$2) as r', [orderId, actor]);

  /** Two frozen effects on one order: a product discount and an order discount over two lines (37,000 -> 35,000 yen). */
  async function twoEffectOrder() {
    const product = await seedHDiscount(db(), hDiscount({ name: 'Product A', code: `PA-${randomUUID().slice(0, 8).toUpperCase()}` }));
    const order = await seedHDiscount(db(), hDiscount({ name: 'Order B', kind: 'order_percent', code: `OB-${randomUUID().slice(0, 8).toUpperCase()}` }));
    const placed = await seedHOrderUnits(db(), { legacy: false, lines: [
      { itemPrice: 20000, quantity: 1, discounts: [{ discountId: product, amount: 1000 }, { discountId: order, amount: 500 }], unitAmounts: [18500] },
      { itemPrice: 17000, quantity: 1, discounts: [{ discountId: order, amount: 500 }], unitAmounts: [16500] },
    ] });
    const freeze = (discountId: string, name: string, cls: 'product' | 'order', amount: number, state = 'confirmed') => db().query(
      `insert into public.discount_redemptions(discount_id,code_id,order_id,identity_key,normalized_email,state,confirmed_at,cancelled_at,
        name_snapshot,code_snapshot,class_snapshot,amount,first_order_only_snapshot)
       select d.id,c.id,$2,'guest:h@example.invalid','h@example.invalid',$6,case when $6='confirmed' then now() end,case when $6='cancelled' then now() end,
        $3,c.code,$4,$5,false from public.discounts d left join public.discount_codes c on c.discount_id=d.id where d.id=$1`,
      [discountId, placed.orderId, name, cls, amount, state]);
    // The order class is inserted first on purpose: the breakdown must still list product first.
    await freeze(order, 'Frozen Order B', 'order', 1000);
    await freeze(product, 'Frozen Product A', 'product', 1000);
    return { ...placed, product, order };
  }

  test('FREQ-552-AC-01: 注文時の名前・コード・額が商品→注文の順で返り、割引の改名後も同じで、額の合計は注文の割引額と一致する', async () => {
    const o = await twoEffectOrder();
    const result = await breakdown(o.orderId);

    expect(result.legacy).toBe(false);
    expect(result.rows.map(r => [r.name, r.amount, r.discountId])).toEqual([['Frozen Product A', 1000, o.product], ['Frozen Order B', 1000, o.order]]);
    expect(result.rows.every(r => /^(PA|OB)-/.test(r.code ?? ''))).toBe(true);
    expect(result.rows.reduce((n, r) => n + r.amount, 0)).toBe((await db().query('select discount_amount from public.orders where id=$1', [o.orderId])).rows[0].discount_amount);
    await db().query("update public.discounts set name='Renamed later' where id in ($1,$2)", [o.product, o.order]);
    expect((await breakdown(o.orderId)).rows.map(r => r.name)).toEqual(['Frozen Product A', 'Frozen Order B']);
  });

  test('FREQ-552-AC-03: 行別の配分は割引ごとの額と一致し、0円の割引と配分は出ない', async () => {
    const o = await twoEffectOrder();
    const result = await breakdown(o.orderId);
    const order = result.rows.find(r => r.discountId === o.order)!;

    expect(order.lineAllocations.map(a => a.amount).sort()).toEqual([500, 500]);
    for (const row of result.rows) expect(row.lineAllocations.reduce((n, a) => n + a.amount, 0)).toBe(row.amount);
    const free = await seedHDiscount(db(), hDiscount({ name: 'Free', code: `FR-${randomUUID().slice(0, 8).toUpperCase()}` }));
    await db().query(`insert into public.discount_redemptions(discount_id,order_id,identity_key,state,confirmed_at,name_snapshot,class_snapshot,amount,first_order_only_snapshot)
      values($1,$2,'guest:h@example.invalid','confirmed',now(),'Free','product',0,false)`, [free, o.orderId]);
    expect((await breakdown(o.orderId)).rows.map(r => r.name)).toEqual(['Frozen Product A', 'Frozen Order B']);
  });

  test('FREQ-552-AC-01: 取消済みの使用も注文時の内訳として残り、合計は変わらない', async () => {
    const o = await twoEffectOrder();
    await db().query('set local role postgres');
    await db().query('alter table public.discount_redemptions disable trigger user');
    await db().query("update public.discount_redemptions set state='cancelled',confirmed_at=null,cancelled_at=now() where order_id=$1 and class_snapshot='order'", [o.orderId]);
    await db().query('alter table public.discount_redemptions enable trigger user');
    await db().query('reset role');
    const result = await breakdown(o.orderId);
    expect(result.rows.map(r => r.amount)).toEqual([1000, 1000]);
  });

  test('FREQ-552-AC-01: 旧注文は名前の印(discount)の合計1行と配分なし、0円の旧注文は空の行', async () => {
    const legacy = await seedHOrderUnits(db(), { legacy: true, lines: [{ itemPrice: 10000, quantity: 1, discounts: [{ discountId: randomUUID(), amount: 700 }], unitAmounts: [] }] });
    expect(await breakdown(legacy.orderId)).toEqual({ rows: [{ name: 'discount', amount: 700, discountId: null, code: null, lineAllocations: [] }], legacy: true });
    const none = await seedHOrderUnits(db(), { legacy: true, lines: [{ itemPrice: 10000, quantity: 1, discounts: [], unitAmounts: [] }] });
    expect(await breakdown(none.orderId)).toEqual({ rows: [], legacy: true });
  });

  test('FREQ-552-AC-03: 内訳の合計が注文の割引額と食い違う壊れたデータは固定の拒否で返し、静かに丸めない', async () => {
    const o = await twoEffectOrder();
    await db().query('set local role postgres');
    await db().query('alter table public.discount_redemptions disable trigger user');
    await db().query("update public.discount_redemptions set amount=amount+1 where order_id=$1 and class_snapshot='order'", [o.orderId]);
    await db().query('alter table public.discount_redemptions enable trigger user');
    await db().query('reset role');
    expect(await hFailure(db(), () => breakdown(o.orderId))).toEqual({ code: '55000', message: 'GROUP_H_ORDER_BREAKDOWN_INVALID' });
    expect(await hFailure(db(), () => breakdown(randomUUID()))).toEqual({ code: 'P0002', message: 'GROUP_H_ORDER_NOT_FOUND' });
    expect(await hFailure(db(), () => breakdown(null))).toEqual({ code: '22023', message: 'GROUP_H_ARGUMENT_INVALID' });
  });

  test('FREQ-552-AC-01: 実際の受付と入金を通した注文の内訳は、固定した結果の名前と額と行別配分に一致する', async () => {
    const userId = await seedHMember(db());
    const code = `H6-${randomUUID().toUpperCase()}`;
    const id = await seedHDiscount(db(), hDiscount({ name: 'Checkout name', code }));
    const f = await seedHCheckout(db(), { discountId: id, code, userId });
    const row = await acceptHCheckout(db(), f);
    await db().query("select * from public.mark_order_paid($1,'payment_in_progress',$2,$3,'jpy',true,'payment_received')", [row.order_id, f.paymentIntentId, f.result.totalAmount]);

    const result = await breakdown(row.order_id);
    expect(result.legacy).toBe(false);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ name: 'Checkout name', amount: f.result.discountAmount, discountId: id, code });
    expect(result.rows[0].lineAllocations.reduce((n, a) => n + a.amount, 0)).toBe(f.result.discountAmount);
    // 入金後に割引の名前を変えても、注文の内訳と公開の状況材料は注文時の名前のまま
    await db().query("update public.discounts set name='Changed after payment' where id=$1", [id]);
    const publicMaterial = await material(row.order_id);
    expect(publicMaterial?.discounts).toEqual([{ name: 'Checkout name', amount: f.result.discountAmount }]);
  });

  test('FREQ-552-AC-02: 公開の状況材料の割引は名前と額の2キーだけで、コード・割引id・配分・会員の本人キーを含まない', async () => {
    const o = await twoEffectOrder();
    const m = (await material(o.orderId))!;

    expect(Object.keys(m).sort()).toEqual(['delivery_detail', 'delivery_summary', 'discounts', 'fulfillments', 'line_rows', 'order', 'refund_rows']);
    expect(m.discounts).toEqual([{ name: 'Frozen Product A', amount: 1000 }, { name: 'Frozen Order B', amount: 1000 }]);
    for (const discount of m.discounts as Array<Record<string, unknown>>) expect(Object.keys(discount).sort()).toEqual(['amount', 'name']);
    const json = JSON.stringify(m);
    expect(json).not.toMatch(/lineAllocations|discountId|identity_key|normalized_email|guest:h@example|code_snapshot/);
    expect(json).not.toContain(o.product);
    expect(json).not.toContain(o.order);
  });

  test('FREQ-552-AC-02: 旧注文の公開材料は名前の印の合計1行、割引のない注文は空の配列、見せない状態の注文はnull', async () => {
    const legacy = await seedHOrderUnits(db(), { legacy: true, lines: [{ itemPrice: 10000, quantity: 1, discounts: [{ discountId: randomUUID(), amount: 300 }], unitAmounts: [] }] });
    expect((await material(legacy.orderId))?.discounts).toEqual([{ name: 'discount', amount: 300 }]);
    const none = await seedHOrderUnits(db(), { legacy: true, lines: [{ itemPrice: 10000, quantity: 1, discounts: [], unitAmounts: [] }] });
    expect((await material(none.orderId))?.discounts).toEqual([]);
    const hidden = await seedHOrderUnits(db(), { legacy: true, status: 'payment_in_progress', paidAt: null, lines: [{ itemPrice: 10000, quantity: 1, discounts: [{ discountId: randomUUID(), amount: 300 }], unitAmounts: [] }] });
    expect(await material(hidden.orderId)).toBeNull();
  });

  test('FREQ-552-AC-03: 管理詳細は orders.read だけの担当にもコードと行別配分つきの内訳を返し、合計は amounts.discount と一致する', async () => {
    const actor = await flow.createActor(['supporter']);
    const o = await twoEffectOrder();
    const d = await detail(o.orderId, actor);

    expect(d.discounts).toHaveLength(2);
    expect(d.discounts.map((r: { name: string }) => r.name)).toEqual(['Frozen Product A', 'Frozen Order B']);
    expect(d.discounts.every((r: { code: string | null; lineAllocations: unknown[] }) => r.code !== null && r.lineAllocations.length > 0)).toBe(true);
    expect(d.discounts.reduce((n: number, r: { amount: number }) => n + r.amount, 0)).toBe(d.amounts.discount);
    // 既存の欄(attention.discounts の要対応)は別の欄のまま
    expect(Object.keys(d).sort()).toEqual(['amounts', 'attention', 'discounts', 'order', 'permissions', 'rows']);
    const legacy = await seedHOrderUnits(db(), { legacy: true, lines: [{ itemPrice: 10000, quantity: 1, discounts: [{ discountId: randomUUID(), amount: 700 }], unitAmounts: [] }] });
    expect((await detail(legacy.orderId, actor)).discounts).toEqual([{ name: 'discount', amount: 700, discountId: null, code: null, lineAllocations: [] }]);
  });

  test('FREQ-552-AC-03: 権限のない・無効な担当は管理詳細を読めず、未知の注文は固定の拒否になる', async () => {
    const o = await twoEffectOrder();
    const nobody = await seedHMember(db());
    // hFailure は GROUP_H_ 以外の文を固定の記号へ丸めるので、G の拒否は SQLSTATE で確かめる
    expect(await hFailure(db(), () => detail(o.orderId, nobody))).toMatchObject({ code: '42501' });
    const actor = await flow.createActor(['supporter']);
    expect(await hFailure(db(), () => detail(randomUUID(), actor))).toMatchObject({ code: 'P0002' });
    expect((await detail(o.orderId, actor)).discounts).toHaveLength(2);
  });

  test('FREQ-552-AC-02: 完全な内訳の入口はservice_roleだけで、anon・authenticatedと内部関数は拒否される', async () => {
    const o = await twoEffectOrder();
    for (const role of ['anon', 'authenticated']) {
      expect(await hFailure(db(), async () => { await db().query(`set local role ${role}`); await db().query('select public.get_order_discount_breakdown($1)', [o.orderId]); }))
        .toMatchObject({ code: '42501' });
      expect(await hFailure(db(), async () => { await db().query(`set local role ${role}`); await db().query('select public.get_order_status_public_material($1)', [o.orderId]); }))
        .toMatchObject({ code: '42501' });
    }
    for (const signature of ['private.order_discount_breakdown(uuid)', 'private.get_order_discount_breakdown(uuid)', 'public.get_order_discount_breakdown(uuid)', 'public.get_order_status_public_material(uuid)', 'private.get_admin_order_detail(uuid,uuid)']) {
      const privileges = (await db().query(`select has_function_privilege('anon',$1::regprocedure,'EXECUTE') as anon,
        has_function_privilege('authenticated',$1::regprocedure,'EXECUTE') as authenticated,
        has_function_privilege('service_role',$1::regprocedure,'EXECUTE') as service`, [signature])).rows[0];
      expect({ signature, ...privileges }).toEqual({ signature, anon: false, authenticated: false, service: signature !== 'private.order_discount_breakdown(uuid)' });
    }
    expect(await hFailure(db(), async () => { await db().query('set local role service_role'); await db().query('select private.order_discount_breakdown($1)', [o.orderId]); }))
      .toMatchObject({ code: '42501' });
  });
});
