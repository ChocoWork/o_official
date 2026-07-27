import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import NewsSection from '@/components/NewsSection';

jest.mock('next/image', () => ({
  __esModule: true,
  default: ({ src, alt }: { src: string; alt: string }) => React.createElement('img', { src, alt }),
}));

jest.mock('@/lib/client-fetch', () => ({
  clientFetch: jest.fn(),
}));

import { clientFetch } from '@/lib/client-fetch';

const mockClientFetch = clientFetch as jest.MockedFunction<typeof clientFetch>;

const mockArticles = [
  {
    id: '1',
    title: 'テスト記事',
    published_date: '2025-01-01',
    category: 'SUSTAINABILITY',
    status: 'published' as const,
    image_url: '/test.jpg',
    content: 'テスト本文',
    detailed_content: '詳細テスト本文',
  },
  {
    id: '2',
    title: '別記事',
    published_date: '2025-01-02',
    category: 'COLLABORATION',
    status: 'private' as const,
    image_url: '/test2.jpg',
    content: '別本文',
    detailed_content: '別詳細',
  },
];

describe('NewsSection category label', () => {
  beforeEach(() => {
    mockClientFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ data: mockArticles }),
    } as Response);
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  // カテゴリは TagLabel の outline variant で描画する。枠線の見た目は
  // TagLabel.css の責務なので、ここでは variant の属性契約だけを検証する。
  it('カテゴリを TagLabel の outline variant で描画する', async () => {
    render(<NewsSection />);

    await waitFor(() => {
      expect(screen.getByText('SUSTAINABILITY')).toBeInTheDocument();
    });

    const categoryEl = screen.getByText('SUSTAINABILITY').closest('[data-ui-tag-label]');
    expect(categoryEl).not.toBeNull();
    expect(categoryEl).toHaveAttribute('data-ui-tag-label-variant', 'outline');
  });

  it('すべてのカテゴリを TagLabel で描画する', async () => {
    render(<NewsSection />);

    await waitFor(() => {
      expect(screen.getByText('COLLABORATION')).toBeInTheDocument();
    });

    const collab = screen.getByText('COLLABORATION').closest('[data-ui-tag-label]');
    expect(collab).not.toBeNull();
    expect(collab).toHaveAttribute('data-ui-tag-label-variant', 'outline');
  });

  it('素の span では描画しない', async () => {
    render(<NewsSection />);

    await waitFor(() => {
      expect(screen.getByText('SUSTAINABILITY')).toBeInTheDocument();
    });

    // TagLabel を経由していれば必ず data-ui-tag-label が祖先に付く。
    expect(screen.getByText('SUSTAINABILITY').closest('[data-ui-tag-label]')).not.toBeNull();
  });
});
