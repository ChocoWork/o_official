import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';

jest.mock('server-only', () => ({}), { virtual: true });
const mockCalls: string[] = [];
jest.mock('next/server', () => ({ connection: jest.fn(async () => { mockCalls.push('connection'); }) }));
jest.mock('next/navigation', () => ({ notFound: jest.fn(() => { throw new Error('NOT_FOUND'); }) }));
jest.mock('@/lib/supabase/server', () => ({ createServiceRoleClient: jest.fn(async () => ({})) }));
jest.mock('@/lib/orders/status/status-store', () => ({
  getOrderStatusLink: jest.fn(), loadOrderStatusPublicMaterial: jest.fn(), loadOrderStatusReturns: jest.fn(),
  loadOrderStatusPrivateInput: jest.fn(),
}));
jest.mock('@/lib/orders/customer-order-view', () => ({ buildCustomerOrderPublicView: jest.fn() }));
jest.mock('@/lib/storage/item-images', () => ({ signItemImageUrl: jest.fn() }));
jest.mock('@/lib/orders/tracking/delivery-config', () => ({ isDeliveryTrackingKeyConfigured: () => false }));
jest.mock('@/features/order-status/components/OrderStatusPublic', () => ({ OrderStatusPublic: () => <h1>ご注文の状況</h1> }));
jest.mock('@/features/order-status/components/OrderStatusAccess', () => ({ OrderStatusAccess: () => null }));

import OrderStatusPage, { metadata } from '@/app/order-status/[token]/page';
import OrderStatusNotFound from '@/app/order-status/[token]/not-found';
import OrderStatusError from '@/app/order-status/[token]/error';
import { notFound } from 'next/navigation';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { buildCustomerOrderPublicView } from '@/lib/orders/customer-order-view';
import { getOrderStatusLink, loadOrderStatusPublicMaterial, loadOrderStatusReturns, loadOrderStatusPrivateInput } from '@/lib/orders/status/status-store';

const token = 't'.repeat(43);
beforeEach(() => {
  jest.clearAllMocks(); mockCalls.length = 0;
  jest.mocked(getOrderStatusLink).mockImplementation(async () => { mockCalls.push('link'); return { orderId: 'order', customerId: null, verifyUntil: null, failedAttempts: 0, phoneAvailable: true }; });
  jest.mocked(loadOrderStatusPublicMaterial).mockImplementation(async () => { mockCalls.push('publicMaterial'); return {} as never; });
  jest.mocked(loadOrderStatusReturns).mockImplementation(async () => { mockCalls.push('publicReturns'); return null; });
  jest.mocked(buildCustomerOrderPublicView).mockImplementation(async () => { mockCalls.push('publicView'); return { id: 'order', orderNumber: 'ORD-1234ABCD', returnSection: null } as never; });
});

test('ページはconnectionの後で公開材料を読み個人情報を呼ばない', async () => {
  render(await OrderStatusPage({ params: Promise.resolve({ token }) }));
  expect(mockCalls).toEqual(['connection', 'link', 'publicMaterial', 'publicReturns', 'publicView']);
  expect(loadOrderStatusPrivateInput).not.toHaveBeenCalled();
  expect(screen.getByRole('heading', { name: 'ご注文の状況' })).toBeVisible();
  expect(metadata).toEqual({ title: 'ご注文の状況 | Le Fil des Heures', robots: { index: false, follow: false } });
  expect(jest.mocked(loadOrderStatusReturns).mock.calls[0]?.[1]).toEqual({ orderId: 'order', includePrivate: false });
});

test('形違いと無い注文と隠す状態は同じnotFound', async () => {
  await expect(OrderStatusPage({ params: Promise.resolve({ token: 'invalid' }) })).rejects.toThrow('NOT_FOUND');
  expect(createServiceRoleClient).not.toHaveBeenCalled();
  jest.mocked(getOrderStatusLink).mockResolvedValueOnce(null);
  await expect(OrderStatusPage({ params: Promise.resolve({ token }) })).rejects.toThrow('NOT_FOUND');
  jest.mocked(loadOrderStatusPublicMaterial).mockResolvedValueOnce(null);
  await expect(OrderStatusPage({ params: Promise.resolve({ token }) })).rejects.toThrow('NOT_FOUND');
  expect(notFound).toHaveBeenCalledTimes(3);
});

test('返品だけの失敗はnullで続け固定codeを1回だけ記録し、それ以外も固定codeだけ記録して投げる', async () => {
  const log = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    const failure = Object.assign(new Error('PRIVATE_SENTINEL'), { digest: 'PRIVATE_SENTINEL', code: 'PRIVATE_SENTINEL' });
    jest.mocked(loadOrderStatusReturns).mockRejectedValueOnce(failure);
    render(await OrderStatusPage({ params: Promise.resolve({ token }) }));
    expect(screen.getByRole('heading', { name: 'ご注文の状況' })).toBeVisible();
    expect(jest.mocked(buildCustomerOrderPublicView).mock.calls[0]?.[0].returnSection).toBeNull();
    // 固定の記号が1回・引数1つだけ。エラーの中身・digest・トークンは出さない
    expect(log.mock.calls).toEqual([['ORDER_STATUS_FAILED']]);

    log.mockClear();
    jest.mocked(loadOrderStatusPublicMaterial).mockRejectedValueOnce(failure);
    await expect(OrderStatusPage({ params: Promise.resolve({ token }) })).rejects.toThrow('ORDER_STATUS_FAILED');
    expect(log.mock.calls).toEqual([['ORDER_STATUS_FAILED']]);
  } finally { log.mockRestore(); }
});

test('404とerrorは固定文を出し、errorの内容を表示も記録せずretryで読み直す', () => {
  const log = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  const retry = jest.fn();
  const errorProps = {
    error: Object.assign(new Error('PRIVATE_SENTINEL'), { digest: 'PRIVATE_SENTINEL' }),
    reset: jest.fn(),
    retry,
  };
  const { unmount } = render(<OrderStatusNotFound />);
  expect(screen.getByRole('heading', { name: 'このページは見つかりません' })).toBeVisible();
  expect(screen.getByRole('link', { name: 'トップページへ' })).toHaveAttribute('href', '/');
  unmount();
  render(<OrderStatusError {...errorProps} />);
  expect(document.body.textContent?.includes('PRIVATE_SENTINEL')).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'もう一度読み込む' }));
  expect(retry).toHaveBeenCalledTimes(1);
  expect(errorProps.reset).not.toHaveBeenCalled();
  expect(log).not.toHaveBeenCalled(); log.mockRestore();
});
