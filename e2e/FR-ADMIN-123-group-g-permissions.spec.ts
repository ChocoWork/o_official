/**
 * FR-ADMIN-123 グループ G の権限（G-0 の部分と、G-1 の旧入口の停止）
 * 対応 FREQ: FREQ-540（AC-01 の拒否の側・AC-02 の画面の側・AC-05 の旧6RPC/HTTP の迂回の拒否）、FREQ-519-AC-01、FREQ-524-AC-03
 *
 * G-1 の部分（下の「G-1」の節）:
 * - 旧の発送・発送取消・伝票番号の訂正・手動の配達済み・仕上がりの記録/取消の窓口（7メソッド）: ログインしていない本物の HTTP は 401、
 *   権限の無い本物のお客様のログインの HTTP は 403。
 * - 認可済み（店長/サポーター）の 410 は、既存の mockAdminSessionAs（管理者のログインの差し替え）と、この spec に明示した route bridge
 *   （窓口の固定の 410 の本文を返すだけ。窓口から DB までの完全な経路ではない）で確かめる。実際の guard（認可→CSRF→回数制限）と DB の拒否
 *   （LEGACY_FULFILLMENT_DISABLED / MANUAL_COMPLETION_DISABLED）は Task 14 の単体・DB 結合が別に確かめる。
 * - 注文の一覧と履歴（390/768/1280px・店長とサポーター）: 旧の入口が 0 で固定の停止文が出て、注文の取消・返金・返品・履歴の読み取りは残る。
 * 後段の G-2/G-3/G-4 の確かめは、この spec の合格に数えない。
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
import type { OrderHistoryResponse } from '@/lib/orders/email/order-history';
import {
  LEGACY_FULFILLMENT_DISABLED,
  LEGACY_FULFILLMENT_DISABLED_TEXT,
  MANUAL_COMPLETION_DISABLED,
  MANUAL_COMPLETION_DISABLED_TEXT,
  legacyFulfillmentDisabledBody,
} from '@/lib/orders/fulfillment/legacy-fulfillment-disabled';
import type { PgClient } from '../tests/integration/db/helpers/local-db';
import { loginCustomer } from './delivery-tracking-test-utils';
import { withLocalDb } from './order-email-test-utils';
import {
  adminOrder,
  fulfillJson,
  historyOf,
  mockOrderList,
  openOrderTab,
  orderLine,
  orderNumberOf,
  viewports,
} from './order-fulfillment-test-utils';
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
// G-1 の 403 の確かめは、お客様の本物のログイン（確認コードとログインの Cookie）をブラウザの通信に載せるので、通信記録（trace）を残さない
// （trace は worker 単位の設定なので、ファイルの最上位に置く）
test.use({ trace: 'off' });

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

// ---------------------------------------------------------------------------------------------------------------------
// G-1: 旧の発送・手動の仕上がりの入口の停止（FREQ-524-AC-03・FREQ-540-AC-05）
// ---------------------------------------------------------------------------------------------------------------------

const G1_ORDER_ID = 'a1230000-0000-4000-8000-000000000123';
const G1_FULFILLMENT_ID = 'f1230000-0000-4000-8000-000000000123';
const G1_COMPLETION_ID = 'c1230000-0000-4000-8000-000000000123';
const G1_BLOUSE = 'b1230000-0000-4000-8000-000000000001';
const G1_COAT = 'b1230000-0000-4000-8000-000000000002';

/** 停止した旧の窓口（6パス・7メソッド）。発送系は LEGACY_FULFILLMENT_DISABLED、仕上がり系は MANUAL_COMPLETION_DISABLED */
const STOPPED_OPERATIONS = [
  { name: '発送の画面の材料', method: 'GET', path: `/api/admin/orders/${G1_ORDER_ID}/fulfillments`, code: LEGACY_FULFILLMENT_DISABLED },
  { name: '発送', method: 'POST', path: `/api/admin/orders/${G1_ORDER_ID}/fulfillments`, code: LEGACY_FULFILLMENT_DISABLED },
  { name: '発送の取消', method: 'POST', path: `/api/admin/orders/${G1_ORDER_ID}/fulfillments/${G1_FULFILLMENT_ID}/cancel`, code: LEGACY_FULFILLMENT_DISABLED },
  { name: '手動の配達済み', method: 'POST', path: `/api/admin/orders/${G1_ORDER_ID}/fulfillments/${G1_FULFILLMENT_ID}/delivered`, code: LEGACY_FULFILLMENT_DISABLED },
  { name: '伝票番号の訂正', method: 'POST', path: `/api/admin/orders/${G1_ORDER_ID}/fulfillments/${G1_FULFILLMENT_ID}/tracking`, code: LEGACY_FULFILLMENT_DISABLED },
  { name: '仕上がりの記録', method: 'POST', path: `/api/admin/orders/${G1_ORDER_ID}/completions`, code: MANUAL_COMPLETION_DISABLED },
  { name: '仕上がりの取消', method: 'POST', path: `/api/admin/orders/${G1_ORDER_ID}/completions/${G1_COMPLETION_ID}/cancel`, code: MANUAL_COMPLETION_DISABLED },
] as const;

