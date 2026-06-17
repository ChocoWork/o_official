import { useState, useEffect, useRef, useCallback } from "react";
import { useCart } from "@/contexts/CartContext";

// Shape of a cart entry as returned by /api/cart
export interface CartEntry {
  id: string;
  item_id: number;
  quantity: number;
  color: string | null;
  size: string | null;
  added_at: string;
  // null when the product has been removed from inventory
  items: {
    id: number;
    name: string;
    price: number;
    image_url: string;
    category: string;
  } | null;
}

export function useCartItems() {
  const [cartItems, setCartItems] = useState<CartEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [togglingWishlist, setTogglingWishlist] = useState<string | null>(null);
  const [resyncing, setResyncing] = useState(false);
  const [syncErrorByItem, setSyncErrorByItem] = useState<Record<string, string>>({});

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
      const response = await fetch("/api/cart");
      if (!response.ok) throw new Error("カートの取得に失敗しました");
      const data: CartEntry[] = await response.json();
      const items = data.filter((ci) => ci.items !== null);
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
    return () => {
      Object.values(pendingTimers.current).forEach(clearTimeout);
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
      const response = await fetch(`/api/cart/${cartId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ quantity }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        const message =
          typeof payload?.message === "string"
            ? payload.message
            : typeof payload?.error === "string"
              ? payload.error
              : "数量更新に失敗しました";
        throw new Error(message);
      }
      const updated = await response.json().catch(() => null);
      const confirmedQty =
        typeof updated?.quantity === "number" ? updated.quantity : quantity;
      confirmedQuantities.current[cartId] = confirmedQty;
      delete failedDesired.current[cartId];
      setCartItems((prev) =>
        prev.map((item) =>
          item.id === cartId ? { ...item, quantity: confirmedQty } : item
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
    try {
      const response = await fetch(`/api/cart/${cartId}`, { method: "DELETE" });
      if (!response.ok) throw new Error("削除に失敗しました");
      setCartItems((prev) => prev.filter((item) => item.id !== cartId));
      await updateCartCount();
    } catch (err) {
      alert(err instanceof Error ? err.message : "エラーが発生しました");
    } finally {
      setUpdatingId(null);
    }
  };

  const handleToggleWishlist = async (itemId: number) => {
    setTogglingWishlist(itemId.toString());
    try {
      await toggleWishlist(itemId);
    } catch (err) {
      alert(err instanceof Error ? err.message : "エラーが発生しました");
    } finally {
      setTogglingWishlist(null);
    }
  };

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
    subtotal,
    wishlistedItems,
    handleQuantityChange,
    handleRetryUpdate,
    handleRemove,
    handleToggleWishlist,
    handleResyncFromServer,
  };
}
