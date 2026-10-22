import fs from 'node:fs';
import path from 'node:path';
import { RefundStoreError } from '@/lib/orders/refund/refund-store';
import { CUSTOMER_RETURN_ERROR_CODES } from '@/lib/orders/returns/customer-return-messages';
import {
  CustomerOrderNotFoundError,
  createCustomerReturnPhotoUpload,
  loadCustomerOrderReturns,
  loadCustomerReturnRequestMaterials,
  parseCustomerOrderReturns,
  parsePublicCustomerOrderReturns,
  requestCustomerCancel,
  requestCustomerReturn,
} from '@/lib/orders/returns/customer-return-store';
import type { CustomerCancelRequestInput, CustomerReturnRequestInput } from '@/lib/orders/returns/customer-return-types';
import { ReturnStoreError, type ReturnStore } from '@/lib/orders/returns/return-store';
import { declaredParams, expectRefusal, migrationText, storeWith } from './return-store-test-utils';

const ORDER_ID = 'a1b2c3d4-1111-4222-8333-444455556666';
const CUSTOMER_ID = 'b1b2c3d4-1111-4222-8333-444455556666';
const REQUEST_KEY = 'c1b2c3d4-1111-4222-8333-444455556666';
const RETURN_ID = 'd1b2c3d4-1111-4222-8333-444455556666';
const OTHER_RETURN_ID = 'd2b2c3d4-1111-4222-8333-444455556666';
const CANCEL_ID = 'e1b2c3d4-1111-4222-8333-444455556666';
const OTHER_CANCEL_ID = 'e2b2c3d4-1111-4222-8333-444455556666';
const UPLOAD_1 = 'f1b2c3d4-1111-4222-8333-444455556661';
const UPLOAD_2 = 'f1b2c3d4-1111-4222-8333-444455556662';
const FULFILLMENT_ID = '01b2c3d4-1111-4222-8333-444455556666';
const OTHER_FULFILLMENT_ID = '02b2c3d4-1111-4222-8333-444455556666';
const ITEM_1 = '11b2c3d4-1111-4222-8333-444455556661';
const ITEM_2 = '11b2c3d4-1111-4222-8333-444455556662';
const ITEM_3 = '11b2c3d4-1111-4222-8333-444455556663';
const OWNER = { orderId: ORDER_ID, customerId: CUSTOMER_ID };

// ---- 呼び出しの入力 ----

// 1行目: 破損の2点を、写真2枚つきで色違い（白 / L）に交換したい。2行目: 不要になった1点を返金したい
const RETURN_INPUT: CustomerReturnRequestInput = {
  orderId: ORDER_ID,
  customerId: CUSTOMER_ID,
  requestKey: REQUEST_KEY,
  lines: [
    {
      fulfillmentId: FULFILLMENT_ID, orderItemId: ITEM_1, quantity: 2, reason: 'defective', customerNote: '袖に穴がありました',
      requestedResolution: 'exchange', requestedExchangeVariantId: 102,
      photos: [
        { uploadId: UPLOAD_1, contentType: 'image/jpeg', sizeBytes: 123456 },
        { uploadId: UPLOAD_2, contentType: 'image/png', sizeBytes: 4567 },
      ],
    },
    {
      fulfillmentId: FULFILLMENT_ID, orderItemId: ITEM_2, quantity: 1, reason: 'unwanted', customerNote: null,
      requestedResolution: 'refund', requestedExchangeVariantId: null, photos: [],
    },
  ],
};

const CANCEL_INPUT: CustomerCancelRequestInput = {
  orderId: ORDER_ID,
  customerId: CUSTOMER_ID,
  requestKey: REQUEST_KEY,
  lines: [{ orderItemId: ITEM_1, quantity: 1 }, { orderItemId: ITEM_2, quantity: 2 }],
  customerNote: '色違いを買い直します',
};

// TS が呼ぶ DB の関数（移行 E）と、その呼び出し
const CALLS: Array<[rpcName: string, run: (store: ReturnStore) => Promise<unknown>]> = [
  ['get_customer_return_request_materials', (store) => loadCustomerReturnRequestMaterials(store, OWNER)],
  ['customer_create_return_photo_upload', (store) => createCustomerReturnPhotoUpload(store, OWNER)],
  ['customer_request_return', (store) => requestCustomerReturn(store, RETURN_INPUT)],
  ['get_customer_order_returns', (store) => loadCustomerOrderReturns(store, OWNER)],
  ['customer_request_cancel', (store) => requestCustomerCancel(store, CANCEL_INPUT)],
];

// 答えの行が1つ要る関数（行が返らなければ、DB の誤りとして止める）
const ROW_REQUIRED_RPCS = ['customer_create_return_photo_upload', 'customer_request_return', 'customer_request_cancel'];
// 答えの jsonb が1つ要る関数（null や空なら、注文が無いのではなく、DB の誤りとして止める）
const JSON_REQUIRED_RPCS = ['get_customer_return_request_materials', 'get_customer_order_returns'];
// 読む関数は注文が無い時に null、書く関数は CustomerOrderNotFoundError
const READ_RPCS = JSON_REQUIRED_RPCS;
const WRITE_RPCS = ROW_REQUIRED_RPCS;

