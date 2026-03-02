'use client'

import { useRouter, useSearchParams } from 'next/navigation';
import { TabSegmentControl } from '@/app/components/ui/TabSegmentControl';
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
      />
    </div>
  );
}
