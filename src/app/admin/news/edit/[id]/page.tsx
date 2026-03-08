'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import type { NewsFormData } from '@/types/news';
import { clientFetch } from '@/lib/client-fetch';
import { NewsForm } from '../../NewsForm';

type NewsArticle = {
  id: string;
  title: string;
  category: string;
  published_date: string;
  image_url: string;
  content: string;
  detailed_content: string;
  status: 'private' | 'published';
};

export default function EditNewsPage() {
  const params = useParams<{ id: string }>();
  const articleId = params?.id;

  const [isLoading, setIsLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [initialValues, setInitialValues] = useState<NewsFormData | null>(null);
  const [existingImageUrl, setExistingImageUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!articleId) {
      setFetchError('記事IDの取得に失敗しました');
      setIsLoading(false);
      return;
    }

    const fetchArticle = async () => {
      try {
        const res = await clientFetch(`/api/admin/news/${articleId}`);
        const json = await res.json().catch(() => null);
        if (!res.ok) {
          setFetchError(json?.error ?? '記事の読み込みに失敗しました');
          return;
        }

        const article: NewsArticle = json.data;

        setInitialValues({
          title: article.title,
          category: article.category as NewsFormData['category'],
          date: article.published_date,
          content: article.content,
          detailedContent: article.detailed_content,
          status: article.status,
        });

        setExistingImageUrl(article.image_url);
      } catch (error) {
        console.error('Failed to load article:', error);
        setFetchError('記事の読み込みに失敗しました');
      } finally {
        setIsLoading(false);
      }
    };

    fetchArticle();
  }, [articleId]);

  if (isLoading) {
    return (
      <main className="pt-32 pb-20">
        <div className="max-w-4xl mx-auto px-6 lg:px-12 text-center font-acumin">
          読み込み中...
        </div>
      </main>
    );
  }

  if (fetchError) {
    return (
      <main className="pt-32 pb-20">
        <div className="max-w-4xl mx-auto px-6 lg:px-12 text-center text-red-600 font-acumin">
          {fetchError}
        </div>
      </main>
    );
  }

  if (!initialValues || !articleId) {
    return null;
  }

  return (
    <NewsForm
      submitUrl={`/api/admin/news/${articleId}`}
      submitMethod="PUT"
      initialValues={initialValues}
      existingImageUrl={existingImageUrl}
    />
  );
}
