'use client';

import Link from 'next/link';
import Image from 'next/image';
import { useEffect, useState } from 'react';

interface AdminItem {
  id: number;
  name: string;
  category: string;
  price: number;
  image_url: string;
  status: 'private' | 'published';
}

interface ItemCardProps {
  item: AdminItem;
  onToggleStatus: (id: number, currentStatus: 'private' | 'published') => void;
  onDelete: (id: number) => void;
}

function ItemCard({ item, onToggleStatus, onDelete }: ItemCardProps) {
  const priceLabel = `¥${item.price.toLocaleString()}`;

  return (
    <div className="border border-[#d5d0c9] overflow-hidden">
      <Image
        alt={item.name}
        className="w-full aspect-[3/4] object-cover bg-[#f5f5f5]"
        src={item.image_url || '/placeholder.png'}
        width={300}
        height={400}
        unoptimized
      />
      <div className="p-4 space-y-3">
        <div className="flex items-center space-x-2">
          <span
            className={`px-3 py-1 text-xs tracking-widest font-acumin ${
              item.status === 'published' ? 'bg-black text-white' : 'border border-black text-black'
            }`}
          >
            {item.status === 'published' ? '公開中' : '非公開'}
          </span>
          <span className="text-xs text-[#474747] tracking-widest font-acumin">
            {item.category}
          </span>
        </div>
        <h4 className="text-base text-black font-acumin">{item.name}</h4>
        <p className="text-sm text-black font-acumin">{priceLabel}</p>
        <div className="flex space-x-2 pt-2">
          <button
            onClick={() => onToggleStatus(item.id, item.status)}
            className="flex-1 px-4 py-2 border border-black text-black text-xs tracking-widest hover:bg-black hover:text-white transition-all cursor-pointer whitespace-nowrap font-acumin"
          >
            {item.status === 'published' ? '非公開' : '公開'}
          </button>
          <Link className="flex-1" href={`/admin/item/edit/${item.id}`}>
            <button className="w-full px-4 py-2 border border-black text-black text-xs tracking-widest hover:bg-black hover:text-white transition-all cursor-pointer whitespace-nowrap font-acumin">
              編集
            </button>
          </Link>
          <button
            onClick={() => onDelete(item.id)}
            className="px-4 py-2 bg-black text-white text-xs tracking-widest hover:bg-[#474747] transition-all cursor-pointer whitespace-nowrap font-acumin"
          >
            削除
          </button>
        </div>
      </div>
    </div>
  );
}

export default function ItemSection() {
  const [items, setItems] = useState<AdminItem[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchItems = async () => {
    try {
      const res = await fetch('/api/admin/items');
      if (!res.ok) {
        throw new Error('Failed to fetch items');
      }

      const json = await res.json();
      setItems(json.data || []);
    } catch (error) {
      console.error('Failed to load items:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchItems();
  }, []);

  const handleToggleStatus = async (id: number, currentStatus: 'private' | 'published') => {
    const nextStatus = currentStatus === 'published' ? 'private' : 'published';

    try {
      const res = await fetch(`/api/admin/items/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: nextStatus }),
      });

      if (!res.ok) {
        throw new Error('Failed to update status');
      }

      await fetchItems();
    } catch (error) {
      console.error('Failed to toggle item status:', error);
      alert('ステータスの更新に失敗しました');
    }
  };

  const handleDelete = async (id: number) => {
    if (!confirm('この商品を削除してもよろしいですか？')) {
      return;
    }

    try {
      const res = await fetch(`/api/admin/items/${id}`, {
        method: 'DELETE',
      });

      if (!res.ok) {
        throw new Error('Failed to delete item');
      }

      await fetchItems();
    } catch (error) {
      console.error('Failed to delete item:', error);
      alert('商品の削除に失敗しました');
    }
  };

  if (loading) {
    return <div className="text-center py-12 font-acumin">読み込み中...</div>;
  }

  if (items.length === 0) {
    return <div className="text-center py-12 text-[#474747] font-acumin">商品がありません</div>;
  }

  return (
    <div>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {items.map((item) => (
          <ItemCard key={item.id} item={item} onToggleStatus={handleToggleStatus} onDelete={handleDelete} />
        ))}
      </div>
    </div>
  );
}