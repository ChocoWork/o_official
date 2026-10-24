/**
 * /auth/verified の見せ方の移り変わり（STATE-AUTH-003）を確かめる結合テスト。
 * 読み込みから、未ログイン・一般の会員・管理画面へ・TOTP の見せ方のどれへ移るかは、`/api/auth/me` の答えで1回だけ決まる。
 * TOTP の見せ方の中では要素の有無で登録と確認を出し分け、自動の登録は1回だけ試す。
 * 実物の頁を描き、next/navigation・ログインの文脈・fetch だけを差し替えて、移った先と通信の回数を見る。
 */
import React from 'react';
import userEvent from '@testing-library/user-event';
import { act, render, screen, waitFor } from '@testing-library/react';
import VerifiedPage from '@/app/auth/verified/page';

const mockReplace = jest.fn();
const mockRefreshAuthState = jest.fn();
// 実物の useRouter は同じ物を返す（Effect の依存が毎回替わって me を聞き直さないように）
const mockRouter = { replace: mockReplace };

jest.mock('next/navigation', () => ({
  useRouter: () => mockRouter,
}));
jest.mock('@/contexts/LoginContext', () => ({
  useLogin: () => ({ refreshAuthState: mockRefreshAuthState }),
}));

const originalFetch = globalThis.fetch;
const mockFetch = jest.fn();

type Handler = () => Response | Promise<Response>;

