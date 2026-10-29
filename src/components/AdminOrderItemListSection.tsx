'use client';

// File: src/components/AdminOrderItemListSection.tsx
// 注文一覧表（G-4 / FREQ-536・538・539-AC-05）。品物×ステータスの12列を20行ずつ読み、行から注文の詳細（/admin/orders/[id]）を開く。
// 上部に要対応の欄（旧い ORDER タブから移した。操作は useOrderAttention、返金・返品の入口は詳細頁の ?open= へ）を置く。
// 絞り込みは「入力中（draft）」と「読んだ条件（applied）」を分け、「絞り込む」を押すまで読み直さない。初めて開いた時は全期間。
// 読んだ条件と頁はこのタブの sessionStorage にだけ持つ（URL には載せない。詳細から戻ると復元する）。読みは最後に始めた物の答えだけを使う。
// CSV はブラウザの取得済みの行からは作らず、窓口が同じ条件の全行を出す（一覧の5000件の上限を受けない）。
import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import AdminOrderItemTable from '@/components/AdminOrderItemTable';
import AttentionInbox from '@/components/AttentionInbox';
import { BannerAlert } from '@/components/ui/BannerAlert/BannerAlert';
import { Button } from '@/components/ui/Button/Button';
import { DateTimePicker } from '@/components/ui/DateTimePicker/DateTimePicker';
import { SearchField } from '@/components/ui/SearchField/SearchField';
import { useLogin } from '@/contexts/LoginContext';
import { useOrderAttention } from '@/hooks/useOrderAttention';
import { clientFetch } from '@/lib/client-fetch';
import { RATE_LIMITED_MESSAGE, readSafeOrderActionError } from '@/lib/orders/admin-orders/admin-order-client';
import { orderItemCsvFilename } from '@/lib/orders/admin-orders/admin-order-csv';
import { parseOrderItemQuery, toSearchParams } from '@/lib/orders/admin-orders/admin-order-query';
import {
  ADMIN_ORDER_TEXT,
  ORDER_ITEM_STATUS_ORDER,
  orderItemCapNote,
  type AdminOrderItemFilters,
  type AdminOrderItemPage,
} from '@/lib/orders/admin-orders/admin-order-types';
import { ADMIN_ITEM_STATUS_LABELS, type AdminItemStatus } from '@/lib/orders/item-state/item-state-types';
import { RETURN_DISPLAY_STATUS_LABELS } from '@/lib/orders/returns/return-messages';

const STORAGE_KEY = 'admin-order-list-state';
const TEXT_KEYS = ['orderNumber', 'customer', 'email', 'product', 'color', 'size'] as const;
const DATE_KEYS = ['dateFrom', 'dateTo'] as const;

type StoredState = { filters: AdminOrderItemFilters; page: number };

/** 入力中の絞り込み。欄の文字をそのまま持つ（読む時に trim して空を落とす） */
type Draft = {
  dateFrom: string;
  dateTo: string;
  orderNumber: string;
  customer: string;
  email: string;
  product: string;
  color: string;
  size: string;
  statuses: AdminItemStatus[];
  attention: boolean;
};

const EMPTY_DRAFT: Draft = {
  dateFrom: '', dateTo: '', orderNumber: '', customer: '', email: '', product: '', color: '', size: '', statuses: [], attention: false,
};

function draftFromFilters(filters: AdminOrderItemFilters): Draft {
  return {
    dateFrom: filters.dateFrom ?? '',
    dateTo: filters.dateTo ?? '',
    orderNumber: filters.orderNumber ?? '',
    customer: filters.customer ?? '',
    email: filters.email ?? '',
    product: filters.product ?? '',
    color: filters.color ?? '',
    size: filters.size ?? '',
    statuses: filters.statuses ?? [],
    attention: filters.attention === true,
  };
}

function filtersFromDraft(draft: Draft): AdminOrderItemFilters {
  const filters: AdminOrderItemFilters = {};
  for (const key of DATE_KEYS) {
    if (draft[key]) filters[key] = draft[key];
  }
  for (const key of TEXT_KEYS) {
    const value = draft[key].trim();
    if (value) filters[key] = value;
  }
  if (draft.statuses.length > 0) filters.statuses = [...draft.statuses];
  if (draft.attention) filters.attention = true;
  return filters;
}

