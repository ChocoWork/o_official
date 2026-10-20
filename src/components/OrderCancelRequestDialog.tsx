'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/Button/Button';
import { Dialog } from '@/components/ui/Dialog/Dialog';
import { SingleSelect } from '@/components/ui/SingleSelect/SingleSelect';
import { StatusBadge } from '@/components/ui/StatusBadge/StatusBadge';
import { TextAreaField } from '@/components/ui/TextAreaField/TextAreaField';
import { lineLabel } from '@/lib/orders/fulfillment/fulfillment-client';
import { toOrderNumber } from '@/lib/orders/order-number';
import type { OrderStatus } from '@/lib/orders/order-payment-types';
import { callReturnApi, fetchReturnData } from '@/lib/orders/returns/return-client';
import {
  RETURN_DECLINE_REASON_LABELS,
  RETURN_ERROR_MESSAGES,
  prefillDeclineMessage,
} from '@/lib/orders/returns/return-messages';
import {
  RETURN_DECLINE_REASONS,
  type AdminCancelRequest,
  type ReturnDeclineReason,
} from '@/lib/orders/returns/return-types';

/**
 * 「品を外す」で親に渡す物（C-2）。mode が親の開く画面を決める: 未入金は今の取消の画面（unpaid_cancel）、
 * 支払い済みで発送が0で未発送の全部を外すなら支払い済みのキャンセルの画面（paid_cancel）、ほかは返金の画面の発送前の商品に
 * 申し込みの品と数を入れて開く（refund）。lines は申し込みの品と数
 */
export type RemoveItemsRequest = {
  cancelRequestId: string;
  mode: 'unpaid_cancel' | 'paid_cancel' | 'refund';
  lines: Array<{ orderItemId: string; quantity: number }>;
};

export type OrderCancelRequestDialogProps = {
  orderId: string;
  /** 偽の間は何も描かず、窓口も読まない。真になるたびに中身を読み直す */
  open: boolean;
  onClose: () => void;
  /** お断り・解決済みにした。親が画面を閉じ、知らせ（notice）を出して一覧を読み直す */
  onChanged: (notice: string) => void;
  /** 「品を外す」。親が返金・キャンセルの画面を開き、成功したら解決の窓口を呼ぶ */
  onRemoveItems: (request: RemoveItemsRequest) => void;
  /**
   * 店長か（管理画面が `userRole === 'admin'` で渡す。一覧の「返金」と同じ条件）。C-2 の任意の props。
   * 支払い済みの注文の「品を外す」は返金を伴う（窓口は admin.orders.refund）ので店長だけ。未入金の注文の取消は、サポートの人もできる。省くと偽
   */
  canRefund?: boolean;
};

type OrderCancelRequestDialogBodyProps = Omit<OrderCancelRequestDialogProps, 'open'>;

/** `GET /api/admin/orders/[id]/cancel-requests` の答え（`{ data }` の中身。C-3） */
type CancelRequestsData = {
  cancelRequests: AdminCancelRequest[];
  orderStatus: OrderStatus;
  /** 発送した数の合計。1つも発送していない（0）支払い済みの注文だけ、支払い済みのキャンセルの画面になりうる */
  shippedUnits: number;
  /** 未発送の数の合計。支払い済みのキャンセルの画面にするかを、窓口を足さずに決める */
  unshippedUnits: number;
};

/** 開いている画面。お断り・解決済みにするは、操作する申し込みの番号を持つ（ブラウザの Screen 型と重ならない名前にした） */
type OpenScreen = { kind: 'list' } | { kind: 'decline'; requestId: string } | { kind: 'close'; requestId: string };

