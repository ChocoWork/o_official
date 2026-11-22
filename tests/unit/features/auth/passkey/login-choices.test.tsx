import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import LoginChoices from '@/features/auth/passkey/components/LoginChoices';

const mockReplace = jest.fn();
const mockRefresh = jest.fn();
const mockGoogle = jest.fn();
const mockSupported = jest.fn();
const mockAssert = jest.fn();
const mockResolve = jest.fn();
const mockStartAuth = jest.fn();
const mockResetTurnstile = jest.fn();
let pushToken: (token: string) => void = () => undefined;

jest.mock('next/navigation', () => ({ useRouter: () => ({ replace: mockReplace }) }));
jest.mock('next/script', () => ({ __esModule: true, default: () => null }));
jest.mock('@/contexts/LoginContext', () => ({
  useLogin: () => ({ loginWithGoogle: mockGoogle, refreshAuthState: mockRefresh }),
}));
jest.mock('@/lib/supabase/client', () => ({
  supabase: { auth: { passkey: { startAuthentication: (...a: unknown[]) => mockStartAuth(...a) } } },
}));
jest.mock('@/hooks/useTurnstileWidget', () => ({
  useTurnstileWidget: (_key: string, onToken: (t: string) => void) => {
    pushToken = onToken;
    return { containerRef: () => undefined, renderWidget: jest.fn(), resetWidget: mockResetTurnstile };
  },
}));
jest.mock('@/features/auth/passkey/webauthn-browser', () => ({
  isPasskeySupported: () => mockSupported(),
  requestAssertion: (...a: unknown[]) => mockAssert(...a),
}));
jest.mock('@/features/auth/passkey/post-login', () => ({ resolvePostLoginPath: () => mockResolve() }));

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

const START = {
  challenge_id: 'chal-1',
  options: { challenge: 'AQID', rpId: 'localhost', userVerification: 'required' },
  expires_at: 1,
};
const CREDENTIAL = { id: 'a', rawId: 'a', type: 'public-key', response: {} };

function passkeyButton() {
  return screen.getByRole('button', { name: /パスキーでログイン|確認しています/ });
}

