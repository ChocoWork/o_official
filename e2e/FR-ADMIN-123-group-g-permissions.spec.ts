/**
 * FR-ADMIN-123 グループ G の権限（G-0 の部分）
 * 対応 FREQ: FREQ-540（AC-01 の拒否の側・AC-02 の画面の側）、FREQ-519-AC-01
 *
 * - サポーター・一般利用者・権限なし（役割名は店長だが有効な割り当てが無い人）が権限の画面を直に開いても、表は出ない。
 *   ログインの形（/api/auth/me）は既存の mockAdminSessionAs と同じ差し替えで、拒否そのものは bridge が手元の DB の関数
 *   （public.admin_get_permissions・public.admin_set_role_permissions）で確かめる（e2e/permission-settings-test-utils.ts）。
 * - 管理メニューの表示は役割名で決まる（権限の設定ではない）。権限なしの人にも SETTINGS の「権限」は見えるが、表は出ない。
 * - ログインしていない本物の GET/POST は、差し替えの無い request context で 401。
 *
 * この spec が確かめない所（照合先）:
 * - 窓口の認可（DB の ACL）・MFA（aal2）・CSRF・回数の制限・操作の監査 → Task 2 の単体（permissions-route・role-permissions-route）
 * - user_roles の直接の書き込みによる昇格・最後の店長・自分の役割の変更 → Task 1 の DB 結合と users-route の PATCH の単体
 * - 設定を変えた後の既存の admin.orders.read の効き方 → admin-rbac の単体と has_permission の DB 結合
 */
import { randomUUID } from 'node:crypto';
import { expect, test, type Locator, type Page } from '@playwright/test';
import type { RolePermissionChange } from '@/lib/auth/role-permission-types';
import type { PgClient } from '../tests/integration/db/helpers/local-db';
import { withLocalDb } from './order-email-test-utils';
import { mockOrderList, viewports } from './order-fulfillment-test-utils';
import {
  countPermissionRequests,
  createPermissionActor,
  deactivatePermissionActor,
  mockPermissionUiBridge,
  mockUserSession,
  readPermissionEvents,
  readRolePermissionState,
  withPermissionScenario,
} from './permission-settings-test-utils';
import { mockAdminSessionAs } from './refund-test-utils';

test.describe.configure({ mode: 'serial', timeout: 90_000 });

const PAGE_PATH = '/admin/settings/permissions';
const DB_FORBIDDEN = '権限を変更する権限がありません。';

const adminMenu = (page: Page): Locator => page.getByRole('navigation', { name: '管理メニュー', exact: true });

/** 権限の画面を直に開き、読み込みが DB の拒否で終わって、表・スイッチ・再送の操作が出ないことを確かめる */
async function expectNoPermissionTable(page: Page): Promise<void> {
  await page.goto(PAGE_PATH);
  await expect(page.getByRole('heading', { name: '権限', level: 1, exact: true })).toBeVisible();
  await expect(page.getByRole('alert').filter({ hasText: DB_FORBIDDEN })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: '読み込み中...' })).toHaveCount(0);
  await expect(page.getByRole('table')).toHaveCount(0);
  await expect(page.getByRole('switch')).toHaveCount(0);
  await expect(page.getByRole('region', { name: '権限の表', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '同じ変更を再送', exact: true })).toHaveCount(0);
  // 戻る道は残る
  await expect(page.getByRole('link', { name: '管理画面に戻る', exact: true })).toBeVisible();
  const overflows = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  expect(overflows).toBe(false);
}

