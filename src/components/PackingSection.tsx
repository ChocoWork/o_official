'use client';

// File: src/components/PackingSection.tsx
// 荷作り表（G-3 / FREQ-531）。発送準備中の品物だけを、古い注文から 注文ID・注文日・顧客名・メールアドレス・商品名・色・サイズ・数量・単価 の9列で見る。
// 下に、発送票の下書きと確定済みの発送票を新しい順に最新20件ずつ出す。この段階は読むだけ（品物を選ぶ操作と「発送」は次の段階で足す）。
// 権限は窓口と DB が守り、この部品は返事の状態で出し分ける。
import { useEffect, useState } from 'react';
import Link from 'next/link';
import OrderHistoryDialog from '@/components/OrderHistoryDialog';
import { Button } from '@/components/ui/Button/Button';
import { adminLoadFailureMessage } from '@/lib/admin/admin-load-failure';
import { clientFetch } from '@/lib/client-fetch';
import { toOrderNumber } from '@/lib/orders/order-number';
import { formatYen } from '@/lib/orders/refund/refund-messages';
import {
  formatOtherSlipNotice,
  PACKING_COLUMN_HEADINGS,
  PACKING_HOLD_LABELS,
  parsePackingRow,
  parseShipmentSlipListRow,
  SHIPMENT_SLIP_LIMITS,
  SHIPMENT_SLIP_STAGE_LABELS,
  SHIPMENT_SLIP_TEXT,
  type PackingRow,
  type ShipmentSlipListRow,
  type ShipmentSlipStage,
} from '@/lib/orders/shipment-slips/shipment-slip-types';
import { SHIPPING_CARRIERS } from '@/lib/orders/shipping-carriers';

const LIMIT = SHIPMENT_SLIP_LIMITS.packingPage.limit.fallback;
const SLIP_LIMIT = SHIPMENT_SLIP_LIMITS.slipPage.limit.fallback;
const HEADING_ID = 'packing-heading';
const DRAFTS_HEADING_ID = 'packing-drafts-heading';
const CONFIRMED_HEADING_ID = 'packing-confirmed-heading';
const HEAD_CELL = 'sticky top-0 z-10 whitespace-nowrap border-b border-black/15 bg-white p-3 font-normal';
const NUMBER_CELL = 'p-3 text-right tabular-nums';
const SCROLL_REGION_CLASS = 'max-h-[70vh] max-w-full overflow-auto border border-black/15 focus-visible:outline-2';
const RIGHT_ALIGNED_COLUMNS = new Set<string>(['数量', '単価']);

const jstDay = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' });
const jstDateTime = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', dateStyle: 'medium', timeStyle: 'short' });

/** 日時を日本時間の日付にする。読めない日時はそのまま返す */
function formatOrderDay(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : jstDay.format(date);
}

/** 日時を日本時間の日付と時刻にする。読めない日時はそのまま返す */
function formatUpdatedAt(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : jstDateTime.format(date);
}

/** 日付（YYYY-MM-DD）を YYYY/MM/DD にする（日付だけの値なので時差の換算はしない） */
function formatShipmentDay(value: string): string {
  return value.replace(/-/g, '/');
}

type PackingState =
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'ready'; rows: PackingRow[]; total: number };

/** 窓口の応答（{ rows, total, page, limit }）から行と全件数を取る。形が崩れていれば null */
function readPage<T>(body: unknown, parse: (row: unknown) => T): { rows: T[]; total: number } | null {
  if (body === null || typeof body !== 'object') return null;
  const { rows, total } = body as { rows?: unknown; total?: unknown };
  if (!Array.isArray(rows) || typeof total !== 'number' || !Number.isSafeInteger(total) || total < rows.length) return null;
  // 全件があるのに頁が空なのは、頁の指定が合っていない（読み違い）
  if (rows.length === 0 && total > 0) return null;
  try {
    return { rows: rows.map((row: unknown) => parse(row)), total };
  } catch {
    return null;
  }
}

type SlipRowsResult = { ok: true; rows: ShipmentSlipListRow[] } | { ok: false; message: string };