describe('LoginChoices', () => {
  const originalFetch = global.fetch;
  const originalMode = process.env.NEXT_PUBLIC_PASSKEY_START_MODE;
  const originalSite = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
  beforeEach(() => {
    jest.clearAllMocks();
    mockSupported.mockReturnValue(true);
    mockResolve.mockResolvedValue('/account');
    mockAssert.mockResolvedValue({ ok: true, credential: CREDENTIAL });
    delete process.env.NEXT_PUBLIC_PASSKEY_START_MODE;
    delete process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
    global.fetch = jest.fn();
  });
  afterEach(() => {
    global.fetch = originalFetch;
    if (originalMode === undefined) delete process.env.NEXT_PUBLIC_PASSKEY_START_MODE;
    else process.env.NEXT_PUBLIC_PASSKEY_START_MODE = originalMode;
    if (originalSite === undefined) delete process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
    else process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY = originalSite;
  });

  function mockServerLogin(finish: Response) {
    (global.fetch as jest.Mock).mockImplementation(async (url: string) =>
      url === '/api/auth/passkey/login/start' ? json(200, START) : finish,
    );
  }

  async function clickPasskey() {
    await act(async () => {
      fireEvent.click(passkeyButton());
    });
  }

  test('DD-AUTH-063 3つの入口が、パスキー・OR・Google・OR・メールの順に並び、見出しは隠したログイン', () => {
    const { container } = render(<LoginChoices />);
    expect(screen.getByRole('heading', { level: 1, name: 'ログイン' })).toHaveClass('sr-only');
    expect(screen.getByText('この端末の顔認証・指紋・PIN で入れます。')).toBeInTheDocument();
    expect(container.querySelector('.ri-fingerprint-line')).toBeInTheDocument();
    expect(screen.getAllByText('OR')).toHaveLength(2);
    const order = [
      passkeyButton(),
      screen.getByRole('button', { name: /Googleでサインイン/ }),
      screen.getByRole('textbox', { name: 'Email' }),
      screen.getByRole('button', { name: 'メールでコードを受け取る' }),
    ];
    for (let i = 0; i < order.length - 1; i += 1) {
      expect(order[i].compareDocumentPosition(order[i + 1]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    expect(screen.getByText('はじめての方も、同じ方法でアカウントを作れます。')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '利用規約' })).toHaveAttribute('href', '/terms');
    expect(screen.getByRole('link', { name: 'プライバシーポリシー' })).toHaveAttribute('href', '/privacy');
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  test('DD-AUTH-063 未対応のブラウザではボタンを出さず、一文を出す', () => {
    mockSupported.mockReturnValue(false);
    render(<LoginChoices />);
    expect(screen.queryByRole('button', { name: /パスキーでログイン/ })).not.toBeInTheDocument();
    expect(
      screen.getByText('この端末ではパスキーを使えません。メールのコードか Google でログインできます。'),
    ).toBeInTheDocument();
  });

  test('DD-AUTH-063 Google のボタンは戻り先を渡す', () => {
    render(<LoginChoices returnTo="/item/3" />);
    fireEvent.click(screen.getByRole('button', { name: /Googleでサインイン/ }));
    expect(mockGoogle).toHaveBeenCalledWith({ next: '/item/3' });
  });

  test('DD-AUTH-063 渡された案内を status で出す', () => {
    render(<LoginChoices notice="しばらく操作がなかったため、ログアウトしました。もう一度ログインしてください。" />);
    expect(screen.getByText('しばらく操作がなかったため、ログアウトしました。もう一度ログインしてください。')).toHaveAttribute('role', 'status');
  });

  test('DD-AUTH-063 パスキー成功: refreshAuthState の後に post-login の行き先へ置き換え、勧めの画面を出さない', async () => {
    mockServerLogin(json(200, { user: { id: 'u1', email: 'a@example.com', role: 'user' } }));
    render(<LoginChoices returnTo="/account" />);
    await clickPasskey();
    expect(mockRefresh).toHaveBeenCalledTimes(1);
    expect(mockReplace).toHaveBeenCalledWith('/account');
    expect(mockReplace).not.toHaveBeenCalledWith('/login/passkey');
    const finishCall = (global.fetch as jest.Mock).mock.calls.find((c) => c[0] === '/api/auth/passkey/login/finish');
    expect(JSON.parse(finishCall[1].body)).toMatchObject({ challenge_id: 'chal-1', next: '/account' });
  });

  test('DD-AUTH-063 押した間は disabled・aria-busy・確認しています', async () => {
    let release: (r: Response) => void = () => undefined;
    (global.fetch as jest.Mock).mockImplementation((url: string) =>
      url === '/api/auth/passkey/login/start'
        ? Promise.resolve(json(200, START))
        : new Promise<Response>((resolve) => {
            release = resolve;
          }),
    );
    render(<LoginChoices />);
    await clickPasskey();
    const busy = screen.getByRole('button', { name: /確認しています/ });
    expect(busy).toBeDisabled();
    expect(busy).toHaveAttribute('aria-busy', 'true');
    await act(async () => {
      release(json(401, { error: 'passkey_login_failed' }));
    });
    expect(passkeyButton()).toBeEnabled();
  });

  test('DD-AUTH-063 失敗の後、フォーカスが失われていればパスキーのボタンへ戻す', async () => {
    mockServerLogin(json(401, { error: 'passkey_login_failed' }));
    render(<LoginChoices />);
    await clickPasskey();
    expect(passkeyButton()).toHaveFocus();
  });

  test('DD-AUTH-063 失敗の後、別の所にフォーカスがあれば奪わない', async () => {
    let release: (r: Response) => void = () => undefined;
    (global.fetch as jest.Mock).mockImplementation((url: string) =>
      url === '/api/auth/passkey/login/start'
        ? Promise.resolve(json(200, START))
        : new Promise<Response>((resolve) => {
            release = resolve;
          }),
    );
    render(<LoginChoices />);
    await clickPasskey();
    const email = screen.getByRole('textbox', { name: 'Email' });
    email.focus();
    await act(async () => {
      release(json(401, { error: 'passkey_login_failed' }));
    });
    expect(email).toHaveFocus();
  });

  test('DD-AUTH-063 中止は赤でなく status の文', async () => {
    mockAssert.mockResolvedValue({ ok: false, reason: 'cancelled' });
    mockServerLogin(json(200, {}));
    render(<LoginChoices />);
    await clickPasskey();
    const status = screen.getByText('パスキーでのログインを中止しました。');
    expect(status).toHaveAttribute('role', 'status');
    expect(status).not.toHaveClass('text-red-600');
  });

  test.each([
    ['not_found', 401, { error: 'passkey_login_failed' }, 'このパスキーではログインできませんでした。メールのコードか Google でもログインできます。'],
    ['uv_required', 400, { error: 'uv_required' }, 'この端末で本人確認をしてから、もう一度お試しください。'],
    ['staff_blocked', 403, { error: 'staff_passkey_required' }, 'このパスキーはログインに使えません。'],
    ['unavailable', 503, {}, 'ただいまパスキーを使えません。メールのコードか Google でログインしてください。'],
    ['failed', 500, {}, 'ただいまパスキーを使えません。メールのコードか Google でログインしてください。'],
  ])('DD-AUTH-063 %s の文', async (_reason, status, body, message) => {
    mockServerLogin(json(status, body));
    render(<LoginChoices />);
    await clickPasskey();
    expect(screen.getAllByRole('alert')[0]).toHaveTextContent(message);
    expect(mockReplace).not.toHaveBeenCalled();
  });

  test('DD-AUTH-063 rate_limited は「約 N 分後」を足す（Retry-After があれば）', async () => {
    mockServerLogin(json(429, {}, { 'Retry-After': '300' }));
    render(<LoginChoices />);
    await clickPasskey();
    expect(screen.getAllByRole('alert')[0]).toHaveTextContent(
      'ログインの試行が集中しています。しばらくしてからお試しください。（約 5 分後）',
    );
  });

  test('DD-AUTH-063 rate_limited は Retry-After が無ければ分を足さない', async () => {
    mockServerLogin(json(429, {}));
    render(<LoginChoices />);
    await clickPasskey();
    expect(screen.getAllByRole('alert')[0].textContent).toBe(
      'ログインの試行が集中しています。しばらくしてからお試しください。',
    );
  });

  test('DD-AUTH-063 始めが失敗した時も使えない文', async () => {
    (global.fetch as jest.Mock).mockResolvedValue(json(500, {}));
    render(<LoginChoices />);
    await clickPasskey();
    expect(screen.getAllByRole('alert')[0]).toHaveTextContent('ただいまパスキーを使えません。');
  });

  test('DD-AUTH-063 browser の始め: Turnstile のトークンが無ければ GoTrue を呼ばない', async () => {
    process.env.NEXT_PUBLIC_PASSKEY_START_MODE = 'browser';
    process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY = 'site-key';
    render(<LoginChoices />);
    await clickPasskey();
    expect(mockStartAuth).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
    expect(screen.getAllByRole('alert')[0]).toHaveTextContent('ただいまパスキーを使えません。');
  });

  test('DD-AUTH-063 browser の始め: トークンがあれば GoTrue を呼び、引き直す', async () => {
    process.env.NEXT_PUBLIC_PASSKEY_START_MODE = 'browser';
    process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY = 'site-key';
    mockStartAuth.mockResolvedValue({ data: START, error: null });
    (global.fetch as jest.Mock).mockResolvedValue(json(200, { user: { id: 'u1', email: null, role: 'user' } }));
    render(<LoginChoices />);
    act(() => pushToken('tok-1'));
    await clickPasskey();
    expect(mockStartAuth).toHaveBeenCalledWith({ options: { captchaToken: 'tok-1' } });
    expect(mockResetTurnstile).toHaveBeenCalled();
    expect(mockReplace).toHaveBeenCalledWith('/account');
  });

  test('DD-AUTH-063 server の始め: GoTrue を呼ばずアプリの窓口を呼ぶ', async () => {
    mockServerLogin(json(200, { user: { id: 'u1', email: null, role: 'user' } }));
    render(<LoginChoices />);
    await clickPasskey();
    expect(mockStartAuth).not.toHaveBeenCalled();
    expect((global.fetch as jest.Mock).mock.calls[0][0]).toBe('/api/auth/passkey/login/start');
  });

  test('DD-AUTH-063 メール欄の初めの値を渡す', () => {
    render(<LoginChoices initialEmail="a@example.com" />);
    expect(screen.getByRole('textbox', { name: 'Email' })).toHaveValue('a@example.com');
  });
});
