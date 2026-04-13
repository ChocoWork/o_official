'use client';

import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { useCart } from '@/contexts/CartContext';

interface WishlistItem {
  id: string;
  item_id: number;
  added_at: string;
  items: {
    id: number;
    name: string;
    price: number;
    image_url: string;
    category: string;
  } | null;
}

function isWishlistItem(value: unknown): value is WishlistItem {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  const hasBase =
    typeof candidate.id === 'string'
    && typeof candidate.item_id === 'number'
    && typeof candidate.added_at === 'string';

  if (!hasBase) {
    return false;
  }

  if (candidate.items === null) {
    return true;
  }

  if (!candidate.items || typeof candidate.items !== 'object') {
    return false;
  }

  const item = candidate.items as Record<string, unknown>;
  return (
    typeof item.id === 'number'
    && typeof item.name === 'string'
    && typeof item.price === 'number'
    && typeof item.image_url === 'string'
    && typeof item.category === 'string'
  );
}

function parseWishlistResponse(payload: unknown): WishlistItem[] {
  if (!Array.isArray(payload)) {
    throw new Error('ウィッシュリストのレスポンス形式が不正です');
  }

  const parsed = payload.filter(isWishlistItem);
  if (parsed.length !== payload.length) {
    console.warn('Invalid wishlist entries were filtered out', payload);
  }

  return parsed;
}

export default function WishlistClient() {
  const [wishlistItems, setWishlistItems] = useState<WishlistItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [addingToCartId, setAddingToCartId] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const { updateWishlist, updateCartCount } = useCart();

  useEffect(() => {
    fetchWishlist();
  }, []);

  const fetchWishlist = async () => {
    try {
      const response = await fetch('/api/wishlist');
      if (!response.ok) {
        throw new Error('ウィッシュリストの取得に失敗しました');
      }
      const payload = await response.json();
      const data = parseWishlistResponse(payload);
      setWishlistItems(data);
    } catch (err) {
      console.error('Error fetching wishlist:', err);
      setError(err instanceof Error ? err.message : 'エラーが発生しました');
    } finally {
      setLoading(false);
    }
  };

  const handleRemove = async (wishlistId: string) => {
    setActionMessage(null);
    setRemovingId(wishlistId);
    try {
      const response = await fetch(`/api/wishlist/${wishlistId}`, {
        method: 'DELETE',
      });

      if (!response.ok) {
        throw new Error('削除に失敗しました');
      }

      setWishlistItems(wishlistItems.filter((item) => item.id !== wishlistId));
      
      // Update wishlist in context
      await updateWishlist();
    } catch (err) {
      console.error('Error removing from wishlist:', err);
      alert(err instanceof Error ? err.message : 'エラーが発生しました');
    } finally {
      setRemovingId(null);
    }
  };

  const handleAddToCart = async (wishlistItem: WishlistItem) => {
    if (!wishlistItem.items) {
      return;
    }

    setActionMessage(null);
    setAddingToCartId(wishlistItem.id);

    try {
      const response = await fetch('/api/cart', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          item_id: wishlistItem.items.id,
          quantity: 1,
        }),
      });

      if (!response.ok) {
        throw new Error('カートへの追加に失敗しました');
      }

      await updateCartCount();
      setActionMessage('カートに追加しました。');
    } catch (err) {
      console.error('Error adding to cart:', err);
      setActionMessage(err instanceof Error ? err.message : 'エラーが発生しました');
    } finally {
      setAddingToCartId(null);
    }
  };

  if (loading) {
    return (
      <div className="text-center py-12">
        <div className="text-base tracking-widest font-brand">読み込み中...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-center py-12">
        <p className="text-sm text-red-500 font-brand">{error}</p>
      </div>
    );
  }

  if (wishlistItems.length === 0) {
    return (
      <div className="text-center py-12">
        <p className="text-sm text-[#474747] font-brand mb-4">
          ウィッシュリストは空です
        </p>
        <Link href="/item" className="text-sm text-black hover:text-[#474747] transition-colors font-brand">
          買い物を続ける
        </Link>
      </div>
    );
  }

  return (
    <>
      <div className="flex items-center justify-between mb-8">
        <p className="text-sm text-[#474747] font-brand">{wishlistItems.length}点のアイテム</p>
      </div>
      {actionMessage ? (
        <p className="mb-4 text-sm text-[#474747] font-brand" role="status">{actionMessage}</p>
      ) : null}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-8" role="list" aria-label="ウィッシュリスト商品一覧">
        {wishlistItems.map((item) => (
          <article key={item.id} className="group relative" role="listitem">
            {item.items ? (
              <Link className="block" href={`/item/${item.items.id}`}>
                <div className="aspect-[4/5] bg-[#f5f5f5] mb-4 overflow-hidden relative">
                  <Image
                    alt={item.items.name}
                    className="w-full h-full object-cover object-top group-hover:scale-105 transition-transform duration-500"
                    src={item.items.image_url}
                    fill
                    sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 25vw"
                  />
                </div>
              </Link>
            ) : (
              <div className="aspect-[4/5] bg-[#f5f5f5] mb-4 flex items-center justify-center px-4 text-center text-sm text-[#474747] font-brand">
                商品情報を取得できませんでした
              </div>
            )}
            <button
              onClick={() => handleRemove(item.id)}
              disabled={removingId === item.id}
              aria-label="ウィッシュリストから削除"
              className="absolute top-4 right-4 w-10 h-10 bg-white flex items-center justify-center hover:bg-black hover:text-white transition-all duration-300 cursor-pointer opacity-0 group-hover:opacity-100 disabled:opacity-30"
            >
              <i className="ri-close-line text-xl" />
            </button>
            {item.items ? (
              <>
                <Link href={`/item/${item.items.id}`}>
                  <p className="text-xs text-[#474747] mb-2 tracking-wider font-brand">
                    {item.items.category}
                  </p>
                  <h3 className="text-base text-black mb-2 hover:text-[#474747] transition-colors font-brand">
                    {item.items.name}
                  </h3>
                  <p className="text-sm text-black font-brand mb-3">
                    ¥{item.items.price.toLocaleString('ja-JP')}
                  </p>
                </Link>
                <button
                  type="button"
                  onClick={() => handleAddToCart(item)}
                  disabled={addingToCartId === item.id}
                  className="w-full border border-black text-black text-sm py-2 hover:bg-black hover:text-white transition-colors disabled:opacity-40"
                >
                  {addingToCartId === item.id ? '追加中...' : 'カートに追加'}
                </button>
              </>
            ) : (
              <div className="space-y-2">
                <p className="text-xs text-[#474747] tracking-wider font-brand">不明なカテゴリ</p>
                <h3 className="text-base text-black font-brand">削除済み商品</h3>
              </div>
            )}
          </article>
        ))}
      </div>
    </>
  );
}
