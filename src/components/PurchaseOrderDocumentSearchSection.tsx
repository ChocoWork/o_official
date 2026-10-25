'use client';

// File: src/components/PurchaseOrderDocumentSearchSection.tsx
// 取引書類の検索（G-2 Task 8 / FREQ-530）。見積書・請求書を、取引日・金額の範囲、取引先、発注書番号、種類で探す。
// 既定は各書類の最新の情報だけで、「訂正前の情報も探す」を付けると、直す前の取引日・金額・取引先でも見つかる（状態は「訂正前」）。
// 結果の表は「印刷」で window.print() にかける（条件欄とボタンは印刷しない）。権限は窓口と DB が守り、この部品は返事の状態で出し分ける。
import { useEffect, useId, useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/Button/Button';
import { adminLoadFailureMessage } from '@/lib/admin/admin-load-failure';
import { clientFetch } from '@/lib/client-fetch';
import { fetchPurchaseOrderDocumentUrl, openBlankDocumentTab } from '@/lib/purchase-orders/purchase-order-documents-client';
import {
  formatNumber,
  formatPurchaseOrderDay,
  parsePurchaseOrderDocumentSearchRow,
  PURCHASE_ORDER_ATTACHMENT_KIND_LABELS,
  PURCHASE_ORDER_DOCUMENT_PAGE_LIMIT,
  PURCHASE_ORDER_DOCUMENT_TEXT,
  PURCHASE_ORDER_LIMITS,
  PURCHASE_ORDER_TEXT,
  purchaseOrderDocumentStateLabel,
  type PurchaseOrderAttachmentKind,
  type PurchaseOrderDocumentSearchRow,
} from '@/lib/purchase-orders/purchase-order-types';

const TEXT = PURCHASE_ORDER_DOCUMENT_TEXT;
const HEADINGS = [TEXT.columnNumber, TEXT.columnKind, TEXT.columnFileName, TEXT.columnDate, TEXT.columnAmount, TEXT.columnCounterparty, TEXT.columnState] as const;
const HEADING_ID = 'purchase-order-document-search-heading';
const HEAD_CELL = 'sticky top-0 z-10 whitespace-nowrap border-b border-black/15 bg-white p-3 font-normal';
const NUMBER_CELL = 'p-3 text-right tabular-nums';
// 画面では見出しを保ったスクロール領域。印刷では表の全部（全ての行と列）を紙に出すため、高さの上限・スクロール・表の最小幅を外す
const SCROLL_REGION_CLASS =
  'max-h-[70vh] max-w-full overflow-auto border border-black/15 focus-visible:outline-2 print:max-h-none print:overflow-visible';
const TABLE_CLASS = 'w-full min-w-[52rem] border-collapse text-left print:min-w-0';
const FIELD_CLASS =
  'w-full border border-black/20 bg-white px-3 py-2 lk-text-2xs text-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black/40';
const KINDS = Object.keys(PURCHASE_ORDER_ATTACHMENT_KIND_LABELS) as PurchaseOrderAttachmentKind[];

type Form = {
  dateFrom: string;
  dateTo: string;
  amountMin: string;
  amountMax: string;
  counterparty: string;
  number: string;
  kind: '' | PurchaseOrderAttachmentKind;
  includeHistory: boolean;
};
const EMPTY_FORM: Form = { dateFrom: '', dateTo: '', amountMin: '', amountMax: '', counterparty: '', number: '', kind: '', includeHistory: false };

type State =
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'ready'; rows: PurchaseOrderDocumentSearchRow[]; total: number };

/** 条件から窓口の query にする。空の条件は付けない */
function toQuery(form: Form, page: number): string {
  const params = new URLSearchParams();
  const entries: Array<[string, string]> = [
    ['dateFrom', form.dateFrom], ['dateTo', form.dateTo], ['amountMin', form.amountMin.trim()], ['amountMax', form.amountMax.trim()],
    ['counterparty', form.counterparty.trim()], ['number', form.number.trim()], ['kind', form.kind],
  ];
  for (const [name, value] of entries) if (value !== '') params.set(name, value);
  if (form.includeHistory) params.set('includeHistory', '1');
  params.set('page', String(page));
  return params.toString();
}

/** 窓口の応答（{ rows, total, page, limit }）から行と全件数を取る。形が崩れていれば null */
function readPage(body: unknown): { rows: PurchaseOrderDocumentSearchRow[]; total: number } | null {
  if (body === null || typeof body !== 'object') return null;
  const { rows, total } = body as { rows?: unknown; total?: unknown };
  if (!Array.isArray(rows) || typeof total !== 'number' || !Number.isSafeInteger(total) || total < rows.length) return null;
  // 全件があるのに頁が空なのは、頁の指定が合っていない（読み違い）
  if (rows.length === 0 && total > 0) return null;
  try {
    return { rows: rows.map((row: unknown) => parsePurchaseOrderDocumentSearchRow(row)), total };
  } catch {
    return null;
  }
}

const isAmount = (value: string): boolean => value.trim() === '' || /^[0-9]{1,11}$/.test(value.trim());

