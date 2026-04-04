'use client';

import { useEffect, useState } from 'react';
import { clientFetch } from '@/lib/client-fetch';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { TagLabel } from '@/components/ui/TagLabel';
import { StockistType } from '@/features/stockist/types';

type AdminStockist = {
  id: number;
  type: StockistType;
  name: string;
  address: string;
  phone: string;
  time: string;
  holiday: string;
  status: 'private' | 'published';
};

export default function StockistSection() {
  const [stockists, setStockists] = useState<AdminStockist[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchStockists = async () => {
    try {
      const res = await clientFetch('/api/admin/stockists');
      if (!res.ok) {
        throw new Error('Failed to fetch stockists');
      }

      const json = await res.json();
      setStockists((json.data ?? []) as AdminStockist[]);
    } catch (error) {
      console.error('Failed to load stockists:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void fetchStockists();
  }, []);

  const handleToggleStatus = async (id: number, currentStatus: 'private' | 'published') => {
    const nextStatus = currentStatus === 'published' ? 'private' : 'published';

    try {
      const res = await clientFetch(`/api/admin/stockists/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: nextStatus }),
      });

      if (!res.ok) {
        throw new Error('Failed to update status');
      }

      await fetchStockists();
    } catch (error) {
      console.error('Failed to toggle stockist status:', error);
      alert('ステータスの更新に失敗しました');
    }
  };

  const handleDelete = async (id: number) => {
    if (!confirm('このSTOCKISTを削除してもよろしいですか？')) {
      return;
    }

    try {
      const res = await clientFetch(`/api/admin/stockists/${id}`, {
        method: 'DELETE',
      });

      if (!res.ok) {
        throw new Error('Failed to delete stockist');
      }

      await fetchStockists();
    } catch (error) {
      console.error('Failed to delete stockist:', error);
      alert('STOCKISTの削除に失敗しました');
    }
  };

  if (loading) {
    return <div className="py-12 text-center font-acumin">読み込み中...</div>;
  }

  if (stockists.length === 0) {
    return <div className="py-12 text-center text-[#474747] font-acumin">STOCKISTがありません</div>;
  }

  return (
    <section>
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-8 lg:gap-12">
        {stockists.map((stockist) => (
          <Card key={stockist.id} className="border-black/10 p-8 hover:border-black transition-colors duration-300" size="md">
            <div className="space-y-2">
              <div className="mb-4">
                <TagLabel className="inline-block mb-4 font-brand" size="md">{stockist.type}</TagLabel>
                <h2 className="text-2xl text-black mb-6 font-display">{stockist.name}</h2>
              </div>
              <div className="space-y-3">
                <div className="flex items-start">
                  <div className="w-6 h-6 flex items-center justify-center flex-shrink-0 mr-3"><i className="ri-map-pin-line text-lg text-black" /></div>
                  <p className="text-sm text-[#474747] font-brand">{stockist.address}</p>
                </div>
                <div className="flex items-center">
                  <div className="w-6 h-6 flex items-center justify-center flex-shrink-0 mr-3"><i className="ri-phone-line text-lg text-black" /></div>
                  <p className="text-sm text-[#474747] font-brand">{stockist.phone}</p>
                </div>
                <div className="flex items-center">
                  <div className="w-6 h-6 flex items-center justify-center flex-shrink-0 mr-3"><i className="ri-time-line text-lg text-black" /></div>
                  <p className="text-sm text-[#474747] font-brand">{stockist.time}</p>
                </div>
                <div className="flex items-center">
                  <div className="w-6 h-6 flex items-center justify-center flex-shrink-0 mr-3"><i className="ri-calendar-line text-lg text-black" /></div>
                  <p className="text-sm text-[#474747] font-brand">{stockist.holiday}</p>
                </div>
              </div>
            </div>

            <div className="mt-8 border-t border-black/10 pt-4">
              <div className="mb-3">
                <TagLabel variant={stockist.status === 'published' ? 'solid' : 'outline'} size="sm">
                  {stockist.status === 'published' ? '公開中' : '非公開'}
                </TagLabel>
              </div>
              <div className="flex space-x-2">
              <Button
                onClick={() => handleToggleStatus(stockist.id, stockist.status)}
                variant="secondary"
                size="sm"
                className="flex-1 font-acumin"
              >
                {stockist.status === 'published' ? '非公開' : '公開'}
              </Button>
              <Button
                href={`/admin/stockist/edit/${stockist.id}`}
                variant="secondary"
                size="sm"
                className="flex-1 font-acumin"
              >
                編集
              </Button>
              <Button
                onClick={() => handleDelete(stockist.id)}
                variant="primary"
                size="sm"
                className="font-acumin"
              >
                削除
              </Button>
            </div>
            </div>
          </Card>
        ))}
      </div>
    </section>
  );
}
