/**
 * 未使用（削除の判断待ち）の古い Google の戻りの画面（SCR-AUTH-008: /auth/callback）を確かめる結合テスト。
 * 実物の頁とそれを包む待ち画面を描き、next/navigation と fetch だけを差し替えて、
 * 確認中の見た目、成功した時の移動、失敗した時の案内とログインへの戻り、code を窓口へ渡す動きを見る。
 */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import OAuthCallbackPage from '@/app/auth/callback/page';

const mockReplace = jest.fn();
// 実物の useRouter は同じ物を返す（Effect の依存が毎回替わらないように）
const mockRouter = { replace: mockReplace };
let mockSearchParams = new URLSearchParams();
let mockSuspend: Promise<never> | null = null;

jest.mock('next/navigation', () => ({
  useRouter: () => mockRouter,
  useSearchParams: () => {
    if (mockSuspend) throw mockSuspend;
    return mockSearchParams;
  },
}));

const originalFetch = globalThis.fetch;
const mockFetch = jest.fn();

function json(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

/**
 * jsdom の window.location.replace は差し替えられない（作り替え不可）ので、
 * 内側の実装（impl）の replace を見張り、移動先の文字列だけを受け取って実際の移動はさせない。
 */
function spyLocationReplace() {
  const implSymbol = Object.getOwnPropertySymbols(window.location).find(
    (symbol) => symbol.description === 'impl',
  );
  if (!implSymbol) throw new Error('jsdom の Location の impl が見つからない');
  const impl = (window.location as unknown as Record<symbol, { replace: (url: string) => void }>)[
    implSymbol
  ];
  return jest.spyOn(impl, 'replace').mockImplementation(() => {});
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSearchParams = new URLSearchParams();
  mockSuspend = null;
  mockFetch.mockResolvedValue(json({ authenticated: true }));
  globalThis.fetch = mockFetch as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  jest.restoreAllMocks();
});

describe('/auth/callback の画面（未使用）', () => {
  it('SCR-AUTH-008 検索の問い合わせを待つ間は見出しと「認証処理中…」の status を回る印つきで出す', () => {
    mockSuspend = new Promise<never>(() => {});
    const { container } = render(<OAuthCallbackPage />);

    expect(screen.getByRole('heading', { level: 1, name: 'サインインしています…' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('認証処理中…');
    expect(container.querySelector('.animate-spin')).not.toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('SCR-AUTH-008 確認の最中は見出し・回る印・文を出し、ログインへのリンクは出さない', () => {
    mockFetch.mockReturnValue(new Promise(() => {}));
    const { container } = render(<OAuthCallbackPage />);

    expect(screen.getByRole('heading', { level: 1, name: 'サインインしています…' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('サインインしています…');
    expect(container.querySelector('.animate-spin')).not.toBeNull();
    expect(screen.queryByRole('link', { name: 'ログインに戻る' })).not.toBeInTheDocument();
  });

  it('SCR-AUTH-008 code が無くログイン済みなら me を聞いて既定の /auth/verified へ置き換える', async () => {
    render(<OAuthCallbackPage />);

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/auth/verified'));
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith('/api/auth/me', {
      method: 'GET',
      cache: 'no-store',
      credentials: 'same-origin',
    });
  });

  it('SCR-AUTH-008 next が / で始まれば移動先に使い、始まらなければ既定に戻す', async () => {
    mockSearchParams = new URLSearchParams({ next: '/account/orders' });
    const first = render(<OAuthCallbackPage />);
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/account/orders'));
    first.unmount();

    mockReplace.mockClear();
    mockSearchParams = new URLSearchParams({ next: 'https://evil.example/' });
    render(<OAuthCallbackPage />);
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/auth/verified'));
  });

  it('SCR-AUTH-008 code があれば問い合わせ全部を写して窓口へ移り、me は聞かず置き換えもしない', async () => {
    mockSearchParams = new URLSearchParams('code=abc&state=xyz&next=%2Faccount');
    const locationReplace = spyLocationReplace();
    render(<OAuthCallbackPage />);

    await waitFor(() => expect(locationReplace).toHaveBeenCalledTimes(1));
    expect(locationReplace).toHaveBeenCalledWith(
      '/api/auth/oauth/callback?code=abc&state=xyz&next=%2Faccount',
    );
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockReplace).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent('サインインしています…');
  });

  it('SCR-AUTH-008 未ログインなら失敗の見出しと案内を出し、ログインへのリンクを出して回る印を消す', async () => {
    mockFetch.mockResolvedValue(json({ authenticated: false }));
    const { container } = render(<OAuthCallbackPage />);

    expect(await screen.findByRole('heading', { level: 1, name: 'サインインできませんでした' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(
      '認証を完了できませんでした。ログイン画面からもう一度お試しください。',
    );
    expect(screen.getByRole('link', { name: 'ログインに戻る' })).toHaveAttribute('href', '/login');
    expect(container.querySelector('.animate-spin')).toBeNull();
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('SCR-AUTH-008 me が 200 以外なら authenticated が真でも失敗にする', async () => {
    mockFetch.mockResolvedValue(json({ authenticated: true }, 401));
    render(<OAuthCallbackPage />);

    expect(await screen.findByRole('link', { name: 'ログインに戻る' })).toBeInTheDocument();
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('SCR-AUTH-008 me の本文が JSON でなければ失敗にする', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected end of JSON input');
      },
    } as unknown as Response);
    render(<OAuthCallbackPage />);

    expect(await screen.findByRole('link', { name: 'ログインに戻る' })).toBeInTheDocument();
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('SCR-AUTH-008 通信が例外で落ちたら「内部エラー」の案内とログインへのリンクを出す', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    mockFetch.mockRejectedValue(new TypeError('network down'));
    render(<OAuthCallbackPage />);

    expect(await screen.findByRole('heading', { level: 1, name: 'サインインできませんでした' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('内部エラーが発生しました。');
    expect(screen.getByRole('link', { name: 'ログインに戻る' })).toHaveAttribute('href', '/login');
    expect(console.error).toHaveBeenCalledWith('OAuth callback page error', expect.any(TypeError));
  });

  it('SCR-AUTH-008 me が返る前に画面を離れたら、置き換えをしない', async () => {
    let release!: (value: Response) => void;
    mockFetch.mockReturnValue(new Promise<Response>((resolve) => (release = resolve)));
    const { unmount } = render(<OAuthCallbackPage />);

    unmount();
    release(json({ authenticated: true }));
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockReplace).not.toHaveBeenCalled();
  });
});
