import { buildOrderItemCsv, neutralizeCsvFormula, ORDER_ITEM_CSV_HEADERS, orderItemCsvFilename } from '@/lib/orders/admin-orders/admin-order-csv';
import type { AdminOrderExportRow } from '@/lib/orders/admin-orders/admin-order-types';

const row: AdminOrderExportRow = { orderId: 'abcdef12-1234-4234-8234-123456789abc', orderCreatedAt: '2026-10-25T15:30:00Z', customerName: null, customerEmail: null, orderItemId: '12345678-1234-4234-8234-123456789abc', itemName: '品"物\n名', color: '白', size: 'M', isExchange: true, status: 'ready', quantity: 2, unitPrice: 100, lineAmount: 200, refundAmount: 0 };
test('FREQ-538-AC-03: BOM・12列・全セルの引用符・引用符二重化・セル内改行・末尾CRLF', () => {
  expect(ORDER_ITEM_CSV_HEADERS).toEqual(['注文ID', '注文日', '顧客名', 'メールアドレス', '商品名', '色', 'サイズ', '数量', '単価', '合計金額', '返金額', 'ステータス']);
  expect(buildOrderItemCsv([row])).toBe('\uFEFF"注文ID","注文日","顧客名","メールアドレス","商品名","色","サイズ","数量","単価","合計金額","返金額","ステータス"\r\n"ORD-ABCDEF12","2026-10-26 00:30","","","品""物\n名（交換品）","白","M","2","100","200","0","発送準備中"\r\n');
});
test.each(['=', '+', '-', '@', '\t', '\r', '\n'])('FREQ-538-AC-04: 文字の5列の先頭 %j を無害化し数値は保つ', (prefix) => {
  const value = `${prefix}value`;
  expect(neutralizeCsvFormula(value)).toBe(`'${value}`);
  const csv = buildOrderItemCsv([{ ...row, isExchange: false, customerName: value, customerEmail: value, itemName: value, color: value, size: value }]);
  expect(csv.split(`"'${value}"`)).toHaveLength(6);
  expect(csv).toContain('"2","100","200","0"');
});
test.each(['plain', "'=x", ' =x', ''])('FREQ-538-AC-04: ほかの文字は変更しない %j', (value) => expect(neutralizeCsvFormula(value)).toBe(value));
test('FREQ-536-AC-01: 通常行・空文字・日本時間のファイル名', () => {
  expect(buildOrderItemCsv([{ ...row, itemName: '通常品', isExchange: false, customerName: '' }])).toContain('"通常品"');
  expect(orderItemCsvFilename(new Date('2026-10-25T15:00:00Z'))).toBe('order-items_2026-10-26.csv');
});