function json(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function route(routes: Record<string, Handler>) {
  mockFetch.mockImplementation(async (url: string) => {
    const handler = routes[url];
    if (!handler) throw new Error(`unexpected fetch: ${url}`);
    return handler();
  });
}

function calls(url: string) {
  return mockFetch.mock.calls.filter(([called]) => called === url).length;
}

const me = (role: unknown, mfaVerified = false) => () =>
  json({ authenticated: true, user: { role, mfaVerified } });
const noFactorStatus = () => json({ data: { hasVerifiedFactor: false, factors: [] } });
const oneFactorStatus = () =>
  json({ data: { hasVerifiedFactor: true, factors: [{ id: 'f1', factorType: 'totp', friendlyName: 'iPhone' }] } });
const enrolled = () =>
  json({
    data: { factorId: 'new-factor', friendlyName: null, qrCode: 'data:image/svg+xml;base64,QR', secret: 'S', uri: 'u' },
  });

beforeEach(() => {
  jest.clearAllMocks();
  mockRefreshAuthState.mockResolvedValue(undefined);
  globalThis.fetch = mockFetch as unknown as typeof fetch;
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('/auth/verified の見せ方の移り変わり', () => {
  it('STATE-AUTH-003 読み込みは me の答えが返るまで続き、他の API は聞かず、どこへも移らない', () => {
    mockFetch.mockReturnValue(new Promise(() => {}));
    render(<VerifiedPage />);

    expect(screen.getByRole('status')).toHaveTextContent('サインインを確認しています…');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toBe('/api/auth/me');
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('STATE-AUTH-003 me が 200 以外なら読み込みから未ログインへ移る', async () => {
    route({ '/api/auth/me': () => json({ authenticated: true, user: { role: 'admin', mfaVerified: true } }, 401) });
    render(<VerifiedPage />);

    expect(await screen.findByRole('link', { name: 'ログインページへ' })).toHaveAttribute('href', '/login');
    expect(mockReplace).not.toHaveBeenCalled();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('STATE-AUTH-003 me が authenticated を真にしなければ読み込みから未ログインへ移る', async () => {
    route({ '/api/auth/me': () => json({ authenticated: false }) });
    render(<VerifiedPage />);

    expect(await screen.findByRole('link', { name: 'ログインページへ' })).toBeInTheDocument();
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('STATE-AUTH-003 me の本文が JSON でなくても読み込みから未ログインへ移る', async () => {
    route({
      '/api/auth/me': () =>
        ({
          ok: true,
          status: 200,
          json: async () => {
            throw new SyntaxError('Unexpected end of JSON input');
          },
        }) as unknown as Response,
    });
    render(<VerifiedPage />);

    expect(await screen.findByRole('link', { name: 'ログインページへ' })).toBeInTheDocument();
  });

  it('STATE-AUTH-003 役割が user なら読み込みから一般の会員へ移り、0.8 秒後にアカウントへ移る', async () => {
    jest.useFakeTimers();
    route({ '/api/auth/me': me('user') });
    render(<VerifiedPage />);

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('確認完了。アカウントへ移動します…'));
    expect(mockReplace).not.toHaveBeenCalled();
    act(() => {
      jest.advanceTimersByTime(800);
    });
    expect(mockReplace).toHaveBeenCalledTimes(1);
    expect(mockReplace).toHaveBeenCalledWith('/account');
    expect(calls('/api/auth/mfa/status')).toBe(0);
  });

  it.each([['guest'], [null], [undefined], [42]])(
    'STATE-AUTH-003 役割が %p のように読めなければ user と同じく一般の会員へ移る',
    async (role) => {
      jest.useFakeTimers();
      route({ '/api/auth/me': me(role, true) });
      render(<VerifiedPage />);

      await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('確認完了。アカウントへ移動します…'));
      act(() => {
        jest.advanceTimersByTime(800);
      });
      expect(mockReplace).toHaveBeenCalledWith('/account');
    },
  );

  it('STATE-AUTH-003 一般の会員が待つ間に画面を離れたら、アカウントへは移さない', async () => {
    jest.useFakeTimers();
    route({ '/api/auth/me': me('user') });
    const { unmount } = render(<VerifiedPage />);

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('確認完了。アカウントへ移動します…'));
    unmount();
    act(() => {
      jest.advanceTimersByTime(2000);
    });
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('STATE-AUTH-003 管理者で aal2 済みなら TOTP の見せ方を経ず管理画面へ移る', async () => {
    route({ '/api/auth/me': me('admin', true) });
    render(<VerifiedPage />);

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/admin'));
    expect(calls('/api/auth/mfa/status')).toBe(0);
    expect(calls('/api/auth/mfa/enroll-totp')).toBe(0);
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('STATE-AUTH-003 サポーターで aal2 でなければ読み込みから TOTP の見せ方へ移り、要素を聞く', async () => {
    route({ '/api/auth/me': me('supporter'), '/api/auth/mfa/status': oneFactorStatus });
    render(<VerifiedPage />);

    expect(await screen.findByText('2要素認証コードを入力してください。')).toBeInTheDocument();
    expect(calls('/api/auth/me')).toBe(1);
    expect(calls('/api/auth/mfa/status')).toBe(1);
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('STATE-AUTH-003 TOTP の見せ方で要素が無ければ登録の案内を出し、自動で登録して QR を出す', async () => {
    route({
      '/api/auth/me': me('admin'),
      '/api/auth/mfa/status': noFactorStatus,
      '/api/auth/mfa/enroll-totp': enrolled,
    });
    render(<VerifiedPage />);

    expect(await screen.findByRole('img', { name: 'TOTP QR code' })).toBeInTheDocument();
    expect(calls('/api/auth/mfa/enroll-totp')).toBe(1);
    expect(screen.getByText('認証アプリでQRコードを読み取り、生成されたコードを入力してください。')).toBeInTheDocument();
  });

  it('STATE-AUTH-003 TOTP の見せ方で要素が有れば自動の登録はせずコード入力を出す', async () => {
    route({ '/api/auth/me': me('admin'), '/api/auth/mfa/status': oneFactorStatus });
    render(<VerifiedPage />);

    await screen.findByRole('textbox', { name: '認証コード（6〜8桁）' });
    expect(calls('/api/auth/mfa/enroll-totp')).toBe(0);
    expect(screen.queryByRole('img', { name: 'TOTP QR code' })).not.toBeInTheDocument();
  });

  it('STATE-AUTH-003 自動の登録は1回だけで、失敗しても勝手に繰り返さない', async () => {
    route({
      '/api/auth/me': me('admin'),
      '/api/auth/mfa/status': noFactorStatus,
      '/api/auth/mfa/enroll-totp': () => json({ error: 'x' }, 500),
    });
    render(<VerifiedPage />);

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('2要素認証の登録に失敗しました。'),
    );
    await screen.findByRole('button', { name: '2要素認証（TOTP）を登録' });
    expect(calls('/api/auth/mfa/enroll-totp')).toBe(1);
  });

  it('STATE-AUTH-003 自動の登録が 409 なら「登録済み」の文を出す', async () => {
    route({
      '/api/auth/me': me('admin'),
      '/api/auth/mfa/status': noFactorStatus,
      '/api/auth/mfa/enroll-totp': () => json({ error: 'exists' }, 409),
    });
    render(<VerifiedPage />);

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        '既に2要素認証は登録済みです。コード入力へ進んでください。',
      ),
    );
    expect(calls('/api/auth/mfa/enroll-totp')).toBe(1);
  });

  it('STATE-AUTH-003 自動の登録の最中は案内を「セットアップ中」に替える', async () => {
    let release!: (value: Response) => void;
    route({
      '/api/auth/me': me('admin'),
      '/api/auth/mfa/status': noFactorStatus,
      '/api/auth/mfa/enroll-totp': () => new Promise<Response>((resolve) => (release = resolve)),
    });
    render(<VerifiedPage />);

    expect(await screen.findByText('2要素認証（TOTP）をセットアップ中です…')).toBeInTheDocument();
    await act(async () => {
      release(enrolled());
    });
    expect(await screen.findByRole('img', { name: 'TOTP QR code' })).toBeInTheDocument();
  });

  it('STATE-AUTH-003 mfa/status が失敗しても TOTP の見せ方へ移り、そこで自動の登録を1回試す（一般の会員にも出る推定の挙動）', async () => {
    route({
      '/api/auth/me': me('admin'),
      '/api/auth/mfa/status': () => json({ error: 'x' }, 500),
      '/api/auth/mfa/enroll-totp': () => json({ error: 'x' }, 500),
    });
    render(<VerifiedPage />);

    expect(await screen.findByText(/Google Authenticator などの認証アプリに表示される/)).toBeInTheDocument();
    await waitFor(() => expect(calls('/api/auth/mfa/enroll-totp')).toBe(1));
    expect(screen.queryByRole('link', { name: 'ログインページへ' })).not.toBeInTheDocument();
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('STATE-AUTH-003 me の通信が失敗したら TOTP の見せ方へ移り、どこへも移らず、未ログインの導線も出さない', async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url === '/api/auth/me') throw new TypeError('network down');
      if (url === '/api/auth/mfa/enroll-totp') return json({ error: 'x' }, 500);
      throw new Error(`unexpected fetch: ${url}`);
    });
    render(<VerifiedPage />);

    expect(await screen.findByText(/Google Authenticator などの認証アプリに表示される/)).toBeInTheDocument();
    expect(console.error).toHaveBeenCalledWith('Failed to initialize auth verified page:', expect.any(TypeError));
    expect(calls('/api/auth/mfa/status')).toBe(0);
    expect(screen.queryByRole('link', { name: 'ログインページへ' })).not.toBeInTheDocument();
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('STATE-AUTH-003 me が返る前に画面を離れたら、状態も移動も起こさない', async () => {
    let release!: (value: Response) => void;
    route({ '/api/auth/me': () => new Promise<Response>((resolve) => (release = resolve)) });
    const { unmount } = render(<VerifiedPage />);

    unmount();
    await act(async () => {
      release(json({ authenticated: true, user: { role: 'admin', mfaVerified: true } }));
    });
    expect(mockReplace).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });

  it('STATE-AUTH-003 管理者の me が返る前に離れたら、要素の問い合わせもしない', async () => {
    let release!: (value: Response) => void;
    route({
      '/api/auth/me': () => new Promise<Response>((resolve) => (release = resolve)),
      '/api/auth/mfa/status': oneFactorStatus,
    });
    const { unmount } = render(<VerifiedPage />);

    unmount();
    await act(async () => {
      release(json({ authenticated: true, user: { role: 'admin', mfaVerified: false } }));
    });
    expect(calls('/api/auth/mfa/status')).toBe(0);
  });

  it('STATE-AUTH-003 TOTP の確認が通ったら管理画面へ移り、同期を先に終える', async () => {
    const order: string[] = [];
    mockRefreshAuthState.mockImplementation(async () => {
      order.push('refresh');
    });
    mockReplace.mockImplementation(() => {
      order.push('replace');
    });
    route({
      '/api/auth/me': me('admin'),
      '/api/auth/mfa/status': oneFactorStatus,
      '/api/auth/mfa/verify': () => json({ data: { verified: true } }),
    });
    const user = userEvent.setup();
    render(<VerifiedPage />);

    await user.type(await screen.findByRole('textbox', { name: '認証コード（6〜8桁）' }), '123456');
    await user.click(screen.getByRole('button', { name: '2要素認証を完了' }));

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/admin'));
    expect(order).toEqual(['refresh', 'replace']);
  });
});
