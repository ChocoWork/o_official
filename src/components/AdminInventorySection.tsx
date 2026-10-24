'use client';

// File: src/components/AdminInventorySection.tsx
// 在庫一覧表（G-2 / FREQ-525）。商品（色・サイズ）ごとの注文数・在庫・発注済み・発注必要数を1つの表で見る。
// 読むだけの画面で、発注のボタンは持たない（発注一覧表は別の頁）。権限は窓口と DB が守り、この部品は返事の状態で出し分ける。
import { Fragment, useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button/Button';
import { adminLoadFailureMessage } from '@/lib/admin/admin-load-failure';
import { clientFetch } from '@/lib/client-fetch';
import { formatStockBreakdown, INVENTORY_LIST_TEXT, type AdminInventoryRow } from '@/lib/inventory/inventory-list-types';

const HEADINGS = ['商品名', '色', 'サイズ', '注文数', '在庫', '発注済み', '発注必要数'] as const;
const HEADING_ID = 'admin-inventory-heading';
const HEAD_CELL = 'sticky top-0 z-10 whitespace-nowrap border-b border-black/15 bg-white p-3 font-normal';
const NUMBER_CELL = 'p-3 text-right tabular-nums';

type State =
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'ready'; rows: AdminInventoryRow[] };

function isRow(value: unknown): value is AdminInventoryRow {
  if (value === null || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  const numbers = ['variantId', 'itemId', 'free', 'paidAllocated', 'paymentHeld', 'onHand', 'orderQuantity', 'onOrder', 'required'];
  return numbers.every((key) => typeof row[key] === 'number')
    && typeof row.itemName === 'string' && typeof row.isActive === 'boolean'
    && (row.colorName === null || typeof row.colorName === 'string')
    && (row.sizeLabel === null || typeof row.sizeLabel === 'string');
}

function readRows(body: unknown): AdminInventoryRow[] | null {
  if (body === null || typeof body !== 'object') return null;
  const { rows } = body as { rows?: unknown };
  return Array.isArray(rows) && rows.every(isRow) ? rows : null;
}

export default function AdminInventorySection(): React.JSX.Element {
  const [state, setState] = useState<State>({ phase: 'loading' });
  const [openIds, setOpenIds] = useState<ReadonlySet<number>>(new Set());

  useEffect(() => {
    let cancelled = false;
    const failed: State = { phase: 'error', message: INVENTORY_LIST_TEXT.screenFailed };
    void (async () => {
      try {
        const response = await clientFetch('/api/admin/inventory', { cache: 'no-store' });
        const body: unknown = await response.json().catch(() => null);
        if (cancelled) return;
        if (!response.ok) {
          setState({
            phase: 'error',
            message: adminLoadFailureMessage(response.status, body, INVENTORY_LIST_TEXT.forbidden, INVENTORY_LIST_TEXT.screenFailed),
          });
          return;
        }
        const rows = readRows(body);
        setState(rows === null ? failed : { phase: 'ready', rows });
      } catch {
        if (!cancelled) setState(failed);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const toggle = (variantId: number): void => {
    setOpenIds((current) => {
      const next = new Set(current);
      if (!next.delete(variantId)) next.add(variantId);
      return next;
    });
  };

  return (
    <div className="w-full min-w-0 max-w-full space-y-6">
      <Button href="/admin" variant="secondary">管理画面に戻る</Button>
      <h1 id={HEADING_ID} className="lk-text-xl">在庫一覧表</h1>
      {state.phase === 'loading' ? <p role="status">読み込み中...</p> : null}
      {state.phase === 'error' ? <p role="alert">{state.message}</p> : null}
      {state.phase === 'ready' && state.rows.length === 0 ? <p>{INVENTORY_LIST_TEXT.empty}</p> : null}
      {state.phase === 'ready' && state.rows.length > 0 ? (
        <div
          role="region"
          aria-labelledby={HEADING_ID}
          tabIndex={0}
          className="max-h-[70vh] max-w-full overflow-auto border border-black/15 focus-visible:outline-2"
        >
          <table className="w-full min-w-[44rem] border-collapse text-left">
            <thead>
              <tr>
                {HEADINGS.map((heading, index) => (
                  <th key={heading} scope="col" className={`${HEAD_CELL} ${index >= 3 ? 'text-right' : ''}`}>{heading}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {state.rows.map((row) => {
                const open = openIds.has(row.variantId);
                const panelId = `inventory-breakdown-${row.variantId}`;
                const nameId = `inventory-name-${row.variantId}`;
                return (
                  <Fragment key={row.variantId}>
                    <tr data-testid="inventory-row" className="border-b border-black/10 align-top">
                      <td id={nameId} className="break-words p-3">{row.itemName}</td>
                      <td className="break-words p-3">{row.colorName ?? '—'}</td>
                      <td className="break-words p-3">{row.sizeLabel ?? '—'}</td>
                      <td className={NUMBER_CELL}>{row.orderQuantity}</td>
                      <td className={NUMBER_CELL}>
                        <span>{row.onHand}</span>
                        <Button
                          variant="link"
                          size="sm"
                          className="ml-3 whitespace-nowrap"
                          aria-expanded={open}
                          aria-controls={open ? panelId : undefined}
                          aria-describedby={nameId}
                          onClick={() => toggle(row.variantId)}
                        >
                          在庫の内訳
                        </Button>
                      </td>
                      <td className={NUMBER_CELL}>{row.onOrder}</td>
                      <td className={NUMBER_CELL}>{row.required}</td>
                    </tr>
                    {open ? (
                      <tr id={panelId} className="border-b border-black/10 bg-black/5">
                        <td colSpan={HEADINGS.length} className="p-3 lk-text-sm">{formatStockBreakdown(row)}</td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
