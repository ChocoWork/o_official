import { randomInt, randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { CHECKOUT_VIEWPORTS, expectNoHorizontalOverflow } from './checkout-flow-helpers';
import {
  addDaysIso,
  ledgerRowCells,
  selectAccountingPeriod,
  selectLedgerAccount,
  withAccountingScenario,
  type AccountingScenario,
  type PoolPeriod,
} from './accounting-test-utils';
import { createDraftInDb, createShippingMaterial, withShippingScenario } from './shipping-test-utils';

// FREQ-562 / FREQ-563 / FREQ-564 / FREQ-569 / FREQ-570（計画2）: 支払いの前受金・出荷した日の売上・出荷日の直し・計上待ち・取引管理の注文の収入を、
// 本物の route・本物の画面・手元の Supabase で確かめる。
// 材料（注文・Stripe の残高の取引・確定した発送票）は手元の DB へ直に入れる。Stripe は呼ばない。入れた stripe_* の行は
// 「画面と帳簿の表示の証拠」であって、実 Stripe の証拠ではない（計画2 Task 16 で本物の Stripe の読みを確かめる）。
// 仕訳は消せないので db reset してから流す。期間は今日を含む期間（ensurePeriodFor）で、計画1の池の期間は使わない（裁定 P2-M11）。
// 出荷日を直す例だけ、元の発送票の出荷日を「明日」で直に入れる（G の確定は今日より後の日を断るが、切り替えの日が今日だと今日の前に日が無い。
// 直しは G の本物の関数で今日へ）。年をまたぐ例は DB の試験が持つ。

test.use({ trace: 'off', locale: 'ja-JP' });
// 仕訳・計上待ちは全体で共有する状態なので、このファイルの中は1つずつ流す（他のファイルとは並列）。
test.describe.configure({ mode: 'default' });

const FRONT_DEPOSIT = { code: '2150', name: '前受金' };
const SALES = { code: '4010', name: '売上高' };
/** 計上待ちの理由の文のうち、理由ごとに決まった一部（画面の文はやさしい日本語） */
const PAYMENT_MISSING_TEXT = 'この出荷の注文の支払いが、まだ帳簿に入っていません。支払いが入ると自動で計上されます。';
const yen = (value: number) => value.toLocaleString('ja-JP');
const slash = (date: string) => date.replaceAll('-', '/');
const jstDateOf = (instant: string) => new Date(new Date(instant).getTime() + 9 * 3_600_000).toISOString().slice(0, 10);

/** 注文と Stripe の支払いを入れる（計上はまだ）。手数料 fee は残高の取引に付く */
async function paidOrderWithCharge(
  s: AccountingScenario,
  lines: Array<{ price: number; quantity: number }>,
  fee = 0,
) {
  const order = await s.seedPaidOrder({ lines });
  const txId = await s.seedStripeCharge({ paymentIntentId: order.paymentIntentId, amount: order.total, orderId: order.orderId, fee });
  return { ...order, txId };
}

/** 画面の帳簿の仕訳・元帳で、期間と科目を選んで伝票番号の行を読む */
async function ledgerCells(page: import('@playwright/test').Page, period: PoolPeriod, account: { code: string; name: string }, entryNo: number) {
  await selectAccountingPeriod(page, period.name);
  await selectLedgerAccount(page, account);
  return ledgerRowCells(page, entryNo);
}

for (const viewport of CHECKOUT_VIEWPORTS) {
  test.describe(`FR-ADMIN-132 (${viewport.width}px)`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize(viewport);
    });

    test('FREQ-569-AC-06: 1件の失敗の理由と直して再計上する案内が計上待ちに出てほかの出来事の仕訳は見える', async ({ page }) => {
      test.setTimeout(300_000);
      await withAccountingScenario('pending-posting-error', async (s) => {
        const period = await s.todayPeriod();
        // 処理の失敗は手元の DB の試験用の例で作る（本番には作らない）: Stripe の取引の payment_intent に印に使えない文字（:）が入っていると core が断る。
        // 注文は取引に結んだ注文の番号で見つかる（注文の payment_intent は変えられないので、直す時は取引の側を直す）
        const brokenIntent = `pi_bad:${randomUUID().replaceAll('-', '')}`;
        const broken = await s.seedPaidOrder({ lines: [{ price: 4_500, quantity: 1 }] });
        const brokenTx = await s.seedStripeCharge({ paymentIntentId: brokenIntent, amount: broken.total, orderId: broken.orderId });
        const fine = await paidOrderWithCharge(s, [{ price: 5_000 + randomInt(100, 900), quantity: 1 }]);

        await s.openAccounting(page, '計上待ち');
        // 「もう一度計上する」は処理の間は押せない。応答を少し遅らせて、押した直後の無効化を見る
        await page.route('**/api/admin/accounting/posting/run', async (route) => {
          await new Promise((resolve) => setTimeout(resolve, 600));
          await route.continue();
        });
        const run = page.getByRole('button', { name: 'もう一度計上する', exact: true });
        await run.click();
        await expect(run).toBeDisabled();
        await expect(page.getByText(/件を計上しました/)).toBeVisible({ timeout: 90_000 });
        await expect(run).toBeEnabled();

        // DB: 失敗した1件だけが計上待ち（posting_error）に残り、ほかの支払いは計上された
        const parked = await s.pendingOf('payment_confirmed', brokenTx);
        expect(parked).toMatchObject({ reason: 'posting_error', detail: { error_sqlstate: '22023', error_code: 'ACCOUNTING_ARGUMENT_INVALID' }, resolvedAt: null });
        expect(await s.entryByKey(`payment_confirmed:${broken.paymentIntentId}`)).toBeNull();
        const fineEntry = await s.entryByKey(`payment_confirmed:${fine.paymentIntentId}`);
        expect(fineEntry).not.toBeNull();

        // 画面: 理由と直して再計上する案内が出る。お金の動く理由なので「確認済みにする」は無い
        const guide = (text: string) => page.getByRole('list', { name: '計上待ちの一覧' }).getByRole('listitem').filter({ hasText: text });
        const errorRows = guide('理由のコード ACCOUNTING_ARGUMENT_INVALID（SQLSTATE 22023）');
        await expect(errorRows.first()).toBeVisible({ timeout: 30_000 });
        const before = await errorRows.count();
        const mine = errorRows.filter({ has: page.locator(`a[href="/admin/orders/${broken.orderId}"]`) });
        await expect(mine).toHaveCount(1);
        await expect(mine).toContainText('直してから『もう一度計上する』を押してください');
        await expect(mine).toContainText('生の例外の文はここには出しません');
        await expect(mine).toContainText('仕訳が入るまで閉じられません');
        await expect(mine.getByRole('button', { name: '確認済みにする' })).toHaveCount(0);
        await expectNoHorizontalOverflow(page);

        // ほかの出来事の仕訳は、帳簿の前受金の元帳に見える
        await page.getByRole('tab', { name: '帳簿', exact: true }).click();
        const cells = await ledgerCells(page, period, FRONT_DEPOSIT, fineEntry!.entryNo);
        expect(cells[6]).toBe(yen(fine.total));
        await expectNoHorizontalOverflow(page);

        // 直す（取引の payment_intent を注文の番号に合わせる）と、もう一度計上する で入り、計上待ちが解決済みになる
        await s.db.query('update public.stripe_balance_transactions set payment_intent_id = $2 where id = $1', [brokenTx, broken.paymentIntentId]);
        await page.getByRole('tab', { name: '計上待ち', exact: true }).click();
        await page.getByRole('button', { name: 'もう一度計上する', exact: true }).click();
        await expect(page.getByText(/件を計上しました/)).toBeVisible({ timeout: 90_000 });
        expect(await s.entryByKey(`payment_confirmed:${broken.paymentIntentId}`)).not.toBeNull();
        expect((await s.pendingOf('payment_confirmed', brokenTx))?.resolvedAt).not.toBeNull();
        await expect(errorRows).toHaveCount(before - 1);
      }, { period: 'none' });
    });

    test('FREQ-562-AC-01: 支払いを計上すると仕訳帳に前受金の仕訳が出る', async ({ page }) => {
      test.setTimeout(300_000);
      await withAccountingScenario('payment-journal', async (s) => {
        const period = await s.todayPeriod();
        const order = await paidOrderWithCharge(s, [{ price: 12_000 + randomInt(100, 900), quantity: 1 }, { price: 8_000, quantity: 1 }], 720);
        expect(await s.entryByKey(`payment_confirmed:${order.paymentIntentId}`)).toBeNull();

        await s.openAccounting(page, '計上待ち');
        await page.getByRole('button', { name: 'もう一度計上する', exact: true }).click();
        await expect(page.getByText(/件を計上しました/)).toBeVisible({ timeout: 90_000 });

        // 支払いの仕訳は手数料を引く前の総額で、前受金の行に注文が付く
        const entry = await s.entryByKey(`payment_confirmed:${order.paymentIntentId}`);
        expect(entry).toMatchObject({ eventKind: 'payment_confirmed', entryDate: s.today, periodId: period.id });
        expect(await s.linesOf(entry!.id)).toEqual([
          { account: '1160', debit: order.total, credit: 0, orderId: order.orderId, subAccount: null },
          { account: '2150', debit: 0, credit: order.total, orderId: order.orderId, subAccount: null },
        ]);
        expect(await s.deferredBalance(order.orderId)).toBe(order.total);

        // 本物の journal route にも出る
        const journal = await s.journalBetween(period.id, s.today, s.today);
        const listed = journal.entries.find((candidate) => candidate.id === entry!.id);
        expect(listed).toMatchObject({ eventKind: 'payment_confirmed', dedupeKey: `payment_confirmed:${order.paymentIntentId}` });
        expect(listed!.lines.map((line) => [line.accountCode, line.debit, line.credit])).toEqual([['1160', order.total, 0], ['2150', 0, order.total]]);

        // 画面: 帳簿の前受金の元帳に、その日の貸方として出る
        await page.getByRole('tab', { name: '帳簿', exact: true }).click();
        const cells = await ledgerCells(page, period, FRONT_DEPOSIT, entry!.entryNo);
        expect(cells[0]).toContain(slash(s.today));
        expect(cells[5]).toBe('—');
        expect(cells[6]).toBe(yen(order.total));
        await expectNoHorizontalOverflow(page);
      }, { period: 'none' });
    });

    test('FREQ-563-AC-01: 発送票を確定して計上すると売上の仕訳が出て前受金が減る', async ({ page }) => {
      test.setTimeout(300_000);
      await withAccountingScenario('shipment-journal', async (s) => {
        const period = await s.todayPeriod();
        // 2着10,000円（1着め6,000円・2着め4,000円）の注文を払い、1着だけ本物の確定の route で送る（G の確定から計上までを通す）
        await withShippingScenario(async (ctx) => {
          const paymentIntentId = `pi_${randomUUID().replaceAll('-', '')}`;
          const material = await createShippingMaterial(ctx.client, { quantity: 2, paymentIntentId });
          await s.seedUnitAmounts(material.orderId, material.orderItemId, [6_000, 4_000]);
          await s.seedStripeCharge({ paymentIntentId, amount: 10_000, orderId: material.orderId });
          await s.runPosting();
          expect(await s.deferredBalance(material.orderId)).toBe(10_000);

          const draft = await createDraftInDb(ctx, [material], [1]);
          const confirmed = await s.api(s.admin, `/api/admin/shipment-slips/${draft.id}/confirm`, 'POST', {
            expectedVersion: draft.version, carrier: null, trackingNumber: null, shipmentDate: s.today, notifyCustomer: false, requestKey: randomUUID(),
          });
          expect(confirmed.status, confirmed.text.slice(0, 300)).toBe(200);

          await s.openAccounting(page, '計上待ち');
          await page.getByRole('button', { name: 'もう一度計上する', exact: true }).click();
          await expect(page.getByText(/件を計上しました/)).toBeVisible({ timeout: 90_000 });

          // 送った着（番号の若い1着め）の額だけの売上（前受金／売上高）が出荷の日に立ち、前受金は送っていない分だけ残る
          const entry = await s.entryByKey(`shipment_confirmed:${draft.number}`);
          expect(entry).toMatchObject({ eventKind: 'shipment_confirmed', entryDate: s.today, periodId: period.id });
          expect(await s.linesOf(entry!.id)).toEqual([
            { account: '2150', debit: 6_000, credit: 0, orderId: material.orderId, subAccount: null },
            { account: '4010', debit: 0, credit: 6_000, orderId: material.orderId, subAccount: null },
          ]);
          expect(await s.deferredBalance(material.orderId)).toBe(4_000);

          // 画面: 売上高の元帳（貸方 6,000）と、前受金の確認（残り 4,000）
          await page.getByRole('tab', { name: '帳簿', exact: true }).click();
          const cells = await ledgerCells(page, period, SALES, entry!.entryNo);
          expect(cells[6]).toBe(yen(6_000));
          expect(cells[9]).toBe(slash(s.today));
          await page.getByRole('tab', { name: '計上待ち', exact: true }).click();
          const deferred = page.getByRole('table', { name: '繰り越した前受金の一覧' }).getByRole('row').filter({ hasText: material.orderNumber });
          await expect(deferred).toHaveCount(1, { timeout: 30_000 });
          await expect(deferred).toContainText(yen(4_000));
          await expectNoHorizontalOverflow(page);

          // 2着めも本物の発送票で送って計上すると、前受金は0になり、前受金の確認の一覧から消える（残りを残さない）
          const second = await createDraftInDb(ctx, [material], [1]);
          const secondConfirmed = await s.api(s.admin, `/api/admin/shipment-slips/${second.id}/confirm`, 'POST', {
            expectedVersion: second.version, carrier: null, trackingNumber: null, shipmentDate: s.today, notifyCustomer: false, requestKey: randomUUID(),
          });
          expect(secondConfirmed.status, secondConfirmed.text.slice(0, 300)).toBe(200);
          await s.runPosting();
          const secondEntry = await s.entryByKey(`shipment_confirmed:${second.number}`);
          expect(await s.linesOf(secondEntry!.id)).toEqual([
            { account: '2150', debit: 4_000, credit: 0, orderId: material.orderId, subAccount: null },
            { account: '4010', debit: 0, credit: 4_000, orderId: material.orderId, subAccount: null },
          ]);
          expect(await s.deferredBalance(material.orderId)).toBe(0);
          await s.openAccounting(page, '計上待ち');
          await expect(page.getByRole('table', { name: '繰り越した前受金の一覧' }).or(page.getByText('繰り越した前受金はありません'))).toBeVisible({ timeout: 30_000 });
          await expect(page.getByRole('row').filter({ hasText: material.orderNumber })).toHaveCount(0);
          await expectNoHorizontalOverflow(page);
        });
      }, { period: 'none' });
    });

    test('FREQ-564-AC-02: 出荷日を直すと取り消しと正しい仕訳が並び、出荷した日と登録した日の列が出る', async ({ page }) => {
      test.setTimeout(300_000);
      await withAccountingScenario('shipment-redate', async (s) => {
        const period = await s.todayPeriod();
        const tomorrowPeriod = await s.ensurePeriodFor(s.tomorrow);
        const unit = 9_000 + randomInt(100, 900);
        const order = await paidOrderWithCharge(s, [{ price: unit, quantity: 2 }]);
        await s.runPosting();

        // 元の発送票は出荷日が明日（直に入れる）。計上すると明日の日付で売上が立つ
        // 発送票を確定した日（登録した日）は昨日にして、出荷した日（今日に直す）と別の日にする
        const yesterday = addDaysIso(s.today, -1);
        const slip = await s.seedConfirmedSlip({
          orders: [{ orderId: order.orderId, lines: [{ orderItemId: order.orderItemIds[0], quantity: 1 }] }],
          shipmentDate: s.tomorrow,
          confirmedAt: new Date(Date.now() - 86_400_000).toISOString(),
        });
        await s.runPosting();
        const original = await s.entryByKey(`shipment_confirmed:${slip.number}`);
        expect(original).toMatchObject({ entryDate: s.tomorrow });

        // 出荷日を G の本物の関数で今日へ直し、計上すると、元の日の取り消しと、直した日の正しい仕訳が足される
        const historyId = await s.correctShipmentDate(slip.slipId, s.today, 'E2Eの日の直し');
        await s.runPosting();
        const reversal = await s.reversalOf(original!.id);
        const redated = await s.entryByKey(`shipment_redated:${historyId}`);
        expect(reversal).toMatchObject({ entryDate: s.tomorrow, reason: 'E2Eの日の直し' });
        expect(redated).toMatchObject({ eventKind: 'shipment_redated', entryDate: s.today });
        expect(await s.linesOf(redated!.id)).toEqual(await s.linesOf(original!.id));
        expect(await s.deferredBalance(order.orderId)).toBe(unit * 2 - unit);

        // 本物の journal route: 直した日の仕訳に、出荷した日と登録した日（発送票を確定した日）が付く
        const journal = await s.journalBetween(period.id, s.today, s.today);
        expect(journal.entries.find((entry) => entry.id === redated!.id)).toMatchObject({ eventKind: 'shipment_redated', dedupeKey: `shipment_redated:${historyId}` });
        const meta = journal.shipmentMeta.find((row) => row.entryId === redated!.id);
        expect(meta).toMatchObject({ slipNumber: slip.number, shipmentDate: s.today });
        expect(jstDateOf(meta!.confirmedAt)).toBe(yesterday);

        // 画面: 売上高の元帳に、取り消しと正しい仕訳が並び、列に出荷した日と登録した日が出る
        await s.openAccounting(page, '帳簿');
        const redatedCells = await ledgerCells(page, period, SALES, redated!.entryNo);
        expect(redatedCells[6]).toBe(yen(unit));
        // 出荷した日（直した日）と登録した日（確定した日）は別の列で、別の日が出る
        expect(redatedCells[9]).toBe(slash(s.today));
        expect(redatedCells[10]).toBe(slash(yesterday));
        const traceButton = page.getByRole('button', { name: `JE-${String(redated!.entryNo).padStart(6, '0')}の出荷の跡を開く` });
        await traceButton.click();
        const trace = page.getByRole('region', { name: '出荷の跡' });
        await expect(trace).toContainText(slip.number);
        await expect(trace).toContainText(`${slash(s.tomorrow)} から ${slash(s.today)} へ直しました。理由 E2Eの日の直し`);
        const relations = trace.getByRole('list', { name: 'この出荷の仕訳' });
        await expect(relations).toContainText('を取り消す');
        await expect(relations).toContainText('取り消されました');
        await expect(relations).toContainText('今の正しい仕訳');
        await expectNoHorizontalOverflow(page);

        const reversalCells = await ledgerCells(page, tomorrowPeriod, SALES, reversal!.entryNo);
        expect(reversalCells[0]).toContain(slash(s.tomorrow));
        expect(reversalCells[5]).toBe(yen(unit));
        expect(reversalCells[6]).toBe('—');
        const originalCells = await ledgerCells(page, tomorrowPeriod, SALES, original!.entryNo);
        expect(originalCells[6]).toBe(yen(unit));
        await expectNoHorizontalOverflow(page);
      }, { period: 'none' });
    });

    test('FREQ-569-AC-01: 支払いより先に出荷した注文は計上待ちに理由が出て、支払いを入れて「もう一度計上する」で消える', async ({ page }) => {
      test.setTimeout(300_000);
      await withAccountingScenario('shipment-before-payment', async (s) => {
        await s.todayPeriod();
        // この理由の行は、名前も番号も出さない固定の文なので、画面では行の数でしか数えられない。画面は新しい順の50件までなので、
        // 件数を前の値と比べず、画面を開き直すたびに「画面の出荷+この理由の行の数」を同じ瞬間の計上待ちの route（画面と同じ問い合わせ）の1ページ目と比べる。
        // この試験の1行は、route の1ページ目に注文と発送票の番号で名指しして、出る・消えるを確かめる。
        const rows = () => page.getByRole('list', { name: '計上待ちの一覧' }).getByRole('listitem')
          .filter({ hasText: PAYMENT_MISSING_TEXT })
          .filter({ has: page.locator('span', { hasText: /^出荷$/ }) });
        const firstPage = async () => {
          const reply = await s.api(s.admin, '/api/admin/accounting/pending-events?includeResolved=false&limit=50');
          expect(reply.status, reply.text.slice(0, 200)).toBe(200);
          return (reply.body.data.events as Array<{ sourceId: string; orderId: string | null; reason: string; eventKind: string }>)
            .filter((event) => event.eventKind === 'shipment_confirmed' && event.reason === 'payment_journal_missing');
        };
        /** 画面を開き直し、画面の行の数と route の1ページ目の該当の数が同じ瞬間に揃うまで繰り返す。揃った時の route の該当の行を返す */
        const screenMatchesRoute = async () => {
          let matched: Awaited<ReturnType<typeof firstPage>> = [];
          await expect
            .poll(async () => {
              await s.openAccounting(page, '計上待ち');
              await expect(page.getByText(/^未解決 \d+件$/)).toBeVisible({ timeout: 30_000 });
              const fromRoute = await firstPage();
              const onScreen = await rows().count();
              matched = fromRoute;
              return onScreen === fromRoute.length;
            }, { timeout: 90_000, intervals: [500, 1_000, 2_000] })
            .toBe(true);
          return matched;
        };

        // 注文はあるが、Stripe の支払い（残高の取引）がまだ無いまま出荷した
        const order = await s.seedPaidOrder({ lines: [{ price: 6_000 + randomInt(100, 900), quantity: 1 }] });
        const slip = await s.seedConfirmedSlip({ orders: [{ orderId: order.orderId, lines: [{ orderItemId: order.orderItemIds[0], quantity: 1 }] }] });
        await s.runPosting();
        expect(await s.entryByKey(`shipment_confirmed:${slip.number}`)).toBeNull();
        expect(await s.pendingOf('shipment_confirmed', slip.slipId)).toMatchObject({ reason: 'payment_journal_missing', resolvedAt: null });

        // この試験の1行が計上待ちの route に名指しで出て、画面の行の数もその route と揃う
        const open = await screenMatchesRoute();
        expect(open.filter((event) => event.sourceId === slip.slipId && event.orderId === order.orderId)).toHaveLength(1);
        await expect(rows().first()).toContainText('仕訳が入るまで閉じられません');
        await expectNoHorizontalOverflow(page);

        // 支払い（Stripe の残高の取引）を入れて「もう一度計上する」を押すと、支払いも出荷も計上され、この行は route からも画面からも消える
        await s.seedStripeCharge({ paymentIntentId: order.paymentIntentId, amount: order.total, orderId: order.orderId });
        await page.getByRole('button', { name: 'もう一度計上する', exact: true }).click();
        await expect(page.getByText(/件を計上しました/)).toBeVisible({ timeout: 90_000 });
        const payment = await s.entryByKey(`payment_confirmed:${order.paymentIntentId}`);
        const shipment = await s.entryByKey(`shipment_confirmed:${slip.number}`);
        expect(payment).not.toBeNull();
        expect(shipment).not.toBeNull();
        const resolved = await s.pendingOf('shipment_confirmed', slip.slipId);
        expect(resolved?.resolvedAt).not.toBeNull();
        expect(await s.deferredBalance(order.orderId)).toBe(0);
        const gone = await screenMatchesRoute();
        expect(gone.filter((event) => event.sourceId === slip.slipId)).toHaveLength(0);
        await expectNoHorizontalOverflow(page);
      }, { period: 'none' });
    });

    test('FREQ-570-AC-02: 取引管理の注文の収入の行が出荷の仕訳と同じ額で出る', async ({ page }) => {
      test.setTimeout(300_000);
      await withAccountingScenario('order-income-row', async (s) => {
        const period = await s.todayPeriod();
        // 他の行と見分けるため、この試験だけの額にする
        const amount = 23_000 + randomInt(1, 9_000);
        const order = await paidOrderWithCharge(s, [{ price: amount, quantity: 1 }]);
        const slip = await s.seedConfirmedSlip({ orders: [{ orderId: order.orderId, lines: [{ orderItemId: order.orderItemIds[0], quantity: 1 }] }] });
        await s.runPosting();
        const entry = await s.entryByKey(`shipment_confirmed:${slip.number}`);
        expect(entry).not.toBeNull();
        const revenue = (await s.linesOf(entry!.id)).filter((line) => line.account === '4010').reduce((sum, line) => sum + line.credit - line.debit, 0);
        expect(revenue).toBe(amount);

        // 本物の cost-profit route: 注文の収入の行は出荷の仕訳から作られ、総額も純額も 4010 の貸方−借方と同じ
        const reply = await s.api(s.admin, `/api/admin/kpi/cost-profit?periodId=${period.id}`);
        expect(reply.status, reply.text.slice(0, 200)).toBe(200);
        const incomes = reply.body.data.incomes as Array<{ source?: string; sourceId?: string; grossAmount?: number; netAmount?: number; amount: number; readOnly?: boolean }>;
        const row = incomes.find((income) => income.source === 'order' && income.sourceId === entry!.id);
        expect(row).toMatchObject({ grossAmount: revenue, netAmount: revenue, amount: revenue, readOnly: true });

        // 画面: 取引管理の取引一覧に、同じ額の注文の収入の行が出る
        await s.openAccounting(page, '取引管理');
        await selectAccountingPeriod(page, period.name);
        // 一覧は何ページにもなるので、取引金額の範囲をこの額だけにして探す
        await page.getByRole('button', { name: '詳細条件' }).click();
        await page.getByLabel('取引金額（下限）').fill(String(amount));
        await page.getByLabel('取引金額（上限）').fill(String(amount));
        await page.getByRole('button', { name: '適用して閉じる' }).click();
        const table = page.getByRole('region', { name: '取引一覧' });
        // 同じ額の行が前の実行に残っていても、route が返す同じ額の注文の収入の行の数と同じだけ出る
        const sameAmount = incomes.filter((income) => income.source === 'order' && income.amount === amount).length;
        expect(sameAmount).toBeGreaterThanOrEqual(1);
        const rows = table.getByRole('row').filter({ hasText: 'オンライン注文' }).filter({ hasText: yen(amount) });
        await expect(rows).toHaveCount(sameAmount, { timeout: 30_000 });
        await expectNoHorizontalOverflow(page);
      }, { period: 'none' });
    });
  });
}
