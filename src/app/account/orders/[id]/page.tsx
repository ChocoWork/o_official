"use client";

import Link from "next/link";
import React from "react";
import { useParams } from "next/navigation";
import { Button } from "@/components/ui/Button/Button";
import { useLogin } from "@/contexts/LoginContext";
import { clientFetch } from "@/lib/client-fetch";
import {
  PARTIALLY_SHIPPED_LABEL,
  type OrderProgressKey,
  type OrderProgressStep,
} from "@/lib/orders/order-progress";
import {
  OrderItemRow,
  type OrderLineItem,
} from "@/features/account/components/OrderItemRow";
import { useReorder } from "@/features/account/hooks/useReorder";
import { LiveMessage } from "@/components/ui/LiveMessage/LiveMessage";
import "../../account.css";

// OD-2: Tailwind 既定サイズではなくサイト共通の --lk-size-* トークンを使用
const labelStyle = { fontSize: "var(--lk-size-2xs)" } as const;
const bodyStyle = { fontSize: "var(--lk-size-sm)" } as const;
const lgStyle = { fontSize: "var(--lk-size-lg)" } as const;
const acuminFont = { fontFamily: "acumin-pro, sans-serif" } as const;
const acuminLgStyle = { ...lgStyle, ...acuminFont } as const;

type OrderDetailItem = OrderLineItem & {
  /** 発送した数 */
  shippedQuantity: number;
  /** 発送準備中の数（入金後の注文だけ。窓口が数える） */
  readyQuantity: number;
  /** 受注生産中の数（入金後の注文だけ。窓口が数える） */
  inProductionQuantity: number;
};

type OrderShipment = {
  id: string;
  number: number;
  shippedAt: string;
  carrier: string | null;
  carrierLabel: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  items: Array<{
    orderItemId: string;
    name: string;
    color: string | null;
    size: string | null;
    quantity: number;
  }>;
};

type OrderDetail = {
  id: string;
  orderNumber: string;
  orderDate: string;
  status: string;
  progress: {
    key: OrderProgressKey;
    label: string;
    partiallyShipped: boolean;
    steps: OrderProgressStep[] | null;
  };
  subtotalAmount: string;
  shippingAmount: string;
  discountAmount: string;
  totalAmount: string;
  paymentMethod: string;
  shippingAddress: string;
  items: OrderDetailItem[];
  shipments: OrderShipment[];
};

/** 発送日は日本時間の日付で出す（窓口は時刻のまま返す） */
function formatShippedDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "-";
  }

  return new Intl.DateTimeFormat("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: "Asia/Tokyo",
  }).format(date);
}

/** 「名前（色 / サイズ）」の形。色もサイズも無い古い明細は名前だけ */
function describeItem(
  name: string,
  color: string | null | undefined,
  size: string | null | undefined,
): string {
  const variant = [color, size].filter(Boolean).join(" / ");
  return variant ? `${name}（${variant}）` : name;
}

