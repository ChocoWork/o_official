/**
 * 発送・仕上がり・注文の進み具合の管理画面の E2E の道具（グループ E-1）。
 * 管理画面は、今までの管理画面の E2E と同じく窓口を差し替えて確かめる（本物の管理者のログインには2段階認証が要る）。
 * 窓口の答えは、共通の約束（実装計画 C-2）の型に合わせて組み立てる。型が変われば tsc が教えてくれる。
 */
import type { Page, Route } from '@playwright/test';
import type { OrderItem, OrderLineItem } from '@/components/OrderSection';
import type { OrderHistoryResponse } from '@/lib/orders/email/order-history';
import type { FulfillmentMaterialLine, FulfillmentMaterials } from '@/lib/orders/fulfillment/fulfillment-types';
import type { OrderStatus } from '@/lib/orders/order-payment-types';
import type { OrderProgress } from '@/lib/orders/order-progress';
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

export const READY_PROGRESS: OrderProgress = { key: 'ready', label: '発送準備中', partiallyShipped: false };

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

/** 発送の材料の商品の行。未発送の数は、渡さなければ「数 − 発送した数」 */
export function materialLine(overrides: Partial<FulfillmentMaterialLine> & { orderItemId: string }): FulfillmentMaterialLine {
  const merged = {
    name: 'シルクブラウス',
    color: 'ホワイト',
    size: 'M',
    fulfillmentType: 'stock' as const,
    quantity: 1,
    shipped: 0,
    inProduction: 0,
    readyUnshipped: 1,
    ...overrides,
  };
  return { ...merged, unshipped: overrides.unshipped ?? merged.quantity - merged.shipped };
}

/** GET /api/admin/orders/[id]/fulfillments の答え */
export function shipMaterials(input: {
  orderId: string;
  lines: FulfillmentMaterialLine[];
  status?: OrderStatus;
  progress?: OrderProgress;
  blockedReason?: FulfillmentMaterials['blockedReason'];
  fulfillments?: FulfillmentMaterials['fulfillments'];
}): FulfillmentMaterials {
  return {
    order: {
      id: input.orderId,
      orderNumber: orderNumberOf(input.orderId),
      status: input.status ?? 'paid',
      progress: input.progress ?? READY_PROGRESS,
    },
    blockedReason: input.blockedReason ?? null,
    lines: input.lines,
    fulfillments: input.fulfillments ?? [],
  };
}

/** GET /api/admin/orders/[id]/history の答え */
export function historyOf(orderId: string, entries: OrderHistoryResponse['entries']): OrderHistoryResponse {
  return {
    order: { id: orderId, orderNumber: orderNumberOf(orderId), statusLabel: '決済完了', recipient: 'hanako@example.com' },
    sendPaused: null,
    entries,
  };
}
