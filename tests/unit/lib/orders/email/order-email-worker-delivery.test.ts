const mockClientRpc = jest.fn();
jest.mock('@/lib/supabase/server', () => ({
  createServiceRoleClient: jest.fn(async () => ({ rpc: (...args: unknown[]) => mockClientRpc(...args), from: jest.fn() })),
}));
jest.mock('@/lib/ops/ops-store', () => ({ recordHeartbeat: jest.fn() }));
const mockLoadDelivery = jest.fn();
jest.mock('@/lib/orders/email/order-email-delivery-material', () => ({
  loadDeliveryEmailMaterial: (...args: unknown[]) => mockLoadDelivery(...args),
}));
const mockSend = jest.fn();
jest.mock('@/lib/orders/email/order-email-sender', () => ({
  ...jest.requireActual('@/lib/orders/email/order-email-sender'),
  checkOrderEmailSendConfig: () => null,
  sendOrderEmailMessage: (...args: unknown[]) => mockSend(...args),
}));

import { processOrderEmails, runOrderEmailWorker, skipReasonFor, type OrderEmailWorkerDeps } from '@/lib/orders/email/order-email-worker';
import type { ClaimedOrderEmail } from '@/lib/orders/email/order-email-store';
import type { OrderEmailMaterial } from '@/lib/orders/email/order-email-compose';
import type { OrderEmailDeliveryMaterial } from '@/lib/orders/email/order-email-delivery-material';
import type { DeliveryEmailKind } from '@/lib/orders/email/order-email-types';

const KINDS = ['out_for_delivery', 'delivered', 'shipping_update'] as const;
function material(overrides: Partial<OrderEmailDeliveryMaterial> = {}): OrderEmailMaterial {
  return {
    order: {
      id: 'order-1', status: 'shipped', shipping_email: 'customer@example.com', shipping_full_name: null,
      subtotal_amount: 1000, shipping_amount: 0, discount_amount: 0, total_amount: 1000, currency: 'jpy',
      shipping_postal_code: null, shipping_prefecture: null, shipping_city: null, shipping_address: null,
      shipping_building: null, shipping_phone: null, review_reason: null,
    },
    items: [], fulfillment: { number: 1, carrier: 'yamato', trackingNumber: '1234', completesOrder: true, cancelled: false,
      lines: [{ item_name: 'コート', color: null, size: null, quantity: 1 }] },
    refund: null, orderReturn: null, request: null,
    delivery: { fulfillmentId: 'fulfillment-1', trackingVersion: 2, currentTrackingVersion: 2, cancelled: false,
      deliveryStatus: 'confirmed', deliveredAt: '2026-10-20T15:00:00Z', windowDays: 7,
      carrier: 'yamato', trackingNumber: '1234', ...overrides },
  };
}

function claim(kind: DeliveryEmailKind, overrides: Partial<ClaimedOrderEmail> = {}): ClaimedOrderEmail {
  return { id: 'email-1', orderId: 'order-1', kind, variant: null, origin: 'auto', attempts: 1, leaseToken: 'lease-1',
    subject: null, bodyText: null, paymentExpiredSent: false, fulfillmentId: 'fulfillment-1', refundId: null,
    returnId: null, returnReceiptId: null, cancelRequestId: null, trackingVersion: 2,
    trackingChangeId: kind === 'shipping_update' ? 'change-1' : null, ...overrides };
}

function harness(row: ClaimedOrderEmail, source: OrderEmailMaterial | null = material()) {
  const rows = [[{ email_id: row.id, order_id: row.orderId, kind: row.kind, variant: row.variant, origin: row.origin,
    attempts: row.attempts, lease_token: row.leaseToken, subject: row.subject, body_text: row.bodyText,
    fulfillment_id: row.fulfillmentId, tracking_version: row.trackingVersion, tracking_change_id: row.trackingChangeId }], []];
  const rpc = jest.fn(async (name: string) => ({ data: name === 'claim_order_email' ? rows.shift() ?? [] : true, error: null }));
  const deps: OrderEmailWorkerDeps = {
    store: { rpc }, loadMaterial: jest.fn(async () => null), loadRequestMaterial: jest.fn(async () => null),
    loadDeliveryMaterial: jest.fn(async () => source), shopRecipient: () => null,
    send: jest.fn(async () => ({ ok: true as const, providerMessageId: 'message-1' })), checkConfig: () => null,
    now: () => 0, budgetMs: 1000,
  };
  return { deps, rpc };
}

