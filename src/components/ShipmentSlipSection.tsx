'use client';

// File: src/components/ShipmentSlipSection.tsx
// 発送票の頁（G-3 / FREQ-531・FREQ-532・FREQ-533）。下書きの表示・編集と発送確定:
// 「同梱する品物」の表（行を外す）、「品物を追加」（同梱できる候補だけ）、「送り先」、「下書きを破棄」。
// 品物の外す・追加は、選択の全部を送って丸ごと入れ替える（版が違えば断られ、読み直しても入力は保つ）。
// 発送票確認と確定、確定済みの票の取消（ShipmentSlipCancelDialog）を扱う。確定後の訂正は後の段階で足す。
// 権限は窓口と DB が守り、この部品は返事の状態で出し分ける。
import { useEffect, useState } from 'react';
import ShipmentSlipCancelDialog from '@/components/ShipmentSlipCancelDialog';
import { Button } from '@/components/ui/Button/Button';
import { Dialog } from '@/components/ui/Dialog/Dialog';
import { useShipmentSlipWrite, type SlipWriteResult } from '@/hooks/useShipmentSlipWrite';
import { toOrderNumber } from '@/lib/orders/order-number';
import { fetchPacking, fetchShipmentSlip, submitSlipConfirm, submitSlipDiscard, submitSlipDraft } from '@/lib/orders/shipment-slips/shipment-slip-client';
import { takeSlipNotice } from '@/lib/orders/shipment-slips/shipment-slip-notice';
import {
  formatSlipHeading,
  SHIPMENT_SLIP_ISSUE_TEXT,
  SHIPMENT_SLIP_STAGE_LABELS,
  SHIPMENT_SLIP_TEXT,
  SLIP_LINE_COLUMN_HEADINGS,
  type PackingRow,
  type ShipmentSlipDetail,
  type ShipmentSlipDetailLine,
  type ShipmentSlipDraftLine,
} from '@/lib/orders/shipment-slips/shipment-slip-types';
import { SHIPPING_CARRIERS, SHIPPING_CARRIER_IDS, type ShippingCarrierId } from '@/lib/orders/shipping-carriers';
import { DELIVERY_STATUS_LABELS } from '@/lib/orders/tracking/delivery-messages';
import { DELIVERY_FORM_TEXT } from '@/lib/orders/tracking/delivery-client';
import { formatPurchaseOrderDateTime } from '@/lib/purchase-orders/purchase-order-types';

const HEAD_CELL = 'sticky top-0 z-10 whitespace-nowrap border-b border-black/15 bg-white p-3 font-normal';
const NUMBER_CELL = 'p-3 text-right tabular-nums';
const SCROLL_REGION_CLASS = 'max-h-[70vh] max-w-full overflow-auto border border-black/15 focus-visible:outline-2';
const RIGHT_ALIGNED_COLUMNS = new Set<string>(['送る数', '今の準備中の数']);
const LINES_HEADING_ID = 'slip-lines-heading';
const ADD_HEADING_ID = 'slip-add-heading';
const SHIP_TO_HEADING_ID = 'slip-ship-to-heading';
/** 候補を読む1回の件数と、頁の上限（読み続けて止まらないための歯止め） */
const CANDIDATE_LIMIT = 100;
const CANDIDATE_MAX_PAGES = 10;

type SlipState =
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'ready'; slip: ShipmentSlipDetail };

type CandidateState =
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'ready'; rows: PackingRow[] };

/** 「商品名 色 サイズ」。色・サイズが無ければ省く */
function lineLabel(line: { itemName: string; color: string | null; size: string | null }): string {
  return [line.itemName, line.color, line.size].filter((part): part is string => Boolean(part)).join(' ');
}

/** 行に付く問題の文（同じ文は1回）。票全体の問題は含めない */
function issueTextsFor(slip: ShipmentSlipDetail, orderItemId: string): string[] {
  const texts = slip.issues.filter((issue) => issue.orderItemId === orderItemId).map((issue) => SHIPMENT_SLIP_ISSUE_TEXT[issue.code]);
  return [...new Set(texts)];
}

