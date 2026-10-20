'use client';

import { useEffect, useRef, useState } from 'react';
import {
  OrderReturnCancelDialog,
  OrderReturnFeePaymentDialog,
  OrderReturnInspectDialog,
  OrderReturnReleaseExchangeDialog,
  OrderReturnReopenDialog,
} from '@/components/OrderReturnActionDialogs';
import OrderReturnCreateForm, { type CreateReturnResponse } from '@/components/OrderReturnCreateForm';
import OrderReturnReceiveDialog from '@/components/OrderReturnReceiveDialog';
import OrderReturnRefundDialog from '@/components/OrderReturnRefundDialog';
import OrderReturnReviewDialog from '@/components/OrderReturnReviewDialog';
import { requestedWishText } from '@/components/ReturnDialogParts';
import { Button } from '@/components/ui/Button/Button';
import { Dialog } from '@/components/ui/Dialog/Dialog';
import { StatusBadge, type StatusBadgeTone } from '@/components/ui/StatusBadge/StatusBadge';
import { TagLabel } from '@/components/ui/TagLabel/TagLabel';
import { lineLabel } from '@/lib/orders/fulfillment/fulfillment-client';
import { toOrderNumber } from '@/lib/orders/order-number';
import { REFUND_STATUS_LABELS, formatYen } from '@/lib/orders/refund/refund-messages';
import { fetchReturnData } from '@/lib/orders/returns/return-client';
import { RETURN_DISPLAY_STATUS_LABELS, RETURN_MARK_LABELS, RETURN_REASON_LABELS } from '@/lib/orders/returns/return-messages';
import type {
  OrderReturnDetail,
  OrderReturnLineDetail,
  ReturnDisplayStatus,
  ReturnMethod,
} from '@/lib/orders/returns/return-types';

/** `GET /api/admin/orders/[id]/returns` の答え（`{ data }` の中身。C-3） */
export type OrderReturnsData = {
  returns: OrderReturnDetail[];
  /** 額を決めて返金する・手数料の受け取りの記録・支払いを待たずに送る、ができる人（権限 admin.orders.refund も持つ人）か */
  canRefund: boolean;
  /** 注文の商品ごとの返品できる数の合計 */
  returnableUnits: number;
  refundableAmount: number;
  refundableShipping: number;
  /** ショップの設定の「要検品を使う」。この画面は使わない（受け取りの画面が自分で読む） */
  inspectionEnabled: boolean;
};

type OrderReturnsDialogProps = {
  /** 返品を扱う注文 */
  orderId: string;
  /**
   * 店長か（管理画面が `userRole === 'admin'` で渡す。一覧の「返金」のボタンと同じ条件）。額を決めて返金する・手数料の受け取りの記録・
   * 支払いを待たずに送る、のボタンは、これが真で、窓口の答えの canRefund（権限 admin.orders.refund）も真の時だけ出す
   */
  canRefund: boolean;
  /** 偽の間は何も描かず、窓口も読まない。真になるたびに中身を読み直す */
  open: boolean;
  /** 閉じる。親が画面を外して一覧を読み直す（答えが分からないまま閉じた時など、変えたかどうかを知らせない場合のため） */
  onClose: () => void;
  /** 返品が変わったかもしれない（作った・受け取った・取り消したなど。答えが分からないまま閉じた時も）。親が一覧と要対応を読み直す */
  onChanged: () => void;
};

type OrderReturnsDialogBodyProps = Omit<OrderReturnsDialogProps, 'open'>;

/** 返品の欄から開く、返品ごとの操作の画面（Task 9 の部品と、段2の申し込みを確かめる画面） */
type SubDialogKind = 'review' | 'receive' | 'refund' | 'inspect' | 'cancel' | 'reopen' | 'fee_payment' | 'release_exchange';

/** 開いている画面。「返品を作る」か、返品ごとの操作。何も開いていない間だけ、この返品の欄を出す */
type OpenScreen = { kind: 'create' } | { kind: SubDialogKind; returnId: string };

const LOAD_FAILURE_MESSAGE = '返品の情報を読み込めませんでした。';
const EMPTY_MESSAGE = 'この注文にはまだ返品がありません。';
const CREATED_NOTICE = '返品を作りました。';
const APPROVED_NOTICE = '承認しました。';

