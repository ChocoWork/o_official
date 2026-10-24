'use client';

// File: src/components/PurchaseOrderListSection.tsx
// 発注一覧表（G-2 / FREQ-526）。発注書の明細ごとに 発注書番号・商品名・色・サイズ・発注数量・納品済み・未納 の7列で見る。
// 数量確定前の行は「発注数量」と「未納」が「数量未確定」。権限は窓口と DB が守り、この部品は返事の状態で出し分ける。
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/Button/Button';
import { adminLoadFailureMessage } from '@/lib/admin/admin-load-failure';
import { clientFetch } from '@/lib/client-fetch';
import {
  parsePurchaseOrderListRow,
  PURCHASE_ORDER_LIST_TEXT,
  type PurchaseOrderListRow,
} from '@/lib/purchase-orders/purchase-order-types';

const LIMIT = 20;
const HEADINGS = ['発注書番号', '商品名', '色', 'サイズ', '発注数量', '納品済み', '未納'] as const;
const HEADING_ID = 'purchase-order-list-heading';
const HEAD_CELL = 'sticky top-0 z-10 whitespace-nowrap border-b border-black/15 bg-white p-3 font-normal';
const NUMBER_CELL = 'p-3 text-right tabular-nums';
const SCROLL_REGION_CLASS = 'max-h-[70vh] max-w-full overflow-auto border border-black/15 focus-visible:outline-2';

type State =
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'ready'; rows: PurchaseOrderListRow[]; total: number };

/** 窓口の応答（{ rows, total, page, limit }）から行と全明細数を取る。形が崩れていれば null */
function readPage(body: unknown): { rows: PurchaseOrderListRow[]; total: number } | null {
  if (body === null || typeof body !== 'object') return null;
  const { rows, total } = body as { rows?: unknown; total?: unknown };
  if (!Array.isArray(rows) || typeof total !== 'number' || !Number.isSafeInteger(total) || total < rows.length) return null;
  // 全明細があるのに頁が空なのは、頁の指定が合っていない（読み違い）
  if (rows.length === 0 && total > 0) return null;
  try {
    return { rows: rows.map((row: unknown) => parsePurchaseOrderListRow(row)), total };
  } catch {
    return null;
  }
}

export default function PurchaseOrderListSection(): React.JSX.Element {
  const [page, setPage] = useState(1);
  const [state, setState] = useState<State>({ phase: 'loading' });

  useEffect(() => {
    let cancelled = false;
    const failed: State = { phase: 'error', message: PURCHASE_ORDER_LIST_TEXT.failed };
    void (async () => {
      try {
        const response = await clientFetch(`/api/admin/purchase-orders?limit=${LIMIT}&page=${page}`, { cache: 'no-store' });
        const body: unknown = await response.json().catch(() => null);
        if (cancelled) return;
        if (!response.ok) {
          setState({
            phase: 'error',
            message: adminLoadFailureMessage(response.status, body, PURCHASE_ORDER_LIST_TEXT.forbidden, PURCHASE_ORDER_LIST_TEXT.failed),
          });
          return;
        }
        const result = readPage(body);
        setState(result === null ? failed : { phase: 'ready', ...result });
      } catch {
        if (!cancelled) setState(failed);
      }
    })();
    return () => { cancelled = true; };
  }, [page]);

  const goTo = (next: number): void => {
    setState({ phase: 'loading' });
    setPage(next);
  };

  const from = (page - 1) * LIMIT + 1;

  return (
    <div className="w-full min-w-0 max-w-full space-y-6">
      <div className="flex flex-wrap gap-3">
        <Button href="/admin" variant="secondary">管理画面に戻る</Button>
        <Button href="/admin/inventory" variant="secondary">在庫一覧表</Button>
        <Button href="/admin/purchase-orders/documents" variant="secondary">取引書類を検索</Button>
      </div>
      <h1 id={HEADING_ID} className="lk-text-xl">{PURCHASE_ORDER_LIST_TEXT.heading}</h1>
      {state.phase === 'loading' ? <p role="status">読み込み中...</p> : null}
      {state.phase === 'error' ? <p role="alert">{state.message}</p> : null}
      {state.phase === 'ready' && state.rows.length === 0 ? <p>{PURCHASE_ORDER_LIST_TEXT.empty}</p> : null}
      {state.phase === 'ready' && state.rows.length > 0 ? (
        <>
          <div role="region" aria-labelledby={HEADING_ID} tabIndex={0} className={SCROLL_REGION_CLASS}>
            <table className="w-full min-w-[44rem] border-collapse text-left">
              <thead>
                <tr>
                  {HEADINGS.map((heading, index) => (
                    <th key={heading} scope="col" className={`${HEAD_CELL} ${index >= 4 ? 'text-right' : ''}`}>{heading}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {state.rows.map((row) => (
                  <tr key={row.lineId} data-testid="purchase-order-row" className="border-b border-black/10 align-top">
                    <td className="whitespace-nowrap p-3">
                      <Link href={`/admin/purchase-orders/${row.purchaseOrderId}`} className="underline underline-offset-4">{row.number}</Link>
                    </td>
                    <td className="break-words p-3">{row.itemName}</td>
                    <td className="break-words p-3">{row.colorName ?? '—'}</td>
                    <td className="break-words p-3">{row.sizeLabel ?? '—'}</td>
                    <td className={NUMBER_CELL}>{row.orderQuantity ?? PURCHASE_ORDER_LIST_TEXT.unconfirmed}</td>
                    <td className={NUMBER_CELL}>{row.receivedQuantity}</td>
                    <td className={NUMBER_CELL}>{row.outstandingQuantity ?? PURCHASE_ORDER_LIST_TEXT.unconfirmed}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => goTo(page - 1)}>前へ</Button>
            <span className="tabular-nums">{`${from}〜${from + state.rows.length - 1} / ${state.total}`}</span>
            <Button size="sm" variant="secondary" disabled={page * LIMIT >= state.total} onClick={() => goTo(page + 1)}>次へ</Button>
          </div>
        </>
      ) : null}
    </div>
  );
}
