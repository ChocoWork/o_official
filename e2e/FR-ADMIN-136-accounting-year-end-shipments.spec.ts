import { randomUUID } from 'node:crypto';
import { expect, test, type Locator } from '@playwright/test';
import { withAccountingScenario, type AccountingScenario } from './accounting-test-utils';
import { CHECKOUT_VIEWPORTS, expectNoHorizontalOverflow } from './checkout-flow-helpers';
import { SHIPPING_CARRIERS } from '@/lib/orders/shipping-carriers';

// FREQ-574（計画2）: 出荷の年末の確認と運送会社の受付日の照らし合わせを、本物の route・本物の画面・手元の Supabase で確かめる。
// 切り替えの日を動かせず、G の確定は今日より後の出荷日を断るので、E2E は今日の日付だけを使う。年末の一覧は範囲を「今日を含む日」に変えて確かめる。
// 12月25日〜1月10日をまたぐ例は DB の試験（accounting_p2_year_end_shipments）が持つ。
// 発送票は手元の DB へ直に入れ（確定した発送票）、運送会社と追跡番号は本物の追跡の route で入れる。運送会社には何も送らない。
// 仕訳・確かめた印・設定の切り替えの記録は消せないので db reset してから流す。

test.use({ trace: 'off', locale: 'ja-JP' });
// 運送会社の受付日のオプションは全体で1つの設定なので、このファイルの中は1つずつ流す。
test.describe.configure({ mode: 'default' });

const slash = (date: string) => date.replaceAll('-', '/');

type YearEndSlip = { slip_id: string; number: string; shipment_date: string; shipping_carrier: string | null; tracking_number: string | null; checked_at: string | null; checked_by: string | null };
type YearEndReply = {
  slips: YearEndSlip[];
  next_after_date: string | null;
  next_after_slip: string | null;
  options: { carrier_date_check_enabled: boolean; changed_at: string | null; changed_by: string | null; version: string };
  carrier_gaps: { enabled: boolean };
};

// 画面も route も1ページは100件。E2E は今日の日付だけを使うので、db reset の後に流した発送票が増えると今日の分が何ページにもなる。
const YEAR_END_PAGE = 100;
// たどるページの上限（100件×この数）。超えたら無限に回らず失敗にする
const YEAR_END_MAX_PAGES = 100;

async function readYearEnd(s: AccountingScenario, from: string, to: string, after?: { date: string; slip: string }): Promise<YearEndReply> {
  const cursor = after ? `&afterDate=${after.date}&afterSlip=${after.slip}` : '';
  const reply = await s.api(s.admin, `/api/admin/accounting/year-end-shipments?from=${from}&to=${to}&limit=${YEAR_END_PAGE}${cursor}`);
  expect(reply.status, reply.text.slice(0, 200)).toBe(200);
  return reply.body.data as YearEndReply;
}

/**
 * 本物の route の続きの目印（next_after_date・next_after_slip）をたどり、この発送票を探す。1ページに収まらなくても見つかる。
 * 見つかるまでの各ページの先頭の発送票番号も返す（画面を同じページまで送る時に使う）。範囲の最後まで探して無ければ slip は undefined。
 */
async function findYearEndSlip(s: AccountingScenario, slipId: string, from: string, to: string): Promise<{ slip: YearEndSlip | undefined; pageHeads: string[] }> {
  const pageHeads: string[] = [];
  let after: { date: string; slip: string } | undefined;
  for (let pageNo = 0; pageNo < YEAR_END_MAX_PAGES; pageNo += 1) {
    const data = await readYearEnd(s, from, to, after);
    if (data.slips.length > 0) pageHeads.push(data.slips[0].number);
    const slip = data.slips.find((row) => row.slip_id === slipId);
    if (slip) return { slip, pageHeads };
    if (!data.next_after_date || !data.next_after_slip) return { slip: undefined, pageHeads };
    after = { date: data.next_after_date, slip: data.next_after_slip };
  }
  throw new Error(`年末の出荷の一覧が${YEAR_END_MAX_PAGES}ページを超えた`);
}

/**
 * 画面の表を、この発送票があるページまで「次のページ」で送る（route でページを数えてから送る）。
 * 画面を開いた直後・「この範囲で出す」の直後は先頭のページから始まるので、各ページの先頭の発送票番号が表に出るのを待ってから次へ進む。
 */
