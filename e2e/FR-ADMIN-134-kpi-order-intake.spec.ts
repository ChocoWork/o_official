import { expect, test, type Page } from '@playwright/test';
import { mockAdminBackgroundApis } from './admin-test-utils';
import { selectAccountingPeriod, withAccountingScenario, type AccountingScenario } from './accounting-test-utils';
import { CHECKOUT_VIEWPORTS, expectNoHorizontalOverflow } from './checkout-flow-helpers';

// FREQ-571 / FREQ-572（計画2）: KPI の受注高・受注残と、帳簿との照らし合わせを、本物の route・本物の画面・手元の Supabase で確かめる。
// 材料（注文・Stripe の残高の取引・確定した発送票）は手元の DB へ直に入れる。Stripe は呼ばない。入れた stripe_* の行は
// 「画面と帳簿の表示の証拠」であって、実 Stripe の証拠ではない。
// 受注高・受注残は全体の合計なので、ほかの試験が同時に動くと値が動く。合計の突き合わせは、同じ瞬間の読みで揃うまで繰り返して確かめる。
// 仕訳は消せないので db reset してから流す。

test.use({ trace: 'off', locale: 'ja-JP' });
test.describe.configure({ mode: 'default' });

const NOT_BOOK_SALES = '受注高は帳簿の売上高ではありません。申告には使いません。';
/** 「¥1,234」「▲¥1,234」「-¥1,234」「-1,234円」の文から円の数を読む（負は負） */
const yenOf = (text: string): number => {
  const match = /(▲|-)?\s*¥?\s*([\d,]+)/.exec(text);
  if (!match) throw new Error(`円を読めない: ${text}`);
  const value = Number(match[2].replaceAll(',', ''));
  return match[1] ? -value : value;
};

type KpiData = {
  backlog: { total: number; orderCount: number; asOf: string } | null;
  intakeBreakdown: { from: string; to: string; intake: number; payment: number; orderCount: number; breakdownOk: boolean } | null;
  monthlyKpiByYear: Array<{ year: number; metrics: Array<{ period: string; salesAmount: number }> }>;
};

async function readKpi(s: AccountingScenario): Promise<KpiData> {
  const reply = await s.api(s.admin, '/api/admin/kpi');
  expect(reply.status, reply.text.slice(0, 200)).toBe(200);
  return reply.body.data as KpiData;
}

/** 注文を払って（計上して）、1点だけ送る */
async function paidAndPartlyShipped(s: AccountingScenario) {
  const order = await s.seedPaidOrder({ lines: [{ price: 18_750, quantity: 1 }, { price: 11_250, quantity: 1 }] });
  await s.seedStripeCharge({ paymentIntentId: order.paymentIntentId, amount: order.total, orderId: order.orderId });
  await s.runPosting();
  const slip = await s.seedConfirmedSlip({ orders: [{ orderId: order.orderId, lines: [{ orderItemId: order.orderItemIds[0], quantity: 1 }] }] });
  await s.runPosting();
  return { order, slip };
}

async function openKpi(page: Page, s: AccountingScenario): Promise<void> {
  await s.attach(page);
  await mockAdminBackgroundApis(page);
  await page.route('**/api/auth/refresh', (route) => route.continue());
  await page.goto('/admin');
}

