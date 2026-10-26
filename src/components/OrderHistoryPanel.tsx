'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/Button/Button';
import { StatusBadge, type StatusBadgeTone } from '@/components/ui/StatusBadge/StatusBadge';
import { clientFetch } from '@/lib/client-fetch';
import type {
  OrderEmailContentResponse,
  OrderHistoryDeliveryEventEntry,
  OrderHistoryEmailEntry,
  OrderHistoryEntry,
  OrderHistoryFulfillmentEntry,
  OrderHistoryResponse,
  OrderHistoryTrackingChangeEntry,
} from '@/lib/orders/email/order-history';
import { formatYen } from '@/lib/orders/refund/refund-messages';
import { formatOpenSlipLabel, SHIPMENT_SLIP_TEXT } from '@/lib/orders/shipment-slips/shipment-slip-types';
import { SHIPPING_CARRIERS, isShippingCarrierId } from '@/lib/orders/shipping-carriers';
import { DELIVERY_STATUS_LABELS, TRACKING_STATE_LABELS } from '@/lib/orders/tracking/delivery-messages';
import type { DeliveryStatus, FulfillmentDeliveryDetail, TrackingChange } from '@/lib/orders/tracking/delivery-types';
import { cn } from '@/lib/utils';
import { ADMIN_ORDER_TEXT, itemStateReasonLabel } from '@/lib/orders/admin-orders/admin-order-types';
import { ADMIN_ITEM_STATUS_LABELS } from '@/lib/orders/item-state/item-state-types';
import { toOrderNumber } from '@/lib/orders/order-number';

type View =
  | { name: 'list' }
  | { name: 'content'; entry: OrderHistoryEmailEntry; content: OrderEmailContentResponse | null; error: string | null }
  | { name: 'confirm'; entry: OrderHistoryEmailEntry };

/** 履歴の行のボタンの種類。確かめの画面から戻る時に、同じ行の同じボタンへフォーカスを戻すのに使う */
type HistoryAction = 'content' | 'resend';

/** 再送の結果の知らせ。受け付けは status、断り・失敗は alert の入れ物に出す */
type Notice = { tone: 'success' | 'failure'; text: string };

type OrderHistoryPanelProps = {
  orderId: string;
};

const RESEND_ACCEPTED_MESSAGE = '再送を受け付けました。少し待つと届きます。';
const RESEND_FAILED_MESSAGE = '再送を受け付けられませんでした。';
// 管理画面の隣の操作（src/app/admin/page.tsx の要対応・要確認の操作）と同じ文
const FORBIDDEN_MESSAGE = 'この操作の権限がありません。';
const CONTENT_FAILED_MESSAGE = 'メールの中身を読み込めませんでした。';
const DELIVERED_SOURCE_LABELS = { tracking: '追跡', manual: '手で' } as const;

/** 配送の状況の印の色。店が動く番の状況（不在・遅れ・問題あり）を目立たせる */
const DELIVERY_STATUS_TONES: Record<DeliveryStatus, StatusBadgeTone> = {
  confirmed: 'neutral',
  in_transit: 'neutral',
  out_for_delivery: 'neutral',
  attempted_delivery: 'warning',
  ready_for_pickup: 'neutral',
  delivered: 'positive',
  delayed: 'warning',
  failure: 'danger',
};