/** 一覧と履歴から消えた旧の入口の名前（6つ）。どれも出ない */
const G1_LEGACY_ENTRY_NAMES = [
  '発送済みにする',
  '仕上がりを記録する',
  '伝票番号を直す',
  '配達済みにする',
  'この発送を取り消す',
  'この仕上がりを取り消す',
];

const STOPPED_PATH = /^\/api\/admin\/orders\/[^/]+\/(fulfillments(\/[^/]+\/(cancel|delivered|tracking))?|completions(\/[^/]+\/cancel)?)$/;

/**
 * 明示した route bridge: 停止した7メソッドへの要求に、窓口の固定の 410 の本文をそのまま返す。窓口の guard や DB には届かない
 * （認可済みの 410 の「形」を確かめる差し替えで、窓口から DB までの完全な経路ではない）。届いた要求を返す
 */
async function mockStoppedOperationBridge(page: Page): Promise<string[]> {
  const calls: string[] = [];
  await page.route(
    (url) => STOPPED_PATH.test(url.pathname),
    async (route) => {
      const { pathname } = new URL(route.request().url());
      calls.push(`${route.request().method()} ${pathname}`);
      const code = pathname.includes('/completions') ? MANUAL_COMPLETION_DISABLED : LEGACY_FULFILLMENT_DISABLED;
      await route.fulfill({
        status: 410,
        contentType: 'application/json',
        headers: { 'cache-control': 'no-store' },
        body: JSON.stringify(legacyFulfillmentDisabledBody(code)),
      });
    },
  );
  return calls;
}

/** 画面の中から窓口を呼ぶ（ログインの cookie は同じ origin のまま付く） */
async function callFromPage(page: Page, operation: { method: string; path: string }): Promise<{ status: number; body: unknown }> {
  return page.evaluate(async ({ method, path }) => {
    const response = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: method === 'GET' ? undefined : '{}',
    });
    return { status: response.status, body: (await response.json().catch(() => null)) as unknown };
  }, { method: operation.method, path: operation.path });
}

/** 窓口が昔の形で「発送できる・仕上がりを記録できる・取り消せる・直せる」と答える注文（画面はそれを無視して入口を出さない） */
function legacyOrderRow() {
  return adminOrder({
    id: G1_ORDER_ID,
    items: [
      orderLine({ id: G1_BLOUSE, name: 'シルクブラウス', quantity: 1, readyUnshipped: 1 }),
      orderLine({ id: G1_COAT, name: 'ウールコート', fulfillmentType: 'backorder', quantity: 1, inProduction: 1, readyUnshipped: 0 }),
    ],
    status: '受注生産中',
    progressKey: 'in_production',
    canShip: true,
    canRecordCompletion: true,
    canRefund: true,
    canCancel: true,
    cancelKind: 'paid',
    cancelRequestOpen: true,
    returnSummary: {
      orderId: G1_ORDER_ID, displayStatus: null, marks: [], nextAction: 'none',
      hasReturnable: true, refundWaitingReturns: 0, requestedReturns: 0,
    },
  });
}

