'use client';

import Link from "next/link";
import Image from "next/image";
import { useEffect, useState } from "react";
import { Item } from "@/app/types/item";
import { LinkButton } from '@/app/components/ui/LinkButton';

export default function HomeItemsSection() {
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchItems = async () => {
      try {
        const response = await fetch("/api/items");
        if (!response.ok) {
          throw new Error("Failed to fetch items");
        }
        const data: Item[] = await response.json();
        setItems(data);
      } catch (err) {
        setError("商品データの取得に失敗しました");
        console.error("Failed to fetch items:", err);
      } finally {
        setLoading(false);
      }
    };

    fetchItems();
  }, []);

  if (loading) {
    return (
      <section className="py-24 lg:py-32 px-6 lg:px-12 bg-white w-full">
        <div className="max-w-7xl mx-auto text-center">
          <div className="text-xl">商品データを読み込み中...</div>
        </div>
      </section>
    );
  }

  if (error) {
    return (
      <section className="py-24 lg:py-32 px-6 lg:px-12 bg-white w-full">
        <div className="max-w-7xl mx-auto text-center">
          <div className="text-xl text-red-500">{error}</div>
        </div>
      </section>
    );
  }

  const displayItems = items.slice(0, 6);

  return (
    <section className="py-24 lg:py-32 px-6 lg:px-12 bg-white w-full">
      <div className="max-w-7xl mx-auto">
        <div className="text-center mb-16 lg:mb-24">
          <h2
            className="text-4xl lg:text-5xl mb-4 text-black tracking-tight"
            style={{ fontFamily: "Didot, serif" }}
          >
            ITEMS
          </h2>
          <div className="w-16 h-px bg-black mx-auto"></div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-12">
          {displayItems.map((item) => (
            <Link key={item.id} href={`/item/${item.id}`}>
              <div className="group cursor-pointer">
                <div className="aspect-[3/4] bg-[#f5f5f5] mb-4 overflow-hidden">
                  {item.image_url ? (
                    <Image
                      src={item.image_url}
                      alt={item.name}
                      width={600}
                      height={800}
                      className="w-full h-full object-cover object-top group-hover:scale-105 transition-transform duration-500"
                      priority={false}
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-gray-400">
                      No Image
                    </div>
                  )}
                </div>
                <div className="space-y-2">
                  <p className="text-xs text-[#474747] tracking-widest font-brand">{item.category}</p>
                  <h3 className="text-base text-black tracking-tight font-brand">{item.name}</h3>
                  <p className="text-sm text-black font-brand">¥{item.price.toLocaleString('ja-JP')}</p>
                </div>
              </div>
            </Link>
          ))}
        </div>
        <div className="text-center mt-16">
          <LinkButton href="/item" size="lg" className="font-acumin">VIEW ALL ITEMS</LinkButton>
        </div>
      </div>
    </section>
  );
}
