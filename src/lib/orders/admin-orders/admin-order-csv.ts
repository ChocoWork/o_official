import { ADMIN_ITEM_STATUS_LABELS } from '@/lib/orders/item-state/item-state-types';
import { toOrderNumber } from '@/lib/orders/order-number';
import { ORDER_ITEM_COLUMNS, type AdminOrderExportRow } from './admin-order-types';

export const ORDER_ITEM_CSV_HEADERS = ORDER_ITEM_COLUMNS.map((column) => column.header);
export function neutralizeCsvFormula(value: string): string {
  return /^[=+\-@\t\r\n]/.test(value) ? `'${value}` : value;
}
function quote(value: string | number): string {
  const text = typeof value === 'number' ? String(value) : neutralizeCsvFormula(value);
  return `"${text.replace(/"/g, '""')}"`;
}
function jst(date: Date): string {
  return new Date(date.getTime() + 9 * 60 * 60 * 1000).toISOString();
}
/** DBが一度に返す全行だけを材料とし、文字と数値の無害化を分ける。 */
export function buildOrderItemCsv(rows: readonly AdminOrderExportRow[]): string {
  const records: Array<Array<string | number>> = [ORDER_ITEM_CSV_HEADERS];
  for (const row of rows) records.push([
    toOrderNumber(row.orderId), jst(new Date(row.orderCreatedAt)).slice(0, 16).replace('T', ' '), row.customerName ?? '', row.customerEmail ?? '',
    `${row.itemName}${row.isExchange ? '（交換品）' : ''}`, row.color ?? '', row.size ?? '', row.quantity, row.unitPrice, row.lineAmount, row.refundAmount, ADMIN_ITEM_STATUS_LABELS[row.status],
  ]);
  return `\uFEFF${records.map((record) => record.map(quote).join(',')).join('\r\n')}\r\n`;
}
export function orderItemCsvFilename(now: Date): string {
  return `order-items_${jst(now).slice(0, 10)}.csv`;
}
