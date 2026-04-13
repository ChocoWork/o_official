'use client';

// 同カテゴリの関連商品を最大4件取得して表示するコンポーネント
import { useEffect, useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { Item } from '@/types/item';

type Props = {
  currentItemId: number;
  category: string;
};

export function RelatedItems({ currentItemId, category }: Props) {
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchRelated = async () => {
      try {
        const res = await fetch(
          `/api/items?category=${encodeURIComponent(category)}&pageSize=5`
        );
        if (!res.ok) return;
        const payload = await res.json() as { items?: Item[] } | Item[];
        const allItems: Item[] = Array.isArray(payload) ? payload : (payload.items ?? []);
        // 現在の商品を除いて最大4件
        setItems(allItems.filter((i) => i.id !== currentItemId).slice(0, 4));
      } catch {
        // 関連商品取得失敗は静かに無視する
      } finally {
        setLoading(false);
      }
    };

    fetchRelated();
  }, [currentItemId, category]);

  if (loading || items.length === 0) return null;

  return (
    <section
      data-testid="related-items"
      aria-labelledby="related-items-heading"
      className="mt-16 lg:mt-24 border-t border-black/10 pt-10"
    >
      <h2
        id="related-items-heading"
        className="text-sm tracking-widest mb-8 font-brand"
      >
        YOU MAY ALSO LIKE
      </h2>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 lg:gap-6">
        {items.map((item) => (
          <Link
            key={item.id}
            href={`/item/${item.id}`}
            data-testid="item-card"
            className="group"
          >
            <div className="relative aspect-[3/4] bg-[#f5f5f5] overflow-hidden mb-2">
              {item.image_url ? (
                <Image
                  src={item.image_url}
                  alt={`${item.name} - ${item.category}`}
                  fill
                  className="object-cover object-top transition-transform duration-500 group-hover:scale-105"
                  sizes="(max-width: 640px) 50vw, 25vw"
                />
              ) : (
                <div className="w-full h-full flex items-center justify-center text-gray-400 text-xs">
                  No Image
                </div>
              )}
            </div>
            <p className="text-xs text-[#888] tracking-widest font-brand">{item.category}</p>
            <p className="text-xs md:text-sm text-black tracking-tight font-brand line-clamp-2">
              {item.name}
            </p>
            <p className="text-xs md:text-sm text-black font-brand">
              ¥{item.price.toLocaleString('ja-JP')}
            </p>
          </Link>
        ))}
      </div>
    </section>
  );
}
