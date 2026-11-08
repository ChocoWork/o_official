import { expect, test } from '@playwright/test';
import { seedAccountingPeriod } from '../tests/integration/db/helpers/accounting-fixtures';
import { CHECKOUT_VIEWPORTS, expectNoHorizontalOverflow } from './checkout-flow-helpers';
import { withAccountingScenario, type AccountingScenario, type PoolPeriod } from './accounting-test-utils';

// FREQ-555 / FREQ-561: 設定・期間のタブ。本物の route・本物の画面・手元の DB（応答は作り物にしない）。
// やめた日（個人の最後の期間）と開業日は一度入れると戻せない共有の状態なので、書く試験は全体の lock で直列にする。
// 個人の期間は「池」（accounting-test-utils.ts）から取り、やめた日は池の一番後ろの期間の中に置く。

const BASE_BUSINESS_START = '2025-04-01';
const slash = (date: string) => date.replaceAll('-', '/');
const SHORTEN_BLOCKED = 'やめた日を変えられません。やめた日より後の日付の仕訳が無いか確かめてください。';

type SoleState = { endedOn: string | null; changes: number; version: string; periodEndsOn: string; periodVersion: string };

/** DB の控え: やめた日・選び直しの記録の数・設定の版・期間の終わりと版 */
async function soleState(s: AccountingScenario, tail: PoolPeriod): Promise<SoleState> {
  const settings = (await s.db.query(
    `select to_char(sole_business_ended_on, 'YYYY-MM-DD') as ended_on, jsonb_array_length(sole_end_changes)::int as changes, version::text as version
       from public.accounting_settings where id = 1`)).rows[0];
  const period = (await s.db.query(
    `select to_char(ends_on, 'YYYY-MM-DD') as ends_on, version::text as version from public.accounting_periods where id = $1`, [tail.id])).rows[0];
  return { endedOn: settings.ended_on, changes: settings.changes, version: settings.version, periodEndsOn: period.ends_on, periodVersion: period.version };
}

/** やめた日を「最後の期間の12月31日」に置いた基準の状態にする（入っていなければ初めての登録、ずれていれば理由つきで戻す） */
async function soleEndBaseline(s: AccountingScenario, tail: PoolPeriod): Promise<void> {
  const lastDay = `${tail.year}-12-31`;
  const current = await s.settings();
  if (current.soleBusinessEndedOn === lastDay) return;
  const reply = await s.setSoleEnd(tail, lastDay, current.soleBusinessEndedOn === null ? null : 'E2E 基準へ戻す');
  expect(reply.status, reply.text).toBe(200);
}