/** 段階ごとの最新の票を読む。失敗は文にして返す（呼び手の表の外には出さない） */
async function fetchSlipRows(stage: ShipmentSlipStage): Promise<SlipRowsResult> {
  const failed: SlipRowsResult = { ok: false, message: SHIPMENT_SLIP_TEXT.slipListFailed };
  try {
    const response = await clientFetch(`/api/admin/shipment-slips?stage=${stage}&limit=${SLIP_LIMIT}&page=1`, { cache: 'no-store' });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      return {
        ok: false,
        message: adminLoadFailureMessage(response.status, body, SHIPMENT_SLIP_TEXT.slipListForbidden, SHIPMENT_SLIP_TEXT.slipListFailed),
      };
    }
    const page = readPage(body, parseShipmentSlipListRow);
    return page === null ? failed : { ok: true, rows: page.rows };
  } catch {
    return failed;
  }
}

type SlipListState =
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'ready'; rows: ShipmentSlipListRow[] };

/** 段階の組から最新の票を読み、更新の新しい順に最新 SLIP_LIMIT 件にする。1つでも読めなければ失敗の文 */
function useSlipRows(stages: readonly ShipmentSlipStage[]): SlipListState {
  const [state, setState] = useState<SlipListState>({ phase: 'loading' });
  const key = stages.join(',');

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const results = await Promise.all((key.split(',') as ShipmentSlipStage[]).map(fetchSlipRows));
      if (cancelled) return;
      const failure = results.find((result) => !result.ok);
      if (failure && !failure.ok) {
        setState({ phase: 'error', message: failure.message });
        return;
      }
      const rows = results
        .flatMap((result) => (result.ok ? result.rows : []))
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
        .slice(0, SLIP_LIMIT);
      setState({ phase: 'ready', rows });
    })();
    return () => { cancelled = true; };
  }, [key]);

  return state;
}

function SlipOpenLink({ row }: { row: ShipmentSlipListRow }): React.JSX.Element {
  return (
    <Link href={`/admin/shipment-slips/${row.id}`} aria-label={`発送票 ${row.number} を開く`} className="underline underline-offset-4">
      {SHIPMENT_SLIP_TEXT.open}
    </Link>
  );
}