export default function PurchaseOrderDocumentSearchSection(): React.JSX.Element {
  const ids = useId();
  const [form, setForm] = useState<Form>(EMPTY_FORM);
  // 検索ボタンで確定した条件。入力中の条件（form）は検索を押すまで結果に効かない
  const [applied, setApplied] = useState<Form>(EMPTY_FORM);
  const [page, setPage] = useState(1);
  const [state, setState] = useState<State>({ phase: 'loading' });
  const [formError, setFormError] = useState<string | null>(null);
  // 「原本を見る」を押した行の添付 ID（開く間は他の行も押せない）と、開けなかった時の文
  const [opening, setOpening] = useState<string | null>(null);
  const [openMessage, setOpenMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const failed: State = { phase: 'error', message: TEXT.searchFailed };
    void (async () => {
      try {
        const response = await clientFetch(`/api/admin/purchase-order-documents?${toQuery(applied, page)}`, { cache: 'no-store' });
        const body: unknown = await response.json().catch(() => null);
        if (cancelled) return;
        if (!response.ok) {
          setState({ phase: 'error', message: adminLoadFailureMessage(response.status, body, TEXT.searchForbidden, TEXT.searchFailed) });
          return;
        }
        const result = readPage(body);
        setState(result === null ? failed : { phase: 'ready', ...result });
      } catch {
        if (!cancelled) setState(failed);
      }
    })();
    return () => { cancelled = true; };
  }, [applied, page]);

  const search = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!isAmount(form.amountMin) || !isAmount(form.amountMax)) {
      setFormError(PURCHASE_ORDER_TEXT.invalidInput);
      return;
    }
    setFormError(null);
    setOpenMessage(null);
    setState({ phase: 'loading' });
    setPage(1);
    setApplied(form);
  };
  const clear = (): void => {
    setForm(EMPTY_FORM);
    setFormError(null);
    setOpenMessage(null);
    setState({ phase: 'loading' });
    setPage(1);
    setApplied(EMPTY_FORM);
  };
  const goTo = (next: number): void => {
    setOpenMessage(null);
    setState({ phase: 'loading' });
    setPage(next);
  };
  /**
   * 発注書の頁の「表示」と同じ窓口（60秒の署名つきリンク）をもらい、原本を新しいタブで開く。リンクは文にも記録にも出さない。
   * タブはリンクを待つ前にクリックの中で空で開き、リンクが取れてからそのタブを移す（待った後の window.open は Safari が止めることがあるため）。
   * 止められたら文を出し、リンクは取らない。取れなければタブを閉じる。
   */
  const openOriginal = async (row: PurchaseOrderDocumentSearchRow): Promise<void> => {
    if (opening !== null) return;
    const tab = openBlankDocumentTab();
    if (tab === null) {
      setOpenMessage(TEXT.openBlocked);
      return;
    }
    setOpening(row.attachmentId);
    setOpenMessage(null);
    try {
      const result = await fetchPurchaseOrderDocumentUrl(row.purchaseOrderId, row.attachmentId, false);
      if (!result.ok) {
        tab.close();
        setOpenMessage(result.message);
        return;
      }
      tab.location.href = result.url;
    } catch {
      tab.close();
      setOpenMessage(TEXT.openFailed);
    } finally {
      setOpening(null);
    }
  };
  const set = <K extends keyof Form>(name: K, value: Form[K]): void => setForm((current) => ({ ...current, [name]: value }));

  const limit = PURCHASE_ORDER_DOCUMENT_PAGE_LIMIT;
  const from = (page - 1) * limit + 1;

  return (
    <div className="w-full min-w-0 max-w-full space-y-6">
      <div className="flex flex-wrap gap-3 print:hidden">
        <Button href="/admin/purchase-orders" variant="secondary">発注一覧表に戻る</Button>
      </div>
      <h1 id={HEADING_ID} className="lk-text-xl">{TEXT.searchHeading}</h1>

      <form noValidate onSubmit={search} className="space-y-4 print:hidden" aria-labelledby={HEADING_ID}>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div className="space-y-1">
            <label htmlFor={`${ids}-date-from`} className="block lk-text-2xs">{TEXT.searchDateFrom}</label>
            <input id={`${ids}-date-from`} type="date" value={form.dateFrom} onChange={(event) => set('dateFrom', event.target.value)} className={FIELD_CLASS} />
          </div>
          <div className="space-y-1">
            <label htmlFor={`${ids}-date-to`} className="block lk-text-2xs">{TEXT.searchDateTo}</label>
            <input id={`${ids}-date-to`} type="date" value={form.dateTo} onChange={(event) => set('dateTo', event.target.value)} className={FIELD_CLASS} />
          </div>
          <div className="space-y-1">
            <label htmlFor={`${ids}-amount-min`} className="block lk-text-2xs">{TEXT.searchAmountMin}</label>
            <input id={`${ids}-amount-min`} type="text" inputMode="numeric" value={form.amountMin} onChange={(event) => set('amountMin', event.target.value)} className={FIELD_CLASS} />
          </div>
          <div className="space-y-1">
            <label htmlFor={`${ids}-amount-max`} className="block lk-text-2xs">{TEXT.searchAmountMax}</label>
            <input id={`${ids}-amount-max`} type="text" inputMode="numeric" value={form.amountMax} onChange={(event) => set('amountMax', event.target.value)} className={FIELD_CLASS} />
          </div>
          <div className="space-y-1">
            <label htmlFor={`${ids}-counterparty`} className="block lk-text-2xs">{TEXT.searchCounterparty}</label>
            <input
              id={`${ids}-counterparty`}
              type="text"
              maxLength={PURCHASE_ORDER_LIMITS.counterparty.max}
              value={form.counterparty}
              onChange={(event) => set('counterparty', event.target.value)}
              className={FIELD_CLASS}
            />
          </div>
          <div className="space-y-1">
            <label htmlFor={`${ids}-number`} className="block lk-text-2xs">{TEXT.searchNumber}</label>
            <input id={`${ids}-number`} type="text" maxLength={20} value={form.number} onChange={(event) => set('number', event.target.value)} className={FIELD_CLASS} />
          </div>
          <div className="space-y-1">
            <label htmlFor={`${ids}-kind`} className="block lk-text-2xs">{TEXT.searchKind}</label>
            <select id={`${ids}-kind`} value={form.kind} onChange={(event) => set('kind', event.target.value as Form['kind'])} className={FIELD_CLASS}>
              <option value="">{TEXT.searchKindAll}</option>
              {KINDS.map((kind) => <option key={kind} value={kind}>{PURCHASE_ORDER_ATTACHMENT_KIND_LABELS[kind]}</option>)}
            </select>
          </div>
          <div className="flex items-end">
            <label className="flex items-center gap-2 lk-text-2xs">
              <input type="checkbox" checked={form.includeHistory} onChange={(event) => set('includeHistory', event.target.checked)} />
              <span>{TEXT.searchIncludeHistory}</span>
            </label>
          </div>
        </div>
        {formError !== null ? <p role="alert" className="lk-text-2xs text-red-600">{formError}</p> : null}
        <div className="flex flex-wrap gap-3">
          <Button type="submit">{TEXT.search}</Button>
          <Button type="button" variant="secondary" onClick={clear}>{TEXT.clear}</Button>
          <Button type="button" variant="secondary" onClick={() => window.print()}>{TEXT.print}</Button>
        </div>
      </form>

      {state.phase === 'loading' ? <p role="status">読み込み中...</p> : null}
      {state.phase === 'error' ? <p role="alert">{state.message}</p> : null}
      {openMessage !== null ? <p role="alert" className="break-words print:hidden">{openMessage}</p> : null}
      {state.phase === 'ready' && state.rows.length === 0 ? <p>{TEXT.searchEmpty}</p> : null}
      {state.phase === 'ready' && state.rows.length > 0 ? (
        <>
          <div role="region" aria-label={TEXT.searchResults} tabIndex={0} className={SCROLL_REGION_CLASS}>
            <table aria-label={TEXT.searchResults} className={TABLE_CLASS}>
              <thead>
                <tr>
                  {HEADINGS.map((heading, index) => (
                    <th key={heading} scope="col" className={`${HEAD_CELL} ${index === 4 ? 'text-right' : ''}`}>{heading}</th>
                  ))}
                  <th scope="col" className={`${HEAD_CELL} print:hidden`}>{TEXT.columnOriginal}</th>
                </tr>
              </thead>
              <tbody>
                {state.rows.map((row) => (
                  <tr key={`${row.attachmentId}:${row.revisionNo}`} data-testid="purchase-order-document-row" className="border-b border-black/10 align-top">
                    <td className="whitespace-nowrap p-3">
                      <Link href={`/admin/purchase-orders/${row.purchaseOrderId}`} className="underline underline-offset-4">{row.purchaseOrderNumber}</Link>
                    </td>
                    <td className="whitespace-nowrap p-3">{PURCHASE_ORDER_ATTACHMENT_KIND_LABELS[row.kind]}</td>
                    <td className="break-all p-3">{row.fileName}</td>
                    <td className="whitespace-nowrap p-3 tabular-nums">{formatPurchaseOrderDay(row.transactionDate)}</td>
                    <td className={NUMBER_CELL}>{formatNumber(row.amountYen)}</td>
                    <td className="break-words p-3">{row.counterparty}</td>
                    <td className="whitespace-nowrap p-3">{purchaseOrderDocumentStateLabel(row)}</td>
                    <td className="whitespace-nowrap p-3 print:hidden">
                      <Button size="sm" variant="secondary" disabled={opening !== null} onClick={() => void openOriginal(row)}>{TEXT.viewOriginal}</Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap items-center gap-3 print:hidden">
            <Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => goTo(page - 1)}>前へ</Button>
            <span className="tabular-nums">{`${from}〜${from + state.rows.length - 1} / ${state.total}`}</span>
            <Button size="sm" variant="secondary" disabled={page * limit >= state.total} onClick={() => goTo(page + 1)}>次へ</Button>
          </div>
        </>
      ) : null}
    </div>
  );
}
