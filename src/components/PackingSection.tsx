'use client';

// File: src/components/PackingSection.tsx
// 荷作り表（G-3 / FREQ-531）。発送準備中の品物だけを、古い注文から 選択欄・注文ID・注文日・顧客名・メールアドレス・商品名・色・サイズ・数量・単価 で見る。
// 品物を選び（1行目を選ぶと、同じお客様・同じ配送先の行だけ選べる）、「発送」で発送票の下書きを作って票の頁へ移る。
// 下に、発送票の下書きと確定済みの発送票を新しい順に最新20件ずつ出す。
// 権限は窓口と DB が守り、この部品は返事で出し分ける（荷作り表の答えの canManage が false の人には、最初の描画から選択欄と「発送」を出さず権限の文を1回出す。
// 答えの後で権限が外れた人は、「発送」の返事が権限の不足の 403 だった時に同じ形へ片付ける。CSRF の失敗・MFA の 403 は権限の不足にしない）。
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/Button/Button';
import { useShipmentSlipWrite } from '@/hooks/useShipmentSlipWrite';
import { toOrderNumber } from '@/lib/orders/order-number';
import { formatYen } from '@/lib/orders/refund/refund-messages';
import { fetchPacking, fetchShipmentSlips, submitSlipDraft } from '@/lib/orders/shipment-slips/shipment-slip-client';
import { rememberSlipNotice } from '@/lib/orders/shipment-slips/shipment-slip-notice';
import {
  formatOtherSlipNotice,
  PACKING_COLUMN_HEADINGS,
  PACKING_HOLD_LABELS,
  SHIPMENT_SLIP_LIMITS,
  SHIPMENT_SLIP_STAGE_LABELS,
  SHIPMENT_SLIP_TEXT,
  type PackingRow,
  type ShipmentSlipDraftLine,
  type ShipmentSlipListRow,
  type ShipmentSlipStage,
} from '@/lib/orders/shipment-slips/shipment-slip-types';
import { SHIPPING_CARRIERS } from '@/lib/orders/shipping-carriers';
import { DELIVERY_FORM_TEXT } from '@/lib/orders/tracking/delivery-client';

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
  | { phase: 'ready'; rows: PackingRow[]; total: number; canManage: boolean };

type SlipRowsResult = { ok: true; rows: ShipmentSlipListRow[] } | { ok: false; message: string };

