'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { ItemForm } from '../../ItemForm';
import { ItemResponse, ItemFormValues } from '../../types';
import { clientFetch } from '@/lib/client-fetch';

export default function AdminItemEditPage() {
  const params = useParams<{ id: string }>();
  const itemId = params?.id;

  const [initialValues, setInitialValues] = useState<ItemFormValues | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);

  useEffect(() => {
    if (!itemId) {
      setFetchError('商品IDの取得に失敗しました');
      setIsLoading(false);
      return;
    }

    const fetchItem = async () => {
      try {
        const response = await clientFetch(`/api/admin/items/${itemId}`);
        const json = await response.json().catch(() => null);
        if (!response.ok) {
          setFetchError(json?.error ?? '商品の取得に失敗しました');
          return;
        }

        const item = (json?.data ?? null) as ItemResponse | null;
        if (!item) {
          setFetchError('商品の取得に失敗しました');
          return;
        }

        const existingImages =
          (item.image_urls && item.image_urls.length > 0
            ? item.image_urls
            : [item.image_url]).filter(Boolean);

        const values: ItemFormValues = {
          name: item.name,
          description: item.description,
          price: item.price,
          category: item.category,
          colors: item.colors ?? [],
          sizes: item.sizes ?? [],
          productDetails: item.product_details ?? '',
          status: item.status,
          previewUrls: existingImages,
        };

        setInitialValues(values);
      } catch (err) {
        console.error('Failed to fetch item:', err);
        setFetchError('商品の取得に失敗しました');
      } finally {
        setIsLoading(false);
      }
    };

    fetchItem();
  }, [itemId]);

  if (isLoading) {
    return (
      <main className="pt-32 pb-20">
        <div className="max-w-4xl mx-auto px-6 lg:px-12 text-center">読み込み中...</div>
      </main>
    );
  }

  if (fetchError) {
    return (
      <main className="pt-32 pb-20">
        <div className="max-w-4xl mx-auto px-6 lg:px-12 text-center text-red-600">
          {fetchError}
        </div>
      </main>
    );
  }

  if (!initialValues) {
    return null;
  }

  return (
    <ItemForm
      submitUrl={`/api/admin/items/${itemId}`}
      submitMethod="PUT"
      initialValues={initialValues}
    />
  );
}
