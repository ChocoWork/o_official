'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Image from 'next/image';

const CATEGORIES = ['TOPS', 'BOTTOMS', 'OUTERWEAR', 'ACCESSORIES'] as const;
const SIZES = ['S', 'M', 'L', 'FREE'] as const;

interface ColorInput {
  id: string;
  name: string;
  hex: string;
}

type ColorPresetResponse = {
  id: number;
  name: string;
  hex: string;
  created_at: string;
};

type ItemStatus = 'private' | 'published';

type ItemResponse = {
  id: number;
  name: string;
  description: string;
  price: number;
  category: (typeof CATEGORIES)[number];
  image_url: string;
  image_urls?: string[];
  colors: Array<{ name: string; hex: string }>;
  sizes: string[];
  product_details: string;
  status: ItemStatus;
};

export default function AdminItemEditPage({ params }: { params: { id: string } }) {
  const router = useRouter();
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitSuccess, setSubmitSuccess] = useState<string | null>(null);

  const [imageFiles, setImageFiles] = useState<File[]>([]);
  const [previewUrls, setPreviewUrls] = useState<string[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [category, setCategory] = useState<(typeof CATEGORIES)[number]>('TOPS');
  const [itemName, setItemName] = useState('');
  const [price, setPrice] = useState('');
  const [description, setDescription] = useState('');
  const [status, setStatus] = useState<ItemStatus>('private');
  const [colors, setColors] = useState<ColorInput[]>([{ id: '1', name: '', hex: '#000000' }]);
  const [savedColors, setSavedColors] = useState<ColorInput[]>([]);
  const [selectedSizes, setSelectedSizes] = useState<Set<string>>(new Set());
  const [productDetails, setProductDetails] = useState<string>('Material : \nMade in : ');

  const fetchSavedColors = async () => {
    try {
      const response = await fetch('/api/admin/item-color-presets');
      if (!response.ok) {
        throw new Error('Failed to fetch color presets');
      }

      const json = await response.json();
      const presetList = (json?.data ?? []) as ColorPresetResponse[];
      setSavedColors(
        presetList.map((preset) => ({
          id: String(preset.id),
          name: preset.name,
          hex: preset.hex,
        }))
      );
    } catch (error) {
      console.error('Failed to load color presets:', error);
    }
  };

  useEffect(() => {
    void fetchSavedColors();
  }, []);

  useEffect(() => {
    const fetchItem = async () => {
      try {
        const response = await fetch(`/api/admin/items/${params.id}`);
        const json = await response.json().catch(() => null);
        if (!response.ok) {
          setSubmitError(json?.error ?? '商品の取得に失敗しました');
          return;
        }

        const item = (json?.data ?? null) as ItemResponse | null;
        if (!item) {
          setSubmitError('商品の取得に失敗しました');
          return;
        }

        setCategory(item.category);
        setItemName(item.name);
        setPrice(String(item.price));
        setDescription(item.description);
        setStatus(item.status);
        setProductDetails(item.product_details || '');
        setSelectedSizes(new Set(item.sizes ?? []));

        const mappedColors = (item.colors ?? []).map((color, index) => ({
          id: String(index + 1),
          name: color.name,
          hex: color.hex,
        }));
        setColors(mappedColors.length > 0 ? mappedColors : [{ id: '1', name: '', hex: '#000000' }]);

        const existingImages = item.image_urls && item.image_urls.length > 0 ? item.image_urls : [item.image_url];
        setPreviewUrls(existingImages.filter(Boolean));
      } catch (error) {
        console.error('Failed to fetch item:', error);
        setSubmitError('商品の取得に失敗しました');
      } finally {
        setIsLoading(false);
      }
    };

    fetchItem();
  }, [params.id]);

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

  const removeImage = (index: number) => {
    setPreviewUrls((previous) => previous.filter((_, i) => i !== index));
    if (index < imageFiles.length) {
      setImageFiles((previous) => previous.filter((_, i) => i !== index));
    }
  };

  const handleColorChange = (id: string, field: 'name' | 'hex', value: string) => {
    setColors(colors.map((color) => (color.id === id ? { ...color, [field]: value } : color)));
  };

  const handleAddColor = () => {
    const newId = String(Math.max(...colors.map((color) => parseInt(color.id, 10) || 0), 0) + 1);
    setColors([...colors, { id: newId, name: '', hex: '#000000' }]);
  };

  const handleRemoveColor = (id: string) => {
    if (colors.length > 1) {
      setColors(colors.filter((color) => color.id !== id));
    }
  };

  const handleSaveColor = (color: ColorInput) => {
    const trimmedName = color.name.trim();
    if (!trimmedName) {
      setSubmitError('保存するカラー名を入力してください');
      return;
    }

    const exists = savedColors.some((saved) => saved.hex === color.hex && saved.name === trimmedName);
    if (exists) {
      window.alert('このカラー名と色の組み合わせは既に保存されています。');
      return;
    }

    void (async () => {
      try {
        const response = await fetch('/api/admin/item-color-presets', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: trimmedName, hex: color.hex }),
        });

        const json = await response.json().catch(() => null);
        if (!response.ok) {
          setSubmitError(json?.error ?? 'カラー保存に失敗しました');
          return;
        }

        const savedPreset = json?.data as ColorPresetResponse | undefined;
        if (savedPreset) {
          setSavedColors((previous) => {
            if (previous.some((entry) => entry.id === String(savedPreset.id))) {
              return previous;
            }

            return [{ id: String(savedPreset.id), name: savedPreset.name, hex: savedPreset.hex }, ...previous];
          });
        }
      } catch (error) {
        console.error('Failed to save color preset:', error);
        setSubmitError('カラー保存に失敗しました');
      }
    })();
  };

  const handleApplySavedColor = (color: ColorInput) => {
    const newId = String(Math.max(...colors.map((entry) => parseInt(entry.id, 10) || 0), 0) + 1);
    setColors([...colors, { id: newId, name: color.name, hex: color.hex }]);
  };

  const handleRemoveSavedColor = (id: string) => {
    void (async () => {
      try {
        const response = await fetch(`/api/admin/item-color-presets/${id}`, {
          method: 'DELETE',
        });

        if (!response.ok) {
          throw new Error('Failed to delete color preset');
        }

        setSavedColors((previous) => previous.filter((color) => color.id !== id));
      } catch (error) {
        console.error('Failed to delete color preset:', error);
        setSubmitError('保存済みカラーの削除に失敗しました');
      }
    })();
  };

  const handleSizeToggle = (size: string) => {
    const next = new Set(selectedSizes);
    if (next.has(size)) {
      next.delete(size);
    } else {
      next.add(size);
    }
    setSelectedSizes(next);
  };

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setSubmitError(null);
    setSubmitSuccess(null);

    const trimmedName = itemName.trim();
    const trimmedDescription = description.trim();
    const trimmedDetails = productDetails.trim();
    const parsedPrice = Number(price);
    const normalizedColors = colors
      .map((color) => ({ name: color.name.trim(), hex: color.hex }))
      .filter((color) => color.name.length > 0);
    const normalizedSizes = Array.from(selectedSizes);

    if (!trimmedName || !trimmedDescription || !trimmedDetails) {
      setSubmitError('必須項目を入力してください');
      return;
    }

    if (!Number.isInteger(parsedPrice) || parsedPrice < 0) {
      setSubmitError('価格は0以上の整数で入力してください');
      return;
    }

    if (normalizedColors.length === 0) {
      setSubmitError('カラー名を1つ以上入力してください');
      return;
    }

    if (normalizedSizes.length === 0) {
      setSubmitError('サイズを1つ以上選択してください');
      return;
    }

    setIsSubmitting(true);

    try {
      const formData = new FormData();
      formData.append('name', trimmedName);
      formData.append('description', trimmedDescription);
      formData.append('price', String(parsedPrice));
      formData.append('category', category);
      formData.append('productDetails', trimmedDetails);
      formData.append('status', status);
      formData.append('sizes', JSON.stringify(normalizedSizes));
      formData.append('colors', JSON.stringify(normalizedColors));

      for (const file of imageFiles) {
        formData.append('images', file);
      }

      const response = await fetch(`/api/admin/items/${params.id}`, {
        method: 'PUT',
        body: formData,
      });

      const responseJson = await response.json().catch(() => null);
      if (!response.ok) {
        setSubmitError(responseJson?.error ?? '商品の更新に失敗しました');
        return;
      }

      setSubmitSuccess('商品を更新しました');
      router.push('/admin?tab=ITEM');
    } catch (error) {
      console.error('Failed to update item:', error);
      setSubmitError('通信エラーが発生しました。時間をおいて再度お試しください');
    } finally {
      setIsSubmitting(false);
    }
  };

  if (isLoading) {
    return (
      <main className="pt-32 pb-20">
        <div className="max-w-4xl mx-auto px-6 lg:px-12 text-center">読み込み中...</div>
      </main>
    );
  }

  return (
    <main className="pt-32 pb-20">
      <div className="max-w-4xl mx-auto px-6 lg:px-12">
        <form className="space-y-8" onSubmit={handleSubmit}>
          <div>
            <label className="block text-sm tracking-widest mb-4">商品画像</label>
            <div className="grid grid-cols-2 gap-4 mb-6">
              {previewUrls.map((url, index) => (
                <div key={`${url}-${index}`} className="relative aspect-[3/4] bg-[#f5f5f5] overflow-hidden border border-black/20">
                  <Image src={url} alt={`プレビュー ${index + 1}`} fill className="w-full h-full object-cover object-center" unoptimized />
                  <button
                    type="button"
                    onClick={() => removeImage(index)}
                    className="absolute top-2 right-2 w-8 h-8 bg-black text-white flex items-center justify-center text-xs hover:bg-[#474747] transition-colors"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
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
              </div>
            </div>
          </div>

          <div>
            <label className="block text-sm tracking-widest mb-2">カテゴリー</label>
            <div className="relative">
              <select
                className="w-full px-4 py-3 pr-8 border border-black/20 text-sm focus:outline-none focus:border-black appearance-none cursor-pointer"
                value={category}
                onChange={(e) => setCategory(e.target.value as (typeof CATEGORIES)[number])}
              >
                {CATEGORIES.map((itemCategory) => (
                  <option key={itemCategory} value={itemCategory}>
                    {itemCategory}
                  </option>
                ))}
              </select>
              <i className="ri-arrow-down-s-line absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none"></i>
            </div>
          </div>

          <div>
            <label className="block text-sm tracking-widest mb-2">商品名</label>
            <input
              className="w-full px-4 py-3 border border-black/20 text-sm focus:outline-none focus:border-black"
              required
              type="text"
              value={itemName}
              onChange={(e) => setItemName(e.target.value)}
            />
          </div>

          <div>
            <label className="block text-sm tracking-widest mb-2">価格（円）</label>
            <input
              className="w-full px-4 py-3 border border-black/20 text-sm focus:outline-none focus:border-black"
              required
              type="number"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
            />
          </div>

          <div>
            <label className="block text-sm tracking-widest mb-2">商品情報</label>
            <textarea
              rows={4}
              className="w-full px-4 py-3 border border-black/20 text-sm focus:outline-none focus:border-black resize-none"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              required
            />
          </div>

          <div>
            <label className="block text-sm tracking-widest mb-4">カラー</label>
            <div className="space-y-4 mb-4">
              {colors.map((color) => (
                <div key={color.id} className="flex gap-3 items-end">
                  <input
                    className="flex-1 px-4 py-3 border border-black/20 text-sm focus:outline-none focus:border-black"
                    placeholder="カラー名"
                    type="text"
                    value={color.name}
                    onChange={(e) => handleColorChange(color.id, 'name', e.target.value)}
                  />
                  <label className="relative w-12 h-12 rounded-full border-2 border-black/20 cursor-pointer overflow-hidden">
                    <span className="absolute inset-0" style={{ backgroundColor: color.hex }} />
                    <input
                      type="color"
                      value={color.hex}
                      onChange={(e) => handleColorChange(color.id, 'hex', e.target.value)}
                      className="absolute inset-0 opacity-0 cursor-pointer"
                      aria-label="カラーを選択"
                    />
                  </label>
                  <button
                    type="button"
                    onClick={() => handleSaveColor(color)}
                    className="px-3 py-2 border border-black text-black text-xs tracking-widest hover:bg-black hover:text-white transition-all"
                  >
                    保存
                  </button>
                  {colors.length > 1 && (
                    <button
                      type="button"
                      onClick={() => handleRemoveColor(color.id)}
                      className="px-3 py-2 border border-red-500 text-red-500 text-xs tracking-widest hover:bg-red-500 hover:text-white transition-all"
                    >
                      削除
                    </button>
                  )}
                </div>
              ))}
            </div>
            <button
              type="button"
              onClick={handleAddColor}
              className="px-6 py-2 border border-black text-black text-xs tracking-widest hover:bg-black hover:text-white transition-all duration-300 cursor-pointer whitespace-nowrap"
            >
              カラーを追加
            </button>
            {savedColors.length > 0 && (
              <div className="mt-6">
                <p className="text-xs tracking-widest mb-3">保存済みカラー</p>
                <div className="flex flex-wrap gap-3">
                  {savedColors.map((color) => (
                    <div key={color.id} className="relative w-10 h-10">
                      <button
                        type="button"
                        onClick={() => handleApplySavedColor(color)}
                        className="relative w-10 h-10 rounded-full border-2 border-black/20 overflow-hidden"
                        aria-label={`保存済みカラー ${color.name || color.hex}`}
                      >
                        <span className="absolute inset-0" style={{ backgroundColor: color.hex }} />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleRemoveSavedColor(color.id)}
                        className="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-black text-white text-[10px] leading-none flex items-center justify-center"
                        aria-label="保存済みカラーを削除"
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div>
            <label className="block text-sm tracking-widest mb-4">サイズ（複数選択可能）</label>
            <div className="flex gap-3 flex-wrap">
              {SIZES.map((size) => (
                <button
                  key={size}
                  type="button"
                  onClick={() => handleSizeToggle(size)}
                  className={`px-6 py-2 text-xs tracking-widest transition-all duration-300 cursor-pointer whitespace-nowrap border ${
                    selectedSizes.has(size)
                      ? 'border-black bg-black text-white'
                      : 'border-black text-black hover:bg-black hover:text-white'
                  }`}
                >
                  {size}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-sm tracking-widest mb-2">PRODUCT DETAILS（素材・洗濯の情報）</label>
            <textarea
              rows={6}
              className="w-full px-4 py-3 border border-black/20 text-sm focus:outline-none focus:border-black resize-none"
              value={productDetails}
              onChange={(e) => setProductDetails(e.target.value)}
              required
            />
          </div>

          <div>
            <label className="block text-sm tracking-widest mb-2">ステータス</label>
            <div className="flex gap-4">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  className="cursor-pointer"
                  type="radio"
                  name="status"
                  value="private"
                  checked={status === 'private'}
                  onChange={() => setStatus('private')}
                />
                <span className="text-sm">非公開</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  className="cursor-pointer"
                  type="radio"
                  name="status"
                  value="published"
                  checked={status === 'published'}
                  onChange={() => setStatus('published')}
                />
                <span className="text-sm">公開</span>
              </label>
            </div>
          </div>

          {submitSuccess && (
            <p className="text-sm text-black" role="status">
              {submitSuccess}
            </p>
          )}

          {submitError && (
            <p className="text-sm text-red-600" role="alert">
              {submitError}
            </p>
          )}

          <div className="flex gap-4">
            <button
              type="button"
              onClick={() => router.push('/admin?tab=ITEM')}
              disabled={isSubmitting}
              className="px-8 py-3 border border-black text-black text-sm tracking-widest hover:bg-black hover:text-white transition-all duration-300 cursor-pointer whitespace-nowrap"
            >
              キャンセル
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className="px-8 py-3 bg-black text-white text-sm tracking-widest hover:bg-[#474747] transition-all duration-300 cursor-pointer whitespace-nowrap disabled:opacity-50"
            >
              {isSubmitting ? '更新中...' : '更新'}
            </button>
          </div>
        </form>
      </div>
    </main>
  );
}