describe('配送メールを送る直前の判定', () => {
  afterEach(() => jest.restoreAllMocks());

  it('保存済み本文があっても旧版の配達中と配達済みを送らない', async () => {
    for (const kind of ['out_for_delivery', 'delivered'] as const) {
      const row = claim(kind, { subject: '保存した件名', bodyText: '保存した本文' });
      const source = material({ currentTrackingVersion: 3 });
      expect(skipReasonFor(row, source)).toBe('superseded');
      const h = harness(row, source);
      await expect(processOrderEmails(h.deps)).resolves.toMatchObject({ sent: 0, skipped: 1, failed: 0 });
      expect(h.rpc).toHaveBeenCalledWith('skip_order_email', { _email_id: row.id, _lease_token: row.leaseToken, _reason: 'superseded' });
      expect(h.deps.send).not.toHaveBeenCalled();
      expect(h.rpc).not.toHaveBeenCalledWith('save_order_email_content', expect.anything());
    }
  });

  it('配達済みの後の配達中は送る直前にも捨てる', async () => {
    const row = claim('out_for_delivery', { subject: '保存した件名', bodyText: '保存した本文' });
    const source = material({ deliveryStatus: 'delivered' });
    expect(skipReasonFor(row, source)).toBe('superseded');
    const h = harness(row, source);
    await expect(processOrderEmails(h.deps)).resolves.toMatchObject({ skipped: 1 });
    expect(h.deps.send).not.toHaveBeenCalled();
  });

  it('取消は3種類ともfulfillment_cancelled', async () => {
    for (const kind of KINDS) {
      const row = claim(kind, { subject: '保存した件名', bodyText: '保存した本文' });
      const source = material({ cancelled: true, currentTrackingVersion: 3, deliveryStatus: 'delivered' });
      expect(skipReasonFor(row, source)).toBe('fulfillment_cancelled');
      const h = harness(row, source);
      await expect(processOrderEmails(h.deps)).resolves.toMatchObject({ skipped: 1, sent: 0 });
      expect(h.rpc).toHaveBeenCalledWith('skip_order_email', expect.objectContaining({ _reason: 'fulfillment_cancelled' }));
      expect(h.deps.send).not.toHaveBeenCalled();
    }
  });

  it.each(KINDS)('%sは配送の専用loaderを使い、同じoutboxの鍵で送る', async (kind) => {
    const row = claim(kind);
    const h = harness(row);
    await expect(processOrderEmails(h.deps)).resolves.toMatchObject({ sent: 1, failed: 0 });
    expect(h.deps.loadDeliveryMaterial).toHaveBeenCalledWith(expect.objectContaining(row));
    expect(h.deps.loadMaterial).not.toHaveBeenCalled();
    expect(h.deps.loadRequestMaterial).not.toHaveBeenCalled();
    expect(h.deps.send).toHaveBeenCalledWith(expect.objectContaining({ to: 'customer@example.com', idempotencyKey: 'order-email/email-1' }));
  });

  it('発送の更新は旧版でも送る。本文の再利用前に必ず材料を読み直す', async () => {
    const row = claim('shipping_update', { subject: '保存した件名', bodyText: '保存した本文' });
    const h = harness(row, material({ currentTrackingVersion: 4, deliveryStatus: 'delivered' }));
    await expect(processOrderEmails(h.deps)).resolves.toMatchObject({ sent: 1 });
    expect(h.deps.loadDeliveryMaterial).toHaveBeenCalled();
    expect(h.deps.send).toHaveBeenCalledWith(expect.objectContaining({ subject: row.subject, text: row.bodyText }));
  });

  it.each(KINDS)('%sの材料不足は保存済み本文でもsource_missingで再試行する', async (kind) => {
    const h = harness(claim(kind, { trackingVersion: null, subject: '保存した件名', bodyText: '保存した本文' }), null);
    await expect(processOrderEmails(h.deps)).resolves.toMatchObject({ failed: 1, sent: 0 });
    expect(h.rpc).toHaveBeenCalledWith('fail_order_email', expect.objectContaining({ _error_code: 'source_missing', _category: 'transient' }));
    expect(h.deps.send).not.toHaveBeenCalled();
  });

  it('配送loaderの省略時に既存loaderへ逃がさずsource_missingにする', async () => {
    const h = harness(claim('out_for_delivery'));
    delete h.deps.loadDeliveryMaterial;
    await expect(processOrderEmails(h.deps)).resolves.toMatchObject({ failed: 1, sent: 0 });
    expect(h.deps.loadMaterial).not.toHaveBeenCalled();
    expect(h.rpc).toHaveBeenCalledWith('fail_order_email', expect.objectContaining({ _error_code: 'source_missing' }));
  });

  it('配送材料のDB失敗はdb_unavailable。宛先や例外本文をログに出さない', async () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    const h = harness(claim('delivered'));
    h.deps.loadDeliveryMaterial = jest.fn(async () => { throw new Error('customer@example.com 秘密の本文'); });
    await expect(processOrderEmails(h.deps)).resolves.toMatchObject({ failed: 1 });
    expect(h.rpc).toHaveBeenCalledWith('fail_order_email', expect.objectContaining({ _error_code: 'db_unavailable', _category: 'transient' }));
    expect(h.deps.send).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it.each(KINDS)('通常runも%sの配送loaderを必ず渡す', async (kind) => {
    jest.replaceProperty(process, 'env', { NODE_ENV: 'test' });
    const h = harness(claim(kind));
    mockClientRpc.mockImplementation(h.rpc);
    mockLoadDelivery.mockReset().mockResolvedValue(material());
    mockSend.mockReset().mockResolvedValue({ ok: true, providerMessageId: 'message-1' });
    await expect(runOrderEmailWorker()).resolves.toMatchObject({ sent: 1 });
    expect(mockLoadDelivery).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ kind, trackingVersion: 2 }));
    expect(mockSend).toHaveBeenCalledTimes(1);
  });
});
