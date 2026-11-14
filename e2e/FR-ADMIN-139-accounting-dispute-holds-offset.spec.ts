import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { succeedRefund } from '../tests/integration/db/helpers/accounting-returns-fixtures';
import { hBegin } from '../tests/integration/db/helpers/group-h-refund-fixtures';
import { DISPUTE_HOLD_REFUND_MESSAGE } from '@/lib/orders/refund/refund-messages';
import { DISPUTE_HOLD_CODE, DISPUTE_HOLD_MESSAGE } from '@/lib/orders/shipment-slips/shipment-slip-notice';
import { withAccountingScenario, type AccountingScenario, type E2eReturnFlow } from './accounting-test-utils';
import { CHECKOUT_VIEWPORTS, expectNoHorizontalOverflow } from './checkout-flow-helpers';
import { openDetailRefundDialog } from './refund-test-utils';
import { createDraftInDb, createShippingMaterial, withShippingScenario } from './shipping-test-utils';

// FREQ-580 / FREQ-581（計画3）: カード会社の判断待ち（needs_response）の注文の返金・発送票の確定の止めと、取り消しの確定の相殺（返品の返金待ち・返金済み）を、
// 本物の route・本物の画面・手元の Supabase で確かめる。材料（注文・取り消し・Stripe の残高の取引・返金の結果）は手元の DB へ直に入れる。
// Stripe は呼ばない。入れた stripe_* の行は「画面と帳簿の表示の証拠」であって、実 Stripe の証拠ではない。
// 止めは本物の route（409 DISPUTE_HOLD）と、事前の止めを通り越して DB の関数を直接呼んだ時の拒否（55000 ACCOUNTING_DISPUTE_HOLD）の2通りで確かめる。
// E2E は今日の日付だけを使う。引かれた時・確定の時刻は今の少し先にして、返金・出荷の事実より後になるようにする。
// 取り消しの原因の設定（原因ごとに1つで消せない）は fraudulent を使う（無ければ 7530 へ設定する）。仕訳・取り消しは消せないので db reset してから流す。

test.use({ trace: 'off', locale: 'ja-JP' });
// 仕訳・計上待ち・取り消しは全体で共有する状態なので、このファイルの中は1つずつ流す（他のファイルとは並列）。
test.describe.configure({ mode: 'default' });

const DISPUTE_AMOUNT = 30_000;
const isoAfter = (seconds: number) => new Date(Date.now() + seconds * 1000).toISOString();

/** 注文の勘定の残高（貸方−借方。sub を渡すと補助を絞る） */
async function balanceOf(s: AccountingScenario, orderId: string, account: string, sub: string | null = null): Promise<number> {
  return Number((await s.db.query('select private.accounting_order_account_balance($1,$2,$3) as n', [orderId, account, sub])).rows[0].n);
}

/** 計上係を数回流す（返品の係 → 返金の係 → 取り消しの係の順に流れるので、待っていた物が次の回に入る） */
async function settle(s: AccountingScenario): Promise<void> {
  for (let i = 0; i < 4; i += 1) await s.runPosting(200);
}

/** 取り消しの原因 fraudulent の振り替え先の科目の符号。設定が無ければ 7530 に設定する */
async function disputeCostAccount(s: AccountingScenario): Promise<string> {
  const row = await s.db.query("select account_code from public.accounting_dispute_account_settings where reason = 'fraudulent'");
  if (row.rows[0]) return row.rows[0].account_code as string;
  await s.db.query("select public.admin_set_dispute_account_setting($1::uuid, 'fraudulent', '7530', null, $2::uuid)", [s.admin.userId, randomUUID()]);
  return '7530';
}

/** 取り消しの確定の仕訳の行（`科目(補助):借方/貸方`の順の並びで返す） */
async function confirmedSummary(s: AccountingScenario, disputeId: string): Promise<string[] | null> {
  const entry = await s.entryByKey(`dispute_event:${disputeId}:confirmed:lost`);
  if (!entry) return null;
  return (await s.linesOf(entry.id)).map((line) => `${line.account}${line.subAccount ? `(${line.subAccount})` : ''}:${line.debit}/${line.credit}`);
}

/** 返品の流れの注文に、判断待ちの取り消し（引かれた）を置く。引かれた時刻は今の少し先（返金・出荷の事実より後） */
async function withdrawn(s: AccountingScenario, flow: E2eReturnFlow, at: string) {
  return s.seedDispute({ orderId: flow.orderId, paymentIntentId: flow.paymentIntentId, amount: DISPUTE_AMOUNT, withdrawnAt: at, createdAt: at });
}

/** 取り消しが負けで確定した（Stripe 側の時刻 at） */
function lose(s: AccountingScenario, disputeId: string, at: string) {
  return s.addDisputeHistory({ disputeId, status: 'lost', occurredAt: at, stripeEventCreatedAt: at, eventType: 'charge.dispute.closed' });
}

