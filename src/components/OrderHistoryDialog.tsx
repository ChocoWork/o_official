'use client';

import { useCallback, useEffect, useState } from 'react';
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

type View =
  | { name: 'list' }
  | { name: 'content'; entry: OrderHistoryEmailEntry; content: OrderEmailContentResponse | null; error: string | null }
  | { name: 'confirm'; entry: OrderHistoryEmailEntry };

type OrderHistoryDialogProps = {
  /** 開いている注文。null なら閉じている */
  orderId: string | null;
  onClose: () => void;
};

type OrderHistoryDialogBodyProps = {
  orderId: string;
  onClose: () => void;
};

const RESEND_FAILED_MESSAGE = '再送を受け付けられませんでした。';

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
  const [notice, setNotice] = useState<string | null>(null);
  const [view, setView] = useState<View>({ name: 'list' });
  const [submitting, setSubmitting] = useState(false);

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

  const openContent = async (entry: OrderHistoryEmailEntry) => {
    setView({ name: 'content', entry, content: null, error: null });
    try {
      const response = await clientFetch(`/api/admin/orders/${orderId}/emails/${entry.emailId}`, { cache: 'no-store' });
      if (!response.ok) {
        setView({ name: 'content', entry, content: null, error: 'メールの中身を読み込めませんでした。' });
        return;
      }
      setView({ name: 'content', entry, content: (await response.json()) as OrderEmailContentResponse, error: null });
    } catch {
      setView({ name: 'content', entry, content: null, error: 'メールの中身を読み込めませんでした。' });
    }
  };

  const resend = async (entry: OrderHistoryEmailEntry) => {
    if (submitting) return;
    setSubmitting(true);
    try {
      const response = await clientFetch(`/api/admin/orders/${orderId}/emails/resend`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: entry.kind }),
      });
      const body: unknown = await response.json().catch(() => null);
      // 窓口が日本語で返す断りの理由（注文が無い 404・今は再送できない 409）だけを出す。
      // 権限・回数の制限などの共通の守りは英語の短い文なので、画面には出さない
      const reasonShown = response.status === 404 || response.status === 409;
      setNotice(
        response.ok
          ? '再送を受け付けました。少し待つと届きます。'
          : reasonShown
            ? errorMessageOf(body, RESEND_FAILED_MESSAGE)
            : RESEND_FAILED_MESSAGE,
      );
    } catch {
      setNotice(RESEND_FAILED_MESSAGE);
    } finally {
      setSubmitting(false);
      setView({ name: 'list' });
    }
    await load(orderId);
  };

  const title =
    view.name === 'content' ? `${view.entry.kindLabel}のメールの中身` : view.name === 'confirm' ? 'お客様へ再送' : 'この注文の履歴';

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
          {entry.manual ? <span className="text-[#474747]">手で再送{entry.requestedByEmail ? `（${entry.requestedByEmail}）` : ''}</span> : null}
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
            <Button variant="secondary" size="sm" className="font-acumin" onClick={() => setView({ name: 'confirm', entry })}>
              お客様へ再送
            </Button>
          ) : null}
        </div>
      </li>
    );
  };

  return (
    <Dialog open onClose={onClose} title={title}>
      {view.name === 'list' ? (
        <div className="space-y-3">
          {loadError ? (
            <p role="alert" className="font-acumin lk-text-3xs text-red-700">
              {loadError}
            </p>
          ) : null}
          {!history && !loadError ? <p className="font-acumin lk-text-3xs text-[#474747]">読み込み中です...</p> : null}
          {history ? (
            <>
              <p className="font-acumin lk-text-3xs text-[#474747]">
                {history.order.orderNumber}（{history.order.statusLabel}）
              </p>
              <p className="font-acumin lk-text-3xs text-black">宛先: {history.order.recipient ?? 'なし'}</p>
              {history.sendPaused ? (
                <p role="alert" className="font-acumin lk-text-3xs text-red-700">
                  メールの送信を一時停止しています（{history.sendPaused.reasonLabel}）
                </p>
              ) : null}
              {notice ? (
                <p role="status" aria-live="polite" className="font-acumin lk-text-3xs text-black">
                  {notice}
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
        <div className="space-y-3">
          {view.error ? (
            <p role="alert" className="font-acumin lk-text-3xs text-red-700">
              {view.error}
            </p>
          ) : null}
          {!view.content && !view.error ? <p className="font-acumin lk-text-3xs text-[#474747]">読み込み中です...</p> : null}
          {view.content?.status === 'erased' ? (
            <p className="font-acumin lk-text-3xs text-black">本文の保存期間（45日）を過ぎました</p>
          ) : null}
          {view.content?.status === 'available' ? (
            <>
              <p className="font-acumin lk-text-3xs font-semibold text-black">{view.content.subject}</p>
              <pre className="max-h-[50vh] overflow-y-auto whitespace-pre-wrap break-words font-acumin lk-text-3xs text-black">
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
        <div className="space-y-3">
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
