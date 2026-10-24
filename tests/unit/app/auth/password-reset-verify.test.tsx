import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PasswordResetVerifyPage, { metadata } from '@/app/auth/password-reset/verify/page';
import VerifyClient from '@/app/auth/password-reset/verify/VerifyClient';

/**
 * DD-AUTH-004 パスワード再設定のメールのリンクの先（頁と確かめの部品）。
 * 頁は token の有無で転送か部品かを決め、部品は到達時に 1 回だけ窓口へ確かめを送る。
 */

const mockReplace = jest.fn();
const mockRedirect = jest.fn((url: string) => {
  throw new Error(`NEXT_REDIRECT:${url}`);
});
// router は毎回同じ物を返す（本物の useRouter も安定した参照を返す）
const mockRouter = { replace: mockReplace };

jest.mock('next/navigation', () => ({
  useRouter: () => mockRouter,
  redirect: (url: string) => mockRedirect(url),
}));

const originalFetch = globalThis.fetch;
const mockFetch = jest.fn();

function response(ok: boolean, status = ok ? 200 : 400) {
  return { ok, status, json: async () => ({}) } as Response;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockFetch.mockResolvedValue(response(true));
  globalThis.fetch = mockFetch as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  jest.restoreAllMocks();
});

describe('パスワード再設定のリンクの頁', () => {
  it('DD-AUTH-004 token があれば確かめの部品に token を渡して描く', async () => {
    const element = await PasswordResetVerifyPage({
      searchParams: Promise.resolve({ token: 'tok-abc' }),
    });

    expect(mockRedirect).not.toHaveBeenCalled();
    expect(element.type).toBe(VerifyClient);
    expect(element.props).toEqual({ token: 'tok-abc' });
  });

  it.each([
    ['token が無い', {}],
    ['token が空文字', { token: '' }],
  ])('DD-AUTH-004 「%s」の時は link_invalid へ転送し、部品を描かない', async (_label, query) => {
    await expect(
      PasswordResetVerifyPage({ searchParams: Promise.resolve(query) }),
    ).rejects.toThrow('NEXT_REDIRECT:/auth/password-reset?error=link_invalid');

    expect(mockRedirect).toHaveBeenCalledWith('/auth/password-reset?error=link_invalid');
  });

  it('DD-AUTH-004 検索エンジンに載せない（noindex・nofollow）', () => {
    expect(metadata.robots).toEqual({ index: false, follow: false });
  });
});

describe('パスワード再設定のリンクの確かめの部品', () => {
  it('DD-AUTH-004 描いた直後は見出しと「確認中...」を出し、再試行の手段は出さない', async () => {
    mockFetch.mockReturnValue(new Promise(() => {}));
    render(<VerifyClient token="tok-1" />);

    expect(screen.getByRole('heading', { name: 'パスワード再設定' })).toBeInTheDocument();
    expect(screen.getByText('確認中...')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'もう一度試す' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'ログインへ' })).not.toBeInTheDocument();
    // 案内の入れ物は常に置き、誤りが無いあいだは空
    expect(screen.getByRole('alert')).toBeEmptyDOMElement();
  });

  it('DD-AUTH-004 token を本文に入れて窓口へ 1 回だけ送る', async () => {
    mockFetch.mockReturnValue(new Promise(() => {}));
    render(<VerifyClient token="tok-1" />);

    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
    expect(mockFetch).toHaveBeenCalledWith('/api/auth/password-reset/link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'tok-1' }),
    });
  });

  it('DD-AUTH-004 窓口が成功なら /auth/password-reset へ置き換える', async () => {
    render(<VerifyClient token="tok-1" />);

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/auth/password-reset'));
    expect(mockReplace).toHaveBeenCalledTimes(1);
  });

  it('DD-AUTH-004 窓口が断る（200 以外）と link_expired へ置き換える', async () => {
    mockFetch.mockResolvedValue(response(false, 400));
    render(<VerifyClient token="tok-1" />);

    await waitFor(() =>
      expect(mockReplace).toHaveBeenCalledWith('/auth/password-reset?error=link_expired'),
    );
    expect(mockReplace).toHaveBeenCalledTimes(1);
  });

  it('DD-AUTH-004 二重の実行（StrictMode）でも窓口へは 1 回しか送らない', async () => {
    render(
      <React.StrictMode>
        <VerifyClient token="tok-1" />
      </React.StrictMode>,
    );

    await waitFor(() => expect(mockReplace).toHaveBeenCalled());
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('DD-AUTH-004 再描画で token が替わっても送った印が立っていれば送り直さない', async () => {
    const { rerender } = render(<VerifyClient token="tok-1" />);
    await waitFor(() => expect(mockReplace).toHaveBeenCalledTimes(1));

    rerender(<VerifyClient token="tok-2" />);
    await act(async () => {});

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('DD-AUTH-004 通信が投げると文と「もう一度試す」「ログインへ」を出し、置き換えない', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockFetch.mockRejectedValue(new Error('network down'));
    render(<VerifyClient token="tok-1" />);

    expect(
      await screen.findByText('リンクの確認に失敗しました。時間をおいて再度お試しください。'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'もう一度試す' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'ログインへ' })).toHaveAttribute('href', '/login');
    expect(screen.queryByText('確認中...')).not.toBeInTheDocument();
    expect(mockReplace).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith(expect.any(Error));
  });

  it('DD-AUTH-004 「もう一度試す」で送り直し、文を消して確認中に戻り、成功なら置き換える', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const user = userEvent.setup();
    mockFetch.mockRejectedValueOnce(new Error('network down'));
    render(<VerifyClient token="tok-1" />);

    await user.click(await screen.findByRole('button', { name: 'もう一度試す' }));

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/auth/password-reset'));
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(screen.queryByText('リンクの確認に失敗しました。時間をおいて再度お試しください。')).not.toBeInTheDocument();
  });

  it('DD-AUTH-004 送り直しも投げたら、また文と再試行の手段を出す', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const user = userEvent.setup();
    mockFetch.mockRejectedValue(new Error('network down'));
    render(<VerifyClient token="tok-1" />);

    await user.click(await screen.findByRole('button', { name: 'もう一度試す' }));

    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
    expect(
      await screen.findByText('リンクの確認に失敗しました。時間をおいて再度お試しください。'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'もう一度試す' })).toBeInTheDocument();
    expect(mockReplace).not.toHaveBeenCalled();
  });
});