export default function AccountOrderDetailPage() {
  const params = useParams<{ id: string }>();
  const { isLoggedIn, isAuthResolved } = useLogin();
  const [order, setOrder] = React.useState<OrderDetail | null>(null);
  const [isLoading, setIsLoading] = React.useState(true);
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
  const [reorderMessage, setReorderMessage] = React.useState<string | null>(
    null,
  );
  const [reorderError, setReorderError] = React.useState<string | null>(null);

  const { reorderingItemId, reorder } = useReorder({
    onSuccess: (message) => {
      setReorderError(null);
      setReorderMessage(message);
      setTimeout(() => setReorderMessage(null), 3000);
    },
    onError: (message) => setReorderError(message),
  });

  React.useEffect(() => {
    if (!isAuthResolved || !isLoggedIn || !params.id) {
      setIsLoading(false);
      return;
    }

    const fetchOrderDetail = async () => {
      setIsLoading(true);
      setErrorMessage(null);

      try {
        const response = await clientFetch(`/api/orders/${params.id}`, {
          cache: "no-store",
        });
        if (!response.ok) {
          throw new Error("注文詳細の取得に失敗しました");
        }

        const data = (await response.json()) as OrderDetail;
        setOrder(data);
      } catch (error) {
        console.error("Failed to fetch order detail:", error);
        setErrorMessage("注文詳細を読み込めませんでした");
      } finally {
        setIsLoading(false);
      }
    };

    void fetchOrderDetail();
  }, [isAuthResolved, isLoggedIn, params.id]);

  if (!isAuthResolved) {
    return (
      <div className="max-w-3xl mx-auto text-center">
        <p className="text-[#474747] mb-8" style={lgStyle}>
          読み込み中...
        </p>
      </div>
    );
  }

  if (!isLoggedIn) {
    return (
      <div className="max-w-3xl mx-auto text-center">
        <h1 className="mb-4">注文詳細</h1>
        <p className="text-[#474747] mb-8" style={lgStyle}>
          注文詳細を確認するにはログインが必要です
        </p>
        <Button href="/login" variant="primary" size="lg">
          ログイン
        </Button>
      </div>
    );
  }

  // 数は入金後の注文にだけ窓口が返す（未入金・キャンセルの注文の品は 0）
  const readyItems = order?.items.filter((item) => item.readyQuantity > 0) ?? [];
  const inProductionItems =
    order?.items.filter((item) => item.inProductionQuantity > 0) ?? [];

  return (
    // lg 以上は横幅を活かして 61.8% : 38.2%（黄金比）の2カラムに分割する
    // account-page: account.css の間隔変数（--gap-* / --card-pad）のスコープ
    <div className="account-page w-full mx-auto max-w-4xl lg:max-w-6xl space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Link
          href="/account?tab=orders"
          className="account-order-entry-link account-order-entry-date font-acumin"
        >
          <i className="ri-arrow-left-line" aria-hidden="true" />
          購入履歴へ戻る
        </Link>
      </div>

      {/* OD-7: ローディングはスケルトン、エラーは role="alert" */}
      {isLoading ? (
        <div className="space-y-6" aria-hidden="true">
          <div className="border border-black/10 p-5 sm:p-8 animate-pulse space-y-4">
            <div className="h-4 w-1/3 bg-black/8" />
            <div className="h-4 w-1/2 bg-black/8" />
            <div className="h-10 w-full bg-black/5" />
          </div>
          <div className="border border-black/10 p-5 sm:p-8 animate-pulse space-y-4">
            <div className="h-16 w-full bg-black/5" />
            <div className="h-16 w-full bg-black/5" />
          </div>
        </div>
      ) : null}
      <LiveMessage className="text-red-600" style={bodyStyle}>
        {errorMessage}
      </LiveMessage>

      {order ? (
        <div className="space-y-6 lg:grid lg:grid-cols-[61.8fr_38.2fr] lg:items-start lg:gap-8 lg:space-y-0">
          {/* 注文メタ＋進捗はページの文脈なので全幅ヘッダーとして両カラムに跨がせる */}
          <section className="border border-black/10 p-5 sm:p-8 space-y-6 lg:col-span-2">
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <p
                  className="text-[#474747] mb-1 tracking-wider"
                  style={labelStyle}
                >
                  注文番号
                </p>
                <p className="text-black" style={lgStyle}>
                  {order.orderNumber}
                </p>
              </div>
              <div>
                <p
                  className="text-[#474747] mb-1 tracking-wider"
                  style={labelStyle}
                >
                  注文日時
                </p>
                <p className="text-black" style={bodyStyle}>
                  {order.orderDate}
                </p>
              </div>
            </div>

            {/* 状態の言葉。支払い手続き中・放棄の注文は窓口が返さない（お客様には出さない） */}
            <div
              className="flex flex-wrap items-center gap-2"
              data-testid="order-progress-status"
            >
              <span className="account-status">{order.progress.label}</span>
              {order.progress.partiallyShipped ? (
                <span className="account-status account-status-sm">
                  {PARTIALLY_SHIPPED_LABEL}
                </span>
              ) : null}
            </div>

            {/* OD-4: 進捗の視覚化。段は窓口が記録から決める（在庫の品だけなら4段、受注生産の品を含むなら5段） */}
            {order.progress.steps ? (
              // sm 未満はラベルを丸数字の下に置いて折返しを防ぐ（結線は丸数字の中心高さに合わせる）
              <ol
                className="flex items-start sm:items-center gap-1.5 sm:gap-2 pt-2"
                aria-label="配送ステータス"
              >
                {order.progress.steps.map((step, index, steps) => {
                  // 済んだ段と今の段は塗り、結線は済んだ段の後ろだけ塗る
                  const filled = step.state !== "todo";
                  return (
                    <React.Fragment key={step.key}>
                      <li
                        aria-current={step.state === "current" ? "step" : undefined}
                        className="flex flex-col items-center gap-1 sm:flex-row sm:gap-2"
                      >
                        <span
                          aria-hidden="true"
                          className={`flex h-6 w-6 items-center justify-center rounded-full border lk-text-6xs ${filled ? "border-black bg-black text-white" : "border-black/25 text-[#999]"}`}
                        >
                          {index + 1}
                        </span>
                        <span
                          className={`whitespace-nowrap ${filled ? "text-black" : "text-[#999]"}`}
                          style={labelStyle}
                        >
                          {step.label}
                        </span>
                      </li>
                      {index < steps.length - 1 ? (
                        <li
                          aria-hidden="true"
                          className={`h-px flex-1 mt-3 sm:mt-0 ${step.state === "done" ? "bg-black" : "bg-black/15"}`}
                        />
                      ) : null}
                    </React.Fragment>
                  );
                })}
              </ol>
            ) : null}

            {/* 配送情報は発送ごとに出す。取り消した発送は窓口が返さない */}
            {order.shipments.map((shipment) => (
              <section
                key={shipment.id}
                aria-label={`配送情報（${shipment.number}回目）`}
                className="mt-6"
              >
                <h2 className="mb-2 text-[#474747] tracking-wider">
                  {`配送情報（${shipment.number}回目）`}
                </h2>
                <dl className="space-y-1 lk-text-sm">
                  <div className="flex gap-2">
                    <dt className="text-[#707070]">発送日</dt>
                    <dd className="tabular-nums">
                      {formatShippedDate(shipment.shippedAt)}
                    </dd>
                  </div>
                  {shipment.carrierLabel ? (
                    <div className="flex gap-2">
                      <dt className="text-[#707070]">配送業者</dt>
                      <dd>{shipment.carrierLabel}</dd>
                    </div>
                  ) : null}
                  {shipment.trackingNumber ? (
                    <div className="flex gap-2">
                      <dt className="text-[#707070]">追跡番号</dt>
                      <dd className="tabular-nums">{shipment.trackingNumber}</dd>
                    </div>
                  ) : null}
                </dl>
                {shipment.trackingUrl ? (
                  <a
                    href={shipment.trackingUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-2 inline-block lk-text-sm underline"
                  >
                    配送状況を確認する
                  </a>
                ) : null}
                <ul className="mt-2 space-y-1 lk-text-sm">
                  {shipment.items.map((line) => (
                    <li key={line.orderItemId}>
                      {`${describeItem(line.name, line.color, line.size)} × ${line.quantity}`}
                    </li>
                  ))}
                </ul>
              </section>
            ))}

            {readyItems.length > 0 ? (
              <section aria-label="発送準備中の商品" className="mt-6">
                <h2 className="mb-2 text-[#474747] tracking-wider">
                  発送準備中の商品
                </h2>
                <ul className="space-y-1 lk-text-sm">
                  {readyItems.map((item) => (
                    <li key={item.id}>
                      {`${describeItem(item.name, item.color, item.size)} × ${item.readyQuantity}`}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            {inProductionItems.length > 0 ? (
              <section aria-label="受注生産中の商品" className="mt-6">
                <h2 className="mb-2 text-[#474747] tracking-wider">
                  受注生産中の商品
                </h2>
                <ul className="space-y-1 lk-text-sm">
                  {inProductionItems.map((item) => (
                    <li key={item.id}>
                      {`${describeItem(item.name, item.color, item.size)} × ${item.inProductionQuantity}`}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </section>

          {/* 配送先・支払方法は全幅の横長バンドとしてヘッダー直下に配置 */}
          <div className="grid gap-6 sm:grid-cols-[61.8fr_38.2fr] lg:col-span-2">
            <section className="border border-black/10 p-5 sm:p-8 space-y-4">
              <h2 style={acuminFont}>配送先情報</h2>
              <p className="text-black" style={bodyStyle}>
                {order.shippingAddress || "-"}
              </p>
            </section>

            <section className="border border-black/10 p-5 sm:p-8 space-y-4">
              <h2 style={acuminFont}>支払方法</h2>
              <p className="text-black" style={bodyStyle}>
                {order.paymentMethod}
              </p>
            </section>
          </div>

          <section className="border border-black/10 p-5 sm:p-8 space-y-4">
            <h2 style={acuminFont}>ご注文商品</h2>
            {/* 案内の入れ物は常に置き、中身だけを入れ替える（FREQ-377） */}
            <LiveMessage politeness="status" className="text-black account-feedback">
              {reorderMessage}
            </LiveMessage>
            <LiveMessage className="text-red-600 account-feedback">
              {reorderError}
            </LiveMessage>
            {/* 購入履歴タブと同じ表示（OrderItemRow を共用） */}
            <div className="account-order-items">
              {order.items.map((item) => (
                <OrderItemRow
                  key={item.id}
                  item={item}
                  isReordering={reorderingItemId === item.id}
                  onReorder={reorder}
                />
              ))}
            </div>
          </section>

          {/* 決済サマリー（近接: 支払金額・配送先・支払方法を1グループに集約） */}
          <aside className="space-y-6 lg:sticky lg:top-24">
            <section className="border border-black/10 p-5 sm:p-8 space-y-4">
              <h2 style={acuminFont}>支払金額</h2>
              <dl className="space-y-2">
                <div className="flex items-baseline justify-between">
                  <dt className="text-[#474747]" style={bodyStyle}>
                    小計
                  </dt>
                  <dd className="text-black" style={bodyStyle}>
                    {order.subtotalAmount}
                  </dd>
                </div>
                <div className="flex items-baseline justify-between">
                  <dt className="text-[#474747]" style={bodyStyle}>
                    送料
                  </dt>
                  <dd className="text-black" style={bodyStyle}>
                    {order.shippingAmount}
                  </dd>
                </div>
                <div className="flex items-baseline justify-between">
                  <dt className="text-[#474747]" style={bodyStyle}>
                    クーポン値引き
                  </dt>
                  <dd className="text-black" style={bodyStyle}>
                    {order.discountAmount}
                  </dd>
                </div>
                <div className="flex items-baseline justify-between border-t border-black/10 pt-3">
                  <dt className="text-black" style={bodyStyle}>
                    支払金額
                  </dt>
                  <dd className="text-black font-display" style={acuminLgStyle}>
                    {order.totalAmount}
                  </dd>
                </div>
              </dl>
            </section>

            {/* OD-5: 次アクション（注文サマリー直下 = 注文に対する操作として近接配置） */}
            <Button
              href="/contact"
              variant="secondary"
              size="md"
              className="w-full"
            >
              この注文について問い合わせる
            </Button>
          </aside>
        </div>
      ) : null}
    </div>
  );
}