// C-5 に無い文: 読み込めない時（返品の画面の同じ場面の文に合わせた）、結果が分からない時（履歴の画面の取消の文に合わせた）
const LOAD_FAILURE_MESSAGE = 'キャンセルの申し込みを読み込めませんでした。';
const UNKNOWN_OUTCOME_MESSAGE = '結果を確かめられませんでした。申し込みの状態を読み直しました。';
// 窓口が日本語の断りを返さない時の代わりの文。管理画面の隣の操作（src/app/admin/page.tsx の要対応・要確認の操作）と同じ文
const OPERATION_FAILURE_MESSAGE = '操作に失敗しました。一覧を更新してください。';
// 後の知らせ（C-5）
const DECLINED_NOTICE = 'お断りしました。';
const CLOSED_NOTICE = '解決済みにしました。';

// お断りの画面の言葉は返品のお断りと同じ（C-5）。理由の名前と、理由を選んだ時に入る最初の文の規則は Task 4 の部品を使い、ここには持たない
const DECLINE_MESSAGE_MAX_LENGTH = 1000;
const DECLINE_REASON_OPTIONS = RETURN_DECLINE_REASONS.map((value) => ({ value, label: RETURN_DECLINE_REASON_LABELS[value] }));

function isDeclineReason(value: string): value is ReturnDeclineReason {
  return (RETURN_DECLINE_REASONS as readonly string[]).includes(value);
}

