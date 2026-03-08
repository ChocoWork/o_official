'use client'

import { useEffect, useState } from 'react';
import { TabSegmentControl } from '@/app/components/ui/TabSegmentControl';
import { usePublicItems } from '@/features/items/hooks/usePublicItems';
import { PublicItemGrid } from '@/features/items/components/PublicItemGrid';

export default function ItemPage() {
  const { items, loading, error } = usePublicItems();
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);

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
            <TabSegmentControl
              items={categories.map((category) => ({ key: category, label: category }))}
              activeKey={selectedCategory ?? 'ALL'}
              onChange={(category) => setSelectedCategory(category === 'ALL' ? null : category)}
              variant="segment-pill"
             size="md"/>
          </div>
        </div>

        <PublicItemGrid
          items={displayItems}
          className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-8"
        />

        {displayItems.length === 0 && (
          <div className="text-center py-12">
            <p className="text-base tracking-widest font-brand text-gray-500">商品が見つかりません</p>
          </div>
        )}
      </div>
    </main>
  );
}
