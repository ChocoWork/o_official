import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { ACCOUNTING_PERMISSION_CODES, FINANCE_TABLES } from '../tests/integration/db/helpers/accounting-fixtures';
import type { PermissionCode } from '@/lib/auth/admin-rbac';
import { CHECKOUT_VIEWPORTS, expectNoHorizontalOverflow } from './checkout-flow-helpers';
import { selectAccountingPeriod, withAccountingPermissionScenario, withAccountingScenario, type AccountingScenario } from './accounting-test-utils';
import { SUPPORTER_INITIAL_CODES, readRolePermissionState, saveRolePermissionsInDb } from './permission-settings-test-utils';

// FREQ-553: 会計の新しい権限6件と、表の権限を締めた後の本物の route。
// HTTP は本物の route（Authorization: Bearer の本物の JWT）、DB は手元の DB。応答は作り物にしない。
// 権限の付与は withPermissionScenario が終わりに元へ戻す。

const MANAGE = 'admin.accounting.settings.manage' as const;
const READ = 'admin.finance.read' as const;

async function setSupporterGrants(s: AccountingScenario, extra: readonly PermissionCode[]): Promise<void> {
  const state = await readRolePermissionState(s.db, 'supporter');
  const reply = await saveRolePermissionsInDb(s.db, s.admin.userId, {
    roleCode: 'supporter',
    permissionCodes: [...SUPPORTER_INITIAL_CODES, ...extra],
    expectedVersion: state.version,
    requestKey: randomUUID(),
  });
  expect(reply.status, JSON.stringify(reply.body)).toBe(200);
}

/** DB の関数: その利用者が（有効な役割の和集合で）全部の権限を持つか */
async function hasAll(s: AccountingScenario, userId: string, codes: readonly string[]): Promise<boolean> {
  const row = await s.db.query('select private.group_g_actor_has_permissions($1::uuid, $2::text[]) as ok', [userId, [...codes]]);
  return row.rows[0].ok === true;
}

/**
 * 期間の申告の設定を、いまと反対の消費税の区分（免税 ⇄ 課税事業者・期間の始まりから）にする書き込み。権限の確かめに使う。
 * 通れば版が1上がる。池の期間は使い回されるので、いまの区分を DB で読んで反対にする。
 */
async function putFiling(s: AccountingScenario, who: Parameters<AccountingScenario['api']>[0], version: string) {
  const current = (await s.db.query('select consumption_tax_status as status from public.accounting_periods where id = $1', [s.periodId])).rows[0].status as string;
  const toTaxable = current !== 'taxable';
  return s.api(who, `/api/admin/accounting/periods/${s.periodId}/filing`, 'PUT', {
    corporateTaxExtensionMonths: 0,
    consumptionTaxExtensionMonths: 0,
    consumptionTaxStatus: toTaxable ? 'taxable' : 'exempt',
    consumptionTaxableFrom: toTaxable ? s.period.startsOn : null,
    expectedVersion: version,
    requestKey: randomUUID(),
  });
}

/** 申告の設定を新しい期間の既定値（免税・延長なし）へ戻す。すでに既定値なら何もしない */
async function restoreFiling(s: AccountingScenario): Promise<void> {
  const row = (await s.db.query(
    `select consumption_tax_status as status, corporate_tax_extension_months as corp, consumption_tax_extension_months as cons, version::text as version
       from public.accounting_periods where id = $1`, [s.periodId])).rows[0];
  if (row.status === 'exempt' && row.corp === 0 && row.cons === 0) return;
  const reply = await s.api(s.admin, `/api/admin/accounting/periods/${s.periodId}/filing`, 'PUT', {
    corporateTaxExtensionMonths: 0, consumptionTaxExtensionMonths: 0, consumptionTaxStatus: 'exempt', consumptionTaxableFrom: null,
    expectedVersion: row.version, requestKey: randomUUID(),
  });
  expect(reply.status, reply.text).toBe(200);
}

const periodVersion = async (s: AccountingScenario): Promise<string> =>
  (await s.db.query('select version::text as v from public.accounting_periods where id = $1', [s.periodId])).rows[0].v;

