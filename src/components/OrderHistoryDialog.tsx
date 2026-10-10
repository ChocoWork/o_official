'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button/Button';
import { Dialog } from '@/components/ui/Dialog/Dialog';
import { StatusBadge } from '@/components/ui/StatusBadge/StatusBadge';
import { clientFetch } from '@/lib/client-fetch';
import type {
  OrderEmailContentResponse,
  OrderHistoryCompletionEntry,
  OrderHistoryEmailEntry,
  OrderHistoryEntry,
  OrderHistoryFulfillmentEntry,
  OrderHistoryResponse,
} from '@/lib/orders/email/order-history';
import { callFulfillmentApi } from '@/lib/orders/fulfillment/fulfillment-client';
import { FULFILLMENT_FAILURE_MESSAGES } from '@/lib/orders/fulfillment/fulfillment-messages';
import type { CancelCompletionResponse, CancelFulfillmentResponse } from '@/lib/orders/fulfillment/fulfillment-types';
import { cn } from '@/lib/utils';

/** 取り消せる行（発送か仕上がり） */
type CancelTarget = OrderHistoryFulfillmentEntry | OrderHistoryCompletionEntry;

type View =
  | { name: 'list' }
  | { name: 'content'; entry: OrderHistoryEmailEntry; content: OrderEmailContentResponse | null; error: string | null }
  | { name: 'confirm'; entry: OrderHistoryEmailEntry }
  | { name: 'cancel'; entry: CancelTarget };

/** 履歴の行のボタンの種類。確かめの画面から戻る時に、同じ行の同じボタンへフォーカスを戻すのに使う */
type HistoryAction = 'content' | 'resend' | 'cancel';

/** 再送・取消の結果の知らせ。受け付けは status、断り・失敗は alert の入れ物に出す */
type Notice = { tone: 'success' | 'failure'; text: string };

type OrderHistoryDialogProps = {
  /** 開いている注文。null なら閉じている */
  orderId: string | null;
  onClose: () => void;
  /** 発送か仕上がりを取り消した（結果が分からない時も）。管理画面が一覧を読み直す */
  onChanged?: () => void;
};

type OrderHistoryDialogBodyProps = {
  orderId: string;
  onClose: () => void;
  onChanged?: () => void;
};

const RESEND_ACCEPTED_MESSAGE = '再送を受け付けました。少し待つと届きます。';
const RESEND_FAILED_MESSAGE = '再送を受け付けられませんでした。';
// 管理画面の隣の操作（src/app/admin/page.tsx の要対応・要確認の操作）と同じ文
const FORBIDDEN_MESSAGE = 'この操作の権限がありません。';
const CONTENT_FAILED_MESSAGE = 'メールの中身を読み込めませんでした。';
const CANCEL_UNCERTAIN_MESSAGE =
  '結果を確かめられませんでした。履歴を読み直しました。取り消されたかどうかは、この履歴で確かめてください。';