/** 画面の中から保存の窓口へ POST を送る（画面と同じ道。bridge が DB の関数へ渡す） */
async function postFromPage(page: Page, change: RolePermissionChange): Promise<{ status: number; body: { code?: string } }> {
  return page.evaluate(async (body) => {
    const response = await fetch('/api/admin/role-permissions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as { code?: string } };
  }, change);
}

/** 拒否された保存が、付与・版・記録・受付のどれも変えていないことを確かめる */
async function expectNothingSaved(client: PgClient, change: RolePermissionChange, before: Awaited<ReturnType<typeof readRolePermissionState>>): Promise<void> {
  expect(await readRolePermissionState(client, change.roleCode)).toEqual(before);
  expect(await readPermissionEvents(client, [change.requestKey])).toEqual([]);
  expect(await countPermissionRequests(client, [change.requestKey])).toBe(0);
}

test('ログインしていない本物の GET /api/admin/permissions と POST /api/admin/role-permissions は 401 で、保存の記録も残らない', async ({ playwright, baseURL }) => {
  // FREQ-540-AC-01。差し替えの無い request context（cookie なし）で本物の窓口を呼ぶ。画面を描かないので、画面幅ごとには繰り返さない
  if (!baseURL) throw new Error('baseURL が無い（playwright.config.ts）');
  const api = await playwright.request.newContext({ baseURL });
  try {
    const loaded = await api.get('/api/admin/permissions');
    expect(loaded.status()).toBe(401);
    expect(loaded.headers()['cache-control']).toBe('no-store');
    expect(await loaded.json()).toEqual({ error: 'Unauthorized' });

    const change: RolePermissionChange = {
      roleCode: 'supporter',
      permissionCodes: ['admin.permissions.manage'],
      expectedVersion: '0',
      requestKey: randomUUID(),
    };
    // Origin は同じ origin（proxy の Origin の検査の先の、窓口の認可まで届かせる）
    const saved = await api.post('/api/admin/role-permissions', { data: change, headers: { origin: new URL(baseURL).origin } });
    expect(saved.status()).toBe(401);
    expect(saved.headers()['cache-control']).toBe('no-store');
    expect(await saved.json()).toEqual({ error: 'Unauthorized' });
    await withLocalDb(async (client) => {
      expect(await readPermissionEvents(client, [change.requestKey])).toEqual([]);
      expect(await countPermissionRequests(client, [change.requestKey])).toBe(0);
    });
  } finally {
    await api.dispose();
  }
});

for (const viewport of viewports) {
  test.describe(`FR-ADMIN-123 group G permissions, G-0 (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    test('サポーターの管理メニューには ORDER があり SETTINGS（設定の入口）が無く、権限の画面を直に開いても表は出ない。画面から自分に権限管理を付ける保存も DB の関数が断り、何も変わらない', async ({ page }) => {
      // FREQ-540-AC-01・AC-02（サポーターの昇格を断る）
      await withPermissionScenario(async (client) => {
        const actorId = await createPermissionActor(client, 'supporter');
        await mockAdminSessionAs(page, 'supporter');
        await mockOrderList(page, () => []);
        await mockPermissionUiBridge(page, client, actorId);

        // 管理メニューは役割名で決まる: サポーターには ORDER があり、SETTINGS が無い
        await page.goto('/admin');
        await expect(adminMenu(page).getByRole('button', { name: 'ORDER', exact: true })).toBeVisible();
        await expect(adminMenu(page).getByRole('button', { name: 'SETTINGS', exact: true })).toHaveCount(0);
        await expect(page.getByRole('navigation', { name: '設定メニュー', exact: true })).toHaveCount(0);

        await expectNoPermissionTable(page);

        // 画面と同じ道で、サポーターに権限管理（固定）を付ける保存を送る → 実行者の確かめで DB の関数が断る
        const before = await readRolePermissionState(client, 'supporter');
        const escalate: RolePermissionChange = {
          roleCode: 'supporter',
          permissionCodes: [...before.permissionCodes, 'admin.permissions.manage', 'admin.users.manage'],
          expectedVersion: before.version,
          requestKey: randomUUID(),
        };
        const refused = await postFromPage(page, escalate);
        expect(refused).toEqual({ status: 403, body: { error: DB_FORBIDDEN, code: 'ROLE_PERMISSION_FORBIDDEN' } });
        await expectNothingSaved(client, escalate, before);
      });
    });

    test('一般利用者は管理画面に入れず、権限の画面を直に開いても表は出ない。保存も DB の関数が断り、何も変わらない', async ({ page }) => {
      // FREQ-540-AC-01・AC-02（一般利用者の昇格を断る）
      await withPermissionScenario(async (client) => {
        const actorId = await createPermissionActor(client, 'user');
        await mockUserSession(page);
        await mockPermissionUiBridge(page, client, actorId);

        await page.goto('/admin');
        await expect(page.getByRole('heading', { name: 'アクセス権限がありません', exact: true })).toBeVisible();
        await expect(adminMenu(page)).toHaveCount(0);

        await expectNoPermissionTable(page);

        const before = await readRolePermissionState(client, 'admin');
        const change: RolePermissionChange = {
          roleCode: 'admin',
          permissionCodes: before.permissionCodes.filter((code) => code !== 'admin.items.manage'),
          expectedVersion: before.version,
          requestKey: randomUUID(),
        };
        const refused = await postFromPage(page, change);
        expect(refused).toEqual({ status: 403, body: { error: DB_FORBIDDEN, code: 'ROLE_PERMISSION_FORBIDDEN' } });
        await expectNothingSaved(client, change, before);
      });
    });

    test('権限なし（役割名は店長だが有効な割り当てが無い）の人には、役割名で決まる SETTINGS の「権限」は見えるが、開いても表は出ず、保存も DB の関数が断る', async ({ page }) => {
      // FREQ-540-AC-01（役割名だけでは許さない）。管理メニューの表示が役割名で決まる境界も確かめる
      await withPermissionScenario(async (client) => {
        const actorId = await createPermissionActor(client, 'admin');
        await deactivatePermissionActor(client, actorId);
        await mockAdminSessionAs(page, 'admin');
        await mockPermissionUiBridge(page, client, actorId);

        await page.goto('/admin?tab=SETTINGS');
        const menu = page.getByRole('navigation', { name: '設定メニュー', exact: true });
        await expect(menu.getByRole('link', { name: '権限', exact: true })).toBeVisible();
        await menu.getByRole('link', { name: '権限', exact: true }).click();
        await expect(page).toHaveURL(/\/admin\/settings\/permissions$/);
        await expect(page.getByRole('alert').filter({ hasText: DB_FORBIDDEN })).toBeVisible();
        await expect(page.getByRole('table')).toHaveCount(0);

        await expectNoPermissionTable(page);

        const before = await readRolePermissionState(client, 'supporter');
        const change: RolePermissionChange = {
          roleCode: 'supporter',
          permissionCodes: before.permissionCodes.filter((code) => code !== 'admin.shipping.manage'),
          expectedVersion: before.version,
          requestKey: randomUUID(),
        };
        const refused = await postFromPage(page, change);
        expect(refused).toEqual({ status: 403, body: { error: DB_FORBIDDEN, code: 'ROLE_PERMISSION_FORBIDDEN' } });
        await expectNothingSaved(client, change, before);
      });
    });
  });
}
