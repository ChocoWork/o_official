import { act, render, screen, waitFor } from '@testing-library/react';
import OAuthCallbackPage from '@/app/auth/callback/page';

/**
 * DD-AUTH-006 未使用（削除の判断待ち）の /auth/callback の頁。
 * code があれば窓口へ移し、無ければ me を聞いて next へ置き換える。
 */

const mockReplace = jest.fn();
// useSearchParams は同じ物を返す（Effect の依存が毎回替わらないようにする）
let mockSearchParams = new URLSearchParams();
let mockSuspend: Promise<never> | null = null;

jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mockReplace }),
  useSearchParams: () => {
    if (mockSuspend) throw mockSuspend;
    return mockSearchParams;
  },
}));

const originalFetch = globalThis.fetch;
const mockFetch = jest.fn();

function meResponse(body: unknown, ok = true) {
  return { ok, status: ok ? 200 : 401, json: async () => body } as Response;
}

function meResponseWithBrokenJson() {
  return {
    ok: true,
    status: 200,
    json: async () => {
      throw new SyntaxError('Unexpected end of JSON input');
    },
  } as unknown as Response;
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSearchParams = new URLSearchParams();
  mockSuspend = null;
  mockFetch.mockResolvedValue(meResponse({ authenticated: true }));
  globalThis.fetch = mockFetch as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  jest.restoreAllMocks();
});