function formatJst(value: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function errorMessageOf(body: unknown, fallback: string): string {
  return body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string'
    ? (body as { error: string }).error
    : fallback;
}

/**
 * 再送が断られた時の文。窓口が日本語で返す 404（注文が無い）・409（今は再送できない）の文だけを出す。
 * 回数の制限などの共通の守りは英語の短い文なので出さない。権限（403）は、管理画面の隣の操作と同じ文にする。
 */
function resendRefusalMessage(status: number, body: unknown): string {
  if (status === 403) return FORBIDDEN_MESSAGE;
  if (status === 404 || status === 409) return errorMessageOf(body, RESEND_FAILED_MESSAGE);
  return RESEND_FAILED_MESSAGE;
}

/** 手で再送した行の印（履歴の行と中身の画面で同じ表示にする） */
function manualMark(entry: OrderHistoryEmailEntry): string {
  return `手で再送${entry.requestedByEmail ? `（${entry.requestedByEmail}）` : ''}`;
}

function cancelTargetId(entry: CancelTarget): string {
  return entry.type === 'fulfillment' ? entry.fulfillmentId : entry.completionId;
}

/** 確かめ・取消の画面が見ている行の番号。履歴や中身の画面では null */
function viewTargetId(view: View): string | null {
  if (view.name === 'confirm') return view.entry.emailId;
  if (view.name === 'cancel') return cancelTargetId(view.entry);
  return null;
}

function cancelSuccessText(entry: CancelTarget): string {
  return entry.type === 'fulfillment' ? `発送（${entry.number}回目）を取り消しました。` : '仕上がりを取り消しました。';
}

function formatItems(items: Array<{ name: string; quantity: number }>): string {
  return items.map((item) => `${item.name} × ${item.quantity}`).join(' / ');
}

/**
 * 「この注文の履歴」（グループ D 設計書 5 章。Shopify の注文の Timeline とメールの再送に合わせる）。
 * 状態の変化・メール・発送・仕上がり（とその取消）を新しい順に出し、送ったメールの中身・再送の確かめ・
 * 発送と仕上がりの取消の確かめを同じダイアログの中で切り替える（ダイアログを重ねると、Escape で外側も閉じるため）。
 * 再送や取消ができるかは窓口が決めた値に従う。
 *
 * 開くたびに中身を作り直す（key に注文を使う）。前の注文の履歴や画面の切り替えを残したまま開くと、
 * ダイアログが先に中の先頭のボタンへ移したフォーカスが、その後の状態の消去でボタンごと外れてしまう。
 */
export default function OrderHistoryDialog({ orderId, onClose, onChanged }: OrderHistoryDialogProps) {
  return orderId ? <OrderHistoryDialogBody key={orderId} orderId={orderId} onClose={onClose} onChanged={onChanged} /> : null;
}

function OrderHistoryDialogBody({ orderId, onClose, onChanged }: OrderHistoryDialogBodyProps) {
  const [history, setHistory] = useState<OrderHistoryResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [pendingNotice, setPendingNotice] = useState<{ targetId: string; notice: Notice } | null>(null);
  const [view, setView] = useState<View>({ name: 'list' });
  const [submitting, setSubmitting] = useState(false);
  // いま出ている画面の入れ物。画面ごとに同じ ref を使い、ダイアログのパネルを探す起点にする
  const viewRef = useRef<HTMLDivElement>(null);
  const shownView = useRef<View['name']>('list');
  const contentRequest = useRef(0);
  const returnFocus = useRef<{ id: string; action: HistoryAction } | null>(null);

  const load = useCallback(async (id: string) => {
    setLoadError(null);
    try {
      const response = await clientFetch(`/api/admin/orders/${id}/history`, { cache: 'no-store' });
      if (!response.ok) {
        setHistory(null);
        setLoadError(response.status === 403 ? '履歴を見る権限がありません。' : '履歴を読み込めませんでした。');
        return;
      }
      setHistory((await response.json()) as OrderHistoryResponse);
    } catch {
      setHistory(null);
      setLoadError('履歴を読み込めませんでした。');
    }
  }, []);

  useEffect(() => {
    void load(orderId);
  }, [orderId, load]);

  // 画面を切り替えると、押したボタンは画面ごと消えて、フォーカスがダイアログの外（body）へ落ちる（設計書 5-5、WCAG 2.4.3）。
  // 戻る・やめるでは同じ行のボタンへ戻す。ボタンが消えた場合と、それ以外の切り替えはパネルへ移す
  // （再送や取消の返事を待つ間の「やめる」も、返事の後の読み直しで行のボタンが消えるので、パネルへ移す）。
  // 最初の画面では動かさない（Dialog が開いた時に決めた場所を奪わない）
  useEffect(() => {
    if (shownView.current === view.name) return;
    shownView.current = view.name;
    const panel = viewRef.current?.closest<HTMLElement>('[role="dialog"]');
    const target = returnFocus.current;
    const opener = view.name === 'list' && target
      ? Array.from(panel?.querySelectorAll<HTMLButtonElement>('button[data-history-action]') ?? [])
          .find((button) => button.dataset.historyId === target.id && button.dataset.historyAction === target.action && !button.disabled)
      : null;
    returnFocus.current = null;
    (opener ?? panel)?.focus();
  }, [view.name]);

  // 焦点の移動と polite の文の挿入が同じ描画だと読み上げが落ちるため、上の移動の後の描画で文を入れる。
  // 別の行の確かめ・取消の画面にいる間は、その行の結果と誤解される知らせを出さずに取っておき、その画面を離れた時に出す。
  useEffect(() => {
    if (!pendingNotice) return;
    const viewTarget = viewTargetId(view);
    if (viewTarget !== null && viewTarget !== pendingNotice.targetId) return;
    setNotice(pendingNotice.notice);
    setPendingNotice(null);
  }, [pendingNotice, view]);

  const backToList = (id: string, action: HistoryAction) => {
    // 再送や取消の返事を待つ間は、返事の後の読み直しで行のボタンが消えうる（受け付けた行は再送できなくなり、
    // 取り消した行は取り消せなくなる）。消えるボタンへ戻すとフォーカスが body へ落ちるので、行は覚えず、上の effect でパネルへ移す
    returnFocus.current = action !== 'content' && submitting ? null : { id, action };
    setView({ name: 'list' });
  };

  const openContent = async (entry: OrderHistoryEmailEntry) => {
    const request = ++contentRequest.current;
    setNotice(null);
    setView({ name: 'content', entry, content: null, error: null });
    // 同じメールを開き直した要求も番号で区別し、戻った後や別のメールを開いた後の画面を前の返事で上書きしない
    const settle = (next: View) =>
      setView((current) => (
        contentRequest.current === request && current.name === 'content' && current.entry.emailId === entry.emailId ? next : current
      ));
    try {
      const response = await clientFetch(`/api/admin/orders/${orderId}/emails/${entry.emailId}`, { cache: 'no-store' });
      if (!response.ok) {
        settle({ name: 'content', entry, content: null, error: CONTENT_FAILED_MESSAGE });
        return;
      }
      settle({ name: 'content', entry, content: (await response.json()) as OrderEmailContentResponse, error: null });
    } catch {
      settle({ name: 'content', entry, content: null, error: CONTENT_FAILED_MESSAGE });
    }
  };

  const askResend = (entry: OrderHistoryEmailEntry) => {
    setNotice(null);
    setView({ name: 'confirm', entry });
  };

  const resend = async (entry: OrderHistoryEmailEntry) => {
    if (submitting) return;
    setSubmitting(true);
    // 前の知らせを消してから結果を出す（同じ文が続いても、入れ物の中の文字が変わって読み上げられる）
    setNotice(null);
    try {
      const response = await clientFetch(`/api/admin/orders/${orderId}/emails/resend`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // 発送のメールは、どの発送のメールかを窓口へ渡す
        body: JSON.stringify({ kind: entry.kind, ...(entry.fulfillmentId ? { fulfillmentId: entry.fulfillmentId } : {}) }),
      });
      const body: unknown = await response.json().catch(() => null);
      setPendingNotice({
        targetId: entry.emailId,
        notice: response.ok
          ? { tone: 'success', text: RESEND_ACCEPTED_MESSAGE }
          : { tone: 'failure', text: resendRefusalMessage(response.status, body) },
      });
    } catch {
      setPendingNotice({ targetId: entry.emailId, notice: { tone: 'failure', text: RESEND_FAILED_MESSAGE } });
    } finally {
      setSubmitting(false);
      // 履歴へ戻すのは、この行の確かめの画面にいる時だけ。別の画面は変えず、別の行の確かめでは上の effect が知らせを取っておく
      setView((current) =>
        current.name === 'confirm' && current.entry.emailId === entry.emailId ? { name: 'list' } : current,
      );
    }
    await load(orderId);
  };

  const askCancel = (entry: CancelTarget) => {
    setNotice(null);
    setView({ name: 'cancel', entry });
  };

  const cancel = async (entry: CancelTarget) => {
    if (submitting) return;
    setSubmitting(true);
    setNotice(null);
    const targetId = cancelTargetId(entry);
    const result = await callFulfillmentApi<CancelFulfillmentResponse | CancelCompletionResponse>(
      entry.type === 'fulfillment'
        ? `/api/admin/orders/${orderId}/fulfillments/${entry.fulfillmentId}/cancel`
        : `/api/admin/orders/${orderId}/completions/${entry.completionId}/cancel`,
      undefined,
      entry.type === 'fulfillment' ? FULFILLMENT_FAILURE_MESSAGES.cancel : FULFILLMENT_FAILURE_MESSAGES.completion_cancel,
    );
    setSubmitting(false);
    if (result.kind === 'refused') {
      // 断られた＝何も変わっていない。確かめの画面に留まり、理由をその画面に出す（やめることも、押し直すこともできる）
      setPendingNotice({ targetId, notice: { tone: 'failure', text: result.message } });
    } else {
      // 取り消した（もう取り消してあった時も同じ）か、結果が分からない。どちらも状態が変わりうるので一覧を読み直させ、
      // 履歴へ戻る。取り消した行のボタンは消えるので、フォーカスはパネルへ移す
      onChanged?.();
      returnFocus.current = null;
      setPendingNotice({
        targetId,
        notice: result.kind === 'ok'
          ? { tone: 'success', text: cancelSuccessText(entry) }
          : { tone: 'failure', text: CANCEL_UNCERTAIN_MESSAGE },
      });
      setView((current) => (current.name === 'cancel' && cancelTargetId(current.entry) === targetId ? { name: 'list' } : current));
    }
    await load(orderId);
  };

  const title =
    view.name === 'content'
      ? `${view.entry.kindLabel}のメールの中身`
      : view.name === 'confirm'
        ? 'お客様へ再送'
        : view.name === 'cancel'
          ? (view.entry.type === 'fulfillment' ? 'この発送を取り消す' : 'この仕上がりを取り消す')
          : 'この注文の履歴';
  const statusText = notice?.tone === 'success' ? notice.text : null;
  const failureText = notice?.tone === 'failure' ? notice.text : null;

  const renderEntry = (entry: OrderHistoryEntry, index: number) => {
    if (entry.type === 'created') {
      return (
        <li key={`created-${index}`} className="font-acumin lk-text-3xs text-black">
          <span className="text-[#474747]">{formatJst(entry.at)}</span> 注文を受け付けました
        </li>
      );
    }
    if (entry.type === 'status') {
      return (
        <li key={`status-${index}`} className="font-acumin lk-text-3xs text-black">
          <span className="text-[#474747]">{formatJst(entry.at)}</span> {entry.fromLabel ? `${entry.fromLabel} → ` : ''}
          {entry.toLabel}
          {entry.detail ? <span className="block text-[#474747]">{entry.detail}</span> : null}
          {entry.actorEmail ? <span className="block text-[#474747]">操作: {entry.actorEmail}</span> : null}
        </li>
      );
    }
    if (entry.type === 'fulfillment') {
      return (
        <li key={`fulfillment-${entry.fulfillmentId}`} className="space-y-1 font-acumin lk-text-3xs text-black">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[#474747]">{formatJst(entry.at)}</span>
            <span>{`発送（${entry.number}回目）`}</span>
            {entry.cancelled ? (
              <StatusBadge tone="neutral" size="sm">
                取り消し済み
              </StatusBadge>
            ) : null}
          </div>
          <p className="text-[#474747]">{`配送業者: ${entry.carrierLabel ?? '-'} / 伝票番号: ${entry.trackingNumber ?? '-'}`}</p>
          <p>{`商品: ${formatItems(entry.items)}`}</p>
          <p className="text-[#474747]">{`お客様へのメール: ${entry.notifyCustomer ? '送る' : '送らない'}`}</p>
          {entry.completesOrder ? <p className="text-[#474747]">この発送で全部を送りました</p> : null}
          {entry.actorEmail ? <p className="text-[#474747]">操作: {entry.actorEmail}</p> : null}
          {entry.cancellable ? (
            <div className="flex flex-wrap gap-2">
              <Button
                variant="secondary"
                size="sm"
                className="font-acumin"
                data-history-id={entry.fulfillmentId}
                data-history-action="cancel"
                onClick={() => askCancel(entry)}
              >
                この発送を取り消す
              </Button>
            </div>
          ) : null}
        </li>
      );
    }
    if (entry.type === 'fulfillment_cancel') {
      return (
        <li key={`fulfillment-cancel-${entry.fulfillmentId}`} className="font-acumin lk-text-3xs text-black">
          <span className="text-[#474747]">{formatJst(entry.at)}</span> {`発送（${entry.number}回目）を取り消しました`}
          {entry.actorEmail ? <span className="block text-[#474747]">操作: {entry.actorEmail}</span> : null}
        </li>
      );
    }
    if (entry.type === 'completion') {
      return (
        <li key={`completion-${entry.completionId}`} className="space-y-1 font-acumin lk-text-3xs text-black">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[#474747]">{formatJst(entry.at)}</span>
            <span>受注生産の品が仕上がりました</span>
            {entry.cancelled ? (
              <StatusBadge tone="neutral" size="sm">
                取り消し済み
              </StatusBadge>
            ) : null}
          </div>
          <p>{`商品: ${formatItems(entry.items)}`}</p>
          {entry.actorEmail ? <p className="text-[#474747]">操作: {entry.actorEmail}</p> : null}
          {entry.cancellable ? (
            <div className="flex flex-wrap gap-2">
              <Button
                variant="secondary"
                size="sm"
                className="font-acumin"
                data-history-id={entry.completionId}
                data-history-action="cancel"
                onClick={() => askCancel(entry)}
              >
                この仕上がりを取り消す
              </Button>
            </div>
          ) : null}
        </li>
      );
    }
    if (entry.type === 'completion_cancel') {
      return (
        <li key={`completion-cancel-${entry.completionId}`} className="font-acumin lk-text-3xs text-black">
          <span className="text-[#474747]">{formatJst(entry.at)}</span> 仕上がりを取り消しました
          {entry.actorEmail ? <span className="block text-[#474747]">操作: {entry.actorEmail}</span> : null}
        </li>
      );
    }
    return (
      <li key={`email-${entry.emailId}`} className="space-y-1 font-acumin lk-text-3xs text-black">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[#474747]">{formatJst(entry.at)}</span>
          <span>{entry.kindLabel}のメール</span>
          {entry.manual ? <span className="text-[#474747]">{manualMark(entry)}</span> : null}
          {entry.warning ? <span className="font-semibold text-red-700">注意</span> : null}
          <StatusBadge tone={entry.warning ? 'danger' : 'neutral'} size="sm">
            {entry.stateLabel}
          </StatusBadge>
        </div>
        {entry.errorLabel ? <p className="text-[#474747]">原因: {entry.errorLabel}</p> : null}
        {entry.attempts > 1 ? <p className="text-[#474747]">試した回数: {entry.attempts}回</p> : null}
        <div className="flex flex-wrap gap-2">
          {entry.canViewContent ? (
            <Button variant="secondary" size="sm" className="font-acumin" data-history-id={entry.emailId} data-history-action="content" onClick={() => void openContent(entry)}>
              中身を見る
            </Button>
          ) : null}
          {entry.resendable ? (
            <Button variant="secondary" size="sm" className="font-acumin" data-history-id={entry.emailId} data-history-action="resend" onClick={() => askResend(entry)}>
              お客様へ再送
            </Button>
          ) : null}
        </div>
      </li>
    );
  };

  return (
    <Dialog open onClose={onClose} title={title}>
      {/*
        再送・取消の結果と履歴の読み込みの誤りの知らせ。画面を切り替えても履歴を読み直しても消えない入れ物を最初から置き、
        中の文字だけを変える（後から差し込んだ入れ物は、読み上げられない環境が多い）。受け付けは status、断り・失敗は alert
      */}
      <p role="status" aria-live="polite" className={cn('font-acumin lk-text-3xs text-black', statusText && 'mb-3')}>
        {statusText}
      </p>
      <div role="alert" className={cn('font-acumin lk-text-3xs text-red-700', (loadError || failureText) && 'mb-3')}>
        {loadError ? <p>{loadError}</p> : null}
        {failureText ? <p>{failureText}</p> : null}
      </div>

      {view.name === 'list' ? (
        <div ref={viewRef} className="space-y-3">
          {!history && !loadError ? <p className="font-acumin lk-text-3xs text-[#474747]">読み込み中です...</p> : null}
          {history ? (
            <>
              <p className="font-acumin lk-text-3xs text-[#474747]">
                {history.order.orderNumber}（{history.order.statusLabel}）
              </p>
              <p className="font-acumin lk-text-3xs text-black">宛先: {history.order.recipient ?? 'なし'}</p>
              {/* role は付けない（画面へ戻るたびに差し込み直されて、同じ読み上げをくり返すため）。見出しの近くの文として読ませる */}
              {history.sendPaused ? (
                <p className="font-acumin lk-text-3xs text-red-700">
                  メールの送信を一時停止しています（{history.sendPaused.reasonLabel}）
                </p>
              ) : null}
              <ol className="max-h-[60vh] space-y-3 overflow-y-auto">{history.entries.map(renderEntry)}</ol>
            </>
          ) : null}
          <Button variant="secondary" size="sm" className="w-full font-acumin" onClick={onClose}>
            閉じる
          </Button>
        </div>
      ) : null}

      {view.name === 'content' ? (
        <div ref={viewRef} className="space-y-3">
          {view.error ? (
            <p role="alert" className="font-acumin lk-text-3xs text-red-700">
              {view.error}
            </p>
          ) : null}
          {!view.content && !view.error ? <p className="font-acumin lk-text-3xs text-[#474747]">読み込み中です...</p> : null}
          {view.content && (view.content.sentAt || view.entry.manual) ? (
            <p className="flex flex-wrap items-center gap-2 font-acumin lk-text-3xs text-[#474747]">
              {view.content.sentAt ? <span>送った時刻: {formatJst(view.content.sentAt)}</span> : null}
              {view.entry.manual ? <span>{manualMark(view.entry)}</span> : null}
            </p>
          ) : null}
          {view.content?.status === 'erased' ? (
            <p className="font-acumin lk-text-3xs text-black">本文の保存期間（45日）を過ぎました</p>
          ) : null}
          {view.content?.status === 'available' ? (
            <>
              <p className="font-acumin lk-text-3xs font-semibold text-black">{view.content.subject}</p>
              {/* 高さを限ってスクロールするので、キーボードでも届いてスクロールできるよう、フォーカスできて名前の付く欄にする */}
              <pre
                role="region"
                aria-label="メールの本文"
                tabIndex={0}
                className="max-h-[50vh] overflow-y-auto whitespace-pre-wrap break-words font-acumin lk-text-3xs text-black"
              >
                {view.content.bodyText}
              </pre>
            </>
          ) : null}
          <Button variant="secondary" size="sm" className="w-full font-acumin" onClick={() => backToList(view.entry.emailId, 'content')}>
            戻る
          </Button>
        </div>
      ) : null}

      {view.name === 'confirm' ? (
        <div ref={viewRef} className="space-y-3">
          <p className="font-acumin lk-text-3xs text-black">
            {view.entry.kindLabel}のメールを、お客様（注文のメールアドレス）へもう一度送ります
          </p>
          {history?.order.recipient ? (
            <p className="font-acumin lk-text-3xs text-[#474747]">宛先: {history.order.recipient}</p>
          ) : null}
          <div className="flex gap-2 pt-1">
            <Button variant="secondary" size="sm" className="w-full font-acumin" onClick={() => backToList(view.entry.emailId, 'resend')}>
              やめる
            </Button>
            <Button
              variant="primary"
              size="sm"
              className="w-full font-acumin"
              disabled={submitting}
              onClick={() => void resend(view.entry)}
            >
              再送する
            </Button>
          </div>
        </div>
      ) : null}

      {view.name === 'cancel' ? (
        <div ref={viewRef} className="space-y-3">
          <p className="font-acumin lk-text-3xs text-black">
            {view.entry.type === 'fulfillment'
              ? `発送（${view.entry.number}回目）を取り消し、その商品を発送準備中に戻します。お客様にメールは送りません。送った発送のメールがあれば、店からお客様に連絡してください。`
              : 'この仕上がりを取り消し、その商品を受注生産中に戻します。'}
          </p>
          <div className="flex gap-2 pt-1">
            <Button variant="secondary" size="sm" className="w-full font-acumin" onClick={() => backToList(cancelTargetId(view.entry), 'cancel')}>
              やめる
            </Button>
            <Button
              variant="primary"
              size="sm"
              className="w-full font-acumin"
              disabled={submitting}
              onClick={() => void cancel(view.entry)}
            >
              取り消す
            </Button>
          </div>
        </div>
      ) : null}
    </Dialog>
  );
}
