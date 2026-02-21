'use client';

import { useState } from 'react';
import Link from 'next/link';
import FormField from '@/app/components/FormField';
import RadioGroup from '@/app/components/RadioGroup';
import type { NewsFormData, NewsStatus } from '@/types/news';

export default function CreateNewsPage() {
  const [formData, setFormData] = useState<NewsFormData>({
    title: '',
    category: 'COLLECTION',
    imageUrl: '',
    content: '',
    detailedContent: '',
    status: 'draft',
  });

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
    const { name, value } = e.target;
    setFormData(prev => ({ ...prev, [name]: value }));
  };

  const handleStatusChange = (status: NewsStatus) => {
    setFormData(prev => ({ ...prev, status }));
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    // TODO: API呼び出しで保存
    console.log('Form data:', formData);
  };

  return (
    <main className="pt-32 pb-20">
      <div className="max-w-4xl mx-auto px-6 lg:px-12">
        <h1 className="text-4xl text-black mb-12 tracking-tight font-didot">
          NEWS記事作成
        </h1>

        <form onSubmit={handleSubmit} className="space-y-8">
          {/* タイトル */}
          <FormField label="タイトル">
            <input
              type="text"
              name="title"
              value={formData.title}
              onChange={handleInputChange}
              required
              className="w-full px-4 py-3 border border-black/20 text-sm focus:outline-none focus:border-black font-acumin"
            />
          </FormField>

          {/* カテゴリー */}
          <FormField label="カテゴリー">
            <div className="relative">
              <select
                name="category"
                value={formData.category}
                onChange={handleInputChange}
                className="w-full px-4 py-3 pr-8 border border-black/20 text-sm focus:outline-none focus:border-black appearance-none cursor-pointer font-acumin"
              >
                <option value="COLLECTION">COLLECTION</option>
                <option value="EVENT">EVENT</option>
                <option value="COLLABORATION">COLLABORATION</option>
                <option value="SUSTAINABILITY">SUSTAINABILITY</option>
                <option value="STORE">STORE</option>
              </select>
              <i className="ri-arrow-down-s-line absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none"></i>
            </div>
          </FormField>

          {/* 画像URL */}
          <FormField label="画像URL">
            <input
              type="text"
              name="imageUrl"
              value={formData.imageUrl}
              onChange={handleInputChange}
              placeholder="https://..."
              required
              className="w-full px-4 py-3 border border-black/20 text-sm focus:outline-none focus:border-black font-acumin"
            />
          </FormField>

          {/* 本文（要約） */}
          <FormField label="本文（要約）">
            <textarea
              name="content"
              value={formData.content}
              onChange={handleInputChange}
              rows={4}
              required
              placeholder="一覧ページに表示される要約文を入力してください"
              className="w-full px-4 py-3 border border-black/20 text-sm focus:outline-none focus:border-black resize-none font-acumin"
            />
          </FormField>

          {/* 本文（詳細） */}
          <FormField label="本文（詳細）">
            <textarea
              name="detailedContent"
              value={formData.detailedContent}
              onChange={handleInputChange}
              rows={12}
              required
              placeholder="詳細ページに表示される本文を入力してください"
              className="w-full px-4 py-3 border border-black/20 text-sm focus:outline-none focus:border-black resize-none font-acumin"
            />
          </FormField>

          {/* ステータス */}
          <FormField label="ステータス">
            <RadioGroup
              name="status"
              options={[
                { value: 'draft', label: '下書き' },
                { value: 'published', label: '公開' },
              ]}
              selectedValue={formData.status}
              onChange={handleStatusChange}
            />
          </FormField>

          {/* ボタン */}
          <div className="flex gap-4">
            <Link href="/admin">
              <button
                type="button"
                className="px-8 py-3 border border-black text-black text-sm tracking-widest hover:bg-black hover:text-white transition-all duration-300 cursor-pointer whitespace-nowrap font-acumin"
              >
                キャンセル
              </button>
            </Link>
            <button
              type="submit"
              className="px-8 py-3 bg-black text-white text-sm tracking-widest hover:bg-[#474747] transition-all duration-300 cursor-pointer whitespace-nowrap disabled:opacity-50 font-acumin"
            >
              保存
            </button>
          </div>
        </form>
      </div>
    </main>
  );
}