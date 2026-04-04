'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { StockistForm } from '../../StockistForm';
import { StockistFormValues, StockistResponse } from '../../types';
import { clientFetch } from '@/lib/client-fetch';

export default function AdminStockistEditPage() {
  const params = useParams<{ id: string }>();
  const stockistId = params?.id;

  const [initialValues, setInitialValues] = useState<StockistFormValues | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);

  useEffect(() => {
    if (!stockistId) {
      setFetchError('STOCKIST IDの取得に失敗しました');
      setIsLoading(false);
      return;
    }

    const fetchStockist = async () => {
      try {
        const response = await clientFetch(`/api/admin/stockists/${stockistId}`);
        const json = await response.json().catch(() => null);
        if (!response.ok) {
          setFetchError(json?.error ?? 'STOCKISTの取得に失敗しました');
          return;
        }

        const stockist = (json?.data ?? null) as StockistResponse | null;
        if (!stockist) {
          setFetchError('STOCKISTの取得に失敗しました');
          return;
        }

        setInitialValues({
          type: stockist.type,
          name: stockist.name,
          address: stockist.address,
          phone: stockist.phone,
          time: stockist.time,
          holiday: stockist.holiday,
          status: stockist.status,
        });
      } catch (error) {
        console.error('Failed to fetch stockist:', error);
        setFetchError('STOCKISTの取得に失敗しました');
      } finally {
        setIsLoading(false);
      }
    };

    void fetchStockist();
  }, [stockistId]);

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
        <div className="max-w-4xl mx-auto px-6 lg:px-12 text-center text-red-600">{fetchError}</div>
      </main>
    );
  }

  if (!initialValues) {
    return null;
  }

  return (
    <StockistForm
      submitUrl={`/api/admin/stockists/${stockistId}`}
      submitMethod="PUT"
      initialValues={initialValues}
    />
  );
}
