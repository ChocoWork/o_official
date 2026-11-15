import { expect, test, type Locator, type Page } from '@playwright/test';
import { ACCOUNTING_LABELS } from '@/lib/accounting/labels';
import { addDaysIso, withAccountingScenario, type AccountingScenario, type E2eReturnFlow } from './accounting-test-utils';
import { CHECKOUT_VIEWPORTS, expectNoHorizontalOverflow } from './checkout-flow-helpers';
import { detailSection } from './order-fulfillment-test-utils';
import {
  RETURN_TEXT,
  UNIT_STATES,
  confirmButton,
  openDetailReturnsDialog,
  openReceiveDialog,
  returnCard,
  returnLabelOf,
  returnsDialogName,
  setUnitState,
  unitRefundChoice,
} from './return-test-utils';

// FREQ-575 / FREQ-578 / FREQ-584（計画3）: 返品の届いた日・届いた日の直し・額の決定の仕訳と、受け取りの画面の止めを、本物の route・本物の画面・手元の Supabase で確かめる。
// 注文・返品・支払いと出荷の事実は手元の DB の道具で作る（accounting-returns-fixtures。Stripe は呼ばない。stripe_* の行は「表示の証拠」で実 Stripe の証拠ではない）。
// 受け取りは、画面（本物の route。相談なので Stripe を呼ばない）と DB の関数（admin_receive_return・admin_refund_return）の2通り。額を決める返金は DB の関数で、
// 返金が Stripe へ届く所までは試さない。直しは本物の画面と route（return-arrival）。
// 日付は今日だけ（切り替えの日は db reset した日）。届いた日を前の日へ直す例は、返品の申し込みの日時を挿入の時に前へ置き、切り替えの日の前の日へ直す
// （取り消しと新しい日の仕訳が並ぶことは DB の試験 FREQ-578-AC-03 が確かめる）。仕訳・計上待ち・直しの跡は消せないので db reset してから流す。

test.use({ trace: 'off', locale: 'ja-JP' });
// 仕訳・計上待ちは全体で共有する状態なので、このファイルの中は1つずつ流す（他のファイルとは並列）。
test.describe.configure({ mode: 'default' });

/** 日本時間の0時まで6分（360秒）を切っている（届いた日は今日・明日の getter で何度も読み、1本の試験は最長300秒かかるので、0時をまたぐと日付が変わる。この間は流さない。FR-ADMIN-139 の60秒では足りないのでここは6分） */
const nearJstMidnight = () => ((Date.now() + 9 * 3_600_000) % 86_400_000) > 86_400_000 - 360_000;

const slash = (date: string) => date.replaceAll('-', '/');
const AFTER_CORRECTION_NOTICE = '届いた日を直しました。';
const FUTURE_TEXT = '未来の日は選べません。';
const BEFORE_CUTOVER_TEXT = '新しい帳簿を始めた日より前の出来事です。';

/** 受け取りの行（1返品1受け取り）の番号 */
async function receiptIdOf(s: AccountingScenario, returnId: string): Promise<string> {
  const rows = await s.db.query("select id from public.order_return_receipts where return_id = $1 and kind = 'receive'", [returnId]);
  expect(rows.rows).toHaveLength(1);
  return rows.rows[0].id as string;
}

/** 注文の詳細 → 返品の画面を開き、その返品の「受け取る」で受け取りの画面を開く */
async function openReceive(page: Page, s: AccountingScenario, flow: E2eReturnFlow) {
  await s.openOrder(page, flow.orderId);
  await openDetailReturnsDialog(page, flow.orderId, '受け取る');
  return openReceiveDialog(page, flow.orderId, returnLabelOf(flow.orderId, flow.number));
}

/** 受け取りの画面で、1着を「戻さない」で届いたことにし、返金は「額を相談」にする */
async function chooseConsult(dialog: Locator): Promise<void> {
  await setUnitState(dialog, 0, UNIT_STATES.keep);
  await unitRefundChoice(dialog, 0, 'consult').check();
}

