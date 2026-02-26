"use client";

import React, { useState, useEffect } from "react";
import Link from 'next/link';
import Image from "next/image";
import { useCart } from "@/app/components/CartContext";
import { Button } from '@/app/components/ui/Button';
import { LinkButton } from '@/app/components/ui/LinkButton';
import { Stepper } from '@/app/components/ui/Stepper';
import { TextField } from '@/app/components/ui/TextField';

interface CartItem {
  id: string;
  item_id: number;
  quantity: number;
  color: string | null;
  size: string | null;
  added_at: string;
  items: {
    id: number;
    name: string;
    price: number;
    image_url: string;
    category: string;
  };
}

export default function CartPage() {
  const [cartItems, setCartItems] = useState<CartItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [togglingWishlist, setTogglingWishlist] = useState<string | null>(null);
  const { updateCartCount, wishlistedItems, toggleWishlist } = useCart();

  useEffect(() => {
    fetchCart();
  }, []);

  const fetchCart = async () => {
    try {
      const response = await fetch('/api/cart');
      if (!response.ok) {
        throw new Error('カートの取得に失敗しました');
      }
      const data = await response.json();
      setCartItems(data);
    } catch (err) {
      console.error('Error fetching cart:', err);
      setError(err instanceof Error ? err.message : 'エラーが発生しました');
    } finally {
      setLoading(false);
    }
  };

  const handleQuantityChange = async (cartId: string, newQuantity: number) => {
    if (newQuantity < 1) return;

    setUpdatingId(cartId);
    try {
      const response = await fetch(`/api/cart/${cartId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ quantity: newQuantity }),
      });

      if (!response.ok) {
        throw new Error('数量更新に失敗しました');
      }

      setCartItems(
        cartItems.map((item) =>
          item.id === cartId ? { ...item, quantity: newQuantity } : item
        )
      );

      // Update cart count in context
      await updateCartCount();
    } catch (err) {
      console.error('Error updating quantity:', err);
      alert(err instanceof Error ? err.message : 'エラーが発生しました');
    } finally {
      setUpdatingId(null);
    }
  };

  const handleRemove = async (cartId: string) => {
    setUpdatingId(cartId);
    try {
      const response = await fetch(`/api/cart/${cartId}`, {
        method: 'DELETE',
      });

      if (!response.ok) {
        throw new Error('削除に失敗しました');
      }

      setCartItems(cartItems.filter((item) => item.id !== cartId));

      // Update cart count in context
      await updateCartCount();
    } catch (err) {
      console.error('Error removing from cart:', err);
      alert(err instanceof Error ? err.message : 'エラーが発生しました');
    } finally {
      setUpdatingId(null);
    }
  };

  const handleToggleWishlist = async (itemId: number) => {
    setTogglingWishlist(itemId.toString());
    try {
      await toggleWishlist(itemId);
    } catch (error) {
      console.error('Error toggling wishlist:', error);
      alert(error instanceof Error ? error.message : 'エラーが発生しました');
    } finally {
      setTogglingWishlist(null);
    }
  };

  const subtotal = cartItems.reduce(
    (sum, item) => sum + item.items.price * item.quantity,
    0
  );

  const total = subtotal;

  if (loading) {
    return (
      <main className="pt-32 pb-20 px-6 lg:px-12">
        <div className="max-w-7xl mx-auto text-center">
          <div className="text-base tracking-widest font-brand">読み込み中...</div>
        </div>
      </main>
    );
  }

  return (
    <main className="pt-32 pb-20 px-6 lg:px-12">
      <div className="max-w-7xl mx-auto">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-12">
          <div className="lg:col-span-2 space-y-6">
            {error && (
              <div className="text-sm text-red-500 font-brand p-4 border border-red-300 bg-red-50">
                {error}
              </div>
            )}

            {cartItems.length === 0 ? (
              <div className="text-center py-12">
                <p className="text-sm text-[#474747] font-brand mb-4">
                  カートは空です
                </p>
                <Link href="/item" className="text-sm text-black hover:text-[#474747] transition-colors font-brand">
                  買い物を続ける
                </Link>
              </div>
            ) : (
              <>
                {cartItems.map((item) => (
                  <div
                    key={item.id}
                    className="flex gap-6 border-b border-black/10 pb-6 relative group"
                  >
                    <Link
                      href={`/item/${item.id}`}
                      className="w-32 h-40 bg-[#f5f5f5] flex-shrink-0 overflow-hidden relative"
                    >
                      <Image
                        alt={item.items.name}
                        className="w-full h-full object-cover object-top hover:scale-105 transition-transform duration-500"
                        src={item.items.image_url}
                        fill
                        sizes="128px"
                      />
                    </Link>
                    <div className="flex-1">
                      <div className="flex justify-between items-start mb-2">
                        <Link href={`/item/${item.items.id}`}>
                          <h3 className="text-lg text-black hover:text-[#474747] transition-colors cursor-pointer font-brand">
                            {item.items.name}
                          </h3>
                        </Link>
                        <div className="flex items-center gap-2">
                          <Button
                            onClick={() => handleToggleWishlist(item.item_id)}
                            disabled={togglingWishlist === item.item_id.toString()}
                            variant="ghost"
                            size="sm"
                            className="w-8 h-8 flex items-center justify-center text-[#474747] hover:text-black transition-colors cursor-pointer disabled:opacity-30 px-0 py-0"
                          >
                            <i className={`text-xl ${wishlistedItems.has(item.item_id) ? "ri-heart-fill text-red-500" : "ri-heart-line"}`} />
                          </Button>
                          <Button
                            onClick={() => handleRemove(item.id)}
                            disabled={updatingId === item.id}
                            variant="ghost"
                            size="sm"
                            className="w-8 h-8 flex items-center justify-center text-[#474747] hover:text-black transition-colors cursor-pointer disabled:opacity-30 px-0 py-0"
                          >
                            <i className="ri-close-line text-xl"></i>
                          </Button>
                        </div>
                      </div>
                      {item.color && (
                        <p className="text-sm text-[#474747] mb-1 font-brand">
                          カラー: {item.color}
                        </p>
                      )}
                      {item.size && (
                        <p className="text-sm text-[#474747] mb-4 font-brand">
                          サイズ: {item.size}
                        </p>
                      )}
                      <div className="flex items-center justify-between">
                        <p className="text-lg text-black font-brand">
                          ¥{item.items.price.toLocaleString('ja-JP')}
                        </p>
                        <div className="flex items-center gap-2">
                          <Stepper
                            value={item.quantity}
                            min={1}
                            onChange={(value) => handleQuantityChange(item.id, value)}
                          />
                        </div>
                      </div>
                    </div>
                  </div>
                ))}

                <div className="pt-6">
                  <Link
                    href="/item"
                    className="inline-flex items-center gap-2 text-sm text-black hover:text-[#474747] transition-colors cursor-pointer font-brand"
                  >
                    <i className="ri-arrow-left-line"></i>買い物を続ける
                  </Link>
                </div>
              </>
            )}
          </div>

          <div className="lg:col-span-1">
            <div className="border border-black/10 p-8 sticky top-32">
              <h2 className="text-2xl text-black mb-8 tracking-tight font-display">
                Order Summary
              </h2>
              <div className="mb-6">
                <label className="block text-xs text-[#474747] mb-2 tracking-wider font-brand">
                  プロモーションコード
                </label>
                <div className="flex gap-2">
                  <TextField
                    placeholder="コードを入力"
                    className="flex-1 px-4 py-3 border border-black/20 text-sm focus:outline-none focus:border-black transition-colors font-brand"
                    type="text"
                  />
                  <Button size="md" className="font-brand">適用</Button>
                </div>
                <p className="text-xs text-[#474747] mt-2 font-brand">
                  お試し: WELCOME10 または SAVE20
                </p>
              </div>

              <div className="space-y-4 mb-8 pb-8 border-b border-black/10">
                <div className="flex justify-between">
                  <span className="text-sm text-[#474747] font-brand">小計</span>
                  <span className="text-sm text-black font-brand">
                    ¥{subtotal.toLocaleString('ja-JP')}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-sm text-[#474747] font-brand">配送料</span>
                  <span className="text-sm text-black font-brand">無料</span>
                </div>
              </div>

              <div className="flex justify-between mb-8">
                <span className="text-lg text-black font-brand">合計</span>
                <span className="text-2xl text-black font-display">
                  ¥{total.toLocaleString('ja-JP')}
                </span>
              </div>

              <LinkButton href="/checkout" variant="primary" size="lg" className="w-full mb-4 font-brand">
                購入手続きへ進む
              </LinkButton>

              <div className="space-y-3 pt-6 border-t border-black/10">
                <div className="flex items-center gap-3">
                  <div className="w-5 h-5 flex items-center justify-center">
                    <i className="ri-shield-check-line text-lg text-black"></i>
                  </div>
                  <p className="text-xs text-[#474747] font-brand">安全な決済</p>
                </div>
                <div className="flex items-center gap-3">
                  <div className="w-5 h-5 flex items-center justify-center">
                    <i className="ri-truck-line text-lg text-black"></i>
                  </div>
                  <p className="text-xs text-[#474747] font-brand">
                    2-5営業日でお届け
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <div className="w-5 h-5 flex items-center justify-center">
                    <i className="ri-arrow-go-back-line text-lg text-black"></i>
                  </div>
                  <p className="text-xs text-[#474747] font-brand">30日間返品可能</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
