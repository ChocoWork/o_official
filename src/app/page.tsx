'use client';

import Link from 'next/link';
import Image from "next/image";
import { useEffect, useState } from 'react';
import { Item } from '@/app/types/item';

export default function Home() {
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-xl">商品データを読み込み中...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-xl text-red-500">{error}</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen pb-20 font-sans">
      <main className="flex flex-col items-center gap-8">
        {/* メイン画像 */}
        <div className="w-full max-w-screen">
          <Image
            src="/top_photo2.jpg"
            alt="main photo"
            width={6048}
            height={4024}
            className="w-full h-auto object-contain"
            priority
          />
        </div>

        {/* New Item セクション */}
        <h2 className="text-2xl mt-25 mb-5">New Item</h2>

        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4 w-full px-4">
          {items.slice(0, 8).map((item) => (
            <div key={item.id} className="flex flex-col items-start group">
              <div className="w-full aspect-[3/4] relative overflow-hidden">
                <Image
                  src={item.image_url || "/placeholder.png"}
                  alt={item.name}
                  fill
                  className="object-cover transition-transform duration-300 group-hover:scale-105"
                />
              </div>
              <h3 className="text-lg font-semibold mt-2">{item.name}</h3>
              <p className="text-gray-600">¥{item.price.toLocaleString()}</p>
            </div>
          ))}
        </div>

        {/* VIEW ALLボタン */}
        <Link href="/item">
          <button className="px-20 py-1 border hover:bg-black hover:text-white transition-colors">
            VIEW ALL
          </button>
        </Link>

        {/* LOOK セクション */}
        <h2 className="text-2xl mt-25 mb-5">LOOK</h2>

        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-4 2xl:grid-cols-5 gap-1 w-full px-4">
          {items.slice(0, 5).map((item) => (
            <div key={`look-${item.id}`} className="flex flex-col items-start group">
              <div className="w-full aspect-[3/4] relative overflow-hidden">
                <Image
                  src={item.image_url || "/placeholder.png"}
                  alt={item.name}
                  fill
                  className="object-cover transition-transform duration-300 group-hover:scale-105"
                />
              </div>
            </div>
          ))}
        </div>

        {/* VIEW ALLボタン */}
        <Link href="/look">
          <button className="px-20 py-1 border hover:bg-black hover:text-white transition-colors">
            VIEW ALL
          </button>
        </Link>
      </main>
    </div>
  );
}