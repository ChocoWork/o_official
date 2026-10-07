"use client";

import React, { useId, useMemo, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { loadStripe, type Appearance } from "@stripe/stripe-js";
import { CheckoutProvider, PaymentElement, useCheckout } from "@stripe/react-stripe-js/checkout";
import { Button } from "@/components/ui/Button/Button";
import { LiveMessage } from "@/components/ui/LiveMessage/LiveMessage";
import { mapPaymentMethodLabel } from "@/features/checkout/services/payment-method.service";
import { formatPostalCodeInput } from "@/features/checkout/utils/postal-code.util";
import { FINAL_FULFILLMENT_LABELS, FULFILLMENT_HEADINGS } from "@/features/checkout/utils/fulfillment-labels";
import type {
  CheckoutConfirmation,
  CheckoutConfirmationLine,
} from "@/features/checkout/services/checkout-confirmation.service";
import { placeOrder, type CheckoutRejection } from "@/app/checkout/_lib/checkout-api";
import { clearPaymentAttempt, rememberPaymentAttempt } from "@/app/checkout/_lib/payment-attempt";

const stripePromise = loadStripe(process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? "");

// Stripe Payment Element appearance (ブランドトークンに合わせたカスタマイズ)
const stripeAppearance: Appearance = {
  theme: "stripe",
  variables: {
    colorBackground: "#ffffff",
    colorText: "#000000",
    colorPrimary: "#000000",
    colorTextSecondary: "#474747",
    colorDanger: "#dc2626",
    fontFamily: "acumin-pro, sans-serif",
    fontSizeBase: "13px",
    fontWeightNormal: "400",
    fontWeightMedium: "600",
    borderRadius: "0.375rem",
    spacingUnit: "3px",
  },
  rules: {
    ".Input": {
      border: "1px solid rgba(0,0,0,0.2)",
      borderRadius: "0.375rem",
      backgroundColor: "#ffffff",
      color: "#000000",
      fontFamily: "acumin-pro, sans-serif",
      padding: "0.5rem 0.75rem",
    },
    ".Input:focus": {
      borderColor: "#000000",
      boxShadow: "0 0 0 3px rgba(0,0,0,0.15)",
    },
    ".Input::placeholder": {
      color: "rgba(0,0,0,0.4)",
    },
    ".Label": {
      color: "#474747",
      fontWeight: "600",
      fontSize: "0.6875rem",
      letterSpacing: "0.05em",
    },
    ".Button": {
      backgroundColor: "#000000",
      color: "#ffffff",
      borderRadius: "0.375rem",
      fontFamily: "acumin-pro, sans-serif",
      fontWeight: "600",
      padding: "0.5rem 0.75rem",
    },
    ".Button:hover": {
      backgroundColor: "#474747",
    },
    ".Error": {
      color: "#dc2626",
      fontWeight: "600",
    },
    ".Tab": {
      borderRadius: "0.375rem",
      border: "1px solid rgba(0,0,0,0.2)",
      backgroundColor: "#ffffff",
      color: "#000000",
      padding: "0.5rem 0.75rem",
    },
    ".Tab--selected": {
      backgroundColor: "#000000",
      color: "#ffffff",
    },
    ".Checkbox": {
      borderColor: "rgba(0,0,0,0.2)",
      borderRadius: "0.375rem",
      backgroundColor: "#ffffff",
    },
    ".Checkbox:checked": {
      backgroundColor: "#000000",
      borderColor: "#000000",
    },
  },
};

/** 支払いの時期・方法（グループ F 設計書 第4章） */
const PAYMENT_TIMING = [
  { method: "stripe_card", text: "ご注文時にお支払いが確定します" },
  { method: "stripe_paypay", text: "ご注文時に PayPay の画面でお支払いが確定します" },
  {
    method: "stripe_konbini",
    text: "ご注文から7日以内に、発行される払込番号でお支払いください。期限までにお支払いが確認できないときは、ご注文をキャンセルします",
  },
] as const;

const PLACE_ORDER_FAILED_MESSAGE = "ご注文を受け付けられませんでした。少し時間をおいてから、もう一度お試しください。";
const PAYMENT_FAILED_MESSAGE = "お支払いを完了できませんでした。もう一度お試しください。";

export type FinalConfirmationStepProps = {
  confirmation: CheckoutConfirmation;
  /** 画面の上に出す案内（PayPay を取りやめて戻った・決済の画面を作り直した・別の画面で進んでいる） */
  notice: string | null;
  /** 支払いの後の完了の処理の間。もう一度押させない */
  completing: boolean;
  /** 「変更」「戻る」。入力画面へ戻る。この画面で入れたお支払い情報は消える */
  onEdit(): void;
  /** 支払いが済んだ（またはもう済んでいた）。親が完了の処理をする */
  onPaid(checkoutSessionId: string): void;
  /** 受け付けで断られた。親が理由ごとにカート・入力画面・作り直しへ移す（設計書 6-3） */
  onRejected(rejection: CheckoutRejection): void;
};

function variantLabel(line: Pick<CheckoutConfirmationLine, "color" | "size">): string {
  return [line.color, line.size].filter(Boolean).join(" / ");
}

function lineLabel(line: CheckoutConfirmationLine): string {
  const variant = variantLabel(line);
  return `${line.name}${variant ? `（${variant}）` : ""}× ${line.quantity}`;
}

/**
 * 最終確認画面「注文内容の最終確認」（グループ F 設計書 2-3・2-4・第4章）。
 * 決済の画面ごとに Stripe の入れ物を作り直す（key）。入力画面には Stripe の部品を置かない。
 */
export function FinalConfirmationStep(props: FinalConfirmationStepProps) {
  const { clientSecret, checkoutSessionId } = props.confirmation;
  const options = useMemo(
    () => ({
      clientSecret: decodeURIComponent(clientSecret),
      elementsOptions: { appearance: stripeAppearance },
    }),
    [clientSecret],
  );

  return (
    <CheckoutProvider key={checkoutSessionId} stripe={stripePromise} options={options}>
      <FinalConfirmationContent {...props} />
    </CheckoutProvider>
  );
}

function FinalOrderItems({ lines }: { lines: CheckoutConfirmationLine[] }) {
  return (
    <div className="checkout-items">
      {lines.map((line) => (
        <div className="checkout-item" key={`${line.itemId}|${line.color ?? ""}|${line.size ?? ""}`}>
          <div className="w-20 h-24 shrink-0 overflow-hidden relative">
            {line.imageUrl ? (
              <Image alt={line.name} className="image" src={line.imageUrl} width={400} height={500} />
            ) : null}
          </div>
          <div className="checkout-item-lines">
            <p className="checkout-value">{line.name}</p>
            <div>
              {variantLabel(line) ? <p className="checkout-label">{variantLabel(line)}</p> : null}
              <p className="checkout-label">数量: {line.quantity}</p>
            </div>
            <p className="checkout-value">¥{line.price.toLocaleString()}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

// Stripe の決済の画面の金額をそのまま出す（設計書第4章。小計・割引・送料・合計（税込））
function FinalOrderTotals() {
  const checkout = useCheckout();
  if (checkout.type !== "success") {
    return null;
  }
  const total = checkout.checkout.total;

  return (
    <div className="checkout-rows" style={{ paddingTop: "var(--card-pad)", borderTop: "1px solid rgb(0 0 0 / 0.1)" }}>
      <div className="checkout-row">
        <span className="checkout-row-muted">小計</span>
        <span>{total.subtotal.amount}</span>
      </div>
      {total.discount.minorUnitsAmount > 0 && (
        <div className="checkout-row">
          <span className="checkout-row-muted">割引</span>
          <span>-{total.discount.amount}</span>
        </div>
      )}
      <div className="checkout-row">
        <span className="checkout-row-muted">配送料</span>
        <span>{total.shippingRate.minorUnitsAmount === 0 ? "無料" : total.shippingRate.amount}</span>
      </div>
      <div className="checkout-total-row">
        <span className="checkout-total-label">合計（税込）</span>
        <span className="checkout-total">{total.total.amount}</span>
      </div>
    </div>
  );
}

function FinalConfirmationContent({
  confirmation,
  notice,
  completing,
  onEdit,
  onPaid,
  onRejected,
}: FinalConfirmationStepProps) {
  const checkout = useCheckout();
  const termsHeadingId = useId();
  const [selectedPaymentType, setSelectedPaymentType] = useState<string | null>(null);
  const [placing, setPlacing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isReady = checkout.type === "success";
  // 受け付け・支払いの最中と、支払いの後の完了の処理の間は、どのボタンも押させない
  const busy = placing || completing;
  const { shipping, lines } = confirmation;
  // 最終確認画面で「在庫あり」と見せた明細だけを送る（設計書 6-1）
  const inStockVariantIds = useMemo(
    () => lines.flatMap((line) => (line.fulfillment === "stock" && line.variantId !== null ? [line.variantId] : [])),
    [lines],
  );

  const handlePlaceOrder = async () => {
    if (checkout.type !== "success" || busy) return;
    setPlacing(true);
    setError(null);
    try {
      const outcome = await placeOrder({ checkoutSessionId: confirmation.checkoutSessionId, inStockVariantIds });
      if (outcome.kind === "payment_done") {
        onPaid(confirmation.checkoutSessionId);
        return;
      }
      if (outcome.kind === "rejected") {
        onRejected(outcome.rejection);
        return;
      }
      if (outcome.kind === "error") {
        setError(outcome.message);
        return;
      }

      // PayPay などは Stripe の画面へ移る。戻ったときに「支払った直後」と分かるよう残す（決め事 D10）
      rememberPaymentAttempt({ checkoutSessionId: confirmation.checkoutSessionId, paymentType: selectedPaymentType });
      const result = await checkout.checkout.confirm({
        redirect: "if_required",
        returnUrl: `${window.location.origin}/checkout?session_id={CHECKOUT_SESSION_ID}`,
      });
      clearPaymentAttempt();
      if (result.type === "error") {
        // 受け付け済みの注文と確保した在庫はそのまま。直して同じ画面でもう一度押せる（設計書第7章）
        setError(result.error.message ?? PAYMENT_FAILED_MESSAGE);
        return;
      }
      onPaid(confirmation.checkoutSessionId);
    } catch {
      clearPaymentAttempt();
      setError(PLACE_ORDER_FAILED_MESSAGE);
    } finally {
      setPlacing(false);
    }
  };

  return (
    <div className="checkout-grid grid grid-cols-1 md:grid-cols-1 lg:grid-cols-3">
      <div className="order-2 lg:order-1 md:col-span-1 lg:col-span-2 checkout-sections">
        <h2 className="checkout-heading font-brand" style={{ fontSize: "var(--lk-size-xl)" }}>
          注文内容の最終確認
        </h2>
        <LiveMessage data-testid="checkout-final-notice" className="text-red-600" style={{ fontSize: "var(--lk-size-sm)" }}>
          {notice}
        </LiveMessage>

        <section className="checkout-section">
          <div className="flex items-center justify-between">
            <h3 className="checkout-heading font-brand">お客様情報</h3>
            <Button type="button" variant="text" size="xs" onClick={onEdit} disabled={busy}>
              変更
            </Button>
          </div>
          <div className="checkout-card">
            {shipping.fullName && <p>{shipping.fullName}</p>}
            {shipping.kanaName && <p>{shipping.kanaName}</p>}
            {shipping.email && <p className="break-all">{shipping.email}</p>}
            {shipping.phone && <p>{shipping.phone}</p>}
          </div>
        </section>

        <section className="checkout-section">
          <div className="flex items-center justify-between">
            <h3 className="checkout-heading font-brand">配送先</h3>
            <Button type="button" variant="text" size="xs" onClick={onEdit} disabled={busy}>
              変更
            </Button>
          </div>
          <div className="checkout-card">
            {shipping.postalCode && <p>〒{formatPostalCodeInput(shipping.postalCode)}</p>}
            <p>
              {shipping.prefecture}
              {shipping.city}
              {shipping.address}
            </p>
            {shipping.building && <p>{shipping.building}</p>}
          </div>
        </section>

        {confirmation.promotionCode ? (
          <section className="checkout-section">
            <h3 className="checkout-heading font-brand">プロモーションコード</h3>
            <div className="checkout-card">
              <p>{confirmation.promotionCode}</p>
            </div>
          </section>
        ) : null}

        {/* 特定商取引法 12条の6 の最終確認画面の項目（設計書第4章）。申込みの期間は定めが無いので出さない */}
        <section className="checkout-section" aria-labelledby={termsHeadingId}>
          <h3 id={termsHeadingId} className="checkout-heading font-brand">
            お支払い・お届け・返品について
          </h3>
          <div className="checkout-card" data-testid="checkout-terms" style={{ gap: "var(--gap-group)" }}>
            <div className="checkout-field">
              <p className="checkout-label">お支払いの時期・方法</p>
              <ul>
                {PAYMENT_TIMING.map((timing) => (
                  <li key={timing.method}>
                    {mapPaymentMethodLabel(timing.method)}：{timing.text}
                  </li>
                ))}
              </ul>
            </div>
            <div className="checkout-field">
              <p className="checkout-label">お届けの時期</p>
              <ul>
                {lines.map((line) => (
                  <li key={`${line.itemId}|${line.color ?? ""}|${line.size ?? ""}`}>
                    {lineLabel(line)}：{FULFILLMENT_HEADINGS[line.fulfillment]}・{FINAL_FULFILLMENT_LABELS[line.fulfillment]}
                  </li>
                ))}
              </ul>
            </div>
            <div className="checkout-field">
              <p className="checkout-label">返品・キャンセル</p>
              <p>
                ご注文後のお客様都合による返品・交換・キャンセルはお受けできません。初期不良・誤送は、商品到着後7日以内にご連絡ください。詳しくは
                <Link href="/legal" className="underline">
                  特定商取引法の表記
                </Link>
                をご覧ください
              </p>
            </div>
          </div>
        </section>

        <section className="checkout-section">
          <h3 className="checkout-heading font-brand">お支払い方法</h3>
          <div className="checkout-box">
            <PaymentElement
              options={{
                layout: { type: "accordion", defaultCollapsed: false, radios: "always", spacedAccordionItems: false },
              }}
              onChange={(event) => setSelectedPaymentType(event.value?.type ?? null)}
            />
          </div>
        </section>

        <LiveMessage data-testid="checkout-place-order-error" className="text-red-600" style={{ fontSize: "var(--lk-size-sm)" }}>
          {error}
        </LiveMessage>

        <div className="checkout-actions">
          <Button type="button" variant="secondary" size="lg" onClick={onEdit} disabled={busy}>
            戻る
          </Button>
          <Button type="button" size="lg" className="flex-1" onClick={handlePlaceOrder} disabled={!isReady || busy}>
            {busy ? "注文を確定しています..." : isReady ? "注文する" : "決済フォームを準備中..."}
          </Button>
        </div>
      </div>

      <div className="order-1 lg:order-2 md:col-span-1 lg:col-span-1">
        <div className="checkout-summary md:sticky md:top-32">
          <h2 className="checkout-summary-title">ORDER SUMMARY</h2>
          <FinalOrderItems lines={lines} />
          <FinalOrderTotals />
        </div>
      </div>
    </div>
  );
}
