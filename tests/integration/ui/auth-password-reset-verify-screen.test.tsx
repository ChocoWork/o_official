import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PasswordResetVerifyPage, { metadata } from '@/app/auth/password-reset/verify/page';

// 画面は /auth/password-reset/verify の頁（サーバー）→ VerifyClient（端末）を本物のまま通す。
// 外との境目だけ偽物にする: 転送・ルーター・通信（fetch）。
const redirectMock = jest.fn((url: string): never => {
  throw new Error(`NEXT_REDIRECT:${url}`);
});
const routerReplaceMock = jest.fn();
// 本物の useRouter も安定した参照を返すので、毎回同じ物を返す
const mockRouter = { replace: (...args: unknown[]) => routerReplaceMock(...args) };

jest.mock('next/navigation', () => ({
  redirect: (url: string) => redirectMock(url),
  useRouter: () => mockRouter,
}));

const fetchMock = jest.fn();

function linkResponse(ok: boolean, status = ok ? 200 : 400) {
  return { ok, status, json: async () => ({}) };
}

async function renderVerifyPage(searchParams: { token?: string }, options: { strict?: boolean } = {}) {
  const element = await PasswordResetVerifyPage({ searchParams: Promise.resolve(searchParams) });
  await act(async () => {
    render(options.strict ? <React.StrictMode>{element}</React.StrictMode> : element);
  });
}

