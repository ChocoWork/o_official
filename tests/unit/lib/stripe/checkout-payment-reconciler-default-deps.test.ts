/**
 * 照合の既定の部品を作る createDefaultReconcilerDeps が、ショップの設定を読む部品と返金の部品を持つこと
 * （グループ E-2 の自動の返金①②）。照合そのものは checkout-payment-reconciler.test.ts が、返金の部品の中身は
 * refund-service の試験が確かめる。
 * checkout-payment-reconciler-deps.test.ts とは別のファイルにする: ここでは refund-store（ショップの設定の読み方）も
 * jest.mock で丸ごと差し替える。差し替えはファイルの全部の試験に効くので、Task 6 が返金の同期の試験を書いた
 * そのファイルには混ぜない。
 */
const mockClient = { name: 'service-role-client' };
const mockRefundDeps = { name: 'refund-deps' };
const mockCreateDefaultRefundServiceDeps = jest.fn();
const mockGetShopSettings = jest.fn();

jest.mock('@/lib/audit', () => ({ logAudit: jest.fn().mockResolvedValue(undefined) }));
jest.mock('@/lib/supabase/server', () => ({ createServiceRoleClient: jest.fn(async () => mockClient) }));
jest.mock('@/lib/stripe/server', () => ({ getStripeServerClient: jest.fn(() => ({ name: 'stripe-client' })) }));
jest.mock('@/lib/orders/refund/refund-service', () => ({
  createDefaultRefundServiceDeps: (...args: unknown[]) => mockCreateDefaultRefundServiceDeps(...args),
}));
jest.mock('@/lib/orders/refund/refund-store', () => ({
  getShopSettings: (...args: unknown[]) => mockGetShopSettings(...args),
}));

import { createDefaultReconcilerDeps } from '@/lib/stripe/checkout-payment-reconciler-deps';

const SETTINGS = {
  autoRefundCancelledOrderPayment: { enabled: true, updatedAt: null, updatedByEmail: null },
  autoCancelAmountMismatch: { enabled: false, updatedAt: null, updatedByEmail: null },
  refundLedgerStartedAt: '2026-10-11T00:00:00.000Z',
};

beforeEach(() => {
  jest.clearAllMocks();
  mockCreateDefaultRefundServiceDeps.mockResolvedValue(mockRefundDeps);
  mockGetShopSettings.mockResolvedValue(SETTINGS);
});

describe('createDefaultReconcilerDeps（自動の返金①②の部品）', () => {
  it('返金の部品は createDefaultRefundServiceDeps が作った物をそのまま持ち、1回だけ作る', async () => {
    const deps = await createDefaultReconcilerDeps();

    expect(deps.refund).toBe(mockRefundDeps);
    // 返金の同期（syncRefunds）と自動の返金が、同じ部品を使う
    expect(mockCreateDefaultRefundServiceDeps).toHaveBeenCalledTimes(1);
  });

  it('ショップの設定は、呼ばれた時に service_role の client で読む（部品を作るだけでは読まない）', async () => {
    const deps = await createDefaultReconcilerDeps();
    expect(mockGetShopSettings).not.toHaveBeenCalled();

    await expect(deps.readShopSettings()).resolves.toBe(SETTINGS);

    expect(mockGetShopSettings).toHaveBeenCalledTimes(1);
    expect(mockGetShopSettings).toHaveBeenCalledWith(mockClient);
  });
});