/** 発送票の下書き（票番号・更新日時・注文数・数量・開く。期限切れは印を付ける） */
function DraftSlipsSection(): React.JSX.Element {
  const state = useSlipRows(['draft']);
  return (
    <section aria-labelledby={DRAFTS_HEADING_ID} className="space-y-3">
      <h2 id={DRAFTS_HEADING_ID} className="lk-text-lg">{SHIPMENT_SLIP_TEXT.draftsHeading}</h2>
      {state.phase === 'loading' ? <p role="status">読み込み中...</p> : null}
      {state.phase === 'error' ? <p role="alert">{state.message}</p> : null}
      {state.phase === 'ready' && state.rows.length === 0 ? <p>{SHIPMENT_SLIP_TEXT.slipListEmpty}</p> : null}
      {state.phase === 'ready' && state.rows.length > 0 ? (
        <div role="region" aria-labelledby={DRAFTS_HEADING_ID} tabIndex={0} className={SCROLL_REGION_CLASS}>
          <table className="w-full min-w-[32rem] border-collapse text-left">
            <thead>
              <tr>
                <th scope="col" className={HEAD_CELL}>票番号</th>
                <th scope="col" className={HEAD_CELL}>更新日時</th>
                <th scope="col" className={`${HEAD_CELL} text-right`}>注文数</th>
                <th scope="col" className={`${HEAD_CELL} text-right`}>数量</th>
                <th scope="col" className={HEAD_CELL}><span className="sr-only">操作</span></th>
              </tr>
            </thead>
            <tbody>
              {state.rows.map((row) => (
                <tr key={row.id} data-testid="packing-draft-row" className="border-b border-black/10 align-top">
                  <td className="whitespace-nowrap p-3">
                    {row.number}
                    {row.expired ? <span className="ml-2 text-[#474747]">{SHIPMENT_SLIP_TEXT.expired}</span> : null}
                  </td>
                  <td className="whitespace-nowrap p-3">{formatUpdatedAt(row.updatedAt)}</td>
                  <td className={NUMBER_CELL}>{row.orderCount}</td>
                  <td className={NUMBER_CELL}>{row.itemQuantity}</td>
                  <td className="whitespace-nowrap p-3"><SlipOpenLink row={row} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}

/** 運送会社と伝票番号の文字。番号が無ければ「伝票番号なし」 */
function trackingText(row: ShipmentSlipListRow): string {
  if (row.shippingCarrier === null || row.trackingNumber === null) return SHIPMENT_SLIP_TEXT.noTracking;
  return `${SHIPPING_CARRIERS[row.shippingCarrier].label} ${row.trackingNumber}`;
}

/** 確定済みの発送票（票番号・出荷日・運送会社と伝票番号・注文数・開く。取消済みは印を付ける） */
function ConfirmedSlipsSection(): React.JSX.Element {
  const state = useSlipRows(['confirmed', 'cancelled']);
  return (
    <section aria-labelledby={CONFIRMED_HEADING_ID} className="space-y-3">
      <h2 id={CONFIRMED_HEADING_ID} className="lk-text-lg">{SHIPMENT_SLIP_TEXT.confirmedHeading}</h2>
      {state.phase === 'loading' ? <p role="status">読み込み中...</p> : null}
      {state.phase === 'error' ? <p role="alert">{state.message}</p> : null}
      {state.phase === 'ready' && state.rows.length === 0 ? <p>{SHIPMENT_SLIP_TEXT.slipListEmpty}</p> : null}
      {state.phase === 'ready' && state.rows.length > 0 ? (
        <div role="region" aria-labelledby={CONFIRMED_HEADING_ID} tabIndex={0} className={SCROLL_REGION_CLASS}>
          <table className="w-full min-w-[36rem] border-collapse text-left">
            <thead>
              <tr>
                <th scope="col" className={HEAD_CELL}>票番号</th>
                <th scope="col" className={HEAD_CELL}>出荷日</th>
                <th scope="col" className={HEAD_CELL}>運送会社・伝票番号</th>
                <th scope="col" className={`${HEAD_CELL} text-right`}>注文数</th>
                <th scope="col" className={HEAD_CELL}><span className="sr-only">操作</span></th>
              </tr>
            </thead>
            <tbody>
              {state.rows.map((row) => (
                <tr key={row.id} data-testid="packing-confirmed-row" className="border-b border-black/10 align-top">
                  <td className="whitespace-nowrap p-3">
                    {row.number}
                    {row.stage === 'cancelled' ? <span className="ml-2 text-[#474747]">{SHIPMENT_SLIP_STAGE_LABELS.cancelled}</span> : null}
                  </td>
                  <td className="whitespace-nowrap p-3">{row.shipmentDate === null ? '—' : formatShipmentDay(row.shipmentDate)}</td>
                  <td className="break-all p-3">{trackingText(row)}</td>
                  <td className={NUMBER_CELL}>{row.orderCount}</td>
                  <td className="whitespace-nowrap p-3"><SlipOpenLink row={row} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}

/** 行の下に出す文。選べない理由（理由ごとに1行）と、別の下書きにも選ばれている通知 */
function rowNotes(row: PackingRow): string[] {
  return [
    ...row.blockedReasons.map((reason) => PACKING_HOLD_LABELS[reason]),
    ...(row.otherSlipNumbers.length > 0 ? [formatOtherSlipNotice(row.otherSlipNumbers)] : []),
  ];
}

export default function PackingSection(): React.JSX.Element {
  const [page, setPage] = useState(1);
  const [state, setState] = useState<PackingState>({ phase: 'loading' });
  const [historyOrderId, setHistoryOrderId] = useState<string | null>(null);
  // 下の発送票の一覧を出すか。荷作り表の最初の答えを待ち、権限が無い（401・403）時は出さない（同じ権限で断られる読み込みを重ねない）
  const [slipsAllowed, setSlipsAllowed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const failed: PackingState = { phase: 'error', message: SHIPMENT_SLIP_TEXT.packingFailed };
    void (async () => {
      try {
        const response = await clientFetch(`/api/admin/packing?limit=${LIMIT}&page=${page}`, { cache: 'no-store' });
        const body: unknown = await response.json().catch(() => null);
        if (cancelled) return;
        if (!response.ok) {
          setState({
            phase: 'error',
            message: adminLoadFailureMessage(response.status, body, SHIPMENT_SLIP_TEXT.packingForbidden, SHIPMENT_SLIP_TEXT.packingFailed),
          });
          if (response.status !== 401 && response.status !== 403) setSlipsAllowed(true);
          return;
        }
        const result = readPage(body, parsePackingRow);
        setSlipsAllowed(true);
        if (result !== null && result.rows.length === 0 && page > 1) {
          // 他の人の発送などで全件が減り、今の頁が範囲外になった。1頁目へ戻って読み直す（行き止まりにしない。読み込み中の表示のまま）
          setPage(1);
          return;
        }
        setState(result === null ? failed : { phase: 'ready', ...result });
      } catch {
        if (!cancelled) {
          setState(failed);
          setSlipsAllowed(true);
        }
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
    <div className="w-full min-w-0 max-w-full space-y-8">
      <div className="space-y-6">
        <div className="flex flex-wrap gap-3">
          <Button href="/admin?tab=PACKING" variant="secondary">管理画面に戻る</Button>
        </div>
        <h1 id={HEADING_ID} className="lk-text-xl">{SHIPMENT_SLIP_TEXT.packingHeading}</h1>
        <p className="lk-text-sm text-[#474747]">{SHIPMENT_SLIP_TEXT.packingDescription}</p>
        {state.phase === 'loading' ? <p role="status">読み込み中...</p> : null}
        {state.phase === 'error' ? <p role="alert">{state.message}</p> : null}
        {state.phase === 'error' && page > 1 ? (
          <div className="flex flex-wrap items-center gap-3">
            <Button size="sm" variant="secondary" onClick={() => goTo(page - 1)}>{SHIPMENT_SLIP_TEXT.previousPage}</Button>
          </div>
        ) : null}
        {state.phase === 'ready' && state.rows.length === 0 ? <p>{SHIPMENT_SLIP_TEXT.packingEmpty}</p> : null}
        {state.phase === 'ready' && state.rows.length > 0 ? (
          <>
            <div role="region" aria-labelledby={HEADING_ID} tabIndex={0} className={SCROLL_REGION_CLASS}>
              <table className="w-full min-w-[64rem] border-collapse text-left">
                <thead>
                  <tr>
                    {PACKING_COLUMN_HEADINGS.map((heading) => (
                      <th key={heading} scope="col" className={`${HEAD_CELL} ${RIGHT_ALIGNED_COLUMNS.has(heading) ? 'text-right' : ''}`}>{heading}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {state.rows.map((row) => {
                    const notes = rowNotes(row);
                    const orderNumber = toOrderNumber(row.orderId);
                    return (
                      <PackingTableRow key={row.orderItemId} notes={notes}>
                        <td className="whitespace-nowrap p-3">
                          <button
                            type="button"
                            aria-label={`${orderNumber} の履歴を開く`}
                            className="underline underline-offset-4"
                            onClick={() => setHistoryOrderId(row.orderId)}
                          >
                            {orderNumber}
                          </button>
                        </td>
                        <td className="whitespace-nowrap p-3">{formatOrderDay(row.orderCreatedAt)}</td>
                        <td className="break-words p-3">{row.customerName ?? '—'}</td>
                        <td className="break-all p-3">{row.customerEmail ?? '—'}</td>
                        <td className="break-words p-3">
                          {row.itemName}
                          {row.isExchange ? <span className="ml-2 text-[#474747]">{SHIPMENT_SLIP_TEXT.exchangeMark}</span> : null}
                        </td>
                        <td className="break-words p-3">{row.color ?? '—'}</td>
                        <td className="break-words p-3">{row.size ?? '—'}</td>
                        <td className={NUMBER_CELL}>{row.readyQuantity}</td>
                        <td className={NUMBER_CELL}>{formatYen(row.unitPrice)}</td>
                      </PackingTableRow>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => goTo(page - 1)}>{SHIPMENT_SLIP_TEXT.previousPage}</Button>
              <span className="tabular-nums">{`${from}〜${from + state.rows.length - 1} / ${state.total}`}</span>
              <Button size="sm" variant="secondary" disabled={page * LIMIT >= state.total} onClick={() => goTo(page + 1)}>{SHIPMENT_SLIP_TEXT.nextPage}</Button>
            </div>
          </>
        ) : null}
      </div>
      {slipsAllowed ? (
        <>
          <DraftSlipsSection />
          <ConfirmedSlipsSection />
        </>
      ) : null}
      <OrderHistoryDialog orderId={historyOrderId} onClose={() => setHistoryOrderId(null)} />
    </div>
  );
}

/** 1つの品物の行。選べない理由と別の下書きの通知は、行の下の1行に出す（9列ぜんぶにまたがる） */
function PackingTableRow({ notes, children }: { notes: string[]; children: React.ReactNode }): React.JSX.Element {
  return (
    <>
      <tr data-testid="packing-row" className={`align-top ${notes.length > 0 ? '' : 'border-b border-black/10'}`}>{children}</tr>
      {notes.length > 0 ? (
        <tr data-testid="packing-row-note" className="border-b border-black/10">
          <td colSpan={PACKING_COLUMN_HEADINGS.length} className="px-3 pb-3 text-[#474747]">
            {notes.map((note) => <p key={note}>{note}</p>)}
          </td>
        </tr>
      ) : null}
    </>
  );
}
