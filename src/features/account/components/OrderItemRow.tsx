// File: src/features/account/components/OrderItemRow.tsx
import Image from "next/image";
import { Button } from "@/components/ui/Button/Button";
import { ORDER_STATUS_TEXT } from "@/lib/orders/status/status-messages";

// 注文商品1行の共通表示（購入履歴タブ・注文詳細で共有）。
// account.css の .account-order-* スタイルを利用する。
// モバイルではボタンを商品情報列の中（価格の下）に置き、
// 商品とアクションを1つの塊として見せる（近接・整列）。

export type OrderLineItem = {
  id: string;
  itemId: number | null;
  /** 再注文でカートに入れるバリアントの番号。番号の無い古い明細は null */
  variantId: number | null;
  name: string;
  imageUrl?: string | null;
  color?: string | null;
  size?: string | null;
  quantity: number;
  amount: string;
  stockStatus?: "in_stock" | "low_stock" | "sold_out" | "unknown";
  /** 返金した数（返事待ち・保留・成功の返金の合計）。注文の窓口が数える。省くと 0 点で、印を出さない */
  refundedQuantity?: number;
  /** 'exchange' は返品の交換でお店が足した品の行（値段は 0）。「交換の品」の印を付け、値段は「—」と出す。省くと 'order'（ふつうの行） */
  lineKind?: "order" | "exchange";
};

export function OrderItemRow({
  item,
  isReordering,
  onReorder,
  readOnly,
}: {
  item: OrderLineItem;
  isReordering: boolean;
  onReorder: (item: OrderLineItem) => void;
  readOnly?: false;
} | { item: OrderLineItem; readOnly: true; isReordering?: never; onReorder?: never }): React.JSX.Element {
  // モバイル(情報列内)と sm+(右端)の2箇所に出し分けるため関数化
  const renderAction = () => {
    if (readOnly || !item.itemId) {
      return null;
    }
    if (item.stockStatus === "sold_out") {
      return (
        <Button
          href={`/contact?subject=${encodeURIComponent(`予約注文：${item.name}`)}`}
          variant="secondary"
          size="sm"
          className="font-acumin"
        >
          予約注文
        </Button>
      );
    }
    return (
      <Button
        type="button"
        variant="secondary"
        size="sm"
        className="font-acumin"
        disabled={isReordering}
        onClick={() => onReorder(item)}
      >
        {isReordering ? "追加中..." : "再度購入"}
      </Button>
    );
  };

  const action = renderAction();
  const refundedQuantity = item.refundedQuantity ?? 0;
  const isExchange = item.lineKind === "exchange";

  return (
    <div className="account-order-item min-w-0 break-words">
      {item.imageUrl ? (
        <Image
          src={item.imageUrl}
          alt={item.name}
          width={80}
          height={80}
          className="rounded object-cover"
        />
      ) : null}
      <div className="account-order-lines flex-1 min-w-0">
        <p className="account-value">{item.name}</p>
        <div>
          <p className="account-label">
            {ORDER_STATUS_TEXT.items.colorSize(item.color ?? "", item.size ?? "")}
          </p>
          <p className="account-label">{ORDER_STATUS_TEXT.items.quantity(item.quantity)}</p>
          {isExchange ? (
            <span
              className="account-status account-status-sm mt-1 mr-1"
              data-testid="order-item-exchange"
            >
              {ORDER_STATUS_TEXT.items.exchange}
            </span>
          ) : null}
          {refundedQuantity > 0 ? (
            <span
              className="account-status account-status-sm mt-1"
              data-testid="order-item-refunded"
            >
              {ORDER_STATUS_TEXT.items.refunded(refundedQuantity)}
            </span>
          ) : null}
        </div>
        {/* 交換の品の行は値段が 0。「¥0」と出すと無料で買った品に見えるので「—」にする */}
        <p className="account-value">{isExchange ? ORDER_STATUS_TEXT.items.exchangeAmount : item.amount}</p>
        {action ? <div className="mt-1 sm:hidden">{action}</div> : null}
      </div>
      {action ? (
        <div className="hidden shrink-0 sm:block">{action}</div>
      ) : null}
    </div>
  );
}
