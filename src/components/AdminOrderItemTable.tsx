'use client';

// File: src/components/AdminOrderItemTable.tsx
// 注文一覧表の表（G-4 / FREQ-536）。品物×ステータスの12列。注文の共通欄は全行に持つ。
// 行はキーボードで着ける（tabIndex）。行にフォーカスがある時の Enter/Space と行の押下で詳細を開く。
// 注文IDの Link・行の中のボタンと入力の押下では開かない（Link が自分で移るので、二重に移らない）。
import Link from 'next/link';
import type { KeyboardEvent, MouseEvent } from 'react';
import { StatusBadge } from '@/components/ui/StatusBadge/StatusBadge';
import { TagLabel } from '@/components/ui/TagLabel/TagLabel';
import { ORDER_ITEM_COLUMNS, type AdminOrderItemRow } from '@/lib/orders/admin-orders/admin-order-types';
import { ADMIN_ITEM_STATUS_LABELS } from '@/lib/orders/item-state/item-state-types';

type Props = {
  rows: readonly AdminOrderItemRow[];
  /** 行を開く（注文の番号を渡す） */
  onOpen: (orderId: string) => void;
};

const RIGHT_ALIGNED_COLUMNS = new Set<string>(['数量', '単価', '合計金額', '返金額']);
const HEAD_CELL = 'sticky top-0 z-10 whitespace-nowrap border-b border-black/15 bg-white p-3 font-normal';

const yen = (value: number): string => `¥${value.toLocaleString('ja-JP')}`;

/** 日時を日本時間の `YYYY-MM-DD HH:mm` にする。読めない日時はそのまま返す */
function formatOrderDateTime(value: string): string {
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? value : new Date(time + 9 * 60 * 60 * 1000).toISOString().slice(0, 16).replace('T', ' ');
}

export default function AdminOrderItemTable({ rows, onOpen }: Props): React.JSX.Element {
  const handleClick = (event: MouseEvent<HTMLTableRowElement>, orderId: string): void => {
    if ((event.target as HTMLElement).closest('a, button, input')) return;
    onOpen(orderId);
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLTableRowElement>, orderId: string): void => {
    // 行の中の Link などの Enter は、その部品が受け持つ
    if (event.target !== event.currentTarget) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onOpen(orderId);
    }
  };

  return (
    <div role="region" aria-label="注文一覧表" tabIndex={0} className="max-h-[70vh] w-full min-w-0 max-w-full overflow-auto border border-black/15 focus-visible:outline-2">
      <table className="w-full min-w-[72rem] border-collapse text-left lk-text-2xs">
        <thead>
          <tr>
            {ORDER_ITEM_COLUMNS.map((column) => (
              <th key={column.key} scope="col" className={`${HEAD_CELL} ${RIGHT_ALIGNED_COLUMNS.has(column.header) ? 'text-right' : ''}`}>{column.header}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={`${row.orderItemId}-${row.status}`}
              tabIndex={0}
              aria-label={`${row.orderNumber} ${row.itemName} の詳細を開く`}
              data-testid="order-item-row"
              onClick={(event) => handleClick(event, row.orderId)}
              onKeyDown={(event) => handleKeyDown(event, row.orderId)}
              className="cursor-pointer border-b border-black/10 align-top hover:bg-black/[0.03] focus-visible:outline-2"
            >
              <td className="whitespace-nowrap p-3">
                <Link href={`/admin/orders/${row.orderId}`} className="underline underline-offset-4">{row.orderNumber}</Link>
              </td>
              <td className="whitespace-nowrap p-3">{formatOrderDateTime(row.orderCreatedAt)}</td>
              <td className="break-words p-3">{row.customerName || 'ゲスト'}</td>
              <td className="break-all p-3">{row.customerEmail || '-'}</td>
              <td className="break-words p-3">{row.itemName}{row.isExchange ? '（交換品）' : ''}</td>
              <td className="break-words p-3">{row.color || '-'}</td>
              <td className="break-words p-3">{row.size || '-'}</td>
              <td className="p-3 text-right tabular-nums">{row.quantity}</td>
              <td className="whitespace-nowrap p-3 text-right tabular-nums">{yen(row.unitPrice)}</td>
              <td className="whitespace-nowrap p-3 text-right tabular-nums">{yen(row.lineAmount)}</td>
              <td className="whitespace-nowrap p-3 text-right tabular-nums">{yen(row.refundAmount)}</td>
              <td className="p-3">
                <div className="flex flex-wrap items-center gap-1">
                  <StatusBadge className="whitespace-nowrap">{ADMIN_ITEM_STATUS_LABELS[row.status]}</StatusBadge>
                  {row.needsAttention ? <TagLabel variant="outline" size="2xs">要対応</TagLabel> : null}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