/** 窓口が昔の形で取り消せる・直せると答える発送の行と、メールの行（履歴の読み取りと再送は残る） */
function legacyHistoryResponse(): OrderHistoryResponse {
  const entries: OrderHistoryResponse['entries'] = [
    {
      type: 'fulfillment', at: '2026-10-10T02:00:00.000Z', fulfillmentId: G1_FULFILLMENT_ID, number: 1, carrierLabel: 'ヤマト運輸',
      trackingNumber: '1234-5678', items: [{ name: 'シルクブラウス', quantity: 1 }], actorEmail: 'admin@example.com',
      notifyCustomer: true, completesOrder: false, cancelled: false, cancellable: true, legacy: false,
      delivery: {
        fulfillmentId: G1_FULFILLMENT_ID, number: 1, carrier: 'yamato', trackingNumber: '1234-5678', notifyCustomer: true,
        shippedAt: '2026-10-10T02:00:00.000Z', cancelledAt: null, trackingVersion: 1, deliveryStatus: 'in_transit',
        deliveryStatusAt: '2026-10-12T02:00:00.000Z', deliveredAt: null, deliveredSource: null,
        registration: { state: 'registered', failureKind: null, stopReason: null, expiresAt: '2026-11-09T02:00:00.000Z', everRegistered: true },
        events: [], trackingChanges: [],
      },
    },
    {
      type: 'email', at: '2026-10-09T01:00:00.000Z', emailId: 'e1230000-0000-4000-8000-000000000001', kind: 'paid', kindLabel: '注文確認',
      manual: false, requestedByEmail: null, stateLabel: '送信済み', warning: false, attempts: 1, errorLabel: null,
      sentAt: '2026-10-09T01:00:05.000Z', deliveryEventAt: null, canViewContent: true, bodyErased: false, resendable: true,
      fulfillmentId: null, fulfillmentNumber: null,
    },
    { type: 'created', at: '2026-10-09T00:59:00.000Z' },
  ];
  return historyOf(G1_ORDER_ID, entries, { deliveryTrackingEnabled: true });
}

test('G-1: ログインしていない本物の旧配送・手動仕上がりの窓口 7メソッドは 401 を返す', async ({ playwright, baseURL }) => {
  // FREQ-540-AC-05, FREQ-524-AC-03。差し替えの無い request context（cookie なし）で本物の窓口を呼ぶ。画面を描かないので、画面幅ごとには繰り返さない
  if (!baseURL) throw new Error('baseURL が無い（playwright.config.ts）');
  const api = await playwright.request.newContext({ baseURL });
  try {
    for (const operation of STOPPED_OPERATIONS) {
      // Origin は同じ origin（proxy の Origin の検査の先の、窓口の認可まで届かせる）
      const response = await api.fetch(operation.path, {
        method: operation.method,
        data: operation.method === 'GET' ? undefined : {},
        headers: { origin: new URL(baseURL).origin },
      });
      expect(response.status(), `${operation.name}（${operation.method}）`).toBe(401);
      expect(await response.json(), `${operation.name}（${operation.method}）の本文`).toEqual({ error: 'Unauthorized' });
    }
  } finally {
    await api.dispose();
  }
});

test('G-1: 管理者でない本物のログイン（お客様）の旧配送・手動仕上がりの窓口 7メソッドは 403 を返し、停止の 410 には届かない', async ({ page }) => {
  // FREQ-540-AC-05, FREQ-524-AC-03。本物のお客様のログイン（確認コードは Mailpit から読む）で、窓口の権限の確かめまで通す。画面幅ごとには繰り返さない
  test.setTimeout(180_000);
  await loginCustomer(page, 'g123');
  for (const operation of STOPPED_OPERATIONS) {
    const result = await callFromPage(page, operation);
    expect(result.status, `${operation.name}（${operation.method}）`).toBe(403);
    expect(result.body, `${operation.name}（${operation.method}）の本文は停止の 410 ではない`).not.toMatchObject({ code: operation.code });
  }
});

test('G-1: 認可済みの店長の旧配送・手動仕上がりの窓口は、固定の本文の 410 を返す（管理者のログインの差し替えと、明示した route bridge）', async ({ page }) => {
  // FREQ-540-AC-05, FREQ-524-AC-03。route bridge は窓口の 410 の本文を返す差し替えで、窓口の guard・DB には届かない。
  // 本物の guard（認可→CSRF→回数制限）と DB の拒否は Task 14 の単体・DB 結合が確かめる。
  // この case は差し替えの形の確かめだけで、HTTP の 410 の証拠には数えない（証拠は Task 14 の窓口の単体）
  await mockAdminSessionAs(page, 'admin');
  const calls = await mockStoppedOperationBridge(page);
  await page.goto('/admin');

  for (const operation of STOPPED_OPERATIONS) {
    const result = await callFromPage(page, operation);
    expect(result, `${operation.name}（${operation.method}）`).toEqual({ status: 410, body: legacyFulfillmentDisabledBody(operation.code) });
  }
  expect(calls).toEqual(STOPPED_OPERATIONS.map((operation) => `${operation.method} ${operation.path}`));
});