function formatJst(value: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

/** 日本時間の「M月D日」（0詰めなし）。読めない時はそのまま返す。届いた日は日本時間の日付で数える（返品の期限が日本時間の日付で決まるため） */
function formatMonthDay(value: string): string {
  const time = Date.parse(value);
  if (Number.isNaN(time)) return value;
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric' }).formatToParts(new Date(time));
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;
  return month && day ? `${month}月${day}日` : value;
}

/** 「ヤマト運輸 1234-5678」。配送業者か番号が空ならその側だけを省き、どちらも空なら「記録なし」 */
function carrierAndNumber(carrier: string | null, trackingNumber: string | null): string {
  const label = carrier !== null && isShippingCarrierId(carrier) ? SHIPPING_CARRIERS[carrier].label : carrier;
  return [label, trackingNumber].filter((part): part is string => Boolean(part)).join(' ') || '記録なし';
}

/** 直しのメールの状態の言葉。メールが無い（null）・取りやめた（skipped）は「送らない」 */
function trackingChangeEmailLabel(status: TrackingChange['emailStatus']): string {
  switch (status) {
    case 'sent':
      return '送信済み';
    case 'pending':
    case 'sending':
    case 'retry_wait':
      return '送信待ち';
    case 'dead':
      return '送れなかった';
    default:
      return '送らない';
  }
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

/** 再送の確かめの画面が見ている行の番号。履歴や中身の画面では null */
function viewTargetId(view: View): string | null {
  return view.name === 'confirm' ? view.entry.emailId : null;
}

/** 数が0の商品は「× 0」を付けず品名だけにする（確保し直せた数が0の商品が出る。足りなかった数は別の行が伝える） */
function formatItems(items: Array<{ name: string; quantity: number }>): string {
  return items.map((item) => (item.quantity > 0 ? `${item.name} × ${item.quantity}` : item.name)).join(' / ');
}

/**
 * 注文の詳細（/admin/orders/[id]）の「変更履歴」（グループ D 設計書 5 章。Shopify の注文の Timeline とメールの再送に合わせる）。
 * 品物の状態の変化・メール・発送（とその取消）・返金・返品を新しい順に出し、送ったメールの中身・再送の確かめを
 * 同じ欄の中で切り替える。再送できるかは窓口が決めた値に従う。
 * 配送（グループ E-4）: 発送の行に届いた日・現在の状況・登録の状態、出来事と伝票番号の直しの行を出す。
 * G-1 Task 15: 「伝票番号を直す」「配達済みにする」「この発送を取り消す」と仕上がりの行・その取消は撤去した。
 * 履歴の一覧の上に、発送の停止の文を1回出す（窓口が昔の形で cancellable を true にしても、取消の入口は出さない）。
 * G-4 Task 8: 荷作り表から開いていた履歴の dialog は撤去した。ここは詳細の頁に埋め込む形だけを持つ。
 *
 * 注文が変わったら中身を作り直す（key に注文を使う）。前の注文の履歴や画面の切り替えを残したままにすると、
 * 先に移したフォーカスが、その後の状態の消去でボタンごと外れてしまう。
 */
export default function OrderHistoryPanel({ orderId }: OrderHistoryPanelProps): React.JSX.Element {
  return <OrderHistoryPanelBody key={orderId} orderId={orderId} />;
}

function OrderHistoryPanelBody({ orderId }: OrderHistoryPanelProps) {
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

  // 画面を切り替えると、押したボタンは画面ごと消えて、フォーカスが欄の外（body）へ落ちる（設計書 5-5、WCAG 2.4.3）。
  // 戻る・やめるでは同じ行のボタンへ戻す。ボタンが消えた場合と、それ以外の切り替えはパネルへ移す
  // （再送の返事を待つ間の「やめる」も、返事の後の読み直しで行のボタンが消えるので、パネルへ移す）。
  // 最初の画面では動かさない（頁を開いた時のフォーカスの場所を奪わない）
  useEffect(() => {
    if (shownView.current === view.name) return;
    shownView.current = view.name;
    const panel = viewRef.current?.closest<HTMLElement>('[data-order-history-panel]');
    const target = returnFocus.current;
    const opener = view.name === 'list' && target
      ? Array.from(panel?.querySelectorAll<HTMLButtonElement>('button[data-history-action]') ?? [])
          .find((button) => button.dataset.historyId === target.id && button.dataset.historyAction === target.action && !button.disabled)
      : null;
    returnFocus.current = null;
    (opener ?? panel)?.focus();
  }, [view.name]);

  // 焦点の移動と polite の文の挿入が同じ描画だと読み上げが落ちるため、上の移動の後の描画で文を入れる。
  // 別の行の確かめの画面にいる間は、その行の結果と誤解される知らせを出さずに取っておき、その画面を離れた時に出す。
  useEffect(() => {
    if (!pendingNotice) return;
    const viewTarget = viewTargetId(view);
    if (viewTarget !== null && viewTarget !== pendingNotice.targetId) return;
    setNotice(pendingNotice.notice);
    setPendingNotice(null);
  }, [pendingNotice, view]);

  const backToList = (id: string, action: HistoryAction) => {
    // 再送の返事を待つ間は、返事の後の読み直しで行のボタンが消えうる（受け付けた行は再送できなくなる）。
    // 消えるボタンへ戻すとフォーカスが body へ落ちるので、行は覚えず、上の effect でパネルへ移す
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

  const statusText = notice?.tone === 'success' ? notice.text : null;
  const failureText = notice?.tone === 'failure' ? notice.text : null;

  // 追跡がオンの時だけ、現在の状況と登録の状態を出す。届いた日・出来事・直しの記録は、オフでも出す（設計書 6-1）。
  // 窓口が追跡のオン・オフを返さない昔の見本は、オフとして読む
  const trackingEnabled = history?.deliveryTrackingEnabled === true;

  /** 発送の行の配送の欄: 届いた日と出どころ（いつも）、今の状況・最後の更新・登録の状態（追跡オンで、取り消していない発送だけ） */
  const renderFulfillmentDelivery = (entry: OrderHistoryFulfillmentEntry, delivery: FulfillmentDeliveryDetail) => (
    <>
      {delivery.deliveredAt !== null ? (
        <p className="text-[#474747]">
          {`お届け日 ${formatMonthDay(delivery.deliveredAt)}${delivery.deliveredSource ? `（${DELIVERED_SOURCE_LABELS[delivery.deliveredSource]}）` : ''}`}
        </p>
      ) : null}
      {trackingEnabled && !entry.cancelled ? (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <span>{`配送の状況（${entry.number}回目）`}</span>
            <StatusBadge tone={DELIVERY_STATUS_TONES[delivery.deliveryStatus]} size="sm">
              {DELIVERY_STATUS_LABELS[delivery.deliveryStatus]}
            </StatusBadge>
            {delivery.registration ? (
              <span className="text-[#474747]">{TRACKING_STATE_LABELS[delivery.registration.state]}</span>
            ) : null}
          </div>
          <p className="text-[#474747]">{`最後の更新 ${formatJst(delivery.deliveryStatusAt)}`}</p>
        </>
      ) : null}
    </>
  );

  /** 配送の出来事の行（状況と時刻。17TRACK の細かい状況は小さな字で、文字のまま出す） */
  const renderDeliveryEvent = (entry: OrderHistoryDeliveryEventEntry) => (
    <li key={`delivery-event-${entry.event.id}`} className="space-y-1 font-acumin lk-text-3xs text-black">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[#474747]">{formatJst(entry.at)}</span>
        <span>{`配送の状況（${entry.number}回目）`}</span>
        <StatusBadge tone={DELIVERY_STATUS_TONES[entry.event.status]} size="sm">
          {DELIVERY_STATUS_LABELS[entry.event.status]}
        </StatusBadge>
      </div>
      {entry.event.providerSubStatus ? <p className="break-all lk-text-4xs text-[#474747]">{entry.event.providerSubStatus}</p> : null}
      {entry.event.actorEmail ? <p className="text-[#474747]">操作: {entry.event.actorEmail}</p> : null}
    </li>
  );

  /** 伝票番号の直しの行（前の値 → 新しい値と、お客様へのメールの状態） */
  const renderTrackingChange = (entry: OrderHistoryTrackingChangeEntry) => {
    const { change } = entry;
    return (
      <li key={`tracking-change-${change.id}`} className="space-y-1 font-acumin lk-text-3xs text-black">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[#474747]">{formatJst(entry.at)}</span>
          <span>{`伝票番号を直した（${entry.number}回目）`}</span>
        </div>
        <p className="break-all text-[#474747]">
          {`${carrierAndNumber(change.fromCarrier, change.fromTrackingNumber)} → ${carrierAndNumber(change.toCarrier, change.toTrackingNumber)}`}
        </p>
        <p className="text-[#474747]">{`お客様へのメール：${trackingChangeEmailLabel(change.emailStatus)}`}</p>
        {change.actorEmail ? <p className="text-[#474747]">操作: {change.actorEmail}</p> : null}
      </li>
    );
  };

  const renderEntry = (entry: OrderHistoryEntry, index: number) => {
    // 配送の新しい行は Task 10 で表示する。既存のメール行には渡さない。
    if (entry.type === 'delivery_event') return renderDeliveryEvent(entry);
    if (entry.type === 'tracking_change') return renderTrackingChange(entry);
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
      const delivery = entry.delivery;
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
          {/* 伝票番号は英数字とハイフンが64字まで続くことがあるので、狭い画面では字の途中でも折り返す */}
          <p className="break-all text-[#474747]">{`配送業者: ${entry.carrierLabel ?? '-'} / 伝票番号: ${entry.trackingNumber ?? '-'}`}</p>
          <p>{`商品: ${formatItems(entry.items)}`}</p>
          <p className="text-[#474747]">{`お客様へのメール: ${entry.notifyCustomer ? '送る' : '送らない'}`}</p>
          {entry.completesOrder ? <p className="text-[#474747]">この発送で全部を送りました</p> : null}
          {entry.actorEmail ? <p className="text-[#474747]">操作: {entry.actorEmail}</p> : null}
          {entry.slipId && entry.slipNumber ? (
            <p>
              <Link href={`/admin/shipment-slips/${entry.slipId}`} className="underline underline-offset-4">
                {formatOpenSlipLabel(entry.slipNumber)}
              </Link>
            </p>
          ) : null}
          {delivery ? renderFulfillmentDelivery(entry, delivery) : null}
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
    if (entry.type === 'refund') {
      const current = entry.steps.at(-1);
      // 在庫に戻せるのは発送前の商品だけ。「戻さない」の返金にも 0 を出して、戻さなかったことを履歴で確かめられるようにする
      const hasBeforeShipmentItems = entry.items.some((item) => item.beforeShipment);
      const restockedTotal = entry.items.reduce((sum, item) => sum + item.restockedQuantity, 0);
      return (
        <li key={`refund-${entry.refundId}`} className="space-y-1 font-acumin lk-text-3xs text-black">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[#474747]">{formatJst(entry.at)}</span>
            <span>{`返金 ${formatYen(entry.amount)}`}</span>
            {current ? (
              <StatusBadge tone={current.status === 'failed' || current.status === 'error' ? 'danger' : 'neutral'} size="sm">
                {current.label}
              </StatusBadge>
            ) : null}
          </div>
          <p className="text-[#474747]">{entry.sourceLabel}</p>
          <p className="text-[#474747]">
            {entry.steps.map((step) => `${step.label}（${formatJst(step.at)}）`).join(' → ')}
          </p>
          {entry.shippingAmount > 0 ? <p>{`送料 ${formatYen(entry.shippingAmount)}`}</p> : null}
          {entry.items.length > 0 ? <p>{`商品: ${formatItems(entry.items)}`}</p> : null}
          {hasBeforeShipmentItems ? <p>{`在庫に戻した数: ${restockedTotal}`}</p> : null}
          {entry.referenceNumber ? <p>{`照会番号: ${entry.referenceNumber}`}</p> : null}
          {entry.customerActionExpiresAt ? <p>{`口座の入力の期限: ${formatJst(entry.customerActionExpiresAt)}`}</p> : null}
          {entry.failureReasonLabel ? <p>{`失敗の理由: ${entry.failureReasonLabel}`}</p> : null}
          {entry.cancelReasonLabel ? <p>{`取消の理由: ${entry.cancelReasonLabel}`}</p> : null}
          {entry.stripeReasonLabel ? <p>{`Stripe に伝えた理由: ${entry.stripeReasonLabel}`}</p> : null}
          {entry.note ? <p>{`メモ: ${entry.note}`}</p> : null}
          {entry.actorEmail ? <p className="text-[#474747]">操作: {entry.actorEmail}</p> : null}
        </li>
      );
    }
    if (entry.type === 'refund_rereserve') {
      // どの商品が足りないかは、要対応の行（確保し直せなかった商品）と店へのメールに出る。ここは合計だけを約束の文のまま出す
      const shortageTotal = entry.items.reduce((sum, item) => sum + item.shortage, 0);
      return (
        <li key={`refund-rereserve-${entry.refundId}`} className="space-y-1 font-acumin lk-text-3xs text-black">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[#474747]">{formatJst(entry.at)}</span>
            <span>返金の失敗で在庫を確保し直しました</span>
          </div>
          <p>{`商品: ${formatItems(entry.items)}`}</p>
          {shortageTotal > 0 ? <p>{`足りなかった数: ${shortageTotal}`}</p> : null}
        </li>
      );
    }
    if (entry.type === 'return') {
      // 題と細目は窓口が C-5 のとおり組み立て済み。ここは描き方だけを決める
      return (
        <li key={`return-${entry.id}`} className="space-y-1 font-acumin lk-text-3xs text-black">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[#474747]">{formatJst(entry.at)}</span>
            <span>{entry.title}</span>
          </div>
          {entry.details.map((detail, index) => (
            <p key={`${index}-${detail}`}>{detail}</p>
          ))}
          {entry.actorEmail ? <p className="text-[#474747]">操作: {entry.actorEmail}</p> : null}
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
    <section id="order-history" aria-label="変更履歴" aria-labelledby="order-history-heading" tabIndex={-1} data-order-history-panel className="min-w-0 space-y-3 break-words">
      <h2 id="order-history-heading">変更履歴</h2>
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
          {/* G-1 Task 15 / G-3: 発送・発送の取消・伝票番号の訂正・手動の配達済みは発送票で行う。履歴の上に1回だけ伝える（狭い画面でも折り返す） */}
          <p className="font-acumin lk-text-3xs text-[#474747]">{SHIPMENT_SLIP_TEXT.orderHistoryGuide}</p>
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
              <div className="space-y-2">
                <h3>{ADMIN_ORDER_TEXT.itemStatesTitle}</h3>
                {history.itemStatesFailed ? <p role="alert">品物の状態の変化を読み込めませんでした。</p> : (history.itemStates ?? []).length === 0 ? <p>{ADMIN_ORDER_TEXT.itemStatesEmpty}</p> : (
                  <ol className="space-y-2">{history.itemStates?.map((entry) => <li key={entry.id} className="break-words font-acumin lk-text-3xs">
                    <p>{formatJst(entry.at)} {entry.itemName}{entry.quantity}点 {entry.from === null ? '（なし）' : ADMIN_ITEM_STATUS_LABELS[entry.from]} → {entry.to === null ? '（なし）' : ADMIN_ITEM_STATUS_LABELS[entry.to]}（{itemStateReasonLabel(entry.reason)}／{entry.automatic ? '自動' : entry.actorEmail ?? '不明な管理者'}）</p>
                    {entry.ref ? <p><Link className="underline" href={entry.ref.kind === 'shipment_slip' ? `/admin/shipment-slips/${entry.ref.id}` : `/admin/purchase-orders/${entry.ref.id}`}>{entry.ref.kind === 'shipment_slip' ? '発送票' : '発注'} {entry.ref.label}</Link></p> : null}
                    {entry.swap ? <p><Link className="underline" href={`/admin/orders/${entry.swap.counterpartOrderId}`}>相手の注文 {toOrderNumber(entry.swap.counterpartOrderId)}</Link>{entry.swap.note ? ` ${entry.swap.note}` : ''}</p> : null}
                  </li>)}</ol>
                )}
                {history.itemStatesTruncated ? <p>{ADMIN_ORDER_TEXT.itemStatesTruncated}</p> : null}
              </div>
              <ol className="max-h-[60vh] space-y-3 overflow-y-auto">{history.entries.map(renderEntry)}</ol>
            </>
          ) : null}
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
    </section>
  );
}