/** 画面の取り消しの一覧（財務概要のタブ）に、この取り消しが確定として出ることを確かめる */
async function expectDisputeRow(page: Page, s: AccountingScenario, disputeId: string): Promise<void> {
  await s.openAccounting(page, '財務概要');
  const section = page.getByRole('region', { name: 'カード会社からの支払いの取り消し', exact: true });
  const row = section.getByRole('table', { name: 'カード会社からの支払いの取り消しの一覧' }).getByRole('row').filter({ hasText: disputeId });
  for (let i = 0; i < 30 && (await row.count()) === 0; i += 1) {
    const more = section.getByRole('button', { name: 'さらに読み込む', exact: true });
    if ((await more.count()) === 0) break;
    await more.click();
  }
  await expect(row.first()).toBeVisible({ timeout: 60_000 });
  await expect(row.first()).toContainText('取り消しが確定した');
  await expectNoHorizontalOverflow(page);
}

for (const viewport of CHECKOUT_VIEWPORTS) {
  test.describe(`FR-ADMIN-139 (${viewport.width}px)`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize(viewport);
    });

    test('FREQ-580-AC-01: 判断待ちの注文の返金は止まり、理由が出る（本物のroute。DB の拒否）', async ({ page }) => {
      test.setTimeout(300_000);
      await withAccountingScenario('dispute-hold-refund', async (s) => {
        const f = await s.seedRefundFlow(true);
        await s.seedDisputeHold(f.orderId);
        const refunds = async () => Number((await s.db.query('select count(*)::int as n from public.order_refunds where order_id = $1', [f.orderId])).rows[0].n);

        // 本物の返金の route は 409 で止め、判断待ちの注文の番号を返す（Stripe は呼ばない）。返金の行は残らない
        const reply = await s.api(s.admin, `/api/admin/orders/${f.orderId}/refund`, 'POST', {
          requestKey: randomUUID(), lines: [{ orderItemId: f.itemId, quantity: 1, beforeShipment: false }], restock: false,
          shippingAmount: 0, amount: 1_000, note: null, stripeReason: 'requested_by_customer', notifyCustomer: false,
        });
        expect(reply.status, reply.text.slice(0, 300)).toBe(409);
        expect(reply.body).toMatchObject({ code: DISPUTE_HOLD_CODE, orderIds: [f.orderId] });
        expect(await refunds()).toBe(0);
        // 返金の画面が読む材料にも判断待ちの印が付く
        const materials = await s.api(s.admin, `/api/admin/orders/${f.orderId}/refund`);
        expect(materials.status, materials.text.slice(0, 200)).toBe(200);
        expect(materials.body.disputeHold).toBe(true);

        // DB の拒否: 事前の止めを通り越して DB の関数を直接呼んでも、返金の行・履歴は残らない
        const refusal = await s.material(async () => hBegin(s.db, f, 1_000)).then(() => null, (error: { code?: string; message?: string; detail?: string }) => error);
        expect(refusal).toMatchObject({ code: '55000', message: 'ACCOUNTING_DISPUTE_HOLD', detail: 'order_count=1' });
        expect(await refunds()).toBe(0);

        // 画面: 返金の画面に理由が出て、返金は送れない
        await s.openOrder(page, f.orderId);
        const dialog = await openDetailRefundDialog(page, f.orderId);
        await expect(dialog.getByTestId('refund-dispute-hold')).toHaveText(DISPUTE_HOLD_REFUND_MESSAGE, { timeout: 60_000 });
        await expect(dialog.getByRole('button', { name: /返金する$/ })).toBeDisabled();
        await expectNoHorizontalOverflow(page);
        expect(await refunds()).toBe(0);
      }, { period: 'none' });
    });

    test('FREQ-580-AC-02: 判断待ちの注文を含む発送票は、事前の止めをすり抜けても DB が止める', async () => {
      test.setTimeout(300_000);
      await withAccountingScenario('dispute-hold-slip', async (s) => {
        await withShippingScenario(async (ctx) => {
          const material = await createShippingMaterial(ctx.client, { quantity: 1 });
          const draft = await createDraftInDb(ctx, [material]);
          await s.seedDisputeHold(material.orderId);
          const body = {
            expectedVersion: draft.version, carrier: null, trackingNumber: null, shipmentDate: s.today, notifyCustomer: false, requestKey: randomUUID(),
          };
          const slipState = async () => ({
            stage: (await s.db.query('select stage from public.shipment_slips where id = $1', [draft.id])).rows[0].stage as string,
            fulfillments: Number((await s.db.query('select count(*)::int as n from public.order_fulfillments where order_id = $1', [material.orderId])).rows[0].n),
          });

          // 事前の止め: 本物の確定の route は 409 で止める
          const refused = await s.api(s.admin, `/api/admin/shipment-slips/${draft.id}/confirm`, 'POST', body);
          expect(refused.status, refused.text.slice(0, 200)).toBe(409);
          expect(refused.body).toEqual({ error: DISPUTE_HOLD_MESSAGE, code: DISPUTE_HOLD_CODE, orderIds: [material.orderId] });
          expect(await slipState()).toEqual({ stage: 'draft', fulfillments: 0 });

          // すり抜け: 事前の止めを通らずに DB の関数を直接呼んでも、DB が止める（55000）。発送票は下書きのまま、発送の行も増えない
          const direct = await s.db.query(
            'select public.admin_confirm_shipment_slip($1,$2,$3,$4,$5::date,true,$6,$7) as r',
            [draft.id, draft.version, 'yamato', 'ab-123', s.today, s.admin.userId, randomUUID()],
          ).then(() => null, (error: { code?: string; message?: string; detail?: string }) => error);
          expect(direct).toMatchObject({ code: '55000', message: 'ACCOUNTING_DISPUTE_HOLD', detail: 'order_count=1' });
          expect(await slipState()).toEqual({ stage: 'draft', fulfillments: 0 });
        });
      }, { period: 'none' });
    });

    test('FREQ-581-AC-02: 返品の返金待ちがある注文の確定で、返金待ちが消えて残りだけ費用になる', async ({ page }) => {
      test.setTimeout(300_000);
      await withAccountingScenario('dispute-offset-pay', async (s) => {
        await s.todayPeriod();
        const cost = await disputeCostAccount(s);
        const flow = await s.seedReturnFlow();
        // 相談で受け取り、返品の返金待ち 16,875円（18,750円−手数料1,875円）を立てる
        await s.receiveReturn(flow);
        await settle(s);
        expect(await balanceOf(s, flow.orderId, '2130', 'return_refund')).toBe(16_875);
        // 30,000円が引かれ、負けで確定する
        const withdrawnAt = isoAfter(5);
        const dispute = await withdrawn(s, flow, withdrawnAt);
        await settle(s);
        await lose(s, dispute.disputeId, isoAfter(10));
        await settle(s);

        // 確定の仕訳: 返金待ち16,875円を先に消し、残り13,125円だけが費用（引かれた分は判断待ちの30,000円から出る）
        expect(await confirmedSummary(s, dispute.disputeId)).toEqual([`${cost}:13125/0`, '2130(return_refund):16875/0', '1470(dispute_pending):0/30000']);
        expect(await balanceOf(s, flow.orderId, '2130', 'return_refund')).toBe(0);
        const review = Number((await s.db.query(
          "select coalesce(sum(debit - credit), 0)::int as n from public.accounting_journal_lines where order_id = $1 and account_code = '1470' and sub_account = 'dispute_refund_overlap_review'",
          [flow.orderId])).rows[0].n);
        expect(review).toBe(0);
        const open = await s.db.query('select count(*)::int as n from public.accounting_pending_events where order_id = $1 and resolved_at is null', [flow.orderId]);
        expect(open.rows[0].n).toBe(0);
        await expectDisputeRow(page, s, dispute.disputeId);
      }, { period: 'none' });
    });

    test('FREQ-581-AC-03: 返金済みと重なる分は「分けて調べる」に出て、費用にならない', async ({ page }) => {
      test.setTimeout(300_000);
      await withAccountingScenario('dispute-offset-review', async (s) => {
        await s.todayPeriod();
        const cost = await disputeCostAccount(s);
        const flow = await s.seedReturnFlow();
        // 今すぐ返金で受け取り（返金 16,875円を始める）、取り消しが引かれた後に返金が成功する
        const received = await s.receiveReturn(flow, { choice: 'now' });
        expect(received.refund_id).not.toBeNull();
        const withdrawnAt = isoAfter(5);
        const dispute = await withdrawn(s, flow, withdrawnAt);
        await s.material(() => succeedRefund(s.db, received.refund_id as string, { at: isoAfter(6) }));
        await settle(s);
        expect(await balanceOf(s, flow.orderId, '2130', 'return_refund')).toBe(0);
        await lose(s, dispute.disputeId, isoAfter(10));
        await settle(s);

        // 確定の仕訳: 返金済みの16,875円は「分けて調べる」の補助へ移り、費用は残り13,125円だけ
        expect(await confirmedSummary(s, dispute.disputeId)).toEqual([`${cost}:13125/0`, '1470(dispute_refund_overlap_review):16875/0', '1470(dispute_pending):0/30000']);
        const review = Number((await s.db.query(
          "select coalesce(sum(debit - credit), 0)::int as n from public.accounting_journal_lines where order_id = $1 and account_code = '1470' and sub_account = 'dispute_refund_overlap_review'",
          [flow.orderId])).rows[0].n);
        expect(review).toBe(16_875);
        const costLines = await s.db.query(
          `select coalesce(sum(l.debit - l.credit), 0)::int as n from public.accounting_journal_lines l join public.accounting_journal_entries e on e.id = l.entry_id
            where e.dedupe_key = $1 and l.account_code = $2`, [`dispute_event:${dispute.disputeId}:confirmed:lost`, cost]);
        expect(costLines.rows[0].n).toBe(DISPUTE_AMOUNT - 16_875);
        await expectDisputeRow(page, s, dispute.disputeId);
      }, { period: 'none' });
    });
  });
}
