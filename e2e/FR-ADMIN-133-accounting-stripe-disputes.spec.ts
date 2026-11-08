import { randomInt, randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { DISPUTE_HOLD_CODE, DISPUTE_HOLD_MESSAGE } from '@/lib/orders/shipment-slips/shipment-slip-notice';
import { mockAdminBackgroundApis } from './admin-test-utils';
import {
  addDaysIso,
  ledgerRowCells,
  selectAccountingPeriod,
  selectLedgerAccount,
  withAccountingScenario,
  type AccountingScenario,
} from './accounting-test-utils';
import { CHECKOUT_VIEWPORTS, expectNoHorizontalOverflow } from './checkout-flow-helpers';
import { createDraftInDb, createShippingMaterial, openSlip, withShippingScenario } from './shipping-test-utils';

// FREQ-565 / FREQ-566 / FREQ-568（計画2）: Stripe の手数料・照合・補充とカード会社からの支払いの取り消しを、本物の route・本物の画面・手元の Supabase で確かめる。
// 材料（注文・Stripe の残高の取引・取り消し・確定した発送票）は手元の DB へ直に入れる。Stripe は呼ばない。入れた stripe_* の行は
// 「画面と帳簿の表示の証拠」であって、実 Stripe の証拠ではない（計画2 Task 16 で本物の Stripe の読みを確かめる）。
// 仕訳・期間・Stripe の行・取り消しの設定は消せないので db reset してから流す。期間は今日を含む期間と、手数料の月の照合の月を含む期間（ensurePeriodFor）。
// 取り消しの原因の設定（原因ごとに1つ）は消せないので、試験は設定の無い原因を選ぶ。

test.use({ trace: 'off', locale: 'ja-JP' });
// 計上待ち・Stripe の行・照合は全体で共有する状態なので、このファイルの中は1つずつ流す（他のファイルとは並列）。
test.describe.configure({ mode: 'default' });

const FEE_ACCOUNT = { code: '6280', name: '支払手数料' };
const SUSPENSE = { code: '1470', name: '仮払金' };
const yen = (value: number) => value.toLocaleString('ja-JP');
const slash = (date: string) => date.replaceAll('-', '/');
const pad2 = (value: number) => String(value).padStart(2, '0');
const isoAgo = (seconds: number) => new Date(Date.now() - seconds * 1000).toISOString();

/** 取り消しの原因のうち、設定のまだ無い物（設定は消せないので、試験ごとに1つ使う） */
const DISPUTE_CAUSE_CANDIDATES: ReadonlyArray<readonly [string, string]> = [
  ['product_unacceptable', '商品が違う・不備'],
  ['duplicate', '二重の請求'],
  ['general', '一般の理由'],
  ['credit_not_processed', '返金が済んでいない'],
  ['unrecognized', '身に覚えがない'],
  ['product_not_received', '商品が届かない'],
  ['fraudulent', '不正利用'],
  ['subscription_canceled', '定期購入の解約'],
];

async function unusedDisputeCause(s: AccountingScenario): Promise<{ reason: string; label: string }> {
  const reply = await s.api(s.admin, '/api/admin/accounting/dispute-settings');
  expect(reply.status, reply.text.slice(0, 200)).toBe(200);
  const used = new Set((reply.body.data.settings as Array<{ reason: string }>).map((row) => row.reason));
  const found = DISPUTE_CAUSE_CANDIDATES.find(([reason]) => !used.has(reason));
  if (!found) throw new Error('設定の無い取り消しの原因が残っていない。db reset してから流す');
  return { reason: found[0], label: found[1] };
}

/** 手数料の月の照合を使っていない月（取引も請求書も無い月）を、来年以降から選ぶ。その月と翌月を含む期間を足す */
async function freshFeeMonth(s: AccountingScenario): Promise<string> {
  const year = Number(s.today.slice(0, 4)) + 1;
  const months = Array.from({ length: 36 }, (_, index) => `${year + Math.floor(index / 12)}-${pad2((index % 12) + 1)}`);
  for (let tries = 0; tries < months.length; tries += 1) {
    const month = months.splice(randomInt(0, months.length), 1)[0];
    const reply = await s.api(s.admin, `/api/admin/accounting/reconciliation?kind=stripe-fee&month=${month}`);
    expect(reply.status, reply.text.slice(0, 200)).toBe(200);
    const data = reply.body.data;
    if (data.jst_total === 0 && data.utc_total === 0 && data.invoice_total === null && data.next_month_adjustments.length === 0) {
      const next = addDaysIso(`${month}-28`, 8).slice(0, 7);
      await s.ensurePeriodFor(`${month}-15`);
      await s.ensurePeriodFor(`${next}-03`);
      return month;
    }
  }
  throw new Error('使っていない月が無い');
}

async function openSlipWithRealSession(page: Page, s: AccountingScenario, slipId: string): Promise<void> {
  await s.attach(page);
  await mockAdminBackgroundApis(page);
  await page.route('**/api/auth/refresh', (route) => route.continue());
  await openSlip(page, slipId);
}

for (const viewport of CHECKOUT_VIEWPORTS) {
  test.describe(`FR-ADMIN-133 (${viewport.width}px)`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize(viewport);
    });

    test('FREQ-565-AC-01: 手数料が1件ずつ仕訳に出る', async ({ page }) => {
      test.setTimeout(300_000);
      await withAccountingScenario('fee-journal', async (s) => {
        const period = await s.todayPeriod();
        // 手数料の違う2件の支払い。手数料は支払い1件につき仕訳1本（免税の期間なので税込み1本）
        const first = await s.seedPaidOrder({ lines: [{ price: 10_000, quantity: 1 }] });
        const second = await s.seedPaidOrder({ lines: [{ price: 15_000, quantity: 1 }] });
        const feeA = 300 + randomInt(1, 90);
        const feeB = 500 + randomInt(1, 90);
        const txA = await s.seedStripeCharge({ paymentIntentId: first.paymentIntentId, amount: first.total, orderId: first.orderId, fee: feeA });
        const txB = await s.seedStripeCharge({ paymentIntentId: second.paymentIntentId, amount: second.total, orderId: second.orderId, fee: feeB });

        await s.runPosting();
        const entries = [];
        for (const [txId, fee] of [[txA, feeA], [txB, feeB]] as const) {
          const entry = await s.entryByKey(`stripe:fee:${txId}`);
          expect(entry, `手数料の仕訳 ${txId}`).not.toBeNull();
          expect(entry).toMatchObject({ eventKind: 'stripe_fee', entryDate: s.today, periodId: period.id, description: '決済の手数料' });
          expect(await s.linesOf(entry!.id)).toEqual([
            { account: '6280', debit: fee, credit: 0, orderId: null, subAccount: null },
            { account: '1160', debit: 0, credit: fee, orderId: null, subAccount: null },
          ]);
          entries.push({ entry: entry!, fee });
        }
        // 2回目の計上で増えない（1件に1本）
        await s.runPosting();
        const count = await s.db.query("select count(*)::int as n from public.accounting_journal_entries where dedupe_key = any($1::text[])", [[`stripe:fee:${txA}`, `stripe:fee:${txB}`]]);
        expect(count.rows[0].n).toBe(2);

        // 本物の journal route にも、相手を「ストライプジャパン株式会社」にした手数料の仕訳が出る
        const journal = await s.journalBetween(period.id, s.today, s.today);
        for (const { entry, fee } of entries) {
          const listed = journal.entries.find((candidate) => candidate.id === entry.id);
          expect(listed!.lines.map((line) => [line.accountCode, line.debit, line.credit])).toEqual([['6280', fee, 0], ['1160', 0, fee]]);
        }

        // 画面: 帳簿の支払手数料に、手数料が1件ずつ出る
        await s.openAccounting(page, '帳簿');
        await selectAccountingPeriod(page, period.name);
        await selectLedgerAccount(page, FEE_ACCOUNT);
        for (const { entry, fee } of entries) {
          const cells = await ledgerRowCells(page, entry.entryNo);
          expect(cells[5]).toBe(yen(fee));
          expect(cells[3]).toContain('ストライプジャパン株式会社');
        }
        await expectNoHorizontalOverflow(page);
      }, { period: 'none' });
    });

    test('FREQ-566-AC-02: 手数料の月の照合で請求書の合計を入れると説明のつかない差が出る', async ({ page }) => {
      test.setTimeout(300_000);
      await withAccountingScenario('fee-reconciliation', async (s) => {
        await s.todayPeriod();
        const month = await freshFeeMonth(s);
        const next = addDaysIso(`${month}-28`, 8).slice(0, 7);
        // 1件は月の途中（日本時間もUTCも同じ月）、もう1件は日本時間の月初の朝8時（UTCでは前の月の23時）
        const middle = await s.seedStripeFee({ type: 'stripe_fee', reportingCategory: 'fee', amount: -500, createdAt: `${month}-15T03:00:00Z` });
        const edge = await s.seedStripeFee({ type: 'stripe_fee', reportingCategory: 'fee', amount: -300, createdAt: new Date(`${month}-01T08:00:00+09:00`).toISOString() });
        await s.runPosting();

        await s.openAccounting(page, '照合');
        await page.getByLabel('照合する月').fill(month);
        await page.getByRole('button', { name: '手数料を照合する' }).click();
        const firstStage = page.getByRole('group', { name: '1段目 日本時間とUTCの差' });
        await expect(firstStage).toBeVisible({ timeout: 30_000 });
        // 日本時間の合計 800 とUTCの合計 500 の差 300 は、月初の朝の1件で説明がつく
        await expect(firstStage).toContainText(`日本時間の合計 ¥800`);
        await expect(firstStage).toContainText(`UTCの合計 ¥500`);
        await expect(firstStage).toContainText(`月またぎで説明できる差 ¥300`);
        await expect(firstStage).toContainText(edge);
        await expect(firstStage).not.toContainText(middle);
        await expect(page.getByTestId('fee-unexplained-1')).toHaveAttribute('data-tone', 'ok');
        const secondStage = page.getByRole('group', { name: '2段目 UTCと請求書の差' });
        await expect(secondStage).toContainText('請求書の合計が未入力です');
        await expect(page.getByText('帳簿の手数料と取引の差 ¥0')).toBeVisible();

        // 請求書の合計 600 円を入れると、UTCの合計との差 ▲100 円が「説明のつかない差」に出る
        await page.getByLabel('請求書の合計（税込）').fill('600');
        await page.getByLabel('うち消費税').fill('55');
        await page.getByRole('button', { name: '請求書の合計を保存' }).click();
        await expect(page.getByText('保存しました。')).toBeVisible({ timeout: 30_000 });
        await expect(secondStage).toContainText('請求書の合計 ¥600', { timeout: 30_000 });
        const unexplained = page.getByTestId('fee-unexplained-2');
        await expect(unexplained).toHaveAttribute('data-tone', 'alert');
        await expect(unexplained).toContainText('説明のつかない差 ▲¥100');
        await expect(secondStage).toContainText('符号の向きは確認中');
        await expectNoHorizontalOverflow(page);

        // 翌月に税額の調整（100円）が出ると、差は翌月の調整で説明がつき、説明のつかない差は 0 になる
        await s.seedStripeFee({ type: 'tax_fee', reportingCategory: 'tax', amount: -100, createdAt: `${next}-03T03:00:00Z` });
        await s.runPosting();
        await page.getByRole('button', { name: '手数料を照合する' }).click();
        await expect(secondStage).toContainText('翌月の調整で説明できる分 ¥100', { timeout: 30_000 });
        await expect(page.getByTestId('fee-unexplained-2')).toHaveAttribute('data-tone', 'ok');
        await expect(page.getByTestId('fee-unexplained-2')).toContainText('説明のつかない差 ¥0');
        await expectNoHorizontalOverflow(page);
      }, { period: 'none' });
    });

    test('FREQ-566-AC-03: Stripeの残高の照合で仕訳になっていない取引の種類が出る', async ({ page }) => {
      test.setTimeout(300_000);
      await withAccountingScenario('balance-reconciliation', async (s) => {
        await s.todayPeriod();
        // 仕訳にならないまま残る取引（計画3で計上する返金の元本・注文に結び付かない支払い・知らない種類・入金の取引）
        await s.seedStripeFee({ type: 'refund', reportingCategory: 'refund', amount: -1_000 });
        await s.seedStripeCharge({ paymentIntentId: null, amount: 700 });
        await s.seedStripeFee({ type: `e2e_unknown_${randomUUID().slice(0, 8)}`, reportingCategory: 'other', amount: 200 });
        await s.seedStripeFee({ type: 'payout', reportingCategory: 'payout', amount: -9_000, sourceId: `po_e2e_${randomUUID().slice(0, 12)}` });
        await s.runPosting();

        await s.openAccounting(page, '照合');
        await page.getByRole('button', { name: 'Stripeの残高を照合する' }).click();
        const table = page.getByRole('table', { name: '仕訳になっていない取引の種類' });
        await expect(table).toBeVisible({ timeout: 30_000 });
        for (const label of ['返金の元本（返金の仕訳は別の段で入れます）', '計上待ちの取引', '知らない種類の取引', '入金の取引（仕訳がまだ）']) {
          const row = table.getByRole('row').filter({ hasText: label });
          await expect(row).toHaveCount(1);
          const count = Number((await row.getByRole('cell').nth(1).innerText()).replace(/\D/g, ''));
          expect(count, label).toBeGreaterThanOrEqual(1);
        }
        await expect(page.getByTestId('balance-unexplained')).toContainText('説明のつかない差');
        await expectNoHorizontalOverflow(page);
      }, { period: 'none' });
    });

    test('FREQ-568-AC-02: 出荷済みの注文の支払いの取り消しが判断待ちの仮払金に出て、科目を設定して確定すると振り替わる', async ({ page }) => {
      test.setTimeout(300_000);
      await withAccountingScenario('dispute-assignment', async (s) => {
        const period = await s.todayPeriod();
        const cause = await unusedDisputeCause(s);
        // 4着30,000円の注文を全部送った後に、30,000円の取り消しが引かれる（支払い→出荷→引かれた→確定の時刻の順）
        const order = await s.seedPaidOrder({ lines: [{ price: 7_500, quantity: 4 }], paidAt: isoAgo(900) });
        await s.seedStripeCharge({ paymentIntentId: order.paymentIntentId, amount: order.total, orderId: order.orderId, createdAt: isoAgo(600) });
        await s.runPosting();
        await s.confirmSlipAt(order, { quantity: 4, shipmentDate: s.today, lockedAt: isoAgo(480) });
        await s.runPosting();
        expect(await s.deferredBalance(order.orderId)).toBe(0);

        const dispute = await s.seedDispute({
          orderId: order.orderId, paymentIntentId: order.paymentIntentId, amount: 30_000, reason: cause.reason, fee: 1_500,
          withdrawnAt: isoAgo(300), createdAt: isoAgo(300),
        });
        await s.runPosting();
        const withdrawn = await s.entryByKey(`dispute_event:${dispute.disputeId}:withdrawn:${dispute.txnId}`);
        expect(withdrawn).toMatchObject({ entryDate: s.today, description: 'カード会社からの支払いの取り消し' });
        // 出荷済みなので、費用にせず「仮払金（判断待ち）」に置く
        expect(await s.linesOf(withdrawn!.id)).toEqual([
          { account: '1160', debit: 0, credit: 30_000, orderId: null, subAccount: null },
          { account: '1470', debit: 30_000, credit: 0, orderId: null, subAccount: 'dispute_pending' },
        ]);

        // 画面: 判断待ちの間は「カード会社の判断待ち」、帳簿の仮払金に出る
        const disputeRow = () => page.getByRole('table', { name: 'カード会社からの支払いの取り消しの一覧' }).getByRole('row').filter({ hasText: dispute.disputeId });
        await s.openAccounting(page, '財務概要');
        await expect(disputeRow()).toContainText('カード会社の判断待ち', { timeout: 30_000 });
        await expect(disputeRow()).toContainText(cause.label);
        await expect(disputeRow()).toContainText(yen(30_000));
        await expectNoHorizontalOverflow(page);
        await page.getByRole('tab', { name: '帳簿', exact: true }).click();
        await selectAccountingPeriod(page, period.name);
        await selectLedgerAccount(page, SUSPENSE);
        const suspenseCells = await ledgerRowCells(page, withdrawn!.entryNo);
        expect(suspenseCells[5]).toBe(yen(30_000));

        // 負けが確定する。振り替え先の科目の設定がまだ無いので、「仮払金（確定・科目の決定待ち）」に分けて置く
        await s.addDisputeHistory({ disputeId: dispute.disputeId, status: 'lost', occurredAt: isoAgo(60), stripeEventCreatedAt: isoAgo(120), eventType: 'charge.dispute.closed' });
        await s.runPosting();
        const confirmed = await s.entryByKey(`dispute_event:${dispute.disputeId}:confirmed:lost`);
        expect(confirmed).toMatchObject({ entryDate: s.today, description: 'カード会社からの支払いの取り消しの確定' });
        expect(await s.linesOf(confirmed!.id)).toEqual([
          { account: '1470', debit: 30_000, credit: 0, orderId: null, subAccount: 'dispute_confirmed_unassigned' },
          { account: '1470', debit: 0, credit: 30_000, orderId: null, subAccount: 'dispute_pending' },
        ]);

        // 設定のタブで原因の振り替え先（雑損失）を決め、決定待ちの取り消しを振り替える
        await s.openAccounting(page, '設定・期間');
        await page.getByLabel(`${cause.label}の振り替え先`).selectOption({ label: '7530 雑損失' });
        await page.getByRole('button', { name: `${cause.label}を保存`, exact: true }).click();
        await expect(page.getByText('保存しました。').first()).toBeVisible({ timeout: 30_000 });
        const waiting = page.getByRole('list', { name: '科目の決定待ちの取り消し' }).getByRole('listitem').filter({ hasText: dispute.disputeId });
        await expect(waiting).toContainText('振り替え先 7530 雑損失', { timeout: 30_000 });
        await expect(waiting).toContainText(`確定した日 ${slash(s.today)}`);
        await waiting.getByRole('button', { name: `${dispute.disputeId}を設定の科目へ振り替える` }).click();
        await expect(page.getByText(`${dispute.disputeId}を振り替えました。`)).toBeVisible({ timeout: 30_000 });
        await expect(waiting).toHaveCount(0);
        await expectNoHorizontalOverflow(page);

        // 振り替えの仕訳が1本入り、決定待ちの仮払金は0になる
        const assigned = await s.entryByKey(`dispute_event:${dispute.disputeId}:assigned:1`);
        expect(assigned).toMatchObject({ entryDate: s.today });
        expect(await s.linesOf(assigned!.id)).toEqual([
          { account: '7530', debit: 30_000, credit: 0, orderId: null, subAccount: null },
          { account: '1470', debit: 0, credit: 30_000, orderId: null, subAccount: 'dispute_confirmed_unassigned' },
        ]);
        const left = await s.db.query(
          `select coalesce(sum(l.debit - l.credit), 0)::bigint as b from public.accounting_journal_lines l join public.accounting_journal_entries e on e.id = l.entry_id
            where e.dedupe_key like $1 and l.account_code = '1470' and l.sub_account = 'dispute_confirmed_unassigned'`,
          [`dispute_event:${dispute.disputeId}:%`],
        );
        expect(Number(left.rows[0].b)).toBe(0);

        // 画面: 一覧の振り替え先に設定の科目が出る
        await s.openAccounting(page, '財務概要');
        await expect(disputeRow()).toContainText('取り消しが確定した（お金は戻らない）', { timeout: 30_000 });
        await expect(disputeRow()).toContainText('7530 雑損失');
        await expectNoHorizontalOverflow(page);
      }, { period: 'none' });
    });

    test('FREQ-568-AC-06: 判断待ちの注文を含む発送票は確定が止まり理由が出る（本物のroute）', async ({ page }) => {
      test.setTimeout(300_000);
      await withAccountingScenario('dispute-hold', async (s) => {
        await withShippingScenario(async (ctx) => {
          const material = await createShippingMaterial(ctx.client, { quantity: 1 });
          const draft = await createDraftInDb(ctx, [material]);
          // 注文に、お金が引かれた後でまだ決着していない（needs_response）カード会社の取り消しを入れる（読み口は、引かれた取引のある判断待ちだけを数える）
          await s.seedDispute({ orderId: material.orderId, paymentIntentId: null, amount: 5_000, status: 'needs_response' });

          // 本物の確定の route は 409 で止め、固定の文と判断待ちの注文の番号だけを返す
          const body = {
            expectedVersion: draft.version, carrier: null, trackingNumber: null, shipmentDate: s.today, notifyCustomer: false, requestKey: randomUUID(),
          };
          const refused = await s.api(s.admin, `/api/admin/shipment-slips/${draft.id}/confirm`, 'POST', body);
          expect(refused.status, refused.text.slice(0, 200)).toBe(409);
          expect(refused.body).toEqual({ error: DISPUTE_HOLD_MESSAGE, code: DISPUTE_HOLD_CODE, orderIds: [material.orderId] });
          const slip = await s.db.query('select stage from public.shipment_slips where id = $1', [draft.id]);
          expect(slip.rows[0].stage).toBe('draft');

          // 画面: 発送票の確認から発送確定を押しても、確定せずに理由が出る
          await openSlipWithRealSession(page, s, draft.id);
          await page.getByRole('button', { name: '発送票確認', exact: true }).click();
          await expect(page.getByRole('heading', { name: '発送票の確認', level: 2, exact: true })).toBeVisible();
          await page.getByRole('button', { name: '発送確定', exact: true }).click();
          await expect(page.getByText(DISPUTE_HOLD_MESSAGE).first()).toBeVisible({ timeout: 30_000 });
          const after = await s.db.query('select stage from public.shipment_slips where id = $1', [draft.id]);
          expect(after.rows[0].stage).toBe('draft');
          await expectNoHorizontalOverflow(page);
        });
      }, { period: 'none' });
    });

    test('FREQ-565-AC-06: 残高の補充を入れると仕訳が1本出て、2回目は増えない', async ({ page }) => {
      test.setTimeout(300_000);
      await withAccountingScenario('balance-topup', async (s) => {
        const period = await s.todayPeriod();
        const amount = 50_000 + randomInt(1, 9_000);
        const reference = `E2E-TOPUP-${randomUUID().slice(0, 8)}`;
        await s.openAccounting(page, '財務概要');
        const submit = async () => {
          await page.getByLabel('補充した額（円）').fill(String(amount));
          await page.getByLabel('銀行の日').fill(s.today);
          await page.getByLabel('銀行の取引番号').fill(reference);
          await page.getByRole('button', { name: '補充を記録する' }).click();
        };

        await submit();
        await expect(page.getByText('補充を記録しました。')).toBeVisible({ timeout: 30_000 });
        const entry = await s.entryByKey(`balance_topup:${reference}`);
        expect(entry).toMatchObject({ eventKind: 'balance_topup', entryDate: s.today, periodId: period.id });
        expect(await s.linesOf(entry!.id)).toEqual([
          { account: '1160', debit: amount, credit: 0, orderId: null, subAccount: null },
          { account: '1040', debit: 0, credit: amount, orderId: null, subAccount: null },
        ]);

        // 同じ取引番号でもう一度入れても、仕訳は増えない
        await submit();
        await expect(page.getByText('同じ記録が既にあります。新しくは入れていません。')).toBeVisible({ timeout: 30_000 });
        const count = await s.db.query('select count(*)::int as n from public.accounting_journal_entries where dedupe_key = $1', [`balance_topup:${reference}`]);
        expect(count.rows[0].n).toBe(1);
        await expectNoHorizontalOverflow(page);
      }, { period: 'none' });
    });
  });
}
