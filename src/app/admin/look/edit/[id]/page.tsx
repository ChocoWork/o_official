'use client';

import Image from 'next/image';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Button } from '@/app/components/ui/Button';
import { RadioButtonGroup } from '@/app/components/ui/RadioButtonGroup';
import { SingleSelect } from '@/app/components/ui/SingleSelect';
import { TextAreaField } from '@/app/components/ui/TextAreaField';
import { TextField } from '@/app/components/ui/TextField';
import { clientFetch } from '@/lib/client-fetch';

type ItemSummary = {
  id: number;
  name: string;
  price: number;
  image_url: string;
  status: 'private' | 'published';
};

type LookDetail = {
  id: number;
  season_year: number;
  season_type: 'SS' | 'AW';
  theme: string;
  theme_description: string;
  image_urls: string[];
  status: 'private' | 'published';
  linkedItemIds: number[];
};

export default function AdminLookEditPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const lookId = params?.id;
  const now = new Date();
  const currentYear = now.getFullYear();
  const yearOptions = Array.from({ length: 4 }, (_, index) => currentYear - 1 + index);

  const [seasonYear, setSeasonYear] = useState<number>(currentYear);
  const [seasonType, setSeasonType] = useState<'SS' | 'AW'>('SS');
  const [theme, setTheme] = useState('');
  const [themeDescription, setThemeDescription] = useState('');
  const [status, setStatus] = useState<'private' | 'published'>('private');
  const [imageFiles, setImageFiles] = useState<File[]>([]);
  const [previewUrls, setPreviewUrls] = useState<string[]>([]);
  const [existingImageUrls, setExistingImageUrls] = useState<string[]>([]);
  const [items, setItems] = useState<ItemSummary[]>([]);
  const [selectedItemIds, setSelectedItemIds] = useState<Set<number>>(new Set());
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingItems, setIsLoadingItems] = useState(true);
  const [isDragging, setIsDragging] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitSuccess, setSubmitSuccess] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const currencyFormatter = useMemo(
    () => new Intl.NumberFormat('ja-JP', { style: 'currency', currency: 'JPY', maximumFractionDigits: 0 }),
    []
  );

  const fetchItems = useCallback(async () => {
    setIsLoadingItems(true);
    try {
      const response = await clientFetch('/api/admin/items');
      if (!response.ok) {
        throw new Error('Failed to fetch items');
      }

      const json = (await response.json()) as { data?: ItemSummary[] };
      setItems(Array.isArray(json.data) ? json.data : []);
    } catch (error) {
      console.error('Failed to load items:', error);
      setSubmitError('商品一覧の取得に失敗しました');
    } finally {
      setIsLoadingItems(false);
    }
  }, []);

  const fetchLook = useCallback(async () => {
    if (!lookId) {
      setSubmitError('LOOK IDの取得に失敗しました');
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    try {
      const response = await clientFetch(`/api/admin/looks/${lookId}`);
      if (!response.ok) {
        throw new Error('Failed to fetch look');
      }

      const json = (await response.json()) as { data?: LookDetail };
      const look = json.data;

      if (!look) {
        throw new Error('Look not found');
      }

      setSeasonYear(look.season_year);
      setSeasonType(look.season_type);
      setTheme(look.theme);
      setThemeDescription(look.theme_description || '');
      setStatus(look.status);
      setExistingImageUrls(Array.isArray(look.image_urls) ? look.image_urls : []);
      setSelectedItemIds(new Set(look.linkedItemIds));
    } catch (error) {
      console.error('Failed to load look:', error);
      setSubmitError('LOOKの読み込みに失敗しました');
    } finally {
      setIsLoading(false);
    }
  }, [lookId]);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files?.[0];
    if (selected) {
      updateSelectedImage(selected);
    }
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
    const dropped = e.dataTransfer.files?.[0];
    if (dropped) {
      updateSelectedImage(dropped);
    }
  };

  const updateSelectedImage = (file: File) => {
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

    const reader = new FileReader();
    reader.onload = () => {
      const loadedResult = reader.result;
      if (typeof loadedResult === 'string') {
        setImageFiles((previousFiles) => [...previousFiles, file]);
        setPreviewUrls((previousUrls) => [...previousUrls, loadedResult]);
      }
    };
    reader.onerror = () => {
      setSubmitError('画像プレビューの読み込みに失敗しました');
    };
    reader.readAsDataURL(file);
  };

  const removeImage = (index: number) => {
    setImageFiles((previousFiles) => previousFiles.filter((_, i) => i !== index));
    setPreviewUrls((previousUrls) => previousUrls.filter((_, i) => i !== index));
  };

  const toggleItemSelection = (itemId: number) => {
    setSelectedItemIds((previousIds) => {
      const nextIds = new Set(previousIds);
      if (nextIds.has(itemId)) {
        nextIds.delete(itemId);
      } else {
        nextIds.add(itemId);
      }
      return nextIds;
    });
  };

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();

    if (!lookId) {
      setSubmitError('LOOK IDの取得に失敗しました');
      return;
    }
    setSubmitError(null);
    setSubmitSuccess(null);

    const trimmedTheme = theme.trim();
    const trimmedThemeDescription = themeDescription.trim();
    const linkedItemIds = Array.from(selectedItemIds);

    if (!trimmedTheme) {
      setSubmitError('シーズンテーマを入力してください');
      return;
    }

    if (linkedItemIds.length === 0) {
      setSubmitError('紐づける商品を1つ以上選択してください');
      return;
    }

    if (existingImageUrls.length === 0 && imageFiles.length === 0) {
      setSubmitError('画像を1枚以上追加してください');
      return;
    }

    setIsSubmitting(true);

    try {
      const formData = new FormData();
      formData.append('seasonYear', String(seasonYear));
      formData.append('seasonType', seasonType);
      formData.append('theme', trimmedTheme);
      formData.append('themeDescription', trimmedThemeDescription);
      formData.append('status', status);
      formData.append('linkedItemIds', JSON.stringify(linkedItemIds));

      for (const image of imageFiles) {
        formData.append('images', image);
      }

      const response = await clientFetch(`/api/admin/looks/${lookId}`, {
        method: 'PUT',
        body: formData,
      });

      const responseJson = await response.json().catch(() => null);
      if (!response.ok) {
        setSubmitError(responseJson?.error ?? 'Lookの更新に失敗しました');
        return;
      }

      setSubmitSuccess('Lookを更新しました');
      router.push('/admin?tab=LOOK');
    } catch (error) {
      console.error('Failed to submit look:', error);
      setSubmitError('通信エラーが発生しました。時間をおいて再度お試しください');
    } finally {
      setIsSubmitting(false);
    }
  };

  useEffect(() => {
    void (async () => {
      await Promise.all([fetchItems(), fetchLook()]);
    })();
  }, [fetchItems, fetchLook]);

  if (isLoading) {
    return (
      <main className="pt-32 pb-20">
        <div className="max-w-4xl mx-auto px-6 lg:px-12 text-center font-acumin">読み込み中...</div>
      </main>
    );
  }

  return (
    <main className="pt-32 pb-20">
      <div className="max-w-4xl mx-auto px-6 lg:px-12">
        <form className="space-y-8" onSubmit={handleSubmit}>
          <div>
            <label className="block text-sm tracking-widest mb-2">シーズン</label>
            <div className="flex flex-wrap gap-3">
              <div className="min-w-[140px]">
                <SingleSelect
                  value={String(seasonYear)}
                  onChange={(e) => setSeasonYear(Number(e.target.value))}
                  options={yearOptions.map((year) => ({ value: String(year), label: String(year) }))}
                />
              </div>
              <div className="min-w-[110px]">
                <SingleSelect
                  value={seasonType}
                  onChange={(e) => setSeasonType(e.target.value as 'SS' | 'AW')}
                  options={[
                    { value: 'SS', label: 'SS' },
                    { value: 'AW', label: 'AW' },
                  ]}
                />
              </div>
            </div>
          </div>

          <div>
            <label className="block text-sm tracking-widest mb-2">シーズンテーマ</label>
            <TextField placeholder="例: Effortless Elegance" required type="text" value={theme} onChange={(e) => setTheme(e.target.value)} />
          </div>

          <div>
            <label className="block text-sm tracking-widest mb-2">シーズンテーマ詳細</label>
            <TextAreaField
              placeholder="このシーズンテーマの説明文を入力してください"
              rows={4}
              value={themeDescription}
              onChange={(e) => setThemeDescription(e.target.value)}
            />
          </div>

          <div>
            <label className="block text-sm tracking-widest mb-2">画像</label>
            {existingImageUrls.length > 0 && previewUrls.length === 0 && (
              <div className="grid grid-cols-2 gap-4 mb-6">
                {existingImageUrls.map((url, index) => (
                  <div key={`${url}-${index}`} className="relative aspect-[3/4] bg-[#f5f5f5] overflow-hidden border border-black/20">
                    <Image src={url} alt={`登録済み画像 ${index + 1}`} fill className="w-full h-full object-cover object-center" unoptimized />
                  </div>
                ))}
              </div>
            )}
            {previewUrls.length > 0 && (
              <div className="grid grid-cols-2 gap-4 mb-6">
                {previewUrls.map((url, index) => (
                  <div key={index} className="relative aspect-[3/4] bg-[#f5f5f5] overflow-hidden border border-black/20">
                    <Image src={url} alt={`プレビュー ${index + 1}`} fill className="w-full h-full object-cover object-center" unoptimized />
                    <Button
                      type="button"
                      onClick={() => removeImage(index)}
                      size="sm"
                      className="absolute top-2 right-2 h-8 w-8 p-0"
                    >
                      ×
                    </Button>
                  </div>
                ))}
              </div>
            )}
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
              className={`w-full border border-black/20 text-sm px-4 py-10 text-center cursor-pointer transition-colors ${
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
              <div className="space-y-2">
                <p className="text-sm tracking-widest">画像をドラッグ&ドロップ</p>
                <p className="text-xs text-black/70">またはクリックしてファイルを追加（JPEG / PNG / WebP / GIF、5MB以下）</p>
                <p className="text-xs text-black/70">新規画像を追加して保存すると、画像は新規選択分に置き換わります</p>
              </div>
            </div>
          </div>

          <div>
            <label className="block text-sm tracking-widest mb-4">紐づける商品を選択</label>
            {isLoadingItems ? (
              <p className="text-sm text-black/70">商品を読み込み中です...</p>
            ) : items.length === 0 ? (
              <p className="text-sm text-black/70">登録済み商品がありません。先にITEMを登録してください。</p>
            ) : (
              <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                {items.map((item) => {
                  const isSelected = selectedItemIds.has(item.id);

                  return (
                    <div
                      key={item.id}
                      onClick={() => toggleItemSelection(item.id)}
                      className={`border cursor-pointer transition-all duration-300 hover:border-black ${
                        isSelected ? 'border-black ring-1 ring-black' : 'border-black/20'
                      }`}
                    >
                      <div className="aspect-[3/4] bg-[#f5f5f5] overflow-hidden relative">
                        <Image
                          src={item.image_url}
                          alt={item.name}
                          fill
                          sizes="(max-width: 768px) 50vw, 33vw"
                          className="object-cover object-top"
                          unoptimized
                        />
                      </div>
                      <div className="p-3">
                        <p className="text-xs text-black mb-1">{item.name}</p>
                        <p className="text-xs text-[#474747]">{currencyFormatter.format(item.price)}</p>
                        {item.status === 'private' && <p className="mt-2 text-[10px] tracking-widest text-black/60">非公開商品</p>}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div>
            <label className="block text-sm tracking-widest mb-2">ステータス</label>
            <RadioButtonGroup
              name="status"
              value={status}
              onChange={(value) => setStatus(value as 'private' | 'published')}
              options={[
                { value: 'private', label: '非公開' },
                { value: 'published', label: '公開' },
              ]}
            />
          </div>

          {submitSuccess && (
            <p className="text-sm text-green-700" role="status">
              {submitSuccess}
            </p>
          )}

          {submitError && (
            <p className="text-sm text-red-600" role="alert">
              {submitError}
            </p>
          )}

          <div className="flex gap-4">
            <Button
              type="button"
              onClick={() => router.push('/admin?tab=LOOK')}
              variant="secondary"
            >
              キャンセル
            </Button>
            <Button
              type="submit"
              disabled={isSubmitting}
            >
              {isSubmitting ? '更新中...' : '更新'}
            </Button>
          </div>
        </form>
      </div>
    </main>
  );
}
