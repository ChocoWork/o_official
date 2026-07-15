'use client';

import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import { useCart } from '@/contexts/CartContext';
import { EmptyPage } from '@/components/ui/EmptyPage/EmptyPage';
import { ItemCardInfo, ItemCardMedia } from '@/features/items/components/ItemCard';
import { extractColorSwatches } from '@/lib/items/colors';
import { isItemInStock } from '@/lib/items/stock-label';

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
    colors?: Array<{ hex: string; name: string }> | string[];
    sizes?: string[];
  } | null;
}

function isColorOption(value: unknown): value is { hex: string; name: string } {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return typeof candidate.hex === 'string' && typeof candidate.name === 'string';
}

function isColorList(value: unknown): value is Array<{ hex: string; name: string }> | string[] {
  if (value === undefined) {
    return true;
  }

  if (!Array.isArray(value)) {
    return false;
  }

  return value.every((entry) => typeof entry === 'string' || isColorOption(entry));
}

function isSizeList(value: unknown): value is string[] {
  if (value === undefined) {
    return true;
  }

  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function resolveDefaultColor(item: WishlistItem['items']): string | null {
  if (!item?.colors || item.colors.length === 0) {
    return null;
  }

  const firstColor = item.colors[0];
  return typeof firstColor === 'string' ? firstColor : firstColor.name;
}

function resolveDefaultSize(item: WishlistItem['items']): string | null {
  if (!item?.sizes || item.sizes.length === 0) {
    return null;
  }

  return item.sizes.length === 1 ? item.sizes[0] : null;
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
    && isColorList(item.colors)
    && isSizeList(item.sizes)
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

const wishlistTextMdStyle: React.CSSProperties = { fontSize: 'var(--lk-size-md)' };
const wishlistTextLgStyle: React.CSSProperties = { fontSize: 'var(--lk-size-lg)' };
const wishlistIconLgStyle: React.CSSProperties = { fontSize: 'var(--lk-size-lg)' };
// 削除済み/フォールバック用の文字サイズ。商品カードは ItemCard（ITEM 一覧と共通）を使う。
const wishlistCardNameStyle: React.CSSProperties = { fontSize: 'var(--lk-size-2xs)' };
const wishlistCardButtonStyle: React.CSSProperties = { fontSize: 'var(--lk-size-2xs)' };

export default function Page() {
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
      // WL-2: ネイティブ alert を廃し、他箇所と同じインライン通知に統一
      setActionMessage(err instanceof Error ? err.message : '削除に失敗しました。時間をおいて再度お試しください。');
    } finally {
      setRemovingId(null);
    }
  };

  const handleAddToCart = async (wishlistItem: WishlistItem) => {
    if (!wishlistItem.items) {
      return;
    }

    const resolvedColor = resolveDefaultColor(wishlistItem.items);
    const resolvedSize = resolveDefaultSize(wishlistItem.items);
    const requiresSizeSelection = Array.isArray(wishlistItem.items.sizes) && wishlistItem.items.sizes.length > 1;

    if (requiresSizeSelection) {
      setActionMessage('サイズ選択が必要な商品です。商品詳細ページからカートに追加してください。');
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
          color: resolvedColor,
          size: resolvedSize,
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
      <div className="max-w-7xl mx-auto w-full">
        <div className="flex items-center justify-between mb-8">
          <h1 className="tracking-widest" style={wishlistTextLgStyle}>WISHLIST</h1>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-x-[2px] sm:gap-x-[3px] lg:gap-x-[4px] gap-y-[16px] sm:gap-y-[20px] md:gap-y-[24px] lg:gap-y-[28px]" aria-hidden="true">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="animate-pulse">
              <div className="aspect-[3/4] bg-black/8 mb-[8px]" />
              <div className="h-[10px] w-1/3 bg-black/8 mb-[6px]" />
              <div className="h-[10px] w-2/3 bg-black/8 mb-[6px]" />
              <div className="h-[10px] w-1/4 bg-black/8 mb-[8px]" />
              <div className="h-8 w-full bg-black/5" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-center py-12">
        <p className="text-red-500" style={wishlistTextMdStyle}>{error}</p>
      </div>
    );
  }

  if (wishlistItems.length === 0) {
    return (
      <EmptyPage
        iconClassName="ri-heart-line"
        label="WISHLIST IS EMPTY"
        size="xs"
        buttonLabel="Continue Shopping"
        href="/item"
      />
    );
  }

  return (
    <div className="max-w-7xl mx-auto w-full">
      <div className="flex items-baseline justify-between mb-8 gap-4">
        <h1 className="tracking-widest" style={wishlistTextLgStyle}>WISHLIST</h1>
        <p className="text-[#474747]" style={wishlistTextMdStyle}>{wishlistItems.length}点のアイテム</p>
      </div>
      {/* WL-3: 操作地点（カード）に近い視認性のため、固定トーストで通知 */}
      {actionMessage ? (
        <div
          role="status"
          className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 max-w-[90vw] bg-black text-white px-5 py-3 shadow-lg flex items-center gap-3"
          style={wishlistTextMdStyle}
        >
          <span>{actionMessage}</span>
          <button
            type="button"
            onClick={() => setActionMessage(null)}
            aria-label="通知を閉じる"
            className="flex-shrink-0 opacity-70 hover:opacity-100 transition-opacity"
          >
            <i className="ri-close-line" aria-hidden="true" />
          </button>
        </div>
      ) : null}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-x-[2px] sm:gap-x-[3px] lg:gap-x-[4px] gap-y-[16px] sm:gap-y-[20px] md:gap-y-[24px] lg:gap-y-[28px]" role="list" aria-label="ウィッシュリスト商品一覧">
        {wishlistItems.map((item) => {
          // カードの見た目は ITEM 一覧（PublicItemGrid）と共通の ItemCard に統一。
          // 色（カラースウォッチ）と数量（在庫：残り〇点／受注生産）を表示する。
          const product = item.items;
          const swatches = product ? extractColorSwatches(product.colors) : [];
          const soldOut = product ? !isItemInStock(product) : false;

          return (
            <article key={item.id} className="group relative" role="listitem">
              {product ? (
                <Link className="block" href={`/item/${product.id}`}>
                  <ItemCardMedia
                    imageUrl={product.image_url}
                    alt={product.name}
                    soldOut={soldOut}
                  />
                </Link>
              ) : (
                <div className="aspect-[3/4] bg-[#f5f5f5] mb-[2px] sm:mb-[6px] md:mb-[8px] flex items-center justify-center px-4 text-center text-[#474747]" style={wishlistCardNameStyle}>
                  商品情報を取得できませんでした
                </div>
              )}
              <button
                onClick={() => handleRemove(item.id)}
                disabled={removingId === item.id}
                aria-label="ウィッシュリストから削除"
                className="absolute top-2 right-2 w-9 h-9 bg-white flex items-center justify-center hover:bg-black hover:text-white transition-all duration-300 cursor-pointer [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 disabled:opacity-30"
              >
                <i className="ri-close-line" style={wishlistIconLgStyle} />
              </button>
              {product ? (
                <>
                  <Link href={`/item/${product.id}`}>
                    <ItemCardInfo
                      name={product.name}
                      price={product.price}
                      swatches={swatches}
                    />
                  </Link>
                  {/* WL-5: 複数サイズ品はボタン挙動と文言を実態に合わせ、詳細ページへ誘導 */}
                  <div className="px-[8px] mt-[8px]">
                    {product.sizes && product.sizes.length > 1 ? (
                      <Link
                        href={`/item/${product.id}`}
                        className="block w-full border border-black text-black text-center py-[6px] hover:bg-black hover:text-white transition-colors"
                        style={wishlistCardButtonStyle}
                      >
                        サイズを選択
                      </Link>
                    ) : (
                      <button
                        type="button"
                        onClick={() => handleAddToCart(item)}
                        disabled={addingToCartId === item.id}
                        className="w-full border border-black text-black py-[6px] hover:bg-black hover:text-white transition-colors disabled:opacity-40"
                        style={wishlistCardButtonStyle}
                      >
                        {addingToCartId === item.id ? '追加中...' : 'カートに追加'}
                      </button>
                    )}
                  </div>
                </>
              ) : (
                <div className="px-[8px] mt-[8px] space-y-[8px]">
                  <h3 className="text-black font-brand tracking-tight" style={wishlistCardNameStyle}>削除済み商品</h3>
                  {/* WL-6: 削除済みエントリを片付ける明示CTA */}
                  <button
                    type="button"
                    onClick={() => handleRemove(item.id)}
                    disabled={removingId === item.id}
                    className="w-full border border-black/30 text-[#474747] py-[6px] hover:border-black hover:text-black transition-colors disabled:opacity-40"
                    style={wishlistCardButtonStyle}
                  >
                    {removingId === item.id ? '処理中...' : 'リストから外す'}
                  </button>
                </div>
              )}
            </article>
          );
        })}
      </div>
    </div>
  );
}
