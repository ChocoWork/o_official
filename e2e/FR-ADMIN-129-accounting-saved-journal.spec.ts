import { expect, test, type Page } from '@playwright/test';
import { CHECKOUT_VIEWPORTS, expectNoHorizontalOverflow } from './checkout-flow-helpers';
import { openTrialBalance, selectAccountingPeriod, trialBalanceTotals, withAccountingScenario } from './accounting-test-utils';

// FREQ-556 / FREQ-557: 保存した仕訳（S4 のトリガーが取引から作る）を、本物の route と本物の画面で確かめる。
// 取引の作成・更新は本物の POST /api/admin/kpi/cost-profit、読みは本物の GET。
// 例外は2つだけで、どちらも題の下で名指しする。
//  - 201 件の例: 取引 201 件は手元の DB へ直に入れる（route を通らない。トリガーは同じ）
//  - 表示だけの例: 上限の応答（500 + JOURNAL_TOO_LARGE / JOURNAL_INCOMPLETE）に差し替えて画面の出し方だけを見る（業務の判定は確かめない）

const LEDGER_ACCOUNT = { code: '6060', name: '広告宣伝費' };

type LedgerRow = { number: string; debit: string; credit: string; date: string };

async function selectLedgerAccount(page: Page): Promise<void> {
  await page.getByRole('searchbox', { name: '勘定科目を検索' }).fill(LEDGER_ACCOUNT.name);
  await page.getByRole('button', { name: '勘定科目を検索する' }).click();
  await page
    .getByRole('region', { name: '勘定科目' })
    .getByRole('button', { name: new RegExp(`${LEDGER_ACCOUNT.code}\\s*${LEDGER_ACCOUNT.name}`) })
    .click();
}

/** 仕訳一覧（選んだ科目の元帳行）を、画面に出ている順に読む */
async function ledgerRows(page: Page): Promise<LedgerRow[]> {
  const rows = page.getByRole('region', { name: '仕訳一覧' }).locator('tbody tr').filter({ hasText: 'JE-' });
  const result: LedgerRow[] = [];
  for (const row of await rows.all()) {
    const cells = (await row.getByRole('cell').allInnerTexts()).map((text) => text.trim());
    result.push({ date: cells[0], number: cells[1], debit: cells[5], credit: cells[6] });
  }
  return result;
}

