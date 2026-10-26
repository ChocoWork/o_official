/**
 * FR-ADMIN-123 グループ G の権限（G-0〜G-4。旧HTTPは撤去後の404）
 * 対応 FREQ: FREQ-540（AC-01 の拒否の側・AC-02 の画面の側・AC-05 の旧6RPC/HTTP の迂回の拒否）、FREQ-540-AC-13・FREQ-540-AC-15、FREQ-523-AC-05、FREQ-519-AC-01、FREQ-524-AC-03
 *
 * G-1 の旧経路は G-4 で撤去済み。GET /api/admin/orders と旧7メソッドは差し替えず404を確かめる。
 * 旧DB関数の拒否は group_g1_legacy_disabled のDB結合が担当する。旧caseごとの移設先は e2e-disposition.md。
 * ORDERタブは一覧表への入口だけ。旧操作の不在と残る取消・返金・返品・履歴は詳細頁で確かめる。
 * G-4: 新5メソッドの本物の401/403、DBが決める一覧/詳細/CSV/入替の権限、画面での付け外しを確かめる。
 *
 * G-2 の部分（下の「G-2」の節。FREQ-540-AC-06・AC-07、FREQ-525・FREQ-526 の権限）:
 * - 新しい窓口15メソッド（在庫・発注・受け取り・原本・書類検索）と既存の variants の GET/POST: ログインしていない本物の HTTP は 401、
 *   お客様の本物のログインの HTTP は 403。
 * - 管理者のログインは差し替えのまま、窓口の代わりに e2e/purchasing-test-utils.ts の bridge が実行者を DB の公開関数へ渡す。bridge は権限を決めず、
 *   サポーター（初期値）の拒否は DB の関数（42501）が決める。店長が権限の画面でサポーターに権限を付けると、表が見える。
 * - 窓口の認可（authorizeAdminPermission(s)）の効きは、本物の 401/403 と各 route の単体が確かめる（bridge の下では DB の権限の確かめを確かめる）。
 *
 * G-3 の部分（下の「G-3」の節。FREQ-540-AC-10、FREQ-534-AC-05、FREQ-531-AC-04 の権限）:
 * - 荷作り表・発送票の新しい窓口11メソッド: ログインしていない本物の HTTP は 401、お客様の本物のログインの HTTP は 403。
 * - 管理者のログインは差し替えのまま、窓口の代わりに e2e/shipping-test-utils.ts の bridge が実行者を DB の公開関数へ渡す。bridge は権限を決めず、
 *   サポーター（初期値）の出荷日の訂正の拒否や、店長が権限の画面でオフにした権限の拒否は DB の関数（42501）が決める。
 * - 旧4つの発送の入口は G-4 で撤去され、差し替えない HTTP の404で確かめる。
 * - 窓口の認可（authorizeAdminPermissions）の効きは、本物の 401/403 と各 route の単体が確かめる（bridge の下では DB の権限の確かめを確かめる）。
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
import { ALLOCATION_SWAP_TEXT } from '@/lib/inventory/allocation-swap-types';
import { ADMIN_ORDER_TEXT } from '@/lib/orders/admin-orders/admin-order-types';
import { SHIPMENT_SLIP_TEXT } from '@/lib/orders/shipment-slips/shipment-slip-types';
import type { PgClient } from '../tests/integration/db/helpers/local-db';
import { loginCustomer } from './delivery-tracking-test-utils';
import {
  applyFilters, createSwapMaterial, downloadCsv, listRowsOf,
  mockOrderAdminBridge, mockOrderDetailBridge, openOrderList, readSwapSnapshot,
  withOrderAdminScenario,
} from './order-admin-test-utils';
import { withLocalDb } from './order-email-test-utils';
import {
  adminOrder,
  adminOrderDetail,
  detailSection,
  mockOrderDetail,
  openOrderDetail,
  SUPPORTER_DETAIL_PERMISSIONS,
  fulfillJson,
  historyOf,
  orderLine,
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
import {
  contentAlerts,
  createCatalogMaterial,
  createPurchaseOrderInDb,
  inventoryRowOf,
  mockPurchasingUiBridge,
  withPurchasingScenario,
} from './purchasing-test-utils';
import { mockAdminSessionAs } from './refund-test-utils';
import {
  callFromPage as callWithBody,
  confirmOnSlipPage,
  createDraftInDb,
  createShippingMaterial,
  expectNoPageOverflow,
  fulfillmentsOf,
  noticeOf,
  openPacking,
  openSlip,
  prepareShippingPage,
  readSlip,
  readyQuantityOf,
  revealPackingRow,
  selectBoxOf,
  setSupporterPermissionOnScreen,
  shipMaterialsInDb,
  slipIdOfUrl,
  expectSlipHeading,
  withShippingScenario,
} from './shipping-test-utils';

/** G-1 で出していた旧い仕上がりの停止文（G-4 で画面ごと無くなった）。どの画面にも出ないことの確かめだけに使う */
const OLD_COMPLETION_STOP_TEXT = '仕上がりの手動記録・取消は終了しました。在庫の入荷から自動で割り当てます。';

/** 管理画面を開いて ORDER タブにする（ORDER は注文一覧表への入口だけ） */
async function openOrderMenu(page: Page): Promise<void> {
  await page.goto('/admin');
  await page.getByRole('button', { name: 'ORDER' }).click();
}

test.describe.configure({ mode: 'serial', timeout: 90_000 });
// G-1 の 403 の確かめは、お客様の本物のログイン（確認コードとログインの Cookie）をブラウザの通信に載せるので、通信記録（trace）を残さない
// （trace は worker 単位の設定なので、ファイルの最上位に置く）
test.use({ trace: 'off' });

const PAGE_PATH = '/admin/settings/permissions';
const DB_FORBIDDEN = '権限を変更する権限がありません。';

// G-4の①②⑤は幅によらない実HTTPのcase。③④⑥は下の各幅で行う。

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

const G4_OPERATIONS = [
  { method: 'GET', path: '/api/admin/order-items' },
  { method: 'GET', path: '/api/admin/order-items/export' },
  { method: 'GET', path: `/api/admin/orders/${G1_ORDER_ID}` },
  { method: 'POST', path: `/api/admin/orders/${G1_ORDER_ID}/allocations/swap` },
  { method: 'GET', path: `/api/admin/orders/${G1_ORDER_ID}/allocations/swap-candidates?orderItemId=${G1_BLOUSE}` },
] as const;

test('ログインしていない本物の新しい窓口 5メソッド〔GET order-items・GET order-items/export・GET orders/[id]・POST allocations/swap・GET allocations/swap-candidates〕は401', async ({ playwright, baseURL }) => {
  // FREQ-540-AC-13。差し替えなしのHTTP。画面幅では繰り返さない。
  if (!baseURL) throw new Error('baseURL が無い（playwright.config.ts）');
  const api = await playwright.request.newContext({ baseURL });
  try {
    expect(G4_OPERATIONS).toHaveLength(5);
    for (const operation of G4_OPERATIONS) {
      const response = await api.fetch(operation.path, { method: operation.method,
        data: operation.method === 'GET' ? undefined : {}, headers: { origin: new URL(baseURL).origin } });
      expect(response.status(), operation.path).toBe(401);
      expect(response.headers()['cache-control']).toBe('no-store');
      expect(await response.json()).toEqual({ error: 'Unauthorized' });
    }
  } finally { await api.dispose(); }
});

