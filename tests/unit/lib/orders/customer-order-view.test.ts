import {
  buildCustomerOrderPublicView,
  buildCustomerOrderPrivateView,
  buildCustomerOrderDetailView,
} from '@/lib/orders/customer-order-view';
import type {
  CustomerOrderPublicInput,
  CustomerOrderPublicView,
  CustomerOrderPrivateInput,
  CustomerOrderDetailInput,
} from '@/lib/orders/customer-order-view-types';
import type { CustomerOrderReturns } from '@/lib/orders/returns/customer-return-types';
import type { OrderRefundRow } from '@/lib/orders/refund/refund-store';

const ORDER_ID = 'a1b2c3d4-1111-4222-8333-444455556666';

function returns(): CustomerOrderReturns {
  return {
    returns: [{
      id: 'return-1', number: 1, label: 'ORD-A1B2C3D4-R1', status: 'open', customerStatus: 'accepted',
      returnMethod: 'customer_ships', returnShippingPayer: 'shop', returnShippingFee: 0,
      returnAddress: { name: '返送係', postalCode: '1000001', address: '返送先', phone: '03-0000-0000' },
      requestedAt: '2026-10-20T00:00:00Z', closedAt: null,
      lines: [{ itemName: 'シャツ', color: null, size: 'M', quantity: 1, requestedResolution: 'refund',
        requestedExchange: { color: '青', size: 'L' }, resolution: 'refund', exchange: null }],
      refundAmount: 1000,
      sentBack: [
        { itemName: 'シャツ', color: null, size: 'M', quantity: 1, message: '確認中', carrier: 'yamato', trackingNumber: 'RETURN-1' },
        { itemName: 'シャツ', color: '青', size: 'L', quantity: 1, message: null, carrier: null, trackingNumber: null },
      ],
      declineMessage: null, exchangeShipping: 'pending',
    }],
    cancelRequests: [{ id: 'cancel-1', status: 'declined', requestedAt: '2026-10-19T00:00:00Z',
      lines: [{ itemName: 'シャツ', color: null, size: 'M', quantity: 1 }], declineMessage: '発送済みです' }],
    availability: { returns: 'available', endedOn: null, cancel: false },
  };
}

function publicInput(): CustomerOrderPublicInput {
  return {
    order: {
      id: ORDER_ID, created_at: '2026-10-01T00:00:00Z', status: 'paid', subtotal_amount: 1000,
      shipping_amount: 500, discount_amount: 0, total_amount: 1500, currency: 'jpy',
      order_items: [{ id: 'item-1', item_id: 1, variant_id: null, item_name: 'シャツ', item_image_url: null,
        color: null, size: 'M', quantity: 2, line_total: 1000, line_kind: 'order' }],
    },
    lineRows: [{ orderId: ORDER_ID, orderItemId: 'item-1', variantId: null, fulfillmentType: 'stock', quantity: 2,
      shipped: 1, completed: 2, refundedBeforeShipment: 0, refundedAfterShipment: 0, inProduction: 0, readyUnshipped: 1, unshipped: 1 }],
    fulfillments: [{ fulfillmentId: 'ful-1', number: 1, shippingCarrier: 'yamato', shippedAt: '2026-10-20T00:00:00Z', cancelledAt: null,
      lines: [{ orderItemId: 'item-1', quantity: 1 }, { orderItemId: 'missing', quantity: 1 }] }],
    deliveryDetail: { enabled: true, fulfillments: [{
      fulfillmentId: 'ful-1', cancelledAt: null, trackingVersion: 2, deliveryStatus: 'in_transit',
      deliveryStatusAt: '2026-10-22T01:00:00Z', deliveredAt: null, registration: { state: 'registered', everRegistered: true },
      events: [
        { trackingVersion: 1, status: 'failure', happenedAt: '2026-10-23T00:00:00Z', recordedAt: '2026-10-23T00:00:00Z' },
        { trackingVersion: 2, status: 'confirmed', happenedAt: '2026-10-20T00:00:00Z', recordedAt: '2026-10-20T00:00:00Z' },
        { trackingVersion: 2, status: 'in_transit', happenedAt: '2026-10-22T01:00:00Z', recordedAt: '2026-10-22T01:00:01Z' },
        { trackingVersion: 2, status: 'out_for_delivery', happenedAt: '2026-10-22T01:00:00Z', recordedAt: '2026-10-22T01:00:02Z' },
      ],
    }] },
    deliverySummary: { activeCount: 1, deliveredCount: 0 }, refundRows: [], returnSection: null,
    trackingKeyConfigured: true, signImage: jest.fn(async (path: string | null) => path === null ? null : 'fixed-image'),
  };
}