test.use({ trace: 'off', locale: 'ja-JP' });
for (const viewport of CHECKOUT_VIEWPORTS) {
  test.describe(`FR-ADMIN-129 (${viewport.width}px)`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize(viewport);
    });

    test('FREQ-557-AC-06: 201件の保存した仕訳が試算表に入り取得が途中なら合計が出ない', async ({ page }) => {
      test.setTimeout(300_000);
      await withAccountingScenario('journal-201', async (s) => {
        const period = s.period;
        // 取引は 1円・2円…201円。借方と貸方の合計はどちらも 201×202÷2 = 20,301 円
        const rows = Array.from({ length: 201 }, (_, index) => ({ date: s.day(1 + (index % 12), 1 + (index % 28)), amount: index + 1 }));
        const TOTAL = 20_301;

        // ---- 手元 DB の201件の例（取引は DB へ直に入れる。読みは本物の route と画面） ----
        await s.createExpensesInDb(rows);
        const stored = await s.db.query('select count(*)::int as n from public.accounting_journal_entries where period_id = $1', [period.id]);
        expect(stored.rows[0].n).toBe(201);

        // journal route は1ページ200件で、続きの目印を返す
        const first = await s.api(s.admin, `/api/admin/accounting/journal?periodId=${period.id}&limit=200`);
        expect(first.status).toBe(200);
        expect(first.body.data.entries).toHaveLength(200);
        expect(first.body.data.nextAfter).not.toBeNull();
        const { entryDate, entryNo } = first.body.data.nextAfter;
        const second = await s.api(s.admin, `/api/admin/accounting/journal?periodId=${period.id}&limit=200&afterEntryDate=${entryDate}&afterEntryNo=${entryNo}`);
        expect(second.status).toBe(200);
        expect(second.body.data.entries).toHaveLength(1);
        expect(second.body.data.nextAfter).toBeNull();

        // cost-profit は全ページを読み切って201件の合計を返す（欠けた配列を成功として返さない）
        const costProfit = await s.api(s.admin, `/api/admin/kpi/cost-profit?periodId=${period.id}`);
        expect(costProfit.status).toBe(200);
        const saved = costProfit.body.data.savedJournal as Array<{ lines: Array<{ debit: number; credit: number }> }>;
        expect(saved).toHaveLength(201);
        const sum = (pick: 'debit' | 'credit') => saved.reduce((total, entry) => total + entry.lines.reduce((t, line) => t + line[pick], 0), 0);
        expect([sum('debit'), sum('credit')]).toEqual([TOTAL, TOTAL]);

        // 画面の試算表も201件ぶんの合計を出す
        await s.openAccounting(page, '帳簿');
        await selectAccountingPeriod(page, period.name);
        await openTrialBalance(page);
        await expect.poll(() => trialBalanceTotals(page), { timeout: 30_000 }).toEqual({ debit: TOTAL, credit: TOTAL });
        await expect(page.getByText('貸借一致（借方合計 = 貸方合計）', { exact: true })).toBeVisible();
        await expect(page.getByText('一部しか読めていないため、合計を表示できません。もう一度読み込んでください')).toHaveCount(0);
        await expectNoHorizontalOverflow(page);

        // ---- 表示だけの例（応答の差し替え。上限・途中の失敗の応答を作り物にして、画面の出し方だけを見る） ----
        await test.step('表示だけの例: 上限・途中の失敗の応答では合計を出さない', async () => {
          for (const code of ['JOURNAL_TOO_LARGE', 'JOURNAL_INCOMPLETE']) {
            const handler = (route: import('@playwright/test').Route) => {
              if (route.request().method() !== 'GET') return route.fallback();
              return route.fulfill({
                status: 500,
                contentType: 'application/json',
                body: JSON.stringify({ error: '会計データの取得に失敗しました。', code }),
              });
            };
            const pattern = /\/api\/admin\/kpi\/cost-profit\?/;
            await page.route(pattern, handler);
            await page.getByRole('button', { name: '更新', exact: true }).click();
            await expect(page.getByRole('alert').filter({ hasText: '一部しか読めていないため、合計を表示できません。もう一度読み込んでください' })).toBeVisible();
            // 前の合計も試算表も残さない
            await expect(page.getByRole('button', { name: '試算表CSV' })).toHaveCount(0);
            await expect(page.getByText(`¥${TOTAL.toLocaleString('ja-JP')}`)).toHaveCount(0);
            await page.unroute(pattern, handler);
          }
          // 差し替えを外して読み直すと、また合計が出る
          await page.getByRole('button', { name: '更新', exact: true }).click();
          await openTrialBalance(page);
          await expect.poll(() => trialBalanceTotals(page), { timeout: 30_000 }).toEqual({ debit: TOTAL, credit: TOTAL });
        });
      });
    });

    test('FREQ-556-AC-01: 手入力の取引を作ると帳簿の仕訳帳に出て直すと取り消しと正しい仕訳が並ぶ', async ({ page }) => {
      test.setTimeout(240_000);
      await withAccountingScenario('manual-journal', async (s) => {
        const period = s.period;
        const dateA = s.day(9, 20);
        const dateB = s.day(3, 5);
        // 先に9/20、後に3/5を作る。通し番号は A=1・B=2 で、日の順とは逆
        const a = await s.createExpense({ date: dateA, amount: 3000, item: 'E2E 仕訳帳 A' });
        const b = await s.createExpense({ date: dateB, amount: 1000, item: 'E2E 仕訳帳 B' });

        const journal = async () => {
          const reply = await s.api(s.admin, `/api/admin/accounting/journal?periodId=${period.id}`);
          expect(reply.status).toBe(200);
          return reply.body.data.entries as Array<{
            id: string; entryNo: number; entryDate: string; eventKind: string; dedupeKey: string; reason: string | null;
            reversesEntryId: string | null; description: string; lines: Array<{ accountCode: string; debit: number; credit: number }>;
          }>;
        };

        // 作った直後: 保存した仕訳は日の順 → 通し番号の順
        const created = await journal();
        expect(created.map((entry) => [entry.entryDate, entry.entryNo, entry.dedupeKey])).toEqual([
          [dateB, 2, `manual_entry:${b}:0`],
          [dateA, 1, `manual_entry:${a}:0`],
        ]);
        const originalA = created[1];
        expect(originalA.lines.map((line) => [line.accountCode, line.debit, line.credit])).toEqual([
          [LEDGER_ACCOUNT.code, 3000, 0],
          ['1010', 0, 3000],
        ]);

        await s.openAccounting(page, '帳簿');
        await selectAccountingPeriod(page, period.name);
        await selectLedgerAccount(page);
        // 作った直後: 新しい日（9/20 の A・JE-000001）が先、3/5 の B（JE-000002）が後。通し番号の順なら逆になる
        await expect.poll(() => ledgerRows(page).then((rows) => rows.map((row) => row.number))).toEqual(['JE-000001', 'JE-000002']);
        expect(await ledgerRows(page)).toEqual([
          { date: expect.stringContaining(dateA.replaceAll('-', '/')), number: 'JE-000001', debit: '3,000', credit: '—' },
          { date: expect.stringContaining(dateB.replaceAll('-', '/')), number: 'JE-000002', debit: '1,000', credit: '—' },
        ]);

        // 直す: 金額を 3,000 → 3,500 に。元の仕訳は動かず、取り消しと正しい仕訳が足される
        const edited = await s.updateExpense(a, { date: dateA, amount: 3500, item: 'E2E 仕訳帳 A' });
        expect(edited.status, edited.text).toBe(200);
        const after = await journal();
        expect(after.map((entry) => [entry.entryDate, entry.entryNo, entry.eventKind, entry.dedupeKey])).toEqual([
          [dateB, 2, 'manual_entry', `manual_entry:${b}:0`],
          [dateA, 1, 'manual_entry', `manual_entry:${a}:0`],
          [dateA, 3, 'reversal', `reversal:${originalA.id}`],
          [dateA, 4, 'manual_entry', `manual_entry:${a}:1`],
        ]);
        // 元の仕訳は動かない（旧の訂正履歴の件数 legacy だけは、取引を直すと1つ増える）
        const withoutLegacy = (entry: object) => Object.fromEntries(Object.entries(entry).filter(([key]) => key !== 'legacy'));
        const afterA = withoutLegacy(after[1]);
        const beforeA = withoutLegacy(originalA);
        expect(afterA).toEqual(beforeA);
        expect(after[2]).toMatchObject({ reason: 'edit', reversesEntryId: originalA.id, description: 'E2E 仕訳帳 A' });
        expect(after[2].lines.map((line) => [line.accountCode, line.debit, line.credit])).toEqual([
          [LEDGER_ACCOUNT.code, 0, 3000],
          ['1010', 3000, 0],
        ]);
        expect(after[3].lines.map((line) => [line.accountCode, line.debit, line.credit])).toEqual([
          [LEDGER_ACCOUNT.code, 3500, 0],
          ['1010', 0, 3500],
        ]);

        // 画面の仕訳一覧は新しい日から古い日の順（同じ日は通し番号の大きい方から）。通し番号の順ではなく仕訳の日の順で並ぶ:
        // 3/5 の B（JE-000002）は、9/20 の A の3本（JE-000004・000003・000001）より後ろに出る。取り消しと正しい仕訳は元の仕訳と同じ日に並ぶ
        await page.getByRole('button', { name: '更新', exact: true }).click();
        await expect.poll(() => ledgerRows(page).then((rows) => rows.map((row) => row.number)), { timeout: 30_000 })
          .toEqual(['JE-000004', 'JE-000003', 'JE-000001', 'JE-000002']);
        expect((await ledgerRows(page)).map((row) => [row.number, row.debit, row.credit])).toEqual([
          ['JE-000004', '3,500', '—'],
          ['JE-000003', '—', '3,000'],
          ['JE-000001', '3,000', '—'],
          ['JE-000002', '1,000', '—'],
        ]);
        await expectNoHorizontalOverflow(page);
      });
    });

    test('FREQ-557-AC-01: 期間を選ぶと選んだ期間の仕訳だけが試算表に出る', async ({ page }) => {
      test.setTimeout(240_000);
      await withAccountingScenario('period-select', async (s) => {
        const first = s.period;
        const second = await s.claimPeriod();
        await s.createExpense({ date: s.day(4, 10, first), amount: 1111 });
        await s.createExpense({ date: s.day(5, 10, first), amount: 2222 });
        await s.createExpense({ date: s.day(6, 1, second), amount: 5000 });

        // 本物の route: 期間ごとに、その期間の仕訳だけを返す
        for (const [period, count] of [[first, 2], [second, 1]] as const) {
          const reply = await s.api(s.admin, `/api/admin/kpi/cost-profit?periodId=${period.id}`);
          expect(reply.status).toBe(200);
          const saved = reply.body.data.savedJournal as Array<{ periodId: string }>;
          expect(saved).toHaveLength(count);
          expect(new Set(saved.map((entry) => entry.periodId))).toEqual(new Set([period.id]));
        }

        // 画面: 期間を選ぶごとに、その期間の借方合計・貸方合計だけが試算表に出る
        // （後の期間は前の期間の残高を期首に持つので、残高の列でなく合計の列で見る）
        await s.openAccounting(page, '帳簿');
        await selectAccountingPeriod(page, first.name);
        await openTrialBalance(page);
        await expect.poll(() => trialBalanceTotals(page), { timeout: 30_000 }).toEqual({ debit: 3333, credit: 3333 });
        await selectAccountingPeriod(page, second.name);
        await expect.poll(() => trialBalanceTotals(page), { timeout: 30_000 }).toEqual({ debit: 5000, credit: 5000 });
        await selectAccountingPeriod(page, first.name);
        await expect.poll(() => trialBalanceTotals(page), { timeout: 30_000 }).toEqual({ debit: 3333, credit: 3333 });
        await expectNoHorizontalOverflow(page);
      });
    });
  });
}
