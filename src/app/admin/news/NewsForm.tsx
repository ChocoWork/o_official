'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Image from 'next/image';
import { Button } from '@/app/components/ui/Button';
import { RadioButtonGroup } from '@/app/components/ui/RadioButtonGroup';
import { SingleSelect } from '@/app/components/ui/SingleSelect';
import { TextAreaField } from '@/app/components/ui/TextAreaField';
import { TextField } from '@/app/components/ui/TextField';
import type { NewsFormData, NewsStatus } from '@/types/news';
import { clientFetch } from '@/lib/client-fetch';

const NEWS_CATEGORY_OPTIONS = [
  { value: 'COLLECTION', label: 'COLLECTION' },
  { value: 'EVENT', label: 'EVENT' },
  { value: 'COLLABORATION', label: 'COLLABORATION' },
  { value: 'SUSTAINABILITY', label: 'SUSTAINABILITY' },
  { value: 'STORE', label: 'STORE' },
] as const;

function getTodayDateString(): string {
  const now = new Date();
  const tzOffset = now.getTimezoneOffset() * 60000;
  return new Date(now.getTime() - tzOffset).toISOString().slice(0, 10);
}

function getDefaultFormValues(): NewsFormData {
  return {
    title: '',
    category: 'COLLECTION',
    date: getTodayDateString(),
    content: '',
    detailedContent: '',
    status: 'private',
  };
}

interface NewsFormProps {
  submitUrl: string;
  submitMethod: 'POST' | 'PUT';
  initialValues?: NewsFormData;
  existingImageUrl?: string | null;
}

export function NewsForm({
  submitUrl,
  submitMethod,
  initialValues,
  existingImageUrl = null,
}: NewsFormProps) {
  const router = useRouter();
  const isCreateMode = submitMethod === 'POST';

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitSuccess, setSubmitSuccess] = useState<string | null>(null);
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [formData, setFormData] = useState<NewsFormData>(
    initialValues ?? getDefaultFormValues()
  );
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (initialValues) {
      setFormData(initialValues);
    }
  }, [initialValues]);

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

  const handleInputChange = (
    e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>
  ) => {
    const { name, value } = e.target;
    setFormData((previous) => ({ ...previous, [name]: value }));
  };

  const handleStatusChange = (status: string) => {
    setFormData((previous) => ({ ...previous, status: status as NewsStatus }));
  };

  const updateSelectedImage = (file: File | null) => {
    if (!file) {
      setImageFile(null);
      return;
    }

    const supportedTypes = new Set([
      'image/jpeg',
      'image/png',
      'image/webp',
      'image/gif',
    ]);
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

    if (isCreateMode && !imageFile) {
      setSubmitError('画像を添付してください');
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

      const response = await clientFetch(submitUrl, {
        method: submitMethod,
        body: requestFormData,
      });
      const result = await response.json().catch(() => null);

      if (!response.ok) {
        setSubmitError(
          result?.error ??
            (isCreateMode ? '保存に失敗しました' : '更新に失敗しました')
        );
        return;
      }

      setSubmitSuccess(isCreateMode ? '保存しました' : '更新しました');

      setTimeout(() => {
        router.push('/admin?tab=NEWS');
      }, 500);
    } catch {
      setSubmitError('通信エラーが発生しました');
    } finally {
      setIsSubmitting(false);
    }
  };

  const displayImageUrl = previewUrl || existingImageUrl;

  return (
    <main className="pt-32 pb-20">
      <div className="max-w-4xl mx-auto px-6 lg:px-12">
        <form onSubmit={handleSubmit} className="space-y-8">
          <TextField
            label="タイトル"
            type="text"
            name="title"
            value={formData.title}
            onChange={handleInputChange}
            required
            className="font-acumin"
            size="md"
          />

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <SingleSelect
              label="カテゴリー"
              name="category"
              variant="dropdown"
              value={formData.category}
              onChange={handleInputChange}
              className="font-acumin"
              options={NEWS_CATEGORY_OPTIONS.map((option) => ({
                value: option.value,
                label: option.label,
              }))}
              size="md"
            />

            <TextField
              label="公開日"
              type="date"
              name="date"
              value={formData.date}
              onChange={handleInputChange}
              required
              className="font-acumin"
              size="md"
            />
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
            size="md"
          />

          <TextAreaField
            label="本文（詳細）"
            name="detailedContent"
            value={formData.detailedContent}
            onChange={handleInputChange}
            rows={12}
            required
            placeholder="詳細ページに表示される本文を入力してください"
            className="font-acumin"
            size="md"
          />

          <RadioButtonGroup
            label="ステータス"
            name="status"
            options={[
              { value: 'private', label: '非公開' },
              { value: 'published', label: '公開' },
            ]}
            value={formData.status}
            onChange={handleStatusChange}
            size="md"
          />

          <div className="flex gap-4">
            <Button
              type="button"
              onClick={() => router.push('/admin?tab=NEWS')}
              variant="secondary"
              className="font-acumin"
              size="md"
            >
              キャンセル
            </Button>
            <Button type="submit" disabled={isSubmitting} className="font-acumin" size="md">
              {isSubmitting
                ? isCreateMode
                  ? '保存中...'
                  : '更新中...'
                : isCreateMode
                  ? '保存'
                  : '更新'}
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