function privateInput(): CustomerOrderPrivateInput {
  return {
    order: { shipping_full_name: '試験 太郎', shipping_postal_code: '1000001', shipping_prefecture: '東京都',
      shipping_city: '千代田区', shipping_address: '1-1', shipping_building: '試験棟', shipping_phone: '090-0000-0000', shipping_email: 'test@example.test' },
    paymentMethod: 'stripe_card',
    fulfillments: [{ fulfillmentId: 'ful-1', number: 1, shippingCarrier: 'yamato', trackingNumber: 'OUT-1', cancelledAt: null }],
    returnSection: returns(),
  };
}

function refund(overrides: Partial<OrderRefundRow> = {}): OrderRefundRow {
  return {
    refundId: 'refund-1', source: 'admin', status: 'pending', stripeStatus: 'pending', pendingReason: null,
    failureReason: null, customerActionExpiresAt: '2026-10-26T00:00:00Z', paymentMethodType: 'konbini', amount: 500,
    shippingAmount: 0, adjustmentAmount: 0, note: null, stripeReason: null, cancelReason: null,
    notifyCustomer: true, actorEmail: null, referenceNumber: null, referenceType: null,
    createdAt: '2026-10-20T00:00:00Z', acceptedAt: null, succeededAt: null, failedAt: null, erroredAt: null, lines: [],
    ...overrides,
  };
}

function detailInput(): CustomerOrderDetailInput {
  const pub = publicInput();
  const priv = privateInput();
  return {
    ...pub, order: { ...pub.order, ...priv.order }, paymentMethod: priv.paymentMethod, returnSection: priv.returnSection,
    fulfillments: pub.fulfillments.map((row) => ({ ...row, trackingNumber: 'OUT-1', notifyCustomer: true,
      completesOrder: false, createdByEmail: null, cancelledByEmail: null, legacy: false })),
    deliverySummary: { ...pub.deliverySummary, attentionKind: null },
    deliveryDetail: { enabled: pub.deliveryDetail.enabled, fulfillments: [] }, refundRows: [],
  };
}

function keysOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(keysOf);
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, inner]) => [key, ...keysOf(inner)]);
  }
  return [];
}

