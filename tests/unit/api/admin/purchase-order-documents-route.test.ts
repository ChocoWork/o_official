/** @jest-environment node */
jest.mock('server-only', () => ({}), { virtual: true });
jest.mock('next/server', () => ({ NextResponse: { json: (body: unknown, init?: ResponseInit) => new Response(JSON.stringify(body), init) } }));
jest.mock('@/lib/auth/admin-rbac', () => ({ authorizeAdminPermissions: jest.fn(), authorizeAdminPermission: jest.fn() }));
jest.mock('@/lib/supabase/server', () => ({ createServiceRoleClient: jest.fn() }));

import { inspect } from 'node:util';
import * as documentsRoute from '@/app/api/admin/purchase-order-documents/route';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { ATTACHMENT_ID, ORDER_ID } from '../../lib/purchase-orders/purchase-order-fixtures';

const rpc = jest.fn();
const authorize = authorizeAdminPermission as jest.Mock;

const dbRow = (total: number, overrides: Record<string, unknown> = {}) => ({
  total, attachment_id: ATTACHMENT_ID, purchase_order_id: ORDER_ID, purchase_order_number: 'PO-20261025-0001', kind: 'invoice',
  original_file_name: 'invoice.pdf', mime_type: 'application/pdf', size_bytes: 2048, revision_no: 1, is_current: true,
  transaction_date: '2026-10-26', amount_yen: 6000, currency: 'JPY', counterparty: '工場A', voided: false, reason: null,
  replaces_attachment_id: null, created_at: '2026-10-26T03:00:00+00:00', ...overrides,
});

beforeEach(() => {
  jest.resetAllMocks();
  jest.spyOn(console, 'error').mockImplementation(() => {});
  authorize.mockResolvedValue({ ok: true, userId: 'authorized-actor', role: 'admin' });
  (createServiceRoleClient as jest.Mock).mockResolvedValue({ rpc });
  rpc.mockResolvedValue({ data: [dbRow(1)], error: null });
});
afterEach(() => jest.restoreAllMocks());

async function get(query = '') {
  const request = new Request(`https://example.test/api/admin/purchase-order-documents${query}`);
  const response = await documentsRoute.GET(request);
  const text = await response.text();
  return { request, response, status: response.status, text, json: text ? JSON.parse(text) : null };
}

const EMPTY_ARGS = {
  _date_from: null, _date_to: null, _amount_min: null, _amount_max: null, _counterparty: null, _purchase_order_number: null,
  _kind: null, _include_history: false, _limit: 50, _offset: 0, _actor_id: 'authorized-actor',
};

