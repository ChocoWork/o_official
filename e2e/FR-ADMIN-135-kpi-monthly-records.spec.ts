import { randomInt } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { mockAdminBackgroundApis } from './admin-test-utils';
import { withAccountingScenario, type AccountingScenario } from './accounting-test-utils';
import { CHECKOUT_VIEWPORTS, expectNoHorizontalOverflow } from './checkout-flow-helpers';
import { currentSeasonKey, seasonMonthKeys } from '@/lib/kpi/monthly-metrics';

// FREQ-573（計画2）: 月の KPI の記録（admin_kpi_monthly_records）を、本物の route・本物の画面・手元の Supabase で確かめる。
// 書き込みは DB の関数だけが行う。保存・読み直し・空にして消す・同じ月と指標は1行・サポーターは保存できない。
// 記録は手動入力の指標（リーチ数・リンククリック数）を使い、試験の終わりに必ず空に戻す。

test.use({ trace: 'off', locale: 'ja-JP' });
test.describe.configure({ mode: 'default' });

type MonthlyReply = { season: string; monthKeys: string[]; values: Record<string, Record<string, number>> };

const putRecord = (s: AccountingScenario, who: Parameters<AccountingScenario['api']>[0], season: string, updates: Array<{ monthKey: string; metricKey: string; value: number | '' }>) =>
  s.api(who, '/api/admin/kpi/monthly-record', 'PUT', { season, updates });

const getRecord = async (s: AccountingScenario, season: string): Promise<MonthlyReply> => {
  const reply = await s.api(s.admin, `/api/admin/kpi/monthly-record?season=${season}`);
  expect(reply.status, reply.text.slice(0, 200)).toBe(200);
  return reply.body.data as MonthlyReply;
};

const rowsOf = async (s: AccountingScenario, monthKeys: string[]) =>
  (await s.db.query(
    'select month_key, metric_key, value::float8 as value from public.admin_kpi_monthly_records where month_key = any($1::text[]) order by month_key, metric_key',
    [monthKeys],
  )).rows.map((row) => [row.month_key, row.metric_key, row.value]);

async function openKpi(page: Page, s: AccountingScenario): Promise<void> {
  await s.attach(page);
  await mockAdminBackgroundApis(page);
  await page.route('**/api/auth/refresh', (route) => route.continue());
  await page.goto('/admin');
}

