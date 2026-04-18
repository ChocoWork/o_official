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

  it('renders category with border (TagLabel outline variant)', async () => {
    render(<NewsSection />);

    await waitFor(() => {
      expect(screen.getByText('SUSTAINABILITY')).toBeInTheDocument();
    });

    const categoryEl = screen.getByText('SUSTAINABILITY');
    // TagLabel variant="outline" applies border and border-black
    expect(categoryEl).toHaveClass('border');
    expect(categoryEl).toHaveClass('border-black');
  });

  it('renders all category labels as TagLabel outline', async () => {
    render(<NewsSection />);

    await waitFor(() => {
      expect(screen.getByText('COLLABORATION')).toBeInTheDocument();
    });

    const collab = screen.getByText('COLLABORATION');
    expect(collab).toHaveClass('border');
    expect(collab).toHaveClass('border-black');
  });

  it('does not render category as plain span without border', async () => {
    render(<NewsSection />);

    await waitFor(() => {
      expect(screen.getByText('SUSTAINABILITY')).toBeInTheDocument();
    });

    const categoryEl = screen.getByText('SUSTAINABILITY');
    // Must not be the old plain-text span (which had text-[#474747] but no border)
    expect(categoryEl).not.toHaveClass('text-\\[\\#474747\\]');
  });
});
