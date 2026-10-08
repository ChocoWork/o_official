'use client';

import React, { createContext, useCallback, useContext, useState, useEffect, useRef } from 'react';
import { fetchCartJson, sendShoppingRequest } from '@/features/cart/client/cart-api';

type WishlistItemResponse = {
  id: string;
  item_id: number;
};

interface CartContextType {
  cartCount: number;
  wishlistedItems: Set<number>;
  updateCartCount: () => Promise<void>;
  updateWishlist: () => Promise<void>;
  /** カートの数とお気に入りを読み直す。ログイン・ログアウトの後に呼ぶ（CartLoginSync） */
  refreshShopping: () => Promise<void>;
  toggleWishlist: (itemId: number) => Promise<boolean>;
}

const CartContext = createContext<CartContextType | undefined>(undefined);

export function CartProvider({ children, enabled = true }: { children: React.ReactNode; enabled?: boolean }) {
  const [cartCount, setCartCount] = useState(0);
  const [wishlistedItems, setWishlistedItems] = useState<Set<number>>(new Set());
  // item_id -> wishlist の行 ID。解除で DELETE 先を引くために持つ。
  // これが無いと解除のたびに一覧を取り直すことになり、追加の倍の往復がかかる。
  const wishlistRowIds = useRef<Map<number, string>>(new Map());
  // 処理中の item_id。楽観更新は「押した時点の状態」へ巻き戻すので、
  // 同じ商品の操作が重なるとロールバックが後勝ちして表示が壊れる。
  const pendingItems = useRef<Set<number>>(new Set());

  const updateCartCount = useCallback(async () => {
    try {
      const cart = await fetchCartJson();
      setCartCount(cart.item_count);
    } catch (error) {
      console.error('Failed to fetch cart count:', error);
    }
  }, []);

  const updateWishlist = useCallback(async () => {
    try {
      const response = await sendShoppingRequest('/api/wishlist');
      if (response.ok) {
        const wishlistItems: WishlistItemResponse[] = await response.json();
        wishlistRowIds.current = new Map(wishlistItems.map((item) => [item.item_id, item.id]));
        setWishlistedItems(new Set(wishlistItems.map((item) => item.item_id)));
      }
    } catch (error) {
      console.error('Failed to fetch wishlist:', error);
    }
  }, []);

  const refreshShopping = useCallback(async () => {
    await Promise.all([updateCartCount(), updateWishlist()]);
  }, [updateCartCount, updateWishlist]);

  const markWishlisted = (itemId: number, wishlisted: boolean) => {
    setWishlistedItems(prev => {
      const next = new Set(prev);
      if (wishlisted) {
        next.add(itemId);
      } else {
        next.delete(itemId);
      }
      return next;
    });
  };

  /** 行 ID が手元に無いときだけ一覧を引き直す。409 で登録済みと分かった場合など。 */
  const lookupWishlistRowId = async (itemId: number): Promise<string | undefined> => {
    const response = await sendShoppingRequest('/api/wishlist');
    if (!response.ok) {
      throw new Error('ウィッシュリストから削除できません');
    }

    const wishlistItems: WishlistItemResponse[] = await response.json();
    wishlistRowIds.current = new Map(wishlistItems.map((item) => [item.item_id, item.id]));
    return wishlistRowIds.current.get(itemId);
  };

  const removeFromWishlist = async (itemId: number) => {
    const rowId = wishlistRowIds.current.get(itemId) ?? (await lookupWishlistRowId(itemId));

    // サーバー側に行が無い＝解除済み。目的は達成されているので成功として扱う。
    if (rowId) {
      const response = await sendShoppingRequest(`/api/wishlist/${rowId}`, { method: 'DELETE' });

      // 404 も「既に無い」なので同じ。冪等にしておかないと、行 ID が古いだけで失敗になる。
      if (!response.ok && response.status !== 404) {
        throw new Error('ウィッシュリストから削除できません');
      }
    }

    wishlistRowIds.current.delete(itemId);
  };

  const addToWishlist = async (itemId: number) => {
    const response = await sendShoppingRequest('/api/wishlist', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        item_id: itemId,
      }),
    });

    // 409 は既に登録済み。目的は達成されている。行 ID は返らないので、
    // 解除するときに lookupWishlistRowId で引き直す。
    if (response.status === 409) {
      return;
    }

    if (!response.ok) {
      throw new Error('ウィッシュリストに追加できません');
    }

    const created: WishlistItemResponse | null = await response.json().catch(() => null);
    if (created?.id) {
      wishlistRowIds.current.set(itemId, created.id);
    }
  };

  const toggleWishlist = async (itemId: number): Promise<boolean> => {
    const isWishlisted = wishlistedItems.has(itemId);

    // 処理中の商品は触らない。詳細ページとカートページから同じ商品を操作できるため、
    // ボタンの disabled だけでは重なりを防げない。
    if (pendingItems.current.has(itemId)) {
      return isWishlisted;
    }
    pendingItems.current.add(itemId);

    // 先に表示を反転する。通信を待たせると、押しても何も起きない時間ができる。
    markWishlisted(itemId, !isWishlisted);

    try {
      if (isWishlisted) {
        await removeFromWishlist(itemId);
        return false;
      }

      await addToWishlist(itemId);
      return true;
    } catch (error) {
      markWishlisted(itemId, isWishlisted);
      console.error('Error toggling wishlist:', error);
      throw error;
    } finally {
      pendingItems.current.delete(itemId);
    }
  };

  // Initial fetch on mount
  useEffect(() => {
    if (!enabled) {
      return;
    }

    updateCartCount();
    updateWishlist();
  }, [enabled, updateCartCount, updateWishlist]);

  return (
    <CartContext.Provider value={{ cartCount, wishlistedItems, updateCartCount, updateWishlist, refreshShopping, toggleWishlist }}>
      {children}
    </CartContext.Provider>
  );
}

export function useCart() {
  const context = useContext(CartContext);
  if (context === undefined) {
    throw new Error('useCart must be used within CartProvider');
  }
  return context;
}