const DISPLAY_STATUS_TONES: Record<ReturnDisplayStatus, StatusBadgeTone> = {
  requested: 'warning',
  in_progress: 'neutral',
  refund_waiting: 'warning',
  returned: 'positive',
};

/** 「白 / M」。色もサイズも無ければ空 */
function variantText(color: string | null, size: string | null): string {
  return [color, size].filter((part): part is string => Boolean(part)).join(' / ');
}

/** 返品の行の解決の方法の文。「返金」「交換: 白 / L（在庫から）」「交換: 白 / L（作って送る）」 */
function resolutionText(line: OrderReturnLineDetail): string {
  if (line.resolution === 'refund') return '返金';
  // 交換なのに色・サイズの記録が無い（ありえない）時も、返金とは書かない
  if (line.exchange === null) return '交換';
  const target = variantText(line.exchange.color, line.exchange.size) || line.itemName;
  return `交換: ${target}（${line.exchange.method === 'stock' ? '在庫から' : '作って送る'}）`;
}

/**
 * 処理の数の文。受け取り済み（戻した＋戻さなかった）・届かない・お返し・検品待ちは、重ならない分け方にする
 * （お返しも検品待ちも「受け取り済み」に入れると、足し算が合わなくなる）。0点の物は出さない。
 * 交換にした数（exchanged）と返金しないことにした数（refundWaived）は、受け取り済みなどの中の数なので、足さず、別の言葉も出さない。
 */
function progressTexts(progress: OrderReturnLineDetail['progress']): string[] {
  const received = progress.restocked + progress.notRestocked;
  return [
    received > 0 ? `受け取り済み ${received}点` : null,
    progress.missing > 0 ? `届かない ${progress.missing}点` : null,
    progress.sentBack > 0 ? `お返し ${progress.sentBack}点` : null,
    progress.pendingInspection > 0 ? `検品待ち ${progress.pendingInspection}点` : null,
  ].filter((text): text is string => text !== null);
}

type ReturnActions = {
  review: boolean;
  receive: boolean;
  inspect: boolean;
  refund: boolean;
  recordFee: boolean;
  releaseExchange: boolean;
  cancel: boolean;
  reopen: boolean;
};

/**
 * 返品の状態に合うボタン（設計書 8-1）。DB が最後に確かめるので、ここは「出すか」だけを決める。
 * 額を決めて返金・手数料の記録・支払いを待たずに送るは、権限 admin.orders.refund を持つ人（canRefund）にだけ出す。
 * 申し込み中（requested）の返品は「申し込みを確かめる」だけを出す（承認かお断りが済むまで、受け取り・返金・取消の対象ではない）。
 */
function returnActionsOf(detail: OrderReturnDetail, canRefund: boolean): ReturnActions {
  if (detail.status === 'requested') {
    return {
      review: true,
      receive: false,
      inspect: false,
      refund: false,
      recordFee: false,
      releaseExchange: false,
      cancel: false,
      reopen: false,
    };
  }
  const sum = (pick: (line: OrderReturnLineDetail) => number) => detail.lines.reduce((total, line) => total + pick(line), 0);
  const isOpen = detail.status === 'open';
  const awaitingFee = detail.fees.feeDueAmount > 0 && detail.fees.feeReceivedAt === null;
  return {
    review: false,
    receive: isOpen && sum((line) => line.progress.unprocessed) > 0,
    inspect: isOpen && sum((line) => line.progress.pendingInspection) > 0,
    // 完了した返品でも出す: 返品の返金が後で失敗すると、覆いが外れて返金待ちの品が戻り、返品の状態は返金待ちになる（P21）。
    // ふつうの返金の画面では返金待ちの品を選べないので、返し直しはここから行う
    refund: canRefund && sum((line) => line.progress.refundWaiting) > 0,
    recordFee: canRefund && awaitingFee,
    // 送れるようにする交換の品が無い返品（返金から手数料を引けなかっただけ）には出さない
    releaseExchange: canRefund && awaitingFee && detail.fees.exchangeReleasedAt === null && detail.exchangeItems.length > 0,
    // 取消は、何も受け取る前だけ（処理した数が0。DB の admin_cancel_return と同じ。受け取りの記録は見ないので、
    // 「届かない」で終えて開き直した返品も、何も受け取っていなければ取り消せる）
    cancel: isOpen && sum((line) => line.progress.processed) === 0,
    reopen: detail.status === 'closed' && sum((line) => line.progress.missing) > 0,
  };
}

