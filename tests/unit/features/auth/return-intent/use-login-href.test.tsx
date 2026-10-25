/**
 * @jest-environment jsdom
 */
/**
 * DD-AUTH-036 ログインの入口のリンクの URL を作る（use-login-href.ts）。
 */
import { act, renderHook } from '@testing-library/react';
import { buildLoginHref, useLoginHref } from '@/features/auth/return-intent/use-login-href';

const mockUsePathname = jest.fn<string, []>();

jest.mock('next/navigation', () => ({
  usePathname: () => mockUsePathname(),
}));

function setLocation(pathname: string, search = '', hash = '') {
  window.history.pushState(null, '', `${pathname}${search}${hash}`);
}

describe('DD-AUTH-036 buildLoginHref', () => {
  it('DD-AUTH-036 確かめを通った道筋と検索条件を next にエンコードして載せる', () => {
    expect(buildLoginHref('/stockist?from=e2e', 'http://localhost')).toBe('/login?next=%2Fstockist%3Ffrom%3De2e');
  });

  it('DD-AUTH-036 origin を省くと window.location.origin を基準にする', () => {
    expect(buildLoginHref('/item/3')).toBe('/login?next=%2Fitem%2F3');
  });

  it.each(['/login', '/auth/verified', '/api/x', '/unknown'])('DD-AUTH-036 %s は next を付けない', (path) => {
    expect(buildLoginHref(path)).toBe('/login');
  });

  it('DD-AUTH-036 ホーム / は戻り先を持たない扱いで next を付けない', () => {
    expect(buildLoginHref('/')).toBe('/login');
  });

  it.each([['//evil.example'], ['https://evil.example/'], ['/\\evil.example'], [''], [null], [undefined]])(
    'DD-AUTH-036 外の住所・不正な値（%p）は next を付けない',
    (path) => {
      expect(buildLoginHref(path as string | null | undefined)).toBe('/login');
    },
  );
});

describe('DD-AUTH-036 useLoginHref', () => {
  beforeEach(() => {
    mockUsePathname.mockReset();
    setLocation('/');
  });

  it('DD-AUTH-036 /stockist と ?from=e2e を載せる', () => {
    setLocation('/stockist', '?from=e2e');
    mockUsePathname.mockReturnValue('/stockist');

    const { result } = renderHook(() => useLoginHref());

    expect(result.current).toBe('/login?next=%2Fstockist%3Ffrom%3De2e');
  });

  it('DD-AUTH-036 ホーム / にいる時は next を付けない', () => {
    setLocation('/');
    mockUsePathname.mockReturnValue('/');

    const { result } = renderHook(() => useLoginHref());

    expect(result.current).toBe('/login');
  });

  it('DD-AUTH-036 fragment は載せない', () => {
    setLocation('/item/3', '?color=red', '#x');
    mockUsePathname.mockReturnValue('/item/3');

    const { result } = renderHook(() => useLoginHref());

    expect(result.current).toBe('/login?next=%2Fitem%2F3%3Fcolor%3Dred');
  });

  it.each(['/login', '/auth/verified', '/api/x', '/unknown'])('DD-AUTH-036 %s にいる時は next を付けない', (path) => {
    setLocation(path, '?a=1');
    mockUsePathname.mockReturnValue(path);

    const { result } = renderHook(() => useLoginHref());

    expect(result.current).toBe('/login');
  });

  it('DD-AUTH-036 最初の描画（サーバーと同じ）は検索条件を含まず、効果の後に含む', () => {
    setLocation('/stockist', '?from=e2e');
    mockUsePathname.mockReturnValue('/stockist');
    const seen: string[] = [];

    renderHook(() => {
      const href = useLoginHref();
      seen.push(href);
      return href;
    });

    expect(seen[0]).toBe('/login?next=%2Fstockist');
    expect(seen[seen.length - 1]).toBe('/login?next=%2Fstockist%3Ffrom%3De2e');
  });

  it('DD-AUTH-036 道筋が変わると更新し、前の頁の検索条件を引きずらない', () => {
    setLocation('/stockist', '?from=e2e');
    mockUsePathname.mockReturnValue('/stockist');
    const seen: string[] = [];
    const { result, rerender } = renderHook(() => {
      const href = useLoginHref();
      seen.push(href);
      return href;
    });
    expect(result.current).toBe('/login?next=%2Fstockist%3Ffrom%3De2e');

    setLocation('/news', '?page=2');
    mockUsePathname.mockReturnValue('/news');
    seen.length = 0;
    act(() => {
      rerender();
    });

    expect(seen[0]).toBe('/login?next=%2Fnews');
    expect(result.current).toBe('/login?next=%2Fnews%3Fpage%3D2');
  });
});
