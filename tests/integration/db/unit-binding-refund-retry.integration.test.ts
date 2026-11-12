/** @jest-environment node */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { hClaims, hRefundFixture, hResult } from './helpers/group-h-refund-fixtures';
import { describeLocalDb } from './helpers/local-db';
import { createUbReturn, ubReceive, type ReceiveUnit } from './helpers/unit-binding-receive';
import { loadReturnRefundOutstanding, type UnitPricingClient } from '@/lib/orders/unit-pricing/unit-pricing-store';

jest.setTimeout(60000);

const directory = path.join(process.cwd(), 'supabase', 'migrations');
const file = fs.readdirSync(directory).find((name) => name.endsWith('_unit_binding_refund_retry.sql'));
const sql = file ? fs.readFileSync(path.join(directory, file), 'utf8') : '';

describe('FREQ-642-AC-37: unit binding refund retry migration source contract', () => {
  test('FREQ-642-AC-37: 移行は単一取引・ASCII・LF・末尾の確かめを持ち、移行 D より後', () => {
    expect(file).toBeDefined();
    expect((file ?? '') > '20261110135232').toBe(true);
    expect(sql).not.toMatch(/[^\x00-\x7f]|\r/);
    expect(sql.startsWith('BEGIN;\n')).toBe(true);
    expect(sql.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(sql.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(sql.trimEnd()).toMatch(/NOTIFY pgrst, 'reload schema';\nCOMMIT;$/);
    expect(sql).toContain('UNIT_BINDING_REFUND_RETRY_MIGRATION_ASSERTION_FAILED');
    for (const detail of ['ubx_schema', 'ubx_functions', 'ubx_acl', 'ubx_allowlist', 'ubx_waive_backfill']) expect(sql).toContain(`'${detail}'`);
    // @design は詳細設計の DD-ADMIN-022 の頁と設計書を指す（ADMIN の領域の文書ではない。M-5）
    expect(sql).toMatch(/^-- @design docs\/superpowers\/specs\/2026-11-08-exchange-unit-binding-design\.md docs\/04_DetailDesign\/pages\/16_admin\.md$/m);
  });
});

type Failure = { code?: string; message?: string; detail?: string };

/** supabase の from().select().eq().in() を、試験の取引の中の pg で答える最小の入れ物（loadReturnRefundOutstanding が使う形だけ） */
function pgUnitPricingClient(query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[] }>): UnitPricingClient {
  const from = (table: string) => {
    let columns = '*';
    const where: string[] = [];
    const params: unknown[] = [];
    const chain = {
      select(c: string) { columns = c; return chain; },
      eq(c: string, v: unknown) { params.push(v); where.push(`${c} = $${params.length}`); return chain; },
      in(c: string, v: unknown[]) { params.push(v); where.push(`${c} = any($${params.length})`); return chain; },
      then(resolve: (r: { data: unknown[] | null; error: unknown }) => void, reject: (e: unknown) => void) {
        query(`select ${columns} from public.${table}${where.length ? ` where ${where.join(' and ')}` : ''}`, params)
          // 時刻は PostgREST と同じく文字列で返す（作った時刻の比べに使う）
          .then((r) => resolve({ data: r.rows.map((row) => Object.fromEntries(Object.entries(row as Record<string, unknown>)
            .map(([k, v]) => [k, v instanceof Date ? v.toISOString() : v]))), error: null }), reject);
      },
    };
    return chain;
  };
  return { from } as unknown as UnitPricingClient;
}
const unit = (lineId: string, quantity = 1, refundChoice?: 'now' | 'consult', disposition = 'not_restocked'): ReceiveUnit =>
  ({ return_line_id: lineId, disposition, quantity, ...(refundChoice ? { refund_choice: refundChoice } : {}) });

describeLocalDb('FREQ-642-AC-37: refund after the receive-time refund failed (controller only)', (db) => {
  beforeEach(async () => { await db().query('begin'); await db().query('select pg_advisory_xact_lock(190521,1)'); });
  afterEach(async () => { await db().query('rollback'); });

  const q = (text: string, params?: unknown[]) => db().query(text, params);
  async function failure(run: () => Promise<unknown>): Promise<Failure> {
    await q('savepoint ubx_expected');
    try { await run(); return {}; }
    catch (caught) { const e = caught as Failure; return { code: e.code, message: e.message, detail: e.detail }; }
    finally { await q('rollback to savepoint ubx_expected'); await q('release savepoint ubx_expected'); }
  }
  const eventsOf = async (orderId: string) => (await q('select * from public.order_unit_events where order_id=$1 order by seq', [orderId])).rows;
  const linksOf = async (refundId: string) => (await q(
    'select event_id, part from public.order_unit_event_refunds where refund_id=$1 order by part', [refundId])).rows;
  const refundLines = async (refundId: string) => (await q(
    'select order_item_id, quantity, before_shipment, amount from public.order_refund_lines where refund_id=$1 order by order_item_id', [refundId])).rows;
  const refundReturn = async (returnId: string, actor: string, key = randomUUID(), amount: number | null = null) =>
    (await q('select * from public.admin_refund_return($1,$2,$3,$4,0,null,false)', [returnId, actor, key, amount])).rows[0] as {
      refund_id: string; amount: number; status: string; replayed: boolean; release_refund_ids: string[] };
  /** 画面の「返金の画面を出すか」の元: 返品の行の返金待ちの数の和（OrderReturnsDialog の returnActionsOf） */
  const waitingOf = async (returnId: string) => Number((await q(
    'select coalesce(sum(g.refund_waiting),0) n from private.order_return_line_progress($1) g', [returnId])).rows[0].n);
  /**
   * 画面の見込み（サーバーの loadReturnRefundOutstanding を、この取引の中の DB で動かした額）。DB の読み手
   * private.order_unit_return_refund_parts の額の和と同じであることを毎回確かめる（2か所の決まりがずれないこと。M-6）
   */
  const screenBasis = async (returnId: string) => {
    const screen = (await loadReturnRefundOutstanding(pgUnitPricingClient(q), returnId)).amount;
    const reader = Number((await q('select coalesce(sum(amount),0) n from private.order_unit_return_refund_parts($1)', [returnId])).rows[0].n);
    expect(screen).toBe(reader);
    return screen;
  };

  /** 2着の返品を今すぐ1着・相談1着で受け取る（今すぐの返金は 17,000円、相談の分は 20,000円） */
  async function mixedReceive(o: { percent?: number; waived?: boolean; amount?: number; fixed?: number } = {}) {
    const f = await hRefundFixture(db(), true);
    const ret = await createUbReturn(db(), f, [{ quantity: 1 }, { quantity: 1 }], { percent: o.percent, fixed: o.fixed });
    const received = await ubReceive(db(), { returnId: ret.returnId, actorId: f.actor, choice: 'mixed', amount: o.amount,
      restockingFeeWaived: o.waived, units: [unit(ret.lineIds[0], 1, 'now'), unit(ret.lineIds[1], 1, 'consult')] });
    const [event] = await eventsOf(f.orderId);
    return { f, ret, received, event };
  }

  test('FREQ-642-AC-37: 今すぐの返金が失敗した後の返金は、失敗した今すぐの分と相談の分を1つの返金 37,000円で返し、両方の分を結ぶ', async () => {
    const { f, ret, received, event } = await mixedReceive();
    expect(event).toMatchObject({ now_refund: 17000, consult_refund: 20000 });
    await hResult(db(), received.refund_id, 'failed');
    expect(await waitingOf(ret.returnId)).toBe(2);
    expect(await screenBasis(ret.returnId)).toBe(37000);
    const retry = await refundReturn(ret.returnId, f.actor);
    expect(retry).toMatchObject({ amount: 37000, status: 'awaiting_response', replayed: false, release_refund_ids: [] });
    expect(await refundLines(retry.refund_id)).toEqual([{ order_item_id: f.itemId, quantity: 2, before_shipment: false, amount: 37000 }]);
    expect(await linksOf(retry.refund_id)).toEqual([{ event_id: event.id, part: 'consult' }, { event_id: event.id, part: 'now' }]);
    // 失敗した今すぐの返金の結びは残る（記録は消さない）
    expect(await linksOf(received.refund_id)).toEqual([{ event_id: event.id, part: 'now' }]);
    // 返した2着とも、新しい返金が取り押さえる（失敗で放した着を、同じ額で付け直す）
    const claims = await hClaims(db(), f.itemId);
    expect(claims.filter((u) => u.refund_id === retry.refund_id)).toHaveLength(2);
    expect(claims.filter((u) => u.refund_id === retry.refund_id).reduce((sum, u) => sum + Number(u.paid_amount), 0)).toBe(37000);
    expect(await screenBasis(ret.returnId)).toBe(0);
    expect(await waitingOf(ret.returnId)).toBe(0);
  });

  test('FREQ-642-AC-37: 今すぐだけの受け取りの返金が失敗した後の返金は 17,000円で、今すぐの分を結ぶ', async () => {
    const f = await hRefundFixture(db(), true);
    const ret = await createUbReturn(db(), f, [{ quantity: 1 }]);
    const received = await ubReceive(db(), { returnId: ret.returnId, actorId: f.actor, choice: 'now', units: [unit(ret.lineIds[0])] });
    const [event] = await eventsOf(f.orderId);
    await hResult(db(), received.refund_id, 'failed');
    expect(await waitingOf(ret.returnId)).toBe(1);
    expect(await screenBasis(ret.returnId)).toBe(17000);
    const retry = await refundReturn(ret.returnId, f.actor);
    expect(retry).toMatchObject({ amount: 17000, status: 'awaiting_response', replayed: false });
    expect(await refundLines(retry.refund_id)).toEqual([{ order_item_id: f.itemId, quantity: 1, before_shipment: false, amount: 17000 }]);
    expect(await linksOf(retry.refund_id)).toEqual([{ event_id: event.id, part: 'now' }]);
    expect((await hClaims(db(), f.itemId)).filter((u) => u.refund_id === retry.refund_id)).toHaveLength(1);
  });

  test('FREQ-642-AC-37: 今すぐの返金が成功していれば、返金は相談の分 20,000円だけ（今までどおり）', async () => {
    const { f, ret, received, event } = await mixedReceive();
    await hResult(db(), received.refund_id, 'succeeded');
    expect(await screenBasis(ret.returnId)).toBe(20000);
    const consult = await refundReturn(ret.returnId, f.actor);
    expect(consult.amount).toBe(20000);
    expect(await linksOf(consult.refund_id)).toEqual([{ event_id: event.id, part: 'consult' }]);
  });

  test('FREQ-642-AC-37: 今すぐの返金が手続き中（pending）なら二度は返さず、返金は相談の分 20,000円だけ', async () => {
    const { f, ret, received, event } = await mixedReceive();
    await hResult(db(), received.refund_id, 'pending');
    expect(await waitingOf(ret.returnId)).toBe(1);
    expect(await screenBasis(ret.returnId)).toBe(20000);
    const consult = await refundReturn(ret.returnId, f.actor);
    expect(consult.amount).toBe(20000);
    expect(await linksOf(consult.refund_id)).toEqual([{ event_id: event.id, part: 'consult' }]);
    expect(await linksOf(received.refund_id)).toEqual([{ event_id: event.id, part: 'now' }]);
  });

  test('FREQ-642-AC-37: 受け取りで今すぐの返金を0円で終えた分は返し直さず、返金は相談の分 20,000円だけ', async () => {
    const { f, ret, received, event } = await mixedReceive({ amount: 0 });
    expect(received.refund_id).toBeNull();
    expect(await screenBasis(ret.returnId)).toBe(20000);
    const consult = await refundReturn(ret.returnId, f.actor);
    expect(consult.amount).toBe(20000);
    expect(await linksOf(consult.refund_id)).toEqual([{ event_id: event.id, part: 'consult' }]);
  });

  test('FREQ-642-AC-37: 相談の返金が失敗したら、次の返金で相談の分を返し直す', async () => {
    const { f, ret, received, event } = await mixedReceive();
    await hResult(db(), received.refund_id, 'succeeded');
    const first = await refundReturn(ret.returnId, f.actor);
    await hResult(db(), first.refund_id, 'failed');
    expect(await screenBasis(ret.returnId)).toBe(20000);
    const again = await refundReturn(ret.returnId, f.actor);
    expect(again.amount).toBe(20000);
    expect(await linksOf(again.refund_id)).toEqual([{ event_id: event.id, part: 'consult' }]);
  });

  test('FREQ-642-AC-37: 今すぐと相談の返金が両方失敗したら、次の返金で両方を 37,000円で返す', async () => {
    const { f, ret, received, event } = await mixedReceive();
    await hResult(db(), received.refund_id, 'failed');
    const first = await refundReturn(ret.returnId, f.actor);
    expect(first.amount).toBe(37000);
    await hResult(db(), first.refund_id, 'failed');
    expect(await screenBasis(ret.returnId)).toBe(37000);
    const again = await refundReturn(ret.returnId, f.actor);
    expect(again.amount).toBe(37000);
    expect(await linksOf(again.refund_id)).toEqual([{ event_id: event.id, part: 'consult' }, { event_id: event.id, part: 'now' }]);
  });

  test('FREQ-642-AC-37: 同じ二重防止の番号で呼び直すと、前の返金をそのまま返す', async () => {
    const { f, ret, received } = await mixedReceive();
    await hResult(db(), received.refund_id, 'failed');
    const key = randomUUID();
    const first = await refundReturn(ret.returnId, f.actor, key);
    const replay = await refundReturn(ret.returnId, f.actor, key);
    expect(replay).toMatchObject({ refund_id: first.refund_id, amount: 37000, replayed: true });
    expect(Number((await q('select count(*) n from public.order_refunds where return_id=$1', [ret.returnId])).rows[0].n)).toBe(2);
  });

  test.each([
    ['率の手数料 10%', { percent: 10 }],
    ['率の手数料 10% を免除', { percent: 10, waived: true }],
  ])('FREQ-642-AC-37: %s の受け取りでも、返し直しの額は出来事に残した額の和', async (_label, o) => {
    const { f, ret, received, event } = await mixedReceive(o);
    await hResult(db(), received.refund_id, 'failed');
    const expected = Number(event.now_refund) + Number(event.consult_refund);
    expect(await screenBasis(ret.returnId)).toBe(expected);
    const retry = await refundReturn(ret.returnId, f.actor);
    expect(retry.amount).toBe(expected);
    expect((await refundLines(retry.refund_id)).reduce((sum, l) => sum + Number(l.amount), 0)).toBe(37000);
  });

  test('FREQ-642-AC-37: 返送料（固定の費用 1,000円）は失敗した今すぐの返金から返品の引く手数料に戻り、返し直しで引き直す（16,000円 → 36,000円）', async () => {
    const { f, ret, received } = await mixedReceive({ fixed: 1000 });
    const fee = async () => Number((await q('select fee_pending_deduction n from public.order_returns where id=$1', [ret.returnId])).rows[0].n);
    const refundOf = async (id: string) => (await q('select amount, return_fee_deduction from public.order_refunds where id=$1', [id])).rows[0];
    expect(await refundOf(received.refund_id)).toEqual({ amount: 16000, return_fee_deduction: 1000 });
    expect(await fee()).toBe(0);
    await hResult(db(), received.refund_id, 'failed');
    expect(await fee()).toBe(1000);
    const retry = await refundReturn(ret.returnId, f.actor);
    expect(retry.amount).toBe(36000);
    expect(await refundOf(retry.refund_id)).toEqual({ amount: 36000, return_fee_deduction: 1000 });
    expect(await fee()).toBe(0);
  });

  test('FREQ-642-AC-37: 失敗した今すぐの分を返金しないで終えた後、残りの品を相談で受け取ると、返金は新しい相談の分だけ', async () => {
    const f = await hRefundFixture(db(), true);
    const ret = await createUbReturn(db(), f, [{ quantity: 1 }, { quantity: 1 }]);
    const received = await ubReceive(db(), { returnId: ret.returnId, actorId: f.actor, choice: 'now', units: [unit(ret.lineIds[0])] });
    await hResult(db(), received.refund_id, 'failed');
    const waived = await refundReturn(ret.returnId, f.actor, randomUUID(), 0);
    expect(waived).toMatchObject({ refund_id: null, amount: 0, status: 'waived' });
    const [first] = await eventsOf(f.orderId);
    expect((await q('select event_id, part from public.order_unit_event_waives where event_id=$1', [first.id])).rows)
      .toEqual([{ event_id: first.id, part: 'now' }]);
    expect(await screenBasis(ret.returnId)).toBe(0);
    await ubReceive(db(), { returnId: ret.returnId, actorId: f.actor, choice: 'consult', units: [unit(ret.lineIds[1])] });
    const [, second] = await eventsOf(f.orderId);
    expect(await screenBasis(ret.returnId)).toBe(Number(second.consult_refund));
    const consult = await refundReturn(ret.returnId, f.actor);
    expect(consult.amount).toBe(Number(second.consult_refund));
    expect(await linksOf(consult.refund_id)).toEqual([{ event_id: second.id, part: 'consult' }]);
  });

  test('FREQ-642-AC-37: 相談の分を返金しないで終えた後、残りの品を相談で受け取ると、返金は新しい相談の分だけ（移行 D からの穴）', async () => {
    const f = await hRefundFixture(db(), true);
    const ret = await createUbReturn(db(), f, [{ quantity: 1 }, { quantity: 1 }]);
    await ubReceive(db(), { returnId: ret.returnId, actorId: f.actor, choice: 'consult', units: [unit(ret.lineIds[0])] });
    expect(await refundReturn(ret.returnId, f.actor, randomUUID(), 0)).toMatchObject({ refund_id: null, status: 'waived' });
    const [first] = await eventsOf(f.orderId);
    expect((await q('select part from public.order_unit_event_waives where event_id=$1', [first.id])).rows).toEqual([{ part: 'consult' }]);
    await ubReceive(db(), { returnId: ret.returnId, actorId: f.actor, choice: 'consult', units: [unit(ret.lineIds[1])] });
    const [, second] = await eventsOf(f.orderId);
    const consult = await refundReturn(ret.returnId, f.actor);
    expect(consult.amount).toBe(Number(second.consult_refund));
    expect(await linksOf(consult.refund_id)).toEqual([{ event_id: second.id, part: 'consult' }]);
  });

  test('FREQ-642-AC-37: 出来事が2つ（今すぐだけで失敗・相談だけ）なら、1つの返金が両方の出来事の分を返して両方を結ぶ', async () => {
    const f = await hRefundFixture(db(), true);
    const ret = await createUbReturn(db(), f, [{ quantity: 1 }, { quantity: 1 }]);
    const received = await ubReceive(db(), { returnId: ret.returnId, actorId: f.actor, choice: 'now', units: [unit(ret.lineIds[0])] });
    await hResult(db(), received.refund_id, 'failed');
    await ubReceive(db(), { returnId: ret.returnId, actorId: f.actor, choice: 'consult', units: [unit(ret.lineIds[1])] });
    const [a, b] = await eventsOf(f.orderId);
    const expected = Number(a.now_refund) + Number(b.consult_refund);
    expect(await screenBasis(ret.returnId)).toBe(expected);
    const retry = await refundReturn(ret.returnId, f.actor);
    expect(retry.amount).toBe(expected);
    expect((await q('select event_id, part from public.order_unit_event_refunds where refund_id=$1 order by part', [retry.refund_id])).rows)
      .toEqual([{ event_id: b.id, part: 'consult' }, { event_id: a.id, part: 'now' }]);
  });

  test.each([
    ['今すぐ1着・相談1着', 'mixed', 'ub_refund_lines'],
    ['今すぐだけ', 'now', 'ub_refund_event'],
  ])('FREQ-642-AC-37: 今すぐの返金がエラー（error）の間は、%s の返品の返金を断る（既知の制限）', async (_label, choice, detail) => {
    const f = await hRefundFixture(db(), true);
    const ret = await createUbReturn(db(), f, choice === 'mixed' ? [{ quantity: 1 }, { quantity: 1 }] : [{ quantity: 1 }]);
    const received = await ubReceive(db(), { returnId: ret.returnId, actorId: f.actor, choice: choice as 'mixed' | 'now',
      units: choice === 'mixed' ? [unit(ret.lineIds[0], 1, 'now'), unit(ret.lineIds[1], 1, 'consult')] : [unit(ret.lineIds[0])] });
    await q("select outcome from public.mark_order_refund_error($1::uuid,'not_found_in_stripe',false)", [received.refund_id]);
    expect((await q('select status from public.order_refunds where id=$1', [received.refund_id])).rows[0].status).toBe('error');
    expect(await failure(() => refundReturn(ret.returnId, f.actor))).toMatchObject({ code: '22023', message: 'UNIT_PRICING_INVALID', detail });
  });

  test('FREQ-642-AC-37: 今すぐの返金がエラー（error）の間は、返金しないで終える（0円）も ub_refund_lines で断り、何も書かない', async () => {
    const { f, ret, received } = await mixedReceive();
    await q("select outcome from public.mark_order_refund_error($1::uuid,'not_found_in_stripe',false)", [received.refund_id]);
    expect(await failure(() => refundReturn(ret.returnId, f.actor, randomUUID(), 0)))
      .toMatchObject({ code: '22023', message: 'UNIT_PRICING_INVALID', detail: 'ub_refund_lines' });
    expect(await waitingOf(ret.returnId)).toBe(2);
    expect(Number((await q(`select count(*) n from public.order_unit_event_waives w join public.order_unit_events e on e.id=w.event_id
      where e.order_id=$1`, [f.orderId])).rows[0].n)).toBe(0);
    // エラーが片付けば（ここでは失敗）、両方の分を1つの返金で返せる
    await hResult(db(), received.refund_id, 'failed');
    expect((await refundReturn(ret.returnId, f.actor)).amount).toBe(37000);
  });

  test('FREQ-642-AC-37: 移行の前に写しのある返品を返金しないで終えた記録があれば、移行は ubx_waive_backfill で止まる', async () => {
    const guard = sql.split('-- UBX_WAIVE_GUARD_BEGIN\n')[1]?.split('-- UBX_WAIVE_GUARD_END')[0] ?? '';
    expect(guard).not.toBe('');
    const { f, ret } = await mixedReceive();
    await refundReturn(ret.returnId, f.actor, randomUUID(), 0);
    expect(await failure(() => q(guard)))
      .toEqual({ code: 'P0001', message: 'UNIT_BINDING_REFUND_RETRY_MIGRATION_ASSERTION_FAILED', detail: 'ubx_waive_backfill' });
  });

  test('FREQ-642-AC-37: 返金しないで終えた記録の表は追記だけで、書き換えを拒む', async () => {
    const { f, ret } = await mixedReceive();
    await refundReturn(ret.returnId, f.actor, randomUUID(), 0);
    const rows = (await q('select count(*) n from public.order_unit_event_waives w join public.order_unit_events e on e.id=w.event_id where e.order_id=$1', [f.orderId])).rows;
    expect(Number(rows[0].n)).toBe(1);
    expect(await failure(() => q("update public.order_unit_event_waives set part='now' where event_id in (select id from public.order_unit_events where order_id=$1)", [f.orderId])))
      .toMatchObject({ code: '55000' });
  });

  test('FREQ-642-AC-37: 1つの返金が同じ出来事の今すぐと相談の分を持てる（主キーは出来事・返金・分）', async () => {
    const pk = (await q(`select pg_get_constraintdef(c.oid) d from pg_constraint c
      where c.conrelid='public.order_unit_event_refunds'::regclass and c.contype='p'`)).rows;
    expect(pk).toEqual([{ d: 'PRIMARY KEY (event_id, refund_id, part)' }]);
    const { received } = await mixedReceive();
    // 書き換えは今までどおり拒む
    expect(await failure(() => q("update public.order_unit_event_refunds set part='consult' where refund_id=$1", [received.refund_id])))
      .toMatchObject({ code: '55000' });
  });
});

const ubxAssert = sql.split('-- UBX_FINAL_ASSERT_BEGIN\n')[1]?.split('-- UBX_FINAL_ASSERT_END')[0] ?? '';

describeLocalDb('FREQ-642-AC-37: unit binding refund retry migration final assertion (controller only)', (db) => {
  beforeEach(async () => { await db().query('begin'); await db().query('select pg_advisory_xact_lock(190521,1)'); });
  afterEach(async () => { await db().query('rollback'); });
  async function attempt(change = ''): Promise<Failure | null> {
    await db().query('savepoint ubx_assert');
    let failure: Failure | null = null;
    try {
      await db().query(`create temp table ubx_writer_baseline on commit drop as
        select x::oid as oid from unnest(private.group_g_writer_allowlist()) as t(x)`);
      if (change) await db().query(change);
      await db().query(ubxAssert);
    } catch (caught) { const e = caught as Failure; failure = { code: e.code, message: e.message, detail: e.detail }; }
    finally { await db().query('rollback to savepoint ubx_assert'); await db().query('release savepoint ubx_assert'); }
    return failure;
  }
  const replaceBody = (signature: string, from: string, to: string) => `do $x$ begin execute replace(pg_get_functiondef('${signature}'::regprocedure), '${from}', '${to}'); end $x$`;
  const CORE = 'private.begin_order_refund_core(uuid,text,uuid,jsonb,boolean,integer,integer,text,text,text,boolean,uuid,integer,uuid,integer,uuid)';

  test('FREQ-642-AC-37: 末尾の確かめは改変なしで通る', async () => {
    expect(ubxAssert).not.toBe('');
    expect(await attempt()).toBeNull();
  });

  test.each([
    ['alter table public.order_unit_event_refunds drop constraint order_unit_event_refunds_pkey', 'ubx_schema'],
    ['alter table public.order_unit_event_refunds disable trigger ub_order_unit_event_refunds_immutable', 'ubx_schema'],
    [replaceBody(CORE, 'ub_refund_lines', 'ub_refund_linex'), 'ubx_functions'],
    [replaceBody('private.admin_refund_return(uuid,uuid,uuid,integer,integer,text,boolean,jsonb)', 'ub_refund_event', 'ub_refund_evenx'), 'ubx_functions'],
    [replaceBody('private.order_unit_link_refund(uuid,uuid,text)', 'ub_link_2', 'ub_link_x'), 'ubx_functions'],
    ['grant execute on function ' + CORE + ' to service_role', 'ubx_acl'],
    ['grant execute on function private.order_unit_link_refund(uuid,uuid,text) to service_role', 'ubx_acl'],
    ['revoke execute on function public.admin_refund_return(uuid,uuid,uuid,integer,integer,text,boolean,jsonb) from service_role', 'ubx_acl'],
    [replaceBody('private.order_unit_return_refund_parts(uuid)', 'ORDER BY e.seq, p.part', 'ORDER BY p.part, e.seq'), 'ubx_functions'],
    ['grant execute on function private.order_unit_return_refund_parts(uuid) to service_role', 'ubx_acl'],
    ['alter table public.order_unit_event_waives drop constraint order_unit_event_waives_pkey', 'ubx_schema'],
    ['alter table public.order_unit_event_waives disable trigger ub_order_unit_event_waives_immutable', 'ubx_schema'],
    ['alter table public.order_unit_event_waives disable row level security', 'ubx_schema'],
    ['grant insert on public.order_unit_event_waives to service_role', 'ubx_acl'],
    ['grant select on public.order_unit_event_waives to authenticated', 'ubx_acl'],
    ['insert into ubx_writer_baseline values (4000000001)', 'ubx_allowlist'],
  ])('FREQ-642-AC-37: 改変 %s はP0001とDETAIL=%sで拒む', async (change, detail) => {
    expect(await attempt(change)).toEqual({ code: 'P0001', message: 'UNIT_BINDING_REFUND_RETRY_MIGRATION_ASSERTION_FAILED', detail });
    expect(await attempt()).toBeNull();
  });
});
