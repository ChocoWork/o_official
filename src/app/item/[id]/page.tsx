"use client";

import React, { useState, useEffect, use } from "react";
import Image from "next/image";
import { Item } from "@/app/types/item";

export default function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [item, setItem] = useState<Item | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [color, setColor] = useState<string>("");
  const [size, setSize] = useState<string | null>(null);
  const [quantity, setQuantity] = useState<number>(1);
  const [selectedImageIndex, setSelectedImageIndex] = useState(0);

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
            <a
              href="#"
              onClick={(e) => {
                e.preventDefault();
                history.back();
              }}
              className="text-sm text-[#474747] hover:text-black transition-colors duration-300 flex items-center gap-2 font-brand"
            >
              <i className="ri-arrow-left-line" />BACK TO ITEMS
            </a>
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
    <main className="pt-32 pb-20 px-6 lg:px-12">
      <div className="max-w-7xl mx-auto">
        <div className="mb-8">
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault();
              history.back();
            }}
            className="text-sm text-[#474747] hover:text-black transition-colors duration-300 flex items-center gap-2 font-brand"
          >
            <i className="ri-arrow-left-line" />BACK TO ITEMS
          </a>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-12">
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
              <h1 className="text-3xl lg:text-4xl text-black mb-4 tracking-tight font-display">
                {item.name}
              </h1>
              <p className="text-2xl text-black font-brand">
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
                    <button
                      key={colorOption.name}
                      onClick={() => setColor(colorOption.name)}
                      className={`px-6 py-2 text-xs tracking-widest transition-all duration-300 cursor-pointer whitespace-nowrap border border-black text-black hover:bg-black hover:text-white font-brand ${
                        color === colorOption.name ? "bg-black text-white" : ""
                      }`}
                    >
                      {colorOption.name}
                    </button>
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
                    <button
                      key={sizeOption}
                      onClick={() => setSize(sizeOption)}
                      className={`w-16 h-12 text-sm tracking-widest transition-all duration-300 cursor-pointer border border-black text-black hover:bg-black hover:text-white font-brand ${
                        size === sizeOption ? "bg-black text-white" : ""
                      }`}
                    >
                      {sizeOption}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div>
              <h3 className="text-sm tracking-widest mb-4 font-brand">
                QUANTITY
              </h3>
              <div className="flex items-center gap-4">
                <button
                  onClick={() => setQuantity((q) => Math.max(1, q - 1))}
                  className="w-10 h-10 border border-black flex items-center justify-center hover:bg-black hover:text-white transition-all duration-300 cursor-pointer"
                >
                  <i className="ri-subtract-line" />
                </button>
                <span className="text-lg w-12 text-center font-brand">
                  {quantity}
                </span>
                <button
                  onClick={() => setQuantity((q) => q + 1)}
                  className="w-10 h-10 border border-black flex items-center justify-center hover:bg-black hover:text-white transition-all duration-300 cursor-pointer"
                >
                  <i className="ri-add-line" />
                </button>
              </div>
            </div>

            <button
              onClick={(e) => e.preventDefault()}
              className="w-full py-4 bg-black text-white text-sm tracking-widest hover:bg-[#474747] transition-all duration-300 cursor-pointer whitespace-nowrap font-brand"
            >
              ADD TO CART
            </button>

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
