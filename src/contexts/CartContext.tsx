'use client';

import React, { createContext, useContext, useState, useEffect } from 'react';

type CartItemResponse = {
  quantity: number;
};

type WishlistItemResponse = {
  id: string;
  item_id: number;
};

interface CartContextType {
  cartCount: number;
  wishlistedItems: Set<number>;
  updateCartCount: () => Promise<void>;
  updateWishlist: () => Promise<void>;
  toggleWishlist: (itemId: number) => Promise<boolean>;
}

const CartContext = createContext<CartContextType | undefined>(undefined);

export function CartProvider({ children, enabled = true }: { children: React.ReactNode; enabled?: boolean }) {
  const [cartCount, setCartCount] = useState(0);
  const [wishlistedItems, setWishlistedItems] = useState<Set<number>>(new Set());

  const updateCartCount = async () => {
    try {
      const response = await fetch('/api/cart');
      if (response.ok) {
        const cartItems: CartItemResponse[] = await response.json();
        const totalCount = cartItems.reduce((sum: number, item) => sum + item.quantity, 0);
        setCartCount(totalCount);
      }
    } catch (error) {
      console.error('Failed to fetch cart count:', error);
    }
  };

  const updateWishlist = async () => {
    try {
      const response = await fetch('/api/wishlist');
      if (response.ok) {
        const wishlistItems: WishlistItemResponse[] = await response.json();
        const itemIds = new Set(wishlistItems.map((item) => item.item_id));
        setWishlistedItems(itemIds);
      }
    } catch (error) {
      console.error('Failed to fetch wishlist:', error);
    }
  };

  const toggleWishlist = async (itemId: number): Promise<boolean> => {
    try {
      const isWishlisted = wishlistedItems.has(itemId);

      if (isWishlisted) {
        // Remove from wishlist - need to find wishlist ID first
        const response = await fetch('/api/wishlist');
        if (response.ok) {
          const wishlistItems: WishlistItemResponse[] = await response.json();
          const wishlistItem = wishlistItems.find((item) => item.item_id === itemId);
          
          if (wishlistItem) {
            const deleteResponse = await fetch(`/api/wishlist/${wishlistItem.id}`, {
              method: 'DELETE',
            });

            if (!deleteResponse.ok) {
              throw new Error('ウィッシュリストから削除できません');
            }

            setWishlistedItems(prev => {
              const next = new Set(prev);
              next.delete(itemId);
              return next;
            });
            return false;
          }
        }
      } else {
        // Add to wishlist
        const response = await fetch('/api/wishlist', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            item_id: itemId,
          }),
        });

        if (!response.ok) {
          if (response.status === 409) {
            // Already in wishlist
            setWishlistedItems(prev => new Set(prev).add(itemId));
            return true;
          }
          throw new Error('ウィッシュリストに追加できません');
        }

        setWishlistedItems(prev => new Set(prev).add(itemId));
        return true;
      }
    } catch (error) {
      console.error('Error toggling wishlist:', error);
      throw error;
    }
    return false;
  };

  // Initial fetch on mount
  useEffect(() => {
    if (!enabled) {
      return;
    }

    updateCartCount();
    updateWishlist();
  }, [enabled]);

  return (
    <CartContext.Provider value={{ cartCount, wishlistedItems, updateCartCount, updateWishlist, toggleWishlist }}>
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
