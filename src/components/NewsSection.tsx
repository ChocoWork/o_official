'use client';

import Image from 'next/image';
import { useEffect, useState } from 'react';
import { clientFetch } from '@/lib/client-fetch';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { TagLabel } from '@/components/ui/TagLabel';

type NewsArticle = {
  id: string;
  title: string;
  published_date: string;
  category: string;
  status: 'private' | 'published';
  image_url: string;
  content: string;
  detailed_content: string;
};

export default function NewsSection() {
  const [newsItems, setNewsItems] = useState<NewsArticle[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchNews = async () => {
    try {
      const res = await clientFetch('/api/admin/news');
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        console.error(`Failed to fetch news: ${res.status} ${res.statusText}`, errorData);
        throw new Error(`Failed to fetch news: ${res.status} ${res.statusText}`);
      }
      const json = await res.json();
      setNewsItems(json.data || []);
    } catch (error) {
      console.error('Failed to load news:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchNews();
  }, []);

  const handleToggleStatus = async (id: string, currentStatus: 'private' | 'published') => {
    const newStatus = currentStatus === 'published' ? 'private' : 'published';
    
    try {
      const res = await clientFetch(`/api/admin/news/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      });

      if (!res.ok) throw new Error('Failed to update status');
      
      // リストを再読み込み
      await fetchNews();
    } catch (error) {
      console.error('Failed to toggle status:', error);
      alert('ステータスの更新に失敗しました');
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('この記事を削除してもよろしいですか？')) {
      return;
    }

    try {
      const res = await clientFetch(`/api/admin/news/${id}`, {
        method: 'DELETE',
      });

      if (!res.ok) throw new Error('Failed to delete article');
      
      // リストを再読み込み
      await fetchNews();
    } catch (error) {
      console.error('Failed to delete article:', error);
      alert('記事の削除に失敗しました');
    }
  };

  if (loading) {
    return <div className="text-center py-12 font-acumin">読み込み中...</div>;
  }

  if (newsItems.length === 0) {
    return <div className="text-center py-12 text-[#474747] font-acumin">ニュース記事がありません</div>;
  }

  return (
    <div>
      <div className="space-y-4">
        {newsItems.map((item) => (
          <Card key={item.id} className="flex items-center justify-between" size="md">
            <div className="flex items-center space-x-6 flex-1">
              <Image
                src={item.image_url}
                alt={item.title}
                width={96}
                height={96}
                className="w-24 h-24 object-cover bg-[#f5f5f5]"
              />
              <div className="flex-1">
                <div className="flex items-center space-x-3 mb-2">
                  <StatusBadge tone={item.status === 'published' ? 'positive' : 'neutral'} size="md">
                    {item.status === 'published' ? '公開中' : '非公開'}
                  </StatusBadge>
                  <TagLabel variant="outline" size="sm" className="font-acumin tracking-widest">
                    {item.category}
                  </TagLabel>
                </div>
                <h4 className="text-lg text-black mb-2 font-acumin">{item.title}</h4>
                <p className="text-sm text-[#474747] font-acumin">{item.published_date}</p>
              </div>
            </div>
            <div className="flex items-center space-x-3">
              <Button
                onClick={() => handleToggleStatus(item.id, item.status)}
                variant="secondary"
                size="sm"
                className="font-acumin"
              >
                {item.status === 'published' ? '非公開' : '公開'}
              </Button>
              <Button
                href={`/admin/news/edit/${item.id}`}
                variant="secondary"
                size="sm"
                className="font-acumin"
              >
                編集
              </Button>
              <Button
                onClick={() => handleDelete(item.id)}
                variant="primary"
                size="sm"
                className="font-acumin"
              >
                削除
              </Button>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