test('公開型と公開の答えに個人情報のキーを持たない', async () => {
  const input = publicInput();
  const privateMaterial = privateInput();
  input.order = { ...input.order, ...privateMaterial.order, paymentMethod: 'private' } as typeof input.order;
  input.fulfillments = input.fulfillments.map((row) => ({ ...row, trackingNumber: 'PRIVATE', actorEmail: 'private@example.test' }));
  input.refundRows = [refund()];
  const section = returns();
  section.returns[0].lines[0] = { ...section.returns[0].lines[0], actorEmail: 'private@example.test' } as typeof section.returns[0]['lines'][number];
  section.cancelRequests[0] = { ...section.cancelRequests[0], paymentMethod: 'private' } as typeof section.cancelRequests[number];
  section.availability = { ...section.availability, phone: 'PRIVATE' } as typeof section.availability;
  input.returnSection = section;
  const publicView: CustomerOrderPublicView = await buildCustomerOrderPublicView(input);
  const forbidden = ['paymentMethod', 'shipping', 'shipping_full_name', 'shipping_email', 'shipping_phone', 'shipping_postal_code',
    'shipping_prefecture', 'shipping_city', 'shipping_address', 'shipping_building', 'shippingFullName', 'shippingEmail',
    'shippingPhone', 'shippingAddress', 'contactEmail', 'trackingNumber', 'trackingUrl', 'returnAddress', 'customerActionDeadline',
    'actorEmail', 'providerSubStatus', 'registration', 'trackingChanges', 'phone'];
  const recursiveForbiddenKeys = keysOf(publicView).filter((key) => forbidden.includes(key));
  expect(recursiveForbiddenKeys).toEqual([]);
  expect(keysOf(publicView.returnSection?.returns[0].sentBack)).not.toContain('carrier');
  expect(publicView.returnSection).toEqual({
    returns: [{ id: 'return-1', number: 1, label: 'ORD-A1B2C3D4-R1', status: 'open', customerStatus: 'accepted',
      returnMethod: 'customer_ships', returnShippingPayer: 'shop', returnShippingFee: 0, requestedAt: '2026-10-20T00:00:00Z', closedAt: null,
      lines: [{ itemName: 'シャツ', color: null, size: 'M', quantity: 1, requestedResolution: 'refund',
        requestedExchange: { color: '青', size: 'L' }, resolution: 'refund', exchange: null }], refundAmount: 1000,
      sentBack: [{ itemName: 'シャツ', color: null, size: 'M', quantity: 1, message: '確認中' },
        { itemName: 'シャツ', color: '青', size: 'L', quantity: 1, message: null }], declineMessage: null, exchangeShipping: 'pending' }],
    cancelRequests: returns().cancelRequests, availability: returns().availability,
  });
  // @ts-expect-error 公開型にこのキーは存在しない
  expect(publicView.paymentMethod).toBeUndefined();
  // @ts-expect-error 公開の発送に伝票番号は存在しない
  expect(publicView.shipments[0].trackingNumber).toBeUndefined();
  // @ts-expect-error 公開の返金に口座期限は存在しない
  expect(publicView.refunds[0]?.customerActionDeadline).toBeUndefined();
  // @ts-expect-error 公開の返品に返送先は存在しない
  expect(publicView.returnSection?.returns[0].returnAddress).toBeUndefined();
  // @ts-expect-error 公開の送り返しに業者は存在しない
  expect(publicView.returnSection?.returns[0].sentBack[0].carrier).toBeUndefined();
});

test('配送の現版だけを出し取消と登録前と鍵無しを隠す', async () => {
  const input = publicInput();
  input.fulfillments.unshift({ ...input.fulfillments[0], fulfillmentId: 'cancelled', number: 2, cancelledAt: '2026-10-22T00:00:00Z' });
  const view = await buildCustomerOrderPublicView(input);
  expect(view.shipments.map((row) => row.id)).toEqual(['ful-1']);
  const events = view.shipments[0].delivery?.events;
  const expectedCurrentVersionEvents = [
    { status: 'out_for_delivery', happenedAt: '2026-10-22T01:00:00Z' },
    { status: 'in_transit', happenedAt: '2026-10-22T01:00:00Z' },
    { status: 'confirmed', happenedAt: '2026-10-20T00:00:00Z' },
  ];
  expect(events).toEqual(expectedCurrentVersionEvents);
  input.trackingKeyConfigured = false;
  const noKeyShipment = (await buildCustomerOrderPublicView(input)).shipments[0];
  expect(noKeyShipment).not.toHaveProperty('delivery');
});

test.each([
  [null, false], ['pending', false], ['failed', false], ['stopped', false], ['stopped', true], ['registered', false],
] as const)('配送の登録 %s・登録済み %s に従ってキーを出し分ける', async (state, everRegistered) => {
  const input = publicInput();
  input.deliveryDetail.fulfillments[0].registration = state ? { state, everRegistered } : null;
  const shipment = (await buildCustomerOrderPublicView(input)).shipments[0];
  expect(Object.hasOwn(shipment, 'delivery')).toBe(state === 'registered' || (state === 'stopped' && everRegistered));
});

test.each(['disabled', 'cancelled', 'missing'] as const)('配送が%sならdeliveryを省き手動の配達日は条件どおり保つ', async (condition) => {
  const input = publicInput();
  input.deliveryDetail.fulfillments[0].deliveredAt = '2026-10-22T00:00:00Z';
  if (condition === 'disabled') input.deliveryDetail.enabled = false;
  if (condition === 'cancelled') input.deliveryDetail.fulfillments[0].cancelledAt = '2026-10-22T00:00:00Z';
  if (condition === 'missing') input.deliveryDetail.fulfillments = [];
  const shipment = (await buildCustomerOrderPublicView(input)).shipments[0];
  expect(shipment).not.toHaveProperty('delivery');
  expect(shipment.deliveredAt).toBe(condition === 'disabled' ? '2026-10-22T00:00:00Z' : null);
});

