'use client'

import { useEffect, useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { Item } from '@/app/types/item';

export default function ItemPage() {
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);

  useEffect(() => {
    const fetchItems = async () => {
      try {
        const response = await fetch('/api/items');
        if (!response.ok) {
          throw new Error('Failed to fetch items');
        }
        const data: Item[] = await response.json();
        setItems(data);
      } catch (err) {
        setError('商品データの取得に失敗しました');
        console.error('Failed to fetch items:', err);
      } finally {
        setLoading(false);
      }
    };

    fetchItems();
  }, []);

  // デバッグ情報をコンソールに出力
  useEffect(() => {
    console.log('ItemPage State:', { items, loading, error, itemsCount: items.length });
  }, [items, loading, error]);

  if (loading) {
    return (
      <main className="pt-32 pb-20 px-6 lg:px-12">
        <div className="max-w-7xl mx-auto text-center">
          <div className="text-base tracking-widest font-brand">読み込み中...</div>
        </div>
      </main>
    );
  }

  if (error) {
    return (
      <main className="pt-32 pb-20 px-6 lg:px-12">
        <div className="max-w-7xl mx-auto text-center">
          <div className="text-base tracking-widest font-brand text-red-500">{error}</div>
          <div className="text-xs text-gray-500 mt-2">{error}</div>
        </div>
      </main>
    );
  }

  const categories = ['ALL', 'TOPS', 'BOTTOMS', 'OUTERWEAR', 'ACCESSORIES'] as const;
  const displayItems = selectedCategory && selectedCategory !== 'ALL' 
    ? items.filter(item => item.category === selectedCategory)
    : items;

  return (
    <main className="pt-32 pb-20 px-6 lg:px-12">
      <div className="max-w-7xl mx-auto">
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-12 gap-6">
          <div className="flex flex-wrap gap-3">
            {categories.map((category) => (
              <button
                key={category}
                onClick={() => setSelectedCategory(category === 'ALL' ? null : category)}
                className={`px-6 py-2 text-xs tracking-widest transition-all duration-300 cursor-pointer whitespace-nowrap font-brand ${
                  (category === 'ALL' && selectedCategory === null) || selectedCategory === category
                    ? 'bg-black text-white'
                    : 'border border-black text-black hover:bg-black hover:text-white'
                }`}
              >
                {category}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-8">
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

        {displayItems.length === 0 && (
          <div className="text-center py-12">
            <p className="text-base tracking-widest font-brand text-gray-500">商品が見つかりません</p>
          </div>
        )}
      </div>
    </main>
  );
}
