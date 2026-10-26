'use client';

import { Button } from '@/components/ui/Button/Button';
import { StatusBadge } from '@/components/ui/StatusBadge/StatusBadge';
import type { AdminOrderDetail } from '@/lib/orders/admin-orders/admin-order-types';
import { ADMIN_ITEM_STATUS_LABELS, ITEM_BLOCKED_REASON_LABELS } from '@/lib/orders/item-state/item-state-types';

type Props = { rows: AdminOrderDetail['rows']; orderNumber: string; canSwap: boolean; onSwap: (row: AdminOrderDetail['rows'][number]) => void };
const yen = (value: number): string => `¥${value.toLocaleString('ja-JP')}`;

export default function AdminOrderItemsTable({ rows, orderNumber, canSwap, onSwap }: Props): React.JSX.Element {
  return (
    <div role="region" aria-label={`${orderNumber} 明細の表`} tabIndex={0} className="max-h-[32rem] w-full min-w-0 overflow-x-auto">
      <table className="w-full min-w-[850px] text-left lk-text-2xs">
        <thead className="sticky top-0 z-10 bg-white"><tr>{['商品名', '色', 'サイズ', 'ステータス', '数量', '単価', '合計金額', '返金額', '補足'].map((label) => <th key={label} scope="col" className="whitespace-nowrap border-b border-black/20 px-3 py-2">{label}</th>)}</tr></thead>
        <tbody>{rows.map((row, index) => (
          <tr key={`${row.orderItemId}:${row.status}:${index}`} className="border-b border-black/10 align-top">
            <td className="px-3 py-3">{row.itemName}{row.isExchange ? '（交換品）' : ''}</td>
            <td className="px-3 py-3">{row.color || '-'}</td><td className="px-3 py-3">{row.size || '-'}</td>
            <td className="px-3 py-3"><StatusBadge>{ADMIN_ITEM_STATUS_LABELS[row.status]}</StatusBadge></td>
            <td className="px-3 py-3">{row.quantity}</td>
            <td className="whitespace-nowrap px-3 py-3">{yen(row.unitPrice)}</td><td className="whitespace-nowrap px-3 py-3">{yen(row.lineAmount)}</td><td className="whitespace-nowrap px-3 py-3">{yen(row.refundAmount)}</td>
            <td className="min-w-48 px-3 py-3">
              {row.blockedReasons.map((reason) => <p key={reason}>{ITEM_BLOCKED_REASON_LABELS[reason]}</p>)}
              {canSwap && row.status === 'in_production' && row.blockedReasons.length === 1 && row.blockedReasons[0] === 'stock_shortage' ? <Button type="button" variant="secondary" size="sm" className="mt-2" aria-label={`${row.itemName} ${row.color ?? ''} ${row.size ?? ''} の割り当てを入れ替える`} onClick={() => onSwap(row)}>割り当てを入れ替える</Button> : null}
            </td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}
