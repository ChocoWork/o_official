import React from "react";
import { postCart } from "@/features/cart/client/cart-api";

// 再購入（注文商品をカートに追加）の共通ロジック。
// 購入履歴タブ・注文詳細ページで同一挙動を共有する。
// 成否メッセージの表示先はページごとに異なるためコールバックで受け取る。

type ReorderableItem = {
  id: string;
  itemId: number | null;
  variantId: number | null;
  quantity: number;
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
    // 注文の明細のバリアントで入れる。番号の無い古い明細・取り扱いを終えた色やサイズは入れられない（設計書 8 章）
    if (item.variantId === null) {
      callbacks.onError("この商品は現在お求めいただけません。");
      return;
    }
    setReorderingItemId(item.id);
    try {
      const result = await postCart(
        "/api/cart/add",
        { items: [{ id: item.variantId, quantity: item.quantity }] },
        "カートへの追加に失敗しました",
      );
      if (result.ok) {
        callbacks.onSuccess("カートに追加しました");
      } else {
        callbacks.onError(result.status === 404 ? "この商品は現在お求めいただけません。" : result.description);
      }
    } catch {
      callbacks.onError("カートへの追加に失敗しました");
    } finally {
      setReorderingItemId(null);
    }
  };

  return { reorderingItemId, reorder };
}
