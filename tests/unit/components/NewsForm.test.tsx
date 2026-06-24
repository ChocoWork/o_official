import React from 'react';
import { render, screen } from '@testing-library/react';
import { NewsForm } from '@/app/admin/news/NewsForm';

/**
 * FREQ-33-AC-01: News 作成・編集フォームに画像アップロード欄が存在しないこと
 */

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn() }),
}));

jest.mock('@/lib/client-fetch', () => ({
  clientFetch: jest.fn(),
}));

describe('NewsForm 画像アップロード欄の廃止 (FREQ-33)', () => {
  test('作成モード: 画像アップロード欄が存在しない', () => {
    const { container } = render(
      <NewsForm submitUrl="/api/admin/news" submitMethod="POST" />
    );

    expect(screen.queryByText('画像')).not.toBeInTheDocument();
    expect(container.querySelector('input[type="file"]')).toBeNull();
  });

  test('編集モード: 画像アップロード欄が存在しない', () => {
    const { container } = render(
      <NewsForm
        submitUrl="/api/admin/news/1"
        submitMethod="PUT"
        initialValues={{
          title: 'テスト',
          category: 'COLLECTION',
          date: '2026-01-01',
          content: '要約',
          detailedContent: '詳細',
          status: 'published',
        }}
      />
    );

    expect(screen.queryByText('画像')).not.toBeInTheDocument();
    expect(container.querySelector('input[type="file"]')).toBeNull();
  });
});