for (const viewport of CHECKOUT_VIEWPORTS) {
  test.describe(`FR-ADMIN-135 (${viewport.width}px)`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize(viewport);
    });

    test('FREQ-573-AC-02: 月の記録を保存して読み直すと値が残り、空にすると消える（本物のroute）', async ({ page }) => {
      test.setTimeout(300_000);
      await withAccountingScenario('kpi-monthly-record', async (s) => {
        // ---- 本物の route: 誰とも重ならない遠い年のシーズンで、保存・読み直し・同じ月と指標は1行・空にして消す ----
        const season = `${randomInt(2100, 2990)}SS`;
        const [april, may] = seasonMonthKeys(season);
        try {
          // 同じ月・指標の重複は最後の1件だけが残る
          const saved = await putRecord(s, s.admin, season, [
            { monthKey: april, metricKey: 'src:reach', value: 1200 },
            { monthKey: may, metricKey: 'src:reach', value: 300 },
            { monthKey: april, metricKey: 'src:link_clicks', value: 45 },
            { monthKey: april, metricKey: 'src:reach', value: 1250 },
          ]);
          expect(saved.status, saved.text.slice(0, 200)).toBe(200);
          expect(saved.body.data.values[april]).toEqual({ 'src:reach': 1250, 'src:link_clicks': 45 });
          expect(saved.body.data.values[may]).toEqual({ 'src:reach': 300 });
          expect(await rowsOf(s, [april, may])).toEqual([
            [april, 'src:link_clicks', 45],
            [april, 'src:reach', 1250],
            [may, 'src:reach', 300],
          ]);
          // 読み直すと値が残っている。同じ月・指標をもう一度保存しても1行のまま
          expect((await getRecord(s, season)).values[april]['src:reach']).toBe(1250);
          expect((await putRecord(s, s.admin, season, [{ monthKey: april, metricKey: 'src:reach', value: 1300 }])).status).toBe(200);
          expect((await rowsOf(s, [april])).filter((row) => row[1] === 'src:reach')).toEqual([[april, 'src:reach', 1300]]);
          // 空にすると消える（ほかの記録は残る）
          const cleared = await putRecord(s, s.admin, season, [{ monthKey: april, metricKey: 'src:reach', value: '' }]);
          expect(cleared.status).toBe(200);
          expect(cleared.body.data.values[april]).toEqual({ 'src:link_clicks': 45 });
          expect(await rowsOf(s, [april, may])).toEqual([
            [april, 'src:link_clicks', 45],
            [may, 'src:reach', 300],
          ]);
        } finally {
          await putRecord(s, s.admin, season, [
            { monthKey: april, metricKey: 'src:reach', value: '' },
            { monthKey: april, metricKey: 'src:link_clicks', value: '' },
            { monthKey: may, metricKey: 'src:reach', value: '' },
          ]);
        }
        expect(await rowsOf(s, seasonMonthKeys(season))).toEqual([]);

        // ---- 画面: 今のシーズンの今月に、記録を入れて保存し、開き直しても残り、空にすると消える ----
        const current = currentSeasonKey();
        const monthKey = s.today.slice(0, 7);
        expect(seasonMonthKeys(current)).toContain(monthKey);
        const monthLabel = `${Number(monthKey.slice(5, 7))}月`;
        const value = String(7000 + randomInt(1, 900));
        const cell = () => page.getByLabel(`リーチ数 ${monthLabel}の値`);
        const openDrawer = async () => {
          await openKpi(page, s);
          await page.getByRole('button', { name: '算出元データを確認' }).click();
          await expect(cell()).toBeVisible({ timeout: 60_000 });
        };
        try {
          await openDrawer();
          await cell().fill(value);
          await page.getByRole('button', { name: '保存', exact: true }).click();
          await expect(page.getByText('月次記録を保存しました。').first()).toBeVisible({ timeout: 30_000 });
          expect((await getRecord(s, current)).values[monthKey]['src:reach']).toBe(Number(value));
          await openDrawer();
          await expect(cell()).toHaveValue(value);
          await expectNoHorizontalOverflow(page);

          await cell().fill('');
          await page.getByRole('button', { name: '保存', exact: true }).click();
          await expect(page.getByText('月次記録を保存しました。').first()).toBeVisible({ timeout: 30_000 });
          expect((await getRecord(s, current)).values[monthKey]?.['src:reach']).toBeUndefined();
          await openDrawer();
          await expect(cell()).toHaveValue('');
          await expectNoHorizontalOverflow(page);
        } finally {
          await putRecord(s, s.admin, current, [{ monthKey, metricKey: 'src:reach', value: '' }]);
        }
      }, { period: 'none' });
    });

    test('FREQ-573-AC-03: サポーターは保存できない', async ({ page }) => {
      test.setTimeout(300_000);
      await withAccountingScenario('kpi-monthly-record-supporter', async (s) => {
        const season = `${randomInt(3000, 3990)}SS`;
        const [april] = seasonMonthKeys(season);
        const supporter = await s.actor('supporter', 'aal2');
        const refused = await putRecord(s, supporter, season, [{ monthKey: april, metricKey: 'src:reach', value: 99 }]);
        expect(refused.status, refused.text.slice(0, 200)).toBe(403);
        expect(refused.body).toEqual({ error: 'Forbidden' });
        expect(await rowsOf(s, [april])).toEqual([]);
        // 読むこともできない
        const read = await s.api(supporter, `/api/admin/kpi/monthly-record?season=${season}`);
        expect(read.status).toBe(403);
        // 店長は保存できる（同じ本文で通る）。終わりに空に戻す
        try {
          const ok = await putRecord(s, s.admin, season, [{ monthKey: april, metricKey: 'src:reach', value: 99 }]);
          expect(ok.status, ok.text.slice(0, 200)).toBe(200);
          expect(await rowsOf(s, [april])).toEqual([[april, 'src:reach', 99]]);
        } finally {
          await putRecord(s, s.admin, season, [{ monthKey: april, metricKey: 'src:reach', value: '' }]);
        }
        // 画面を開いても横にあふれない
        await openKpi(page, s);
        await expect(page.getByRole('button', { name: '算出元データを確認' })).toBeVisible({ timeout: 60_000 });
        await expectNoHorizontalOverflow(page);
      }, { period: 'none' });
    });
  });
}