/** 保存した値を、窓口と同じ検査で確かめて取り出す。読めない・合わない値は捨てる */
function sanitizeStoredState(value: unknown): StoredState | null {
  if (typeof value !== 'object' || value === null) return null;
  const { filters, page } = value as { filters?: unknown; page?: unknown };
  if (typeof filters !== 'object' || filters === null || Array.isArray(filters) || typeof page !== 'number') return null;
  const source = filters as Record<string, unknown>;
  const candidate: AdminOrderItemFilters = {};
  for (const key of [...DATE_KEYS, ...TEXT_KEYS]) {
    if (typeof source[key] === 'string') candidate[key] = source[key];
  }
  if (Array.isArray(source.statuses)) {
    candidate.statuses = source.statuses.filter((status): status is AdminItemStatus => typeof status === 'string');
  }
  if (source.attention === true) candidate.attention = true;
  const parsed = parseOrderItemQuery(toSearchParams(candidate, page));
  return parsed.ok ? { filters: parsed.filters, page: parsed.page } : null;
}

// sessionStorage は使えない時（私的な閲覧・保存の拒否など）がある。読み書きとも失敗しても一覧は動く
function readStoredState(): StoredState | null {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    return raw ? sanitizeStoredState(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

function writeStoredState(state: StoredState): void {
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // 保存できなくても、画面の state で動く
  }
}

type ReturnAttention = { requested: number; refundWaiting: number };

// 読み直しの間は前の答え（previous）を出したままにする。表・件数・注記・頁送りを外すと、押した「次の頁」からフォーカスが落ちる（R-49）
type ListState =
  | { phase: 'loading'; previous: AdminOrderItemPage | null }
  | { phase: 'error'; message: string }
  | { phase: 'ready'; data: AdminOrderItemPage };

function isListData(value: unknown): value is AdminOrderItemPage {
  if (typeof value !== 'object' || value === null) return false;
  const data = value as Record<string, unknown>;
  return Array.isArray(data.rows)
    && typeof data.totalRows === 'number' && typeof data.totalOrders === 'number' && typeof data.totalPages === 'number'
    && typeof data.ordersCapped === 'boolean' && typeof data.ordersCap === 'number';
}

// 一行に並べる物。返品の数（押すとその状態の絞り込み）に続けて、開いているキャンセルの申し込みの数を並べる
type AttentionPiece = { status: AdminItemStatus; label: string };

/** ダウンロードのファイル名。窓口の Content-Disposition の名前（英数字と . _ - の .csv だけ）を使い、無い・読めない時は今日の日付で作る */
function downloadFilename(response: Response): string {
  const name = /filename="([^"]*)"/.exec(response.headers.get('Content-Disposition') ?? '')?.[1];
  return name && /^[A-Za-z0-9][A-Za-z0-9._-]*\.csv$/.test(name) ? name : orderItemCsvFilename(new Date());
}

