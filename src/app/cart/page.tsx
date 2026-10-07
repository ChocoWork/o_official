"use client";

import React from "react";
import Link from "next/link";
import { EmptyPage } from "@/components/ui/EmptyPage/EmptyPage";
import { Button } from "@/components/ui/Button/Button";
import { ToastSnackbar } from "@/components/ui/ToastSnackbar/ToastSnackbar";
import { LiveMessage } from "@/components/ui/LiveMessage/LiveMessage";
import { useCartItems } from "./_hooks/useCartItems";
import { CartItemRow } from "./_components/CartItemRow";
import { OrderSummary } from "./_components/OrderSummary";
import { isSameCartLine, takeCartNotice, type CartNotice } from "@/features/checkout/utils/cart-notice";

export default function CartPage() {
  const {
    cartItems,
    loading,
    error,
    updatingId,
    togglingWishlist,
    resyncing,
    syncErrorByItem,
    hasSyncError,
    actionError,
    subtotal,
    wishlistedItems,
    handleQuantityChange,
    handleRetryUpdate,
    handleRemove,
    handleToggleWishlist,
    handleResyncFromServer,
    dismissActionError,
  } = useCartItems();

  // 決済の画面の受け付けで断られた理由（決め事 D11）。読んだら消えるので、開発時の二重実行で空を上書きしない。
  // 読み込み中は読み上げの入れ物が DOM に無い。そのまま notice に入れると、商品が届いた後に文言ごと
  // 入れ物が差し込まれ、スクリーンリーダーが読まないことがある。いったん表示待ちに置き、
  // 読み込みが終わって入れ物が空のまま描かれた後で notice に移す
  const [pendingNotice, setPendingNotice] = React.useState<CartNotice | null>(null);
  const [notice, setNotice] = React.useState<CartNotice | null>(null);
  React.useEffect(() => {
    const taken = takeCartNotice();
    if (taken) {
      setPendingNotice(taken);
    }
  }, []);
  React.useEffect(() => {
    if (!loading && pendingNotice) {
      setNotice(pendingNotice);
      setPendingNotice(null);
    }
  }, [loading, pendingNotice]);

  const noticeBlock = (
    <LiveMessage
      as="div"
      politeness="status"
      data-testid="cart-notice"
      className={notice ? "border border-black/20 bg-black/2 mb-6" : undefined}
      // --pad-x は商品ありの外枠でしか定義されない。空のカートでも余白が 0 にならないよう同じ式を既定値にする
      style={
        notice
          ? {
              fontSize: "var(--lk-size-xs)",
              padding: "var(--pad-x, calc(var(--lk-size-md) / var(--sqrt-phi)))",
            }
          : undefined
      }
    >
      {notice ? (
        <>
          <p>{notice.message}</p>
          {notice.kind === "stock_changed" && notice.lines.length > 0 ? (
            <ul className="mt-2 list-disc pl-5">
              {notice.lines.map((line) => {
                const variant = [line.color, line.size].filter(Boolean).join(" / ");
                return (
                  <li key={`${line.itemId}|${line.color ?? ""}|${line.size ?? ""}`}>
                    {line.name}
                    {variant ? `（${variant}）` : ""}
                  </li>
                );
              })}
            </ul>
          ) : null}
        </>
      ) : null}
    </LiveMessage>
  );

  if (loading) {
    // CT-1: 黒バー明滅 + デバッグ文言を廃し、カートレイアウトの控えめなスケルトンに
    return (
      <div className="max-w-5xl mx-auto w-full">
        <div
          className="grid grid-cols-1 md:grid-cols-[3fr_2fr] gap-8"
          aria-hidden="true"
        >
          <div>
            {Array.from({ length: 3 }).map((_, i) => (
              <div
                key={i}
                className="border-b border-black/10 flex gap-4 py-6 animate-pulse"
              >
                <div className="w-20 h-24 shrink-0 bg-black/8" />
                <div className="flex-1 flex flex-col gap-2">
                  <div className="h-4 w-2/3 bg-black/8" />
                  <div className="h-3 w-1/4 bg-black/5" />
                  <div className="mt-auto flex items-end justify-between">
                    <div className="h-4 w-20 bg-black/8" />
                    <div className="h-7 w-24 bg-black/5" />
                  </div>
                </div>
              </div>
            ))}
          </div>
          <div>
            <div className="border border-black/10 p-6 animate-pulse space-y-4">
              <div className="h-4 w-1/3 bg-black/8" />
              <div className="h-3 w-full bg-black/5" />
              <div className="h-3 w-full bg-black/5" />
              <div className="h-10 w-full bg-black/8 mt-4" />
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (cartItems.length === 0) {
    return (
      <>
        {/* 空のカートでも読み上げの入れ物は常に置く。空の間は見えず場所も取らない */}
        <div className="max-w-5xl mx-auto w-full">{noticeBlock}</div>
        <EmptyPage
          iconClassName="ri-shopping-bag-line"
          label="YOUR CART IS EMPTY"
          size="xs"
          buttonLabel="CONTINUE SHOPPING"
          href="/item"
        />
      </>
    );
  }

  return (
    <div
      className="max-w-5xl mx-auto w-full"
      style={
        {
          "--pad-x": "calc(var(--lk-size-md) / var(--sqrt-phi))",
          "--pad-y":
            "calc((var(--lk-size-md) * var(--sqrt-phi)) / (var(--phi) * var(--phi)))",
          "--gap-icon2text":
            "calc(var(--lk-size-md) / var(--sqrt-phi) / var(--phi))",
        } as React.CSSProperties
      }
    >
      <div className="grid grid-cols-1 md:grid-cols-[3fr_2fr] gap-8">
        <div>
          {noticeBlock}
          <LiveMessage
            as="div"
            className="text-red-600 border border-black/15 bg-black/2 mb-6"
            style={{ fontSize: "var(--lk-size-md)", padding: "var(--pad-x)" }}
          >
            {error}
          </LiveMessage>

          {/* 外枠と読み上げの入れ物は常に置き、失敗している間だけ枠の見た目と文言を出す（FREQ-377）。
              ボタンは押すと文言が変わるので、読み上げの入れ物の外に置く（案内が読み直されないように） */}
          <div
            className={
              hasSyncError
                ? "text-[#474747] border border-black/20 bg-black/2 flex items-center justify-between mb-6"
                : undefined
            }
            style={
              hasSyncError
                ? {
                    fontSize: "var(--lk-size-xs)",
                    padding: "var(--pad-x)",
                    gap: "var(--pad-x)",
                  }
                : undefined
            }
          >
            <LiveMessage as="span" politeness="status" className="flex items-center gap-2">
              {hasSyncError ? (
                <>
                  <i className="ri-error-warning-line" aria-hidden="true" />
                  数量の更新に失敗した商品があります。再試行または再同期してください。
                </>
              ) : null}
            </LiveMessage>
            {hasSyncError ? (
              <Button
                onClick={handleResyncFromServer}
                disabled={resyncing}
                variant="secondary"
                size="sm"
              >
                {resyncing ? "再同期中..." : "最新状態を再取得"}
              </Button>
            ) : null}
          </div>

          {cartItems.map((item) => (
            <CartItemRow
              key={item.id}
              item={item}
              isUpdating={updatingId === item.id}
              isTogglingWishlist={togglingWishlist === item.item_id.toString()}
              isWishlisted={wishlistedItems.has(item.item_id)}
              syncError={syncErrorByItem[item.id]}
              // 断られた後に数量を減らして在庫に収まった行は、目安が在庫ありに変わっている。目安が読めない（null）ときは印を残す
              stockChanged={
                notice?.kind === "stock_changed" &&
                item.fulfillment !== "stock" &&
                notice.lines.some((line) => isSameCartLine(line, item))
              }
              resyncing={resyncing}
              onQuantityChange={handleQuantityChange}
              onRemove={handleRemove}
              onToggleWishlist={handleToggleWishlist}
              onRetryUpdate={handleRetryUpdate}
              onResync={handleResyncFromServer}
            />
          ))}

          <div
            style={{ paddingTop: "calc(var(--lk-size-md) * var(--sqrt-phi))" }}
          >
            <Link
              href="/item"
              className="group inline-flex items-center text-[#767676]"
              style={{
                fontSize: "var(--lk-size-2xs)",
                gap: "var(--gap-icon2text)",
                letterSpacing: "0.08em",
              }}
            >
              <i className="ri-arrow-left-line transition-transform duration-150 group-hover:-translate-x-0.75 motion-reduce:transition-none" />
              CONTINUE SHOPPING
            </Link>
          </div>
        </div>

        <div>
          <OrderSummary subtotal={subtotal} />
        </div>
      </div>

      {/* FREQ-342: 操作の失敗は alert() ではなく商品詳細と同じ Toast で伝える。
          読み上げの入れ物は常に置き、トーストが出ている間だけ中身と data-testid を持たせる（FREQ-376） */}
      <LiveMessage
        as="div"
        data-testid={actionError ? "cart-action-toast" : undefined}
        className="fixed bottom-4 right-4 z-50 max-w-[min(92vw,420px)]"
      >
        {actionError ? (
          <ToastSnackbar
            message={actionError}
            variant="error"
            actionLabel="閉じる"
            onAction={dismissActionError}
          />
        ) : null}
      </LiveMessage>
    </div>
  );
}