function formatJst(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

/** 過去の申し込みの状態の言葉（C-5）。開いている申し込みは null（操作のボタンを出す） */
function pastStatusLabel(request: AdminCancelRequest): string | null {
  switch (request.status) {
    case 'resolved':
      return request.resolvedRefundId ? '解決（返金）' : '解決（キャンセル）';
    case 'declined':
      return 'お断り';
    case 'closed':
      return '解決済み';
    default:
      return null;
  }
}

/**
 * 「品を外す」の行き先（C-2・P11）。未入金は取消の画面。支払い済みで、発送が0で、注文の未発送の全部が申し込みに入っている時だけ
 * 支払い済みのキャンセルの画面（注文の全体をキャンセルして残りを全額返金する画面なので、申し込んでいない品が残っているなら使えない）。
 * ほかは返金の画面。窓口の答え（shippedUnits・unshippedUnits）と申し込みの行（今の未発送の数つき）だけで決め、ほかの窓口は読まない
 */
export function decideRemoveMode(input: {
  orderStatus: OrderStatus;
  shippedUnits: number;
  unshippedUnits: number;
  requestLines: ReadonlyArray<{ quantity: number; unshipped: number }>;
}): RemoveItemsRequest['mode'] {
  if (input.orderStatus === 'pending') return 'unpaid_cancel';
  if (input.orderStatus !== 'paid' || input.shippedUnits !== 0) return 'refund';
  // 申し込みのどの行も今の未発送の全部で、行の数の合計が注文の未発送の合計と同じ＝申し込んでいない未発送の品が無い
  const total = input.requestLines.reduce((sum, line) => sum + line.quantity, 0);
  const coversAll =
    input.requestLines.length > 0 &&
    input.requestLines.every((line) => line.quantity === line.unshipped) &&
    total === input.unshippedUnits;
  return coversAll ? 'paid_cancel' : 'refund';
}

type CancelRequestCardProps = {
  request: AdminCancelRequest;
  busy: boolean;
  /** 「品を外す」を押せるか（未入金の取消か、店長） */
  canRemove: boolean;
  onRemove: () => void;
  onDecline: () => void;
  onCloseRequest: () => void;
};

function CancelRequestCard({ request, busy, canRemove, onRemove, onDecline, onCloseRequest }: CancelRequestCardProps) {
  const pastLabel = pastStatusLabel(request);
  return (
    <li data-testid="cancel-request-item" data-request-id={request.id} data-status={request.status}>
      <div className="space-y-2 border border-[#d4d4d4] p-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-acumin lk-text-sm text-black">{`申し込み: ${formatJst(request.requestedAt)}`}</span>
          {pastLabel ? (
            <StatusBadge tone="neutral" size="sm">
              {pastLabel}
            </StatusBadge>
          ) : null}
        </div>
        <ul className="space-y-1">
          {request.lines.map((line) => (
            <li key={line.orderItemId} className="font-acumin lk-text-sm text-black">
              {`${lineLabel({ name: line.itemName, color: line.color, size: line.size })} × ${line.quantity}（未発送 ${line.unshipped}）`}
            </li>
          ))}
        </ul>
        {request.customerNote ? (
          <p className="whitespace-pre-wrap break-words font-acumin lk-text-3xs text-[#474747]">{`ご連絡事項: ${request.customerNote}`}</p>
        ) : null}
        {request.status === 'requested' ? (
          <div className="space-y-2">
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" size="sm" className="font-acumin" disabled={busy || !canRemove} onClick={onRemove}>
                {busy ? '処理中...' : '品を外す（返金・キャンセルの画面を開く）'}
              </Button>
              <Button variant="secondary" size="sm" className="font-acumin" disabled={busy} onClick={onDecline}>
                お断りする
              </Button>
              <Button variant="secondary" size="sm" className="font-acumin" disabled={busy} onClick={onCloseRequest}>
                解決済みにする
              </Button>
            </div>
            {!canRemove ? (
              <p className="font-acumin lk-text-3xs text-[#474747]">{RETURN_ERROR_MESSAGES.RETURN_FORBIDDEN.message}</p>
            ) : null}
          </div>
        ) : null}
      </div>
    </li>
  );
}

/**
 * キャンセルの申し込みの画面（グループ E-3 段2 設計書 5-4。Shopify の「お客様の申し込み」の扱いに合わせる）。
 * 一覧の「キャンセルの申し込み」のボタンから開く。開く時に、この注文の申し込みと注文の状態・発送した数・未発送の数を読み、
 * 開いている申し込みには「品を外す」「お断りする」「解決済みにする」を、過去の申し込みには状態の言葉だけを出す。
 * 画面は同時に1つだけ出す（Dialog は重ねると Esc で下の画面が閉じる）: 一覧 → お断り／解決済みにするの確かめ。
 * 「品を外す」は、返金・キャンセルの画面を親が開く。親が、その画面で返金・キャンセルが受け付けられた後に、解決の窓口を呼ぶ。
 * 開くたびに作り直す（open が偽の間は外し、key に注文を使う）。
 */
export default function OrderCancelRequestDialog({
  orderId,
  open,
  onClose,
  onChanged,
  onRemoveItems,
  canRefund = false,
}: OrderCancelRequestDialogProps) {
  return open ? (
    <OrderCancelRequestDialogBody
      key={orderId}
      orderId={orderId}
      canRefund={canRefund}
      onClose={onClose}
      onChanged={onChanged}
      onRemoveItems={onRemoveItems}
    />
  ) : null;
}

function OrderCancelRequestDialogBody({
  orderId,
  canRefund = false,
  onClose,
  onChanged,
  onRemoveItems,
}: OrderCancelRequestDialogBodyProps) {
  const [data, setData] = useState<CancelRequestsData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // 読み直しの回数。増やすと下の effect が読み直す（読み込みの競合は effect の active で捨てる）
  const [reloadCount, setReloadCount] = useState(0);
  const [screen, setScreen] = useState<OpenScreen>({ kind: 'list' });
  // 窓口を呼んでいる間（お断り・解決済みにするを送る間）。画面は閉じず、ボタンを押せなくする
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState<ReturnDeclineReason | ''>('');
  const [message, setMessage] = useState('');
  // お断り・解決済みにするを送っている間に画面が外れた時に、その後で親の処理（onChanged）を呼ばないため
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    void fetchReturnData<CancelRequestsData>(`/api/admin/orders/${orderId}/cancel-requests`, LOAD_FAILURE_MESSAGE).then((result) => {
      if (!active) return;
      if (result.kind === 'error') {
        // 読み直しが失敗したら古い中身とボタンを残さない。読めない時のボタンは「閉じる」だけ
        setData(null);
        setLoadError(result.message);
        return;
      }
      setLoadError(null);
      setData(result.data);
    });
    return () => {
      active = false;
    };
  }, [orderId, reloadCount]);

  const requests = data && Array.isArray(data.cancelRequests) ? data.cancelRequests : [];
  const openRequests = requests.filter((request) => request.status === 'requested');
  const pastRequests = requests.filter((request) => request.status !== 'requested');
  // 未入金の取消はサポートの人もできる。返金・支払い済みのキャンセルは店長だけ（T12-3）
  const canRemove = data?.orderStatus === 'pending' || canRefund;
  const orderNumber = toOrderNumber(orderId);
  // 窓口を呼んでいる間は閉じない
  const guardedClose = () => {
    if (!busy) onClose();
  };

  const reloadList = () => {
    setScreen({ kind: 'list' });
    setReloadCount((count) => count + 1);
  };

  const handleRemove = (request: AdminCancelRequest) => {
    if (!data || busy) return;
    onRemoveItems({
      cancelRequestId: request.id,
      mode: decideRemoveMode({
        orderStatus: data.orderStatus,
        shippedUnits: data.shippedUnits,
        unshippedUnits: data.unshippedUnits,
        requestLines: request.lines,
      }),
      lines: request.lines.map((line) => ({ orderItemId: line.orderItemId, quantity: line.quantity })),
    });
  };

  const openDecline = (requestId: string) => {
    setError(null);
    setReason('');
    setMessage('');
    setScreen({ kind: 'decline', requestId });
  };

  const openClose = (requestId: string) => {
    setError(null);
    setScreen({ kind: 'close', requestId });
  };

  const backToList = () => {
    if (busy) return;
    setError(null);
    setScreen({ kind: 'list' });
  };

  const changeReason = (value: string) => {
    if (!isDeclineReason(value)) {
      // 「選んでください」に戻した時は、書いた文を残す（理由が無いので送れない）
      setReason('');
      return;
    }
    // 欄が空白だけか前の理由の最初の文のままなら新しい理由の最初の文に、直した文は残す（P8。返品のお断りと同じ部品）
    setMessage((current) => prefillDeclineMessage(current, reason === '' ? null : reason, value));
    setReason(value);
  };

  /** お断り・解決済みにするを送る。窓口の答えは callReturnApi の4つに分ける（T12-4） */
  const runOperation = async (url: string, body: object, doneNotice: string) => {
    setBusy(true);
    setError(null);
    const result = await callReturnApi(url, body, OPERATION_FAILURE_MESSAGE);
    if (!mounted.current) return;
    setBusy(false);
    if (result.kind === 'ok') {
      reloadList();
      onChanged(doneNotice);
      return;
    }
    if (result.kind === 'blocked') {
      // 処理に入っていない。今の画面に留まり、押し直せる
      setError(result.message);
      return;
    }
    if (result.kind === 'refused') {
      setError(result.message);
      // 状態が変わった・申し込みが無い時は、今の中身を読み直して一覧の画面へ戻る。入力の誤りは今の画面に留まる
      if (result.code === 'CANCEL_REQUEST_STATE_CONFLICT' || result.code === 'CANCEL_REQUEST_NOT_FOUND') {
        reloadList();
      }
      return;
    }
    // 通信が切れた・500番台・読めない答え: 記録されたか分からないので、読み直して今の状態を見せる
    setError(UNKNOWN_OUTCOME_MESSAGE);
    reloadList();
  };

  if (screen.kind === 'decline') {
    const requestId = screen.requestId;
    const trimmed = message.trim();
    const canDecline = reason !== '' && trimmed.length >= 1 && trimmed.length <= DECLINE_MESSAGE_MAX_LENGTH && !busy;
    const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (reason === '' || !canDecline) return;
      void runOperation(
        `/api/admin/cancel-requests/${requestId}/decline`,
        { declineReason: reason, declineMessage: trimmed },
        DECLINED_NOTICE,
      );
    };
    return (
      <Dialog key="decline" open onClose={guardedClose} title={`お断りする（${orderNumber}）`} fullScreenOnMobile>
        <form className="space-y-3" onSubmit={handleSubmit}>
          <SingleSelect
            label="お断りの理由（お客様には見えません）"
            required
            placeholder="選んでください"
            options={DECLINE_REASON_OPTIONS}
            value={reason}
            disabled={busy}
            onChange={(event) => changeReason(event.target.value)}
          />
          <TextAreaField
            label="お客様へのメッセージ（必須・お客様に届きます）"
            value={message}
            rows={5}
            maxLength={DECLINE_MESSAGE_MAX_LENGTH}
            disabled={busy}
            onChange={(event) => setMessage(event.target.value)}
          />
          <p className="font-acumin lk-text-3xs text-[#474747]">お客様にメッセージが届きます。取り消せません。</p>
          {error ? (
            <p role="alert" className="font-acumin lk-text-3xs text-red-700">
              {error}
            </p>
          ) : null}
          <div className="flex gap-2 pt-1">
            <Button variant="secondary" size="sm" className="w-full font-acumin" disabled={busy} onClick={backToList}>
              戻る
            </Button>
            <Button type="submit" variant="primary" size="sm" className="w-full font-acumin" disabled={!canDecline}>
              {busy ? '処理中...' : 'お断りする'}
            </Button>
          </div>
        </form>
      </Dialog>
    );
  }

  if (screen.kind === 'close') {
    const requestId = screen.requestId;
    return (
      <Dialog key="close" open onClose={guardedClose} title={`解決済みにする（${orderNumber}）`} fullScreenOnMobile>
        <div className="space-y-3">
          <p className="font-acumin lk-text-sm text-black">注文を変えず、メールも送らずに閉じます。</p>
          {error ? (
            <p role="alert" className="font-acumin lk-text-3xs text-red-700">
              {error}
            </p>
          ) : null}
          <div className="flex gap-2 pt-1">
            <Button variant="secondary" size="sm" className="w-full font-acumin" disabled={busy} onClick={backToList}>
              戻る
            </Button>
            <Button
              variant="primary"
              size="sm"
              className="w-full font-acumin"
              disabled={busy}
              onClick={() => void runOperation(`/api/admin/cancel-requests/${requestId}/close`, {}, CLOSED_NOTICE)}
            >
              {busy ? '処理中...' : '解決済みにする'}
            </Button>
          </div>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog key="list" open onClose={guardedClose} title={`キャンセルの申し込み（${orderNumber}）`} fullScreenOnMobile>
      <div className="space-y-3">
        {!data && !loadError ? <p className="font-acumin lk-text-3xs text-[#474747]">読み込み中です...</p> : null}
        {error ? (
          <p role="alert" className="font-acumin lk-text-3xs text-red-700">
            {error}
          </p>
        ) : null}
        {data && requests.length === 0 ? (
          <p className="font-acumin lk-text-sm text-black">{RETURN_ERROR_MESSAGES.CANCEL_REQUEST_NOT_FOUND.message}</p>
        ) : null}
        {requests.length > 0 ? (
          // 幅が 768px 以上の Dialog は高さを制限しないので、申し込みの一覧だけを縦に動かし、下のボタンは動かさない
          <div className="space-y-3 md:max-h-[60vh] md:overflow-y-auto md:pr-1">
            <ul className="space-y-3">
              {[...openRequests, ...pastRequests].map((request) => (
                <CancelRequestCard
                  key={request.id}
                  request={request}
                  busy={busy}
                  canRemove={canRemove}
                  onRemove={() => handleRemove(request)}
                  onDecline={() => openDecline(request.id)}
                  onCloseRequest={() => openClose(request.id)}
                />
              ))}
            </ul>
          </div>
        ) : null}
        {loadError ? (
          <p role="alert" className="font-acumin lk-text-3xs text-red-700">
            {loadError}
          </p>
        ) : null}
        <div className="flex gap-2 pt-1">
          <Button variant="secondary" size="sm" className="w-full font-acumin" disabled={busy} onClick={onClose}>
            閉じる
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
