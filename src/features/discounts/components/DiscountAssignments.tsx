'use client';

// File: src/features/discounts/components/DiscountAssignments.tsx
// 割り当ての表（グループ H / FREQ-547-AC-03）。列は コード・割り当てた人・状態・使った日・注文。20行ずつ。
// 状態は 未使用／使用済み（入金待ち）／使用済み。「外す」は未使用の行だけ（manage の人だけ）で、連打しても同じ要求番号で1回だけ送る。
// ゲストの行はサーバーが伏せたメールだけを持つ。注文は /admin/orders/[orderId] へのリンクで、読む権限はその頁が確かめる。
import Link from 'next/link';
import { useRef, useState } from 'react';
import { Button } from '@/components/ui/Button/Button';
import { clientFetch } from '@/lib/client-fetch';
import type { AdminDiscountDetail, DiscountAssignmentRow } from '@/lib/discounts/admin-discount-types';
import { DISCOUNT_PAGE_SIZE } from '@/lib/discounts/discount-types';
import {
  ASSIGNMENT_STATUS_LABELS, DISCOUNT_TEXT, createRequestKeys, drainBody, formatJst, readDiscountFailure,
} from '../discount-admin-client';
import { TABLE_HEAD_CELL } from './DiscountField';

const COLUMNS = ['コード', '割り当てた人', '状態', '使った日', '注文'] as const;
const EMPTY = '割り当てはありません。';
const UNASSIGN_FAILED = '割り当てを外せませんでした。';

function assigneeText(row: DiscountAssignmentRow): string {
  if (row.assigneeDeleted) return '退会した会員';
  if (row.assigneeName) return row.assigneeName;
  if (row.userId) return '名前のない会員';
  return row.guestEmailMasked ?? '未割り当て';
}

export default function DiscountAssignments({ detail, page, onPage, onChanged, disabled = false, loading = false, loadError = false, onRetry }: {
  detail: AdminDiscountDetail;
  page: number;
  onPage: (page: number) => void;
  onChanged: (changed?: boolean) => Promise<void>;
  /** 変更の後に最新の情報を読めなかった間は、古い表への操作を止める */
  disabled?: boolean;
  loading?: boolean;
  loadError?: boolean;
  onRetry?: () => void;
}): React.JSX.Element {
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const keys = useRef(createRequestKeys());
  const inFlight = useRef(new Set<string>());
  const totalPages = Math.max(1, Math.ceil(detail.assignmentTotal / DISCOUNT_PAGE_SIZE));
  const canManage = detail.permissions.manage && (!disabled || loading);

  const unassign = async (row: DiscountAssignmentRow): Promise<void> => {
    if (!row.userId) return;
    const signature = `unassign:${row.codeId}:${row.userId}`;
    if (inFlight.current.has(signature)) return;
    inFlight.current.add(signature);
    setBusy(new Set(inFlight.current));
    setError(null);
    try {
      const response = await clientFetch(`/api/admin/discounts/${detail.discount.id}/unassign`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ codeId: row.codeId, userId: row.userId, requestKey: keys.current.keyFor(signature) }),
      });
      if (!response.ok) {
        const failure = await readDiscountFailure(response, UNASSIGN_FAILED, DISCOUNT_TEXT.manageForbidden);
        setError(failure.message);
        if (failure.code === 'GROUP_H_ASSIGNMENT_USED') await onChanged(false);
        return;
      }
      await drainBody(response);
      keys.current.done(signature);
      await onChanged();
    } catch (caught) {
      console.error('Failed to unassign discount:', caught instanceof Error ? caught.name : 'UnknownError');
      setError(UNASSIGN_FAILED);
    } finally {
      inFlight.current.delete(signature);
      setBusy(new Set(inFlight.current));
    }
  };

  return (
    <section aria-label="割り当て" className="min-w-0 space-y-3">
      <h2 className="lk-text-lg">割り当て（{detail.assignmentTotal}件）</h2>
      {loading ? <p role="status">割り当てを読み込み中…</p> : null}
      {loadError ? <div><p role="alert">割り当てを読み込めませんでした。</p><Button variant="secondary" size="sm" onClick={onRetry}>読み直す</Button></div> : null}
      {error ? <p role="alert" className="lk-text-sm text-red-700 font-acumin">{error}</p> : null}
      {detail.assignments.length === 0 ? (
        <p className="lk-text-sm text-[#474747] font-acumin">{EMPTY}</p>
      ) : (
        <div role="region" aria-label="割り当ての表" aria-busy={loading} tabIndex={0} className="max-h-[70vh] w-full min-w-0 max-w-full overflow-auto border border-black/15 focus-visible:outline-2">
          <table className="w-full min-w-[44rem] border-collapse text-left lk-text-2xs">
            <thead>
              <tr>
                {COLUMNS.map((column) => <th key={column} scope="col" className={TABLE_HEAD_CELL}>{column}</th>)}
                {canManage ? <th scope="col" className={TABLE_HEAD_CELL}><span className="sr-only">操作</span></th> : null}
              </tr>
            </thead>
            <tbody>
              {detail.assignments.map((row) => {
                const signature = row.userId ? `unassign:${row.codeId}:${row.userId}` : '';
                return (
                  <tr key={row.rowId} data-testid="assignment-row" className="border-b border-black/10 align-top">
                    <td className="break-all p-3 font-mono">{row.code}</td>
                    <td className="break-all p-3">{assigneeText(row)}</td>
                    <td className="whitespace-nowrap p-3">{ASSIGNMENT_STATUS_LABELS[row.status]}</td>
                    <td className="whitespace-nowrap p-3">{row.usedAt ? formatJst(row.usedAt) : '—'}</td>
                    <td className="whitespace-nowrap p-3">
                      {row.orderId ? <Link href={`/admin/orders/${row.orderId}`} className="underline underline-offset-4">注文を見る</Link> : '—'}
                    </td>
                    {canManage ? (
                      <td className="whitespace-nowrap p-3">
                        {!disabled && row.status === 'unused' && row.userId ? (
                          <Button variant="secondary" size="sm" className="font-acumin" disabled={busy.has(signature)} onClick={() => void unassign(row)}>外す</Button>
                        ) : null}
                      </td>
                    ) : null}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-3 lk-text-3xs font-acumin">
        <Button variant="secondary" size="sm" className="font-acumin" disabled={loading || page <= 1} onClick={() => onPage(page - 1)}>前の頁</Button>
        <span className="tabular-nums">{page} / {totalPages}ページ</span>
        <Button variant="secondary" size="sm" className="font-acumin" disabled={loading || page >= totalPages} onClick={() => onPage(page + 1)}>次の頁</Button>
      </div>
    </section>
  );
}