async function pageToSlip(s: AccountingScenario, section: Locator, slipId: string): Promise<void> {
  const { pageHeads } = await findYearEndSlip(s, slipId, s.today, s.today);
  const table = section.getByRole('table', { name: '年末の発送票' });
  for (let index = 0; index < pageHeads.length; index += 1) {
    await expect(table.getByRole('row').nth(1)).toContainText(pageHeads[index], { timeout: 30_000 });
    if (index < pageHeads.length - 1) await section.getByRole('button', { name: '次のページ' }).click();
  }
}

for (const viewport of CHECKOUT_VIEWPORTS) {
  test.describe(`FR-ADMIN-136 (${viewport.width}px)`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize(viewport);
    });

    test('FREQ-574-AC-01: 年末の出荷の一覧が出て確かめた印を付けると残る', async ({ page }) => {
      test.setTimeout(300_000);
      await withAccountingScenario('year-end-check', async (s) => {
        await s.todayPeriod();
        const order = await s.seedPaidOrder({ lines: [{ price: 14_000, quantity: 1 }] });
        await s.seedStripeCharge({ paymentIntentId: order.paymentIntentId, amount: order.total, orderId: order.orderId });
        const slip = await s.seedConfirmedSlip({ orders: [{ orderId: order.orderId, lines: [{ orderItemId: order.orderItemIds[0], quantity: 1 }] }] });
        // 運送会社と追跡番号は、本物の追跡の route で入れる
        const tracking = `E2E-${randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}`;
        const set = await s.api(s.admin, `/api/admin/shipment-slips/${slip.slipId}/tracking`, 'POST', {
          expectedVersion: slip.version, carrier: 'yamato', trackingNumber: tracking, notifyCustomer: false, requestKey: randomUUID(),
        });
        expect(set.status, set.text.slice(0, 300)).toBe(200);
        await s.runPosting();

        // 本物の route: 今日を含む範囲に、運送会社・追跡番号・出荷した日つきで出て、まだ確かめていない。
        // 今日の発送票が100件を超えても見つかるよう、続きの目印をたどって探す
        const before = (await findYearEndSlip(s, slip.slipId, s.today, s.today)).slip;
        expect(before).toMatchObject({ number: slip.number, shipment_date: s.today, shipping_carrier: 'yamato', tracking_number: tracking, checked_at: null, checked_by: null });

        // 画面: 照合のタブの「年末の出荷の確認」で、範囲を今日にして出す
        await s.openAccounting(page, '照合');
        const section = page.getByRole('region', { name: '年末の出荷の確認' });
        await section.getByLabel('開始日').fill(s.today);
        await section.getByLabel('終了日').fill(s.today);
        await section.getByRole('button', { name: 'この範囲で出す' }).click();
        const row = () => section.getByRole('table', { name: '年末の発送票' }).getByRole('row').filter({ hasText: slip.number });
        await pageToSlip(s, section, slip.slipId);
        await expect(row()).toHaveCount(1, { timeout: 30_000 });
        await expect(row()).toContainText(slash(s.today));
        await expect(row()).toContainText('確定');
        await expect(row()).toContainText(SHIPPING_CARRIERS.yamato.label);
        await expect(row()).toContainText(tracking);
        await expect(row()).toContainText('まだ確かめていません');
        await expectNoHorizontalOverflow(page);

        // 確かめた印を付けると、人と時刻つきで残り、ボタンは消える
        await section.getByRole('button', { name: `${slip.number}を確かめた` }).click();
        await expect(row()).toContainText(`確かめ済み ${slash(s.today)}`, { timeout: 30_000 });
        await expect(section.getByRole('button', { name: `${slip.number}を確かめた` })).toHaveCount(0);
        const marks = await s.db.query('select checked_by, checked_at from public.accounting_shipment_checks where slip_id = $1', [slip.slipId]);
        expect(marks.rows).toHaveLength(1);
        expect(marks.rows[0].checked_by).toBe(s.admin.userId);

        // 範囲を出し直しても、開き直しても残っている。同じ発送票に印は二重に付かない
        await section.getByRole('button', { name: 'この範囲で出す' }).click();
        await pageToSlip(s, section, slip.slipId);
        await expect(row()).toContainText(`確かめ済み ${slash(s.today)}`, { timeout: 30_000 });
        const again =await s.api(s.admin, '/api/admin/accounting/year-end-shipments', 'POST', { slipId: slip.slipId, note: null, requestKey: randomUUID() });
        expect(again.status, again.text.slice(0, 200)).toBe(200);
        expect(again.body.data.check.created).toBe(false);
        const marksAfter = await s.db.query('select count(*)::int as n from public.accounting_shipment_checks where slip_id = $1', [slip.slipId]);
        expect(marksAfter.rows[0].n).toBe(1);
        const after = (await findYearEndSlip(s, slip.slipId, s.today, s.today)).slip;
        expect(after?.checked_by).toBe(s.admin.userId);
        expect(after?.checked_at).not.toBeNull();
        await s.openAccounting(page, '照合');
        await section.getByLabel('開始日').fill(s.today);
        await section.getByLabel('終了日').fill(s.today);
        await section.getByRole('button', { name: 'この範囲で出す' }).click();
        await pageToSlip(s, section, slip.slipId);
        await expect(row()).toContainText(`確かめ済み ${slash(s.today)}`, { timeout: 30_000 });
        await expectNoHorizontalOverflow(page);
      }, { period: 'none' });
    });

    test('FREQ-574-AC-03: 運送会社の受付日のオプションは既定がオフで、切り替えられる', async ({ page }) => {
      test.setTimeout(300_000);
      await withAccountingScenario('carrier-date-option', async (s) => {
        await s.todayPeriod();
        const initial = (await readYearEnd(s, s.today, s.today)).options;
        // 一度も切り替えていなければ既定はオフ（切り替えた日と人は空）。切り替えの記録は消せないので、既定そのものを確かめられるのは
        // db reset の後の最初の幅だけ。2つ目以降の幅と再実行では、前の実行がオフに戻した状態（オフ）を確かめる
        if (initial.changed_at === null) {
          expect(initial.carrier_date_check_enabled).toBe(false);
          expect(initial.changed_by).toBeNull();
        }
        // 前の実行がオンのまま終わっていたら、オフに戻してから始める
        if (initial.carrier_date_check_enabled) {
          const reset = await s.api(s.admin, '/api/admin/accounting/year-end-shipments', 'PUT', {
            carrierDateCheckEnabled: false, expectedVersion: initial.version, requestKey: randomUUID(),
          });
          expect(reset.status, reset.text.slice(0, 200)).toBe(200);
        }

        try {
          // 画面: 設定のタブでオンにして保存すると、切り替えた日と人が残る
          await s.openAccounting(page, '設定・期間');
          const section = page.getByRole('region', { name: '運送会社の受付日' });
          const toggle = section.getByRole('checkbox', { name: '運送会社の受付日との照らし合わせを使う' });
          await expect(toggle).not.toBeChecked({ timeout: 30_000 });
          await expect(section.getByRole('button', { name: 'オプションを保存' })).toBeDisabled();
          await toggle.check();
          await section.getByRole('button', { name: 'オプションを保存' }).click();
          await expect(section.getByText('保存しました。')).toBeVisible({ timeout: 30_000 });
          const saved = (await readYearEnd(s, s.today, s.today)).options;
          expect(saved.carrier_date_check_enabled).toBe(true);
          expect(saved.changed_by).toBe(s.admin.userId);
          expect(saved.changed_at).not.toBeNull();
          await expectNoHorizontalOverflow(page);

          // オンの間は、照合のタブの「受付日とのずれ」がオフの案内ではなく、ずれの一覧（無ければ無いという案内）になる
          await s.openAccounting(page, '照合');
          const yearEnd = page.getByRole('region', { name: '年末の出荷の確認' });
          await expect(yearEnd.getByText('運送会社の受付日との照らし合わせはオフです')).toHaveCount(0, { timeout: 30_000 });
          await expect(yearEnd.getByText('運送会社の受付日とのずれ')).toBeVisible();
          await expectNoHorizontalOverflow(page);
        } finally {
          // どの場合もオフに戻す
          const now = (await readYearEnd(s, s.today, s.today)).options;
          if (now.carrier_date_check_enabled) {
            await s.api(s.admin, '/api/admin/accounting/year-end-shipments', 'PUT', {
              carrierDateCheckEnabled: false, expectedVersion: now.version, requestKey: randomUUID(),
            });
          }
        }

        // オフに戻すと、ずれの一覧はオフの案内になる
        await s.openAccounting(page, '照合');
        const yearEnd = page.getByRole('region', { name: '年末の出荷の確認' });
        await expect(yearEnd.getByText('運送会社の受付日との照らし合わせはオフです')).toBeVisible({ timeout: 30_000 });
        expect((await readYearEnd(s, s.today, s.today)).options.carrier_date_check_enabled).toBe(false);
        await expectNoHorizontalOverflow(page);
      }, { period: 'none' });
    });
  });
}
