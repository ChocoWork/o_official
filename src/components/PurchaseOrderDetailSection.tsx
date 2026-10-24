'use client';

// File: src/components/PurchaseOrderDetailSection.tsx
// 発注書の詳細（G-2 / FREQ-526）。発注先・メモ・発注日・段階、明細の表、数量確定後の単価未登録・証憑未添付のバッジと発注見込額、
// 数量の履歴・受け取りの履歴・取引書類の節を読むだけで出す。操作のボタンは後続の Task が足す。
// 作成の直後は発注の画面が目印（created）つきで移してくるので、読み込んだ発注書の番号で通知を role=status で出す。
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button/Button';
import { adminLoadFailureMessage } from '@/lib/admin/admin-load-failure';
import { clientFetch } from '@/lib/client-fetch';
import {
  formatNumber,
  formatPurchaseOrderCreatedNotice,
  formatPurchaseOrderDate,
  formatPurchaseOrderDateTime,
  formatPurchaseOrderDay,
  formatYen,
  parsePurchaseOrderDetail,
  PURCHASE_ORDER_DETAIL_TEXT,
  PURCHASE_ORDER_DISPLAY_STAGE_LABELS,
  PURCHASE_ORDER_LIST_TEXT,
  PURCHASE_ORDER_RECEIPT_KIND_LABELS,
  PURCHASE_ORDER_REVISION_KIND_LABELS,
  type PurchaseOrderDetail,
  type PurchaseOrderRevision,
} from '@/lib/purchase-orders/purchase-order-types';

const LINE_HEADINGS = ['商品名', '色', 'サイズ', '仮数量', '発注数量', '納品済み', '未納', '単価（円）'] as const;
const REVISION_HEADINGS = ['版', '日時', '種類', '対象', '変更', '理由'] as const;
const REVISIONS_ID = 'purchase-order-revisions-heading';
const RECEIPTS_ID = 'purchase-order-receipts-heading';
const DOCUMENTS_ID = 'purchase-order-documents-heading';
const HEAD_CELL = 'sticky top-0 z-10 whitespace-nowrap border-b border-black/15 bg-white p-3 font-normal';
const NUMBER_CELL = 'p-3 text-right tabular-nums';
const SCROLL_REGION_CLASS = 'max-h-[70vh] max-w-full overflow-auto border border-black/15 focus-visible:outline-2';
const BADGE_CLASS = 'inline-block border border-black/30 px-2 py-0.5 lk-text-2xs';

type State =
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'ready'; detail: PurchaseOrderDetail };

type Props = {
  purchaseOrderId: string;
  /** 作成の直後の目印（?created=1）がある時だけ真。通知の番号は props ではなく、読み込んだ発注書の物を使う */
  created?: boolean;
};

/** 商品名・色・サイズ。色・サイズが無ければ有る部分だけを並べる */
function itemLabel(itemName: string, colorName: string | null, sizeLabel: string | null): string {
  return [itemName, colorName, sizeLabel].filter((part): part is string => part !== null && part !== '').join(' ');
}

/** 変更前 → 変更後。変更前が無い（最初の記録）なら変更後だけ。どちらも無ければ null */
function change(label: string, before: string | null, after: string | null): string | null {
  if (before === null && after === null) return null;
  return before === null ? `${label} ${after}` : `${label} ${before} → ${after ?? '—'}`;
}

