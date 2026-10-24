import React from 'react';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PasswordResetPage from '@/app/auth/password-reset/page';

// 画面は /auth/password-reset の頁を本物の AuthResultScreen・Button・TextField・LiveMessage・
// useTurnstileWidget のまま通す。外との境目だけ偽物にする: 通信（fetch）・Turnstile の Script と window.turnstile。
let mockScriptReady: (() => void) | undefined;

jest.mock('next/script', () => ({
  __esModule: true,
  default: function MockTurnstileScript({ onReady }: { onReady?: () => void }) {
    mockScriptReady = onReady;
    const { useEffect } = jest.requireActual('react') as typeof React;
    useEffect(() => {
      onReady?.();
    }, []);
    return null;
  },
}));

type SessionBody = { ready: boolean; email?: string } | null;

const fetchMock = jest.fn();
const turnstileRender = jest.fn();
const turnstileReset = jest.fn();
const turnstileRemove = jest.fn();
let turnstileCallback: ((token: string) => void) | undefined;

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers[name] ?? null },
    json: async () => body,
  };
}

function routeFetch(routes: {
  session?: SessionBody;
  request?: ReturnType<typeof jsonResponse>;
  confirm?: ReturnType<typeof jsonResponse>;
}) {
  fetchMock.mockImplementation(async (url: string) => {
    if (url === '/api/auth/password-reset/session') {
      return jsonResponse(200, routes.session ?? { ready: false });
    }
    if (url === '/api/auth/password-reset/request') {
      return routes.request ?? jsonResponse(200, { ok: true });
    }
    if (url === '/api/auth/password-reset/confirm') {
      return routes.confirm ?? jsonResponse(200, { ok: true });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
}

function callsTo(path: string) {
  return fetchMock.mock.calls.filter(([url]) => url === path);
}

async function renderPage(search = '') {
  window.history.pushState(null, '', `/auth/password-reset${search}`);
  await act(async () => {
    render(<PasswordResetPage />);
  });
  // 窓口への確かめ（session）が終わるのを待つ
  await waitFor(() => expect(screen.queryByRole('button', { name: '確認中...' })).toBeNull());
}

const LONG_PASSWORD = 'correct-horse-battery-staple';

describe('SCR-AUTH-005 /auth/password-reset は申請・新しいパスワード・結果の3つの見せ方を持つ再設定のページにする', () => {
  const originalSiteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
    mockScriptReady = undefined;
    turnstileCallback = undefined;
    turnstileRender.mockImplementation((_el: HTMLElement, options: { callback: (token: string) => void }) => {
      turnstileCallback = options.callback;
      return 'widget-1';
    });
    (window as unknown as { turnstile: unknown }).turnstile = {
      render: turnstileRender,
      reset: turnstileReset,
      remove: turnstileRemove,
    };
    routeFetch({});
    global.fetch = fetchMock as unknown as typeof fetch;
    // jsdom に無い。Turnstile の幅合わせが使うので、何もしない物を置く
    (global as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete (window as unknown as { turnstile?: unknown }).turnstile;
    if (originalSiteKey === undefined) delete process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
    else process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY = originalSiteKey;
  });

  describe('申請の見せ方', () => {
    it('SCR-AUTH-005 再設定の Cookie が無ければ見出し・Email の欄・送信のボタンを出し、新しいパスワードの欄は出さない', async () => {
      await renderPage();

      expect(screen.getByRole('heading', { level: 1, name: 'パスワード再設定' })).toBeInTheDocument();
      expect(screen.getByLabelText('Email')).toHaveAttribute('type', 'email');
      expect(screen.getByRole('button', { name: '再設定メールを送信' })).toHaveAttribute('type', 'submit');
      expect(screen.queryByLabelText('New Password (16+ characters)')).toBeNull();
      expect(screen.queryByLabelText('Confirm New Password (16+ characters)')).toBeNull();
    });

    it('SCR-AUTH-005 窓口に聞いている間は Email の欄を使えず、ボタンは「確認中...」で押せない', async () => {
      let resolveSession: (value: unknown) => void = () => undefined;
      fetchMock.mockImplementation(
        () => new Promise((resolve) => {
          resolveSession = resolve;
        }),
      );

      await act(async () => {
        render(<PasswordResetPage />);
      });

      expect(screen.getByLabelText('Email')).toBeDisabled();
      expect(screen.getByRole('button', { name: '確認中...' })).toBeDisabled();

      await act(async () => {
        resolveSession(jsonResponse(200, { ready: false }));
      });

      await waitFor(() => expect(screen.getByLabelText('Email')).toBeEnabled());
      expect(screen.getByRole('button', { name: '再設定メールを送信' })).toBeDisabled();
    });

    it('SCR-AUTH-005 Email が埋まるまで送信のボタンは押せず、埋まると押せる', async () => {
      const user = userEvent.setup();
      await renderPage();
      const submit = screen.getByRole('button', { name: '再設定メールを送信' });

      expect(submit).toBeDisabled();
      await user.type(screen.getByLabelText('Email'), 'a@example.com');
      expect(submit).toBeEnabled();
    });

    it('SCR-AUTH-005 メールの形式が誤りなら送らずに理由の文を出す', async () => {
      const user = userEvent.setup();
      await renderPage();

      await user.type(screen.getByLabelText('Email'), 'a@b');
      await user.click(screen.getByRole('button', { name: '再設定メールを送信' }));

      expect(await screen.findByText('メールアドレスの形式が正しくありません')).toBeInTheDocument();
      expect(callsTo('/api/auth/password-reset/request')).toHaveLength(0);
    });

    it('SCR-AUTH-005 サイトキーが無い時は Turnstile を描かない', async () => {
      await renderPage();

      expect(turnstileRender).not.toHaveBeenCalled();
      expect(mockScriptReady).toBeUndefined();
    });

    it('SCR-AUTH-005 サイトキーがあれば Turnstile を flexible で描き、横にあふれさせない', async () => {
      process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY = 'site-key-1';
      await renderPage();

      expect(turnstileRender).toHaveBeenCalled();
      turnstileRender.mock.calls.forEach(([, options]) => {
        expect(options).toMatchObject({ sitekey: 'site-key-1', size: 'flexible' });
      });
    });

    it('SCR-AUTH-005 Turnstile のトークンが無い時は送らず、ボット検証を求める文を出す', async () => {
      process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY = 'site-key-1';
      const user = userEvent.setup();
      await renderPage();

      await user.type(screen.getByLabelText('Email'), 'a@example.com');
      await user.click(screen.getByRole('button', { name: '再設定メールを送信' }));

      expect(await screen.findByText('ボット検証を完了してください')).toBeInTheDocument();
      expect(callsTo('/api/auth/password-reset/request')).toHaveLength(0);
    });

    it('SCR-AUTH-005 送ると request に Email（小文字に揃えた値）と Turnstile のトークンを渡し、送るたびに Turnstile を引き直す', async () => {
      process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY = 'site-key-1';
      const user = userEvent.setup();
      await renderPage();

      await user.type(screen.getByLabelText('Email'), 'A@Example.com');
      act(() => turnstileCallback?.('token-1'));
      await user.click(screen.getByRole('button', { name: '再設定メールを送信' }));

      await screen.findByRole('heading', { level: 1, name: '再設定メールを送信しました' });
      const [, init] = callsTo('/api/auth/password-reset/request')[0];
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body)).toEqual({ email: 'A@Example.com', turnstileToken: 'token-1' });
      expect(turnstileReset).toHaveBeenCalledWith('widget-1');
    });

    it('SCR-AUTH-005 送信が断られても Turnstile を引き直す（使い捨てのトークンを残さない）', async () => {
      process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY = 'site-key-1';
      routeFetch({ request: jsonResponse(403, { error: 'ボット検証に失敗しました' }) });
      const user = userEvent.setup();
      await renderPage();

      await user.type(screen.getByLabelText('Email'), 'a@example.com');
      act(() => turnstileCallback?.('token-1'));
      await user.click(screen.getByRole('button', { name: '再設定メールを送信' }));

      expect(await screen.findByText('ボット検証に失敗しました')).toBeInTheDocument();
      expect(turnstileReset).toHaveBeenCalledWith('widget-1');
      // 結果へは移らず、申請のまま
      expect(screen.getByRole('button', { name: '再設定メールを送信' })).toBeInTheDocument();
    });
  });

  describe('新しいパスワードの見せ方', () => {
    beforeEach(() => {
      routeFetch({ session: { ready: true, email: 'owner@example.com' } });
    });

    it('SCR-AUTH-005 再設定の Cookie があれば新しいパスワードの2つの欄を出し、メールの欄と宛先は出さない', async () => {
      await renderPage();

      expect(screen.getByLabelText('New Password (16+ characters)')).toHaveAttribute('type', 'password');
      expect(screen.getByLabelText('Confirm New Password (16+ characters)')).toHaveAttribute('type', 'password');
      expect(screen.getByRole('button', { name: 'パスワードを更新' })).toBeInTheDocument();
      expect(screen.queryByLabelText('Email')).toBeNull();
      expect(screen.queryByDisplayValue('owner@example.com')).toBeNull();
      expect(screen.queryByText('owner@example.com')).toBeNull();
    });

    it('SCR-AUTH-005 2つの欄が両方埋まるまで更新のボタンは押せない', async () => {
      const user = userEvent.setup();
      await renderPage();
      const submit = screen.getByRole('button', { name: 'パスワードを更新' });

      expect(submit).toBeDisabled();
      await user.type(screen.getByLabelText('New Password (16+ characters)'), LONG_PASSWORD);
      expect(submit).toBeDisabled();
      await user.type(screen.getByLabelText('Confirm New Password (16+ characters)'), LONG_PASSWORD);
      expect(submit).toBeEnabled();
    });

    it('SCR-AUTH-005 2つの欄それぞれに表示の切り替えがあり、押した欄だけ文字を出す', async () => {
      const user = userEvent.setup();
      await renderPage();
      const fresh = screen.getByLabelText('New Password (16+ characters)');
      const confirm = screen.getByLabelText('Confirm New Password (16+ characters)');

      await user.click(screen.getByRole('button', { name: 'パスワードを表示' }));
      expect(fresh).toHaveAttribute('type', 'text');
      expect(confirm).toHaveAttribute('type', 'password');
      expect(screen.getByRole('button', { name: 'パスワードを非表示' })).toHaveAttribute('aria-pressed', 'true');

      await user.click(screen.getByRole('button', { name: '確認用パスワードを表示' }));
      expect(confirm).toHaveAttribute('type', 'text');

      await user.click(screen.getByRole('button', { name: 'パスワードを非表示' }));
      await user.click(screen.getByRole('button', { name: '確認用パスワードを非表示' }));
      expect(fresh).toHaveAttribute('type', 'password');
      expect(confirm).toHaveAttribute('type', 'password');
    });

    it('SCR-AUTH-005 短いパスワードを2回同じに打っても、一致の文ではなく長さの文を出す（長さが先）', async () => {
      const user = userEvent.setup();
      await renderPage();

      await user.type(screen.getByLabelText('New Password (16+ characters)'), 'short-pass');
      await user.type(screen.getByLabelText('Confirm New Password (16+ characters)'), 'short-pass');
      await user.click(screen.getByRole('button', { name: 'パスワードを更新' }));

      expect(await screen.findByText('パスワードは16文字以上で入力してください')).toBeInTheDocument();
      expect(screen.queryByText('パスワードが一致しません')).toBeNull();
      expect(callsTo('/api/auth/password-reset/confirm')).toHaveLength(0);
    });

    it('SCR-AUTH-005 長さが足りていて2つが違う時は一致しない旨を出して送らない', async () => {
      const user = userEvent.setup();
      await renderPage();

      await user.type(screen.getByLabelText('New Password (16+ characters)'), LONG_PASSWORD);
      await user.type(screen.getByLabelText('Confirm New Password (16+ characters)'), `${LONG_PASSWORD}-x`);
      await user.click(screen.getByRole('button', { name: 'パスワードを更新' }));

      expect(await screen.findByText('パスワードが一致しません')).toBeInTheDocument();
      expect(callsTo('/api/auth/password-reset/confirm')).toHaveLength(0);
    });

    it('SCR-AUTH-005 送ると confirm へ新しいパスワードだけを渡し、確認の欄の値は送らない', async () => {
      const user = userEvent.setup();
      await renderPage();

      await user.type(screen.getByLabelText('New Password (16+ characters)'), LONG_PASSWORD);
      await user.type(screen.getByLabelText('Confirm New Password (16+ characters)'), LONG_PASSWORD);
      await user.click(screen.getByRole('button', { name: 'パスワードを更新' }));

      await screen.findByRole('heading', { level: 1, name: 'パスワードを更新しました' });
      const calls = callsTo('/api/auth/password-reset/confirm');
      expect(calls).toHaveLength(1);
      expect(calls[0][1].method).toBe('POST');
      expect(JSON.parse(calls[0][1].body)).toEqual({ new_password: LONG_PASSWORD });
    });
  });

  describe('結果の見せ方', () => {
    it('SCR-AUTH-005 送った後はフォームと頁の見出しを畳み、結果の h1 だけを出す（宛先は出さない）', async () => {
      const user = userEvent.setup();
      await renderPage();

      await user.type(screen.getByLabelText('Email'), 'secret@example.com');
      await user.click(screen.getByRole('button', { name: '再設定メールを送信' }));

      const title = await screen.findByRole('heading', { level: 1, name: '再設定メールを送信しました' });
      expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
      expect(screen.queryByRole('heading', { name: 'パスワード再設定' })).toBeNull();
      expect(screen.queryByLabelText('Email')).toBeNull();
      expect(screen.queryByRole('button', { name: '再設定メールを送信' })).toBeNull();
      expect(screen.queryByText(/secret@example\.com/)).toBeNull();
      expect(screen.getByTestId('auth-result-icon-mail')).toBeInTheDocument();
      expect(screen.getByText('メール内のリンクから再設定してください。')).toBeInTheDocument();
      // 押したボタンが消えるので、見出しへフォーカスを移して読ませる
      expect(title).toHaveFocus();
    });

    it('SCR-AUTH-005 送った後は迷惑メールの確認と「再送で前のリンクは無効」の注意書き、別のアドレスとログインへの逃げ道を出す', async () => {
      const user = userEvent.setup();
      await renderPage();

      await user.type(screen.getByLabelText('Email'), 'a@example.com');
      await user.click(screen.getByRole('button', { name: '再設定メールを送信' }));

      const note = await screen.findByTestId('auth-result-note');
      expect(within(note).getByText('迷惑メールフォルダをご確認ください')).toBeInTheDocument();
      expect(within(note).getByText('再送信すると前回のリンクは無効です')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '別のアドレスで送信' })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'ログインへ' })).toHaveAttribute('href', '/login');
    });

    it('SCR-AUTH-005 変えた後は南京錠の図と「ログインへ」のボタンを主の操作として出し、フォームと頁の見出しを畳む', async () => {
      routeFetch({ session: { ready: true, email: 'owner@example.com' } });
      const user = userEvent.setup();
      await renderPage();

      await user.type(screen.getByLabelText('New Password (16+ characters)'), LONG_PASSWORD);
      await user.type(screen.getByLabelText('Confirm New Password (16+ characters)'), LONG_PASSWORD);
      await user.click(screen.getByRole('button', { name: 'パスワードを更新' }));

      const title = await screen.findByRole('heading', { level: 1, name: 'パスワードを更新しました' });
      expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
      expect(screen.getByTestId('auth-result-icon-password')).toBeInTheDocument();
      expect(screen.getByText('新しいパスワードでログインしてください。')).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'ログインへ' })).toHaveAttribute('href', '/login');
      expect(screen.queryByLabelText('New Password (16+ characters)')).toBeNull();
      expect(screen.queryByRole('button', { name: 'パスワードを更新' })).toBeNull();
      expect(title).toHaveFocus();
    });

    it('SCR-AUTH-005 変えた後は入力していたパスワードを画面に残さない', async () => {
      routeFetch({ session: { ready: true } });
      const user = userEvent.setup();
      await renderPage();

      await user.type(screen.getByLabelText('New Password (16+ characters)'), LONG_PASSWORD);
      await user.type(screen.getByLabelText('Confirm New Password (16+ characters)'), LONG_PASSWORD);
      await user.click(screen.getByRole('button', { name: 'パスワードを更新' }));

      await screen.findByRole('heading', { level: 1, name: 'パスワードを更新しました' });
      expect(screen.queryByDisplayValue(LONG_PASSWORD)).toBeNull();
      expect(document.body.textContent).not.toContain(LONG_PASSWORD);
    });
  });

  describe('無効・期限切れのリンクで来た時', () => {
    it('SCR-AUTH-005 ?error=link_expired で来たら期限切れ・使用済みの旨を出し、URL から外す', async () => {
      const replaceStateSpy = jest.spyOn(window.history, 'replaceState');
      await renderPage('?error=link_expired');

      expect(
        screen.getByText(
          'リンクの有効期限が切れているか、すでに使用されています。お手数ですが、再度メールを送信してください。',
        ),
      ).toBeInTheDocument();
      expect(replaceStateSpy).toHaveBeenCalledWith(null, '', '/auth/password-reset');
      expect(window.location.search).toBe('');
      // 申請の見せ方のまま、やり直せる
      expect(screen.getByLabelText('Email')).toBeInTheDocument();
      replaceStateSpy.mockRestore();
    });

    it('SCR-AUTH-005 ?error=link_invalid で来たらリンクが正しくない旨を出す', async () => {
      await renderPage('?error=link_invalid');

      expect(
        screen.getByText('リンクが正しくありません。お手数ですが、再度メールを送信してください。'),
      ).toBeInTheDocument();
      expect(window.location.search).toBe('');
    });

    it('SCR-AUTH-005 知らない error の値でも正しくない旨を出す', async () => {
      await renderPage('?error=something_else');

      expect(
        screen.getByText('リンクが正しくありません。お手数ですが、再度メールを送信してください。'),
      ).toBeInTheDocument();
    });

    it('SCR-AUTH-005 error が無い時は理由の文を出さず、URL も触らない', async () => {
      const replaceStateSpy = jest.spyOn(window.history, 'replaceState');
      await renderPage();

      expect(screen.queryByText(/リンク/)).toBeNull();
      expect(replaceStateSpy).not.toHaveBeenCalled();
      replaceStateSpy.mockRestore();
    });

    it('SCR-AUTH-005 理由の文は送信を始めると消える', async () => {
      const user = userEvent.setup();
      await renderPage('?error=link_invalid');

      await user.type(screen.getByLabelText('Email'), 'a@example.com');
      await user.click(screen.getByRole('button', { name: '再設定メールを送信' }));

      await screen.findByRole('heading', { level: 1, name: '再設定メールを送信しました' });
      expect(screen.queryByText(/リンクが正しくありません/)).toBeNull();
    });
  });

  describe('案内の入れ物', () => {
    it('SCR-AUTH-005 誤りの案内は role=alert の入れ物に出し、誤りが無いあいだは入れ物を空にしておく', async () => {
      const user = userEvent.setup();
      await renderPage();

      screen.getAllByRole('alert').forEach((box) => expect(box).toBeEmptyDOMElement());

      await user.type(screen.getByLabelText('Email'), 'a@b');
      await user.click(screen.getByRole('button', { name: '再設定メールを送信' }));

      const message = await screen.findByText('メールアドレスの形式が正しくありません');
      expect(message).toHaveAttribute('role', 'alert');
    });
  });
});