for (const viewport of CHECKOUT_VIEWPORTS) {
  test.describe(`FR-ADMIN-134 (${viewport.width}px)`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize(viewport);
    });

    test('FREQ-572-AC-02: 発送済みの注文も受注高に入り、受注残が前受金の残りと合う', async ({ page }) => {
      test.setTimeout(300_000);
      await withAccountingScenario('kpi-intake-shipped', async (s) => {
        await s.todayPeriod();
        const { order, slip } = await paidAndPartlyShipped(s);
        expect(await s.entryByKey(`shipment_confirmed:${slip.number}`)).not.toBeNull();
        expect(await s.deferredBalance(order.orderId)).toBe(11_250);

        // 受注高の出来事: この注文は出荷しても支払いの30,000円のまま（出荷では減らない）
        const monthStart = `${s.today.slice(0, 7)}-01`;
        const events = await s.db.query(
          'select kind, amount::bigint as amount from private.accounting_intake_events($1::date, $2::date) where order_id = $3::uuid order by key',
          [monthStart, s.today, order.orderId],
        );
        expect(events.rows.map((row) => [row.kind, Number(row.amount)])).toEqual([['payment', 30_000]]);

        // 本物の KPI route: 今月の受注高と内訳の受注高が同じで、DB の出来事の合計・前受金の残りの合計と、同じ瞬間の読みで揃う
        await expect
          .poll(
            async () => {
              const [kpi, dbIntake, dbBacklog] = await Promise.all([
                readKpi(s),
                s.db.query('select coalesce(sum(amount), 0)::bigint as n from private.accounting_intake_events($1::date, $2::date)', [monthStart, s.today]),
                s.db.query(
                  `select coalesce(sum(l.credit - l.debit), 0)::bigint as n from public.accounting_journal_lines l join public.accounting_journal_entries e on e.id = l.entry_id
                    where l.account_code = '2150' and l.order_id is not null and e.entry_date <= $1::date`,
                  [s.today],
                ),
              ]);
              const monthly = kpi.monthlyKpiByYear.find((row) => row.year === Number(s.today.slice(0, 4)))?.metrics[Number(s.today.slice(5, 7)) - 1];
              return {
                intake: kpi.intakeBreakdown?.intake === Number(dbIntake.rows[0].n),
                monthly: monthly?.salesAmount === kpi.intakeBreakdown?.intake,
                backlog: kpi.backlog?.total === Number(dbBacklog.rows[0].n),
                breakdownOk: kpi.intakeBreakdown?.breakdownOk === true,
              };
            },
            { timeout: 60_000, intervals: [500, 1_000, 2_000] },
          )
          .toEqual({ intake: true, monthly: true, backlog: true, breakdownOk: true });

        // 前受金の確認の route にも、送っていない11,250円が出る
        let balance: number | undefined;
        let after = '';
        for (let page2 = 0; page2 < 20 && balance === undefined; page2 += 1) {
          const reply = await s.api(s.admin, `/api/admin/accounting/deferred-revenue?asOf=${s.today}&limit=200${after}`);
          expect(reply.status).toBe(200);
          balance = (reply.body.data.orders as Array<{ order_id: string; balance: number }>).find((row) => row.order_id === order.orderId)?.balance;
          if (!reply.body.data.next_after_order) break;
          after = `&afterOrder=${reply.body.data.next_after_order}`;
        }
        expect(balance).toBe(11_250);

        // 画面: 受注高の内訳に、受注高・受注残・支払いの件数が出る（全体の合計なので、この注文の分以上）
        await openKpi(page, s);
        const panel = page.getByRole('region', { name: '受注高の内訳' });
        await expect(panel).toBeVisible({ timeout: 60_000 });
        expect(yenOf(await panel.getByTestId('intake-total').innerText())).toBeGreaterThanOrEqual(30_000);
        expect(yenOf(await panel.getByTestId('intake-backlog-total').innerText())).toBeGreaterThanOrEqual(11_250);
        expect(yenOf(await panel.getByTestId('intake-backlog-count').innerText())).toBeGreaterThanOrEqual(1);
        expect(yenOf(await panel.getByTestId('intake-order-count').innerText())).toBeGreaterThanOrEqual(1);
        await expectNoHorizontalOverflow(page);
      }, { period: 'none' });
    });

    test('FREQ-572-AC-05: 画面に帳簿の売上高ではないと書いてある', async ({ page }) => {
      test.setTimeout(300_000);
      await withAccountingScenario('kpi-not-book-sales', async (s) => {
        await s.todayPeriod();
        await openKpi(page, s);
        // 名前は「受注高」で、旧い「売上」のカードや推移は無い。注意書きは受注高の内訳の中に出る
        const panel = page.getByRole('region', { name: '受注高の内訳' });
        await expect(panel).toBeVisible({ timeout: 60_000 });
        await expect(panel.getByText(NOT_BOOK_SALES, { exact: true })).toBeVisible();
        await expect(page.getByRole('button', { name: /^受注高：/ }).first()).toBeVisible();
        await expect(page.getByRole('button', { name: /^売上：/ })).toHaveCount(0);
        await expect(page.getByText('受注高推移').first()).toBeVisible();
        await expect(page.getByText('売上推移')).toHaveCount(0);
        await expectNoHorizontalOverflow(page);

        // 会計の照合のタブにも同じ注意書きがある
        await s.openAccounting(page, '照合');
        const reconciliation = page.getByRole('region', { name: '受注高と帳簿の照らし合わせ' });
        await expect(reconciliation).toContainText('受注高は帳簿の売上高ではありません。申告には使いません');
        await expectNoHorizontalOverflow(page);
      }, { period: 'none' });
    });

    test('FREQ-571-AC-05: 照合の画面で期首の受注残＋受注高−売上高＝期末の受注残の差が0', async ({ page }) => {
      test.setTimeout(300_000);
      await withAccountingScenario('kpi-intake-reconciliation', async (s) => {
        const period = await s.todayPeriod();
        await paidAndPartlyShipped(s);

        await s.openAccounting(page, '照合');
        await selectAccountingPeriod(page, period.name);
        const section = page.getByRole('region', { name: '受注高と帳簿の照らし合わせ' });
        await section.getByLabel('開始日').fill(period.startsOn);
        await section.getByLabel('終了日').fill(s.today);
        await section.getByRole('button', { name: '受注高を照合する' }).click();
        const stage = section.getByRole('group', { name: '1段目 受注残の動き' });
        await expect(stage).toBeVisible({ timeout: 30_000 });

        // 画面に出ている値で、期首の受注残＋受注高−売上高＋例外の行＝期末の受注残 になっている
        const line = async (label: string) => yenOf((await stage.getByText(new RegExp(`^${label} `)).first().innerText()).slice(label.length));
        const opening = await line('期首の受注残');
        const intake = await line('受注高');
        const sales = await line('返品の前の売上');
        const closing = await line('期末の受注残');
        const exceptions = stage.getByRole('list', { name: '例外の行' }).getByRole('listitem');
        let exceptionSum = 0;
        for (const item of await exceptions.all()) exceptionSum += yenOf((await item.innerText()).split('　').pop() as string);
        expect(intake).toBeGreaterThanOrEqual(30_000);
        expect(opening + intake - sales + exceptionSum).toBe(closing);
        await expect(page.getByTestId('intake-unexplained-1')).toHaveAttribute('data-tone', 'ok');
        await expect(page.getByTestId('intake-unexplained-1')).toContainText('説明のつかない差 ¥0');
        // 2段目: 返品の前の売上−返品＝帳簿の売上高（受注の売上）
        await expect(page.getByTestId('intake-unexplained-2')).toHaveAttribute('data-tone', 'ok');
        await expectNoHorizontalOverflow(page);
      }, { period: 'none' });
    });

    test('FREQ-572-AC-04: サポーターはKPIを読めない', async ({ page }) => {
      test.setTimeout(300_000);
      await withAccountingScenario('kpi-supporter', async (s) => {
        const supporter = await s.actor('supporter', 'aal2');
        const refused = await s.api(supporter, '/api/admin/kpi');
        expect(refused.status, refused.text.slice(0, 200)).toBe(403);
        expect(refused.body).toEqual({ error: 'Forbidden' });
        // 受注高の中身（受注残・内訳）はサポーターの応答に1つも出ない
        expect(refused.text).not.toMatch(/backlog|intakeBreakdown|returnsThisMonth/);

        // 店長は読める（受注残と内訳が付く）
        const kpi = await readKpi(s);
        expect(kpi.backlog).not.toBeNull();
        expect(kpi.intakeBreakdown).not.toBeNull();
        await openKpi(page, s);
        await expect(page.getByRole('region', { name: '受注高の内訳' })).toBeVisible({ timeout: 60_000 });
        await expectNoHorizontalOverflow(page);
      }, { period: 'none' });
    });
  });
}