export default function AdminOrderItemListSection(): React.JSX.Element {
  const router = useRouter();
  const { userRole, isMfaVerified } = useLogin();
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [applied, setApplied] = useState<AdminOrderItemFilters>({});
  const [page, setPage] = useState(1);
  // 保存した条件を読み終えるまで一覧を読まない（初めから全期間で読んでから、復元した条件でもう一度読まないため）
  const [hydrated, setHydrated] = useState(false);
  const [state, setState] = useState<ListState>({ phase: 'loading', previous: null });
  const [returnAttention, setReturnAttention] = useState<ReturnAttention | null>(null);
  const [cancelRequestAttention, setCancelRequestAttention] = useState(0);
  const [dateError, setDateError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  // 一覧を読んだ番号。絞り込みや頁を続けて変えると読みが重なるので、使うのは最後に始めた読みの答えだけにする
  const requestSeq = useRef(0);

  const load = useCallback(async (filters: AdminOrderItemFilters, nextPage: number): Promise<void> => {
    const requestId = ++requestSeq.current;
    const isLatest = () => requestId === requestSeq.current;
    setState((current) => ({
      phase: 'loading',
      previous: current.phase === 'ready' ? current.data : current.phase === 'loading' ? current.previous : null,
    }));
    try {
      const response = await clientFetch(`/api/admin/order-items?${toSearchParams(filters, nextPage).toString()}`, { cache: 'no-store' });
      if (!response.ok) {
        const message = response.status === 403
          ? ADMIN_ORDER_TEXT.listForbidden
          : await readSafeOrderActionError(response, ADMIN_ORDER_TEXT.listFailed, [422]);
        if (isLatest()) setState({ phase: 'error', message });
        return;
      }
      const json = (await response.json()) as { data?: unknown; returnAttention?: ReturnAttention; cancelRequestAttention?: number };
      if (!isLatest()) return;
      if (!isListData(json.data)) {
        setState({ phase: 'error', message: ADMIN_ORDER_TEXT.listFailed });
        return;
      }
      setState({ phase: 'ready', data: json.data });
      setReturnAttention(json.returnAttention ?? null);
      setCancelRequestAttention(json.cancelRequestAttention ?? 0);
    } catch (error) {
      console.error('Failed to fetch admin order items:', error instanceof Error ? error.name : 'UnknownError');
      if (isLatest()) setState({ phase: 'error', message: ADMIN_ORDER_TEXT.listFailed });
    }
  }, []);

  // 返金・取消などの操作の返事の後は、画面の今の条件と頁で読み直す
  const latest = useRef({ applied, page });
  useLayoutEffect(() => {
    latest.current = { applied, page };
  }, [applied, page]);
  const reloadList = useCallback(() => load(latest.current.applied, latest.current.page), [load]);

  const canAccessAdmin = userRole === 'admin' || userRole === 'supporter';
  const attentionInbox = useOrderAttention({ enabled: canAccessAdmin && isMfaVerified, onChanged: reloadList });
  // 配送の要対応を閉じる（窓口の権限は admin.orders.manage）。店長とサポートの人だけ。返金の権限（店長だけ）とは別に決める
  const canManageDelivery = userRole === 'admin' || userRole === 'supporter';

  useEffect(() => {
    const stored = readStoredState();
    if (stored) {
      setApplied(stored.filters);
      setDraft(draftFromFilters(stored.filters));
      setPage(stored.page);
    }
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    writeStoredState({ filters: applied, page });
    void load(applied, page);
  }, [hydrated, applied, page, load]);

  const updateDraft = (patch: Partial<Draft>): void => setDraft((current) => ({ ...current, ...patch }));

  const toggleStatus = (status: AdminItemStatus): void => {
    setDraft((current) => ({
      ...current,
      statuses: ORDER_ITEM_STATUS_ORDER.filter((candidate) => (candidate === status ? !current.statuses.includes(candidate) : current.statuses.includes(candidate))),
    }));
  };

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (draft.dateFrom && draft.dateTo && draft.dateFrom > draft.dateTo) {
      setDateError(ADMIN_ORDER_TEXT.dateRangeInvalid);
      return;
    }
    setDateError(null);
    setApplied(filtersFromDraft(draft));
    setPage(1);
  };

  const handleClear = (): void => {
    setDraft(EMPTY_DRAFT);
    setDateError(null);
    setApplied({});
    setPage(1);
  };

  // 一行の数を押すと、その状態だけにする。数は全体の注文の数なので、ほかの絞り込みは全部外して数と一覧を合わせる。
  // もう一度押すと、状態の絞り込みだけを外す（押している印は aria-pressed）
  const isPiecePressed = (status: AdminItemStatus): boolean => applied.statuses?.length === 1 && applied.statuses[0] === status;
  const handleAttentionPiece = (status: AdminItemStatus): void => {
    let next: AdminOrderItemFilters;
    if (isPiecePressed(status)) {
      next = { ...applied };
      delete next.statuses;
    } else {
      next = { statuses: [status] };
    }
    setDateError(null);
    setDraft(draftFromFilters(next));
    setApplied(next);
    setPage(1);
  };

  const handleExport = async (): Promise<void> => {
    if (exporting) return;
    setExporting(true);
    setExportError(null);
    try {
      const response = await clientFetch(`/api/admin/order-items/export?${toSearchParams(applied).toString()}`, { cache: 'no-store' });
      if (!response.ok) {
        // 回数の制限（429）の窓口の本文は英語なので、画面の案内にする
        setExportError(response.status === 429
          ? RATE_LIMITED_MESSAGE
          : await readSafeOrderActionError(response, ADMIN_ORDER_TEXT.exportFailed, [403, 422, 500]));
        return;
      }
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = downloadFilename(response);
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      window.URL.revokeObjectURL(url);
    } catch (error) {
      console.error('Failed to export admin order items:', error instanceof Error ? error.name : 'UnknownError');
      setExportError(ADMIN_ORDER_TEXT.exportFailed);
    } finally {
      setExporting(false);
    }
  };

  const attentionPieces: AttentionPiece[] = [
    ...(returnAttention && returnAttention.requested > 0
      ? [{ status: 'return_requested' as const, label: `${RETURN_DISPLAY_STATUS_LABELS.requested} ${returnAttention.requested}件` }]
      : []),
    ...(returnAttention && returnAttention.refundWaiting > 0
      ? [{ status: 'refund_waiting' as const, label: `${RETURN_DISPLAY_STATUS_LABELS.refund_waiting} ${returnAttention.refundWaiting}件` }]
      : []),
    ...(cancelRequestAttention > 0
      ? [{ status: 'cancel_requested' as const, label: `キャンセルの申し込み ${cancelRequestAttention}件` }]
      : []),
  ];

  const { attention } = attentionInbox;
  const data = state.phase === 'ready' ? state.data : state.phase === 'loading' ? state.previous : null;

  return (
    <div className="w-full min-w-0 max-w-full space-y-6">
      <div className="flex flex-wrap gap-3">
        <Button href="/admin?tab=ORDER" variant="secondary">管理画面に戻る</Button>
      </div>
      <h1 className="lk-text-xl">{ADMIN_ORDER_TEXT.listTitle}</h1>
      <p className="lk-text-sm text-[#474747]">{ADMIN_ORDER_TEXT.listDescription}</p>

      {attention?.emailSending?.paused === true ? (
        <BannerAlert
          variant="error"
          title="お客様への注文のメールの送信を止めています"
          description={`原因: ${attention.emailSending.reasonLabel ?? '不明'}。原因を直すと、15分ごとに1件ずつ試して自動で再開します（1日の送信の上限の時は日本時間 9時から）。手順は「注文のメールの手順書」の「送信の一時停止」にあります。`}
        />
      ) : null}
      <div id="attention" className="space-y-4">
        <AttentionInbox
          attention={attention}
          processingIds={attentionInbox.processingIds}
          onReview={attentionInbox.onReview}
          onResolve={attentionInbox.onResolve}
          onCancelAndResolve={attentionInbox.onCancelAndResolve}
          onRetryRefund={userRole === 'admin' ? (orderId) => router.push(`/admin/orders/${orderId}?open=refund`) : undefined}
          onRetryReturnRefund={userRole === 'admin' ? (orderId) => router.push(`/admin/orders/${orderId}?open=returns`) : undefined}
          onOpenDeliveryHistory={(orderId) => router.push(`/admin/orders/${orderId}#order-history`)}
          onResolveDelivery={canManageDelivery ? attentionInbox.onResolveDelivery : undefined}
          onResolveDiscount={canManageDelivery ? attentionInbox.onResolveDiscount : undefined}
        />
        {attentionInbox.errorBanner ? (
          <p role="alert" className="lk-text-sm text-red-700 font-acumin">{attentionInbox.errorBanner}</p>
        ) : null}
        {attentionInbox.errorMessage ? (
          <p role="alert" className="lk-text-sm text-red-700 font-acumin">{attentionInbox.errorMessage}</p>
        ) : null}
        {attentionInbox.noticeMessage ? (
          <p role="status" aria-live="polite" className="lk-text-sm text-[#474747] font-acumin">{attentionInbox.noticeMessage}</p>
        ) : null}
      </div>

      {attentionPieces.length > 0 ? (
        <div data-testid="return-attention" className="flex flex-wrap items-center gap-x-1 lk-text-sm text-[#474747] font-acumin">
          {attentionPieces.map((piece, index) => (
            <Fragment key={piece.status}>
              {index > 0 ? <span aria-hidden="true">・</span> : null}
              <Button
                variant="link"
                size="sm"
                className="font-acumin"
                aria-pressed={isPiecePressed(piece.status)}
                onClick={() => handleAttentionPiece(piece.status)}
              >
                {piece.label}
              </Button>
            </Fragment>
          ))}
        </div>
      ) : null}

      <form aria-label="注文の絞り込み" onSubmit={handleSubmit} className="space-y-4 border-b border-black/10 pb-4">
        <div className="grid min-w-0 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <DateTimePicker id="order-list-date-from" label="注文日（から）" mode="date" size="sm" value={draft.dateFrom} onChange={(event) => updateDraft({ dateFrom: event.target.value })} />
          <DateTimePicker id="order-list-date-to" label="注文日（まで）" mode="date" size="sm" value={draft.dateTo} onChange={(event) => updateDraft({ dateTo: event.target.value })} />
          <SearchField label="注文ID" placeholder="ORD-… または pi_…" size="sm" maxLength={200} value={draft.orderNumber} onChange={(event) => updateDraft({ orderNumber: event.target.value })} />
          <SearchField label="顧客名" size="sm" maxLength={200} value={draft.customer} onChange={(event) => updateDraft({ customer: event.target.value })} />
          <SearchField label="メールアドレス" size="sm" maxLength={200} value={draft.email} onChange={(event) => updateDraft({ email: event.target.value })} />
          <SearchField label="商品名" size="sm" maxLength={200} value={draft.product} onChange={(event) => updateDraft({ product: event.target.value })} />
          <SearchField label="色" size="sm" maxLength={200} value={draft.color} onChange={(event) => updateDraft({ color: event.target.value })} />
          <SearchField label="サイズ" size="sm" maxLength={200} value={draft.size} onChange={(event) => updateDraft({ size: event.target.value })} />
        </div>
        <fieldset className="min-w-0 space-y-2">
          <legend className="lk-text-3xs font-acumin">ステータス</legend>
          <div className="flex flex-wrap gap-2">
            {ORDER_ITEM_STATUS_ORDER.map((status) => {
              const pressed = draft.statuses.includes(status);
              return (
                <Button
                  key={status}
                  variant={pressed ? 'primary' : 'secondary'}
                  size="sm"
                  className="font-acumin"
                  aria-pressed={pressed}
                  onClick={() => toggleStatus(status)}
                >
                  {ADMIN_ITEM_STATUS_LABELS[status]}
                </Button>
              );
            })}
          </div>
        </fieldset>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant={draft.attention ? 'primary' : 'secondary'}
            size="sm"
            className="font-acumin"
            aria-pressed={draft.attention}
            onClick={() => updateDraft({ attention: !draft.attention })}
          >
            要対応のみ
          </Button>
          <Button type="submit" size="sm" className="font-acumin">絞り込む</Button>
          <Button variant="secondary" size="sm" className="font-acumin" onClick={handleClear}>条件をクリア</Button>
        </div>
        {dateError ? <p role="alert" className="lk-text-sm text-red-700 font-acumin">{dateError}</p> : null}
      </form>

      <div className="flex flex-wrap items-center gap-3">
        <Button variant="secondary" size="sm" className="font-acumin" onClick={() => void handleExport()} disabled={exporting}>{ADMIN_ORDER_TEXT.export}</Button>
        <span className="lk-text-3xs text-[#474747] font-acumin">{ADMIN_ORDER_TEXT.exportDescription}</span>
        {exporting ? <span role="status" className="lk-text-3xs font-acumin">{ADMIN_ORDER_TEXT.exportLoading}</span> : null}
      </div>
      {exportError ? <p role="alert" className="lk-text-sm text-red-700 font-acumin">{exportError}</p> : null}

      {state.phase === 'loading' ? <p role="status" className="lk-text-sm text-[#474747] font-acumin">{ADMIN_ORDER_TEXT.listLoading}</p> : null}
      {state.phase === 'error' ? <p role="alert" className="lk-text-sm text-red-700 font-acumin">{state.message}</p> : null}
      {data ? (
        <div aria-busy={state.phase === 'loading'} className={state.phase === 'loading' ? 'space-y-3 opacity-60' : 'space-y-3'}>
          <p data-testid="order-item-count" className="lk-text-sm font-acumin">
            {data.ordersCapped ? `${data.totalRows}行（新しい${data.totalOrders}件の注文の中で）` : `${data.totalRows}行（${data.totalOrders}件の注文）`}
          </p>
          {data.ordersCapped ? (
            <p data-testid="cap-note" role="status" className="lk-text-sm text-[#474747] font-acumin">{orderItemCapNote(data.ordersCap)}</p>
          ) : null}
          {data.rows.length === 0 ? (
            <p className="lk-text-sm text-[#474747] font-acumin">{ADMIN_ORDER_TEXT.empty}</p>
          ) : (
            <AdminOrderItemTable rows={data.rows} onOpen={(orderId) => router.push(`/admin/orders/${orderId}`)} />
          )}
          <div className="flex flex-wrap items-center gap-3 lk-text-3xs font-acumin">
            <Button variant="secondary" size="sm" className="font-acumin" disabled={page <= 1} onClick={() => setPage(page - 1)}>前の頁</Button>
            <span className="tabular-nums">{page} / {data.totalPages}ページ</span>
            <Button variant="secondary" size="sm" className="font-acumin" disabled={page >= data.totalPages} onClick={() => setPage(page + 1)}>次の頁</Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
