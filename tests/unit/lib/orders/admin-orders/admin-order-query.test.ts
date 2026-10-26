import { parseOrderItemQuery, parseOrderItemListResult, toFilterPayload } from '@/lib/orders/admin-orders/admin-order-query';
import { orderItemCapNote, ORDER_ITEM_COLUMNS } from '@/lib/orders/admin-orders/admin-order-types';

describe('admin order query', () => {
  test('FREQ-536-AC-02: trim・繰り返すstatus・attention・日付・頁をDBの条件へ直す', () => {
    const result = parseOrderItemQuery(new URLSearchParams('customer=%20test%20&status=ready&status=shipped&attention=1&dateFrom=2026-01-01&dateTo=2026-12-31&orderNumber=ORD-ABCDEF12&page=2'));
    expect(result).toEqual({ ok: true, filters: { customer: 'test', statuses: ['ready', 'shipped'], attention: true, dateFrom: '2026-01-01', dateTo: '2026-12-31', orderNumber: 'ORD-ABCDEF12' }, page: 2 });
    if (result.ok) expect(toFilterPayload(result.filters)).toEqual(result.filters);
    expect(toFilterPayload({ customer: undefined })).toEqual({});
    expect(parseOrderItemQuery(new URLSearchParams())).toEqual({ ok: true, filters: {}, page: 1 });
  });
  test.each(['abcdef12', 'ord-abcdef12', '12345678-1234-4234-8234-123456789abc', `pi_${'a'.repeat(197)}`, 'PI_abc'])('FREQ-536-AC-02: 有効な注文ID %s', (value) => {
    expect(parseOrderItemQuery(new URLSearchParams({ orderNumber: value })).ok).toBe(true);
  });
  test.each(['counterparty=a', 'page=0', 'page=100001', 'page=1.5', 'page=', 'page=1&page=2', 'attention=0', 'status=unknown', 'dateFrom=2026-02-30', 'dateFrom=2026-1-01', 'dateFrom=2026-02-01&dateTo=2026-01-01', 'orderNumber=hello', 'orderNumber=pi_', `orderNumber=pi_${'a'.repeat(198)}`, `product=${'a'.repeat(201)}`, 'customer=%20'])('FREQ-536-AC-02: 不正な条件を断る %s', (query) => {
    expect(parseOrderItemQuery(new URLSearchParams(query))).toEqual({ ok: false });
  });
  test('FREQ-536-AC-03: 空の頁でも上限の旗・件数を保持する', () => {
    expect(parseOrderItemListResult({ rows: [], totalRows: 0, totalOrders: 0, ordersCapped: true, ordersCap: 5000 }, 1)).toEqual({ rows: [], totalRows: 0, totalOrders: 0, ordersCapped: true, ordersCap: 5000, page: 1, pageSize: 20, totalPages: 1 });
    expect(orderItemCapNote(5000)).toBe('新しい5,000件の注文だけを表示しています。それより前の注文は「注文日（まで）」で期間を絞ると表示されます。');
    expect(ORDER_ITEM_COLUMNS.map((c) => c.header)).toEqual(['注文ID', '注文日', '顧客名', 'メールアドレス', '商品名', '色', 'サイズ', '数量', '単価', '合計金額', '返金額', 'ステータス']);
  });
  test.each([{ ordersCapped: 1 }, { ordersCap: 0 }, { ordersCap: 1.5 }, { totalRows: -1 }, { totalOrders: '1' }, { rows: null }])('FREQ-536-AC-03: 戻り値の型・値域を検査 %j', (patch) => {
    expect(() => parseOrderItemListResult({ rows: [], totalRows: 0, totalOrders: 0, ordersCapped: false, ordersCap: 5000, ...patch }, 1)).toThrow();
  });
});