test('返金は手続き中と済みだけを古い順に出し段の数も保つ', async () => {
  const rows = [refund({ refundId: 'done', status: 'succeeded', createdAt: '2026-10-21T00:00:00Z' }),
    refund({ refundId: 'failed', status: 'failed' }), refund({ refundId: 'errored', status: 'error' }), refund()];
  const pub = publicInput(); pub.refundRows = rows;
  const member = detailInput(); member.refundRows = rows;
  const publicView = await buildCustomerOrderPublicView(pub);
  const memberView = await buildCustomerOrderDetailView(member);
  const publicRefunds = publicView.refunds;
  const memberRefunds = memberView.refunds;
  expect(publicRefunds.map((row) => row.status)).toEqual(['processing', 'completed']);
  expect(publicRefunds[0]).not.toHaveProperty('customerActionDeadline');
  expect(memberRefunds[0].customerActionDeadline).toBe('10月25日');
  expect(publicView.refundTotal).toBe('￥1,000');
  expect(publicView.progress.steps).toHaveLength(4);
  expect(memberView.progress).toEqual(publicView.progress);
  expect(memberView.returnSection).toEqual(member.returnSection);
});

test('個人情報の組み立ては指定の6種類の情報だけ返す', () => {
  const input = privateInput();
  input.fulfillments.unshift({ ...input.fulfillments[0], fulfillmentId: 'cancelled', cancelledAt: '2026-10-22T00:00:00Z' });
  const privateView = buildCustomerOrderPrivateView(input);
  expect(Object.keys(privateView)).toEqual(['shipping', 'contactEmail', 'paymentMethod', 'shipments', 'returns']);
  expect(privateView).toEqual({
    shipping: { fullName: '試験 太郎', postalCode: '1000001', address: '東京都 千代田区 1-1 試験棟', phone: '090-0000-0000' },
    contactEmail: 'test@example.test', paymentMethod: 'クレジットカード',
    shipments: [{ id: 'ful-1', number: 1, trackingNumber: 'OUT-1', trackingUrl: 'https://toi.kuronekoyamato.co.jp/cgi-bin/tneko?number=OUT-1' }],
    returns: [{ id: 'return-1', returnAddress: returns().returns[0].returnAddress,
      sentBack: [{ index: 0, trackingNumber: 'RETURN-1' }, { index: 1, trackingNumber: null }] }],
  });
});

test.each(['unknown', null])('未知の業者と番号無し %s も落とさず返す', async (carrier) => {
  const pub = publicInput(); pub.fulfillments[0].shippingCarrier = carrier;
  expect((await buildCustomerOrderPublicView(pub)).shipments[0]).toMatchObject({ carrier, carrierLabel: null });
  const priv = privateInput(); priv.fulfillments[0].shippingCarrier = carrier; priv.fulfillments[0].trackingNumber = null;
  expect(buildCustomerOrderPrivateView(priv).shipments[0]).toMatchObject({ trackingNumber: null, trackingUrl: null });
});

test('NULL画像と交換の0円を保持し署名にはパスだけ渡す', async () => {
  const input = publicInput();
  input.order.order_items![0].line_kind = 'exchange'; input.order.order_items![0].line_total = 0;
  const view = await buildCustomerOrderPublicView(input);
  expect(view.items[0]).toMatchObject({ imageUrl: null, variantId: null, amount: '￥0', lineKind: 'exchange' });
  expect(input.signImage).toHaveBeenCalledWith(null);
  input.order.order_items![0].item_image_url = 'fixture-image';
  expect((await buildCustomerOrderPublicView(input)).items[0].imageUrl).toBe('fixed-image');
  expect(input.signImage).toHaveBeenLastCalledWith('fixture-image');
});

test.each(['awaiting_response', 'pending'] as const)('全部返金の%sはキャンセルの手続き中で段を出さない', async (status) => {
  const input = publicInput(); input.refundRows = [refund({ status })];
  Object.assign(input.lineRows[0], { shipped: 0, refundedBeforeShipment: 1, refundedAfterShipment: 1, readyUnshipped: 0, unshipped: 0 });
  const view = await buildCustomerOrderPublicView(input);
  expect(view.progress).toEqual({ key: 'cancel_pending', label: 'キャンセルの手続き中', partiallyShipped: false, steps: null });
  expect(view.items[0].refundedQuantity).toBe(2);
  expect(view.refundTotal).toBeNull();
});

