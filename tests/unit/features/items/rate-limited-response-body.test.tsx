import React from 'react';
import { act, render, renderHook, waitFor } from '@testing-library/react';
import { PublicItemGrid } from '@/features/items/components/PublicItemGrid';
import { RelatedItems } from '@/features/items/components/RelatedItems';
import { usePublicItems } from '@/features/items/hooks/usePublicItems';

// 回数の制限の 429・503 は Cache-Control: no-store を付けて返す。本文を読まずに捨てると、
// ブラウザが要求を開いたまま残し、E2E の networkidle が止まる（波 3 の /api/auth/refresh の件と同じ）。
// 商品の窓口を呼ぶ 3 つの部品が、!ok の応答でも本文を読み切ることを確かめる。

jest.mock('next/link', () => ({ href, children, ...props }: any) => (
  <a href={href} {...props}>
    {children}
  </a>
));
jest.mock('next/image', () => ({ src, alt }: any) => React.createElement('img', { src, alt }));
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/item',
}));

function tooManyRequests(drain: jest.Mock) {
  return { ok: false, status: 429, json: async () => ({}), arrayBuffer: drain };
}

describe('商品の窓口の !ok の応答は本文を読み切る', () => {
  const originalFetch = global.fetch;
  const originalObserver = (global as any).IntersectionObserver;
  let drain: jest.Mock;
  let consoleError: jest.SpyInstance;

  beforeEach(() => {
    drain = jest.fn().mockResolvedValue(new ArrayBuffer(0));
    global.fetch = jest.fn().mockResolvedValue(tooManyRequests(drain)) as unknown as typeof fetch;
    consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    (global as any).IntersectionObserver = originalObserver;
    consoleError.mockRestore();
  });

  test('RelatedItems は 429 でも本文を読み切り、何も描かない', async () => {
    const { container } = render(<RelatedItems currentItemId={1} category="TOPS" />);

    await waitFor(() => expect(drain).toHaveBeenCalledTimes(1));
    expect(container.querySelector('a')).toBeNull();
  });

  test('usePublicItems は 429 でも本文を読み切り、失敗の文を返す', async () => {
    const { result } = renderHook(() => usePublicItems());

    await waitFor(() => expect(result.current.error).toBe('商品データの取得に失敗しました'));
    expect(drain).toHaveBeenCalledTimes(1);
  });

  test('PublicItemGrid の続きの頁の取得は 429 でも本文を読み切る', async () => {
    // 失敗の後も hasMore は真のままで効果が組み直されるので、見張りは最初の 1 回だけ交差させる
    let fired = false;
    (global as any).IntersectionObserver = class {
      constructor(private readonly callback: (entries: Array<{ isIntersecting: boolean }>) => void) {}
      observe() {
        if (fired) return;
        fired = true;
        void this.callback([{ isIntersecting: true }]);
      }
      disconnect() {}
      unobserve() {}
    };

    await act(async () => {
      render(<PublicItemGrid variant="catalog" items={[]} initialHasMore pageSize={12} />);
    });

    await waitFor(() => expect(drain).toHaveBeenCalledTimes(1));
    expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('/api/items?'), { cache: 'no-store' });
    expect(consoleError).toHaveBeenCalledWith('Failed to fetch next items page:', expect.any(Error));
  });
});
