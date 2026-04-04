'use client';

import { useEffect, useState } from 'react';
import { clientFetch } from '@/lib/client-fetch';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { StatusBadge } from '@/components/ui/StatusBadge';

type AdminStockist = {
  id: number;
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
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
        {stockists.map((stockist) => (
          <Card
            key={stockist.id}
            className={`border-black/10 p-5 sm:p-6 xl:p-7 hover:border-black transition-colors duration-300 ${stockist.status === 'published' ? 'bg-[#f7fff1]' : 'bg-[#fafafa]'}`}
            size="sm"
          >
            {/* Identity: name + StatusBadge */}
            <div className="mb-3 sm:mb-4 xl:mb-5 flex items-start justify-between gap-3">
              <h2 className="text-sm sm:text-base xl:text-lg text-black font-display leading-snug">{stockist.name}</h2>
              <StatusBadge tone={stockist.status === 'published' ? 'positive' : 'warning'} size="md" className="flex-shrink-0">
                {stockist.status === 'published' ? '公開中' : '非公開'}
              </StatusBadge>
            </div>
            {/* Divider */}
            <div className="border-t border-black/10 mb-3 sm:mb-4 xl:mb-5" />
            {/* Detail rows */}
            <div className="flex flex-col gap-1.5 sm:gap-2 xl:gap-2.5">
              <div className="flex items-start gap-2">
                <i className="ri-map-pin-line text-xs sm:text-sm text-black flex-shrink-0 mt-[3px]" />
                <p className="text-xs sm:text-sm text-[#474747] font-brand leading-relaxed">{stockist.address}</p>
              </div>
              <div className="flex items-center gap-2">
                <i className="ri-phone-line text-xs sm:text-sm text-black flex-shrink-0" />
                <p className="text-xs sm:text-sm text-[#474747] font-brand">{stockist.phone}</p>
              </div>
              <div className="flex items-center gap-2">
                <i className="ri-time-line text-xs sm:text-sm text-black flex-shrink-0" />
                <p className="text-xs sm:text-sm text-[#474747] font-brand">{stockist.time}</p>
              </div>
              <div className="flex items-center gap-2">
                <i className="ri-calendar-line text-xs sm:text-sm text-black flex-shrink-0" />
                <p className="text-xs sm:text-sm text-[#474747] font-brand">{stockist.holiday}</p>
              </div>
            </div>

            <div className="mt-8 border-t border-black/10 pt-4">
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
