"use client";
// File: src/features/account/returns/OrderReturnsSection.tsx

import React from "react";
import { Button } from "@/components/ui/Button/Button";
import { LiveMessage } from "@/components/ui/LiveMessage/LiveMessage";
import {
  CancelRequestForm,
  type CancelableLine,
} from "@/features/account/returns/CancelRequestForm";
import {
  formatMonthDay,
  itemLabel,
  REQUEST_TEXT,
  variantText,
} from "@/features/account/returns/return-request-model";
import { formatYen } from "@/lib/orders/refund/refund-messages";
import { CUSTOMER_RETURN_STATUS_TEXT } from "@/lib/orders/returns/customer-return-messages";
import type {
  CustomerCancelRequest,
  CustomerOrderReturn,
  CustomerOrderReturns,
} from "@/lib/orders/returns/customer-return-types";
import { RETURN_CARRIER_LABELS } from "@/lib/orders/returns/return-messages";
import type { OrderStatusPrivateReturn, PublicCustomerOrderReturn, PublicCustomerOrderReturns } from "@/lib/orders/customer-order-view-types";
import { ORDER_STATUS_TEXT } from "@/lib/orders/status/status-messages";

// 見出しは注文の画面のカードの見出し（h2）と同じ書体にする（見出しの既定の書体は明朝）
const acuminFont = { fontFamily: "acumin-pro, sans-serif" } as const;

const SECTION_HEADING = "返品・交換";
const REQUEST_LABEL = "返品・交換を申し込む";
const CANCEL_OPEN_LABEL = "キャンセルを申し込む";
const CANCEL_RECEIVED =
  "キャンセルのお申し込みを受け付けました。内容を確かめて、メールでご連絡します。";
const SHOP_SAYS = "当店より:";
const HOW_TO_HEADING = "返送のしかた";
const NO_SHIPPING_NEEDED = "品物のご返送は不要です。";
const SEND_TO = "下記の返送先へお送りください。";
const SHIPPING_SHOP_PAYS =
  "返送料は当店が負担いたします。着払いでお送りください。";
const SHIPPING_CUSTOMER_PAYS =
  "恐れ入りますが、返送料はお客様のご負担でお送りください。";
// 返送料が0円の送り状の文。C-5 に無いので、返品の受付のメールと同じ文にそろえる
const SHIPPING_SHOP_LABEL_FREE = "当店がご用意する送り状でお送りください。";
const SENT_BACK_HEADING = "お返しした商品";

const EXCHANGE_SHIPPING_TEXT = {
  pending: "交換の品をお送りします。",
  shipped: "交換の品をお送りしました。",
} as const;

const CANCEL_REQUEST_STATUS_LABELS = {
  requested: "キャンセルのお申し込み中",
  declined: "キャンセルのお申し込みをお受けできませんでした",
  resolved: "キャンセルのお申し込みのお手続きが済みました",
  closed: "キャンセルのお申し込みのお手続きが済みました",
} as const satisfies Record<CustomerCancelRequest["status"], string>;

type ReturnLine = CustomerOrderReturn["lines"][number];

/**
 * 品ごとの解決の一行。まだ承認していない間（申し込み中・お断り）は、お客様の「ご希望」と書く。
 * 承認の後は、お店が決めた解決を書く（ご希望と違っていても、決めた解決を書く）
 */
function resolutionLine(line: ReturnLine, isWish: boolean): string | null {
  if (isWish) {
    if (line.requestedResolution === "refund") {
      return "ご希望: 返金";
    }
    if (line.requestedResolution === "exchange") {
      const variant = line.requestedExchange
        ? variantText(line.requestedExchange.color, line.requestedExchange.size)
        : "";
      return variant ? `ご希望: 交換（${variant}）` : "ご希望: 交換";
    }
    return null;
  }
  if (line.resolution === "refund") {
    return "返金";
  }
  const variant = line.exchange
    ? variantText(line.exchange.color, line.exchange.size)
    : "";
  return variant ? `交換: ${variant}` : "交換";
}