describe('移行 D・E・F との突き合わせ（段2の Task 1〜3 の移行がある前提。無ければこの describe だけ FAIL する）', () => {
  it('TS が呼ぶ DB の関数は、移行 E の本文にある（名前が食い違うと、呼んだ時に初めて分かる）', () => {
    const sql = migrationText('_order_return_customer_requests.sql');

    for (const [rpcName] of CALLS) {
      expect(sql).toMatch(new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+public\\.${rpcName}\\s*\\(`));
    }
  });

  it.each(CALLS)('%s に渡す引数の名前は、移行 E の関数の引数と一字も違わない（食い違うと PostgREST が関数を見つけられない）', async (rpcName, run) => {
    const { store, rpc } = storeWith({});

    await run(store).catch(() => undefined);

    expect(rpc).toHaveBeenCalledTimes(1);
    const [calledName, args] = rpc.mock.calls[0];
    expect(calledName).toBe(rpcName);
    const declared = declaredParams(migrationText('_order_return_customer_requests.sql'), rpcName);
    const passed = Object.keys(args ?? {});
    // 渡した引数が関数に無い、または、省略できない引数を渡していない
    expect(passed.filter((name) => !declared.some((param) => param.name === name))).toEqual([]);
    expect(declared.filter((param) => !param.optional && !passed.includes(param.name)).map((param) => param.name)).toEqual([]);
  });

  it('お客様の言葉がある12の記号と ORDER_NOT_FOUND は、移行 D〜F の本文にある（綴りが食い違うと、画面に出る言葉が変わる）', () => {
    const sql = ['_order_return_request_records.sql', '_order_return_customer_requests.sql', '_order_return_request_reviews.sql']
      .map(migrationText)
      .join('\n');

    for (const word of [...CUSTOMER_RETURN_ERROR_CODES, 'ORDER_NOT_FOUND']) {
      expect(sql).toContain(word);
    }
  });
});

describe('loadCustomerReturnRequestMaterials', () => {
  // get_customer_return_request_materials の答え（jsonb。共通の約束 C-2 の CustomerReturnRequestMaterials のキーを snake_case にした形）
  const MATERIALS_JSON = {
    order: { id: ORDER_ID, status: 'shipped' },
    availability: { returns: 'available', ended_on: null },
    notice_text: 'お申し込みの前に、商品の状態をご確認ください',
    shipments: [
      {
        fulfillment_id: FULFILLMENT_ID, number: 1, shipped_at: '2026-10-10T01:00:00+00:00', deadline_date: '2026-10-20', past_deadline: false,
        lines: [
          {
            order_item_id: ITEM_1, item_id: 12, item_name: 'シルクブラウス', color: '白', size: 'M',
            line_kind: 'order', quantity: 2, selectable: 2, state: 'selectable', return_ineligible: false,
          },
          {
            order_item_id: ITEM_2, item_id: 13, item_name: 'リネンパンツ', color: null, size: null,
            line_kind: 'exchange', quantity: 1, selectable: 0, state: 'requested', return_ineligible: true,
          },
        ],
      },
      {
        fulfillment_id: OTHER_FULFILLMENT_ID, number: 2, shipped_at: '2026-09-01T01:00:00+00:00', deadline_date: '2026-09-10', past_deadline: true,
        lines: [
          {
            order_item_id: ITEM_3, item_id: 14, item_name: 'ウールコート', color: '黒', size: 'L',
            line_kind: 'order', quantity: 1, selectable: 0, state: 'past_deadline', return_ineligible: false,
          },
        ],
      },
    ],
    reasons: [
      {
        reason: 'defective', resolutions: 'refund_and_exchange', out_of_stock_exchange: 'make', photo: 'required',
        photo_instructions: '傷の場所がわかる写真をお送りください', shipping_payer: 'shop',
      },
      {
        reason: 'unwanted', resolutions: 'refund_only', out_of_stock_exchange: 'decline', photo: 'none',
        photo_instructions: '', shipping_payer: 'customer',
      },
    ],
    exchange_options: [
      {
        item_id: 12,
        variants: [
          { variant_id: 101, color: '白', size: 'M', stock_quantity: 0, made_to_order_lead_days: 14 },
          { variant_id: 102, color: '白', size: 'L', stock_quantity: 3, made_to_order_lead_days: null },
        ],
      },
    ],
    fees: { customer_paid_method: 'shop_label', shop_label_fee: 800, restocking_fee_percent: 10, exchange_fee: 500, exchange_shipping_fee: 300 },
  };
  const MATERIALS = {
    order: { id: ORDER_ID, status: 'shipped' },
    availability: { returns: 'available', endedOn: null },
    noticeText: 'お申し込みの前に、商品の状態をご確認ください',
    shipments: [
      {
        fulfillmentId: FULFILLMENT_ID, number: 1, shippedAt: '2026-10-10T01:00:00+00:00', deadlineDate: '2026-10-20', pastDeadline: false,
        lines: [
          {
            orderItemId: ITEM_1, itemId: 12, itemName: 'シルクブラウス', color: '白', size: 'M',
            lineKind: 'order', quantity: 2, selectable: 2, state: 'selectable', returnIneligible: false,
          },
          {
            orderItemId: ITEM_2, itemId: 13, itemName: 'リネンパンツ', color: null, size: null,
            lineKind: 'exchange', quantity: 1, selectable: 0, state: 'requested', returnIneligible: true,
          },
        ],
      },
      {
        fulfillmentId: OTHER_FULFILLMENT_ID, number: 2, shippedAt: '2026-09-01T01:00:00+00:00', deadlineDate: '2026-09-10', pastDeadline: true,
        lines: [
          {
            orderItemId: ITEM_3, itemId: 14, itemName: 'ウールコート', color: '黒', size: 'L',
            lineKind: 'order', quantity: 1, selectable: 0, state: 'past_deadline', returnIneligible: false,
          },
        ],
      },
    ],
    reasons: [
      {
        reason: 'defective', resolutions: 'refund_and_exchange', outOfStockExchange: 'make', photo: 'required',
        photoInstructions: '傷の場所がわかる写真をお送りください', shippingPayer: 'shop',
      },
      {
        reason: 'unwanted', resolutions: 'refund_only', outOfStockExchange: 'decline', photo: 'none',
        photoInstructions: '', shippingPayer: 'customer',
      },
    ],
    exchangeOptions: [
      {
        itemId: 12,
        variants: [
          { variantId: 101, color: '白', size: 'M', stockQuantity: 0, madeToOrderLeadDays: 14 },
          { variantId: 102, color: '白', size: 'L', stockQuantity: 3, madeToOrderLeadDays: null },
        ],
      },
    ],
    fees: { customerPaidMethod: 'shop_label', shopLabelFee: 800, restockingFeePercent: 10, exchangeFee: 500, exchangeShippingFee: 300 },
  };

  it('申し込みの画面の材料を、持ち主の確かめに使う番号と一緒に DB へ渡し、キーを camelCase にして返す', async () => {
    const { store, rpc } = storeWith({ get_customer_return_request_materials: { data: MATERIALS_JSON } });

    await expect(loadCustomerReturnRequestMaterials(store, OWNER)).resolves.toEqual(MATERIALS);

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('get_customer_return_request_materials', { _order_id: ORDER_ID, _customer_id: CUSTOMER_ID });
  });

  it('jsonb が配列に包まれて来ても読める', async () => {
    const { store } = storeWith({ get_customer_return_request_materials: { data: [MATERIALS_JSON] } });

    await expect(loadCustomerReturnRequestMaterials(store, OWNER)).resolves.toEqual(MATERIALS);
  });

  it('受付の有無の4つの記号（available・ended・closed・none）と、期限の日付をそのまま写す', async () => {
    for (const returns of ['available', 'ended', 'closed', 'none'] as const) {
      const { store } = storeWith({
        get_customer_return_request_materials: {
          data: { ...MATERIALS_JSON, availability: { returns, ended_on: returns === 'ended' ? '2026-10-20' : null } },
        },
      });

      const materials = await loadCustomerReturnRequestMaterials(store, OWNER);

      expect(materials?.availability).toEqual({ returns, endedOn: returns === 'ended' ? '2026-10-20' : null });
    }
  });

  it('品の状態の5つの記号を写す。表に無い記号は unavailable（選べない側に倒す）、受付の有無の表に無い記号は none', async () => {
    const states = ['selectable', 'past_deadline', 'requested', 'sent_back', 'unavailable', 'weird'];
    const lines = states.map((state, index) => ({
      order_item_id: `11b2c3d4-1111-4222-8333-44445555666${index}`, item_id: 12, item_name: 'シルクブラウス', color: null, size: null,
      line_kind: 'order', quantity: 1, selectable: state === 'selectable' ? 1 : 0, state, return_ineligible: false,
    }));
    const { store } = storeWith({
      get_customer_return_request_materials: {
        data: {
          ...MATERIALS_JSON,
          availability: { returns: 'weird', ended_on: null },
          shipments: [{ ...MATERIALS_JSON.shipments[0], lines }],
        },
      },
    });

    const materials = await loadCustomerReturnRequestMaterials(store, OWNER);

    expect(materials?.shipments[0].lines.map((line) => line.state)).toEqual([
      'selectable', 'past_deadline', 'requested', 'sent_back', 'unavailable', 'unavailable',
    ]);
    expect(materials?.availability.returns).toBe('none');
  });

  it('注文が無い・持ち主でない（DB が ORDER_NOT_FOUND で断る）時は、投げずに null', async () => {
    const { store } = storeWith({ get_customer_return_request_materials: { error: { message: 'ORDER_NOT_FOUND', code: 'P0002' } } });

    await expect(loadCustomerReturnRequestMaterials(store, OWNER)).resolves.toBeNull();
  });
});

describe('createCustomerReturnPhotoUpload', () => {
  it('持ち主の確かめに使う番号を渡し、送り先の番号と置き場の場所を返す', async () => {
    const { store, rpc } = storeWith({
      customer_create_return_photo_upload: { data: [{ upload_id: UPLOAD_1, storage_path: `requests/${ORDER_ID}/${UPLOAD_1}` }] },
    });

    await expect(createCustomerReturnPhotoUpload(store, OWNER)).resolves.toEqual({
      uploadId: UPLOAD_1,
      storagePath: `requests/${ORDER_ID}/${UPLOAD_1}`,
    });

    expect(rpc).toHaveBeenCalledWith('customer_create_return_photo_upload', { _order_id: ORDER_ID, _customer_id: CUSTOMER_ID });
  });

  it.each(['RETURN_REQUESTS_CLOSED', 'RETURN_NOT_ELIGIBLE', 'RETURN_PHOTO_INVALID'] as const)('DB が %s で断れば、同じ綴りの記号', async (word) => {
    await expectRefusal('customer_create_return_photo_upload', word, word, (store) => createCustomerReturnPhotoUpload(store, OWNER));
  });
});

describe('requestCustomerReturn', () => {
  it('DB の関数の引数名のとおりに渡す。写真の行は upload_id・content_type・size_bytes。ご希望の色・サイズが無い行は null のまま渡す', async () => {
    const { store, rpc } = storeWith({
      customer_request_return: { data: [{ return_id: RETURN_ID, number: 2, status: 'requested', replayed: false }] },
    });

    await requestCustomerReturn(store, RETURN_INPUT);

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('customer_request_return', {
      _order_id: ORDER_ID,
      _customer_id: CUSTOMER_ID,
      _request_key: REQUEST_KEY,
      _lines: [
        {
          fulfillment_id: FULFILLMENT_ID, order_item_id: ITEM_1, quantity: 2, reason: 'defective', customer_note: '袖に穴がありました',
          requested_resolution: 'exchange', requested_exchange_variant_id: 102,
          photos: [
            { upload_id: UPLOAD_1, content_type: 'image/jpeg', size_bytes: 123456 },
            { upload_id: UPLOAD_2, content_type: 'image/png', size_bytes: 4567 },
          ],
        },
        {
          fulfillment_id: FULFILLMENT_ID, order_item_id: ITEM_2, quantity: 1, reason: 'unwanted', customer_note: null,
          requested_resolution: 'refund', requested_exchange_variant_id: null, photos: [],
        },
      ],
    });
  });

  it('1行の答えを窓口の形に直す（返品の番号・番号の数字・状態・送り直しか）。行が1つのオブジェクトで来ても読める', async () => {
    const array = storeWith({ customer_request_return: { data: [{ return_id: RETURN_ID, number: 2, status: 'requested', replayed: false }] } });
    await expect(requestCustomerReturn(array.store, RETURN_INPUT)).resolves.toEqual({
      returnId: RETURN_ID, number: 2, status: 'requested', replayed: false,
    });

    const object = storeWith({ customer_request_return: { data: { return_id: RETURN_ID, number: 2, status: 'requested', replayed: false } } });
    await expect(requestCustomerReturn(object.store, RETURN_INPUT)).resolves.toEqual({
      returnId: RETURN_ID, number: 2, status: 'requested', replayed: false,
    });
  });

  it('同じ二重防止の番号の送り直しは、前の返品を返す（replayed が true。Review Focus 1）。返品が先へ進んでいても、状態は requested に固定する', async () => {
    const { store } = storeWith({ customer_request_return: { data: [{ return_id: RETURN_ID, number: 2, status: 'open', replayed: true }] } });

    await expect(requestCustomerReturn(store, RETURN_INPUT)).resolves.toEqual({
      returnId: RETURN_ID, number: 2, status: 'requested', replayed: true,
    });
  });

  it.each([
    'RETURN_NOT_ELIGIBLE',
    'RETURN_REQUESTS_CLOSED',
    'RETURN_PHOTO_INVALID',
    'RETURN_CUSTOMER_NOTE_REQUIRED',
    'RETURN_QUANTITY_EXCEEDS',
    'RETURN_REQUEST_MISMATCH',
    'RETURN_EXCHANGE_VARIANT_INVALID',
    'RETURN_ARGUMENT_INVALID',
    'ORDER_NOT_RETURNABLE',
  ] as const)('DB が %s で断れば、同じ綴りの記号', async (word) => {
    await expectRefusal('customer_request_return', word, word, (store) => requestCustomerReturn(store, RETURN_INPUT));
  });
});

describe('loadCustomerOrderReturns', () => {
  // get_customer_order_returns の答え（jsonb。共通の約束 C-2 の CustomerOrderReturns のキーを snake_case にした形。label は無い）
  const RETURNS_JSON = {
    returns: [
      {
        id: RETURN_ID, number: 2, status: 'open', customer_status: 'awaiting_fee',
        return_method: 'shop_label', return_shipping_payer: 'customer', return_shipping_fee: 800,
        return_address: { name: 'Le Fil des Heures 返品係', postal_code: '150-0001', address: '東京都渋谷区神宮前1-2-3', phone: '03-1234-5678' },
        requested_at: '2026-10-12T01:00:00+00:00', closed_at: null,
        lines: [
          {
            item_name: 'シルクブラウス', color: '白', size: 'M', quantity: 2,
            requested_resolution: 'exchange', requested_exchange: { color: '白', size: 'L' },
            resolution: 'exchange', exchange: { color: '白', size: 'L' },
          },
          {
            item_name: 'リネンパンツ', color: null, size: null, quantity: 1,
            requested_resolution: 'refund', requested_exchange: null, resolution: 'refund', exchange: null,
          },
        ],
        refund_amount: 5400,
        sent_back: [
          { item_name: 'レザーベルト', color: '茶', size: null, quantity: 1, message: '着用の跡があります', carrier: 'yamato', tracking_number: 'AB-9999' },
        ],
        decline_message: null,
        exchange_shipping: 'pending',
      },
      {
        id: OTHER_RETURN_ID, number: 1, status: 'declined', customer_status: 'declined',
        return_method: 'not_required', return_shipping_payer: 'shop', return_shipping_fee: 0,
        return_address: null,
        requested_at: '2026-10-11T01:00:00+00:00', closed_at: null,
        lines: [
          {
            item_name: 'ウールコート', color: '黒', size: 'L', quantity: 1,
            requested_resolution: 'refund', requested_exchange: null, resolution: 'refund', exchange: null,
          },
        ],
        refund_amount: null,
        sent_back: [],
        decline_message: '受付の期限を過ぎているため、今回のお申し込みはお受けできませんでした。',
        exchange_shipping: 'none',
      },
    ],
    cancel_requests: [
      {
        id: CANCEL_ID, status: 'requested', requested_at: '2026-10-12T02:00:00+00:00',
        lines: [{ item_name: 'シルクブラウス', color: '白', size: 'M', quantity: 1 }], decline_message: null,
      },
      {
        id: OTHER_CANCEL_ID, status: 'declined', requested_at: '2026-10-10T02:00:00+00:00',
        lines: [{ item_name: 'リネンパンツ', color: null, size: null, quantity: 2 }], decline_message: 'すでに発送の準備を進めています。',
      },
    ],
    availability: { returns: 'ended', ended_on: '2026-10-20', cancel: false },
  };
  const RETURNS = {
    returns: [
      {
        id: RETURN_ID, number: 2, label: 'ORD-A1B2C3D4-R2', status: 'open', customerStatus: 'awaiting_fee',
        returnMethod: 'shop_label', returnShippingPayer: 'customer', returnShippingFee: 800,
        returnAddress: { name: 'Le Fil des Heures 返品係', postalCode: '150-0001', address: '東京都渋谷区神宮前1-2-3', phone: '03-1234-5678' },
        requestedAt: '2026-10-12T01:00:00+00:00', closedAt: null,
        lines: [
          {
            itemName: 'シルクブラウス', color: '白', size: 'M', quantity: 2,
            requestedResolution: 'exchange', requestedExchange: { color: '白', size: 'L' },
            resolution: 'exchange', exchange: { color: '白', size: 'L' },
          },
          {
            itemName: 'リネンパンツ', color: null, size: null, quantity: 1,
            requestedResolution: 'refund', requestedExchange: null, resolution: 'refund', exchange: null,
          },
        ],
        refundAmount: 5400,
        sentBack: [
          { itemName: 'レザーベルト', color: '茶', size: null, quantity: 1, message: '着用の跡があります', carrier: 'yamato', trackingNumber: 'AB-9999' },
        ],
        declineMessage: null,
        exchangeShipping: 'pending',
      },
      {
        id: OTHER_RETURN_ID, number: 1, label: 'ORD-A1B2C3D4-R1', status: 'declined', customerStatus: 'declined',
        returnMethod: 'not_required', returnShippingPayer: 'shop', returnShippingFee: 0,
        returnAddress: null,
        requestedAt: '2026-10-11T01:00:00+00:00', closedAt: null,
        lines: [
          {
            itemName: 'ウールコート', color: '黒', size: 'L', quantity: 1,
            requestedResolution: 'refund', requestedExchange: null, resolution: 'refund', exchange: null,
          },
        ],
        refundAmount: null,
        sentBack: [],
        declineMessage: '受付の期限を過ぎているため、今回のお申し込みはお受けできませんでした。',
        exchangeShipping: 'none',
      },
    ],
    cancelRequests: [
      {
        id: CANCEL_ID, status: 'requested', requestedAt: '2026-10-12T02:00:00+00:00',
        lines: [{ itemName: 'シルクブラウス', color: '白', size: 'M', quantity: 1 }], declineMessage: null,
      },
      {
        id: OTHER_CANCEL_ID, status: 'declined', requestedAt: '2026-10-10T02:00:00+00:00',
        lines: [{ itemName: 'リネンパンツ', color: null, size: null, quantity: 2 }], declineMessage: 'すでに発送の準備を進めています。',
      },
    ],
    availability: { returns: 'ended', endedOn: '2026-10-20', cancel: false },
  };

  it('注文の画面の返品の欄を、キーを camelCase にして返す。番号の文字（label）は注文の番号と返品の番号から付ける', async () => {
    const { store, rpc } = storeWith({ get_customer_order_returns: { data: RETURNS_JSON } });

    await expect(loadCustomerOrderReturns(store, OWNER)).resolves.toEqual(RETURNS);

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('get_customer_order_returns', { _order_id: ORDER_ID, _customer_id: CUSTOMER_ID });
  });

  it('お客様に出さない物（店のメモ・お断りの理由の記号・した人のメール・返金の失敗の中身）は、DB が返しても写さない（P19）', async () => {
    const leaky = {
      ...RETURNS_JSON,
      returns: RETURNS_JSON.returns.map((row) => ({
        ...row,
        shop_note: '内部メモ: 常連のお客様',
        decline_reason: 'final_sale',
        created_by_email: 'staff@example.com',
        approved_by_email: 'owner@example.com',
        refund_error: 'card_declined',
        lines: row.lines.map((line) => ({ ...line, reason_note: '内部の理由メモ' })),
      })),
      cancel_requests: RETURNS_JSON.cancel_requests.map((row) => ({ ...row, decline_reason: 'other', declined_by_email: 'staff@example.com' })),
    };
    const { store } = storeWith({ get_customer_order_returns: { data: leaky } });

    const result = await loadCustomerOrderReturns(store, OWNER);

    expect(result).toEqual(RETURNS);
    const text = JSON.stringify(result);
    for (const secret of ['内部メモ', '内部の理由メモ', 'final_sale', 'staff@example.com', 'owner@example.com', 'card_declined']) {
      expect(text).not.toContain(secret);
    }
  });

  it('お客様の状態の8つの記号（customer_status）を写す', async () => {
    const statuses = ['requested', 'accepted', 'partially_received', 'inspecting', 'awaiting_fee', 'refund_preparing', 'returned', 'declined'];
    for (const customerStatus of statuses) {
      const { store } = storeWith({
        get_customer_order_returns: { data: { ...RETURNS_JSON, returns: [{ ...RETURNS_JSON.returns[0], customer_status: customerStatus }] } },
      });

      const result = await loadCustomerOrderReturns(store, OWNER);

      expect(result?.returns[0].customerStatus).toBe(customerStatus);
    }
  });

  it('返品もキャンセルの申し込みも無ければ空の配列。受付の有無の表に無い記号は none、交換の品の発送の表に無い記号は none', async () => {
    const empty = storeWith({
      get_customer_order_returns: { data: { returns: null, cancel_requests: null, availability: { returns: 'weird', ended_on: null, cancel: true } } },
    });
    await expect(loadCustomerOrderReturns(empty.store, OWNER)).resolves.toEqual({
      returns: [], cancelRequests: [], availability: { returns: 'none', endedOn: null, cancel: true },
    });

    const weird = storeWith({
      get_customer_order_returns: { data: { ...RETURNS_JSON, returns: [{ ...RETURNS_JSON.returns[0], exchange_shipping: 'weird' }] } },
    });
    const result = await loadCustomerOrderReturns(weird.store, OWNER);
    expect(result?.returns[0].exchangeShipping).toBe('none');
  });

  it('お客様の状態・返品の状態・キャンセルの申し込みの状態が表に無い記号なら、黙って別の状態にせず、思いがけない失敗（RefundStoreError）で止める', async () => {
    const brokenRows = [
      { ...RETURNS_JSON, returns: [{ ...RETURNS_JSON.returns[0], customer_status: 'weird' }] },
      { ...RETURNS_JSON, returns: [{ ...RETURNS_JSON.returns[0], status: 'cancelled' }] },
      { ...RETURNS_JSON, returns: [{ ...RETURNS_JSON.returns[0], lines: [{ ...RETURNS_JSON.returns[0].lines[0], resolution: 'weird' }] }] },
      { ...RETURNS_JSON, cancel_requests: [{ ...RETURNS_JSON.cancel_requests[0], status: 'weird' }] },
    ];
    for (const data of brokenRows) {
      const { store } = storeWith({ get_customer_order_returns: { data } });

      const error = await loadCustomerOrderReturns(store, OWNER).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(RefundStoreError);
      expect(error).toMatchObject({ operation: 'get_customer_order_returns' });
    }
  });

  it('注文が無い・持ち主でない（DB が ORDER_NOT_FOUND で断る）時は、投げずに null', async () => {
    const { store } = storeWith({ get_customer_order_returns: { error: { message: 'ORDER_NOT_FOUND', code: 'P0002' } } });

    await expect(loadCustomerOrderReturns(store, OWNER)).resolves.toBeNull();
  });

  // E-5（注文の状況の頁）の公開・個人情報の読み出しも、この変換を共有する
  describe('共有の変換（parseCustomerOrderReturns・parsePublicCustomerOrderReturns）', () => {
    const without = (object: Record<string, unknown>, keys: string[]) =>
      Object.fromEntries(Object.entries(object).filter(([key]) => !keys.includes(key)));
    // 公開の答え（DB が返送先と送り返しの業者・伝票番号のキーを作らない形）
    const PUBLIC_JSON = {
      ...RETURNS_JSON,
      returns: RETURNS_JSON.returns.map((row) => ({
        ...without(row, ['return_address']),
        sent_back: row.sent_back.map((item) => without(item, ['carrier', 'tracking_number'])),
      })),
    };
    const PUBLIC_RETURNS = {
      ...RETURNS,
      returns: RETURNS.returns.map((row) => ({
        ...without(row, ['returnAddress']),
        sentBack: row.sentBack.map((item) => without(item, ['carrier', 'trackingNumber'])),
      })),
    };

    it('parseCustomerOrderReturns は loadCustomerOrderReturns と同じ答えを返す', () => {
      expect(parseCustomerOrderReturns(RETURNS_JSON, ORDER_ID)).toEqual(RETURNS);
    });

    it('オブジェクトでない値は null。配列に包まれた1つは今までどおり読む', () => {
      for (const value of [null, undefined, 'text', 5, true, []]) {
        expect(parseCustomerOrderReturns(value, ORDER_ID)).toBeNull();
        expect(parsePublicCustomerOrderReturns(value, ORDER_ID)).toBeNull();
      }
      expect(parseCustomerOrderReturns([RETURNS_JSON], ORDER_ID)).toEqual(RETURNS);
      expect(parsePublicCustomerOrderReturns([PUBLIC_JSON], ORDER_ID)).toEqual(PUBLIC_RETURNS);
    });

    it('会員の答えのキーの並びを変えない（JSON の文字列で比べる）', async () => {
      const { store } = storeWith({ get_customer_order_returns: { data: RETURNS_JSON } });

      const result = await loadCustomerOrderReturns(store, OWNER);

      expect(Object.keys(result ?? {})).toEqual(['returns', 'cancelRequests', 'availability']);
      expect(Object.keys(result?.returns[0] ?? {})).toEqual([
        'id', 'number', 'label', 'status', 'customerStatus', 'returnMethod', 'returnShippingPayer', 'returnShippingFee',
        'returnAddress', 'requestedAt', 'closedAt', 'lines', 'refundAmount', 'sentBack', 'declineMessage', 'exchangeShipping',
      ]);
      expect(Object.keys(result?.returns[0].sentBack[0] ?? {})).toEqual(['itemName', 'color', 'size', 'quantity', 'message', 'carrier', 'trackingNumber']);
      expect(JSON.stringify(result)).toBe(JSON.stringify(RETURNS));
    });

    it('公開の変換は返送先と送り返しの業者・伝票番号のキーを持たない（null で生やさない）', () => {
      const result = parsePublicCustomerOrderReturns(PUBLIC_JSON, ORDER_ID);

      expect(result).toEqual(PUBLIC_RETURNS);
      for (const entry of result?.returns ?? []) {
        expect(entry).not.toHaveProperty('returnAddress');
        for (const sent of entry.sentBack) {
          expect(sent).not.toHaveProperty('carrier');
          expect(sent).not.toHaveProperty('trackingNumber');
        }
      }
      const text = JSON.stringify(result);
      for (const key of ['returnAddress', 'carrier', 'trackingNumber']) {
        expect(text).not.toContain(`"${key}"`);
      }
    });

    it('DB が非公開のキーを返してしまっても、公開の変換は写さない', () => {
      const result = parsePublicCustomerOrderReturns(RETURNS_JSON, ORDER_ID);

      expect(result).toEqual(PUBLIC_RETURNS);
      const text = JSON.stringify(result);
      for (const secret of ['AB-9999', 'yamato', '150-0001', '03-1234-5678', 'Le Fil des Heures 返品係']) {
        expect(text).not.toContain(secret);
      }
    });

    it('公開の変換も、お客様の状態などが表に無い記号なら黙って別の状態にせず RefundStoreError（今までの変換と同じ許容）', () => {
      const broken = { ...PUBLIC_JSON, returns: [{ ...PUBLIC_JSON.returns[0], customer_status: 'weird' }] };

      expect(() => parsePublicCustomerOrderReturns(broken, ORDER_ID)).toThrow(RefundStoreError);
      expect(() => parseCustomerOrderReturns({ ...RETURNS_JSON, returns: [{ ...RETURNS_JSON.returns[0], customer_status: 'weird' }] }, ORDER_ID)).toThrow(RefundStoreError);
    });
  });
});

describe('requestCustomerCancel', () => {
  it('DB の関数の引数名のとおりに渡し、1行の答えを窓口の形に直す', async () => {
    const { store, rpc } = storeWith({
      customer_request_cancel: { data: [{ cancel_request_id: CANCEL_ID, status: 'requested', replayed: false }] },
    });

    await expect(requestCustomerCancel(store, CANCEL_INPUT)).resolves.toEqual({
      cancelRequestId: CANCEL_ID, status: 'requested', replayed: false,
    });

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('customer_request_cancel', {
      _order_id: ORDER_ID,
      _customer_id: CUSTOMER_ID,
      _request_key: REQUEST_KEY,
      _lines: [{ order_item_id: ITEM_1, quantity: 1 }, { order_item_id: ITEM_2, quantity: 2 }],
      _customer_note: '色違いを買い直します',
    });
  });

  it('ご連絡事項が無ければ null のまま渡す。同じ番号の送り直しは前の申し込みを返す（replayed が true）', async () => {
    const { store, rpc } = storeWith({
      customer_request_cancel: { data: { cancel_request_id: CANCEL_ID, status: 'closed', replayed: true } },
    });

    await expect(requestCustomerCancel(store, { ...CANCEL_INPUT, customerNote: null })).resolves.toEqual({
      cancelRequestId: CANCEL_ID, status: 'requested', replayed: true,
    });
    expect(rpc).toHaveBeenCalledWith('customer_request_cancel', expect.objectContaining({ _customer_note: null }));
  });

  it.each([
    'RETURN_REQUESTS_CLOSED',
    'CANCEL_REQUEST_NOT_ELIGIBLE',
    'CANCEL_REQUEST_EXISTS',
    'CANCEL_REQUEST_QUANTITY_EXCEEDS',
    'RETURN_REQUEST_MISMATCH',
    'RETURN_ARGUMENT_INVALID',
  ] as const)('DB が %s で断れば、同じ綴りの記号', async (word) => {
    await expectRefusal('customer_request_cancel', word, word, (store) => requestCustomerCancel(store, CANCEL_INPUT));
  });
});

describe.each(CALLS)('%s の失敗', (rpcName, run) => {
  const dbError = { message: '宛先・氏名を含む DB の文', code: '08006' };

  it('記号の無い DB の失敗は RefundStoreError（DB の文はメッセージに入れず、cause にだけ残す）。注文が無い時の null や CustomerOrderNotFoundError にしない', async () => {
    const { store } = storeWith({ [rpcName]: { error: dbError } });

    const error = (await run(store).catch((caught: unknown) => caught)) as RefundStoreError;

    expect(error).toBeInstanceOf(RefundStoreError);
    expect(error).not.toBeInstanceOf(ReturnStoreError);
    expect(error).not.toBeInstanceOf(CustomerOrderNotFoundError);
    expect(error.message).toBe(`refund store failed: ${rpcName}`);
    expect(error.operation).toBe(rpcName);
    expect(error.code).toBe('08006');
    expect(error.cause).toEqual(dbError);
  });

  it('DB が返品の言葉で断れば、同じ綴りの記号を持つ ReturnStoreError（CustomerOrderNotFoundError にしない）', async () => {
    const { store } = storeWith({ [rpcName]: { error: { message: 'RETURN_STATE_CONFLICT', code: 'P0001' } } });

    const error = await run(store).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ReturnStoreError);
    expect(error).not.toBeInstanceOf(CustomerOrderNotFoundError);
    expect(error).toMatchObject({ code: 'RETURN_STATE_CONFLICT' });
  });
});

describe('注文が無い・持ち主でない時（DB が ORDER_NOT_FOUND で断る）', () => {
  const notFound = { message: 'ORDER_NOT_FOUND', code: 'P0002' };

  it.each(CALLS.filter(([rpcName]) => READ_RPCS.includes(rpcName)))('読む関数 %s は null を返す（投げない）', async (rpcName, run) => {
    const { store } = storeWith({ [rpcName]: { error: notFound } });

    await expect(run(store)).resolves.toBeNull();
  });

  it.each(CALLS.filter(([rpcName]) => WRITE_RPCS.includes(rpcName)))(
    '書く関数 %s は CustomerOrderNotFoundError を投げる（窓口が 404 にする。ReturnStoreError ではない）',
    async (rpcName, run) => {
      const { store } = storeWith({ [rpcName]: { error: notFound } });

      const error = await run(store).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(CustomerOrderNotFoundError);
      expect(error).not.toBeInstanceOf(ReturnStoreError);
      expect(error).not.toBeInstanceOf(RefundStoreError);
    },
  );

  it('CustomerOrderNotFoundError のメッセージに、注文の番号・お客様の番号を入れない', async () => {
    const { store } = storeWith({ customer_request_cancel: { error: notFound } });

    const error = (await requestCustomerCancel(store, CANCEL_INPUT).catch((caught: unknown) => caught)) as Error;

    expect(error.name).toBe('CustomerOrderNotFoundError');
    expect(error.message).not.toContain(ORDER_ID);
    expect(error.message).not.toContain(CUSTOMER_ID);
  });
});

describe('答えが足りない時（想定外の失敗）', () => {
  it.each(CALLS.filter(([rpcName]) => ROW_REQUIRED_RPCS.includes(rpcName)))('%s は行が返らなければ RefundStoreError', async (rpcName, run) => {
    const { store } = storeWith({ [rpcName]: { data: [] } });

    const error = await run(store).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(RefundStoreError);
    expect(error).toMatchObject({ operation: rpcName });
  });

  it.each(CALLS.filter(([rpcName]) => JSON_REQUIRED_RPCS.includes(rpcName)))(
    '%s は答えが null や空なら、注文が無い扱い（null）にせず RefundStoreError',
    async (rpcName, run) => {
      for (const data of [null, [], 'text']) {
        const { store } = storeWith({ [rpcName]: { data } });

        const error = await run(store).catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(RefundStoreError);
        expect(error).toMatchObject({ operation: rpcName });
      }
    },
  );
});

describe('このタスクの2つのファイルの書き方', () => {
  it.each(['customer-return-store.ts', 'cancel-request-store.ts'])(
    "%s は import 'server-only' を書かない（単体テストが直接 import するため。return-store.ts と同じ）",
    (name) => {
      const source = fs.readFileSync(path.join(process.cwd(), 'src/lib/orders/returns', name), 'utf8');

      expect(source).not.toMatch(/import\s+['"]server-only['"]/);
    },
  );
});
