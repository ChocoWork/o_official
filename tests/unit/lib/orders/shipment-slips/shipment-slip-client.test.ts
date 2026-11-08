import * as client from '@/lib/orders/shipment-slips/shipment-slip-client';
import { SHIPMENT_SLIP_ERRORS } from '@/lib/orders/shipment-slips/shipment-slip-types';
import { confirmedDetail, draftDetail, ITEM_ID, packingRow, SLIP_ID, slipListRow } from './shipment-slip-fixtures';

/**
 * ブラウザから発送票の窓口を呼ぶ唯一のモジュール（G-3 Task 4）。読取は SlipReadResult、書込みは DeliveryCallResult
 * （ok・refused・blocked・unknown）で返す。clientFetch だけを差し替える。
 */
const mockClientFetch = jest.fn();
jest.mock('@/lib/client-fetch', () => ({ clientFetch: (...args: unknown[]) => mockClientFetch(...args) }));

function respond(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

const KEY = '66666666-6666-4666-8666-666666666661';
const LINES = [{ orderItemId: ITEM_ID, quantity: 2 }];
const SAVED = { id: SLIP_ID, number: 'SL-20261025-0001', version: 2, replayed: false };

beforeEach(() => {
  mockClientFetch.mockReset();
});

describe('モジュールの形', () => {
  test('FREQ-531-AC-01: 窓口の呼び出しは、Task 7までの読取3つと書込み6つ（下書き・破棄・確定・伝票番号・配達済み・取消）。出荷日の訂正は後の Task が足す', () => {
    expect(Object.keys(client).sort()).toEqual(['fetchPacking', 'fetchShipmentSlip', 'fetchShipmentSlips', 'submitSlipCancel', 'submitSlipConfirm', 'submitSlipDateCorrection', 'submitSlipDelivered',
      'submitSlipDiscard', 'submitSlipDraft', 'submitSlipTrackingEdit']);
  });
});

describe('fetchPacking', () => {
  test('FREQ-531-AC-01: 荷作り表の窓口を no-store で1回読み、行と全件数を返す。slipId があれば先頭の指定に足す', async () => {
    mockClientFetch.mockResolvedValue(respond(200, { rows: [packingRow()], total: 7, page: 1, limit: 50, canManage: true }));
    await expect(client.fetchPacking({ limit: 50, page: 1 })).resolves.toEqual({ kind: 'ok', data: { rows: [packingRow()], total: 7, canManage: true } });
    expect(mockClientFetch).toHaveBeenCalledWith('/api/admin/packing?limit=50&page=1', { cache: 'no-store' });
    await client.fetchPacking({ slipId: SLIP_ID, limit: 100, page: 2 });
    expect(mockClientFetch).toHaveBeenLastCalledWith(`/api/admin/packing?slipId=${SLIP_ID}&limit=100&page=2`, { cache: 'no-store' });
    await client.fetchPacking({ slipId: null, limit: 10, page: 3 });
    expect(mockClientFetch).toHaveBeenLastCalledWith('/api/admin/packing?limit=10&page=3', { cache: 'no-store' });
  });

  test('FREQ-540-AC-10: 応答の canManage（操作の権限があるか）をそのまま返す。false でも荷作り表は読める', async () => {
    mockClientFetch.mockResolvedValue(respond(200, { rows: [packingRow()], total: 1, page: 1, limit: 50, canManage: false }));
    await expect(client.fetchPacking({ limit: 50, page: 1 })).resolves.toEqual({ kind: 'ok', data: { rows: [packingRow()], total: 1, canManage: false } });
  });

  test.each([['無い', undefined], ['文字', 'true'], ['数', 1], ['null', null]])(
    'FREQ-540-AC-10: canManage が真偽でない（%s）応答は読み違いとして失敗の文', async (_name, canManage) => {
      mockClientFetch.mockResolvedValue(respond(200, { rows: [packingRow()], total: 1, page: 1, limit: 50, canManage }));
      expect(await client.fetchPacking({ limit: 50, page: 1 })).toEqual({ kind: 'error', message: '荷作り表を読み込めませんでした。', denied: false });
    },
  );

  test.each(['abc', '../orders', `${SLIP_ID}/x`, `${SLIP_ID}&limit=1`])(
    'FREQ-531-AC-04: slipId（%s）が票の id の形でなければ窓口へ送らず、「発送票が見つかりません。」', async (slipId) => {
      expect(await client.fetchPacking({ slipId, limit: 50, page: 1 })).toEqual({ kind: 'error', message: '発送票が見つかりません。', denied: false });
      expect(mockClientFetch).not.toHaveBeenCalled();
    },
  );

  test.each([
    [401, { error: 'Unauthorized' }, 'ログインし直してください。', true],
    [403, { error: 'Forbidden', permission: 'admin.shipping.read' }, '荷作り表を見る権限がありません。', true],
    [403, { error: 'Forbidden', reason: 'MFA required' }, '2要素認証が必要です', true],
    [500, { error: '発送の記録に失敗しました' }, '荷作り表を読み込めませんでした。', false],
    [409, { code: 'GROUP_G_SLIP_NOT_DRAFT', error: 'PRIVATE-MARKER' }, '荷作り表を読み込めませんでした。', false],
  ])('FREQ-531-AC-04: 失敗 %s は文にして返し、権限・認証の失敗（401・403）だけ denied', async (status, body, message, denied) => {
    mockClientFetch.mockResolvedValue(respond(status, body));
    const result = await client.fetchPacking({ limit: 50, page: 1 });
    expect(result).toEqual({ kind: 'error', message, denied });
  });

  test.each([
    ['形が崩れた行', { rows: [{ orderId: 'x' }], total: 1, canManage: true }],
    ['全件があるのに空の頁', { rows: [], total: 5, canManage: true }],
    ['total が行数より少ない', { rows: [packingRow(), packingRow({ orderItemId: '22222222-2222-4222-8222-222222222299' })], total: 1, canManage: true }],
    ['rows が配列でない', { rows: 'x', total: 1, canManage: true }],
    ['total が文字', { rows: [], total: '0', canManage: true }],
    ['null', null],
  ])('FREQ-531-AC-04: 成功の応答が崩れている（%s）と「荷作り表を読み込めませんでした。」', async (_name, body) => {
    mockClientFetch.mockResolvedValue(respond(200, body));
    expect(await client.fetchPacking({ limit: 50, page: 1 })).toEqual({ kind: 'error', message: '荷作り表を読み込めませんでした。', denied: false });
  });

  test('FREQ-531-AC-04: 通信が切れても、本文が JSON でなくても、例外にせず失敗の文を返す', async () => {
    mockClientFetch.mockRejectedValue(new Error('PRIVATE-MARKER'));
    expect(await client.fetchPacking({ limit: 50, page: 1 })).toEqual({ kind: 'error', message: '荷作り表を読み込めませんでした。', denied: false });
    mockClientFetch.mockResolvedValue({ ok: true, status: 200, json: async () => { throw new Error('PRIVATE-MARKER'); } } as unknown as Response);
    expect(await client.fetchPacking({ limit: 50, page: 1 })).toEqual({ kind: 'error', message: '荷作り表を読み込めませんでした。', denied: false });
  });
});

describe('fetchShipmentSlips', () => {
  test('FREQ-531-AC-01: 票の一覧の窓口を stage・件数・頁つきで読み、行と全件数を返す。stage が無ければ全段階', async () => {
    mockClientFetch.mockResolvedValue(respond(200, { rows: [slipListRow()], total: 1, page: 1, limit: 20 }));
    await expect(client.fetchShipmentSlips({ stage: 'draft', limit: 20, page: 1 })).resolves.toEqual({ kind: 'ok', data: { rows: [slipListRow()], total: 1 } });
    expect(mockClientFetch).toHaveBeenCalledWith('/api/admin/shipment-slips?stage=draft&limit=20&page=1', { cache: 'no-store' });
    await client.fetchShipmentSlips({ limit: 5, page: 2 });
    expect(mockClientFetch).toHaveBeenLastCalledWith('/api/admin/shipment-slips?limit=5&page=2', { cache: 'no-store' });
  });

  test.each([
    [403, { error: 'Forbidden' }, '発送票を見る権限がありません。', true],
    [500, { error: 'x' }, '発送票の一覧を読み込めませんでした。', false],
  ])('FREQ-531-AC-04: 失敗 %s は節ごとの文', async (status, body, message, denied) => {
    mockClientFetch.mockResolvedValue(respond(status, body));
    expect(await client.fetchShipmentSlips({ stage: 'confirmed', limit: 20, page: 1 })).toEqual({ kind: 'error', message, denied });
  });

  test('FREQ-531-AC-04: 崩れた行・通信の切れは失敗の文', async () => {
    mockClientFetch.mockResolvedValue(respond(200, { rows: [{ id: 'x' }], total: 1 }));
    expect(await client.fetchShipmentSlips({ stage: 'draft', limit: 20, page: 1 })).toEqual({ kind: 'error', message: '発送票の一覧を読み込めませんでした。', denied: false });
    mockClientFetch.mockRejectedValue(new Error('PRIVATE-MARKER'));
    expect(await client.fetchShipmentSlips({ stage: 'draft', limit: 20, page: 1 })).toEqual({ kind: 'error', message: '発送票の一覧を読み込めませんでした。', denied: false });
  });
});

describe('fetchShipmentSlip', () => {
  test.each([undefined, 'true', null])('FREQ-540-AC-10: 訂正権限%jが真偽でなければ読み違い', async (canCorrectDate) => {
    mockClientFetch.mockResolvedValue(respond(200, { slip: confirmedDetail(), canCorrectDate }));
    expect(await client.fetchShipmentSlip(SLIP_ID)).toEqual({ kind: 'error', message: '発送票を読み込めませんでした。', denied: false });
  });
  test('FREQ-531-AC-01: 票1件の窓口を読み、応答 { slip } の詳細を検査して返す（下書きも確定済みも）', async () => {
    mockClientFetch.mockResolvedValue(respond(200, { slip: draftDetail(), canCorrectDate: false }));
    await expect(client.fetchShipmentSlip(SLIP_ID)).resolves.toEqual({ kind: 'ok', data: { ...draftDetail(), canCorrectDate: false } });
    expect(mockClientFetch).toHaveBeenCalledWith(`/api/admin/shipment-slips/${SLIP_ID}`, { cache: 'no-store' });
    mockClientFetch.mockResolvedValue(respond(200, { slip: confirmedDetail(), canCorrectDate: true }));
    await expect(client.fetchShipmentSlip(SLIP_ID)).resolves.toEqual({ kind: 'ok', data: { ...confirmedDetail(), canCorrectDate: true } });
  });

  test.each([
    [404, { code: 'GROUP_G_SLIP_NOT_FOUND', error: '発送票が見つかりません。' }, '発送票が見つかりません。', false],
    [403, { error: 'Forbidden' }, '発送票を見る権限がありません。', true],
    [401, { error: 'Unauthorized' }, 'ログインし直してください。', true],
    [400, { error: 'Invalid request' }, '発送票を読み込めませんでした。', false],
    [500, { error: 'x' }, '発送票を読み込めませんでした。', false],
  ])('FREQ-531-AC-04: 失敗 %s は固定の文', async (status, body, message, denied) => {
    mockClientFetch.mockResolvedValue(respond(status, body));
    expect(await client.fetchShipmentSlip(SLIP_ID)).toEqual({ kind: 'error', message, denied });
  });

  test.each([['slip が無い', {}], ['slip が崩れている', { slip: { id: 'x' } }], ['null', null], ['文字', 'x']])(
    'FREQ-531-AC-04: 成功の応答が崩れている（%s）と失敗の文', async (_name, body) => {
      mockClientFetch.mockResolvedValue(respond(200, body));
      expect(await client.fetchShipmentSlip(SLIP_ID)).toEqual({ kind: 'error', message: '発送票を読み込めませんでした。', denied: false });
    },
  );

  test('FREQ-531-AC-04: 通信が切れたら失敗の文', async () => {
    mockClientFetch.mockRejectedValue(new Error('PRIVATE-MARKER'));
    expect(await client.fetchShipmentSlip(SLIP_ID)).toEqual({ kind: 'error', message: '発送票を読み込めませんでした。', denied: false });
  });

  test.each(['abc', '../orders', `${SLIP_ID}/discard`, '', '%2e%2e'])(
    'FREQ-531-AC-04: 票の id（%s）が uuid の形でなければ窓口へ送らず、「発送票が見つかりません。」', async (id) => {
      expect(await client.fetchShipmentSlip(id)).toEqual({ kind: 'error', message: '発送票が見つかりません。', denied: false });
      expect(mockClientFetch).not.toHaveBeenCalled();
    },
  );
});

describe('submitSlipDateCorrection', () => {
  const body = { expectedVersion: 2, shipmentDate: '2026-10-24', reason: '記録の訂正', requestKey: KEY };
  const corrected = { id: SLIP_ID, version: 3, shipmentDate: body.shipmentDate, replayed: false };
  test('FREQ-535-AC-03: 固定の窓口と本文で送信し、成功を検査する', async () => {
    mockClientFetch.mockResolvedValue(respond(200, corrected));
    expect(await client.submitSlipDateCorrection(SLIP_ID, body)).toEqual({ kind: 'ok', data: corrected });
    expect(mockClientFetch).toHaveBeenCalledWith(`/api/admin/shipment-slips/${SLIP_ID}/shipment-date`, expect.objectContaining({ method: 'POST', body: JSON.stringify(body) }));
    mockClientFetch.mockResolvedValue(respond(200, { ...corrected, id: ITEM_ID }));
    expect(await client.submitSlipDateCorrection(SLIP_ID, body)).toEqual({ kind: 'unknown' });
  });
  test('FREQ-540-AC-10: 権限403は訂正の専用文、CSRFは再読込の文を維持する', async () => {
    mockClientFetch.mockResolvedValue(respond(403, { permission: 'admin.shipping.correct_date' }));
    expect(await client.submitSlipDateCorrection(SLIP_ID, body)).toEqual({ kind: 'blocked', forbidden: true, message: '出荷日を訂正する権限がありません。' });
    mockClientFetch.mockResolvedValue(respond(403, { reason: 'CSRF validation failed' }));
    expect(await client.submitSlipDateCorrection(SLIP_ID, body)).toEqual({ kind: 'blocked', forbidden: false, message: 'セキュリティ確認に失敗しました。ページを再読み込みして、もう一度送ってください。' });
  });
});

describe('submitSlipDraft', () => {
  test('FREQ-531-AC-03: 作成（slipId が null）は POST /api/admin/shipment-slips に { lines, requestKey } だけを JSON で送り、成功を ok で返す', async () => {
    mockClientFetch.mockResolvedValue(respond(201, SAVED));
    const result = await client.submitSlipDraft(null, { expectedVersion: 9, lines: LINES, requestKey: KEY });
    expect(result).toEqual({ kind: 'ok', data: SAVED });
    expect(mockClientFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockClientFetch.mock.calls[0];
    expect(url).toBe('/api/admin/shipment-slips');
    expect(init).toMatchObject({ method: 'POST', headers: { 'Content-Type': 'application/json' } });
    expect(JSON.parse(init.body)).toEqual({ lines: LINES, requestKey: KEY });
  });

  test('FREQ-531-AC-03: 入替は POST /api/admin/shipment-slips/[id]/draft に { expectedVersion, lines, requestKey } を送る', async () => {
    mockClientFetch.mockResolvedValue(respond(200, { ...SAVED, replayed: true }));
    const result = await client.submitSlipDraft(SLIP_ID, { expectedVersion: 1, lines: LINES, requestKey: KEY });
    expect(result).toEqual({ kind: 'ok', data: { ...SAVED, replayed: true } });
    const [url, init] = mockClientFetch.mock.calls[0];
    expect(url).toBe(`/api/admin/shipment-slips/${SLIP_ID}/draft`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ expectedVersion: 1, lines: LINES, requestKey: KEY });
  });

  test.each(Object.entries(SHIPMENT_SLIP_ERRORS).filter(([, [, status]]) => status >= 400 && status < 500 && status !== 403))(
    'FREQ-531-AC-03: 窓口の断り %s（4xx）は refused。DB の誤りの code が表にあればその本文を出し、窓口の文は使わない', async (code, [, status, body]) => {
      mockClientFetch.mockResolvedValue(respond(status, { code, error: 'PRIVATE-MARKER' }));
      expect(await client.submitSlipDraft(SLIP_ID, { expectedVersion: 1, lines: LINES, requestKey: KEY })).toEqual({ kind: 'refused', message: body });
    },
  );

  test.each([
    ['400 の Invalid request', 400, { error: 'Invalid request' }],
    ['404 で code が無い', 404, { error: 'Not Found' }],
    ['409 で知らない code', 409, { code: 'UNKNOWN', error: 'PRIVATE-MARKER' }],
    ['409 で継承した名前の code', 409, { code: 'toString', error: 'PRIVATE-MARKER' }],
    ['422 で本文が無い', 422, null],
  ])('FREQ-531-AC-03: %s は「入力を確かめてください。」の refused（生の文は出さない）', async (_name, status, body) => {
    mockClientFetch.mockResolvedValue(respond(status, body));
    expect(await client.submitSlipDraft(SLIP_ID, { expectedVersion: 1, lines: LINES, requestKey: KEY })).toEqual({ kind: 'refused', message: '入力を確かめてください。' });
  });

  test.each([
    [401, { error: 'Unauthorized' }, 'ログインし直してください。'],
    [429, { error: 'Too many requests' }, '操作が続いたため受け付けませんでした。しばらく待ってから、もう一度お試しください。'],
  ])('FREQ-540-AC-10: 処理の前の断り %s は blocked（権限の不足ではないので forbidden は付かない）', async (status, body, message) => {
    mockClientFetch.mockResolvedValue(respond(status, body));
    const result = await client.submitSlipDraft(null, { lines: LINES, requestKey: KEY });
    expect(result).toEqual({ kind: 'blocked', message });
    expect(result).not.toHaveProperty('forbidden', true);
  });

  test.each([
    ['権限の不足（窓口の認可）', { error: 'Forbidden', permission: 'admin.shipping.manage', role: 'supporter' }, '発送を扱う権限がありません。', true],
    ['権限の不足（DB の GROUP_G_FORBIDDEN）', { code: 'GROUP_G_FORBIDDEN', error: '発送を扱う権限がありません。' }, '発送を扱う権限がありません。', true],
    ['MFA が要る', { error: 'Forbidden', reason: 'MFA required', permission: 'admin.shipping.manage', role: 'admin' }, '2要素認証が必要です', false],
    ['CSRF の確かめの失敗', { error: 'Forbidden', reason: 'CSRF validation failed' }, 'セキュリティ確認に失敗しました。ページを再読み込みして、もう一度送ってください。', false],
    ['理由の分からない 403', { error: 'Forbidden' }, '発送を扱う権限がありません。', false],
    ['本文が無い 403', null, '発送を扱う権限がありません。', false],
  ])('FREQ-540-AC-10: 403（%s）は blocked。権限の不足だけ forbidden: true（CSRF・MFA は権限が無いことにしない）', async (_name, body, message, forbidden) => {
    mockClientFetch.mockResolvedValue(respond(403, body));
    expect(await client.submitSlipDraft(null, { lines: LINES, requestKey: KEY })).toEqual({ kind: 'blocked', message, forbidden });
  });

  test.each(['abc', '../orders', `${SLIP_ID}/discard`, ''])(
    'FREQ-531-AC-03: 入替の票の id（%s）が uuid の形でなければ窓口へ送らず、「発送票が見つかりません。」の refused', async (id) => {
      expect(await client.submitSlipDraft(id, { expectedVersion: 1, lines: LINES, requestKey: KEY })).toEqual({ kind: 'refused', message: '発送票が見つかりません。' });
      expect(mockClientFetch).not.toHaveBeenCalled();
    },
  );

  test('FREQ-533-AC-03: 入替の成功の答えが別の票の id なら、読み違いとして unknown（記録されたか分からない）', async () => {
    mockClientFetch.mockResolvedValue(respond(200, { ...SAVED, id: '33333333-3333-4333-8333-333333333399' }));
    expect(await client.submitSlipDraft(SLIP_ID, { expectedVersion: 1, lines: LINES, requestKey: KEY })).toEqual({ kind: 'unknown' });
    mockClientFetch.mockResolvedValue(respond(200, { ...SAVED, id: SLIP_ID.toUpperCase() }));
    expect((await client.submitSlipDraft(SLIP_ID, { expectedVersion: 1, lines: LINES, requestKey: KEY })).kind).toBe('ok');
  });

  test.each([
    ['500', () => respond(500, { error: '発送の記録に失敗しました' })],
    ['503', () => respond(503, { error: 'Service temporarily unavailable' })],
    ['成功なのに本文が JSON でない', () => ({ ok: true, status: 201, json: async () => { throw new Error('PRIVATE-MARKER'); } }) as unknown as Response],
    ['成功なのに本文が崩れている', () => respond(201, { id: 'x' })],
    ['成功なのに本文が空', () => respond(200, null)],
  ])('FREQ-533-AC-03: 結果が分からない（%s）時は unknown', async (_name, answer) => {
    mockClientFetch.mockResolvedValue(answer());
    expect(await client.submitSlipDraft(SLIP_ID, { expectedVersion: 1, lines: LINES, requestKey: KEY })).toEqual({ kind: 'unknown' });
  });

  test('FREQ-533-AC-03: 通信が切れたら unknown（POST は自動で送り直さない）', async () => {
    mockClientFetch.mockRejectedValue(new TypeError('network'));
    expect(await client.submitSlipDraft(null, { lines: LINES, requestKey: KEY })).toEqual({ kind: 'unknown' });
    expect(mockClientFetch).toHaveBeenCalledTimes(1);
  });
});

describe('submitSlipDiscard', () => {
  test('FREQ-531-AC-03: POST /api/admin/shipment-slips/[id]/discard に { expectedVersion, requestKey } だけを送り、成功を ok で返す', async () => {
    mockClientFetch.mockResolvedValue(respond(200, { ...SAVED, version: 3 }));
    const result = await client.submitSlipDiscard(SLIP_ID, { expectedVersion: 2, requestKey: KEY });
    expect(result).toEqual({ kind: 'ok', data: { ...SAVED, version: 3 } });
    const [url, init] = mockClientFetch.mock.calls[0];
    expect(url).toBe(`/api/admin/shipment-slips/${SLIP_ID}/discard`);
    expect(init).toMatchObject({ method: 'POST', headers: { 'Content-Type': 'application/json' } });
    expect(JSON.parse(init.body)).toEqual({ expectedVersion: 2, requestKey: KEY });
  });

  test('FREQ-531-AC-03: 断り・処理の前の断り・結果不明を同じ4つに分ける', async () => {
    mockClientFetch.mockResolvedValue(respond(409, { code: 'GROUP_G_SLIP_NOT_DRAFT', error: 'x' }));
    expect(await client.submitSlipDiscard(SLIP_ID, { expectedVersion: 2, requestKey: KEY })).toEqual({ kind: 'refused', message: 'この発送票は下書きではありません。' });
    mockClientFetch.mockResolvedValue(respond(403, { error: 'Forbidden', permission: 'admin.shipping.manage' }));
    expect(await client.submitSlipDiscard(SLIP_ID, { expectedVersion: 2, requestKey: KEY })).toEqual({ kind: 'blocked', message: '発送を扱う権限がありません。', forbidden: true });
    mockClientFetch.mockResolvedValue(respond(403, { error: 'Forbidden', reason: 'CSRF validation failed' }));
    expect(await client.submitSlipDiscard(SLIP_ID, { expectedVersion: 2, requestKey: KEY })).toEqual({
      kind: 'blocked', message: 'セキュリティ確認に失敗しました。ページを再読み込みして、もう一度送ってください。', forbidden: false,
    });
    mockClientFetch.mockResolvedValue(respond(500, {}));
    expect(await client.submitSlipDiscard(SLIP_ID, { expectedVersion: 2, requestKey: KEY })).toEqual({ kind: 'unknown' });
  });

  test.each(['abc', '../orders', ''])('FREQ-531-AC-03: 票の id（%s）が uuid の形でなければ窓口へ送らず、「発送票が見つかりません。」の refused', async (id) => {
    expect(await client.submitSlipDiscard(id, { expectedVersion: 2, requestKey: KEY })).toEqual({ kind: 'refused', message: '発送票が見つかりません。' });
    expect(mockClientFetch).not.toHaveBeenCalled();
  });

  test('FREQ-533-AC-03: 破棄の成功の答えが別の票の id なら unknown', async () => {
    mockClientFetch.mockResolvedValue(respond(200, { ...SAVED, id: '33333333-3333-4333-8333-333333333399', version: 3 }));
    expect(await client.submitSlipDiscard(SLIP_ID, { expectedVersion: 2, requestKey: KEY })).toEqual({ kind: 'unknown' });
  });
});

describe('submitSlipConfirm', () => {
  const body = { expectedVersion: 1, carrier: null, trackingNumber: null, shipmentDate: '2026-10-25', notifyCustomer: true, requestKey: KEY };
  const result = { id: SLIP_ID, number: 'SL-20261025-0001', version: 2, shipmentDate: '2026-10-25', fulfillments: [{ orderId: '11111111-1111-4111-8111-111111111111', fulfillmentId: '22222222-2222-4222-8222-222222222222', number: 1, completesOrder: true }], replayed: false };
  test('FREQ-533-AC-03: 確定は決まったURLと同じ本文を送り全結果を検査する', async () => {
    mockClientFetch.mockResolvedValue(respond(200, result));
    expect(await client.submitSlipConfirm(SLIP_ID, body)).toEqual({ kind: 'ok', data: result });
    expect(mockClientFetch).toHaveBeenCalledWith(`/api/admin/shipment-slips/${SLIP_ID}/confirm`, expect.objectContaining({ method: 'POST', body: JSON.stringify(body) }));
  });
  test('FREQ-533-AC-03: 読めない成功と別票の戻りはunknown、不正idは送らない', async () => {
    for (const data of [{...result,fulfillments:[]},{...result,id:'33333333-3333-4333-8333-333333333333'}]) {
      mockClientFetch.mockResolvedValue(respond(200,data));
      expect(await client.submitSlipConfirm(SLIP_ID,body)).toEqual({kind:'unknown'});
    }
    mockClientFetch.mockClear();
    expect(await client.submitSlipConfirm('../bad',body)).toEqual({kind:'refused',message:'発送票が見つかりません。'});
    expect(mockClientFetch).not.toHaveBeenCalled();
  });
});

describe('submitSlipConfirm の判断待ちの止め', () => {
  const body = { expectedVersion: 1, carrier: null, trackingNumber: null, shipmentDate: '2026-10-25', notifyCustomer: true, requestKey: KEY };
  test('FREQ-568-AC-06: 確定の409が code DISPUTE_HOLD なら、断りの文にカード会社の判断待ちの止めの文を出す', async () => {
    mockClientFetch.mockResolvedValue(respond(409, { code: 'DISPUTE_HOLD', error: 'x', orderIds: ['11111111-1111-4111-8111-111111111111'] }));
    expect(await client.submitSlipConfirm(SLIP_ID, body)).toEqual({ kind: 'refused', message: 'カード会社の判断待ちの注文が含まれているため、出荷できません。' });
  });
  test('FREQ-568-AC-06: 確定の409でも code が DISPUTE_HOLD でなければ今までの断りの文のまま', async () => {
    mockClientFetch.mockResolvedValue(respond(409, {}));
    expect(await client.submitSlipConfirm(SLIP_ID, body)).toEqual({ kind: 'refused', message: SHIPMENT_SLIP_ERRORS.GROUP_G_ARGUMENT_INVALID[2] });
  });
});

describe('submitSlipCancel', () => {
  const body = { expectedVersion: 2, requestKey: KEY };
  const result = { id: SLIP_ID, version: 3, restoredQuantity: 4, replayed: false };
  test('FREQ-533-AC-04: POST /api/admin/shipment-slips/[id]/cancel に { expectedVersion, requestKey } だけを送り、成功の答えを検査して ok で返す', async () => {
    mockClientFetch.mockResolvedValue(respond(200, { ...result, secret: 'discard' }));
    expect(await client.submitSlipCancel(SLIP_ID, { ...body, extra: 1 } as typeof body)).toEqual({ kind: 'ok', data: result });
    const [url, init] = mockClientFetch.mock.calls[0];
    expect(url).toBe(`/api/admin/shipment-slips/${SLIP_ID}/cancel`);
    expect(init).toMatchObject({ method: 'POST', headers: { 'Content-Type': 'application/json' } });
    expect(JSON.parse(init.body)).toEqual(body);
  });

  test.each([
    ['返品', 'GROUP_G_SLIP_HAS_RETURN', '返品の対象になっている注文があるため、発送を取り消せません。'],
    ['発送後の返金', 'GROUP_G_SLIP_REFUNDED', '発送後に返金した注文があるため、発送を取り消せません。'],
    ['取り消せない状態', 'GROUP_G_SLIP_CANCEL_NOT_ALLOWED', '取り消せない状態の注文があるため、発送を取り消せません。'],
    ['版の競合', 'GROUP_G_SLIP_VERSION_CONFLICT', '発送票が更新されました。内容を確認して、もう一度送ってください。'],
    ['取消済み', 'GROUP_G_SLIP_CANCELLED', 'この発送票は取り消されています。'],
  ])('FREQ-534-AC-03: 取消の拒否（%s）は表の本文の refused', async (_name, code, message) => {
    mockClientFetch.mockResolvedValue(respond(409, { code, error: 'PRIVATE-MARKER' }));
    const refused = await client.submitSlipCancel(SLIP_ID, body);
    expect(refused).toEqual({ kind: 'refused', message });
    expect(JSON.stringify(refused)).not.toContain('PRIVATE-MARKER');
  });

  test('FREQ-534-AC-03: 処理の前の断り（401・403・429）は blocked、結果不明（500・通信切れ・読めない成功）は unknown', async () => {
    mockClientFetch.mockResolvedValue(respond(403, { error: 'Forbidden', permission: 'admin.shipping.manage' }));
    expect(await client.submitSlipCancel(SLIP_ID, body)).toEqual({ kind: 'blocked', message: '発送を扱う権限がありません。', forbidden: true });
    mockClientFetch.mockResolvedValue(respond(403, { error: 'Forbidden', reason: 'CSRF validation failed' }));
    expect(await client.submitSlipCancel(SLIP_ID, body)).toMatchObject({ kind: 'blocked', forbidden: false });
    mockClientFetch.mockResolvedValue(respond(429, {}));
    expect(await client.submitSlipCancel(SLIP_ID, body)).toMatchObject({ kind: 'blocked' });
    mockClientFetch.mockResolvedValue(respond(401, { error: 'Unauthorized' }));
    expect(await client.submitSlipCancel(SLIP_ID, body)).toMatchObject({ kind: 'blocked' });
    mockClientFetch.mockResolvedValue(respond(500, {}));
    expect(await client.submitSlipCancel(SLIP_ID, body)).toEqual({ kind: 'unknown' });
    mockClientFetch.mockRejectedValue(new TypeError('network'));
    expect(await client.submitSlipCancel(SLIP_ID, body)).toEqual({ kind: 'unknown' });
    for (const data of [null, { ...result, restoredQuantity: 0 }, { ...result, version: undefined }, { ...result, id: 'PRIVATE-MARKER' }]) {
      mockClientFetch.mockResolvedValue(respond(200, data));
      expect(await client.submitSlipCancel(SLIP_ID, body)).toEqual({ kind: 'unknown' });
    }
  });

  test('FREQ-534-AC-03: 別の票の id の答えは unknown、uuid でない票の id は窓口へ送らず「発送票が見つかりません。」の refused', async () => {
    mockClientFetch.mockResolvedValue(respond(200, { ...result, id: '33333333-3333-4333-8333-333333333399' }));
    expect(await client.submitSlipCancel(SLIP_ID, body)).toEqual({ kind: 'unknown' });
    mockClientFetch.mockClear();
    for (const id of ['abc', '../orders', '']) {
      expect(await client.submitSlipCancel(id, body)).toEqual({ kind: 'refused', message: '発送票が見つかりません。' });
    }
    expect(mockClientFetch).not.toHaveBeenCalled();
  });
});

describe('submitSlipTrackingEdit', () => {
  const body = { expectedVersion: 2, carrier: 'sagawa', trackingNumber: 'NEW-456', notifyCustomer: true, requestKey: KEY } as const;
  const result = { id: SLIP_ID, version: 3, trackingVersion: 2, replayed: false };
  test('FREQ-534-AC-01: POST /api/admin/shipment-slips/[id]/tracking に { expectedVersion, carrier, trackingNumber, notifyCustomer, requestKey } だけを送り、成功の答えを検査して ok で返す', async () => {
    mockClientFetch.mockResolvedValue(respond(200, { ...result, secret: 'discard' }));
    expect(await client.submitSlipTrackingEdit(SLIP_ID, { ...body, extra: 1 } as typeof body)).toEqual({ kind: 'ok', data: result });
    const [url, init] = mockClientFetch.mock.calls[0];
    expect(url).toBe(`/api/admin/shipment-slips/${SLIP_ID}/tracking`);
    expect(init).toMatchObject({ method: 'POST', headers: { 'Content-Type': 'application/json' } });
    expect(JSON.parse(init.body)).toEqual(body);
  });

  test.each([
    ['空には戻せない（400）', 400, 'GROUP_G_SLIP_TRACKING_INCOMPLETE', '運送会社と伝票番号は、両方入れるか両方空にしてください。'],
    ['変わっていない', 409, 'GROUP_G_SLIP_TRACKING_UNCHANGED', '運送会社も伝票番号も変わっていません。'],
    ['版の競合', 409, 'GROUP_G_SLIP_VERSION_CONFLICT', '発送票が更新されました。内容を確認して、もう一度送ってください。'],
    ['取消済み', 409, 'GROUP_G_SLIP_CANCELLED', 'この発送票は取り消されています。'],
    ['確定前', 409, 'GROUP_G_SLIP_NOT_CONFIRMED', '発送が確定した発送票だけで行える操作です。'],
    ['同じ要求番号で違う内容', 409, 'GROUP_G_REQUEST_KEY_CONFLICT', '同じ要求番号で異なる操作は実行できません。'],
  ])('FREQ-534-AC-01: 伝票番号の拒否（%s）は表の本文の refused', async (_name, status, code, message) => {
    mockClientFetch.mockResolvedValue(respond(status, { code, error: 'PRIVATE-MARKER' }));
    const refused = await client.submitSlipTrackingEdit(SLIP_ID, body);
    expect(refused).toEqual({ kind: 'refused', message });
    expect(JSON.stringify(refused)).not.toContain('PRIVATE-MARKER');
  });

  test('FREQ-534-AC-01: code が無い・表に無い 400 は「入力を確かめてください。」の refused', async () => {
    mockClientFetch.mockResolvedValue(respond(400, { error: 'Invalid request' }));
    expect(await client.submitSlipTrackingEdit(SLIP_ID, body)).toEqual({ kind: 'refused', message: '入力を確かめてください。' });
  });

  test('FREQ-534-AC-01: 処理の前の断り（401・403・429）は blocked、結果不明（500・通信切れ・読めない成功）は unknown', async () => {
    mockClientFetch.mockResolvedValue(respond(403, { error: 'Forbidden', permission: 'admin.shipping.manage' }));
    expect(await client.submitSlipTrackingEdit(SLIP_ID, body)).toEqual({ kind: 'blocked', message: '発送を扱う権限がありません。', forbidden: true });
    mockClientFetch.mockResolvedValue(respond(403, { error: 'Forbidden', reason: 'CSRF validation failed' }));
    expect(await client.submitSlipTrackingEdit(SLIP_ID, body)).toMatchObject({ kind: 'blocked', forbidden: false });
    mockClientFetch.mockResolvedValue(respond(429, {}));
    expect(await client.submitSlipTrackingEdit(SLIP_ID, body)).toMatchObject({ kind: 'blocked' });
    mockClientFetch.mockResolvedValue(respond(401, { error: 'Unauthorized' }));
    expect(await client.submitSlipTrackingEdit(SLIP_ID, body)).toMatchObject({ kind: 'blocked' });
    mockClientFetch.mockResolvedValue(respond(500, {}));
    expect(await client.submitSlipTrackingEdit(SLIP_ID, body)).toEqual({ kind: 'unknown' });
    mockClientFetch.mockRejectedValue(new TypeError('network'));
    expect(await client.submitSlipTrackingEdit(SLIP_ID, body)).toEqual({ kind: 'unknown' });
    for (const data of [null, { ...result, trackingVersion: 1 }, { ...result, trackingVersion: undefined }, { ...result, version: undefined }, { ...result, id: 'PRIVATE-MARKER' }]) {
      mockClientFetch.mockResolvedValue(respond(200, data));
      expect(await client.submitSlipTrackingEdit(SLIP_ID, body)).toEqual({ kind: 'unknown' });
    }
  });

  test('FREQ-534-AC-01: 別の票の id の答えは unknown、uuid でない票の id は窓口へ送らず「発送票が見つかりません。」の refused', async () => {
    mockClientFetch.mockResolvedValue(respond(200, { ...result, id: '33333333-3333-4333-8333-333333333399' }));
    expect(await client.submitSlipTrackingEdit(SLIP_ID, body)).toEqual({ kind: 'unknown' });
    mockClientFetch.mockClear();
    for (const id of ['abc', '../orders', '']) {
      expect(await client.submitSlipTrackingEdit(id, body)).toEqual({ kind: 'refused', message: '発送票が見つかりません。' });
    }
    expect(mockClientFetch).not.toHaveBeenCalled();
  });
});

describe('submitSlipDelivered', () => {
  const body = { expectedVersion: 2, deliveredOn: '2026-10-25', notifyCustomer: true, requestKey: KEY };
  const result = { id: SLIP_ID, version: 3, deliveredAt: '2026-10-25T03:00:00.000Z', replayed: false };
  test('FREQ-534-AC-02: POST /api/admin/shipment-slips/[id]/delivered に { expectedVersion, deliveredOn, notifyCustomer, requestKey } だけを送り、成功の答えを検査して ok で返す', async () => {
    mockClientFetch.mockResolvedValue(respond(200, { ...result, secret: 'discard' }));
    expect(await client.submitSlipDelivered(SLIP_ID, { ...body, extra: 1 } as typeof body)).toEqual({ kind: 'ok', data: result });
    const [url, init] = mockClientFetch.mock.calls[0];
    expect(url).toBe(`/api/admin/shipment-slips/${SLIP_ID}/delivered`);
    expect(init).toMatchObject({ method: 'POST', headers: { 'Content-Type': 'application/json' } });
    expect(JSON.parse(init.body)).toEqual(body);
  });

  test.each([
    ['すでに配達済み', 409, 'GROUP_G_SLIP_ALREADY_DELIVERED', 'この発送票はすでに配達済みです。'],
    ['届いた日が範囲外（400）', 400, 'GROUP_G_SLIP_DELIVERY_DATE_INVALID', '届いた日は、発送した日から今日までの日付にしてください。'],
    ['版の競合', 409, 'GROUP_G_SLIP_VERSION_CONFLICT', '発送票が更新されました。内容を確認して、もう一度送ってください。'],
    ['取消済み', 409, 'GROUP_G_SLIP_CANCELLED', 'この発送票は取り消されています。'],
    ['確定前', 409, 'GROUP_G_SLIP_NOT_CONFIRMED', '発送が確定した発送票だけで行える操作です。'],
  ])('FREQ-534-AC-02: 配達済みの拒否（%s）は表の本文の refused', async (_name, status, code, message) => {
    mockClientFetch.mockResolvedValue(respond(status, { code, error: 'PRIVATE-MARKER' }));
    const refused = await client.submitSlipDelivered(SLIP_ID, body);
    expect(refused).toEqual({ kind: 'refused', message });
    expect(JSON.stringify(refused)).not.toContain('PRIVATE-MARKER');
  });

  test('FREQ-534-AC-02: 処理の前の断り（401・403・429）は blocked、結果不明（500・通信切れ・読めない成功）は unknown', async () => {
    mockClientFetch.mockResolvedValue(respond(403, { error: 'Forbidden', permission: 'admin.shipping.manage' }));
    expect(await client.submitSlipDelivered(SLIP_ID, body)).toEqual({ kind: 'blocked', message: '発送を扱う権限がありません。', forbidden: true });
    mockClientFetch.mockResolvedValue(respond(403, { error: 'Forbidden', reason: 'CSRF validation failed' }));
    expect(await client.submitSlipDelivered(SLIP_ID, body)).toMatchObject({ kind: 'blocked', forbidden: false });
    mockClientFetch.mockResolvedValue(respond(429, {}));
    expect(await client.submitSlipDelivered(SLIP_ID, body)).toMatchObject({ kind: 'blocked' });
    mockClientFetch.mockResolvedValue(respond(401, { error: 'Unauthorized' }));
    expect(await client.submitSlipDelivered(SLIP_ID, body)).toMatchObject({ kind: 'blocked' });
    mockClientFetch.mockResolvedValue(respond(500, {}));
    expect(await client.submitSlipDelivered(SLIP_ID, body)).toEqual({ kind: 'unknown' });
    mockClientFetch.mockRejectedValue(new TypeError('network'));
    expect(await client.submitSlipDelivered(SLIP_ID, body)).toEqual({ kind: 'unknown' });
    for (const data of [null, { ...result, deliveredAt: 'not a date' }, { ...result, deliveredAt: undefined }, { ...result, version: undefined }, { ...result, id: 'PRIVATE-MARKER' }]) {
      mockClientFetch.mockResolvedValue(respond(200, data));
      expect(await client.submitSlipDelivered(SLIP_ID, body)).toEqual({ kind: 'unknown' });
    }
  });

  test('FREQ-534-AC-02: 別の票の id の答えは unknown、uuid でない票の id は窓口へ送らず「発送票が見つかりません。」の refused', async () => {
    mockClientFetch.mockResolvedValue(respond(200, { ...result, id: '33333333-3333-4333-8333-333333333399' }));
    expect(await client.submitSlipDelivered(SLIP_ID, body)).toEqual({ kind: 'unknown' });
    mockClientFetch.mockClear();
    for (const id of ['abc', '../orders', '']) {
      expect(await client.submitSlipDelivered(id, body)).toEqual({ kind: 'refused', message: '発送票が見つかりません。' });
    }
    expect(mockClientFetch).not.toHaveBeenCalled();
  });
});
