/**
 * 発送・仕上がり・注文の進み具合の管理画面の E2E の道具（グループ E-1）。
 * 管理画面は、今までの管理画面の E2E と同じく窓口を差し替えて確かめる（本物の管理者のログインには2段階認証が要る）。
 * 窓口の答えは、共通の約束（実装計画 C-2）の型に合わせて組み立てる。型が変われば tsc が教えてくれる。
 */
import { expect, type Locator, type Page, type Route } from '@playwright/test';
import {
  ORDER_ITEM_STATUS_ORDER,
  type AdminOrderDetail,
  type AdminOrderSummary,
  type OrderItem,
  type OrderLineItem,
} from '@/lib/orders/admin-orders/admin-order-types';
import type { AdminItemStatus } from '@/lib/orders/item-state/item-state-types';
import type { OrderHistoryResponse } from '@/lib/orders/email/order-history';
import { mockAdminBackgroundApis } from './admin-test-utils';

export const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 900 },
] as const;

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** 管理画面の注文番号（src/lib/orders/order-number.ts と同じ形。値の import は避ける） */
export function orderNumberOf(orderId: string): string {
  return `ORD-${orderId.slice(0, 8).toUpperCase()}`;
}

/** 窓口の答えを JSON で返す */
export function fulfillJson(route: Route, body: unknown, status = 200): Promise<void> {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

/** 管理者のログインと、管理画面が裏で読む窓口を固定する */
export async function mockAdminSession(page: Page): Promise<void> {
  await mockAdminBackgroundApis(page);
  await page.route('**/api/auth/me', (route) =>
    fulfillJson(route, { authenticated: true, user: { id: 'a', email: 'admin@example.com', role: 'admin', mfaVerified: true } }));
  await page.route('**/api/admin/kpi', (route) => fulfillJson(route, { error: 'not mocked' }, 500));
}

/**
 * 注文の一覧の窓口。読まれた URL を記録し、その時の一覧を返す。
 * 注文の番号つきの窓口（…/orders/{id}/…）と取り違えないよう、パスが一覧だけの時に当てる。
 * 後から登録した窓口が先に効くので、これを先に呼んでから、注文ごとの窓口を登録する。
 */
export async function mockOrderList(page: Page, current: () => OrderItem[]): Promise<{ urls: string[] }> {
  const urls: string[] = [];
  await page.route(
    (url) => url.pathname === '/api/admin/orders',
    (route) => {
      urls.push(route.request().url());
      const orders = current();
      return fulfillJson(route, { data: orders, pagination: { page: 1, pageSize: 20, total: orders.length, totalPages: 1 } });
    },
  );
  return { urls };
}

/** 管理画面を開いて ORDER タブにする */
export async function openOrderTab(page: Page): Promise<void> {
  await page.goto('/admin');
  await page.getByRole('button', { name: 'ORDER' }).click();
}

/** 一覧の商品の行（既定は、在庫の品1つが発送準備中） */
export function orderLine(overrides: Partial<OrderLineItem> = {}): OrderLineItem {
  return {
    id: 'c1000000-0000-4000-8000-000000000001',
    name: 'シルクブラウス',
    color: 'ホワイト',
    size: 'M',
    quantity: 1,
    fulfillmentType: 'stock',
    shipped: 0,
    inProduction: 0,
    readyUnshipped: 1,
    ...overrides,
  };
}

/** 一覧の注文の行（既定は、発送できる状態の入金済みの注文） */
export function adminOrder(overrides: Partial<OrderItem> & { id: string }): OrderItem {
  const items = overrides.items ?? [orderLine()];
  const quantity = items.reduce((sum, item) => sum + item.quantity, 0);
  return {
    customerName: '山田 花子',
    customerEmail: 'hanako@example.com',
    orderDate: '2026-10-10',
    itemCount: `${quantity}点`,
    items,
    totalAmount: '¥28,800',
    status: '発送準備中',
    orderStatus: 'paid',
    progressKey: 'ready',
    partiallyShipped: false,
    canShip: true,
    canRecordCompletion: false,
    ...overrides,
  };
}

/**
 * GET /api/admin/orders/[id]/history の答え。窓口は配送の追跡のオン・オフ（deliveryTrackingEnabled）を必ず付ける（グループ E-4）。
 * 既定はオフ（現在の状況と登録の状態を出さない）。オンにしたい試験は options で渡す
 */
export function historyOf(
  orderId: string,
  entries: OrderHistoryResponse['entries'],
  options: { deliveryTrackingEnabled?: boolean } = {},
): OrderHistoryResponse {
  return {
    order: { id: orderId, orderNumber: orderNumberOf(orderId), statusLabel: '決済完了', recipient: 'hanako@example.com' },
    sendPaused: null,
    entries,
    deliveryTrackingEnabled: options.deliveryTrackingEnabled ?? false,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// 注文の詳細（/admin/orders/[id]）。グループ G-4 Task 9 で足した（121 の行から詳細へ移る確かめ、112・122 が使う）
// ---------------------------------------------------------------------------------------------------------------------

/** 店長の詳細の旗（全部あり）。DB の答えの形（AdminOrderDetail.permissions）と同じ */
export const ADMIN_DETAIL_PERMISSIONS: AdminOrderDetail['permissions'] = {
  read: true, manage: true, refund: true, return: true, allocate: true, shippingRead: true,
};

/** サポーター（初期値）の詳細の旗。返金と割当の入替ができない */
export const SUPPORTER_DETAIL_PERMISSIONS: AdminOrderDetail['permissions'] = {
  read: true, manage: true, refund: false, return: true, allocate: false, shippingRead: true,
};

/** adminOrder の引数に、詳細だけが持つ欄（order・amounts・rows ほか）の上書きを足した物 */
export type OrderDetailOverrides = Partial<OrderItem> & {
  id: string;
  /** 詳細の summary（旧い一覧の1件の形に、支払いの欄を足した物）の上書き */
  summary?: Partial<AdminOrderSummary>;
  order?: Partial<AdminOrderDetail['order']>;
  amounts?: Partial<AdminOrderDetail['amounts']>;
  rows?: AdminOrderDetail['rows'];
  attention?: Partial<AdminOrderDetail['attention']>;
  permissions?: Partial<AdminOrderDetail['permissions']>;
  fulfillments?: AdminOrderDetail['fulfillments'];
  slips?: AdminOrderDetail['slips'];
};

/**
 * GET /api/admin/orders/[id] の答え（AdminOrderDetail）。旧い `adminOrder(overrides)` の1件を summary にし、
 * order・amounts・rows（items から1明細1行）・attention（空）・permissions（店長の旗）・fulfillments（空）・slips（空）を既定で足す。
 */
export function adminOrderDetail(overrides: OrderDetailOverrides): AdminOrderDetail {
  const { summary: summaryOverrides, order, amounts, rows, attention, permissions, fulfillments, slips, ...itemOverrides } = overrides;
  const item = adminOrder(itemOverrides);
  const summary: AdminOrderSummary = {
    ...item,
    paymentMethod: 'クレジットカード',
    paymentReference: `pi_e2e_${item.id.slice(0, 8)}`,
    stripePaymentStatus: 'succeeded',
    paymentStatus: '支払い済み',
    shippedAt: null,
    shippingCarrier: null,
    trackingNumber: null,
    ...summaryOverrides,
  };
  const defaultRows: AdminOrderDetail['rows'] = item.items.map((line) => {
    const status: AdminItemStatus = line.readyUnshipped > 0 ? 'ready' : line.inProduction > 0 ? 'in_production' : line.shipped > 0 ? 'shipped' : 'in_production';
    return {
      orderItemId: line.id,
      itemName: line.name,
      color: line.color,
      size: line.size,
      isExchange: line.lineKind === 'exchange',
      status,
      statusRank: ORDER_ITEM_STATUS_ORDER.indexOf(status) + 1,
      quantity: line.quantity,
      unitPrice: 5000,
      lineAmount: 5000 * line.quantity,
      refundAmount: 0,
      blockedReasons: [],
    };
  });
  const detailRows = rows ?? defaultRows;
  const productNet = detailRows.reduce((sum, row) => sum + row.lineAmount, 0);
  return {
    order: {
      id: item.id,
      status: item.orderStatus ?? 'paid',
      createdAt: `${item.orderDate}T03:00:00.000Z`,
      paidAt: `${item.orderDate}T03:00:00.000Z`,
      customerKind: 'guest',
      customerName: item.customerName,
      customerEmail: item.customerEmail,
      currency: 'jpy',
      shipTo: {
        fullName: item.customerName, postalCode: '1500001', prefecture: '東京都', city: '渋谷区', address: '神宮前1-1-1', building: null, phone: '0311112222',
      },
      ...order,
    },
    amounts: {
      productNet, discount: 0, shipping: 0, total: productNet, paidAmount: productNet,
      refundedAmount: 0, refundAttachedToRows: 0, refundNotAttached: 0, refundProcessingAmount: 0,
      ...amounts,
    },
    rows: detailRows,
    attention: { paymentExceptions: [], review: null, deliveries: [], ...attention },
    permissions: { ...ADMIN_DETAIL_PERMISSIONS, ...permissions },
    summary,
    fulfillments: fulfillments ?? [],
    slips: slips === undefined ? [] : slips,
  };
}

/**
 * 詳細の窓口（GET /api/admin/orders/[id]）と履歴の窓口（…/history。空）を固定の答えにする。読まれた URL を記録して返す
 * （「詳細を読み直した」の確かめは urls の増加で見る）。current は URL の注文の番号を受ける（1件に決まっている試験は無視してよい）。
 */
export async function mockOrderDetail(page: Page, current: (orderId: string) => AdminOrderDetail): Promise<{ urls: string[] }> {
  const urls: string[] = [];
  await page.route(
    (url) => /^\/api\/admin\/orders\/[0-9a-f-]{36}$/.test(url.pathname),
    (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      const url = route.request().url();
      urls.push(url);
      return fulfillJson(route, { data: current(new URL(url).pathname.split('/')[4] ?? '') });
    },
  );
  await page.route(
    (url) => /^\/api\/admin\/orders\/[0-9a-f-]{36}\/history$/.test(url.pathname),
    (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      const orderId = new URL(route.request().url()).pathname.split('/')[4] ?? '';
      return fulfillJson(route, { ...historyOf(orderId, []), itemStates: [], itemStatesTruncated: false });
    },
  );
  return { urls };
}

/** 注文の詳細の頁を開き、見出し「注文 ORD-…」が出るまで待つ。query は `?open=refund` のように頭の ? から渡す */
export async function openOrderDetail(page: Page, orderId: string, query = ''): Promise<void> {
  await page.goto(`/admin/orders/${orderId}${query}`);
  await expect(page.getByRole('heading', { name: `注文 ${orderNumberOf(orderId)}`, level: 1, exact: true })).toBeVisible();
}

/** 詳細の欄（見出しの文字が region の名前になる）。名前は 注文情報・支払いと返金・品物・発送・返品とキャンセルの申し込み・要対応・変更履歴 */
export function detailSection(page: Page, name: string): Locator {
  return page.getByRole('region', { name, exact: true });
}