function ReturnLineRow({ line, requested }: { line: OrderReturnLineDetail; requested: boolean }) {
  const label = lineLabel({ name: line.itemName, color: line.color, size: line.size });
  const reason = RETURN_REASON_LABELS[line.reason];
  const progress = progressTexts(line.progress);
  // 申し込みの間の解決は仮の値なので、お客様のご希望を出す（承認の時にお店が決める）。写真の数も、申し込みの間だけ出す
  const wish = requested ? requestedWishText(line) : null;
  const photoCount = requested ? line.photos.length : 0;
  return (
    <li className="space-y-1">
      <p className="font-acumin lk-text-sm text-black">{`${label} × ${line.quantity}`}</p>
      <p className="font-acumin lk-text-3xs text-[#474747]">{`理由: ${reason}${line.reasonNote ? `（${line.reasonNote}）` : ''}`}</p>
      <p className="font-acumin lk-text-3xs text-[#474747]">{wish ?? resolutionText(line)}</p>
      {photoCount > 0 ? <p className="font-acumin lk-text-3xs text-[#474747]">{`写真 ${photoCount}枚`}</p> : null}
      {progress.length > 0 ? (
        <p className="flex flex-wrap gap-x-3 font-acumin lk-text-3xs text-[#474747]">
          {progress.map((text) => (
            <span key={text}>{text}</span>
          ))}
        </p>
      ) : null}
    </li>
  );
}

type ReturnCardProps = {
  detail: OrderReturnDetail;
  canRefund: boolean;
  onOpen: (kind: SubDialogKind) => void;
};

function ReturnCard({ detail, canRefund, onOpen }: ReturnCardProps) {
  const actions = returnActionsOf(detail, canRefund);
  const awaitingFee = detail.fees.feeDueAmount > 0 && detail.fees.feeReceivedAt === null;
  const requested = detail.status === 'requested';
  const buttons: Array<{ show: boolean; kind: SubDialogKind; label: string }> = [
    { show: actions.review, kind: 'review', label: '申し込みを確かめる' },
    { show: actions.receive, kind: 'receive', label: '受け取る' },
    { show: actions.inspect, kind: 'inspect', label: '検品を終える' },
    { show: actions.refund, kind: 'refund', label: '額を決めて返金する' },
    { show: actions.recordFee, kind: 'fee_payment', label: '手数料の受け取りを記録する' },
    { show: actions.releaseExchange, kind: 'release_exchange', label: '支払いを待たずに送る' },
    { show: actions.cancel, kind: 'cancel', label: '返品を取り消す' },
    { show: actions.reopen, kind: 'reopen', label: '開き直す' },
  ];
  return (
    <li>
      <div role="group" aria-label={detail.label} className="space-y-2 border border-[#d4d4d4] p-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-acumin lk-text-sm text-black">{detail.label}</span>
          {detail.displayStatus ? (
            <StatusBadge tone={DISPLAY_STATUS_TONES[detail.displayStatus]} accent size="md" className="whitespace-nowrap">
              {RETURN_DISPLAY_STATUS_LABELS[detail.displayStatus]}
            </StatusBadge>
          ) : null}
          {detail.marks.map((mark) => (
            <TagLabel key={mark} variant="outline" size="2xs">
              {RETURN_MARK_LABELS[mark]}
            </TagLabel>
          ))}
        </div>
        <ul className="space-y-2">
          {detail.lines.map((line) => (
            <ReturnLineRow key={line.id} line={line} requested={requested} />
          ))}
        </ul>
        {awaitingFee ? (
          <p className="font-acumin lk-text-3xs text-black">{`お支払い待ち ${formatYen(detail.fees.feeDueAmount)}`}</p>
        ) : null}
        {detail.refunds.map((refund) => (
          <p key={refund.id} className="font-acumin lk-text-3xs text-black">
            {`返金 ${formatYen(refund.amount)}（${REFUND_STATUS_LABELS[refund.status]}）`}
          </p>
        ))}
        <div className="flex flex-wrap gap-2">
          {buttons
            .filter((button) => button.show)
            .map((button) => (
              <Button key={button.kind} variant="secondary" size="sm" className="font-acumin" onClick={() => onOpen(button.kind)}>
                {button.label}
              </Button>
            ))}
        </div>
      </div>
    </li>
  );
}

