'use client';

import { useEffect, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Image from 'next/image';
import { Button } from '@/app/components/ui/Button';
import { RadioButtonGroup } from '@/app/components/ui/RadioButtonGroup';
import { SingleSelect } from '@/app/components/ui/SingleSelect';
import { TextAreaField } from '@/app/components/ui/TextAreaField';
import { TextField } from '@/app/components/ui/TextField';
import type { NewsFormData, NewsStatus } from '@/types/news';
import { clientFetch } from '@/lib/client-fetch';

function getTodayDateString(): string {
  const now = new Date();
  const tzOffset = now.getTimezoneOffset() * 60000;
  return new Date(now.getTime() - tzOffset).toISOString().slice(0, 10);
}

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
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const articleId = params?.id;
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitSuccess, setSubmitSuccess] = useState<string | null>(null);
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [existingImageUrl, setExistingImageUrl] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [formData, setFormData] = useState<NewsFormData>({
    title: '',
    category: 'COLLECTION',
    date: getTodayDateString(),
    content: '',
    detailedContent: '',
    status: 'private',
  });

  useEffect(() => {
    if (!articleId) {
      setSubmitError('記事IDの取得に失敗しました');
      setIsLoading(false);
      return;
    }

    const fetchArticle = async () => {
      try {
        const res = await clientFetch(`/api/admin/news/${articleId}`);
        if (!res.ok) throw new Error('Failed to fetch article');
        const json = await res.json();
        const article: NewsArticle = json.data;

        setFormData({
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
        setSubmitError('記事の読み込みに失敗しました');
      } finally {
        setIsLoading(false);
      }
    };

    fetchArticle();
  }, [articleId]);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
    const { name, value } = e.target;
    setFormData(prev => ({ ...prev, [name]: value }));
  };

  const handleStatusChange = (status: string) => {
    setFormData(prev => ({ ...prev, status: status as NewsStatus }));
  };

  const updateSelectedImage = (file: File | null) => {
    if (!file) {
      setImageFile(null);
      return;
    }

    const supportedTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
    if (!supportedTypes.has(file.type)) {
      setSubmitError('画像は JPEG / PNG / WebP / GIF を選択してください');
      return;
    }

    if (file.size > 5 * 1024 * 1024) {
      setSubmitError('画像サイズは5MB以下にしてください');
      return;
    }

    setSubmitError(null);
    setImageFile(file);
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files?.[0] ?? null;
    updateSelectedImage(selected);
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
    const dropped = e.dataTransfer.files?.[0] ?? null;
    updateSelectedImage(dropped);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!articleId) {
      setSubmitError('記事IDの取得に失敗しました');
      return;
    }

    setIsSubmitting(true);
    setSubmitError(null);
    setSubmitSuccess(null);

    try {
      const requestFormData = new FormData();
      requestFormData.append('title', formData.title);
      requestFormData.append('category', formData.category);
      requestFormData.append('date', formData.date);
      requestFormData.append('content', formData.content);
      requestFormData.append('detailedContent', formData.detailedContent);
      requestFormData.append('status', formData.status);
      
      if (imageFile) {
        requestFormData.append('image', imageFile);
      }

      const response = await clientFetch(`/api/admin/news/${articleId}`, {
        method: 'PUT',
        body: requestFormData,
      });

      const result = await response.json();

      if (!response.ok) {
        setSubmitError(result?.error ?? '更新に失敗しました');
        return;
      }

      setSubmitSuccess('更新しました');

      setTimeout(() => {
        router.push('/admin?tab=NEWS');
      }, 500);
    } catch {
      setSubmitError('通信エラーが発生しました');
    } finally {
      setIsSubmitting(false);
    }
  };

  useEffect(() => {
    if (!imageFile) {
      setPreviewUrl(null);
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        setPreviewUrl(reader.result);
      }
    };
    reader.onerror = () => {
      setSubmitError('画像プレビューの読み込みに失敗しました');
      setPreviewUrl(null);
    };
    reader.readAsDataURL(imageFile);
  }, [imageFile]);

  if (isLoading) {
    return (
      <main className="pt-32 pb-20">
        <div className="max-w-4xl mx-auto px-6 lg:px-12 text-center font-acumin">
          読み込み中...
        </div>
      </main>
    );
  }

  const displayImageUrl = previewUrl || existingImageUrl;

  return (
    <main className="pt-32 pb-20">
      <div className="max-w-4xl mx-auto px-6 lg:px-12">
        <form onSubmit={handleSubmit} className="space-y-8">
          <TextField label="タイトル" type="text" name="title" value={formData.title} onChange={handleInputChange} required className="font-acumin"  size="md"/>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <SingleSelect
              label="カテゴリー"
              name="category"
              value={formData.category}
              onChange={handleInputChange}
              className="font-acumin"
              options={[
                { value: 'COLLECTION', label: 'COLLECTION' },
                { value: 'EVENT', label: 'EVENT' },
                { value: 'COLLABORATION', label: 'COLLABORATION' },
                { value: 'SUSTAINABILITY', label: 'SUSTAINABILITY' },
                { value: 'STORE', label: 'STORE' },
              ]}
             size="md"/>

            <TextField label="公開日" type="date" name="date" value={formData.date} onChange={handleInputChange} required className="font-acumin"  size="md"/>
          </div>

          <div className="space-y-2">
            <label className="block text-xs tracking-wider text-[#474747] font-brand">画像</label>
            <div
              role="button"
              tabIndex={0}
              onClick={() => fileInputRef.current?.click()}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  fileInputRef.current?.click();
                }
              }}
              onDragOver={(e) => {
                e.preventDefault();
                setIsDragging(true);
              }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={handleDrop}
              className={`w-full border border-black/20 text-sm font-acumin px-4 py-10 text-center cursor-pointer transition-colors ${
                isDragging ? 'border-black bg-black/5' : 'bg-white'
              }`}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp,image/gif"
                onChange={handleFileSelect}
                className="hidden"
              />
              {displayImageUrl ? (
                <div className="space-y-4">
                  <p className="text-sm tracking-widest">
                    {imageFile ? `${imageFile.name} (新規)` : '現在の画像'}
                  </p>
                  <Image
                    src={displayImageUrl}
                    alt="画像プレビュー"
                    width={640}
                    height={360}
                    unoptimized={!!previewUrl}
                    className="mx-auto max-h-56 object-contain"
                  />
                  <p className="text-xs text-black/70">クリックまたはドラッグ&ドロップで画像を変更</p>
                </div>
              ) : (
                <div className="space-y-2">
                  <p className="text-sm tracking-widest">画像をドラッグ&ドロップ</p>
                  <p className="text-xs text-black/70">またはクリックしてファイルを追加（JPEG / PNG / WebP / GIF、5MB以下）</p>
                </div>
              )}
            </div>
          </div>

          <TextAreaField
            label="本文（要約）"
            name="content"
            value={formData.content}
            onChange={handleInputChange}
            rows={4}
            required
            placeholder="一覧ページに表示される要約文を入力してください"
            className="font-acumin"
           size="md"/>

          <TextAreaField
            label="本文（詳細）"
            name="detailedContent"
            value={formData.detailedContent}
            onChange={handleInputChange}
            rows={12}
            required
            placeholder="詳細ページに表示される本文を入力してください"
            className="font-acumin"
           size="md"/>

          <div className="space-y-2">
            <label className="block text-xs tracking-wider text-[#474747] font-brand">ステータス</label>
            <RadioButtonGroup
              name="status"
              options={[
                { value: 'private', label: '非公開' },
                { value: 'published', label: '公開' },
              ]}
              value={formData.status}
              onChange={handleStatusChange}
             size="md"/>
          </div>

          <div className="flex gap-4">
            <Button
              type="button"
              onClick={() => router.push('/admin?tab=NEWS')}
              variant="secondary"
              className="font-acumin"
             size="md">
              キャンセル
            </Button>
            <Button
              type="submit"
              disabled={isSubmitting}
              className="font-acumin"
             size="md">
              {isSubmitting ? '更新中...' : '更新'}
            </Button>
          </div>

          {submitError && (
            <p className="text-sm text-red-600 font-acumin" role="alert">
              {submitError}
            </p>
          )}
          {submitSuccess && (
            <p className="text-sm text-black font-acumin" role="status">
              {submitSuccess}
            </p>
          )}
        </form>
      </div>
    </main>
  );
}
