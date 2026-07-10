"use client";

import Link from "next/link";
import React from "react";
import { useParams } from "next/navigation";
import { Button } from "@/components/ui/Button/Button";
import { useLogin } from "@/contexts/LoginContext";
import { clientFetch } from "@/lib/client-fetch";
import {
  ORDER_PROGRESS_STEPS,
  resolveOrderProgressIndex,
} from "@/lib/orders/order-status";
import {
  OrderItemRow,
  type OrderLineItem,
} from "@/features/account/components/OrderItemRow";
import { useReorder } from "@/features/account/hooks/useReorder";
import "../../account.css";

// OD-2: Tailwind 既定サイズではなくサイト共通の --lk-size-* トークンを使用
const labelStyle = { fontSize: "var(--lk-size-2xs)" } as const;
const bodyStyle = { fontSize: "var(--lk-size-sm)" } as const;
const lgStyle = { fontSize: "var(--lk-size-lg)" } as const;
const acuminFont = { fontFamily: "acumin-pro, sans-serif" } as const;
const acuminLgStyle = { ...lgStyle, ...acuminFont } as const;

type OrderDetail = {
  id: string;
  orderNumber: string;
  orderDate: string;
  status: string;
  subtotalAmount: string;
  shippingAmount: string;
  discountAmount: string;
  totalAmount: string;
  paymentMethod: string;
  shippingAddress: string;
  items: OrderLineItem[];
};

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

  const progressIndex = order ? resolveOrderProgressIndex(order.status) : -1;

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
      {errorMessage ? (
        <p role="alert" className="text-red-600" style={bodyStyle}>
          {errorMessage}
        </p>
      ) : null}

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

            {/* OD-4: 進捗の視覚化（受注→発送→配達） */}
            {progressIndex >= 0 ? (
              // sm 未満はラベルを丸数字の下に置いて折返しを防ぐ（結線は丸数字の中心高さに合わせる）
              <ol
                className="flex items-start sm:items-center gap-1.5 sm:gap-2 pt-2"
                aria-label="配送ステータス"
              >
                {ORDER_PROGRESS_STEPS.map((step, index) => {
                  const done = index <= progressIndex;
                  return (
                    <React.Fragment key={step}>
                      <li className="flex flex-col items-center gap-1 sm:flex-row sm:gap-2">
                        <span
                          aria-hidden="true"
                          className={`flex h-6 w-6 items-center justify-center rounded-full border text-[10px] ${done ? "border-black bg-black text-white" : "border-black/25 text-[#999]"}`}
                        >
                          {index + 1}
                        </span>
                        <span
                          className={`whitespace-nowrap ${done ? "text-black" : "text-[#999]"}`}
                          style={labelStyle}
                        >
                          {step}
                        </span>
                      </li>
                      {index < ORDER_PROGRESS_STEPS.length - 1 ? (
                        <li
                          aria-hidden="true"
                          className={`h-px flex-1 mt-3 sm:mt-0 ${index < progressIndex ? "bg-black" : "bg-black/15"}`}
                        />
                      ) : null}
                    </React.Fragment>
                  );
                })}
              </ol>
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
            {reorderMessage ? (
              <p role="status" className="text-black account-feedback">
                {reorderMessage}
              </p>
            ) : null}
            {reorderError ? (
              <p role="alert" className="text-red-600 account-feedback">
                {reorderError}
              </p>
            ) : null}
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