/**
 * 返送料の文。お店の負担を先に見る（返品の受付のメールの返送のしかたと同じ順）。
 * お客様の負担で、お店の送り状（shop_label）の時だけ、返送料を返金から差し引く
 */
function shippingSentence(orderReturn: PublicCustomerOrderReturn): string {
  if (orderReturn.returnShippingPayer === "shop") {
    return SHIPPING_SHOP_PAYS;
  }
  if (orderReturn.returnMethod === "shop_label") {
    return orderReturn.returnShippingFee > 0
      ? `当店がご用意する送り状でお送りください。返送料 ${formatYen(orderReturn.returnShippingFee)} をご返金額から差し引きます。`
      : SHIPPING_SHOP_LABEL_FREE;
  }
  return SHIPPING_CUSTOMER_PAYS;
}

/** お店が書いた文は、書かれたとおりの字として出す（改行を残し、HTML として読まない） */
function ShopMessage({
  message,
  testId,
}: {
  message: string;
  testId?: string;
}) {
  return (
    <div className="space-y-1 lk-text-sm" data-testid={testId}>
      <p className="text-[#474747]">{SHOP_SAYS}</p>
      <p className="whitespace-pre-wrap break-words text-black">{message}</p>
    </div>
  );
}

function SmallHeading({ children }: { children: React.ReactNode }) {
  return (
    <h4
      style={acuminFont}
      className="tracking-wider text-[#474747] lk-text-2xs"
    >
      {children}
    </h4>
  );
}

/** 返送のしかた。返送が要るのに返送先を読めない時は、見出しだけの空の欄を出さない */
function HowToReturn({ orderReturn, address }: { orderReturn: PublicCustomerOrderReturn; address: CustomerOrderReturn["returnAddress"] }) {
  if (orderReturn.returnMethod === "not_required") {
    return (
      <div className="space-y-2 lk-text-sm" data-testid="order-return-how-to">
        <SmallHeading>{HOW_TO_HEADING}</SmallHeading>
        <p>{NO_SHIPPING_NEEDED}</p>
      </div>
    );
  }
  if (!address) {
    return null;
  }
  return (
    <div className="space-y-2 lk-text-sm" data-testid="order-return-how-to">
      <SmallHeading>{HOW_TO_HEADING}</SmallHeading>
      <p>{SEND_TO}</p>
      <p data-testid="order-return-shipping" className="break-words">
        {shippingSentence(orderReturn)}
      </p>
      <address
        className="space-y-0.5 break-words not-italic"
        data-testid="order-return-address"
      >
        <p className="text-[#474747]">返送先:</p>
        <p>{address.name}</p>
        <p>{`〒${address.postalCode} ${address.address}`}</p>
        <p>{address.phone}</p>
      </address>
    </div>
  );
}

function SentBackTracking({ trackingNumber, carrier }: { trackingNumber: string | null; carrier?: CustomerOrderReturn["sentBack"][number]["carrier"] }): React.JSX.Element | null {
  if (!trackingNumber) return null;
  return <p className="break-words">{ORDER_STATUS_TEXT.private.sentBackTracking(`${carrier ? `${RETURN_CARRIER_LABELS[carrier]} ` : ""}${trackingNumber}`)}</p>;
}