export default function ShipmentSlipSection({ slipId }: { slipId: string }): React.JSX.Element {
  const write = useShipmentSlipWrite();
  const [state, setState] = useState<SlipState>({ phase: 'loading' });
  const [reloadKey, setReloadKey] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  // 画面の中で止めた時の断りの文（最後の1行を外そうとした時。窓口へは送らない）
  const [localMessage, setLocalMessage] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [carrier, setCarrier] = useState<ShippingCarrierId | ''>('');
  const [trackingNumber, setTrackingNumber] = useState('');
  const [shipmentDate, setShipmentDate] = useState(() => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(new Date()));
  const [notifyCustomer, setNotifyCustomer] = useState(true);
  const [candidates, setCandidates] = useState<CandidateState>({ phase: 'loading' });
  // 追加するために選んだ候補（明細 ID）。外す・追加が断られても保つ
  const [picked, setPicked] = useState<string[]>([]);

  // 荷作り表から移ってきた直後の通知（1回だけ）
  useEffect(() => {
    if (takeSlipNotice(slipId)) setNotice(SHIPMENT_SLIP_TEXT.draftSaved);
  }, [slipId]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await fetchShipmentSlip(slipId);
      if (cancelled) return;
      setState(result.kind === 'ok' ? { phase: 'ready', slip: result.data } : { phase: 'error', message: result.message });
    })();
    return () => { cancelled = true; };
  }, [slipId, reloadKey]);

  // 追加の候補: この下書きに同梱できる行（bundleOk）で、まだ選んでいない、選べる行だけ。版が進んだら読み直す
  const draftVersion = state.phase === 'ready' && state.slip.stage === 'draft' ? state.slip.version : null;
  useEffect(() => {
    if (draftVersion === null) return;
    let cancelled = false;
    void (async () => {
      const collected: PackingRow[] = [];
      for (let page = 1; page <= CANDIDATE_MAX_PAGES; page += 1) {
        const result = await fetchPacking({ slipId, limit: CANDIDATE_LIMIT, page });
        if (cancelled) return;
        if (result.kind === 'error') {
          setCandidates({ phase: 'error', message: result.message });
          return;
        }
        collected.push(...result.data.rows);
        if (result.data.rows.length === 0 || collected.length >= result.data.total) break;
      }
      setCandidates({
        phase: 'ready',
        rows: collected.filter((row) => row.bundleOk && row.selectedQuantity === null && row.blockedReasons.length === 0),
      });
    })();
    return () => { cancelled = true; };
  }, [slipId, draftVersion]);

  const reload = (): void => setReloadKey((current) => current + 1);

  if (state.phase === 'loading') return <p role="status">{SHIPMENT_SLIP_TEXT.loading}</p>;
  if (state.phase === 'error') {
    return (
      <div className="space-y-6">
        <Button href="/admin/packing" variant="secondary">{SHIPMENT_SLIP_TEXT.slipBack}</Button>
        <p role="alert">{state.message}</p>
      </div>
    );
  }

  const { slip } = state;
  const isDraft = slip.stage === 'draft';
  const locked = write.sending || write.uncertain;
  const slipIssues = [...new Set(slip.issues.filter((issue) => issue.orderItemId === null).map((issue) => SHIPMENT_SLIP_ISSUE_TEXT[issue.code]))];
  const candidateRows = candidates.phase === 'ready' ? candidates.rows : [];
  const pickedRows = candidateRows.filter((row) => picked.includes(row.orderItemId));

  /** 外す・追加の結果。成功なら通知して読み直し、断られても読み直す（入力は保つ）。結果不明は読み直さず「もう一度確かめる」を待つ */
  const afterEdit = (result: SlipWriteResult): void => {
    if (result.kind === 'ok') {
      setNotice(SHIPMENT_SLIP_TEXT.draftSaved);
      setPicked([]);
      reload();
    } else if (result.kind === 'refused') {
      setNotice(null);
      reload();
    }
  };

  const replaceLines = (lines: ShipmentSlipDraftLine[]): void => {
    setNotice(null);
    setLocalMessage(null);
    write.run(
      JSON.stringify({ version: slip.version, lines }),
      (requestKey) => submitSlipDraft(slip.id, { expectedVersion: slip.version, lines, requestKey }),
      afterEdit,
    );
  };

  const currentLines = (): ShipmentSlipDraftLine[] => slip.lines.map((line) => ({ orderItemId: line.orderItemId, quantity: line.quantity }));
  const removeLine = (line: ShipmentSlipDetailLine): void => {
    const remaining = currentLines().filter((existing) => existing.orderItemId !== line.orderItemId);
    if (remaining.length === 0) {
      // 品物が0行の下書きは作れない（DB も断る）。送らずに、票を破棄するか品物を追加するかを促す文を出す
      setNotice(null);
      write.clearMessage();
      setLocalMessage(SHIPMENT_SLIP_TEXT.emptyLines);
      return;
    }
    replaceLines(remaining);
  };
  const addPicked = (): void => {
    replaceLines([...currentLines(), ...pickedRows.map((row) => ({ orderItemId: row.orderItemId, quantity: row.shippableQuantity }))]);
  };
  const togglePicked = (orderItemId: string): void => {
    setPicked((current) => (current.includes(orderItemId) ? current.filter((id) => id !== orderItemId) : [...current, orderItemId]));
  };

  const discard = (): void => {
    setNotice(null);
    setLocalMessage(null);
    write.run(
      `discard:${slip.version}`,
      (requestKey) => submitSlipDiscard(slip.id, { expectedVersion: slip.version, requestKey }),
      (result) => {
        setConfirmOpen(false);
        if (result.kind === 'ok' || result.kind === 'refused') reload();
      },
    );
  };

  const confirmShipment = (): void => {
    const body = { expectedVersion: slip.version, carrier: carrier || null, trackingNumber: trackingNumber.trim() || null, shipmentDate, notifyCustomer };
    setNotice(null);
    write.run(`confirm:${JSON.stringify(body)}`, (requestKey) => submitSlipConfirm(slip.id, { ...body, requestKey }), (result) => {
      if (result.kind === 'ok') {
        setNotice('発送を確定しました。');
        setReviewing(false);
        reload();
      } else if (result.kind === 'refused') {
        setReviewing(false);
        setState({ phase: 'loading' });
        reload();
      }
    });
  };
  const checkShipment = (): void => {
    if ((carrier === '') !== (trackingNumber.trim() === '')) {
      setLocalMessage('運送会社と伝票番号は、両方入れるか両方空にしてください。');
      return;
    }
    if (!shipmentDate || (trackingNumber.trim() && !/^[0-9A-Za-z-]{1,64}$/.test(trackingNumber.trim()))) {
      setLocalMessage('入力を確かめてください。'); return;
    }
    setLocalMessage(null); write.clearMessage(); setReviewing(true);
  };

  return (
    <div className="w-full min-w-0 max-w-full space-y-8">
      <div className="flex flex-wrap gap-3">
        <Button href="/admin/packing" variant="secondary">{SHIPMENT_SLIP_TEXT.slipBack}</Button>
      </div>
      <div className="space-y-2">
        <h1 className="lk-text-xl">{formatSlipHeading(slip.number)}</h1>
        <p data-testid="slip-stage">
          {SHIPMENT_SLIP_STAGE_LABELS[slip.stage]}
          {slip.expired ? <span className="ml-2 text-[#474747]">{SHIPMENT_SLIP_TEXT.expired}</span> : null}
        </p>
      </div>
      {notice !== null ? <p role="status">{notice}</p> : null}
      {localMessage !== null ? <p role="alert">{localMessage}</p> : null}
      {write.message !== null ? <p role="alert">{write.message}</p> : null}
      {write.uncertain ? (
        <div className="space-y-2">
          <p role="alert">{DELIVERY_FORM_TEXT.unknown}</p>
          <div className="flex flex-wrap gap-3">
            <Button type="button" variant="secondary" disabled={write.sending} onClick={write.checkAgain}>{DELIVERY_FORM_TEXT.checkAgain}</Button>
            <Button
              type="button"
              variant="secondary"
              disabled={write.sending}
              onClick={() => { write.forget(); setConfirmOpen(false); reload(); }}
            >
              {DELIVERY_FORM_TEXT.back}
            </Button>
          </div>
        </div>
      ) : null}

      {!reviewing ? <section aria-labelledby={LINES_HEADING_ID} className="space-y-3">
        <h2 id={LINES_HEADING_ID} className="lk-text-lg">{SHIPMENT_SLIP_TEXT.linesHeading}</h2>
        {slipIssues.length > 0 ? (
          <div className="space-y-1" data-testid="slip-issues">
            {slipIssues.map((text) => <p key={text}>{text}</p>)}
          </div>
        ) : null}
        <div role="region" aria-labelledby={LINES_HEADING_ID} tabIndex={0} className={SCROLL_REGION_CLASS}>
          <table className="w-full min-w-[56rem] border-collapse text-left">
            <thead>
              <tr>
                {SLIP_LINE_COLUMN_HEADINGS.map((heading) => (
                  <th key={heading} scope="col" className={`${HEAD_CELL} ${RIGHT_ALIGNED_COLUMNS.has(heading) ? 'text-right' : ''}`}>{heading}</th>
                ))}
                {isDraft ? <th scope="col" className={HEAD_CELL}><span className="sr-only">操作</span></th> : null}
              </tr>
            </thead>
            <tbody>
              {slip.lines.map((line) => {
                const notes = isDraft ? issueTextsFor(slip, line.orderItemId) : [];
                return (
                  <SlipLineRow key={line.orderItemId} notes={notes} columnCount={SLIP_LINE_COLUMN_HEADINGS.length + (isDraft ? 1 : 0)}>
                    <td className="whitespace-nowrap p-3">{toOrderNumber(line.orderId)}</td>
                    <td className="break-words p-3">{slip.shipTo.fullName}</td>
                    <td className="break-words p-3">
                      {line.itemName}
                      {line.isExchange ? <span className="ml-2 text-[#474747]">{SHIPMENT_SLIP_TEXT.exchangeMark}</span> : null}
                    </td>
                    <td className="break-words p-3">{line.color ?? '—'}</td>
                    <td className="break-words p-3">{line.size ?? '—'}</td>
                    <td className={NUMBER_CELL}>{line.quantity}</td>
                    <td className={NUMBER_CELL}>{line.readyQuantity}</td>
                    {isDraft ? (
                      <td className="whitespace-nowrap p-3">
                        <Button type="button" size="sm" variant="secondary" disabled={locked} onClick={() => removeLine(line)}>
                          {SHIPMENT_SLIP_TEXT.removeLine}
                        </Button>
                      </td>
                    ) : null}
                  </SlipLineRow>
                );
              })}
            </tbody>
          </table>
        </div>
      </section> : null}

      {isDraft && !reviewing ? (
        <section aria-labelledby={ADD_HEADING_ID} className="space-y-3">
          <h2 id={ADD_HEADING_ID} className="lk-text-lg">{SHIPMENT_SLIP_TEXT.addHeading}</h2>
          {candidates.phase === 'loading' ? <p role="status">{SHIPMENT_SLIP_TEXT.loading}</p> : null}
          {candidates.phase === 'error' ? <p role="alert">{candidates.message}</p> : null}
          {candidates.phase === 'ready' && candidateRows.length === 0 ? <p>{SHIPMENT_SLIP_TEXT.addEmpty}</p> : null}
          {candidates.phase === 'ready' && candidateRows.length > 0 ? (
            <>
              <div role="region" aria-labelledby={ADD_HEADING_ID} tabIndex={0} className={SCROLL_REGION_CLASS}>
                <table className="w-full min-w-[40rem] border-collapse text-left">
                  <thead>
                    <tr>
                      <th scope="col" className={HEAD_CELL}><span className="sr-only">{SHIPMENT_SLIP_TEXT.selectHeading}</span></th>
                      <th scope="col" className={HEAD_CELL}>注文ID</th>
                      <th scope="col" className={HEAD_CELL}>商品名</th>
                      <th scope="col" className={HEAD_CELL}>色</th>
                      <th scope="col" className={HEAD_CELL}>サイズ</th>
                      <th scope="col" className={`${HEAD_CELL} text-right`}>数量</th>
                    </tr>
                  </thead>
                  <tbody>
                    {candidateRows.map((row) => (
                      <tr key={row.orderItemId} data-testid="slip-candidate-row" className="border-b border-black/10 align-top">
                        <td className="p-3">
                          <input
                            type="checkbox"
                            aria-label={`${lineLabel(row)} を選ぶ`}
                            checked={picked.includes(row.orderItemId)}
                            disabled={locked}
                            onChange={() => togglePicked(row.orderItemId)}
                          />
                        </td>
                        <td className="whitespace-nowrap p-3">{toOrderNumber(row.orderId)}</td>
                        <td className="break-words p-3">
                          {row.itemName}
                          {row.isExchange ? <span className="ml-2 text-[#474747]">{SHIPMENT_SLIP_TEXT.exchangeMark}</span> : null}
                        </td>
                        <td className="break-words p-3">{row.color ?? '—'}</td>
                        <td className="break-words p-3">{row.size ?? '—'}</td>
                        <td className={NUMBER_CELL}>{row.shippableQuantity}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Button type="button" disabled={pickedRows.length === 0 || locked} onClick={addPicked}>{SHIPMENT_SLIP_TEXT.addButton}</Button>
            </>
          ) : null}
        </section>
      ) : null}

      {isDraft && reviewing ? (
        <section aria-labelledby="shipment-review-heading" className="space-y-4">
          <h2 id="shipment-review-heading" className="lk-text-lg">発送票の確認</h2>
          {[...new Set(slip.lines.map((line) => line.orderId))].map((orderId) => (
            <div key={orderId} className="space-y-2">
              <h3>注文 {toOrderNumber(orderId)}</h3>
              <ul>{slip.lines.filter((line) => line.orderId === orderId).map((line) => <li key={line.orderItemId}>{lineLabel(line)} ×{line.quantity}</li>)}</ul>
            </div>
          ))}
        </section>
      ) : null}

      <section aria-labelledby={SHIP_TO_HEADING_ID} className="space-y-2">
        <h2 id={SHIP_TO_HEADING_ID} className="lk-text-lg">{SHIPMENT_SLIP_TEXT.shipToHeading}</h2>
        <div className="space-y-1" data-testid="slip-ship-to">
          <p>{slip.shipTo.fullName}</p>
          <p>{slip.shipTo.postalCode}</p>
          <p>{`${slip.shipTo.prefecture}${slip.shipTo.city}${slip.shipTo.address}`}</p>
          {slip.shipTo.building !== null ? <p>{slip.shipTo.building}</p> : null}
          <p>{slip.shipTo.phone}</p>
        </div>
      </section>

      {isDraft ? (
        <section aria-labelledby="shipment-package-heading" className="space-y-3">
          <h2 id="shipment-package-heading" className="lk-text-lg">荷物の情報</h2>
          {reviewing ? <div className="space-y-2">
            <p>運送会社: {carrier ? SHIPPING_CARRIERS[carrier].label : '未定'}</p>
            <p>伝票番号: {trackingNumber.trim() || '伝票番号なし'}</p>
            <p>出荷日: {shipmentDate}</p>
            <p>お客様に発送のメールを送る: {notifyCustomer ? 'はい' : 'いいえ'}</p>
            <div className="flex flex-wrap gap-3">
              <Button type="button" disabled={locked || slip.issues.length > 0 || slip.expired} onClick={confirmShipment}>発送確定</Button>
              <Button type="button" variant="secondary" disabled={locked} onClick={() => setReviewing(false)}>戻る</Button>
            </div>
          </div> : <div className="space-y-3">
            <label className="block">運送会社
              <select value={carrier} disabled={locked} onChange={(event) => setCarrier(event.target.value as ShippingCarrierId | '')} className="block max-w-full border border-black/30 p-2">
                <option value="">未定</option>
                {SHIPPING_CARRIER_IDS.map((id) => <option key={id} value={id}>{SHIPPING_CARRIERS[id].label}</option>)}
              </select>
            </label>
            <label className="block">伝票番号<input value={trackingNumber} disabled={locked} maxLength={64} onChange={(event) => setTrackingNumber(event.target.value)} className="block max-w-full border border-black/30 p-2" /></label>
            <label className="block">出荷日<input type="date" value={shipmentDate} disabled={locked} onChange={(event) => setShipmentDate(event.target.value)} className="block max-w-full border border-black/30 p-2" /></label>
            <label className="flex items-center gap-2"><input type="checkbox" checked={notifyCustomer} disabled={locked} onChange={(event) => setNotifyCustomer(event.target.checked)} />お客様に発送のメールを送る</label>
            <Button type="button" disabled={locked || slip.issues.length > 0 || slip.expired} onClick={checkShipment}>発送票確認</Button>
          </div>}
        </section>
      ) : null}
      {slip.stage === 'confirmed' ? <section aria-label="発送の記録" className="space-y-3">
        <p>出荷日: {slip.shipmentDate}</p><p>発送した時刻: {slip.confirmedAt ? formatPurchaseOrderDateTime(slip.confirmedAt) : '—'}</p>
        <p>{slip.carrier && slip.trackingNumber ? `${SHIPPING_CARRIERS[slip.carrier].label} ${slip.trackingNumber}` : '伝票番号は未入力です'}</p>
        <h2 className="lk-text-lg">注文ごとの発送</h2>
        {slip.orders.map((order) => <p key={order.fulfillmentId}>注文 {toOrderNumber(order.orderId)} 発送（{order.fulfillmentNumber}回目） {order.deliveryStatus ? DELIVERY_STATUS_LABELS[order.deliveryStatus] : ''}</p>)}
        <h2 className="lk-text-lg">出荷日の履歴</h2>
        {slip.dateHistory.map((entry) => <p key={entry.version}>{formatPurchaseOrderDateTime(entry.createdAt)} {entry.previousDate} → {entry.newDate}</p>)}
        <h2 className="lk-text-lg">荷物の履歴</h2>
        {slip.versions.map((entry) => <p key={entry.version}>{formatPurchaseOrderDateTime(entry.createdAt)} {entry.shipmentDate} {entry.trackingNumber}</p>)}
        <div className="flex flex-wrap gap-3">
          <Button type="button" variant="secondary" disabled={locked} onClick={() => { setNotice(null); setLocalMessage(null); setCancelOpen(true); }}>
            {SHIPMENT_SLIP_TEXT.cancelShipment}
          </Button>
        </div>
      </section> : null}
      {/* 読み直した票がすでに取り消されていた（別の人が取り消した）時は、取消のダイアログを閉じる（取消済みの表示だけが残る） */}
      {cancelOpen && slip.stage === 'confirmed' ? (
        <ShipmentSlipCancelDialog
          slip={slip}
          onClose={() => setCancelOpen(false)}
          onCancelled={() => { setCancelOpen(false); setNotice(SHIPMENT_SLIP_TEXT.cancelled); reload(); }}
          onStale={reload}
        />
      ) : null}

      {isDraft && !reviewing ? (
        <div className="flex flex-wrap gap-3">
          <Button type="button" variant="secondary" disabled={locked} onClick={() => setConfirmOpen(true)}>{SHIPMENT_SLIP_TEXT.discardDraft}</Button>
        </div>
      ) : null}

      <Dialog
        open={confirmOpen}
        onClose={() => { if (!write.sending) setConfirmOpen(false); }}
        title={SHIPMENT_SLIP_TEXT.discardConfirm}
      >
        <div className="flex flex-wrap gap-3">
          <Button type="button" disabled={write.sending || write.uncertain} onClick={discard}>{SHIPMENT_SLIP_TEXT.discardSubmit}</Button>
          <Button type="button" variant="secondary" disabled={write.sending} onClick={() => setConfirmOpen(false)}>{SHIPMENT_SLIP_TEXT.back}</Button>
        </div>
      </Dialog>
    </div>
  );
}

/** 同梱する品物の1行。この行に付く問題の文は、行の下の1行に出す（表の全部の列にまたがる） */
function SlipLineRow({ notes, columnCount, children }: { notes: string[]; columnCount: number; children: React.ReactNode }): React.JSX.Element {
  return (
    <>
      <tr data-testid="slip-line" className={`align-top ${notes.length > 0 ? '' : 'border-b border-black/10'}`}>{children}</tr>
      {notes.length > 0 ? (
        <tr data-testid="slip-line-note" className="border-b border-black/10">
          <td colSpan={columnCount} className="px-3 pb-3 text-[#474747]">
            {notes.map((note) => <p key={note}>{note}</p>)}
          </td>
        </tr>
      ) : null}
    </>
  );
}
