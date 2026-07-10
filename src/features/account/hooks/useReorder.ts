import React from "react";
import { clientFetch } from "@/lib/client-fetch";

// 再購入（注文商品をカートに追加）の共通ロジック。
// 購入履歴タブ・注文詳細ページで同一挙動を共有する。
// 成否メッセージの表示先はページごとに異なるためコールバックで受け取る。

type ReorderableItem = {
  id: string;
  itemId: number | null;
  quantity: number;
  color?: string | null;
  size?: string | null;
};

export function useReorder(callbacks: {
  onSuccess: (message: string) => void;
  onError: (message: string) => void;
}) {
  const [reorderingItemId, setReorderingItemId] = React.useState<string | null>(
    null,
  );

  const reorder = async (item: ReorderableItem) => {
    if (!item.itemId) return;
    setReorderingItemId(item.id);
    try {
      const response = await clientFetch("/api/cart", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          item_id: item.itemId,
          quantity: item.quantity,
          color: item.color ?? "",
          size: item.size ?? "",
        }),
      });
      if (!response.ok) throw new Error("カートへの追加に失敗しました");
      callbacks.onSuccess("カートに追加しました");
    } catch {
      callbacks.onError("カートへの追加に失敗しました");
    } finally {
      setReorderingItemId(null);
    }
  };

  return { reorderingItemId, reorder };
}