test('在庫は4段で受注生産は5段、未入金・失敗・取消は品の段階を出さない', async () => {
  const input = publicInput();
  expect((await buildCustomerOrderPublicView(input)).progress.steps).toHaveLength(4);
  Object.assign(input.lineRows[0], { fulfillmentType: 'backorder', inProduction: 1, readyUnshipped: 0 });
  const made = await buildCustomerOrderPublicView(input);
  expect(made.progress.steps).toHaveLength(5);
  expect(made.progress.key).toBe('in_production');
  expect(made.items[0].inProductionQuantity).toBe(1);
  for (const status of ['pending', 'failed', 'cancelled'] as const) {
    input.order.status = status;
    expect((await buildCustomerOrderPublicView(input)).items[0]).toMatchObject({ readyQuantity: 0, inProductionQuantity: 0 });
  }
});

test('全発送の配達済みを進み具合と済みの段へ反映する', async () => {
  const input = publicInput(); input.order.status = 'shipped';
  Object.assign(input.lineRows[0], { shipped: 2, unshipped: 0, readyUnshipped: 0 });
  input.deliverySummary.deliveredCount = 1;
  const view = await buildCustomerOrderPublicView(input);
  expect(view.progress.key).toBe('delivered');
  expect(view.progress.steps?.map((step) => step.state)).toEqual(['done', 'done', 'done', 'done']);
});

test('割引0と正数、無効な日時、空住所、未知の支払方法を現行どおり返す', async () => {
  const pub = publicInput(); pub.order.created_at = 'invalid'; pub.refundRows = [refund({ createdAt: 'invalid' })];
  expect(await buildCustomerOrderPublicView(pub)).toMatchObject({ orderDate: '-', discountAmount: '￥0', refunds: [{ date: '-' }] });
  pub.order.discount_amount = 100;
  expect((await buildCustomerOrderPublicView(pub)).discountAmount).toBe('-￥100');
  const priv = privateInput();
  for (const key of Object.keys(priv.order) as Array<keyof typeof priv.order>) priv.order[key] = null;
  priv.paymentMethod = 'future-method'; priv.returnSection = null;
  expect(buildCustomerOrderPrivateView(priv)).toMatchObject({ shipping: { fullName: '', postalCode: '', address: '', phone: '' },
    contactEmail: '', paymentMethod: 'future-method', returns: [] });
  const member = detailInput(); member.order = { ...member.order, ...priv.order }; member.paymentMethod = null;
  expect(await buildCustomerOrderDetailView(member)).toMatchObject({ shippingAddress: '', shippingFullName: '', shippingEmail: '', shippingPhone: '', paymentMethod: '-' });
});

test('返品だけ失敗のnullを保持し他の表示を保つ', async () => {
  const input = detailInput();
  const filled = await buildCustomerOrderDetailView(input);
  input.returnSection = null;
  const empty = await buildCustomerOrderDetailView(input);
  expect(empty).toEqual({ ...filled, returnSection: null });
  const pub = publicInput(); pub.order.order_items = null; pub.lineRows = [];
  expect(await buildCustomerOrderPublicView(pub)).toMatchObject({ items: [], returnSection: null });
});

test.each([
  [0, '無料'],
  [500, '￥500'],
  [800, '￥800'],
])('送料%iは「%s」と出し、会員の詳細も同じ字を返す（FREQ-516）', async (shippingAmount, expected) => {
  const pub = publicInput(); pub.order.shipping_amount = shippingAmount;
  expect((await buildCustomerOrderPublicView(pub)).shippingAmount).toBe(expected);
  const member = detailInput(); member.order.shipping_amount = shippingAmount;
  expect((await buildCustomerOrderDetailView(member)).shippingAmount).toBe(expected);
});

test('入力の配列順を変えず発送を古い番号順に組み立てる', async () => {
  const input = publicInput();
  input.fulfillments.unshift({ ...input.fulfillments[0], fulfillmentId: 'ful-2', number: 2 });
  const before = JSON.stringify(input);
  expect((await buildCustomerOrderPublicView(input)).shipments.map((row) => row.number)).toEqual([1, 2]);
  expect(JSON.stringify(input)).toBe(before);
});