/** 返品の画面（受け取り済みの返品の欄）を開く */
async function openReturns(page: Page, s: AccountingScenario, flow: E2eReturnFlow) {
  await s.openOrder(page, flow.orderId);
  // 受け取り済み（返金待ち）の返品は、詳細の欄のボタンが「額を決めて返金する」になる。どれも返品の画面を開く
  await detailSection(page, '返品とキャンセルの申し込み').getByRole('button', { name: /^(返品|受け取る|額を決めて返金する)$/ }).first().click();
  const dialog = page.getByRole('dialog', { name: returnsDialogName(flow.orderId), exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('読み込み中です...')).toHaveCount(0);
  return dialog;
}

/** 計上待ち・返金を数回流す（返品の係の後に返金の係が続くので、待っていた物が次の回に入る） */
async function settle(s: AccountingScenario): Promise<void> {
  for (let i = 0; i < 3; i += 1) await s.runPosting(200);
}

for (const viewport of CHECKOUT_VIEWPORTS) {
  test.describe(`FR-ADMIN-137 (${viewport.width}px)`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize(viewport);
    });

    test('FREQ-575-AC-01: 返品を受け取る時に届いた日（今日）を選ぶと、計上後の仕訳帳に届いた日の仕訳が出る', async ({ page }) => {
      test.setTimeout(300_000);
      test.skip(nearJstMidnight(), '日本時間の0時の直前は、届いた日の今日と明日が入れ替わるので流さない');
      await withAccountingScenario('return-arrival-today', async (s) => {
        const period = await s.todayPeriod();
        const flow = await s.seedReturnFlow();
        const dialog = await openReceive(page, s, flow);
        await chooseConsult(dialog);
        // 届いた日は今日。選び直して（今日を入れて）送る
        await dialog.getByLabel('届いた日', { exact: true }).fill(s.today);
        await expect(dialog.getByText(FUTURE_TEXT)).toHaveCount(0);
        await expectNoHorizontalOverflow(page);
        await confirmButton(dialog, RETURN_TEXT.consultButton).click();
        await expect(page.getByRole('dialog', { name: returnsDialogName(flow.orderId), exact: true }).getByRole('status')).toContainText(RETURN_TEXT.noticeRecorded, { timeout: 60_000 });

        // 受け取りの行の届いた日は今日。計上係を流すと、届いた日の仕訳が1本入る
        const receiptId = await receiptIdOf(s, flow.returnId);
        const arrived = await s.db.query("select arrived_on::text as d from public.order_return_receipts where id = $1", [receiptId]);
        expect(arrived.rows[0].d).toBe(s.today);
        await settle(s);
        const entry = await s.entryByKey(`return_arrived:${receiptId}`);
        expect(entry).toMatchObject({ eventKind: 'return_arrived', entryDate: s.today, periodId: period.id });
        // 返品の分（売上値引・返品）と未払金（返品の返金）、返品の手数料（10%）
        expect(await s.linesOf(entry!.id)).toEqual([
          { account: '4020', debit: 18_750, credit: 0, orderId: flow.orderId, subAccount: null },
          { account: '2130', debit: 0, credit: 18_750, orderId: flow.orderId, subAccount: 'return_refund' },
          { account: '2130', debit: 1_875, credit: 0, orderId: flow.orderId, subAccount: 'return_refund' },
          { account: '4050', debit: 0, credit: 1_875, orderId: flow.orderId, subAccount: null },
        ]);

        // 本物の journal route にも、届いた日（今日）の仕訳として出る
        const journal = await s.journalBetween(period.id, s.today, s.today);
        const listed = journal.entries.find((row) => row.dedupeKey === `return_arrived:${receiptId}`);
        expect(listed).toMatchObject({ eventKind: 'return_arrived', entryDate: s.today });
        expect(listed?.lines.map((line) => line.accountCode)).toEqual(['4020', '2130', '2130', '4050']);
      }, { period: 'none' });
    });

    test('FREQ-575-AC-02: 届いた日を前の日へ直すと直した跡が返品の詳細に出て、切り替えの日より前の日なら計上待ちに理由つきで出る', async ({ page }) => {
      test.setTimeout(300_000);
      test.skip(nearJstMidnight(), '日本時間の0時の直前は、届いた日の今日と明日が入れ替わるので流さない');
      await withAccountingScenario('return-arrival-redate', async (s) => {
        const period = await s.todayPeriod();
        const cutover = await s.cutoverOn();
        const before = addDaysIso(cutover, -1);
        // 申し込みを切り替えの日の3日前にして、届いた日を前の日へ直せるようにする
        const flow = await s.seedReturnFlow({ requestedAt: `${addDaysIso(cutover, -3)}T03:00:00+09:00` });
        const received = await s.receiveReturn(flow);
        await settle(s);
        const arrival = await s.entryByKey(`return_arrived:${received.receipt_id}`);
        expect(arrival).toMatchObject({ eventKind: 'return_arrived', entryDate: s.today, periodId: period.id });

        const returns = await openReturns(page, s, flow);
        const card = returnCard(returns, returnLabelOf(flow.orderId, flow.number));
        await expect(card).toContainText(`届いた日 ${slash(s.today)}`);
        await expect(card).not.toContainText('届いた日の直しの跡');
        await card.getByRole('button', { name: '届いた日を直す', exact: true }).click();
        const fix = page.getByRole('dialog', { name: '届いた日を直す', exact: true });
        await expect(fix).toBeVisible();
        await fix.getByLabel('新しい届いた日', { exact: true }).fill(before);
        await fix.getByLabel('直す理由（必須）').fill('配送の記録を見直した');
        await expectNoHorizontalOverflow(page);
        await fix.getByRole('button', { name: '直して記録する', exact: true }).click();
        await expect(page.getByRole('dialog', { name: returnsDialogName(flow.orderId), exact: true }).getByRole('status')).toContainText(AFTER_CORRECTION_NOTICE, { timeout: 60_000 });

        // 直した跡: 返品の詳細に、はじめの届いた日・版・前後の日・理由が残る
        const returnsAfter = page.getByRole('dialog', { name: returnsDialogName(flow.orderId), exact: true });
        const cardAfter = returnCard(returnsAfter, returnLabelOf(flow.orderId, flow.number));
        await expect(cardAfter).toContainText(`届いた日 ${slash(before)}`, { timeout: 30_000 });
        await expect(cardAfter).toContainText(`はじめの届いた日 ${slash(s.today)}`);
        const trace = cardAfter.getByRole('list', { name: '届いた日の直しの跡' }).getByRole('listitem');
        await expect(trace).toHaveCount(1);
        await expect(trace.first()).toContainText(`版1　${slash(s.today)} → ${slash(before)}　理由 配送の記録を見直した`);
        await expectNoHorizontalOverflow(page);
        const corrections = await s.db.query('select id, previous_on::text as previous_on, new_on::text as new_on from public.order_return_arrival_corrections where receipt_id = $1', [received.receipt_id]);
        expect(corrections.rows).toEqual([{ id: expect.any(String), previous_on: s.today, new_on: before }]);

        // 計上係を流すと、切り替えの日より前の日なので動かさず、計上待ち（before_cutover）に理由つきで出る。今の届いた日の仕訳はそのまま
        await settle(s);
        const parked = await s.pendingOf('return_arrival_redated', corrections.rows[0].id);
        expect(parked).toMatchObject({ reason: 'before_cutover', resolvedAt: null });
        expect(await s.entryByKey(`return_arrived:${received.receipt_id}`)).toMatchObject({ id: arrival!.id, entryDate: s.today });
        expect(await s.reversalOf(arrival!.id)).toBeNull();

        await s.openAccounting(page, '計上待ち');
        const list = page.getByRole('list', { name: '計上待ちの一覧' });
        const rows = list.getByRole('listitem').filter({ hasText: ACCOUNTING_LABELS.returnArrivalRedated }).filter({ hasText: BEFORE_CUTOVER_TEXT });
        // 一覧は50件ずつ。自分の行が出るまで「さらに読み込む」を押す
        await expect(list).toBeVisible({ timeout: 60_000 });
        for (let i = 0; i < 20 && (await rows.count()) === 0; i += 1) {
          const more = page.getByRole('region', { name: '計上待ち', exact: true }).getByRole('button', { name: 'さらに読み込む', exact: true });
          if ((await more.count()) === 0) break;
          await more.click();
        }
        await expect(rows.first()).toBeVisible();
        await expectNoHorizontalOverflow(page);
      }, { period: 'none' });
    });

    test('FREQ-578-AC-02: 相談で受け取り、額を決めて返金すると、差の仕訳が決めた日に出る', async () => {
      test.setTimeout(300_000);
      test.skip(nearJstMidnight(), '日本時間の0時の直前は、届いた日の今日と明日が入れ替わるので流さない');
      await withAccountingScenario('return-amount-decided', async (s) => {
        const period = await s.todayPeriod();
        const flow = await s.seedReturnFlow();
        await s.receiveReturn(flow);
        await settle(s);
        const payable = async () => Number((await s.db.query("select private.accounting_order_account_balance($1,'2130','return_refund') as n", [flow.orderId])).rows[0].n);
        // 受け取りの見込み（18,750円−手数料1,875円）で未払金が立つ
        expect(await payable()).toBe(16_875);

        // 額を14,000円と決めて返金を始める（DB の関数。Stripe には届かない）
        const refund = await s.refundReturn(flow, 14_000);
        expect(refund.refund_id).not.toBeNull();
        await settle(s);
        const decision = (await s.db.query(
          "select id::text as id, decided_on::text as decided_on, payable_delta from public.accounting_return_facts where return_id = $1 and kind = 'decision'", [flow.returnId])).rows;
        expect(decision).toHaveLength(1);
        expect(decision[0]).toMatchObject({ decided_on: s.today, payable_delta: -2_875 });
        const entry = await s.entryByKey(`return_amount_decided:${decision[0].id}`);
        expect(entry).toMatchObject({ eventKind: 'return_amount_decided', entryDate: s.today, periodId: period.id });
        // 未払金（返品の返金）2,875円を減らし、売上値引・返品を2,875円戻す
        expect(await s.linesOf(entry!.id)).toEqual([
          { account: '2130', debit: 2_875, credit: 0, orderId: flow.orderId, subAccount: 'return_refund' },
          { account: '4020', debit: 0, credit: 2_875, orderId: flow.orderId, subAccount: null },
        ]);
        expect(await payable()).toBe(14_000);
        const journal = await s.journalBetween(period.id, s.today, s.today);
        expect(journal.entries.find((row) => row.dedupeKey === `return_amount_decided:${decision[0].id}`)).toMatchObject({ entryDate: s.today });
      }, { period: 'none' });
    });

    test('FREQ-584-AC-01: 未来の届いた日は選べない', async ({ page }) => {
      test.setTimeout(300_000);
      test.skip(nearJstMidnight(), '日本時間の0時の直前は、届いた日の今日と明日が入れ替わるので流さない');
      await withAccountingScenario('return-arrival-future', async (s) => {
        await s.todayPeriod();
        const flow = await s.seedReturnFlow();
        const tomorrow = s.tomorrow;
        // 受け取りの画面: 未来の日を入れると理由が出て、送るボタンは押せない。今日へ戻すと押せる
        const dialog = await openReceive(page, s, flow);
        await chooseConsult(dialog);
        const arrived = dialog.getByLabel('届いた日', { exact: true });
        await expect(arrived).toHaveAttribute('max', s.today);
        await arrived.fill(tomorrow);
        await expect(dialog.getByText(FUTURE_TEXT)).toBeVisible();
        await expect(confirmButton(dialog, RETURN_TEXT.consultButton)).toBeDisabled();
        await arrived.fill(s.today);
        await expect(dialog.getByText(FUTURE_TEXT)).toHaveCount(0);
        await expect(confirmButton(dialog, RETURN_TEXT.consultButton)).toBeEnabled();
        const none = await s.db.query("select count(*)::int as n from public.order_return_receipts where return_id = $1", [flow.returnId]);
        expect(none.rows[0].n).toBe(0);

        // 届いた日を直す画面: 未来の日は選べず、送るボタンは押せない
        await s.receiveReturn(flow);
        const returns = await openReturns(page, s, flow);
        await returnCard(returns, returnLabelOf(flow.orderId, flow.number)).getByRole('button', { name: '届いた日を直す', exact: true }).click();
        const fix = page.getByRole('dialog', { name: '届いた日を直す', exact: true });
        await fix.getByLabel('新しい届いた日', { exact: true }).fill(tomorrow);
        await fix.getByLabel('直す理由（必須）').fill('未来の日を試す');
        await expect(fix.getByText(FUTURE_TEXT)).toBeVisible();
        await expect(fix.getByRole('button', { name: '直して記録する', exact: true })).toBeDisabled();
        const corrections = await s.db.query('select count(*)::int as n from public.order_return_arrival_corrections c join public.order_return_receipts r on r.id = c.receipt_id where r.return_id = $1', [flow.returnId]);
        expect(corrections.rows[0].n).toBe(0);
      }, { period: 'none' });
    });

    test('FREQ-584-AC-06: 受け取りの画面・返品の詳細・計上待ちのタブ・消費税用の返金の一覧が3つの幅で横にはみ出さない', async ({ page }) => {
      test.setTimeout(300_000);
      test.skip(nearJstMidnight(), '日本時間の0時の直前は、届いた日の今日と明日が入れ替わるので流さない');
      await withAccountingScenario('return-arrival-overflow', async (s) => {
        await s.todayPeriod();
        const cutover = await s.cutoverOn();
        const flow = await s.seedReturnFlow({ requestedAt: `${addDaysIso(cutover, -3)}T03:00:00+09:00` });
        const noOverflow = async (target: Locator) => {
          await expectNoHorizontalOverflow(page);
          expect(await target.evaluate((el) => el.scrollWidth > el.clientWidth + 1)).toBe(false);
        };

        // 受け取りの画面（届いた日の欄・未来の日の理由・判断待ちでない注文の選び）
        const receive = await openReceive(page, s, flow);
        await chooseConsult(receive);
        await receive.getByLabel('届いた日', { exact: true }).fill(s.tomorrow);
        await expect(receive.getByText(FUTURE_TEXT)).toBeVisible();
        await noOverflow(receive);
        await page.keyboard.press('Escape');
        await expect(receive).toHaveCount(0);

        // 返品の詳細（届いた日・直した跡）と、届いた日を直す画面
        await s.receiveReturn(flow);
        const returns = await openReturns(page, s, flow);
        await noOverflow(returns);
        await returnCard(returns, returnLabelOf(flow.orderId, flow.number)).getByRole('button', { name: '届いた日を直す', exact: true }).click();
        const fix = page.getByRole('dialog', { name: '届いた日を直す', exact: true });
        await fix.getByLabel('新しい届いた日', { exact: true }).fill(addDaysIso(cutover, -1));
        await fix.getByLabel('直す理由（必須）').fill('幅を確かめる');
        await noOverflow(fix);
        await fix.getByRole('button', { name: '直して記録する', exact: true }).click();
        const returnsAfter = page.getByRole('dialog', { name: returnsDialogName(flow.orderId), exact: true });
        await expect(returnsAfter.getByRole('list', { name: '届いた日の直しの跡' })).toBeVisible({ timeout: 60_000 });
        await noOverflow(returnsAfter);

        // 計上待ちのタブ（直しの行が出る）と、照合のタブの消費税用の返金の一覧
        await settle(s);
        await s.openAccounting(page, '計上待ち');
        await expect(page.getByRole('list', { name: '計上待ちの一覧' })).toBeVisible({ timeout: 60_000 });
        await expectNoHorizontalOverflow(page);
        await s.openAccounting(page, '照合');
        const section = page.getByRole('region', { name: '消費税用の返金', exact: true });
        await section.getByRole('button', { name: '一覧を出す', exact: true }).click();
        await expect(section.getByRole('group', { name: '合計' })).toBeVisible({ timeout: 60_000 });
        await expectNoHorizontalOverflow(page);
        expect(await section.evaluate((el) => el.scrollWidth > el.clientWidth + 1)).toBe(false);
      }, { period: 'none' });
    });
  });
}
