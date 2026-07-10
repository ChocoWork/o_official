import Image from "next/image";
import { Button } from "@/components/ui/Button/Button";

// 注文商品1行の共通表示（購入履歴タブ・注文詳細で共有）。
// account.css の .account-order-* スタイルを利用する。
// モバイルではボタンを商品情報列の中（価格の下）に置き、
// 商品とアクションを1つの塊として見せる（近接・整列）。

export type OrderLineItem = {
  id: string;
  itemId: number | null;
  name: string;
  imageUrl?: string | null;
  color?: string | null;
  size?: string | null;
  quantity: number;
  amount: string;
  stockStatus?: "in_stock" | "low_stock" | "sold_out" | "unknown";
};

export function OrderItemRow({
  item,
  isReordering,
  onReorder,
}: {
  item: OrderLineItem;
  isReordering: boolean;
  onReorder: (item: OrderLineItem) => void;
}) {
  // モバイル(情報列内)と sm+(右端)の2箇所に出し分けるため関数化
  const renderAction = () => {
    if (!item.itemId) {
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

  return (
    <div className="account-order-item">
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
            {item.color} / {item.size}
          </p>
          <p className="account-label">数量: {item.quantity}</p>
        </div>
        <p className="account-value">{item.amount}</p>
        {action ? <div className="mt-1 sm:hidden">{action}</div> : null}
      </div>
      {action ? (
        <div className="hidden shrink-0 sm:block">{action}</div>
      ) : null}
    </div>
  );
}