describe('SCR-AUTH-006 /auth/password-reset/verify はメールのリンクの確かめを1回だけ自動で送り、新しいパスワードの欄へ直に進める', () => {
  const originalFetch = global.fetch;
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    fetchMock.mockResolvedValue(linkResponse(true));
    global.fetch = fetchMock as unknown as typeof fetch;
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    consoleErrorSpy.mockRestore();
  });

  describe('サーバーの描画', () => {
    it.each([
      ['token が無い', {}],
      ['token が空', { token: '' }],
    ])('SCR-AUTH-006 %s時は link_invalid 付きで申請の頁へ送り、印を消費しない（通信しない）', async (_label, query) => {
      await expect(PasswordResetVerifyPage({ searchParams: Promise.resolve(query) })).rejects.toThrow(
        'NEXT_REDIRECT:/auth/password-reset?error=link_invalid',
      );

      expect(redirectMock).toHaveBeenCalledWith('/auth/password-reset?error=link_invalid');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('SCR-AUTH-006 token があれば送らずに端末の部品を描く', async () => {
      await renderVerifyPage({ token: 'tok-1' });

      expect(redirectMock).not.toHaveBeenCalled();
      expect(screen.getByRole('heading', { level: 1, name: 'パスワード再設定' })).toBeInTheDocument();
    });

    it('SCR-AUTH-006 検索に載せない（noindex・nofollow）', () => {
      expect(metadata.robots).toEqual({ index: false, follow: false });
    });

    it('SCR-AUTH-006 頁を描くこと自体は何も消費しない（確かめの通信は端末が開いてから）', async () => {
      const element = await PasswordResetVerifyPage({ searchParams: Promise.resolve({ token: 'tok-1' }) });

      expect(fetchMock).not.toHaveBeenCalled();
      expect(element).toBeTruthy();
    });
  });

  describe('端末の確かめ', () => {
    it('SCR-AUTH-006 開いたら確認のボタンを押させずに、link へ token を POST で1回送る', async () => {
      fetchMock.mockReturnValue(new Promise(() => undefined));
      await renderVerifyPage({ token: 'tok-abc' });

      expect(screen.getByRole('status')).toHaveTextContent('確認中...');
      expect(screen.queryByRole('button')).toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('/api/auth/password-reset/link');
      expect(init.method).toBe('POST');
      expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
      expect(JSON.parse(init.body)).toEqual({ token: 'tok-abc' });
    });

    it('SCR-AUTH-006 送っている間は案内の入れ物を空にして置き、再試行の手段もログインへのリンクも出さない', async () => {
      fetchMock.mockReturnValue(new Promise(() => undefined));
      await renderVerifyPage({ token: 'tok-1' });

      expect(screen.getByRole('alert')).toBeEmptyDOMElement();
      expect(screen.queryByRole('button', { name: 'もう一度試す' })).toBeNull();
      expect(screen.queryByRole('link', { name: 'ログインへ' })).toBeNull();
    });

    it('SCR-AUTH-006 窓口が受けたら新しいパスワードの見せ方になる申請の頁へ置き換える', async () => {
      await renderVerifyPage({ token: 'tok-1' });

      await waitFor(() => expect(routerReplaceMock).toHaveBeenCalledWith('/auth/password-reset'));
      expect(routerReplaceMock).toHaveBeenCalledTimes(1);
    });

    it('SCR-AUTH-006 窓口が断ったら link_expired 付きで申請の頁へ置き換え、再試行の手段は出さない', async () => {
      fetchMock.mockResolvedValue(linkResponse(false, 400));
      await renderVerifyPage({ token: 'tok-used' });

      await waitFor(() =>
        expect(routerReplaceMock).toHaveBeenCalledWith('/auth/password-reset?error=link_expired'),
      );
      expect(screen.queryByRole('button', { name: 'もう一度試す' })).toBeNull();
    });

    it('SCR-AUTH-006 窓口が 429 や 500 で断った時も期限切れとして申請へ戻す', async () => {
      fetchMock.mockResolvedValue(linkResponse(false, 429));
      await renderVerifyPage({ token: 'tok-1' });

      await waitFor(() =>
        expect(routerReplaceMock).toHaveBeenCalledWith('/auth/password-reset?error=link_expired'),
      );
    });

    it('SCR-AUTH-006 開発時の Effect の二重実行でも token を2回送らない', async () => {
      await renderVerifyPage({ token: 'tok-1' }, { strict: true });

      await waitFor(() => expect(routerReplaceMock).toHaveBeenCalled());
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('SCR-AUTH-006 再描画しても token を2回送らない', async () => {
      const element = await PasswordResetVerifyPage({ searchParams: Promise.resolve({ token: 'tok-1' }) });
      let rerender: (ui: React.ReactElement) => void = () => undefined;
      await act(async () => {
        rerender = render(element).rerender;
      });
      await act(async () => {
        rerender(element);
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('通信の誤り', () => {
    it('SCR-AUTH-006 通信で落ちたら文と再試行のボタンとログインへのリンクを出し、申請の頁へは送らない', async () => {
      fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
      await renderVerifyPage({ token: 'tok-1' });

      expect(
        await screen.findByText('リンクの確認に失敗しました。時間をおいて再度お試しください。'),
      ).toHaveAttribute('role', 'alert');
      expect(screen.getByRole('button', { name: 'もう一度試す' })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'ログインへ' })).toHaveAttribute('href', '/login');
      expect(screen.queryByText('確認中...')).toBeNull();
      expect(routerReplaceMock).not.toHaveBeenCalled();
    });

    it('SCR-AUTH-006 再試行を押すと同じ token をもう一度送り、受けられたら申請の頁へ置き換える', async () => {
      const user = userEvent.setup();
      fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValueOnce(linkResponse(true));
      await renderVerifyPage({ token: 'tok-retry' });

      await user.click(await screen.findByRole('button', { name: 'もう一度試す' }));

      await waitFor(() => expect(routerReplaceMock).toHaveBeenCalledWith('/auth/password-reset'));
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ token: 'tok-retry' });
      expect(screen.queryByText('リンクの確認に失敗しました。時間をおいて再度お試しください。')).toBeNull();
    });

    it('SCR-AUTH-006 再試行で窓口に断られたら link_expired 付きで申請の頁へ置き換える', async () => {
      const user = userEvent.setup();
      fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValueOnce(linkResponse(false));
      await renderVerifyPage({ token: 'tok-1' });

      await user.click(await screen.findByRole('button', { name: 'もう一度試す' }));

      await waitFor(() =>
        expect(routerReplaceMock).toHaveBeenCalledWith('/auth/password-reset?error=link_expired'),
      );
    });

    it('SCR-AUTH-006 再試行も通信で落ちたら誤りの文と再試行の手段を出したままにする', async () => {
      const user = userEvent.setup();
      fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
      await renderVerifyPage({ token: 'tok-1' });

      await user.click(await screen.findByRole('button', { name: 'もう一度試す' }));

      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
      expect(
        await screen.findByText('リンクの確認に失敗しました。時間をおいて再度お試しください。'),
      ).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'もう一度試す' })).toBeInTheDocument();
    });
  });
});
