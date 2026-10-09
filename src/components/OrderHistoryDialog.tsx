'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button/Button';
import { Dialog } from '@/components/ui/Dialog/Dialog';
import { StatusBadge } from '@/components/ui/StatusBadge/StatusBadge';
import { clientFetch } from '@/lib/client-fetch';
import type {
  OrderEmailContentResponse,
  OrderHistoryEmailEntry,
  OrderHistoryEntry,
  OrderHistoryResponse,
} from '@/lib/orders/email/order-history';
import { cn } from '@/lib/utils';

type View =
  | { name: 'list' }
  | { name: 'content'; entry: OrderHistoryEmailEntry; content: OrderEmailContentResponse | null; error: string | null }
  | { name: 'confirm'; entry: OrderHistoryEmailEntry };

/** 再送の結果の知らせ。受け付けは status、断り・失敗は alert の入れ物に出す */
type Notice = { tone: 'success' | 'failure'; text: string };

type OrderHistoryDialogProps = {
  /** 開いている注文。null なら閉じている */
  orderId: string | null;
  onClose: () => void;
};

type OrderHistoryDialogBodyProps = {
  orderId: string;
  onClose: () => void;
};

const RESEND_ACCEPTED_MESSAGE = '再送を受け付けました。少し待つと届きます。';
const RESEND_FAILED_MESSAGE = '再送を受け付けられませんでした。';
// 管理画面の隣の操作（src/app/admin/page.tsx の要対応・要確認の操作）と同じ文
const FORBIDDEN_MESSAGE = 'この操作の権限がありません。';
const CONTENT_FAILED_MESSAGE = 'メールの中身を読み込めませんでした。';

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

/**
 * 「この注文の履歴」（グループ D 設計書 5 章。Shopify の注文の Timeline とメールの再送に合わせる）。
 * 状態の変化とメールを新しい順に出し、送ったメールの中身と再送の確かめを同じダイアログの中で切り替える
 * （ダイアログを重ねると、Escape で外側も閉じるため）。再送できるかは窓口が決めた値に従う。
 *
 * 開くたびに中身を作り直す（key に注文を使う）。前の注文の履歴や画面の切り替えを残したまま開くと、
 * ダイアログが先に中の先頭のボタンへ移したフォーカスが、その後の状態の消去でボタンごと外れてしまう。
 */
export default function OrderHistoryDialog({ orderId, onClose }: OrderHistoryDialogProps) {
  return orderId ? <OrderHistoryDialogBody key={orderId} orderId={orderId} onClose={onClose} /> : null;
}

function OrderHistoryDialogBody({ orderId, onClose }: OrderHistoryDialogBodyProps) {
  const [history, setHistory] = useState<OrderHistoryResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [view, setView] = useState<View>({ name: 'list' });
  const [submitting, setSubmitting] = useState(false);
  // いま出ている画面の入れ物。3つの画面で同じ ref を使い、ダイアログのパネルを探す起点にする
  const viewRef = useRef<HTMLDivElement>(null);
  const shownView = useRef<View['name']>('list');

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
  // 消えないパネルへ移し、新しい題を読ませる。最初の画面では動かさない（Dialog が開いた時に決めた場所を奪わない）
  useEffect(() => {
    if (shownView.current === view.name) return;
    shownView.current = view.name;
    viewRef.current?.closest<HTMLElement>('[role="dialog"]')?.focus();
  }, [view.name]);

  const openContent = async (entry: OrderHistoryEmailEntry) => {
    setNotice(null);
    setView({ name: 'content', entry, content: null, error: null });
    // 返事を待つ間に「戻る」を押したり別のメールを開いたりしていたら、その画面を前の返事で上書きしない
    const settle = (next: View) =>
      setView((current) => (current.name === 'content' && current.entry.emailId === entry.emailId ? next : current));
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
        body: JSON.stringify({ kind: entry.kind }),
      });
      const body: unknown = await response.json().catch(() => null);
      setNotice(
        response.ok
          ? { tone: 'success', text: RESEND_ACCEPTED_MESSAGE }
          : { tone: 'failure', text: resendRefusalMessage(response.status, body) },
      );
    } catch {
      setNotice({ tone: 'failure', text: RESEND_FAILED_MESSAGE });
    } finally {
      setSubmitting(false);
      // 履歴へ戻すのは、この行の確かめの画面にいる時だけ。待つ間に別の画面へ移っていたら、画面は変えずに知らせだけ出す
      setView((current) =>
        current.name === 'confirm' && current.entry.emailId === entry.emailId ? { name: 'list' } : current,
      );
    }
    await load(orderId);
  };

  const title =
    view.name === 'content' ? `${view.entry.kindLabel}のメールの中身` : view.name === 'confirm' ? 'お客様へ再送' : 'この注文の履歴';
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
            <Button variant="secondary" size="sm" className="font-acumin" onClick={() => void openContent(entry)}>
              中身を見る
            </Button>
          ) : null}
          {entry.resendable ? (
            <Button variant="secondary" size="sm" className="font-acumin" onClick={() => askResend(entry)}>
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
        再送の結果と履歴の読み込みの誤りの知らせ。画面を切り替えても履歴を読み直しても消えない入れ物を最初から置き、
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
          <Button variant="secondary" size="sm" className="w-full font-acumin" onClick={() => setView({ name: 'list' })}>
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
            <Button variant="secondary" size="sm" className="w-full font-acumin" onClick={() => setView({ name: 'list' })}>
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
    </Dialog>
  );
}