/** 段階ごとの最新の票を読む。失敗は文にして返す（呼び手の表の外には出さない） */
async function fetchSlipRows(stage: ShipmentSlipStage): Promise<SlipRowsResult> {
  const result = await fetchShipmentSlips({ stage, limit: SLIP_LIMIT, page: 1 });
  return result.kind === 'ok' ? { ok: true, rows: result.data.rows } : { ok: false, message: result.message };
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

/** 行の下に出す文。選べない理由（理由ごとに1行）、別の下書きにも選ばれている通知、同梱できない行の案内 */
function rowNotes(row: PackingRow, mismatch: boolean): string[] {
  return [
    ...row.blockedReasons.map((reason) => PACKING_HOLD_LABELS[reason]),
    ...(row.otherSlipNumbers.length > 0 ? [formatOtherSlipNotice(row.otherSlipNumbers)] : []),
    ...(mismatch ? [SHIPMENT_SLIP_TEXT.bundleHint] : []),
  ];
}

/** 「商品名 色 サイズ」。色・サイズが無ければ省く（選択欄・送る数の名前に使う） */
function rowLabel(row: PackingRow): string {
  return [row.itemName, row.color, row.size].filter((part): part is string => Boolean(part)).join(' ');
}

/** 選んだ行。quantity は入力の文字（検査は送る時）。row は選んだ時の行（1行目の bundleKey を同梱の基準にする） */
type Pick = { row: PackingRow; quantity: string };

/** 送る数の入力が、1〜準備中の数の整数か */
function isValidQuantity(quantity: string, max: number): boolean {
  return /^[0-9]{1,5}$/.test(quantity) && Number(quantity) >= SHIPMENT_SLIP_LIMITS.quantity.min && Number(quantity) <= Math.min(max, SHIPMENT_SLIP_LIMITS.quantity.max);
}

export default function PackingSection(): React.JSX.Element {
  const router = useRouter();
  const write = useShipmentSlipWrite();
  const [page, setPage] = useState(1);
  const [state, setState] = useState<PackingState>({ phase: 'loading' });
  // 下の発送票の一覧を出すか。荷作り表の最初の答えを待ち、権限が無い（401・403）時は出さない（同じ権限で断られる読み込みを重ねない）
  const [slipsAllowed, setSlipsAllowed] = useState(false);
  // 選んだ行（選んだ順。頁をまたいでも残る）。操作の権限が無い（答えの canManage が false、または「発送」の返事が権限の不足の 403）時は、
  // 選択欄と「発送」を出さず権限の文を1回出す
  const [picks, setPicks] = useState<Pick[]>([]);
  const [forbiddenByWrite, setForbiddenByWrite] = useState(false);
  const operable = !forbiddenByWrite && (state.phase !== 'ready' || state.canManage);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await fetchPacking({ limit: LIMIT, page });
      if (cancelled) return;
      if (result.kind === 'error') {
        setState({ phase: 'error', message: result.message });
        if (!result.denied) setSlipsAllowed(true);
        return;
      }
      setSlipsAllowed(true);
      if (result.data.rows.length === 0 && page > 1) {
        // 他の人の発送などで全件が減り、今の頁が範囲外になった。1頁目へ戻って読み直す（行き止まりにしない。読み込み中の表示のまま）
        setPage(1);
        return;
      }
      setState({ phase: 'ready', ...result.data });
    })();
    return () => { cancelled = true; };
  }, [page]);

  const goTo = (next: number): void => {
    setState({ phase: 'loading' });
    setPage(next);
  };

  const from = (page - 1) * LIMIT + 1;

  // 1行目の bundleKey が同梱の基準。基準と違う行・bundleKey が無い行は選べない（全部外すと戻る）
  const anchorKey = picks.length > 0 ? picks[0].row.bundleKey : null;
  const pickedIds = new Set(picks.map((pick) => pick.row.orderItemId));
  const isMismatch = (row: PackingRow): boolean =>
    picks.length > 0 && !pickedIds.has(row.orderItemId) && (row.bundleKey === null || row.bundleKey !== anchorKey);
  const locked = write.sending || write.uncertain;
  const canShip = picks.length > 0 && picks.every((pick) => isValidQuantity(pick.quantity, pick.row.shippableQuantity)) && !locked;

  const toggle = (row: PackingRow): void => {
    setPicks((current) => (current.some((pick) => pick.row.orderItemId === row.orderItemId)
      ? current.filter((pick) => pick.row.orderItemId !== row.orderItemId)
      : [...current, { row, quantity: String(row.shippableQuantity) }]));
  };
  const setQuantity = (orderItemId: string, quantity: string): void => {
    setPicks((current) => current.map((pick) => (pick.row.orderItemId === orderItemId ? { ...pick, quantity } : pick)));
  };

  const ship = (): void => {
    if (!canShip) return;
    const lines: ShipmentSlipDraftLine[] = picks.map((pick) => ({ orderItemId: pick.row.orderItemId, quantity: Number(pick.quantity) }));
    write.run(
      JSON.stringify(lines),
      (requestKey) => submitSlipDraft(null, { lines, requestKey }),
      (result) => {
        if (result.kind === 'ok') {
          rememberSlipNotice(result.data.id);
          router.push(`/admin/shipment-slips/${result.data.id}`);
        } else if (result.kind === 'blocked' && result.forbidden === true) {
          setForbiddenByWrite(true);
          setPicks([]);
          write.clearMessage();
        }
      },
    );
  };

  const columnCount = PACKING_COLUMN_HEADINGS.length + (operable ? 1 : 0);

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
                    {operable ? (
                      <th scope="col" className={HEAD_CELL}><span className="sr-only">{SHIPMENT_SLIP_TEXT.selectHeading}</span></th>
                    ) : null}
                    {PACKING_COLUMN_HEADINGS.map((heading) => (
                      <th key={heading} scope="col" className={`${HEAD_CELL} ${RIGHT_ALIGNED_COLUMNS.has(heading) ? 'text-right' : ''}`}>{heading}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {state.rows.map((row) => {
                    const mismatch = operable && isMismatch(row);
                    const notes = rowNotes(row, mismatch);
                    const orderNumber = toOrderNumber(row.orderId);
                    const pick = picks.find((candidate) => candidate.row.orderItemId === row.orderItemId);
                    const quantityValid = pick !== undefined && isValidQuantity(pick.quantity, row.readyQuantity);
                    return (
                      <PackingTableRow key={row.orderItemId} notes={notes} columnCount={columnCount}>
                        {operable ? (
                          <td className="p-3">
                            <input
                              type="checkbox"
                              aria-label={`${rowLabel(row)} を選ぶ`}
                              checked={pick !== undefined}
                              disabled={row.blockedReasons.length > 0 || mismatch || locked}
                              onChange={() => toggle(row)}
                            />
                          </td>
                        ) : null}
                        <td className="whitespace-nowrap p-3">
                          <Link href={`/admin/orders/${row.orderId}`} className="underline underline-offset-4">
                            {orderNumber}
                          </Link>
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
                        <td className={NUMBER_CELL}>
                          {row.readyQuantity}
                          {pick !== undefined ? (
                            <label className="mt-2 block text-left lk-text-2xs text-[#474747]">
                              {SHIPMENT_SLIP_TEXT.sendQuantity}
                              <input
                                type="number"
                                inputMode="numeric"
                                aria-label={`${rowLabel(row)} の送る数`}
                                min={SHIPMENT_SLIP_LIMITS.quantity.min}
                                max={row.readyQuantity}
                                step={1}
                                value={pick.quantity}
                                disabled={locked}
                                aria-invalid={!quantityValid}
                                onChange={(event) => setQuantity(row.orderItemId, event.target.value)}
                                className="mt-1 block w-24 border border-black/20 bg-white px-2 py-1 text-right tabular-nums text-black"
                              />
                            </label>
                          ) : null}
                        </td>
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
        {state.phase === 'ready' && !operable ? <p>{SHIPMENT_SLIP_TEXT.createForbidden}</p> : null}
        {state.phase === 'ready' && operable && state.rows.length > 0 ? (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-3">
              <Button type="button" disabled={!canShip} onClick={ship}>{SHIPMENT_SLIP_TEXT.ship}</Button>
              {write.sending ? <span role="status">{DELIVERY_FORM_TEXT.saving}</span> : null}
            </div>
            {write.message !== null ? <p role="alert">{write.message}</p> : null}
            {write.uncertain ? (
              <div className="space-y-2">
                <p role="alert">{DELIVERY_FORM_TEXT.unknown}</p>
                <Button type="button" variant="secondary" disabled={write.sending} onClick={write.checkAgain}>{DELIVERY_FORM_TEXT.checkAgain}</Button>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
      {slipsAllowed ? (
        <>
          <DraftSlipsSection />
          <ConfirmedSlipsSection />
        </>
      ) : null}
    </div>
  );
}

/** 1つの品物の行。選べない理由・別の下書きの通知・同梱できない行の案内は、行の下の1行に出す（表の全部の列にまたがる） */
function PackingTableRow({ notes, columnCount, children }: { notes: string[]; columnCount: number; children: React.ReactNode }): React.JSX.Element {
  return (
    <>
      <tr data-testid="packing-row" className={`align-top ${notes.length > 0 ? '' : 'border-b border-black/10'}`}>{children}</tr>
      {notes.length > 0 ? (
        <tr data-testid="packing-row-note" className="border-b border-black/10">
          <td colSpan={columnCount} className="px-3 pb-3 text-[#474747]">
            {notes.map((note) => <p key={note}>{note}</p>)}
          </td>
        </tr>
      ) : null}
    </>
  );
}