for (const viewport of viewports) {
  test.describe(`FR-ADMIN-123 group G permissions, G-1 (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    for (const role of ['admin', 'supporter'] as const) {
      const roleName = role === 'admin' ? '店長' : 'サポーター';

      test(`${roleName}の注文の一覧と履歴に、旧の発送・手動の仕上がりの入口は出ず、固定の停止文が出て、取消・返金・返品・履歴の読み取りは残る`, async ({ page }) => {
        // FREQ-524-AC-03, FREQ-540-AC-05
        await mockAdminSessionAs(page, role);
        await mockOrderList(page, () => [legacyOrderRow()]);
        await page.route(`**/api/admin/orders/${G1_ORDER_ID}/history`, (route) => fulfillJson(route, legacyHistoryResponse()));
        // 停止した窓口へは、画面から何も届かない（届けば bridge が記録する）
        const stoppedCalls = await mockStoppedOperationBridge(page);
        await openOrderTab(page);
        const row = page.getByRole('row', { name: new RegExp(G1_ORDER_ID) });
        await expect(row).toBeVisible();

        // 一覧: 窓口が canShip・canRecordCompletion を true と答えても、旧の入口は 0。固定の停止文が表の外に1回ずつ出る
        for (const name of G1_LEGACY_ENTRY_NAMES) {
          await expect(page.getByRole('button', { name }), `一覧の ${name}`).toHaveCount(0);
        }
        for (const text of [LEGACY_FULFILLMENT_DISABLED_TEXT, MANUAL_COMPLETION_DISABLED_TEXT]) {
          await expect(page.getByText(text, { exact: true })).toHaveCount(1);
          await expect(page.getByText(text, { exact: true })).toBeVisible();
          await expect(row.getByText(text, { exact: true })).toHaveCount(0);
        }
        // 残る操作: 履歴・返品・キャンセルの申し込み。支払い済みの注文のキャンセルと返金は店長だけ（設計書 5-4、admin/page.tsx の listedOrders）
        await expect(row.getByRole('button', { name: `${orderNumberOf(G1_ORDER_ID)} の履歴`, exact: true })).toBeVisible();
        await expect(row.getByRole('button', { name: '返品', exact: true })).toBeVisible();
        await expect(row.getByRole('button', { name: 'キャンセルの申し込み', exact: true })).toBeVisible();
        await expect(row.getByRole('button', { name: 'キャンセル', exact: true })).toHaveCount(role === 'admin' ? 1 : 0);
        await expect(row.getByRole('button', { name: '返金', exact: true })).toHaveCount(role === 'admin' ? 1 : 0);

        // 履歴: 読み取りは残り（発送の行・メールの行・中身を見る・お客様へ再送）、窓口が取り消せる・直せると答えても旧の入口は 0。
        // 配送の停止文は履歴の上に1回だけ。仕上がりの停止文は履歴には出さない
        await row.getByRole('button', { name: `${orderNumberOf(G1_ORDER_ID)} の履歴`, exact: true }).click();
        const dialog = page.getByRole('dialog', { name: 'この注文の履歴' });
        await expect(dialog).toBeVisible();
        const shipment = dialog.getByRole('listitem').filter({ hasText: '発送（1回目）' }).filter({ hasText: '配送業者:' });
        await expect(shipment).toContainText('配送業者: ヤマト運輸 / 伝票番号: 1234-5678');
        for (const name of G1_LEGACY_ENTRY_NAMES) {
          await expect(dialog.getByRole('button', { name }), `履歴の ${name}`).toHaveCount(0);
        }
        await expect(dialog.getByText(LEGACY_FULFILLMENT_DISABLED_TEXT, { exact: true })).toHaveCount(1);
        await expect(dialog.getByText(LEGACY_FULFILLMENT_DISABLED_TEXT, { exact: true })).toBeVisible();
        await expect(dialog.getByText(MANUAL_COMPLETION_DISABLED_TEXT, { exact: true })).toHaveCount(0);
        await expect(dialog.getByRole('button', { name: '中身を見る', exact: true })).toBeEnabled();
        await expect(dialog.getByRole('button', { name: 'お客様へ再送', exact: true })).toBeEnabled();

        const overflows = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
        expect(overflows).toBe(false);
        expect(stoppedCalls, '停止した窓口へ画面から要求が届かない').toEqual([]);
      });
    }
  });
}