test.use({ trace: 'off', locale: 'ja-JP' });
for (const viewport of CHECKOUT_VIEWPORTS) {
  test.describe(`FR-ADMIN-128 (${viewport.width}px)`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize(viewport);
    });

    test('FREQ-555-AC-07: 個人の最後の期間をやめた日までにし後の日の仕訳があれば拒否が出て、理由つきで選び直せる', async ({ page }) => {
      test.setTimeout(240_000);
      await withAccountingScenario('sole-end', async (s) => {
        await s.ensurePool(); // やめた日を入れる前に、ほかの試験の期間を足しておく
        const tail = await s.tail();
        await soleEndBaseline(s, tail);
        const entryDate = `${tail.year}-03-15`;
        await s.createExpense({ date: entryDate, amount: 777, item: 'E2E やめた日の後ろの仕訳' });
        const before = await soleState(s, tail);
        expect(before.endedOn).toBe(`${tail.year}-12-31`);

        await s.openAccounting(page, '設定・期間');
        await expect(page.getByRole('heading', { name: '事業をやめた日', exact: true })).toBeVisible();
        await page.getByRole('button', { name: 'やめた日を選び直す', exact: true }).click();
        const save = page.getByRole('button', { name: '選び直しを保存', exact: true });
        await page.getByLabel('やめた日', { exact: true }).fill(`${tail.year}-02-01`);
        // 理由が空の間は保存できない
        await expect(save).toBeDisabled();
        await page.getByLabel('選び直す理由').fill('E2E: 後の日の仕訳があるので拒否される');
        await expect(save).toBeEnabled();
        await save.click();
        // 後の日（3/15）の仕訳があるので、route の日本語の本文がそのまま出る
        await expect(page.getByText(SHORTEN_BLOCKED, { exact: true })).toBeVisible();
        // DB は何も変わらない（やめた日・期間の終わり・版・選び直しの記録）
        expect(await soleState(s, tail)).toEqual(before);
        // 同じ拒否を HTTP でも確かめる（非 ok の本文を最後まで読む）
        const refused = await s.setSoleEnd(tail, `${tail.year}-02-01`, 'E2E: HTTP でも拒否される');
        expect(refused.status).toBe(409);
        expect(refused.body).toEqual({ code: 'ACCOUNTING_PERIOD_SHORTEN_BLOCKED', error: SHORTEN_BLOCKED });
        expect(await soleState(s, tail)).toEqual(before);

        // 仕訳の日（3/15）より後なら、同じ画面で理由つきに選び直せる
        const reason = `E2E 選び直し ${tail.year}`;
        await page.getByLabel('やめた日', { exact: true }).fill(`${tail.year}-11-30`);
        await page.getByLabel('選び直す理由').fill(reason);
        await save.click();
        await expect(page.getByText('やめた日を選び直しました。', { exact: true })).toBeVisible();
        const records = page.getByRole('list', { name: '選び直しの記録' });
        await expect(records.getByRole('listitem').last()).toContainText(reason);
        await expect(records.getByRole('listitem').last()).toContainText(`${slash(`${tail.year}-12-31`)} → ${slash(`${tail.year}-11-30`)}`);
        const after = await soleState(s, tail);
        expect(after).toMatchObject({ endedOn: `${tail.year}-11-30`, periodEndsOn: `${tail.year}-11-30`, changes: before.changes + 1 });
        const settings = await s.settings();
        expect(settings.soleEndChanges.at(-1)).toMatchObject({ newEndedOn: `${tail.year}-11-30`, reason });
        await expectNoHorizontalOverflow(page);

        // 次の試験のために12月31日へ戻す（延ばす側は仕訳があっても選べる）
        const restored = await s.setSoleEnd(tail, `${tail.year}-12-31`, 'E2E 基準へ戻す');
        expect(restored.status, restored.text).toBe(200);
      }, { period: 'none', exclusive: true });
    });

    test('FREQ-555-AC-08: やめた日より後の個人の期間は作れない', async ({ page }) => {
      test.setTimeout(240_000);
      await withAccountingScenario('sole-after-end', async (s) => {
        await s.ensurePool();
        const tail = await s.tail();
        await soleEndBaseline(s, tail);
        const nextYear = tail.year + 1;
        const countSole = async () => Number((await s.db.query(
          "select count(*)::int as n from public.accounting_periods where business_type = 'soleProprietor'")).rows[0].n);
        const before = await countSole();

        // HTTP: やめた日より後の個人の期間は route が断る
        const refused = await s.api(s.admin, '/api/admin/accounting/periods', 'POST', {
          businessType: 'soleProprietor', startsOn: `${nextYear}-01-01`, endsOn: `${nextYear}-12-31`, requestKey: crypto.randomUUID(),
        });
        expect(refused.status).toBe(400);
        expect(refused.body).toEqual({ code: 'ACCOUNTING_ARGUMENT_INVALID', error: '入力を確かめてください。' });
        expect(await countSole()).toBe(before);

        // DB: 直に足そうとしても、次の個人の期間は DB が断る（期間は足されない）
        await expect(seedAccountingPeriod(s.db, { businessType: 'soleProprietor' })).rejects.toThrow(/ACCOUNTING_PERIOD_SHORTEN_BLOCKED/);
        expect(await countSole()).toBe(before);

        // 画面: 個人を選ぶ欄は出ず、法人の期間だけを作る案内が出る
        await s.openAccounting(page, '設定・期間');
        await expect(page.getByText('やめた日を登録したので、次は法人の期間を作ります。個人の期間はこれより後に作りません。', { exact: true })).toBeVisible();
        await expect(page.getByLabel('期間の事業の形')).toHaveCount(0);
        await expect(page.getByLabel('年', { exact: true })).toHaveCount(0);
        await expect(page.getByLabel(/^始まり/)).toBeVisible();
        await expectNoHorizontalOverflow(page);
      }, { period: 'none', exclusive: true });
    });

    test('FREQ-555-AC-01: 設定タブで期間を足し重なりと1年超が日本語で断られる', async ({ page }) => {
      test.setTimeout(240_000);
      await withAccountingScenario('add-period', async (s) => {
        const next = (await s.db.query(
          `select to_char(coalesce(max(ends_on) + 1, date '2027-07-01'), 'YYYY-MM-DD') as starts_on,
                  to_char((coalesce(max(ends_on) + 1, date '2027-07-01') + interval '1 year' - interval '1 day')::date, 'YYYY-MM-DD') as ends_on,
                  to_char((coalesce(max(ends_on) + 1, date '2027-07-01') + interval '1 year' + interval '1 day')::date, 'YYYY-MM-DD') as too_long_to,
                  count(*)::int as n
             from public.accounting_periods where business_type = 'corporation'`)).rows[0] as { starts_on: string; ends_on: string; too_long_to: string; n: number };
        const countCorporation = async () => Number((await s.db.query(
          "select count(*)::int as n from public.accounting_periods where business_type = 'corporation'")).rows[0].n);
        expect(await countCorporation()).toBe(next.n);

        await s.openAccounting(page, '設定・期間');
        await expect(page.getByRole('heading', { name: '期間を追加する' })).toBeVisible();
        // やめた日の前は個人か法人を選べる。入った後は法人に決まっている
        const typeSelect = page.getByLabel('期間の事業の形');
        if (await typeSelect.count()) await typeSelect.selectOption({ label: '法人' });
        const add = page.getByRole('button', { name: '期間を追加', exact: true });
        await expect(add).toBeEnabled();

        // 足す: 法人の期間（前の法人の期間に続けて1年）
        await page.getByLabel(/^始まり/).fill(next.starts_on);
        await page.getByLabel(/^終わり/).fill(next.ends_on);
        await add.click();
        await expect(page.getByText('期間を追加しました。', { exact: true })).toBeVisible();
        expect(await countCorporation()).toBe(next.n + 1);
        const created = (await s.db.query(
          `select name, created_by::text as created_by from public.accounting_periods
            where business_type = 'corporation' and starts_on = $1::date and ends_on = $2::date`, [next.starts_on, next.ends_on])).rows;
        expect(created).toEqual([{ name: `第${next.n + 1}期`, created_by: s.admin.userId }]);
        const table = page.getByRole('table').filter({ hasText: '事業の形' }).first();
        await expect(table.getByRole('row').filter({ hasText: slash(next.starts_on) })).toContainText(slash(next.ends_on));

        // 重なり: いま足した期間と同じ日付
        await page.getByLabel(/^始まり/).fill(next.starts_on);
        await page.getByLabel(/^終わり/).fill(next.ends_on);
        await add.click();
        await expect(page.getByText('会計の期間が重なっています。', { exact: true })).toBeVisible();
        const overlap = await s.api(s.admin, '/api/admin/accounting/periods', 'POST', {
          businessType: 'corporation', startsOn: next.starts_on, endsOn: next.ends_on, requestKey: crypto.randomUUID(),
        });
        expect(overlap.status).toBe(409);
        expect(overlap.body).toEqual({ code: 'ACCOUNTING_PERIOD_OVERLAP', error: '会計の期間が重なっています。' });

        // 1年超: 続く日から1年と1日
        const followStart = (await s.db.query("select to_char($1::date + 1, 'YYYY-MM-DD') as d", [next.ends_on])).rows[0].d as string;
        const tooLongTo = (await s.db.query("select to_char(($1::date + interval '1 year')::date, 'YYYY-MM-DD') as d", [followStart])).rows[0].d as string;
        await page.getByLabel(/^始まり/).fill(followStart);
        await page.getByLabel(/^終わり/).fill(tooLongTo);
        await add.click();
        await expect(page.getByText('会計の期間は1年を超えられません。', { exact: true })).toBeVisible();
        const tooLong = await s.api(s.admin, '/api/admin/accounting/periods', 'POST', {
          businessType: 'corporation', startsOn: followStart, endsOn: tooLongTo, requestKey: crypto.randomUUID(),
        });
        expect(tooLong.status).toBe(409);
        expect(tooLong.body).toEqual({ code: 'ACCOUNTING_PERIOD_TOO_LONG', error: '会計の期間は1年を超えられません。' });
        // 断られた分は足されていない
        expect(await countCorporation()).toBe(next.n + 1);
        await expectNoHorizontalOverflow(page);
      }, { period: 'none', corporateChain: true });
    });

    test('FREQ-561-AC-02: 設定タブに申告の期限と開業日の案内が出る', async ({ page }) => {
      test.setTimeout(240_000);
      await withAccountingScenario('deadlines', async (s) => {
        const start = await s.ensureBusinessStart(BASE_BUSINESS_START);
        const period = s.period;
        await s.openAccounting(page, '設定・期間');
        for (const title of ['開業日と事業の形', '期間', '申告の期限', '開業日からの届け出']) {
          await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
        }
        // 期間ごとの申告の期限（個人は翌年3月15日。祝日の表が無い遠い年は繰り下げず、その旨の注記が付く）
        const group = page.getByRole('group', { name: `${period.name}の申告の期限` });
        await expect(group).toBeVisible();
        await expect(group.getByText('所得税の確定申告', { exact: true })).toBeVisible();
        await expect(group).toContainText(`${period.year + 1}/03/15`);
        await expect(group.getByText('課税事業者になったら出します', { exact: true })).toBeVisible();
        // 開業日からの届け出の期限（4つ）
        const section = page.getByRole('region', { name: '開業日からの届け出' });
        for (const label of ['開業の届け出', '青色申告の承認の申請', '棚卸資産の評価の方法の届け出', '棚卸資産の評価の方法の変更の承認の申請']) {
          await expect(section.getByText(label, { exact: true })).toBeVisible();
        }
        await expect(section.getByRole('listitem')).toHaveCount(4);
        await expect(section.getByRole('listitem').first()).toContainText(/\d{4}\/\d{2}\/\d{2}/);
        if (start === BASE_BUSINESS_START) {
          // 2026年より前の開業は、開業の日から1か月後（2025/05/01）。青色申告は2か月後（6/1 は日曜なので繰り下げて 6/2）
          await expect(section.getByRole('listitem').nth(0)).toContainText('2025/05/01');
          await expect(section.getByRole('listitem').nth(1)).toContainText('2025/06/02');
        }
        await expectNoHorizontalOverflow(page);
      });
    });

    test('FREQ-561-AC-03: 入力済みの開業日は画面で変えられない', async ({ page }) => {
      test.setTimeout(240_000);
      await withAccountingScenario('start-locked', async (s) => {
        const start = await s.ensureBusinessStart(BASE_BUSINESS_START);
        const settingsRow = async () => (await s.db.query(
          `select to_char(business_start_date, 'YYYY-MM-DD') as business_start_date, version::text as version
             from public.accounting_settings where id = 1`)).rows[0];
        const before = await settingsRow();
        expect(before.business_start_date).toBe(start);

        await s.openAccounting(page, '設定・期間');
        const input = page.getByLabel('開業日', { exact: true });
        await expect(input).toHaveValue(start);
        await expect(input).toHaveAttribute('readonly', '');
        await expect(page.getByText('開業日は選び直せません', { exact: true })).toBeVisible();
        await expect(page.getByRole('button', { name: '開業日を保存' })).toHaveCount(0);
        // 事業の形は今のままなので変えるボタンは押せない
        await expect(page.getByRole('button', { name: '事業の形を変える', exact: true })).toBeDisabled();

        // 別の日を HTTP で送っても route が断る（非 ok の本文を最後まで読む）
        const other = start === '2025-05-01' ? '2025-06-01' : '2025-05-01';
        const settings = await s.settings();
        const refused = await s.api(s.admin, '/api/admin/accounting/settings', 'PUT', {
          businessStartDate: other, currentBusinessType: settings.currentBusinessType, expectedVersion: settings.version, requestKey: crypto.randomUUID(),
        });
        expect(refused.status).toBe(409);
        expect(refused.body).toEqual({ code: 'ACCOUNTING_SETTINGS_LOCKED', error: '開業日は一度入れると選び直せません。' });
        expect(await settingsRow()).toEqual(before);
        await expectNoHorizontalOverflow(page);
      });
    });
  });
}
