"use client";

import React, { useState, useEffect, use } from "react";
import Image from "next/image";
import { Item } from "@/app/types/item";
import { useCart } from "@/app/components/CartContext";
import { Button } from '@/app/components/ui/Button';
import { Stepper } from '@/app/components/ui/Stepper';

export default function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { updateCartCount, wishlistedItems, toggleWishlist } = useCart();
  const [item, setItem] = useState<Item | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [color, setColor] = useState<string>("");
  const [size, setSize] = useState<string | null>(null);
  const [quantity, setQuantity] = useState<number>(1);
  const [selectedImageIndex, setSelectedImageIndex] = useState(0);
  const [addingToCart, setAddingToCart] = useState(false);
  const [togglingWishlist, setTogglingWishlist] = useState(false);

  const isWishlisted = item ? wishlistedItems.has(item.id) : false;

  useEffect(() => {
    const fetchItem = async () => {
      try {
        const response = await fetch(`/api/items/${id}`);
        if (!response.ok) {
          if (response.status === 404) {
            throw new Error("商品が見つかりません");
          }
          throw new Error("商品データの取得に失敗しました");
        }
        const data: Item = await response.json();
        setItem(data);
        // 最初の色を初期選択値として設定
        if (data.colors && Array.isArray(data.colors) && data.colors.length > 0) {
          const firstColor = data.colors[0];
          if (typeof firstColor === 'object' && firstColor !== null && 'name' in firstColor) {
            setColor((firstColor as { name: string }).name);
          }
        }
        // サイズが1つの場合は自動選択
        if (data.sizes && Array.isArray(data.sizes) && data.sizes.length === 1) {
          setSize(data.sizes[0]);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "エラーが発生しました");
        console.error("Failed to fetch item:", err);
      } finally {
        setLoading(false);
      }
    };

    fetchItem();
  }, [id]);

  const handleAddToCart = async () => {
    if (!item || !color || !size) {
      alert("すべてのオプションを選択してください");
      return;
    }

    setAddingToCart(true);
    try {
      const response = await fetch('/api/cart', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          item_id: item.id,
          quantity,
          color,
          size,
        }),
      });

      if (!response.ok) {
        throw new Error('カートへの追加に失敗しました');
      }

      // Update cart count in context
      await updateCartCount();

      alert('カートに追加しました');
      setQuantity(1);
    } catch (error) {
      console.error('Error adding to cart:', error);
      alert(error instanceof Error ? error.message : 'エラーが発生しました');
    } finally {
      setAddingToCart(false);
    }
  };

  const handleToggleWishlist = async () => {
    if (!item) return;

    setTogglingWishlist(true);
    try {
      await toggleWishlist(item.id);
    } catch (error) {
      console.error('Error toggling wishlist:', error);
      alert(error instanceof Error ? error.message : 'エラーが発生しました');
    } finally {
      setTogglingWishlist(false);
    }
  };

  if (loading) {
    return (
      <main className="pt-32 pb-20 px-6 lg:px-12">
        <div className="max-w-7xl mx-auto text-center">
          <div className="text-base tracking-widest font-brand">読み込み中...</div>
        </div>
      </main>
    );
  }

  if (error || !item) {
    return (
      <main className="pt-32 pb-20 px-6 lg:px-12">
        <div className="max-w-7xl mx-auto">
          <div className="mb-8">
            <Button
              type="button"
              onClick={(e) => {
                e.preventDefault();
                history.back();
              }}
              variant="ghost"
              className="text-sm text-[#474747] hover:text-black transition-colors duration-300 flex items-center gap-2 font-brand px-0 py-0"
             size="md">
              <i className="ri-arrow-left-line" />BACK TO ITEMS
            </Button>
          </div>
          <div className="text-center">
            <p className="text-base tracking-widest font-brand text-red-500">
              {error || "商品が見つかりません"}
            </p>
          </div>
        </div>
      </main>
    );
  }

  const mainImage = item.image_urls && item.image_urls.length > selectedImageIndex 
    ? item.image_urls[selectedImageIndex]
    : item.image_url;

  const thumbnailImages = item.image_urls && item.image_urls.length > 0
    ? item.image_urls
    : [item.image_url];

  return (
    <main className="pt-24 pb-20 px-6 lg:px-12">
      <div className="max-w-7xl mx-auto">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-24">
          <div>
            <div className="aspect-[3/4] bg-[#f5f5f5] mb-4 overflow-hidden">
              {mainImage ? (
                <Image
                  src={mainImage}
                  alt={item.name}
                  width={600}
                  height={800}
                  className="w-full h-full object-cover object-top"
                  priority
                />
              ) : (
                <div className="w-full h-full flex items-center justify-center text-gray-400">
                  No Image
                </div>
              )}
            </div>

            {thumbnailImages.length > 1 && (
              <div className="grid grid-cols-2 gap-4">
                {thumbnailImages.map((imgUrl: string, index: number) => (
                  <div
                    key={index}
                    className={`aspect-[3/4] bg-[#f5f5f5] overflow-hidden cursor-pointer transition-all duration-300 ${
                      selectedImageIndex === index ? "ring-2 ring-black" : ""
                    }`}
                    onClick={() => setSelectedImageIndex(index)}
                  >
                    <Image
                      src={imgUrl}
                      alt={`${item.name} ${index + 1}`}
                      width={300}
                      height={400}
                      className="w-full h-full object-cover object-top"
                    />
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="space-y-8">
            <div>
              <p className="text-xs text-[#474747] tracking-widest mb-2 font-brand">
                {item.category}
              </p>
              <h2 className="text-xl lg:text-2xl text-black mb-4 tracking-tight font-display">
                {item.name}
              </h2>
              <p className="text-xl text-black font-brand">
                ¥{item.price.toLocaleString('ja-JP')}
              </p>
            </div>

            {item.description && (
              <div>
                <p className="text-base text-[#474747] leading-relaxed font-brand">
                  {item.description}
                </p>
              </div>
            )}

            {item.colors && Array.isArray(item.colors) && item.colors.length > 0 && (
              <div>
                <h3 className="text-sm tracking-widest mb-4 font-brand">
                  COLOR
                </h3>
                <div className="flex gap-3 flex-wrap">
                  {(item.colors as unknown as Array<{ hex: string; name: string }>).map((colorOption) => (
                    <Button
                      key={colorOption.name}
                      onClick={() => setColor(colorOption.name)}
                      variant={color === colorOption.name ? 'primary' : 'secondary'}
                      size="sm"
                      className="font-brand"
                    >
                      {colorOption.name}
                    </Button>
                  ))}
                </div>
              </div>
            )}

            {item.sizes && item.sizes.length > 0 && (
              <div>
                <h3 className="text-sm tracking-widest mb-4 font-brand">
                  SIZE
                </h3>
                <div className="flex gap-3 flex-wrap">
                  {item.sizes!.map((sizeOption: string) => (
                    <Button
                      key={sizeOption}
                      onClick={() => setSize(sizeOption)}
                      variant={size === sizeOption ? 'primary' : 'secondary'}
                      size="sm"
                      className="font-brand"
                    >
                      {sizeOption}
                    </Button>
                  ))}
                </div>
              </div>
            )}

            <div>
              <h3 className="text-sm tracking-widest mb-4 font-brand">
                QUANTITY
              </h3>
              <Stepper value={quantity} min={1} onChange={setQuantity}  size="sm"/>
            </div>

            <div className="flex gap-4">
              <Button
                onClick={handleAddToCart}
                disabled={addingToCart}
                size="md"
                className="w-full font-brand"
              >
                {addingToCart ? (
                  "追加中..."
                ) : (
                  <div className="gap-2 flex items-center justify-center">
                    <div className="w-4 h-4 flex items-center justify-center">
                      <i className="ri-shopping-bag-line text-base" />
                    </div>
                    ADD TO CART
                  </div>
                )}
              </Button>
              <Button
                onClick={handleToggleWishlist}
                disabled={togglingWishlist}
                variant="secondary"
                size="sm"
                aria-label="Add to wishlist"
                className="px-4 py-3"
              >
                <div className="w-5 h-5 flex items-center justify-center">
                  <i className={`text-xl ${isWishlisted ? "ri-heart-fill text-red-500" : "ri-heart-line"}`} />
                </div>
              </Button>
            </div>

            {item.product_details && (
              <div className="border-t border-black/10 pt-8">
                <h3 className="text-sm tracking-widest mb-4 font-brand">
                  PRODUCT DETAILS
                </h3>
                {typeof item.product_details === 'string' ? (
                  <p className="text-sm text-[#474747] font-brand whitespace-pre-line">
                    {item.product_details}
                  </p>
                ) : Array.isArray(item.product_details) ? (
                  <ul className="space-y-2">
                    {item.product_details.map((detail: string, idx: number) => (
                      <li key={idx} className="text-sm text-[#474747] font-brand">
                        {detail}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <ul className="space-y-2">
                    {Object.entries(item.product_details!).map(([key, value]: [string, unknown]) => (
                      <li key={key} className="text-sm text-[#474747] font-brand">
                        {String(value)}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}
