/**
 * 管理画面の NEWS タブで記事を一覧し、公開の切り替えと削除を行う部品（src/components/NewsSection.tsx）。
 *
 * @packageDocumentation
 * @impl IMPL-NEWS-141
 * @design DD-NEWS-060
 * @remarks 部品では権限を確かめない。描くかどうかは親の管理画面が店長の役で決め、守りは窓口の認可と DB の RLS に置くため。
 * 切り替えと削除の後は表示を先に変えず一覧を読み直し、窓口が保存した状態だけを見せる。
 * 消した記事は戻せないので、削除は送る前に確かめのダイアログを挟む。
 * 一覧の取得に失敗した時は「記事が無い」と見せず、失敗の文と再読み込みのボタンを出す。切り替えの後の読み直しに失敗した時は、前の一覧の上に同じ文を出す（SEC-NEWS-020）。
 * 画像の署名ができない記事は image_url が null で届く。next/image は空の src で落ちるので、その行だけ /placeholder.png を出して一覧を壊さない。
 */
'use client';

import Image from 'next/image';
import { useEffect, useState } from 'react';
import { clientFetch } from '@/lib/client-fetch';
import { Button } from '@/components/ui/Button/Button';
import { Card } from '@/components/ui/Card/Card';
import { StatusBadge } from '@/components/ui/StatusBadge/StatusBadge';
import { TagLabel } from '@/components/ui/TagLabel/TagLabel';

type NewsArticle = {
  id: string;
  title: string;
  published_date: string;
  category: string;
  status: 'private' | 'published';
  /** 署名できない画像は null（元の値を返さない）。一覧は /placeholder.png を出す */
  image_url: string | null;
  content: string;
  detailed_content: string;
};

export default function NewsSection() {
  const [newsItems, setNewsItems] = useState<NewsArticle[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);

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
      setLoadFailed(false);
    } catch (error) {
      console.error('Failed to load news:', error);
      setLoadFailed(true);
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

  const loadFailureNotice = loadFailed ? (
    <div role="alert" className="text-center py-12 font-acumin">
      <p className="text-red-600 mb-4">ニュース記事の取得に失敗しました</p>
      <Button
        onClick={() => {
          setLoading(true);
          void fetchNews();
        }}
        variant="secondary"
        size="sm"
        className="font-acumin"
      >
        再読み込み
      </Button>
    </div>
  ) : null;

  if (loadFailed && newsItems.length === 0) {
    return loadFailureNotice;
  }

  if (newsItems.length === 0) {
    return <div className="text-center py-12 text-[#474747] font-acumin">ニュース記事がありません</div>;
  }

  return (
    <div>
      {loadFailureNotice}
      <div className="space-y-4">
        {newsItems.map((item) => (
          <Card key={item.id} className="flex items-center justify-between" size="md">
            <div className="flex items-center space-x-6 flex-1">
              <Image
                src={item.image_url || '/placeholder.png'}
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
                <h4 className="lk-text-2xl text-black mb-2 font-acumin">{item.title}</h4>
                <p className="lk-text-sm text-[#474747] font-acumin">{item.published_date}</p>
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