describe('古い Google の戻りの頁（未使用）', () => {
  it('DD-AUTH-006 検索の問い合わせを待つ間は「認証処理中…」の待ち画面を出す', () => {
    mockSuspend = new Promise<never>(() => {});
    const { container } = render(<OAuthCallbackPage />);

    expect(screen.getByRole('heading', { name: 'サインインしています…' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('認証処理中…');
    expect(container.querySelector('.animate-spin')).not.toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('DD-AUTH-006 確認の最中は見出し・回る印・文を出し、ログインへのリンクは出さない', async () => {
    mockFetch.mockReturnValue(new Promise(() => {}));
    const { container } = render(<OAuthCallbackPage />);

    expect(screen.getByRole('heading', { name: 'サインインしています…' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('サインインしています…');
    expect(container.querySelector('.animate-spin')).not.toBeNull();
    expect(screen.queryByRole('link', { name: 'ログインに戻る' })).not.toBeInTheDocument();
  });

  it('DD-AUTH-006 code があれば問い合わせ全部を写して窓口へ移り、me は聞かない', async () => {
    mockSearchParams = new URLSearchParams('code=abc&state=xyz&next=%2Faccount');
    const locationReplace = spyLocationReplace();
    render(<OAuthCallbackPage />);

    await waitFor(() => expect(locationReplace).toHaveBeenCalledTimes(1));
    expect(locationReplace).toHaveBeenCalledWith(
      '/api/auth/oauth/callback?code=abc&state=xyz&next=%2Faccount',
    );
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('DD-AUTH-006 code が空文字なら窓口へは移らず me を聞く', async () => {
    mockSearchParams = new URLSearchParams('code=');
    const locationReplace = spyLocationReplace();
    render(<OAuthCallbackPage />);

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/auth/verified'));
    expect(locationReplace).not.toHaveBeenCalled();
  });

  it('DD-AUTH-006 code が無ければ me を聞き、ログイン済みなら既定の /auth/verified へ置き換える', async () => {
    render(<OAuthCallbackPage />);

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/auth/verified'));
    expect(mockFetch).toHaveBeenCalledWith('/api/auth/me', {
      method: 'GET',
      cache: 'no-store',
      credentials: 'same-origin',
    });
  });

  it.each([
    ['/ で始まる next はそのまま使う', '/account/orders', '/account/orders'],
    ['/ で始まらない next は /auth/verified にする', 'account', '/auth/verified'],
    ['http の住所の next は /auth/verified にする', 'https://evil.example/', '/auth/verified'],
    ['空の next は既定にする', '', '/auth/verified'],
  ])('DD-AUTH-006 %s', async (_label, next, expected) => {
    mockSearchParams = new URLSearchParams({ next });
    render(<OAuthCallbackPage />);

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith(expected));
    expect(mockReplace).toHaveBeenCalledTimes(1);
  });

  // 先頭が // の next は外の住所へ送れてしまう。直すまで「通る」を期待にしない（SEC-AUTH-026）。
  it.todo('DD-AUTH-006 //で始まる外の住所の next は /auth/verified にする');

  it.each([
    ['me が 200 以外', () => meResponse({ authenticated: true }, false)],
    ['本文が JSON でない', () => meResponseWithBrokenJson()],
    ['本文が null', () => meResponse(null)],
    ['本文が文字列', () => meResponse('authenticated')],
    ['本文が配列', () => meResponse([])],
    ['authenticated が無い', () => meResponse({})],
    ['authenticated が偽', () => meResponse({ authenticated: false })],
    ['authenticated が真に見える文字列', () => meResponse({ authenticated: 'true' })],
  ])('DD-AUTH-006 「%s」の時は失敗の文・ログインへのリンクを出し、移動しない', async (_label, build) => {
    mockFetch.mockResolvedValue(build());
    const { container } = render(<OAuthCallbackPage />);

    expect(
      await screen.findByRole('heading', { name: 'サインインできませんでした' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(
      '認証を完了できませんでした。ログイン画面からもう一度お試しください。',
    );
    expect(screen.getByRole('link', { name: 'ログインに戻る' })).toHaveAttribute('href', '/login');
    expect(container.querySelector('.animate-spin')).toBeNull();
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('DD-AUTH-006 通信が投げると「内部エラーが発生しました。」を出し、ログインへのリンクを出す', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockFetch.mockRejectedValue(new Error('network down'));
    render(<OAuthCallbackPage />);

    expect(
      await screen.findByRole('heading', { name: 'サインインできませんでした' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('内部エラーが発生しました。');
    expect(screen.getByRole('link', { name: 'ログインに戻る' })).toBeInTheDocument();
    expect(mockReplace).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith('OAuth callback page error', expect.any(Error));
  });

  describe('頁が閉じた後に me の答えが来た時', () => {
    async function settle() {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }

    it('DD-AUTH-006 ログイン済みの答えでも移動しない', async () => {
      const pending = deferred<Response>();
      mockFetch.mockReturnValue(pending.promise);
      const { unmount } = render(<OAuthCallbackPage />);
      await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));

      unmount();
      pending.resolve(meResponse({ authenticated: true }));
      await settle();

      expect(mockReplace).not.toHaveBeenCalled();
    });

    it('DD-AUTH-006 ログインできていない答えでも文を変えず、誤りも出さない', async () => {
      const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
      const pending = deferred<Response>();
      mockFetch.mockReturnValue(pending.promise);
      const { unmount } = render(<OAuthCallbackPage />);
      await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));

      unmount();
      pending.resolve(meResponse({ authenticated: false }));
      await settle();

      expect(mockReplace).not.toHaveBeenCalled();
      expect(consoleError).not.toHaveBeenCalled();
    });

    it('DD-AUTH-006 通信が投げても文を変えない', async () => {
      const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
      const pending = deferred<Response>();
      mockFetch.mockReturnValue(pending.promise);
      const { unmount } = render(<OAuthCallbackPage />);
      await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));

      unmount();
      pending.reject(new Error('network down'));
      await settle();

      expect(mockReplace).not.toHaveBeenCalled();
      // 記録は残すが、閉じた頁の状態は触らない（React の警告も出ない）
      expect(consoleError).toHaveBeenCalledTimes(1);
      expect(consoleError).toHaveBeenCalledWith('OAuth callback page error', expect.any(Error));
    });
  });
});