type ReturnSubDialogProps = {
  kind: SubDialogKind;
  orderId: string;
  returnId: string;
  onClose: () => void;
  onDone: (notice?: string) => void;
  onUncertain: () => void;
  /** 申し込みを承認した（review の画面だけが呼ぶ）。返送不要で承認したかを渡す */
  onApproved: (input: { notRequired: boolean }) => void;
};

/** 返品ごとの操作の画面を1つ開く。どれも注文と返品の番号だけを受け、自分で中身を読む（Task 9） */
function ReturnSubDialog({ kind, onApproved, ...props }: ReturnSubDialogProps) {
  switch (kind) {
    case 'review':
      return <OrderReturnReviewDialog {...props} onApproved={onApproved} />;
    case 'receive':
      return <OrderReturnReceiveDialog {...props} />;
    case 'refund':
      return <OrderReturnRefundDialog {...props} />;
    case 'inspect':
      return <OrderReturnInspectDialog {...props} />;
    case 'cancel':
      return <OrderReturnCancelDialog {...props} />;
    case 'reopen':
      return <OrderReturnReopenDialog {...props} />;
    case 'fee_payment':
      return <OrderReturnFeePaymentDialog {...props} />;
    case 'release_exchange':
      return <OrderReturnReleaseExchangeDialog {...props} />;
  }
}

/**
 * 注文ごとの返品の画面（グループ E-3 設計書 8-1）。一覧の「返品」のボタンから開く。
 * 開く時に返品の中身を読み、返品ごとに番号・状態・品・理由・解決・処理の数・返金・手数料と、状態に合うボタンを出す。
 * 申し込み中の返品は「申し込みを確かめる」を出し、一覧の同じ名前のボタンから開いた時（最初の読み込みで申し込み中の返品がある時）は、
 * 返品の欄を経ずにその返品の確かめる画面を開く。承認・お断りの後は、知らせを出して読み直す。
 * 下の「返品を作る」で返品を作る画面を開く。受け取り・額を決めて返金・検品・取消などは、それぞれの画面を開く。
 * 画面は同時に1つだけ開く（Dialog は重ねると Esc で下の画面が閉じる）ので、操作の画面を開いている間はこの欄を出さない。
 * 操作の画面が閉じたら、中身を読み直す。開くたびに作り直す（open が偽の間は外し、key に注文を使う）。
 */
export default function OrderReturnsDialog({ orderId, canRefund, open, onClose, onChanged }: OrderReturnsDialogProps) {
  return open ? (
    <OrderReturnsDialogBody key={orderId} orderId={orderId} canRefund={canRefund} onClose={onClose} onChanged={onChanged} />
  ) : null;
}

