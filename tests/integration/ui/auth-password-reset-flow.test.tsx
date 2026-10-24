import React from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import LoginPage from '@/app/login/page';
import PasswordResetPage from '@/app/auth/password-reset/page';
import PasswordResetVerifyPage from '@/app/auth/password-reset/verify/page';
import { LoginProvider } from '@/contexts/LoginContext';

// 流れは「/login の再設定のリンク → 申請 → （メールのリンク）→ 確認 → 新しいパスワード → 結果 → /login」を、
// 3つの頁を本物のまま次々に描いて辿る。外との境目だけ偽物にする:
//  - 転送・ルーター（置き換えは行き先を記録し、テストが次の頁を描く）
//  - 通信（窓口の4つ: session・request・link・confirm を、再設定の Cookie と印の使用済みを持つ偽物の窓口で返す）
//  - Cookie の入れ物・Turnstile の Script・Supabase の client
jest.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined }),
}));

let pendingReplace: string | null = null;

jest.mock('next/navigation', () => ({
  redirect: (url: string): never => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
  useRouter: () => mockRouter,
}));

const mockRouter = {
  replace: (url: string) => {
    pendingReplace = url;
  },
};

jest.mock('next/script', () => ({
  __esModule: true,
  default: () => null,
}));

jest.mock('@/lib/supabase/client', () => ({
  supabase: { auth: { signOut: jest.fn() } },
}));

jest.mock('@/lib/browser-location', () => ({
  navigateBrowser: jest.fn(),
}));

const VALID_TOKEN = 'mail-link-token';
const NEW_PASSWORD = 'correct-horse-battery-staple';

// 偽物の窓口の状態。実物の仕様: link は Cookie を付けるだけで印を消費せず、confirm が印を消費して Cookie を消す
const server = {
  cookieReady: false,
  cookieEmail: '',
  requestedEmails: [] as string[],
  linkTokens: [] as string[],
  confirmedPasswords: [] as string[],
  tokenConsumed: false,
  linkNetworkDown: false,
};

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
  };
}

const fetchMock = jest.fn(async (url: string, init?: { body?: string }) => {
  const body = init?.body ? JSON.parse(init.body) : {};
  switch (url) {
    case '/api/auth/password-reset/session':
      return jsonResponse(200, server.cookieReady ? { ready: true, email: server.cookieEmail } : { ready: false });
    case '/api/auth/password-reset/request':
      server.requestedEmails.push(body.email);
      server.cookieEmail = body.email;
      return jsonResponse(200, { ok: true });
    case '/api/auth/password-reset/link':
      if (server.linkNetworkDown) throw new TypeError('Failed to fetch');
      server.linkTokens.push(body.token);
      if (body.token !== VALID_TOKEN || server.tokenConsumed) return jsonResponse(400, { error: 'invalid' });
      server.cookieReady = true;
      return jsonResponse(200, { ok: true });
    case '/api/auth/password-reset/confirm':
      if (!server.cookieReady) return jsonResponse(401, { error: '再設定のセッションがありません' });
      server.confirmedPasswords.push(body.new_password);
      server.cookieReady = false;
      server.tokenConsumed = true;
      return jsonResponse(200, { ok: true });
    default:
      return jsonResponse(401, { authenticated: false });
  }
});

function callsTo(path: string) {
  return fetchMock.mock.calls.filter(([url]) => url === path);
}

/**
 * ブラウザの移動の代わり。URL に合う頁を本物で描き直す。
 * サーバーの頁（ログイン・確認）は描く前に非同期で解く。転送が投げられたら行き先へ移る。
 */
async function navigate(url: string): Promise<void> {
  cleanup();
  pendingReplace = null;
  window.history.pushState(null, '', url);
  const { pathname, searchParams } = new URL(url, 'http://localhost');

  if (pathname === '/auth/password-reset') {
    await act(async () => {
      render(<PasswordResetPage />);
    });
    await waitFor(() => expect(screen.queryByRole('button', { name: '確認中...' })).toBeNull());
    return;
  }

  if (pathname === '/auth/password-reset/verify') {
    const token = searchParams.get('token') ?? undefined;
    let element: React.ReactElement;
    try {
      element = await PasswordResetVerifyPage({ searchParams: Promise.resolve({ token }) });
    } catch (error) {
      const redirected = /^NEXT_REDIRECT:(.+)$/.exec((error as Error).message);
      if (!redirected) throw error;
      await navigate(redirected[1]);
      return;
    }
    await act(async () => {
      render(element);
    });
    return;
  }

  if (pathname === '/login') {
    const element = await LoginPage({ searchParams: Promise.resolve({}) });
    await act(async () => {
      render(<LoginProvider>{element}</LoginProvider>);
    });
    return;
  }

  throw new Error(`unexpected url ${url}`);
}