describe('GET /api/admin/purchase-order-documents（取引書類の検索）', () => {
  test('FREQ-530-AC-02: 条件が無ければ 200 で { rows, total, page: 1, limit: 50 } を no-store で返し、DB の関数を実行者つきで1回呼ぶ', async () => {
    const { request, response, status, json } = await get();
    expect(status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(json.page).toBe(1);
    expect(json.limit).toBe(50);
    expect(json.total).toBe(1);
    expect(json.rows).toEqual([{
      attachmentId: ATTACHMENT_ID, purchaseOrderId: ORDER_ID, purchaseOrderNumber: 'PO-20261025-0001', kind: 'invoice', fileName: 'invoice.pdf',
      mimeType: 'application/pdf', sizeBytes: 2048, revisionNo: 1, isCurrent: true, transactionDate: '2026-10-26', amountYen: 6000, currency: 'JPY',
      counterparty: '工場A', voided: false, reason: null, replacesAttachmentId: null, createdAt: '2026-10-26T03:00:00+00:00',
    }]);
    expect(authorize).toHaveBeenCalledTimes(1);
    expect(authorize).toHaveBeenCalledWith('admin.purchase_orders.read', request);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('search_purchase_order_documents', EMPTY_ARGS);
    expect(JSON.stringify(json)).not.toContain('storage_path');
  });

  test('FREQ-530-AC-02: すべての条件を DB の関数へ渡す（取引先・番号は前後の空白を落とす）。page 3 は offset 100', async () => {
    const query = '?dateFrom=2026-10-01&dateTo=2026-10-31&amountMin=1000&amountMax=9000&counterparty=%20%E5%B7%A5%E5%A0%B4%20&number=PO-2026&kind=invoice&includeHistory=1&page=3';
    rpc.mockResolvedValue({ data: [dbRow(120), dbRow(120, { revision_no: 2, is_current: false })], error: null });
    const { status, json } = await get(query);
    expect(status).toBe(200);
    expect(json).toMatchObject({ total: 120, page: 3, limit: 50 });
    expect(json.rows.map((row: { revisionNo: number; isCurrent: boolean }) => [row.revisionNo, row.isCurrent])).toEqual([[1, true], [2, false]]);
    expect(rpc).toHaveBeenCalledWith('search_purchase_order_documents', {
      _date_from: '2026-10-01', _date_to: '2026-10-31', _amount_min: 1000, _amount_max: 9000, _counterparty: '工場', _purchase_order_number: 'PO-2026',
      _kind: 'invoice', _include_history: true, _limit: 50, _offset: 100, _actor_id: 'authorized-actor',
    });
  });

  test('FREQ-530-AC-02: 空の条件（dateFrom= など）は「かけない」。includeHistory=0 は偽。金額は0を指定できる', async () => {
    await get('?dateFrom=&dateTo=&amountMin=0&amountMax=&counterparty=&number=&kind=&includeHistory=0&page=1');
    expect(rpc).toHaveBeenCalledWith('search_purchase_order_documents', { ...EMPTY_ARGS, _amount_min: 0 });
  });

  test('FREQ-530-AC-02: 結果が空なら { rows: [], total: 0 }', async () => {
    rpc.mockResolvedValue({ data: [], error: null });
    const { status, json } = await get();
    expect(status).toBe(200);
    expect(json).toEqual({ rows: [], total: 0, page: 1, limit: 50 });
  });

  test.each([
    ['日付が実在しない', '?dateFrom=2026-02-30'],
    ['日付が形違い', '?dateTo=2026/10/01'],
    ['金額が負', '?amountMin=-1'],
    ['金額が小数', '?amountMax=1.5'],
    ['金額が12桁', '?amountMin=100000000000'],
    ['金額が上限超え（11桁）', '?amountMax=99999999999999'],
    ['取引先が101字', `?counterparty=${'a'.repeat(101)}`],
    ['発注書番号が21字', `?number=${'P'.repeat(21)}`],
    ['種類が quote・invoice 以外', '?kind=memo'],
    ['includeHistory が 1・0 以外', '?includeHistory=true'],
    ['page が 0', '?page=0'],
    ['page が文字', '?page=abc'],
    ['page が上限超え', '?page=100001'],
    ['page が8桁', '?page=00000001'],
  ])('FREQ-530-AC-02: 条件 %s は 400 で no-store。DB に進まない', async (_name, query) => {
    const { response, status, json } = await get(query);
    expect(status).toBe(400);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(json).toEqual({ error: 'Invalid request' });
    expect(rpc).not.toHaveBeenCalled();
  });

  test('FREQ-530-AC-02: 上限ちょうど（金額 99999999999・取引先100字・番号20字・page 100000）は通る', async () => {
    const { status } = await get(`?amountMax=99999999999&counterparty=${encodeURIComponent('あ'.repeat(100))}&number=${'P'.repeat(20)}&page=100000`);
    expect(status).toBe(200);
  });

  test.each([
    ['admin.items.read だけ', ['admin.items.read'], 'admin.purchase_orders.read'],
    ['admin.purchase_orders.manage だけ', ['admin.purchase_orders.manage'], 'admin.purchase_orders.read'],
  ])('FREQ-540-AC-07: %s の人は 403 で no-store。DB に進まない（manage は要らず、read が要る）', async (_name, held, missing) => {
    authorize.mockImplementation(async (required: string) => held.includes(required)
      ? { ok: true, userId: 'authorized-actor', role: 'supporter' }
      : { ok: false, response: new Response(JSON.stringify({ error: 'Forbidden', permission: required, role: 'supporter' }), { status: 403 }) });
    const { response, status, json } = await get();
    expect(status).toBe(403);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(json).toEqual({ error: 'Forbidden', permission: missing, role: 'supporter' });
    expect(createServiceRoleClient).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  test.each([
    [401, { error: 'Unauthorized' }], [403, { error: 'Forbidden', reason: 'MFA required' }], [503, { error: 'Service temporarily unavailable' }],
  ])('FREQ-540-AC-07: 認可の拒否 %s は状態と本文をそのまま返し no-store。認可が先なので範囲外の条件でも認可の拒否が先に返る', async (status, payload) => {
    authorize.mockResolvedValue({ ok: false, response: new Response(JSON.stringify(payload), { status }) });
    const result = await get('?page=0');
    expect(result.status).toBe(status);
    expect(result.json).toEqual(payload);
    expect(result.response.headers.get('cache-control')).toBe('no-store');
    expect(rpc).not.toHaveBeenCalled();
  });

  test('FREQ-540-AC-07: DB が 42501 で断れば 403 { code: GROUP_G_FORBIDDEN, error }（読取の権限も DB が確かめる）', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'GROUP_G_FORBIDDEN', code: '42501', details: 'PRIVATE-MARKER' } });
    const { status, json, text: body } = await get();
    expect(status).toBe(403);
    expect(json).toEqual({ code: 'GROUP_G_FORBIDDEN', error: '発注を扱う権限がありません。' });
    expect(body).not.toContain('PRIVATE-MARKER');
  });

  test.each([
    ['未知の DB エラー', { data: null, error: { message: 'PRIVATE-MARKER', code: '23514', details: 'PRIVATE-MARKER' } }],
    ['戻りが配列でない', { data: { not: 'array' }, error: null }],
    ['行が崩れている', { data: [dbRow(1, { kind: 'memo' })], error: null }],
    ['total が行数より少ない', { data: [dbRow(0)], error: null }],
  ])('FREQ-530-AC-02: %s は固定の500 { error: 取引書類を読み込めませんでした。 } で、生の文を本文にもログにも出さない', async (_name, response) => {
    rpc.mockResolvedValue(response);
    const result = await get();
    expect(result.status).toBe(500);
    expect(result.json).toEqual({ error: '取引書類を読み込めませんでした。' });
    expect(result.response.headers.get('cache-control')).toBe('no-store');
    expect(inspect([result.text, (console.error as jest.Mock).mock.calls], { depth: null })).not.toContain('PRIVATE-MARKER');
  });

  test('FREQ-530-AC-02: DB の呼び出しが例外でも固定の500', async () => {
    rpc.mockRejectedValue(new Error('PRIVATE-MARKER'));
    const result = await get();
    expect(result.status).toBe(500);
    expect(result.json).toEqual({ error: '取引書類を読み込めませんでした。' });
    expect(inspect([result.text, (console.error as jest.Mock).mock.calls], { depth: null })).not.toContain('PRIVATE-MARKER');
  });

  test('FREQ-530-AC-01: route file は GET だけを export する（DELETE・PUT・PATCH・POST は無い）', () => {
    expect(Object.keys(documentsRoute).sort()).toEqual(['GET']);
  });
});
