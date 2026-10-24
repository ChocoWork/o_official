/**
 * ニュースの分類を1つだけ選ぶタブ（src/app/news/NewsCategoryTabs.tsx）。
 *
 * @packageDocumentation
 * @impl IMPL-NEWS-104
 * @design DD-NEWS-005
 * @remarks 一覧の分類は ITEM・LOOK にそろえた複数選択に置き換わり、どこからも使われない。消すかどうかをユーザーが決めるまで、勝手に消して決定を先取りしないため、範囲内の単位として動きを残す（ARC-NEWS-005）。
 */
'use client'

import { useRouter, useSearchParams } from 'next/navigation';
import { TabSegmentControl } from '@/components/ui/TabSegmentControl/TabSegmentControl';
import { categories } from '@/lib/news-data';

export interface NewsCategoryTabsProps {
  activeCategory: (typeof categories)[number];
}

export function NewsCategoryTabs({ activeCategory }: NewsCategoryTabsProps) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const items = categories.map((c) => ({ key: c, label: c }));

  const handleChange = (key: string) => {
    const params = new URLSearchParams(searchParams.toString());

    if (key === 'ALL') {
      params.delete('category');
    } else {
      params.set('category', key);
    }

    const query = params.toString();
    const href = query ? `/news?${query}` : '/news';
    router.push(href);
  };

  return (
    <div className="flex items-center justify-center space-x-6 mb-16">
      <TabSegmentControl
        items={items}
        activeKey={activeCategory}
        onChange={handleChange}
        variant="segment-pill"
       size="md"/>
    </div>
  );
}