/** 確認の画面が置き換えを呼ぶのを待ち、その先へ移る。 */
async function followReplace(): Promise<string> {
  await waitFor(() => expect(pendingReplace).not.toBeNull());
  const target = pendingReplace as unknown as string;
  await navigate(target);
  return target;
}

async function submitRequest(user: ReturnType<typeof userEvent.setup>, email: string) {
  await user.type(screen.getByLabelText('Email'), email);
  await user.click(screen.getByRole('button', { name: '再設定メールを送信' }));
  await screen.findByRole('heading', { level: 1, name: '再設定メールを送信しました' });
}

async function submitNewPassword(user: ReturnType<typeof userEvent.setup>, password: string) {
  await user.type(screen.getByLabelText('New Password (16+ characters)'), password);
  await user.type(screen.getByLabelText('Confirm New Password (16+ characters)'), password);
  await user.click(screen.getByRole('button', { name: 'パスワードを更新' }));
}

describe('FLOW-AUTH-004 パスワードの再設定はログインの画面から申請し、メールのリンクから確認の画面を経て新しいパスワードを決め、ログインへ戻る', () => {
  const originalFetch = global.fetch;
  const originalSiteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
    pendingReplace = null;
    Object.assign(server, {
      cookieReady: false,
      cookieEmail: '',
      requestedEmails: [],
      linkTokens: [],
      confirmedPasswords: [],
      tokenConsumed: false,
      linkNetworkDown: false,
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    consoleErrorSpy.mockRestore();
    if (originalSiteKey === undefined) delete process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
    else process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY = originalSiteKey;
  });

  it('FLOW-AUTH-004 ログインの画面の再設定のリンクから申請し、メールのリンク・確認・新しいパスワード・結果を経て、ログインへ戻る', async () => {
    const user = userEvent.setup();

    // 1. /login の再設定のリンク
    await navigate('/login');
    const resetLink = screen.getByRole('link', { name: 'パスワードをお忘れの方はこちら' });
    expect(resetLink).toHaveAttribute('href', '/auth/password-reset');

    // 2. 申請 → 送った結果
    await navigate(resetLink.getAttribute('href') as string);
    expect(screen.getByRole('heading', { level: 1, name: 'パスワード再設定' })).toBeInTheDocument();
    await submitRequest(user, 'owner@example.com');
    expect(server.requestedEmails).toEqual(['owner@example.com']);

    // 3. メールのリンク → 確認の画面。開くと自動で確かめ、新しいパスワードの見せ方へ置き換わる
    await navigate(`/auth/password-reset/verify?token=${VALID_TOKEN}`);
    expect(await followReplace()).toBe('/auth/password-reset');
    expect(server.linkTokens).toEqual([VALID_TOKEN]);

    // 4. 新しいパスワード（メールの欄は出さない）→ 変えた結果
    expect(screen.getByLabelText('New Password (16+ characters)')).toBeInTheDocument();
    expect(screen.queryByLabelText('Email')).toBeNull();
    await submitNewPassword(user, NEW_PASSWORD);
    await screen.findByRole('heading', { level: 1, name: 'パスワードを更新しました' });
    expect(server.confirmedPasswords).toEqual([NEW_PASSWORD]);

    // 5. 「ログインへ」で /login に戻る
    const toLogin = screen.getByRole('link', { name: 'ログインへ' });
    expect(toLogin).toHaveAttribute('href', '/login');
    await navigate(toLogin.getAttribute('href') as string);
    expect(screen.getByRole('tab', { name: 'ログイン' })).toHaveAttribute('aria-selected', 'true');
  });

  it('FLOW-AUTH-004 メールのリンクを検査が先に開いても（頁を描くだけでは）何も消費せず、後から本人が開いて最後まで進める', async () => {
    const user = userEvent.setup();
    await navigate('/auth/password-reset');
    await submitRequest(user, 'owner@example.com');

    // 検査の GET は頁のサーバーの描画までで終わる（端末の部品は動かない）
    await PasswordResetVerifyPage({ searchParams: Promise.resolve({ token: VALID_TOKEN }) });
    expect(callsTo('/api/auth/password-reset/link')).toHaveLength(0);
    expect(server.tokenConsumed).toBe(false);

    await navigate(`/auth/password-reset/verify?token=${VALID_TOKEN}`);
    await followReplace();
    await submitNewPassword(user, NEW_PASSWORD);

    await screen.findByRole('heading', { level: 1, name: 'パスワードを更新しました' });
    expect(server.confirmedPasswords).toEqual([NEW_PASSWORD]);
  });

  it('FLOW-AUTH-004 リンクに token が無ければ確認の画面を描かずに申請へ戻し、理由を出してもう一度申請できる', async () => {
    const user = userEvent.setup();

    await navigate('/auth/password-reset/verify');

    expect(callsTo('/api/auth/password-reset/link')).toHaveLength(0);
    expect(
      screen.getByText('リンクが正しくありません。お手数ですが、再度メールを送信してください。'),
    ).toBeInTheDocument();
    expect(window.location.search).toBe('');
    await submitRequest(user, 'owner@example.com');
    expect(server.requestedEmails).toEqual(['owner@example.com']);
  });

  it('FLOW-AUTH-004 使えないリンクは窓口が断り、期限切れの理由を出して申請へ戻す', async () => {
    const user = userEvent.setup();

    await navigate('/auth/password-reset/verify?token=wrong-token');
    expect(await followReplace()).toBe('/auth/password-reset?error=link_expired');

    expect(
      screen.getByText(
        'リンクの有効期限が切れているか、すでに使用されています。お手数ですが、再度メールを送信してください。',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('New Password (16+ characters)')).toBeNull();
    expect(window.location.search).toBe('');
    await submitRequest(user, 'owner@example.com');
  });

  it('FLOW-AUTH-004 通信で落ちた確認は再試行でき、再試行が通れば新しいパスワードへ進める', async () => {
    const user = userEvent.setup();
    server.linkNetworkDown = true;

    await navigate(`/auth/password-reset/verify?token=${VALID_TOKEN}`);
    await screen.findByText('リンクの確認に失敗しました。時間をおいて再度お試しください。');
    expect(pendingReplace).toBeNull();

    server.linkNetworkDown = false;
    await user.click(screen.getByRole('button', { name: 'もう一度試す' }));
    expect(await followReplace()).toBe('/auth/password-reset');

    expect(screen.getByLabelText('New Password (16+ characters)')).toBeInTheDocument();
    expect(server.linkTokens).toEqual([VALID_TOKEN]);
  });

  it('FLOW-AUTH-004 パスワードを変えた後は同じリンクが使えず、再設定の頁も申請の見せ方に戻る（ログインし直しになる）', async () => {
    const user = userEvent.setup();
    await navigate(`/auth/password-reset/verify?token=${VALID_TOKEN}`);
    await followReplace();
    await submitNewPassword(user, NEW_PASSWORD);
    await screen.findByRole('heading', { level: 1, name: 'パスワードを更新しました' });

    await navigate('/auth/password-reset');
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
    expect(screen.queryByLabelText('New Password (16+ characters)')).toBeNull();

    await navigate(`/auth/password-reset/verify?token=${VALID_TOKEN}`);
    expect(await followReplace()).toBe('/auth/password-reset?error=link_expired');
    expect(server.confirmedPasswords).toHaveLength(1);
  });

  it('FLOW-AUTH-004 新しいパスワードが短すぎる間は confirm へ進まず、印も消費しない（直せば最後まで進める）', async () => {
    const user = userEvent.setup();
    await navigate(`/auth/password-reset/verify?token=${VALID_TOKEN}`);
    await followReplace();

    await submitNewPassword(user, 'too-short');
    expect(await screen.findByText('パスワードは16文字以上で入力してください')).toBeInTheDocument();
    expect(callsTo('/api/auth/password-reset/confirm')).toHaveLength(0);
    expect(server.tokenConsumed).toBe(false);

    await user.clear(screen.getByLabelText('New Password (16+ characters)'));
    await user.clear(screen.getByLabelText('Confirm New Password (16+ characters)'));
    await submitNewPassword(user, NEW_PASSWORD);

    await screen.findByRole('heading', { level: 1, name: 'パスワードを更新しました' });
    expect(server.confirmedPasswords).toEqual([NEW_PASSWORD]);
  });

  it('FLOW-AUTH-004 新しいパスワードを送る時に再設定の Cookie が消えていれば、窓口が断った文を出して結果へは進まない', async () => {
    const user = userEvent.setup();
    await navigate(`/auth/password-reset/verify?token=${VALID_TOKEN}`);
    await followReplace();
    server.cookieReady = false;

    await submitNewPassword(user, NEW_PASSWORD);

    expect(await screen.findByText('再設定のセッションがありません')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'パスワードを更新しました' })).toBeNull();
    expect(screen.getByLabelText('New Password (16+ characters)')).toBeInTheDocument();
  });
});