test.use({ trace: 'off', locale: 'ja-JP' });
for (const viewport of CHECKOUT_VIEWPORTS) {
  test.describe(`FR-ADMIN-130 (${viewport.width}px)`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize(viewport);
    });

    test('FREQ-553-AC-01: 会計の新しい権限は店長にあり未付与のサポーターは操作できず付与後だけ操作できる', async () => {
      test.setTimeout(240_000);
      await withAccountingPermissionScenario(async (s) => {
       try {
        // ---- DB: 新しい6件は店長だけが持つ ----
        const adminState = await readRolePermissionState(s.db, 'admin');
        const supporterState = await readRolePermissionState(s.db, 'supporter');
        for (const code of ACCOUNTING_PERMISSION_CODES) {
          expect(adminState.permissionCodes).toContain(code);
          expect(supporterState.permissionCodes).not.toContain(code);
        }
        expect(supporterState.permissionCodes).not.toContain(READ);
        const supporter = await s.actor('supporter', 'aal2');
        expect(await hasAll(s, s.admin.userId, [READ, ...ACCOUNTING_PERMISSION_CODES])).toBe(true);
        expect(await hasAll(s, supporter.userId, [MANAGE])).toBe(false);

        // ---- HTTP: 未付与のサポーターは読むのも書くのも断られる ----
        const startVersion = (await s.api(s.admin, '/api/admin/accounting/periods')).body.data.periods
          .find((period: { id: string }) => period.id === s.periodId).version as string;
        const denied = await s.api(supporter, '/api/admin/accounting/periods');
        expect(denied.status).toBe(403);
        expect(denied.body).toMatchObject({ error: 'Forbidden', permission: READ });
        const deniedWrite = await putFiling(s, supporter, startVersion);
        expect(deniedWrite.status).toBe(403);
        expect(deniedWrite.body).toMatchObject({ error: 'Forbidden', permission: MANAGE });
        expect(await periodVersion(s)).toBe(startVersion); // 断られた書き込みは何も変えない

        // ---- 閲覧だけ付与: 読めるが、操作はまだ断られる ----
        await setSupporterGrants(s, [READ]);
        const readOnly = await s.api(supporter, '/api/admin/accounting/periods');
        expect(readOnly.status).toBe(200);
        expect(readOnly.body.permissions).toEqual({ manageSettings: false });
        const stillDenied = await putFiling(s, supporter, startVersion);
        expect(stillDenied.status).toBe(403);
        expect(stillDenied.body).toMatchObject({ permission: MANAGE });
        expect(await periodVersion(s)).toBe(startVersion);

        // ---- 設定の権限を付与: 付与後だけ操作できる。DB も同じ答え ----
        await setSupporterGrants(s, [READ, MANAGE]);
        expect(await hasAll(s, supporter.userId, [MANAGE])).toBe(true);
        for (const other of ACCOUNTING_PERMISSION_CODES.filter((code) => code !== MANAGE)) {
          expect(await hasAll(s, supporter.userId, [other])).toBe(false); // 付与したのは1件だけ
        }
        const granted = await putFiling(s, supporter, startVersion);
        expect(granted.status, granted.text).toBe(200);
        expect(await periodVersion(s)).toBe(String(BigInt(startVersion) + BigInt(1)));
        const grantedRead = await s.api(supporter, '/api/admin/accounting/periods');
        expect(grantedRead.body.permissions).toEqual({ manageSettings: true });

        // ---- 外すと、すぐ断られる ----
        await setSupporterGrants(s, [READ]);
        const revoked = await putFiling(s, supporter, await periodVersion(s));
        expect(revoked.status).toBe(403);
        expect(revoked.body).toMatchObject({ permission: MANAGE });
       } finally {
        // 池の期間は使い回されるので、途中で落ちても申告の設定を新しい期間の既定値へ戻す（店長が同じ route で書く）
        await restoreFiling(s);
       }
      });
    });

    test('FREQ-553-AC-01: 管理routeは結付いたaal1を403、失効app sessionを401で拒む', async () => {
      test.setTimeout(240_000);
      await withAccountingScenario('auth-boundary', async (s) => {
        const aal1 = await s.actor('admin', 'aal1');
        const expired = await s.actor('admin', 'aal2');
        await s.db.query('update public.sessions set revoked_at = now() where auth_session_id = $1', [expired.sessionId]);
        const version = await periodVersion(s);
        const calls: Array<[string, string, unknown?]> = [
          ['GET', '/api/admin/accounting/periods'],
          ['GET', '/api/admin/accounting/settings'],
          ['GET', `/api/admin/accounting/journal?periodId=${s.periodId}`],
          ['GET', `/api/admin/kpi/cost-profit?periodId=${s.periodId}`],
          ['GET', '/api/admin/accounting/product-costs?season=2030SS'],
          ['PUT', `/api/admin/accounting/periods/${s.periodId}/filing`, {
            corporateTaxExtensionMonths: 0, consumptionTaxExtensionMonths: 0, consumptionTaxStatus: 'exempt',
            consumptionTaxableFrom: null, expectedVersion: version, requestKey: randomUUID(),
          }],
          ['POST', '/api/admin/kpi/cost-profit', {
            operation: 'expense.create', fiscalYear: s.period.year,
            expense: { entryType: 'expense', date: s.day(2, 2), category: '広告宣伝費', item: 'E2E 拒否される', partner: '', amount: 1, paymentMethod: '現金', memo: '', seasonTag: null },
          }],
        ];
        for (const [method, path, data] of calls) {
          const mfa = await s.api(aal1, path, method, data);
          expect({ path, status: mfa.status }).toEqual({ path, status: 403 });
          const revoked = await s.api(expired, path, method, data);
          expect({ path, status: revoked.status }).toEqual({ path, status: 401 });
        }
        // 断られた書き込みは何も変えない
        expect(await periodVersion(s)).toBe(version);
        const created = await s.db.query("select count(*)::int as n from public.admin_finance_expenses where item_name = 'E2E 拒否される'");
        expect(created.rows[0].n).toBe(0);
        // 結び付いた aal2 の店長は同じ route を通れる
        expect((await s.api(s.admin, '/api/admin/accounting/periods')).status).toBe(200);
        expect((await s.api(s.admin, `/api/admin/kpi/cost-profit?periodId=${s.periodId}`)).status).toBe(200);
      });
    });

    test('FREQ-553-AC-04: 表の権限を締めた後も本物のcost-profit GETと経費の作成と更新とreceiptのPOSTとproduct-costs GETが手元DBで200を返し、authenticatedのJWTで会計の表を直接読むと断られる', async ({ page }) => {
      test.setTimeout(240_000);
      await withAccountingScenario('table-grants', async (s) => {
        const item = `E2E 権限 ${randomUUID().slice(0, 8)}`;
        // 本物の route（service_role で表を読み書きする）はそのまま通る
        const read = await s.api(s.admin, `/api/admin/kpi/cost-profit?periodId=${s.periodId}`);
        expect(read.status).toBe(200);
        expect(read.body.data.period.id).toBe(s.periodId);
        const id = await s.createExpense({ date: s.day(5, 5), amount: 4200, item });
        const updated = await s.updateExpense(id, { date: s.day(5, 5), amount: 4300, item });
        expect(updated.status, updated.text).toBe(200);
        const receipt = await s.postReceipt(s.admin, id, { evidenceKind: 'electronic' });
        expect(receipt.status, receipt.text).toBe(200);
        expect(receipt.body.data.id).toBeGreaterThan(0);
        const productCosts = await s.api(s.admin, '/api/admin/accounting/product-costs?season=2030SS');
        expect(productCosts.status).toBe(200);
        // DB: 作った取引・直した取引・証憑の種類
        const row = (await s.db.query('select amount::int as amount, updated_by::text as updated_by from public.admin_finance_expenses where id = $1', [id])).rows[0];
        expect(row).toEqual({ amount: 4300, updated_by: s.admin.userId });
        const stored = (await s.db.query('select evidence_kind, paper_original_kept from public.admin_finance_receipts where entry_id = $1', [id])).rows;
        expect(stored).toEqual([{ evidence_kind: 'electronic', paper_original_kept: null }]);
        const reread = await s.api(s.admin, `/api/admin/kpi/cost-profit?periodId=${s.periodId}`);
        expect((reread.body.data.savedJournal as Array<{ dedupeKey: string }>).map((entry) => entry.dedupeKey))
          .toEqual([`manual_entry:${id}:0`, expect.stringMatching(/^reversal:/), `manual_entry:${id}:1`]);

        // authenticated の JWT（admin.finance.read を持つ本物の通行証）で会計の表を PostgREST から直に読むと、表の権限で断られる
        const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
        const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
        if (!url || !anonKey) throw new Error('手元の Supabase の住所と鍵が要る');
        const tables = [...FINANCE_TABLES, 'accounting_periods', 'accounting_journal_entries', 'accounting_journal_lines', 'accounting_accounts'];
        for (const table of tables) {
          const response = await fetch(`${url}/rest/v1/${table}?select=*&limit=1`, {
            headers: { apikey: anonKey, authorization: `Bearer ${s.admin.accessToken}` },
            signal: AbortSignal.timeout(15_000),
          });
          const text = await response.text(); // 断られた本文も最後まで読む
          let code: unknown = null;
          try {
            code = (JSON.parse(text) as { code?: unknown }).code;
          } catch {
            code = null;
          }
          expect({ table, status: response.status, code }).toEqual({ table, status: 403, code: '42501' });
        }

        // 画面も同じ本物の route から取引を出す
        await s.openAccounting(page, '取引管理');
        await selectAccountingPeriod(page, s.period.name);
        await expect(page.getByRole('region', { name: '取引一覧' }).getByText(item, { exact: true })).toBeVisible();
        await expectNoHorizontalOverflow(page);
      });
    });
  });
}
