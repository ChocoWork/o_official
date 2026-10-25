/**
 * ログイン後の振り分けと TOTP の画面（SCR-AUTH-007: /auth/verified）を確かめる結合テスト。
 * 実物の頁・ボタン・選択欄・読み上げの部品を描き、next/navigation・ログインの文脈・fetch だけを差し替えて、
 * 見た目の骨格（見出し・ヘアライン・中央寄せ）、未ログインの導線、一般の会員の案内、管理者・サポーターの TOTP の
 * 登録と確認（QR・秘密・選択欄・コード入力）、確認が通った時の同期と移動を見る。
 */
import React from 'react';
import userEvent from '@testing-library/user-event';
import { act, render, screen, waitFor, within } from '@testing-library/react';
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

type Routes = Record<string, () => Response | Promise<Response>>;

function json(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function route(routes: Routes) {
  mockFetch.mockImplementation(async (url: string) => {
    const handler = routes[url];
    if (!handler) throw new Error(`unexpected fetch: ${url}`);
    return handler();
  });
}

// 誤りの入れ物は空のうちも role="alert" で置いてあるので、現れるのを待たず中身が入るのを待つ
async function expectAlert(text: string) {
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(text));
}

const adminNotVerified =() => json({ authenticated: true, user: { role: 'admin', mfaVerified: false } });
const oneFactorStatus = () =>
  json({ data: { hasVerifiedFactor: true, factors: [{ id: 'f1', factorType: 'totp', friendlyName: 'iPhone' }] } });
const noFactorStatus = () => json({ data: { hasVerifiedFactor: false, factors: [] } });
const enrolled = () =>
  json({
    data: {
      factorId: 'new-factor',
      friendlyName: null,
      qrCode: 'data:image/svg+xml;base64,QR',
      secret: 'SECRET123',
      uri: 'otpauth://totp/x?secret=SECRET123',
    },
  });