function SentBack({ items, readOnly }: { items: PublicCustomerOrderReturn["sentBack"] | CustomerOrderReturn["sentBack"]; readOnly?: boolean }) {
  return (
    <div className="space-y-2 lk-text-sm" data-testid="order-return-sent-back">
      <SmallHeading>{SENT_BACK_HEADING}</SmallHeading>
      <ul className="space-y-3">
        {items.map((item, index) => (
          <li key={index} className="space-y-1">
            <p className="break-words">
              {`${itemLabel(item.itemName, item.color, item.size)} × ${item.quantity}`}
            </p>
            {item.message ? <ShopMessage message={item.message} /> : null}
            {!readOnly && "trackingNumber" in item ? <SentBackTracking trackingNumber={item.trackingNumber} carrier={item.carrier} /> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ReturnCard({ orderReturn, readOnly }: { orderReturn: CustomerOrderReturn | PublicCustomerOrderReturn; readOnly?: boolean }) {
  const status = orderReturn.customerStatus;
  const text = CUSTOMER_RETURN_STATUS_TEXT[status];
  const number = `返品番号 ${orderReturn.label}`;
  // まだ承認していない間（申し込み中・お断り）は、品ごとの解決を「ご希望」と書く
  const isWish = status === "requested" || status === "declined";
  // 返送のしかたは、これから送る間だけ。お受け取りの後（確かめ中・お支払い待ち・返金の準備中）は送った後なので出さない
  const showHowTo = status === "accepted" || status === "partially_received";
  const exchangeShipping =
    status === "returned" ? orderReturn.exchangeShipping : "none";

  return (
    <section
      aria-label={number}
      data-testid="order-return"
      className="space-y-3 py-4 first:pt-0 last:pb-0"
    >
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <h3
          style={acuminFont}
          className="min-w-0 break-words text-[#474747] lk-text-sm"
        >
          {number}
        </h3>
        <span className="account-status" data-testid="order-return-status">
          {text.label}
        </span>
      </div>
      {text.note ? (
        <p className="text-[#474747] lk-text-sm" data-testid="order-return-note">
          {text.note}
        </p>
      ) : null}

      <ul className="space-y-2 lk-text-sm" data-testid="order-return-lines">
        {orderReturn.lines.map((line, index) => {
          const resolution = resolutionLine(line, isWish);
          return (
            <li key={index} className="space-y-0.5">
              <p className="break-words">
                {`${itemLabel(line.itemName, line.color, line.size)} × ${line.quantity}`}
              </p>
              {resolution ? (
                <p className="text-[#474747]">{resolution}</p>
              ) : null}
            </li>
          );
        })}
      </ul>

      {orderReturn.refundAmount !== null ? (
        <p className="lk-text-sm" data-testid="order-return-refund">
          {`ご返金 ${formatYen(orderReturn.refundAmount)}`}
        </p>
      ) : null}

      {showHowTo && !readOnly && "returnAddress" in orderReturn ? <HowToReturn orderReturn={orderReturn} address={orderReturn.returnAddress} /> : null}
      {/* 公開の記録では、返送不要の固定文だけを出す（住所は読まない）。返送が要る時の案内は確かめた後の欄に任せる */}
      {showHowTo && readOnly && orderReturn.returnMethod === "not_required" ? <HowToReturn orderReturn={orderReturn} address={null} /> : null}
      {orderReturn.sentBack.length > 0 ? (
        <SentBack items={orderReturn.sentBack} readOnly={readOnly} />
      ) : null}
      {status === "declined" && orderReturn.declineMessage ? (
        <ShopMessage
          message={orderReturn.declineMessage}
          testId="order-return-decline"
        />
      ) : null}
      {exchangeShipping !== "none" ? (
        <p className="lk-text-sm" data-testid="order-return-exchange-shipping">
          {EXCHANGE_SHIPPING_TEXT[exchangeShipping]}
        </p>
      ) : null}
    </section>
  );
}

function CancelRequestCard({ request }: { request: CustomerCancelRequest }) {
  return (
    <div
      data-testid="order-cancel-request"
      className="space-y-3 py-4 first:pt-0 last:pb-0"
    >
      <span className="account-status" data-testid="order-cancel-request-status">
        {CANCEL_REQUEST_STATUS_LABELS[request.status]}
      </span>
      <ul className="space-y-1 lk-text-sm">
        {request.lines.map((line, index) => (
          <li key={index} className="break-words">
            {`${itemLabel(line.itemName, line.color, line.size)} × ${line.quantity}`}
          </li>
        ))}
      </ul>
      {request.status === "declined" && request.declineMessage ? (
        <ShopMessage
          message={request.declineMessage}
          testId="order-cancel-request-decline"
        />
      ) : null}
    </div>
  );
}

export type OrderReturnsSectionProps = {
  readOnly?: false;
  orderId: string;
  /** 注文の窓口の答えの returnSection（計画の冒頭 C-2 の CustomerOrderReturns） */
  section: CustomerOrderReturns;
  /** キャンセルのお申し込みで選べる品（未発送の数が1以上の品）。注文の画面が注文の品から決める */
  cancelLines: CancelableLine[];
  /** キャンセルのお申し込みが受け付けられた時と、結果が分からないまま閉じた時。注文の画面が答えを読み直す */
  onChanged: () => void;
} | { orderId: string; section: PublicCustomerOrderReturns; readOnly: true; cancelLines?: never; onChanged?: never };

/** 公開の記録は操作用の値やダミーの個人情報を受け取らない。 */
export function OrderReturnsSection(props: OrderReturnsSectionProps): React.JSX.Element | null {
  if (!props.readOnly) return <InteractiveOrderReturnsSection {...props} />;
  const { returns, cancelRequests } = props.section;
  if (returns.length === 0 && cancelRequests.length === 0) return null;
  return (
    <section aria-label={SECTION_HEADING} data-testid="order-returns-section" className="border border-black/10 p-5 sm:p-8 space-y-4 min-w-0 break-words">
      <h2 style={acuminFont}>{SECTION_HEADING}</h2>
      {returns.map((orderReturn) => <ReturnCard key={orderReturn.id} orderReturn={orderReturn} readOnly />)}
      {cancelRequests.map((request) => <CancelRequestCard key={request.id} request={request} />)}
    </section>
  );
}

/** 返送先と番号だけを、公開の返品とID・配列位置で結び付ける。 */
export function OrderReturnPrivateDetails({ orderReturn, details }: { orderReturn: PublicCustomerOrderReturn; details: OrderStatusPrivateReturn }): React.JSX.Element | null {
  if (orderReturn.id !== details.id) return null;
  const showHowTo = orderReturn.customerStatus === "accepted" || orderReturn.customerStatus === "partially_received";
  // 返送不要の文は公開の記録が出すので、ここでは返送が要る時の返送先だけを出す（文を2回出さない）
  const showAddress = showHowTo && orderReturn.returnMethod !== "not_required" && details.returnAddress !== null;
  const tracked = details.sentBack.filter((item) => Number.isInteger(item.index) && item.index >= 0 && orderReturn.sentBack[item.index] && item.trackingNumber);
  if (!showAddress && tracked.length === 0) return null;
  return (
    <section className="space-y-3 min-w-0 break-words">
      <h3 style={acuminFont}>{`返品番号 ${orderReturn.label}`}</h3>
      {showAddress ? <HowToReturn orderReturn={orderReturn} address={details.returnAddress} /> : null}
      {tracked.map((item) => <SentBackTracking key={item.index} trackingNumber={item.trackingNumber} />)}
    </section>
  );
}

/**
 * お客様の注文の画面の「返品・交換」の欄（グループ E-3 段2。計画の冒頭 C-5・仕様書 8-2）。
 * 返品ごとの状態の言葉と添える文、申し込みのボタンか受付の終わりの文、キャンセルの申し込みの状態と入口を出す。
 * 出す物が何も無い時は、空のカードを出さずに null を返す。
 */
function InteractiveOrderReturnsSection({
  orderId,
  section,
  cancelLines,
  onChanged,
}: Extract<OrderReturnsSectionProps, { readOnly?: false }>) {
  const headingRef = React.useRef<HTMLHeadingElement>(null);
  const formWasOpenRef = React.useRef(false);
  const [cancelOpen, setCancelOpen] = React.useState(false);
  const [cancelNotice, setCancelNotice] = React.useState<string | null>(null);

  // 申し込みの画面を閉じた後は、押したボタンが消えている（受け付けた時）ことがあるので、欄の見出しへフォーカスを移す
  React.useEffect(() => {
    if (formWasOpenRef.current && !cancelOpen) {
      headingRef.current?.focus();
    }
    formWasOpenRef.current = cancelOpen;
  }, [cancelOpen]);

  const { returns, cancelRequests, availability } = section;
  const canRequest = availability.returns === "available";
  const endedDate =
    availability.returns === "ended" && availability.endedOn
      ? formatMonthDay(availability.endedOn)
      : null;
  // 選べる品が無い時は、受付が開いていてもボタンを出さない（空のフォームを開かせない）
  const cancelAvailable = availability.cancel && cancelLines.length > 0;
  // 受け付けた後は、注文の答えを読み直すまでの間も、もう一度のボタンを出さない
  const showCancelButton =
    cancelAvailable && !cancelOpen && cancelNotice === null;

  if (
    returns.length === 0 &&
    cancelRequests.length === 0 &&
    !canRequest &&
    endedDate === null &&
    !cancelAvailable &&
    !cancelOpen &&
    cancelNotice === null
  ) {
    return null;
  }

  const openCancel = () => {
    setCancelNotice(null);
    setCancelOpen(true);
  };
  const handleSubmitted = () => {
    setCancelOpen(false);
    setCancelNotice(CANCEL_RECEIVED);
    onChanged();
  };
  const handleClose = ({ uncertain }: { uncertain: boolean }) => {
    setCancelOpen(false);
    // 結果が分からないまま閉じた時は、受け付けられていたかもしれないので、注文の答えを読み直してもらう
    if (uncertain) {
      onChanged();
    }
  };

  return (
    <section
      aria-label={SECTION_HEADING}
      data-testid="order-returns-section"
      className="border border-black/10 p-5 sm:p-8 space-y-4"
    >
      <h2
        ref={headingRef}
        tabIndex={-1}
        style={acuminFont}
        className="outline-none"
      >
        {SECTION_HEADING}
      </h2>

      {/* 案内の入れ物は常に置き、中身だけを入れ替える（FREQ-377）。空の間は余白からも外れるので、見出しの直後に置く */}
      <LiveMessage
        politeness="status"
        className="text-black lk-text-sm"
        data-testid="order-cancel-notice"
      >
        {cancelNotice}
      </LiveMessage>

      {returns.length > 0 || cancelRequests.length > 0 ? (
        <div className="divide-y divide-black/10">
          {returns.map((orderReturn) => (
            <ReturnCard key={orderReturn.id} orderReturn={orderReturn} />
          ))}
          {cancelRequests.map((request) => (
            <CancelRequestCard key={request.id} request={request} />
          ))}
        </div>
      ) : null}

      {endedDate ? (
        <p className="text-[#474747] lk-text-sm" data-testid="order-returns-ended">
          {REQUEST_TEXT.ended(endedDate)}
        </p>
      ) : null}

      {cancelOpen ? (
        <CancelRequestForm
          orderId={orderId}
          lines={cancelLines}
          onSubmitted={handleSubmitted}
          onClose={handleClose}
        />
      ) : null}

      {canRequest || showCancelButton ? (
        <div className="flex flex-col gap-3">
          {canRequest ? (
            <Button
              href={`/account/orders/${orderId}/return`}
              variant="primary"
              size="md"
              className="w-full"
              data-testid="order-returns-request"
            >
              {REQUEST_LABEL}
            </Button>
          ) : null}
          {showCancelButton ? (
            <Button
              type="button"
              variant="secondary"
              size="md"
              className="w-full"
              data-testid="order-cancel-open"
              onClick={openCancel}
            >
              {CANCEL_OPEN_LABEL}
            </Button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
