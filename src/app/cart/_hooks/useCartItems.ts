import { useState, useEffect, useRef, useCallback } from "react";
import { useCart } from "@/contexts/CartContext";
import { fetchCartJson, postCart, toCartEntries, type CartEntry } from "@/features/cart/client/cart-api";
import type { CartJson } from "@/features/cart/types/cart-json";

export type { CartEntry };

export function useCartItems() {
  const [cartItems, setCartItems] = useState<CartEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [togglingWishlist, setTogglingWishlist] = useState<string | null>(null);
  const [resyncing, setResyncing] = useState(false);
  const [syncErrorByItem, setSyncErrorByItem] = useState<Record<string, string>>({});
  // 削除・ウィッシュリスト操作の失敗。alert() はページを止めるうえ商品詳細と見た目が揃わないので、
  // 同じ Toast に寄せる。表示はページ側の責務なので、ここは文言を持つだけ。
  const [actionError, setActionError] = useState<string | null>(null);

  const { updateCartCount, wishlistedItems, toggleWishlist } = useCart();

  // Refs track debounce/in-flight state without triggering re-renders
  const pendingTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const lastDesired = useRef<Record<string, number>>({});
  const failedDesired = useRef<Record<string, number>>({});
  const confirmedQuantities = useRef<Record<string, number>>({});
  const inFlight = useRef<Set<string>>(new Set());

  const fetchCart = useCallback(async ({ showLoading = false } = {}) => {
    if (showLoading) setLoading(true);
    try {
      const items = toCartEntries(await fetchCartJson());
      setCartItems(items);
      confirmedQuantities.current = Object.fromEntries(
        items.map((i) => [i.id, i.quantity])
      );
      failedDesired.current = {};
      setSyncErrorByItem({});
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "エラーが発生しました");
    } finally {
      if (showLoading) setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchCart({ showLoading: true });
    // cleanup 実行時には ref の中身が差し替わっている可能性があるため、
    // エフェクト実行時点の参照をローカルへ退避しておく。
    const timers = pendingTimers.current;
    return () => {
      Object.values(timers).forEach(clearTimeout);
    };
  }, [fetchCart]);

  const rollbackToConfirmed = (cartId: string) => {
    const qty = confirmedQuantities.current[cartId];
    if (typeof qty !== "number") return;
    setCartItems((prev) =>
      prev.map((item) => (item.id === cartId ? { ...item, quantity: qty } : item))
    );
  };

  const scheduleUpdate = (cartId: string) => {
    if (pendingTimers.current[cartId]) clearTimeout(pendingTimers.current[cartId]);
    pendingTimers.current[cartId] = setTimeout(() => sendUpdate(cartId), 500);
  };

  const sendUpdate = async (cartId: string) => {
    delete pendingTimers.current[cartId];
    if (inFlight.current.has(cartId)) return;

    const quantity = lastDesired.current[cartId];
    if (quantity === undefined) return;

    inFlight.current.add(cartId);
    setUpdatingId(cartId);
    try {
      const result = await postCart("/api/cart/change", { id: cartId, quantity }, "数量更新に失敗しました");
      if (!result.ok) {
        throw new Error(result.description);
      }
      // 応答はカート全体。この明細の数量とお届けの目安を確定値として採る
      const updatedLine = toCartEntries(result.body as CartJson).find((item) => item.id === cartId);
      const confirmedQty = updatedLine?.quantity ?? quantity;
      const fulfillment = updatedLine?.fulfillment ?? null;
      confirmedQuantities.current[cartId] = confirmedQty;
      delete failedDesired.current[cartId];
      setCartItems((prev) =>
        prev.map((item) =>
          item.id === cartId ? { ...item, quantity: confirmedQty, fulfillment } : item
        )
      );
      setSyncErrorByItem((prev) => {
        const next = { ...prev };
        delete next[cartId];
        return next;
      });
      await updateCartCount();
    } catch (err) {
      failedDesired.current[cartId] = quantity;
      rollbackToConfirmed(cartId);
      setSyncErrorByItem((prev) => ({
        ...prev,
        [cartId]: err instanceof Error ? err.message : "エラーが発生しました",
      }));
    } finally {
      inFlight.current.delete(cartId);
      setUpdatingId(null);
      if (lastDesired.current[cartId] !== quantity) scheduleUpdate(cartId);
    }
  };

  const handleQuantityChange = (cartId: string, newQuantity: number) => {
    if (newQuantity < 1) return;
    lastDesired.current[cartId] = newQuantity;
    setCartItems((prev) =>
      prev.map((item) =>
        item.id === cartId ? { ...item, quantity: newQuantity } : item
      )
    );
    if (!inFlight.current.has(cartId)) scheduleUpdate(cartId);
  };

  const handleRetryUpdate = (cartId: string) => {
    const qty = failedDesired.current[cartId];
    if (typeof qty !== "number") return;
    lastDesired.current[cartId] = qty;
    setCartItems((prev) =>
      prev.map((item) => (item.id === cartId ? { ...item, quantity: qty } : item))
    );
    setSyncErrorByItem((prev) => {
      const next = { ...prev };
      delete next[cartId];
      return next;
    });
    if (!inFlight.current.has(cartId)) scheduleUpdate(cartId);
  };

  const handleRemove = async (cartId: string) => {
    setUpdatingId(cartId);
    setActionError(null);
    try {
      // 削除は数量0の変更（Shopify の /cart/change.js と同じ）
      const result = await postCart("/api/cart/change", { id: cartId, quantity: 0 }, "削除に失敗しました");
      if (!result.ok) throw new Error(result.description);
      setCartItems((prev) => prev.filter((item) => item.id !== cartId));
      await updateCartCount();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "エラーが発生しました");
    } finally {
      setUpdatingId(null);
    }
  };

  const handleToggleWishlist = async (itemId: number) => {
    setTogglingWishlist(itemId.toString());
    setActionError(null);
    try {
      await toggleWishlist(itemId);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "エラーが発生しました");
    } finally {
      setTogglingWishlist(null);
    }
  };

  const dismissActionError = () => setActionError(null);

  const handleResyncFromServer = async () => {
    setResyncing(true);
    await fetchCart({ showLoading: false });
    setResyncing(false);
  };

  const subtotal = cartItems.reduce(
    (sum, item) => sum + (item.items?.price ?? 0) * item.quantity,
    0
  );

  return {
    cartItems,
    loading,
    error,
    updatingId,
    togglingWishlist,
    resyncing,
    syncErrorByItem,
    hasSyncError: Object.keys(syncErrorByItem).length > 0,
    actionError,
    subtotal,
    wishlistedItems,
    handleQuantityChange,
    handleRetryUpdate,
    handleRemove,
    handleToggleWishlist,
    handleResyncFromServer,
    dismissActionError,
  };
}