beforeEach(() => {
  jest.clearAllMocks();
  mockRefreshAuthState.mockResolvedValue(undefined);
  globalThis.fetch = mockFetch as unknown as typeof fetch;
  // SingleSelect は文字の幅を測るために canvas の getContext を呼ぶ（jsdom は未実装で console.error を出す）
  jest.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('/auth/verified の画面', () => {
  it('SCR-AUTH-007 ブランドの見出しと糸のヘアラインを中央寄せの枠に出す', () => {
    mockFetch.mockReturnValue(new Promise(() => {}));
    const { container } = render(<VerifiedPage />);

    expect(screen.getByRole('heading', { level: 1, name: 'Le Fil des Heures' })).toBeInTheDocument();
    expect(container.firstElementChild).toHaveClass('items-center', 'justify-center', 'text-center');
    expect(container.querySelector('span[aria-hidden="true"].w-px')).not.toBeNull();
  });

  it('SCR-AUTH-007 確認の最中は回る印つきの status で「サインインを確認しています…」を出す', () => {
    mockFetch.mockReturnValue(new Promise(() => {}));
    const { container } = render(<VerifiedPage />);

    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('サインインを確認しています…');
    expect(status.querySelector('.animate-spin')).not.toBeNull();
    expect(container.querySelector('a[href="/login"]')).toBeNull();
  });

  it('SCR-AUTH-007 未ログインには /login へのリンクを出し、確認中の status は消す', async () => {
    route({ '/api/auth/me': () => json({ authenticated: false }) });
    render(<VerifiedPage />);

    expect(await screen.findByText('ログインが必要です。ログイン後に再度お試しください。')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'ログインページへ' })).toHaveAttribute('href', '/login');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(mockReplace).not.toHaveBeenCalled();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('SCR-AUTH-007 一般の会員には同じ status の中身を「確認完了」に替え、リンクを置いて 0.8 秒後に post-login が返した戻り先へ置き換える', async () => {
    jest.useFakeTimers();
    route({
      '/api/auth/me': () => json({ authenticated: true, user: { role: 'user', mfaVerified: false } }),
      '/api/auth/post-login': () => json({ redirectTo: '/item/3?color=red', needsMfa: false }),
    });
    render(<VerifiedPage />);

    const status = screen.getByRole('status');
    await waitFor(() => expect(status).toHaveTextContent('確認完了。移動します…'));
    expect(screen.getByRole('status')).toBe(status);
    expect(screen.getByRole('link', { name: 'トップへ' })).toHaveAttribute('href', '/');
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();

    act(() => {
      jest.advanceTimersByTime(799);
    });
    expect(mockReplace).not.toHaveBeenCalled();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    await act(async () => {
      jest.advanceTimersByTime(1);
    });
    expect(mockReplace).toHaveBeenCalledWith('/item/3?color=red');
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch).toHaveBeenLastCalledWith('/api/auth/post-login', {
      method: 'POST',
      cache: 'no-store',
      credentials: 'same-origin',
    });
  });

  it.each(['admin', 'supporter'])(
    'SCR-AUTH-007 %s が aal2 済みなら TOTP を出さず /admin へ置き換える',
    async (role) => {
      route({
        '/api/auth/me': () => json({ authenticated: true, user: { role, mfaVerified: true } }),
        '/api/auth/post-login': () => json({ redirectTo: '/admin', needsMfa: false }),
      });
      render(<VerifiedPage />);

      await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/admin'));
      expect(screen.getByRole('status')).toHaveTextContent('認証が完了しました。管理画面へ移動します…');
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    },
  );

  it('SCR-AUTH-007 確かめ済みの要素が無い管理者には自動で登録して QR・秘密・コード入力を出す', async () => {
    route({
      '/api/auth/me': adminNotVerified,
      '/api/auth/mfa/status': noFactorStatus,
      '/api/auth/mfa/enroll-totp': enrolled,
    });
    render(<VerifiedPage />);

    expect(await screen.findByRole('img', { name: 'TOTP QR code' })).toHaveAttribute(
      'src',
      'data:image/svg+xml;base64,QR',
    );
    expect(screen.getByText('認証アプリでQRコードを読み取り、生成されたコードを入力してください。')).toBeInTheDocument();
    expect(screen.getByText('シークレット: SECRET123')).toBeInTheDocument();
    expect(screen.getByText('セットアップURI: otpauth://totp/x?secret=SECRET123')).toBeInTheDocument();
    expect(screen.getByText('手動で入力する場合はこちら')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: '認証コード（6〜8桁）' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '2要素認証を完了' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: '2要素認証（TOTP）を登録' })).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();

    const enrollCall = mockFetch.mock.calls.find(([url]) => url === '/api/auth/mfa/enroll-totp');
    expect(enrollCall?.[1]).toMatchObject({ method: 'POST', credentials: 'same-origin' });
  });

  it('SCR-AUTH-007 要素が1つある管理者には登録せず選択欄も出さずコード入力だけを出す', async () => {
    route({ '/api/auth/me': adminNotVerified, '/api/auth/mfa/status': oneFactorStatus });
    render(<VerifiedPage />);

    expect(await screen.findByText('2要素認証コードを入力してください。')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: '認証コード（6〜8桁）' })).toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.queryByRole('img', { name: 'TOTP QR code' })).not.toBeInTheDocument();
    expect(mockFetch.mock.calls.some(([url]) => url === '/api/auth/mfa/enroll-totp')).toBe(false);
  });

  it('SCR-AUTH-007 要素が2つ以上ある管理者には選択欄を出し、名前が無ければ種類を、どちらも無ければ既定の名を出す', async () => {
    route({
      '/api/auth/me': adminNotVerified,
      '/api/auth/mfa/status': () =>
        json({
          data: {
            hasVerifiedFactor: true,
            factors: [
              { id: 'f1', factorType: 'totp', friendlyName: 'iPhone' },
              { id: 'f2', factorType: 'totp', friendlyName: null },
              { id: 'f3', factorType: '', friendlyName: null },
            ],
          },
        }),
    });
    render(<VerifiedPage />);

    const select = await screen.findByRole('combobox', { name: '認証要素' });
    const labels = within(select).getAllByRole('option').map((option) => option.textContent);
    expect(labels).toEqual(['iPhone', 'totp', 'MFA Factor']);
    expect(select).toHaveValue('f1');
  });

  it('SCR-AUTH-007 コードが 6〜8 桁の数字でなければ通信せずに誤りを出し、数字以外は入力で落とす', async () => {
    const user = userEvent.setup();
    route({ '/api/auth/me': adminNotVerified, '/api/auth/mfa/status': oneFactorStatus });
    render(<VerifiedPage />);

    const input = await screen.findByRole('textbox', { name: '認証コード（6〜8桁）' });
    await user.type(input, 'a1b2c');
    expect(input).toHaveValue('12');
    await user.click(screen.getByRole('button', { name: '2要素認証を完了' }));

    await expectAlert('認証コードは6〜8桁の数字で入力してください。');
    expect(mockFetch.mock.calls.some(([url]) => url === '/api/auth/mfa/verify')).toBe(false);
    await user.clear(input);
    await user.type(input, '123456789');
    expect(input).toHaveValue('12345678');
  });

  it('SCR-AUTH-007 確認が通ったら全体のログインの状態を同期し直してから /admin へ置き換える', async () => {
    const user = userEvent.setup();
    const order: string[] = [];
    mockRefreshAuthState.mockImplementation(async () => {
      order.push('refresh');
    });
    mockReplace.mockImplementation(() => {
      order.push('replace');
    });
    route({
      '/api/auth/me': adminNotVerified,
      '/api/auth/mfa/status': noFactorStatus,
      '/api/auth/mfa/enroll-totp': enrolled,
      '/api/auth/mfa/verify': () => json({ data: { verified: true } }),
    });
    render(<VerifiedPage />);

    await user.type(await screen.findByRole('textbox', { name: '認証コード（6〜8桁）' }), '654321');
    await user.click(screen.getByRole('button', { name: '2要素認証を完了' }));

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/admin'));
    expect(order).toEqual(['refresh', 'replace']);
    const verifyCall = mockFetch.mock.calls.find(([url]) => url === '/api/auth/mfa/verify');
    expect(verifyCall?.[1]).toMatchObject({ method: 'POST', credentials: 'same-origin' });
    expect(JSON.parse(String(verifyCall?.[1]?.body))).toEqual({ factorId: 'new-factor', code: '654321' });
    expect(screen.getByText('2要素認証が完了しました。管理画面へ移動します…')).toBeInTheDocument();
  });

  it('SCR-AUTH-007 選択欄で選んだ要素の ID と入力したコードで確認する', async () => {
    const user = userEvent.setup();
    route({
      '/api/auth/me': adminNotVerified,
      '/api/auth/mfa/status': () =>
        json({
          data: {
            hasVerifiedFactor: true,
            factors: [
              { id: 'f1', factorType: 'totp', friendlyName: 'iPhone' },
              { id: 'f2', factorType: 'totp', friendlyName: 'iPad' },
            ],
          },
        }),
      '/api/auth/mfa/verify': () => json({ data: { verified: true } }),
    });
    render(<VerifiedPage />);

    await user.selectOptions(await screen.findByRole('combobox', { name: '認証要素' }), 'f2');
    await user.type(screen.getByRole('textbox', { name: '認証コード（6〜8桁）' }), '111222');
    await user.click(screen.getByRole('button', { name: '2要素認証を完了' }));

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/admin'));
    const verifyCall = mockFetch.mock.calls.find(([url]) => url === '/api/auth/mfa/verify');
    expect(JSON.parse(String(verifyCall?.[1]?.body))).toEqual({ factorId: 'f2', code: '111222' });
  });

  it('SCR-AUTH-007 確認に失敗したら /admin へ移らず誤りを出し、もう一度押せる', async () => {
    const user = userEvent.setup();
    route({
      '/api/auth/me': adminNotVerified,
      '/api/auth/mfa/status': oneFactorStatus,
      '/api/auth/mfa/verify': () => json({ error: 'invalid' }, 400),
    });
    render(<VerifiedPage />);

    await user.type(await screen.findByRole('textbox', { name: '認証コード（6〜8桁）' }), '000000');
    await user.click(screen.getByRole('button', { name: '2要素認証を完了' }));

    await expectAlert('2要素認証コードの検証に失敗しました。');
    expect(mockRefreshAuthState).not.toHaveBeenCalled();
    expect(mockReplace).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '2要素認証を完了' })).toBeEnabled();
  });

  it('SCR-AUTH-007 検証の最中はボタンを「検証中...」にして押せなくし、検証済みの印が無ければ失敗にする', async () => {
    const user = userEvent.setup();
    let release!: (value: Response) => void;
    route({
      '/api/auth/me': adminNotVerified,
      '/api/auth/mfa/status': oneFactorStatus,
      '/api/auth/mfa/verify': () => new Promise<Response>((resolve) => (release = resolve)),
    });
    render(<VerifiedPage />);

    await user.type(await screen.findByRole('textbox', { name: '認証コード（6〜8桁）' }), '123456');
    await user.click(screen.getByRole('button', { name: '2要素認証を完了' }));

    expect(await screen.findByRole('button', { name: '検証中...' })).toBeDisabled();
    await act(async () => {
      release(json({ data: { verified: false } }));
    });
    await expectAlert('2要素認証コードの検証に失敗しました。');
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('SCR-AUTH-007 自動の登録が失敗したら手動の登録ボタンを出し、押すと登録をやり直せる', async () => {
    const user = userEvent.setup();
    let attempt = 0;
    route({
      '/api/auth/me': adminNotVerified,
      '/api/auth/mfa/status': noFactorStatus,
      '/api/auth/mfa/enroll-totp': () => (++attempt === 1 ? json({ error: 'x' }, 500) : enrolled()),
    });
    render(<VerifiedPage />);

    await expectAlert('2要素認証の登録に失敗しました。');
    await user.click(screen.getByRole('button', { name: '2要素認証（TOTP）を登録' }));

    expect(await screen.findByRole('img', { name: 'TOTP QR code' })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toBeEmptyDOMElement();
    expect(attempt).toBe(2);
  });

  it('SCR-AUTH-007 誤りの案内の入れ物は誤りの無い間も置いたままで、中身を空にする', async () => {
    route({ '/api/auth/me': () => json({ authenticated: false }) });
    const { container } = render(<VerifiedPage />);

    await screen.findByText('ログインが必要です。ログイン後に再度お試しください。');
    const live = container.querySelector('[role="alert"]');
    expect(live).not.toBeNull();
    expect(live).toBeEmptyDOMElement();
  });
});