function describeRevision(revision: PurchaseOrderRevision): string {
  const count = (value: number | null): string | null => (value === null ? null : formatNumber(value));
  const parts = [
    change('数量', count(revision.beforeQuantity), count(revision.afterQuantity)),
    change('単価', count(revision.beforeUnitPriceYen), count(revision.afterUnitPriceYen)),
    change('発注先', revision.beforeSupplierName, revision.afterSupplierName),
    change('メモ', revision.beforeMemo, revision.afterMemo),
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join('・') : '—';
}

export default function PurchaseOrderDetailSection({ purchaseOrderId, created = false }: Props): React.JSX.Element {
  const [state, setState] = useState<State>({ phase: 'loading' });

  useEffect(() => {
    let cancelled = false;
    const failed: State = { phase: 'error', message: PURCHASE_ORDER_DETAIL_TEXT.failed };
    void (async () => {
      try {
        const response = await clientFetch(`/api/admin/purchase-orders/${encodeURIComponent(purchaseOrderId)}`, { cache: 'no-store' });
        const body: unknown = await response.json().catch(() => null);
        if (cancelled) return;
        if (!response.ok) {
          setState({
            phase: 'error',
            message: response.status === 404
              ? PURCHASE_ORDER_DETAIL_TEXT.notFound
              : adminLoadFailureMessage(response.status, body, PURCHASE_ORDER_DETAIL_TEXT.forbidden, PURCHASE_ORDER_DETAIL_TEXT.failed),
          });
          return;
        }
        const raw = body !== null && typeof body === 'object' ? (body as { purchaseOrder?: unknown }).purchaseOrder : undefined;
        const detail = parsePurchaseOrderDetail(raw);
        // 頼んだ発注書以外が返った時は読み違い
        setState(detail.id === purchaseOrderId.toLowerCase() ? { phase: 'ready', detail } : failed);
      } catch {
        if (!cancelled) setState(failed);
      }
    })();
    return () => { cancelled = true; };
  }, [purchaseOrderId]);

  const detail = state.phase === 'ready' ? state.detail : null;
  const confirmed = detail?.stage === 'quantity_confirmed';
  const lineById = new Map((detail?.lines ?? []).map((line) => [line.id, line]));
  const lineLabel = (lineId: string | null): string => {
    if (lineId === null) return '発注書';
    const line = lineById.get(lineId);
    return line ? itemLabel(line.itemName, line.colorName, line.sizeLabel) : '—';
  };

  return (
    <div className="w-full min-w-0 max-w-full space-y-8">
      <Button href="/admin/purchase-orders" variant="secondary">発注一覧表に戻る</Button>
      <h1 className="lk-text-xl">{detail ? `発注書 ${detail.number}` : '発注書'}</h1>
      {state.phase === 'loading' ? <p role="status">読み込み中...</p> : null}
      {state.phase === 'error' ? <p role="alert">{state.message}</p> : null}
      {detail ? (
        <>
          {created ? <p role="status">{formatPurchaseOrderCreatedNotice(detail.number)}</p> : null}
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-2">
            <dt>発注先</dt>
            <dd className="break-words">{detail.supplierName}</dd>
            <dt>メモ</dt>
            <dd className="break-words">{detail.memo ?? '—'}</dd>
            <dt>発注日</dt>
            <dd>{formatPurchaseOrderDate(detail.orderedAt)}</dd>
            <dt>段階</dt>
            <dd>{PURCHASE_ORDER_DISPLAY_STAGE_LABELS[detail.displayStage]}</dd>
          </dl>
          {confirmed && (detail.flags.unitPriceMissing || detail.flags.documentMissing) ? (
            <div className="flex flex-wrap gap-2">
              {detail.flags.unitPriceMissing ? <span className={BADGE_CLASS}>{PURCHASE_ORDER_DETAIL_TEXT.priceMissing}</span> : null}
              {detail.flags.documentMissing ? <span className={BADGE_CLASS}>{PURCHASE_ORDER_DETAIL_TEXT.documentMissing}</span> : null}
            </div>
          ) : null}
          {confirmed && detail.estimatedAmountYen !== null ? (
            <p className="flex flex-wrap items-baseline gap-x-3">
              <span>{`発注見込額 ${formatYen(detail.estimatedAmountYen)}`}</span>
              <span className="lk-text-2xs">{PURCHASE_ORDER_DETAIL_TEXT.taxNote}</span>
            </p>
          ) : null}

          <div role="region" aria-label="明細" tabIndex={0} className={SCROLL_REGION_CLASS}>
            <table aria-label="明細" className="w-full min-w-[44rem] border-collapse text-left">
              <thead>
                <tr>
                  {LINE_HEADINGS.map((heading, index) => (
                    <th key={heading} scope="col" className={`${HEAD_CELL} ${index >= 3 ? 'text-right' : ''}`}>{heading}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {detail.lines.map((line) => (
                  <tr key={line.id} data-testid="purchase-order-line" className="border-b border-black/10 align-top">
                    <td className="break-words p-3">{line.itemName}</td>
                    <td className="break-words p-3">{line.colorName ?? '—'}</td>
                    <td className="break-words p-3">{line.sizeLabel ?? '—'}</td>
                    <td className={NUMBER_CELL}>{line.provisionalQuantity}</td>
                    <td className={NUMBER_CELL}>{line.orderQuantity ?? PURCHASE_ORDER_LIST_TEXT.unconfirmed}</td>
                    <td className={NUMBER_CELL}>{line.receivedQuantity}</td>
                    <td className={NUMBER_CELL}>{line.outstandingQuantity ?? PURCHASE_ORDER_LIST_TEXT.unconfirmed}</td>
                    <td className={NUMBER_CELL}>{line.unitPriceYen === null ? '未登録' : formatNumber(line.unitPriceYen)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <section className="space-y-3">
            <h2 id={REVISIONS_ID} className="lk-text-lg">数量の履歴</h2>
            <div role="region" aria-labelledby={REVISIONS_ID} tabIndex={0} className={SCROLL_REGION_CLASS}>
              <table aria-labelledby={REVISIONS_ID} className="w-full min-w-[44rem] border-collapse text-left">
                <thead>
                  <tr>
                    {REVISION_HEADINGS.map((heading) => (
                      <th key={heading} scope="col" className={HEAD_CELL}>{heading}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {detail.revisions.map((revision) => (
                    <tr key={revision.id} data-testid="purchase-order-revision" className="border-b border-black/10 align-top">
                      <td className={NUMBER_CELL}>{revision.revisionNo}</td>
                      <td className="whitespace-nowrap p-3">{formatPurchaseOrderDateTime(revision.createdAt)}</td>
                      <td className="p-3">{PURCHASE_ORDER_REVISION_KIND_LABELS[revision.kind]}</td>
                      <td className="break-words p-3">{lineLabel(revision.lineId)}</td>
                      <td className="break-words p-3">{describeRevision(revision)}</td>
                      <td className="break-words p-3">{revision.reason ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section aria-labelledby={RECEIPTS_ID} className="space-y-3">
            <h2 id={RECEIPTS_ID} className="lk-text-lg">受け取りの履歴</h2>
            {detail.receipts.length === 0 ? <p>受け取りの記録はありません。</p> : (
              <ul className="space-y-4">
                {detail.receipts.map((receipt) => (
                  <li key={receipt.id} className="space-y-2 border border-black/15 p-3">
                    <p>{`${formatPurchaseOrderDay(receipt.receivedOn)} ${PURCHASE_ORDER_RECEIPT_KIND_LABELS[receipt.kind]}`}</p>
                    {receipt.memo !== null ? <p className="break-words">{receipt.memo}</p> : null}
                    {receipt.reason !== null ? <p className="break-words">{`理由 ${receipt.reason}`}</p> : null}
                    <ul className="space-y-1">
                      {receipt.lines.map((line) => (
                        <li key={line.id} className="flex flex-wrap gap-x-3">
                          <span className="break-words">{lineLabel(line.lineId)}</span>
                          <span className="tabular-nums">{line.quantity > 0 ? `+${line.quantity}` : String(line.quantity)}</span>
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* 取引書類の中身（一覧・保存途中の予約・操作）は Task 8 が足す。この Task は節の見出しだけ */}
          <section aria-labelledby={DOCUMENTS_ID} className="space-y-3">
            <h2 id={DOCUMENTS_ID} className="lk-text-lg">取引書類</h2>
          </section>
        </>
      ) : null}
    </div>
  );
}