test('お客様の本物のログインでは同じ5メソッドが403', async ({ page }) => {
  // FREQ-540-AC-13。実際のログイン。CSRF/Originの403と認可の403を本文で区別する。
  test.setTimeout(180_000);
  await loginCustomer(page, 'g123g4');
  for (const operation of G4_OPERATIONS) {
    const result = await callFromPage(page, operation);
    expect(result.status, operation.path).toBe(403);
    expect(result.body).toMatchObject({ error: operation.path.includes('/allocations/') ? ALLOCATION_SWAP_TEXT.forbidden : 'Forbidden',
      permission: operation.path.includes('/allocations/') ? 'admin.orders.allocate' : 'admin.orders.read' });
  }
});

/** 撤去した旧6パス・7メソッド。認可の前に404になる。 */
const STOPPED_OPERATIONS = [
  { name: '発送の画面の材料', method: 'GET', path: `/api/admin/orders/${G1_ORDER_ID}/fulfillments` },
  { name: '発送', method: 'POST', path: `/api/admin/orders/${G1_ORDER_ID}/fulfillments` },
  { name: '発送の取消', method: 'POST', path: `/api/admin/orders/${G1_ORDER_ID}/fulfillments/${G1_FULFILLMENT_ID}/cancel` },
  { name: '手動の配達済み', method: 'POST', path: `/api/admin/orders/${G1_ORDER_ID}/fulfillments/${G1_FULFILLMENT_ID}/delivered` },
  { name: '伝票番号の訂正', method: 'POST', path: `/api/admin/orders/${G1_ORDER_ID}/fulfillments/${G1_FULFILLMENT_ID}/tracking` },
  { name: '仕上がりの記録', method: 'POST', path: `/api/admin/orders/${G1_ORDER_ID}/completions` },
  { name: '仕上がりの取消', method: 'POST', path: `/api/admin/orders/${G1_ORDER_ID}/completions/${G1_COMPLETION_ID}/cancel` },
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
      notifyCustomer: true, completesOrder: false, cancelled: false, cancellable: true, legacy: false, slipId: null, slipNumber: null,
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

test('旧い窓口〔GET /api/admin/orders と旧い 410 の6ファイル7メソッド〕は存在しない〔404〕。DB の旧い4関数の拒否は DB 結合で確かめる', async ({ playwright, baseURL }) => {
  // FREQ-540-AC-05・AC-13・AC-15。旧3caseを統合。HTTPは差し替えなし、DB拒否はgroup_g1_legacy_disabled。
  if (!baseURL) throw new Error('baseURL が無い（playwright.config.ts）');
  const api = await playwright.request.newContext({ baseURL });
  try {
    const operations = [{ name: '旧注文一覧', method: 'GET', path: '/api/admin/orders' }, ...STOPPED_OPERATIONS];
    expect(operations).toHaveLength(8);
    for (const operation of operations) {
      const response = await api.fetch(operation.path, {
        method: operation.method, data: operation.method === 'GET' ? undefined : {},
        headers: { origin: new URL(baseURL).origin },
      });
      expect(response.status(), operation.name).toBe(404);
    }
  } finally { await api.dispose(); }
});

for (const viewport of viewports) {
  test.describe(`FR-ADMIN-123 group G permissions, G-1 (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    for (const role of ['admin', 'supporter'] as const) {
      const roleName = role === 'admin' ? '店長' : 'サポーター';

      test(`${roleName}の ORDER タブは注文一覧表への入口だけで、旧い入口と停止文が無く、詳細には取消・返金・返品・履歴の読み取りが残る`, async ({ page }) => {
        // FREQ-524-AC-03・FREQ-540-AC-05。固定の旧canShip/canRecordCompletionを渡しても操作は復活しない。
        await mockAdminSessionAs(page, role);
        const legacyCalls: string[] = [];
        page.on('request', (r) => {
          const path = new URL(r.url()).pathname;
          if (path === '/api/admin/orders' || /\/(fulfillments|completions)(\/|$)/.test(path)) legacyCalls.push(path);
        });
        await mockOrderDetail(page, () => adminOrderDetail({ ...legacyOrderRow(),
          permissions: role === 'supporter' ? SUPPORTER_DETAIL_PERMISSIONS : undefined,
        }));
        await page.route(`**/api/admin/orders/${G1_ORDER_ID}/history`, (route) => fulfillJson(route, legacyHistoryResponse()));
        await openOrderMenu(page);
        await expect(page.getByRole('navigation', { name: '注文メニュー', exact: true }).getByRole('link', { name: '注文一覧表', exact: true })).toHaveAttribute('href', '/admin/orders');
        await expect(page.getByRole('table')).toHaveCount(0);
        await expect(page.getByRole('button', { name: 'CSV出力', exact: true })).toHaveCount(0);
        for (const text of [SHIPMENT_SLIP_TEXT.orderSectionGuide, OLD_COMPLETION_STOP_TEXT]) {
          await expect(page.getByText(text, { exact: true })).toHaveCount(0);
        }
        for (const name of G1_LEGACY_ENTRY_NAMES) await expect(page.getByRole('button', { name })).toHaveCount(0);
        await openOrderDetail(page, G1_ORDER_ID);
        for (const name of G1_LEGACY_ENTRY_NAMES) await expect(page.getByRole('button', { name })).toHaveCount(0);
        await expect(page.getByRole('button', { name: '返品', exact: true })).toBeVisible();
        await expect(page.getByRole('button', { name: 'キャンセルの申し込み', exact: true })).toBeVisible();
        await expect(page.getByRole('button', { name: 'キャンセル', exact: true })).toHaveCount(role === 'admin' ? 1 : 0);
        await expect(page.getByRole('button', { name: '返金', exact: true })).toHaveCount(role === 'admin' ? 1 : 0);
        const history = detailSection(page, '変更履歴');
        const shipment = history.getByRole('listitem').filter({ hasText: '発送（1回目）' }).filter({ hasText: '配送業者:' });
        await expect(shipment).toContainText('配送業者: ヤマト運輸 / 伝票番号: 1234-5678');
        await expect(history.getByText(SHIPMENT_SLIP_TEXT.orderHistoryGuide, { exact: true })).toBeVisible();
        await expect(history.getByRole('button', { name: '中身を見る', exact: true })).toBeEnabled();
        await expect(history.getByRole('button', { name: 'お客様へ再送', exact: true })).toBeEnabled();
        await expectNoPageOverflow(page);
        expect(legacyCalls).toEqual([]);
      });
    }
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// G-2: 在庫一覧表・発注・受け取り・原本の窓口の権限（FREQ-540-AC-06・AC-07。AC-08 の書き手の閉じた一覧・並行は DB 結合だけ）
// ---------------------------------------------------------------------------------------------------------------------

const G2_PO_ID = 'a1230000-0000-4000-8000-0000000002a1';
const G2_RECEIPT_ID = 'a1230000-0000-4000-8000-0000000002b1';
const G2_ATTACHMENT_ID = 'a1230000-0000-4000-8000-0000000002c1';
const G2_RESERVATION_ID = 'a1230000-0000-4000-8000-0000000002d1';
const G2_ORDERS = `/api/admin/purchase-orders/${G2_PO_ID}`;

/** G-2 の新しい窓口15メソッド（在庫・発注・受け取り・原本・書類検索）と、権限の組を G-2 で変えた既存の variants の GET/POST（合わせて17） */
const G2_OPERATIONS = [
  { name: '在庫一覧表', method: 'GET', path: '/api/admin/inventory' },
  { name: '発注一覧表', method: 'GET', path: '/api/admin/purchase-orders' },
  { name: '発注の作成', method: 'POST', path: '/api/admin/purchase-orders' },
  { name: '発注書の詳細', method: 'GET', path: G2_ORDERS },
  { name: '発注先・メモの訂正', method: 'PATCH', path: G2_ORDERS },
  { name: '数量の確定・訂正', method: 'POST', path: `${G2_ORDERS}/quantities` },
  { name: '残りの打切り', method: 'POST', path: `${G2_ORDERS}/short-closures` },
  { name: '受け取り', method: 'POST', path: `${G2_ORDERS}/receipts` },
  { name: '受け取りの取消・数量訂正', method: 'POST', path: `${G2_ORDERS}/receipts/${G2_RECEIPT_ID}/reversals` },
  { name: '原本の確定', method: 'POST', path: `${G2_ORDERS}/attachments` },
  { name: '原本の予約', method: 'POST', path: `${G2_ORDERS}/attachments/reservations` },
  { name: '署名つき送り先の出し直し', method: 'POST', path: `${G2_ORDERS}/attachments/reservations/${G2_RESERVATION_ID}/upload-url` },
  { name: '書類の情報の訂正・無効化', method: 'POST', path: `${G2_ORDERS}/attachments/${G2_ATTACHMENT_ID}/revisions` },
  { name: '原本を見る', method: 'GET', path: `${G2_ORDERS}/attachments/${G2_ATTACHMENT_ID}/url` },
  { name: '書類の検索', method: 'GET', path: '/api/admin/purchase-order-documents' },
  { name: '商品の在庫の読み取り（既存の variants）', method: 'GET', path: '/api/admin/items/1/variants' },
  { name: '商品の在庫の更新（既存の variants）', method: 'POST', path: '/api/admin/items/1/variants' },
] as const;

const G2_FORBIDDEN_TEXT = {
  inventory: '在庫一覧を見る権限がありません。',
  orders: '発注一覧を見る権限がありません。',
  documents: '取引書類を見る権限がありません。',
  detail: '発注書を見る権限がありません。',
  create: '発注を扱う権限がありません。',
} as const;

const STOCK_READ = '在庫一覧';
const PURCHASE_ORDERS_READ = '発注一覧・発注書・取引添付の閲覧/取得';

/** 表を出さず、権限の文を role=alert で出す（読み込み中のまま止まらない）。頁全体が横にはみ出さない */
async function expectForbiddenPage(page: Page, path: string, heading: string, text: string): Promise<void> {
  await page.goto(path);
  await expect(page.getByRole('heading', { name: heading, level: 1, exact: true })).toBeVisible();
  await expect(page.getByRole('alert').filter({ hasText: text })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: '読み込み中...' })).toHaveCount(0);
  await expect(page.getByRole('table')).toHaveCount(0);
  const overflows = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  expect(overflows).toBe(false);
}

/** 店長の権限の画面（bridge 経由の DB の関数）で、サポーターの1つの権限を付け外しする。保存が済み、スイッチが変わるまで待つ */
async function setSupporterPermission(adminPage: Page, label: string, next: boolean): Promise<void> {
  await adminPage.goto('/admin/settings/permissions');
  await expect(adminPage.getByRole('table')).toBeVisible();
  const toggle = adminPage.getByRole('switch', { name: `サポーター：${label}`, exact: true });
  if ((await toggle.getAttribute('aria-checked')) === String(next)) return;
  await toggle.click();
  const dialog = adminPage.getByRole('dialog', { name: '権限を変更する', exact: true });
  await dialog.getByRole('button', { name: '変更する', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(adminPage.getByRole('status').filter({ hasText: '権限を保存しました。' })).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-checked', String(next));
}

test('ログインしていない本物の新しい窓口15メソッドと既存の variants GET/POST は401', async ({ playwright, baseURL }) => {
  // FREQ-540-AC-06, FREQ-540-AC-07。差し替えの無い request context（cookie なし）で本物の窓口を呼ぶ。画面を描かないので、画面幅ごとには繰り返さない
  if (!baseURL) throw new Error('baseURL が無い（playwright.config.ts）');
  expect(G2_OPERATIONS).toHaveLength(17);
  const api = await playwright.request.newContext({ baseURL });
  try {
    for (const operation of G2_OPERATIONS) {
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

test('お客様の本物のログインでは同じ17メソッドが403', async ({ page }) => {
  // FREQ-540-AC-06, FREQ-540-AC-07。本物のお客様のログイン（確認コードは Mailpit から読む）で、窓口の権限の確かめまで通す。画面幅ごとには繰り返さない
  test.setTimeout(180_000);
  await loginCustomer(page, 'g123g2');
  for (const operation of G2_OPERATIONS) {
    const result = await callFromPage(page, operation);
    expect(result.status, `${operation.name}（${operation.method}）`).toBe(403);
    // 窓口の認可の 403（{ error: 'Forbidden', permission, role }）。CSRF・Origin の 403 とは本文で区別する
    expect(result.body, `${operation.name}（${operation.method}）の本文`).toMatchObject({ error: 'Forbidden' });
  }
});

for (const viewport of viewports) {
  test.describe(`FR-ADMIN-123 group G permissions, G-2 (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    test('サポーター（初期値）は在庫一覧表・発注一覧表を開いても、DB関数の拒否で表が出ず権限の文が出る', async ({ page }) => {
      // FREQ-540-AC-06, FREQ-540-AC-07。窓口の代わりの bridge は権限を決めず、DB の関数が実行者（サポーター）の権限を確かめて断る
      await withPurchasingScenario(async (ctx) => {
        const supporterId = await createPermissionActor(ctx.client, 'supporter');
        await mockAdminSessionAs(page, 'supporter');
        await mockPurchasingUiBridge(page, ctx.client, supporterId);

        await expectForbiddenPage(page, '/admin/inventory', '在庫一覧表', G2_FORBIDDEN_TEXT.inventory);
        await expectForbiddenPage(page, '/admin/purchase-orders', '発注一覧表', G2_FORBIDDEN_TEXT.orders);
        await expectForbiddenPage(page, '/admin/purchase-orders/documents', '取引書類の検索', G2_FORBIDDEN_TEXT.documents);
        await page.goto(`/admin/purchase-orders/${G2_PO_ID}`);
        await expect(page.getByRole('alert').filter({ hasText: G2_FORBIDDEN_TEXT.detail })).toBeVisible();
        await expect(page.getByRole('table')).toHaveCount(0);
        // 戻る道は残る
        await expect(page.getByRole('link', { name: '発注一覧表に戻る', exact: true })).toBeVisible();
      });
    });

    test('店長が権限画面でサポーターに admin.stock.read を付けると在庫一覧表が見え、発注（作成）は引き続き断られ、元に戻すと再び見えない', async ({ page }) => {
      // FREQ-540-AC-06, FREQ-540-AC-07
      await withPurchasingScenario(async (ctx) => {
        const supporterId = await createPermissionActor(ctx.client, 'supporter');
        const material = await createCatalogMaterial(ctx.client);
        // 店長の画面（権限の保存は bridge 経由で DB の関数 admin_set_role_permissions へ）と、サポーターの画面は別のタブ
        await mockAdminSessionAs(page, 'admin');
        await mockPermissionUiBridge(page, ctx.client, ctx.actorId);
        const supporterPage = await page.context().newPage();
        try {
          await supporterPage.setViewportSize({ width: viewport.width, height: viewport.height });
          await mockAdminSessionAs(supporterPage, 'supporter');
          await mockPurchasingUiBridge(supporterPage, ctx.client, supporterId);

          // 付ける前: 見えない
          await expectForbiddenPage(supporterPage, '/admin/inventory', '在庫一覧表', G2_FORBIDDEN_TEXT.inventory);

          // 在庫の読み取りを付けると、在庫一覧表が見える
          await setSupporterPermission(page, STOCK_READ, true);
          await supporterPage.goto('/admin/inventory');
          await expect(supporterPage.getByRole('heading', { name: '在庫一覧表', level: 1, exact: true })).toBeVisible();
          await expect(inventoryRowOf(supporterPage, material)).toHaveCount(1);
          // どの頁にも Next の経路の読み上げ（#__next-route-announcer__。role=alert）が1つあるので、それを除いた頁自身の alert が無いことを確かめる
          await expect(contentAlerts(supporterPage)).toHaveCount(0);

          // 発注（作成）は在庫の読み取りでは足りない: 断られ、発注書は増えない
          const supplier = `E2E サポーター ${Date.now().toString(36)}`;
          await supporterPage.getByRole('button', { name: '発注', exact: true }).click();
          await supporterPage.getByLabel(`${material.itemName} ${material.colorName} ${material.sizeLabel} の発注数量`, { exact: true }).fill('1');
          await supporterPage.getByRole('button', { name: '発注書確認', exact: true }).click();
          await supporterPage.getByLabel('発注先', { exact: true }).fill(supplier);
          await supporterPage.getByRole('button', { name: '発注確定', exact: true }).click();
          await expect(supporterPage.getByRole('alert').filter({ hasText: G2_FORBIDDEN_TEXT.create })).toBeVisible();
          const created = (await ctx.client.query('select count(*)::int as n from public.purchase_orders where supplier_name = $1', [supplier])).rows[0].n;
          expect(created).toBe(0);

          // 元に戻すと、再び見えない
          await setSupporterPermission(page, STOCK_READ, false);
          await expectForbiddenPage(supporterPage, '/admin/inventory', '在庫一覧表', G2_FORBIDDEN_TEXT.inventory);
        } finally {
          await supporterPage.close();
        }
      }, { changesPermissions: true });
    });

    test('サポーターの管理メニューに ORDER と INVENTORY があり SETTINGS は無い。INVENTORY の中に在庫一覧表と発注一覧表へのリンクがあり、権限の無い表は権限の文を出す', async ({ page }) => {
      // FREQ-540-AC-06, FREQ-540-AC-07
      await withPurchasingScenario(async (ctx) => {
        const supporterId = await createPermissionActor(ctx.client, 'supporter');
        await mockAdminSessionAs(page, 'supporter');
        await mockPurchasingUiBridge(page, ctx.client, supporterId);

        await page.goto('/admin');
        await expect(adminMenu(page).getByRole('button', { name: 'ORDER', exact: true })).toBeVisible();
        await expect(adminMenu(page).getByRole('button', { name: 'INVENTORY', exact: true })).toBeVisible();
        await expect(adminMenu(page).getByRole('button', { name: 'SETTINGS', exact: true })).toHaveCount(0);

        // G-3: 荷作り表への入口 PACKING も、サポーターの管理メニューに加わる（SETTINGS は無いまま。PACKING の中身は下の G-3 の節が確かめる）
        await expect(adminMenu(page).getByRole('button', { name: 'PACKING', exact: true })).toBeVisible();

        // INVENTORY の中: 在庫一覧表と発注一覧表へのリンク（キーボードで開ける）
        await adminMenu(page).getByRole('button', { name: 'INVENTORY', exact: true }).click();
        const inventoryMenu = page.getByRole('navigation', { name: '在庫・発注メニュー', exact: true });
        await expect(inventoryMenu.getByRole('link', { name: '在庫一覧表', exact: true })).toBeVisible();
        await expect(inventoryMenu.getByRole('link', { name: '発注一覧表', exact: true })).toBeVisible();
        await inventoryMenu.getByRole('link', { name: '在庫一覧表', exact: true }).focus();
        await page.keyboard.press('Enter');
        await expect(page).toHaveURL(/\/admin\/inventory$/);
        await expect(page.getByRole('alert').filter({ hasText: G2_FORBIDDEN_TEXT.inventory })).toBeVisible();
        await expect(page.getByRole('table')).toHaveCount(0);

        // もう一方のリンクも、権限の無い表は権限の文を出す
        await page.goto('/admin?tab=INVENTORY');
        await page.getByRole('navigation', { name: '在庫・発注メニュー', exact: true }).getByRole('link', { name: '発注一覧表', exact: true }).click();
        await expect(page).toHaveURL(/\/admin\/purchase-orders$/);
        await expect(page.getByRole('alert').filter({ hasText: G2_FORBIDDEN_TEXT.orders })).toBeVisible();
        await expect(page.getByRole('table')).toHaveCount(0);
      });
    });

    test('店長がサポーターに admin.purchase_orders.read を付けると、サポーターは INVENTORY から発注一覧表へ入れる（URLを打たない）。店長の管理メニューにも INVENTORY がある', async ({ page }) => {
      // FREQ-540-AC-06, FREQ-540-AC-07
      await withPurchasingScenario(async (ctx) => {
        const supporterId = await createPermissionActor(ctx.client, 'supporter');
        const material = await createCatalogMaterial(ctx.client);
        const order = await createPurchaseOrderInDb(ctx, { lines: [{ variantId: material.variantId, quantity: 1 }] });
        await mockAdminSessionAs(page, 'admin');
        await mockPermissionUiBridge(page, ctx.client, ctx.actorId);

        // 店長の管理メニューにも INVENTORY があり、その中に2つのリンクがある
        await page.goto('/admin?tab=INVENTORY');
        await expect(adminMenu(page).getByRole('button', { name: 'INVENTORY', exact: true })).toBeVisible();
        const adminInventoryMenu = page.getByRole('navigation', { name: '在庫・発注メニュー', exact: true });
        await expect(adminInventoryMenu.getByRole('link', { name: '在庫一覧表', exact: true })).toBeVisible();
        await expect(adminInventoryMenu.getByRole('link', { name: '発注一覧表', exact: true })).toBeVisible();

        const supporterPage = await page.context().newPage();
        try {
          await supporterPage.setViewportSize({ width: viewport.width, height: viewport.height });
          await mockAdminSessionAs(supporterPage, 'supporter');
          await mockPurchasingUiBridge(supporterPage, ctx.client, supporterId);

          await setSupporterPermission(page, PURCHASE_ORDERS_READ, true);

          // URL を打たず、管理メニューの INVENTORY → 発注一覧表の順で入る
          await supporterPage.goto('/admin');
          await supporterPage.getByRole('navigation', { name: '管理メニュー', exact: true }).getByRole('button', { name: 'INVENTORY', exact: true }).click();
          await supporterPage.getByRole('navigation', { name: '在庫・発注メニュー', exact: true }).getByRole('link', { name: '発注一覧表', exact: true }).click();
          await expect(supporterPage).toHaveURL(/\/admin\/purchase-orders$/);
          await expect(supporterPage.getByRole('heading', { name: '発注一覧表', level: 1, exact: true })).toBeVisible();
          await expect(supporterPage.getByTestId('purchase-order-row').filter({ hasText: order.number })).toHaveCount(1);
          await expect(contentAlerts(supporterPage)).toHaveCount(0);

          // 元に戻すと、再び権限の文
          await setSupporterPermission(page, PURCHASE_ORDERS_READ, false);
          await expectForbiddenPage(supporterPage, '/admin/purchase-orders', '発注一覧表', G2_FORBIDDEN_TEXT.orders);
        } finally {
          await supporterPage.close();
        }
      }, { changesPermissions: true });
    });
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// G-3: 荷作り表・発送票の窓口の権限（FREQ-540-AC-10。FREQ-534-AC-05 の旧4つの発送の入口の停止）
// ---------------------------------------------------------------------------------------------------------------------

const G3_SLIP_ID = 'a1230000-0000-4000-8000-0000000003a1';
const G3_SLIPS = '/api/admin/shipment-slips';
const G3_SLIP = `${G3_SLIPS}/${G3_SLIP_ID}`;

/** G-3 の新しい窓口11メソッド（荷作り表1・票の一覧と下書きの作成2・票の詳細1・票ごとの操作7） */
const G3_OPERATIONS = [
  { name: '荷作り表', method: 'GET', path: '/api/admin/packing' },
  { name: '発送票の一覧', method: 'GET', path: G3_SLIPS },
  { name: '下書きの作成', method: 'POST', path: G3_SLIPS },
  { name: '発送票の詳細', method: 'GET', path: G3_SLIP },
  { name: '下書きの入替', method: 'POST', path: `${G3_SLIP}/draft` },
  { name: '下書きの破棄', method: 'POST', path: `${G3_SLIP}/discard` },
  { name: '発送確定', method: 'POST', path: `${G3_SLIP}/confirm` },
  { name: '伝票番号の入力・訂正', method: 'POST', path: `${G3_SLIP}/tracking` },
  { name: '手動の配達済み', method: 'POST', path: `${G3_SLIP}/delivered` },
  { name: '発送の取消', method: 'POST', path: `${G3_SLIP}/cancel` },
  { name: '出荷日の訂正', method: 'POST', path: `${G3_SLIP}/shipment-date` },
] as const;

/** 旧4つの発送の入口（発送・発送取消・伝票番号の訂正・手動の配達済み）。G-4 で撤去され404 */
const G3_LEGACY_OPERATIONS = [
  { name: '発送', method: 'POST', path: `/api/admin/orders/${G1_ORDER_ID}/fulfillments` },
  { name: '発送の取消', method: 'POST', path: `/api/admin/orders/${G1_ORDER_ID}/fulfillments/${G1_FULFILLMENT_ID}/cancel` },
  { name: '伝票番号の訂正', method: 'POST', path: `/api/admin/orders/${G1_ORDER_ID}/fulfillments/${G1_FULFILLMENT_ID}/tracking` },
  { name: '手動の配達済み', method: 'POST', path: `/api/admin/orders/${G1_ORDER_ID}/fulfillments/${G1_FULFILLMENT_ID}/delivered` },
] as const;

const SHIPPING_MANAGE = 'admin.shipping.manage';
const SHIPPING_READ = 'admin.shipping.read';

test('ログインしていない本物の新しい窓口11メソッドは401', async ({ playwright, baseURL }) => {
  // FREQ-540-AC-10。差し替えの無い request context（cookie なし）で本物の窓口を呼ぶ。画面を描かないので、画面幅ごとには繰り返さない
  if (!baseURL) throw new Error('baseURL が無い（playwright.config.ts）');
  expect(G3_OPERATIONS).toHaveLength(11);
  const api = await playwright.request.newContext({ baseURL });
  try {
    for (const operation of G3_OPERATIONS) {
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

test('お客様の本物のログインでは同じ11メソッドが403', async ({ page }) => {
  // FREQ-540-AC-10。本物のお客様のログイン（確認コードは Mailpit から読む）で、窓口の権限の確かめまで通す。画面幅ごとには繰り返さない
  // （② は画面を描かない API だけの確かめで画面幅によらない。G-2 の節の同じ case と同じ扱い。お客様の本物のログインを3回重ねる回数制限の危険も避ける）
  test.setTimeout(180_000);
  await loginCustomer(page, 'g123g3');
  for (const operation of G3_OPERATIONS) {
    const result = await callFromPage(page, operation);
    expect(result.status, `${operation.name}（${operation.method}）`).toBe(403);
    // 窓口の認可の 403（{ error: 'Forbidden', permission, role }）。CSRF・Origin の 403 とは本文で区別する。
    // 出荷日の訂正だけは、窓口が権限の不足の 403 の error の文を専用の文（SHIPMENT_SLIP_TEXT.dateForbidden）に書き換え、permission は残す
    // （意図した作り。route の forbiddenMessage と単体 shipment-slip-shipment-date-route.test.ts の「403の訂正文」が確かめている）
    const expected = operation.path.endsWith('/shipment-date')
      ? { error: SHIPMENT_SLIP_TEXT.dateForbidden, permission: expect.any(String) }
      : { error: 'Forbidden' };
    expect(result.body, `${operation.name}（${operation.method}）の本文`).toMatchObject(expected);
  }
});

for (const viewport of viewports) {
  test.describe(`FR-ADMIN-123 group G permissions, G-3 (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    test('サポーター（初期値）は荷作り表と票を操作でき、出荷日の訂正はDB関数の拒否で断られる', async ({ page }) => {
      // FREQ-540-AC-10, FREQ-535-AC-03。窓口の代わりの bridge は権限を決めず、DB の関数が実行者（サポーター）の権限を確かめる
      test.setTimeout(240_000);
      await withShippingScenario(async (ctx) => {
        const supporterId = await createPermissionActor(ctx.client, 'supporter');
        const material = await createShippingMaterial(ctx.client, { quantity: 2 });
        await prepareShippingPage(page, ctx, { role: 'supporter', actorId: supporterId });
        await openPacking(page);

        // 荷作り表を見て、選んで発送し、票を確定できる
        const row = await revealPackingRow(page, material);
        await selectBoxOf(row, material.label).check();
        await page.getByRole('button', { name: SHIPMENT_SLIP_TEXT.ship, exact: true }).click();
        await expectSlipHeading(page);
        await confirmOnSlipPage(page);
        expect(await fulfillmentsOf(ctx.client, material.orderId)).toMatchObject([{ number: 1, quantity: 2 }]);

        // 出荷日の訂正は店長だけ: 画面は案内の文だけでボタンを出さない
        await expect(page.getByText(SHIPMENT_SLIP_TEXT.dateOwnerOnly, { exact: true })).toBeVisible();
        await expect(page.getByRole('button', { name: SHIPMENT_SLIP_TEXT.correctDate, exact: true })).toHaveCount(0);
        // 窓口を直接呼んでも、DB の関数が断る。票の版・出荷日の履歴は変わらない
        const slipId = slipIdOfUrl(page);
        const before = await readSlip(ctx.client, ctx.actorId, slipId);
        const refused = await callWithBody(page, 'POST', `${G3_SLIPS}/${slipId}/shipment-date`, {
          expectedVersion: before.version, shipmentDate: before.shipmentDate, reason: '権限の確認', requestKey: randomUUID(),
        });
        expect(refused).toEqual({ status: 403, body: { code: 'GROUP_G_FORBIDDEN', error: SHIPMENT_SLIP_TEXT.dateForbidden } });
        const after = await readSlip(ctx.client, ctx.actorId, slipId);
        expect(after.version).toBe(before.version);
        expect(after.dateHistory).toEqual(before.dateHistory);
        expect(after.shipmentDate).toBe(before.shipmentDate);
        await expectNoPageOverflow(page);
      });
    });

    test('店長が権限画面でサポーターの admin.shipping.manage をオフにすると、サポーターは票を見られるが下書き・確定・取消が断られ、戻すと再びできる', async ({ page }) => {
      // FREQ-540-AC-10
      test.setTimeout(240_000);
      await withShippingScenario(async (ctx) => {
        const { client } = ctx;
        const supporterId = await createPermissionActor(client, 'supporter');
        const toConfirm = await createShippingMaterial(client, { quantity: 2 });
        const toCancel = await createShippingMaterial(client, { quantity: 2 });
        const toCreate = await createShippingMaterial(client, { quantity: 2 });
        const draft = await createDraftInDb(ctx, [toConfirm]);
        const shipped = await shipMaterialsInDb(ctx, [toCancel], { notifyCustomer: false });
        // 店長の画面（権限の保存は bridge 経由で DB の関数 admin_set_role_permissions へ）と、サポーターの画面は別のタブ
        await mockAdminSessionAs(page, 'admin');
        await mockPermissionUiBridge(page, client, ctx.actorId);
        const supporterPage = await page.context().newPage();
        try {
          await supporterPage.setViewportSize({ width: viewport.width, height: viewport.height });
          await prepareShippingPage(supporterPage, ctx, { role: 'supporter', actorId: supporterId });
          const forbiddenAlert = supporterPage.getByRole('alert').filter({ hasText: SHIPMENT_SLIP_TEXT.forbidden });

          // 発送の操作権限を外す
          await setSupporterPermissionOnScreen(page, SHIPPING_MANAGE, false);

          // 票は見られる
          await openSlip(supporterPage, draft.id);
          await expect(supporterPage.getByTestId('slip-line')).toHaveCount(1);
          // 操作の POST の答え（このタブへ届く窓口の答え）を待ってから、画面と DB を確かめる。
          // 前の操作の断りの文が画面に残っていて、後の操作の断りの確かめを見かけ上満たすのを避けるため
          const answerOf = (id: string, operation: string) => supporterPage.waitForResponse(
            (response) => response.request().method() === 'POST' && new URL(response.url()).pathname === `${G3_SLIPS}/${id}/${operation}`,
          );
          // 確定が断られる: 票は下書きのまま、発送は作られない
          await supporterPage.getByRole('button', { name: '発送票確認', exact: true }).click();
          const [confirmAnswer] = await Promise.all([
            answerOf(draft.id, 'confirm'),
            supporterPage.getByRole('button', { name: '発送確定', exact: true }).click(),
          ]);
          expect(confirmAnswer.status()).toBe(403);
          await expect(forbiddenAlert).toBeVisible();
          expect(await fulfillmentsOf(client, toConfirm.orderId)).toEqual([]);
          // 破棄が断られる
          await supporterPage.getByRole('button', { name: '戻る', exact: true }).click();
          await supporterPage.getByRole('button', { name: SHIPMENT_SLIP_TEXT.discardDraft, exact: true }).click();
          const [discardAnswer] = await Promise.all([
            answerOf(draft.id, 'discard'),
            supporterPage.getByRole('dialog', { name: SHIPMENT_SLIP_TEXT.discardConfirm, exact: true })
              .getByRole('button', { name: SHIPMENT_SLIP_TEXT.discardSubmit, exact: true }).click(),
          ]);
          expect(discardAnswer.status()).toBe(403);
          await expect(forbiddenAlert).toBeVisible();
          expect((await readSlip(client, ctx.actorId, draft.id)).stage).toBe('draft');
          // 新しい下書きも作れない
          const created = await callWithBody(supporterPage, 'POST', G3_SLIPS, {
            lines: [{ orderItemId: toCreate.orderItemId, quantity: 1 }], requestKey: randomUUID(),
          });
          expect(created).toEqual({ status: 403, body: { code: 'GROUP_G_FORBIDDEN', error: SHIPMENT_SLIP_TEXT.forbidden } });
          // 取消が断られる: 確定済みの票は変わらない
          await openSlip(supporterPage, shipped.id);
          await supporterPage.getByRole('button', { name: SHIPMENT_SLIP_TEXT.cancelShipment, exact: true }).click();
          const cancelDialog = supporterPage.getByRole('dialog', { name: SHIPMENT_SLIP_TEXT.cancelShipment, exact: true });
          const [cancelAnswer] = await Promise.all([
            answerOf(shipped.id, 'cancel'),
            cancelDialog.getByRole('button', { name: SHIPMENT_SLIP_TEXT.cancelSubmit, exact: true }).click(),
          ]);
          expect(cancelAnswer.status()).toBe(403);
          await expect(cancelDialog.getByRole('alert').filter({ hasText: SHIPMENT_SLIP_TEXT.forbidden })).toBeVisible();
          expect((await readSlip(client, ctx.actorId, shipped.id)).stage).toBe('confirmed');
          expect((await fulfillmentsOf(client, toCancel.orderId))[0].cancelled).toBe(false);
          await expectNoPageOverflow(supporterPage);

          // 戻すと再びできる: 新しい下書きの作成も、取消も、確定も通る
          await setSupporterPermissionOnScreen(page, SHIPPING_MANAGE, true);
          const recreated = await callWithBody(supporterPage, 'POST', G3_SLIPS, {
            lines: [{ orderItemId: toCreate.orderItemId, quantity: 1 }], requestKey: randomUUID(),
          });
          expect(recreated.status).toBe(201);
          await openSlip(supporterPage, shipped.id);
          await supporterPage.getByRole('button', { name: SHIPMENT_SLIP_TEXT.cancelShipment, exact: true }).click();
          await supporterPage.getByRole('dialog', { name: SHIPMENT_SLIP_TEXT.cancelShipment, exact: true })
            .getByRole('button', { name: SHIPMENT_SLIP_TEXT.cancelSubmit, exact: true }).click();
          await expect(noticeOf(supporterPage, SHIPMENT_SLIP_TEXT.cancelled)).toBeVisible();
          await expect(supporterPage.getByTestId('slip-stage')).toContainText('取消済み');
          expect((await fulfillmentsOf(client, toCancel.orderId))[0].cancelled).toBe(true);
          expect(await readyQuantityOf(client, toCancel)).toBe(2);
          await openSlip(supporterPage, draft.id);
          await confirmOnSlipPage(supporterPage);
          expect(await fulfillmentsOf(client, toConfirm.orderId)).toMatchObject([{ number: 1, quantity: 2 }]);
        } finally {
          await supporterPage.close();
        }
      }, { changesPermissions: true });
    });

    test('admin.shipping.read をオフにすると荷作り表は権限の文だけになる', async ({ page }) => {
      // FREQ-540-AC-10, FREQ-531-AC-04
      test.setTimeout(240_000);
      await withShippingScenario(async (ctx) => {
        const { client } = ctx;
        const supporterId = await createPermissionActor(client, 'supporter');
        const material = await createShippingMaterial(client, { quantity: 2 });
        const draft = await createDraftInDb(ctx, [material]);
        await mockAdminSessionAs(page, 'admin');
        await mockPermissionUiBridge(page, client, ctx.actorId);
        const supporterPage = await page.context().newPage();
        try {
          await supporterPage.setViewportSize({ width: viewport.width, height: viewport.height });
          await prepareShippingPage(supporterPage, ctx, { role: 'supporter', actorId: supporterId });

          // 付けている間: 荷作り表の表が見える
          await openPacking(supporterPage);
          await expect(await revealPackingRow(supporterPage, material)).toBeVisible();

          // 荷作り・発送票の閲覧をオフにする: 荷作り表は権限の文だけ（表も下書きの一覧も出ない）。票の頁も権限の文
          await setSupporterPermissionOnScreen(page, SHIPPING_READ, false);
          await expectForbiddenPage(supporterPage, '/admin/packing', SHIPMENT_SLIP_TEXT.packingHeading, SHIPMENT_SLIP_TEXT.packingForbidden);
          await expect(supporterPage.getByRole('heading', { name: SHIPMENT_SLIP_TEXT.draftsHeading, level: 2, exact: true })).toHaveCount(0);
          await supporterPage.goto(`/admin/shipment-slips/${draft.id}`);
          await expect(supporterPage.getByRole('alert').filter({ hasText: SHIPMENT_SLIP_TEXT.slipForbidden })).toBeVisible();
          await expect(supporterPage.getByTestId('slip-line')).toHaveCount(0);
          // 窓口を直接呼んでも、DB の関数が断る
          const list = await callWithBody(supporterPage, 'GET', G3_SLIPS);
          expect(list).toEqual({ status: 403, body: { code: 'GROUP_G_FORBIDDEN', error: SHIPMENT_SLIP_TEXT.forbidden } });

          // 戻すと、再び見える
          await setSupporterPermissionOnScreen(page, SHIPPING_READ, true);
          await openPacking(supporterPage);
          await expect(await revealPackingRow(supporterPage, material)).toBeVisible();
          await expectNoPageOverflow(supporterPage);
        } finally {
          await supporterPage.close();
        }
      }, { changesPermissions: true });
    });

    test('旧4つの発送の入口は存在しない〔404〕。DBの旧関数の拒否はDB結合で確かめる', async ({ page }) => {
      // FREQ-534-AC-05・FREQ-540-AC-05。旧HTTPの差し替えなし。group_g1_legacy_disabledと分担する。
      await mockAdminSessionAs(page, 'admin');
      await page.goto('/admin');
      expect(G3_LEGACY_OPERATIONS).toHaveLength(4);
      for (const operation of G3_LEGACY_OPERATIONS) expect((await callFromPage(page, operation)).status, operation.name).toBe(404);
      await expectNoPageOverflow(page);
    });

    test('サポーターと店長の管理メニューに PACKING があり、SETTINGS はサポーターに無い', async ({ page }) => {
      // FREQ-540-AC-10, FREQ-531-AC-01
      await mockAdminSessionAs(page, 'supporter');
      await page.goto('/admin');
      await expect(adminMenu(page).getByRole('button', { name: 'PACKING', exact: true })).toBeVisible();
      await expect(adminMenu(page).getByRole('button', { name: 'SETTINGS', exact: true })).toHaveCount(0);
      // PACKING の中: 荷作り表へのリンク（キーボードで開ける）。権限の文は荷作り表の頁が出す（窓口と DB が守る）
      await adminMenu(page).getByRole('button', { name: 'PACKING', exact: true }).click();
      const packingMenu = page.getByRole('navigation', { name: '荷作りメニュー', exact: true });
      await expect(packingMenu.getByRole('link', { name: SHIPMENT_SLIP_TEXT.packingHeading, exact: true })).toBeVisible();
      await packingMenu.getByRole('link', { name: SHIPMENT_SLIP_TEXT.packingHeading, exact: true }).focus();
      await page.keyboard.press('Enter');
      await expect(page).toHaveURL(/\/admin\/packing$/);
      await expect(page.getByRole('heading', { name: SHIPMENT_SLIP_TEXT.packingHeading, level: 1, exact: true })).toBeVisible();

      // 店長の管理メニューにも PACKING があり（SETTINGS もある）、中のリンクも同じ
      const adminPage = await page.context().newPage();
      try {
        await adminPage.setViewportSize({ width: viewport.width, height: viewport.height });
        await mockAdminSessionAs(adminPage, 'admin');
        await adminPage.goto('/admin?tab=PACKING');
        await expect(adminMenu(adminPage).getByRole('button', { name: 'PACKING', exact: true })).toBeVisible();
        await expect(adminMenu(adminPage).getByRole('button', { name: 'SETTINGS', exact: true })).toBeVisible();
        await expect(
          adminPage.getByRole('navigation', { name: '荷作りメニュー', exact: true }).getByRole('link', { name: SHIPMENT_SLIP_TEXT.packingHeading, exact: true }),
        ).toBeVisible();
      } finally {
        await adminPage.close();
      }
    });
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// G-4: 注文一覧表・詳細・CSV・割当の入替（FREQ-540-AC-13）
// ---------------------------------------------------------------------------------------------------------------------

for (const viewport of viewports) {
  test.describe(`FR-ADMIN-123 group G permissions, G-4 (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => { await page.setViewportSize({ width: viewport.width, height: viewport.height }); });

    test('サポーター〔初期値〕は注文一覧表と詳細を開け、CSV を出力でき、入替の入口が無い。入替を窓口から直接呼ぶと DB が断る', async ({ page }) => {
      test.setTimeout(240_000);
      // FREQ-540-AC-13・FREQ-523-AC-05。bridgeは権限を決めず、actorを公開DB関数へ渡す。
      await withOrderAdminScenario(async (ctx) => {
        const m = await createSwapMaterial(ctx.client);
        const supporterId = await createPermissionActor(ctx.client, 'supporter');
        await mockAdminSessionAs(page, 'supporter');
        await mockOrderAdminBridge(page, ctx.client, supporterId);
        await mockOrderDetailBridge(page, ctx.client, supporterId, { id: m.taker.orderId });
        await openOrderList(page);
        await applyFilters(page, { email: m.taker.email });
        expect(await listRowsOf(page)).toHaveLength(1);
        const csv = await downloadCsv(page);
        expect(csv.text.startsWith('\uFEFF')).toBe(true);
        expect(csv.text).toContain('受注生産中');
        await page.getByRole('link', { name: m.taker.orderNumber, exact: true }).click();
        await expect(page.getByRole('heading', { name: `注文 ${m.taker.orderNumber}`, level: 1, exact: true })).toBeVisible();
        await expect(detailSection(page, '品物')).toContainText('受注生産中');
        await expect(detailSection(page, '品物').getByRole('button', { name: /の割り当てを入れ替える$/ })).toHaveCount(0);
        const before = await readSwapSnapshot(ctx.client, m.catalog.variantId, [m.donor.orderId, m.taker.orderId]);
        const refused = await callWithBody(page, 'POST', `/api/admin/orders/${m.taker.orderId}/allocations/swap`, {
          takerOrderItemId: m.takerOrderItemId, donorOrderItemId: m.donorOrderItemId,
          quantity: 1, reason: '権限の確認', requestKey: randomUUID(),
        });
        expect(refused).toEqual({ status: 403, body: { code: 'GROUP_G_FORBIDDEN', error: ALLOCATION_SWAP_TEXT.forbidden } });
        const candidates = await callWithBody(page, 'GET', `/api/admin/orders/${m.taker.orderId}/allocations/swap-candidates?orderItemId=${m.takerOrderItemId}`);
        expect(candidates).toEqual({ status: 403, body: { code: 'GROUP_G_FORBIDDEN', error: ALLOCATION_SWAP_TEXT.forbidden } });
        expect(await readSwapSnapshot(ctx.client, m.catalog.variantId, [m.donor.orderId, m.taker.orderId])).toEqual(before);
        await expectNoPageOverflow(page);
      });
    });

    test('店長が権限画面でサポーターの admin.orders.read をオフにすると、一覧は権限の文だけになり CSV も出ない。戻すと見える', async ({ page }) => {
      test.setTimeout(240_000);
      // FREQ-540-AC-13。役割の共有設定はwithPermissionScenarioがfinallyで差分を戻す。
      await withShippingScenario(async (ctx) => {
        const { client, actorId } = ctx;
        const supporterId = await createPermissionActor(client, 'supporter');
        const supporter = await page.context().newPage();
        try {
          const m = await createSwapMaterial(client, { context: ctx });
          await mockAdminSessionAs(page, 'admin');
          await mockPermissionUiBridge(page, client, actorId);
          await supporter.setViewportSize({ width: viewport.width, height: viewport.height });
          await mockAdminSessionAs(supporter, 'supporter');
          await mockOrderAdminBridge(supporter, client, supporterId);
          await mockOrderDetailBridge(supporter, client, supporterId, { id: m.taker.orderId });
          await openOrderList(supporter);
          await applyFilters(supporter, { email: m.taker.email });
          expect(await listRowsOf(supporter)).toHaveLength(1);
          await downloadCsv(supporter);
          await setSupporterPermissionOnScreen(page, 'admin.orders.read', false);
          await supporter.reload();
          await expect(supporter.getByRole('alert').filter({ hasText: ADMIN_ORDER_TEXT.listForbidden })).toBeVisible();
          await expect(supporter.getByRole('table')).toHaveCount(0);
          await expect(supporter.getByRole('status').filter({ hasText: ADMIN_ORDER_TEXT.listLoading })).toHaveCount(0);
          const downloads: string[] = [];
          supporter.on('download', (download) => downloads.push(download.suggestedFilename()));
          const [exportAnswer] = await Promise.all([
            supporter.waitForResponse((response) => new URL(response.url()).pathname === '/api/admin/order-items/export'),
            supporter.getByRole('button', { name: ADMIN_ORDER_TEXT.export, exact: true }).click(),
          ]);
          expect(exportAnswer.status()).toBe(403);
          expect(await exportAnswer.json()).toEqual({ code: 'GROUP_G_FORBIDDEN', error: ADMIN_ORDER_TEXT.detailForbidden });
          await expect(supporter.getByRole('alert').filter({ hasText: ADMIN_ORDER_TEXT.detailForbidden })).toBeVisible();
          await expect(supporter.getByRole('button', { name: ADMIN_ORDER_TEXT.export, exact: true })).toBeEnabled();
          expect(downloads).toEqual([]);
          const detail = await callWithBody(supporter, 'GET', `/api/admin/orders/${m.taker.orderId}`);
          expect(detail).toEqual({ status: 403, body: { code: 'GROUP_G_FORBIDDEN', error: ADMIN_ORDER_TEXT.detailForbidden } });
          await setSupporterPermissionOnScreen(page, 'admin.orders.read', true);
          await openOrderList(supporter);
          expect(await listRowsOf(supporter)).toHaveLength(1);
          await downloadCsv(supporter);
          await expectNoPageOverflow(supporter);
        } finally {
          await supporter.close();
        }
      }, { changesPermissions: true });
    });

    test('店長とサポーターの ORDER タブは注文一覧表への入口だけを出し、旧い一覧・各 dialog の入口・旧CSVは出ない', async ({ page }) => {
      // FREQ-540-AC-13・AC-15。権限の旗でなくメニューの導線を確かめる。旧HTTPを呼ばない。
      for (const role of ['admin', 'supporter'] as const) {
        await mockAdminSessionAs(page, role);
        const calls: string[] = [];
        const record = (request: import('@playwright/test').Request) => {
          const path = new URL(request.url()).pathname;
          if (path === '/api/admin/orders' || /\/(fulfillments|completions)(\/|$)/.test(path)) calls.push(path);
        };
        page.on('request', record);
        await openOrderMenu(page);
        const menu = page.getByRole('navigation', { name: '注文メニュー', exact: true });
        await expect(menu.getByRole('link')).toHaveCount(1);
        await expect(menu.getByRole('link', { name: '注文一覧表', exact: true })).toHaveAttribute('href', '/admin/orders');
        await expect(menu.getByRole('button')).toHaveCount(0);
        await expect(page.getByRole('table')).toHaveCount(0);
        await expect(page.getByRole('dialog')).toHaveCount(0);
        for (const name of [...G1_LEGACY_ENTRY_NAMES, '返金', 'キャンセル', '返品', 'キャンセルの申し込み', 'CSV出力']) {
          await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0);
        }
        await expect(page.getByRole('button', { name: /履歴/ })).toHaveCount(0);
        await expect(page.getByText(SHIPMENT_SLIP_TEXT.orderSectionGuide, { exact: true })).toHaveCount(0);
        await expect(page.getByText(OLD_COMPLETION_STOP_TEXT, { exact: true })).toHaveCount(0);
        await expectNoPageOverflow(page);
        expect(calls).toEqual([]);
        page.off('request', record);
      }
    });
  });
}