function OrderReturnsDialogBody({ orderId, canRefund, onClose, onChanged }: OrderReturnsDialogBodyProps) {
  const [data, setData] = useState<OrderReturnsData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // 読み直しの回数。増やすと下の effect が読み直す（読み込みの競合は effect の active で捨てる）
  const [reloadCount, setReloadCount] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [screen, setScreen] = useState<OpenScreen | null>(null);
  // 最初の読み込みの時だけ、申し込み中の返品の確かめる画面を開く。読み直しのたびには開かない（閉じた画面が勝手に戻らないように）
  const autoReviewDoneRef = useRef(false);

  useEffect(() => {
    let active = true;
    void fetchReturnData<OrderReturnsData>(`/api/admin/orders/${orderId}/returns`, LOAD_FAILURE_MESSAGE).then((result) => {
      if (!active) return;
      if (result.kind === 'error') {
        // 読み直しが失敗したら古い中身とボタンを残さない。読めない時のボタンは「閉じる」だけ
        setData(null);
        setLoadError(result.message);
        return;
      }
      setLoadError(null);
      setData(result.data);
      if (!autoReviewDoneRef.current) {
        autoReviewDoneRef.current = true;
        const target = result.data.returns.find((detail) => detail.status === 'requested');
        if (target) setScreen({ kind: 'review', returnId: target.id });
      }
    });
    return () => {
      active = false;
    };
  }, [orderId, reloadCount]);

  const openScreen = (next: OpenScreen) => {
    setNotice(null);
    setScreen(next);
  };

  // 操作の画面が閉じた時は、何もしなかった時も読み直す（別の人が変えたかもしれず、読み直しは軽い）
  const closeScreen = () => {
    setScreen(null);
    setReloadCount((count) => count + 1);
  };

  const handleDone = (message?: string) => {
    setScreen(null);
    setNotice(message ?? null);
    setReloadCount((count) => count + 1);
    onChanged();
  };

  // 答えが分からないまま閉じた。返金や記録が行われたかもしれないので、一覧の読み直しを親に頼む（画面を閉じる onClose は別に来る）
  const handleUncertain = () => {
    onChanged();
  };

  const handleCreated = (result: CreateReturnResponse, returnMethod: ReturnMethod) => {
    setNotice(CREATED_NOTICE);
    setReloadCount((count) => count + 1);
    onChanged();
    // 返送不要の返品は、作ってすぐ受け取りの画面を開く（設計書 5-3）
    setScreen(returnMethod === 'not_required' ? { kind: 'receive', returnId: result.returnId } : null);
  };

  // 申し込みを承認した。返送不要の返品は、承認してすぐ受け取りの画面を開く（P8）。そうでなければ返品の欄に戻る
  const handleApproved = ({ notRequired }: { notRequired: boolean }) => {
    setNotice(APPROVED_NOTICE);
    setReloadCount((count) => count + 1);
    onChanged();
    setScreen((current) => (notRequired && current?.kind === 'review' ? { kind: 'receive', returnId: current.returnId } : null));
  };

  // 取消・お断りの返品は出さない（品はまた返品できる。取り消した事実は履歴の画面に残る）
  const visibleReturns = (data?.returns ?? []).filter((detail) => detail.status !== 'cancelled' && detail.status !== 'declined');

  return (
    <>
      {screen === null ? (
        <Dialog open onClose={onClose} title={`返品（${toOrderNumber(orderId)}）`} fullScreenOnMobile>
          <div className="space-y-3">
            {!data && !loadError ? <p className="font-acumin lk-text-3xs text-[#474747]">読み込み中です...</p> : null}
            {notice ? (
              <p role="status" className="font-acumin lk-text-sm text-black">
                {notice}
              </p>
            ) : null}

            {data ? (
              // 幅が 768px 以上の Dialog は高さを制限しないので、返品の一覧だけを縦に動かし、下の行とボタンは動かさない
              <div className="space-y-3 md:max-h-[60vh] md:overflow-y-auto md:pr-1">
                {visibleReturns.length === 0 ? (
                  <p className="font-acumin lk-text-sm text-black">{EMPTY_MESSAGE}</p>
                ) : (
                  <ul className="space-y-3">
                    {visibleReturns.map((detail) => (
                      <ReturnCard
                        key={detail.id}
                        detail={detail}
                        canRefund={canRefund && data.canRefund}
                        onOpen={(kind) => openScreen({ kind, returnId: detail.id })}
                      />
                    ))}
                  </ul>
                )}
              </div>
            ) : null}
            {data ? <p className="font-acumin lk-text-sm text-black">{`返品できる品: あと${data.returnableUnits}点`}</p> : null}

            {loadError ? (
              <p role="alert" className="font-acumin lk-text-3xs text-red-700">
                {loadError}
              </p>
            ) : null}

            <div className="flex gap-2 pt-1">
              <Button variant="secondary" size="sm" className="w-full font-acumin" onClick={onClose}>
                閉じる
              </Button>
              {data ? (
                <Button
                  variant="primary"
                  size="sm"
                  className="w-full font-acumin"
                  disabled={data.returnableUnits < 1}
                  onClick={() => openScreen({ kind: 'create' })}
                >
                  返品を作る
                </Button>
              ) : null}
            </div>
          </div>
        </Dialog>
      ) : null}

      {screen?.kind === 'create' ? (
        <OrderReturnCreateForm orderId={orderId} onClose={closeScreen} onCreated={handleCreated} onUncertain={handleUncertain} />
      ) : null}
      {screen && screen.kind !== 'create' ? (
        <ReturnSubDialog
          kind={screen.kind}
          orderId={orderId}
          returnId={screen.returnId}
          onClose={closeScreen}
          onDone={handleDone}
          onUncertain={handleUncertain}
          onApproved={handleApproved}
        />
      ) : null}
    </>
  );
}
