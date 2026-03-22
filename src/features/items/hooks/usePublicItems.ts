'use client';

import { useEffect, useState } from 'react';
import { Item } from '@/app/types/item';

type UsePublicItemsOptions = {
  limit?: number;
  enabled?: boolean;
};

export function usePublicItems(options?: UsePublicItemsOptions) {
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (options?.enabled === false) {
      return;
    }

    const fetchItems = async () => {
      try {
        const query =
          typeof options?.limit === 'number' && Number.isFinite(options.limit) && options.limit > 0
            ? `?limit=${Math.floor(options.limit)}`
            : '';

        const response = await fetch(`/api/items${query}`, { cache: 'no-store' });
        if (!response.ok) {
          throw new Error('Failed to fetch items');
        }

        const data: Item[] = await response.json();
        setItems(data);
        setError(null);
      } catch (fetchError) {
        setItems([]);
        setError('商品データの取得に失敗しました');
        console.error('Failed to fetch items:', fetchError);
      } finally {
        setLoading(false);
      }
    };

    setLoading(true);
    fetchItems();
  }, [options?.limit, options?.enabled]);

  return {
    items,
    loading,
    error,
  };
}
