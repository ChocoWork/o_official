import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PasswordResetPage from '@/app/auth/password-reset/page';

// 状態は /auth/password-reset の頁の中だけで動く（確かめ中・申請・送った・新しいパスワード・変えた）。
// 頁は本物の AuthResultScreen・useTurnstileWidget・formatResendCountdown のまま通し、
// 外との境目だけ偽物にする: 通信（fetch）・Turnstile の Script と window.turnstile・時計（待ちの数え）。
jest.mock('next/script', () => ({
  __esModule: true,
  default: function MockTurnstileScript({ onReady }: { onReady?: () => void }) {
    const { useEffect } = jest.requireActual('react') as typeof React;
    useEffect(() => {
      onReady?.();
    }, []);
    return null;
  },
}));

const REQUEST_PATH = '/api/auth/password-reset/request';
const CONFIRM_PATH = '/api/auth/password-reset/confirm';
const SESSION_PATH = '/api/auth/password-reset/session';

const RATE_LIMIT_MESSAGE = '送信回数の上限に達しました。しばらく時間をおいてからお試しください。';
const NEW_PASSWORD = 'correct-horse-battery-staple';

type MockResponse = {
  ok: boolean;
  status: number;
  headers: { get: (name: string) => string | null };
  json: () => Promise<unknown>;
};

function res(status: number, body: unknown = {}, headers: Record<string, string> = {}): MockResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers[name] ?? null },
    json: async () => body,
  };
}

type Handler = () => MockResponse | Promise<MockResponse>;

const handlers: { session: Handler; request: Handler; confirm: Handler } = {
  session: () => res(200, { ready: false }),
  request: () => res(200, { ok: true }),
  confirm: () => res(200, { ok: true }),
};

const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
  void init;
  if (url === SESSION_PATH) return handlers.session();
  if (url === REQUEST_PATH) return handlers.request();
  if (url === CONFIRM_PATH) return handlers.confirm();
  throw new Error(`unexpected fetch ${url}`);
});

const turnstileRender = jest.fn();
const turnstileReset = jest.fn();
const turnstileRemove = jest.fn();
let turnstileCallback: ((token: string) => void) | undefined;

function callsTo(path: string) {
  return fetchMock.mock.calls.filter(([url]) => url === path);
}

function advance(ms: number) {
  act(() => {
    jest.advanceTimersByTime(ms);
  });
}

async function renderPage() {
  window.history.pushState(null, '', '/auth/password-reset');
  await act(async () => {
    render(<PasswordResetPage />);
  });
  await waitFor(() => expect(screen.queryByRole('button', { name: '確認中...' })).toBeNull());
}

let user: ReturnType<typeof userEvent.setup>;

async function sendFirstRequest(email = 'owner@example.com') {
  await user.type(screen.getByLabelText('Email'), email);
  await user.click(screen.getByRole('button', { name: '再設定メールを送信' }));
  await screen.findByRole('heading', { level: 1, name: '再設定メールを送信しました' });
}

async function typeNewPasswords(first = NEW_PASSWORD, second = NEW_PASSWORD) {
  await user.type(screen.getByLabelText('New Password (16+ characters)'), first);
  await user.type(screen.getByLabelText('Confirm New Password (16+ characters)'), second);
}

describe('STATE-AUTH-004 再設定のページは Cookie の確かめの後に申請か新しいパスワードを出し、送った後は結果へ移る', () => {
  const originalFetch = global.fetch;
  const originalSiteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    delete process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
    handlers.session = () => res(200, { ready: false });
    handlers.request = () => res(200, { ok: true });
    handlers.confirm = () => res(200, { ok: true });
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
    (global as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
    global.fetch = fetchMock as unknown as typeof fetch;
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
    global.fetch = originalFetch;
    consoleErrorSpy.mockRestore();
    delete (window as unknown as { turnstile?: unknown }).turnstile;
    if (originalSiteKey === undefined) delete process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
    else process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY = originalSiteKey;
  });

  describe('確かめ中から申請・新しいパスワードへ', () => {
    it('STATE-AUTH-004 最初は確かめ中で、窓口の答えが返るまで送信のボタンは「確認中...」で押せない', async () => {
      let answer: (value: MockResponse) => void = () => undefined;
      handlers.session = () =>
        new Promise<MockResponse>((resolve) => {
          answer = resolve;
        });

      await act(async () => {
        render(<PasswordResetPage />);
      });

      expect(callsTo(SESSION_PATH)).toHaveLength(1);
      expect(callsTo(SESSION_PATH)[0][1]).toMatchObject({ method: 'GET', cache: 'no-store' });
      expect(screen.getByRole('button', { name: '確認中...' })).toBeDisabled();

      await act(async () => {
        answer(res(200, { ready: false }));
      });
      expect(await screen.findByRole('button', { name: '再設定メールを送信' })).toBeInTheDocument();
    });

    it('STATE-AUTH-004 ready=false なら申請へ移る', async () => {
      await renderPage();

      expect(screen.getByLabelText('Email')).toBeEnabled();
      expect(screen.queryByLabelText('New Password (16+ characters)')).toBeNull();
    });

    it('STATE-AUTH-004 ready=true なら新しいパスワードへ移り、メールの欄は出さない', async () => {
      handlers.session = () => res(200, { ready: true, email: 'owner@example.com' });
      await renderPage();

      expect(screen.getByRole('button', { name: 'パスワードを更新' })).toBeInTheDocument();
      expect(screen.queryByLabelText('Email')).toBeNull();
    });

    it('STATE-AUTH-004 ready=true で宛先が文字列でなくても新しいパスワードへ移る', async () => {
      handlers.session = () => res(200, { ready: true, email: 42 });
      await renderPage();

      expect(screen.getByLabelText('New Password (16+ characters)')).toBeInTheDocument();
    });

    it.each([
      ['窓口が 500 を返した', () => res(500, { error: 'boom' })],
      ['窓口が 401 を返した', () => res(401, {})],
    ])('STATE-AUTH-004 %s時は申請へ移る', async (_label, handler) => {
      handlers.session = handler;
      await renderPage();

      expect(screen.getByLabelText('Email')).toBeEnabled();
      expect(screen.queryByLabelText('New Password (16+ characters)')).toBeNull();
    });

    it('STATE-AUTH-004 窓口への通信が落ちた時は申請へ移る', async () => {
      handlers.session = () => {
        throw new TypeError('Failed to fetch');
      };
      await renderPage();

      expect(screen.getByLabelText('Email')).toBeEnabled();
    });

    it('STATE-AUTH-004 窓口の答えが読めない（JSON でない）時は申請のまま確かめを終える', async () => {
      handlers.session = () => ({
        ...res(200),
        json: async () => {
          throw new SyntaxError('Unexpected token');
        },
      });
      await renderPage();

      expect(screen.getByLabelText('Email')).toBeEnabled();
      expect(screen.queryByLabelText('New Password (16+ characters)')).toBeNull();
    });

    it('STATE-AUTH-004 確かめが終わる前に頁が外されても、遅れて届いた答えで状態を触らない', async () => {
      let answer: (value: MockResponse) => void = () => undefined;
      handlers.session = () =>
        new Promise<MockResponse>((resolve) => {
          answer = resolve;
        });
      let unmount: () => void = () => undefined;
      await act(async () => {
        unmount = render(<PasswordResetPage />).unmount;
      });

      unmount();
      await act(async () => {
        answer(res(200, { ready: true, email: 'late@example.com' }));
      });

      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });
  });

  describe('申請', () => {
    it('STATE-AUTH-004 request が 200 なら送ったへ移り、フォームを畳む', async () => {
      await renderPage();

      await sendFirstRequest();

      expect(screen.queryByLabelText('Email')).toBeNull();
      expect(callsTo(REQUEST_PATH)).toHaveLength(1);
    });

    it('STATE-AUTH-004 request が 429 なら申請のまま上限の旨を出す（送ったへは移らない）', async () => {
      handlers.request = () => res(429, { error: 'rate' }, { 'Retry-After': '60' });
      await renderPage();

      await user.type(screen.getByLabelText('Email'), 'owner@example.com');
      await user.click(screen.getByRole('button', { name: '再設定メールを送信' }));

      expect(await screen.findByText(RATE_LIMIT_MESSAGE)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '再設定メールを送信' })).toBeInTheDocument();
      expect(screen.queryByRole('heading', { name: '再設定メールを送信しました' })).toBeNull();
    });

    it('STATE-AUTH-004 request が 429 以外で断ると、窓口の文を出して申請のまま留まる', async () => {
      handlers.request = () => res(403, { error: 'ボット検証に失敗しました' });
      await renderPage();

      await user.type(screen.getByLabelText('Email'), 'owner@example.com');
      await user.click(screen.getByRole('button', { name: '再設定メールを送信' }));

      expect(await screen.findByText('ボット検証に失敗しました')).toBeInTheDocument();
      expect(screen.getByLabelText('Email')).toHaveValue('owner@example.com');
    });

    it('STATE-AUTH-004 request が窓口の文を持たない断りなら「送信に失敗しました」を出す', async () => {
      handlers.request = () => ({ ...res(500), json: async () => null });
      await renderPage();

      await user.type(screen.getByLabelText('Email'), 'owner@example.com');
      await user.click(screen.getByRole('button', { name: '再設定メールを送信' }));

      expect(await screen.findByText('送信に失敗しました')).toBeInTheDocument();
    });

    it('STATE-AUTH-004 request の通信が落ちた時も「送信に失敗しました」を出して申請に留まる', async () => {
      handlers.request = () => {
        throw new TypeError('Failed to fetch');
      };
      await renderPage();

      await user.type(screen.getByLabelText('Email'), 'owner@example.com');
      await user.click(screen.getByRole('button', { name: '再設定メールを送信' }));

      expect(await screen.findByText('送信に失敗しました')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '再設定メールを送信' })).toBeEnabled();
    });

    it('STATE-AUTH-004 申請の失敗の文は、次に送り直した時に消える', async () => {
      handlers.request = () => res(403, { error: '一時的な失敗' });
      await renderPage();
      await user.type(screen.getByLabelText('Email'), 'owner@example.com');
      await user.click(screen.getByRole('button', { name: '再設定メールを送信' }));
      await screen.findByText('一時的な失敗');

      handlers.request = () => res(200, { ok: true });
      await user.click(screen.getByRole('button', { name: '再設定メールを送信' }));

      await screen.findByRole('heading', { level: 1, name: '再設定メールを送信しました' });
      expect(screen.queryByText('一時的な失敗')).toBeNull();
    });
  });

  describe('送った', () => {
    it('STATE-AUTH-004 送った直後は60秒の待ちを formatResendCountdown の文で出し、再送のボタンは出さない', async () => {
      await renderPage();

      await sendFirstRequest();

      expect(screen.getByText('1分 00秒後に再送可能')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: '再送信する' })).toBeNull();
    });

    it('STATE-AUTH-004 待ちは1秒ごとに減り、0になったら再送のボタンに替わる', async () => {
      await renderPage();
      await sendFirstRequest();

      advance(1000);
      expect(screen.getByText('0分 59秒後に再送可能')).toBeInTheDocument();
      advance(58000);
      expect(screen.getByText('0分 01秒後に再送可能')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: '再送信する' })).toBeNull();

      advance(1000);
      expect(screen.queryByText(/後に再送可能/)).toBeNull();
      expect(screen.getByRole('button', { name: '再送信する' })).toBeEnabled();
    });

    it('STATE-AUTH-004 待ちは経過した時刻から引き直す（タブが背面で間引かれても、過ぎた分だけ進む）', async () => {
      await renderPage();
      await sendFirstRequest();

      // 1 回の tick で 59 秒ぶん時計だけが進んだ状態を作る
      act(() => {
        jest.setSystemTime(Date.now() + 59000);
        jest.advanceTimersByTime(1000);
      });

      expect(screen.queryByText(/後に再送可能/)).toBeNull();
      expect(screen.getByRole('button', { name: '再送信する' })).toBeInTheDocument();
    });

    it('STATE-AUTH-004 待ちが明けて再送が200なら、同じ宛先へもう一度送り、待ちを60秒から数え直す', async () => {
      await renderPage();
      await sendFirstRequest('Owner@Example.com');
      advance(60000);

      await user.click(screen.getByRole('button', { name: '再送信する' }));

      expect(await screen.findByText('1分 00秒後に再送可能')).toBeInTheDocument();
      const requests = callsTo(REQUEST_PATH);
      expect(requests).toHaveLength(2);
      expect(JSON.parse((requests[1][1] as { body: string }).body).email).toBe('Owner@Example.com');
      expect(screen.queryByRole('button', { name: '再送信する' })).toBeNull();
    });

    it('STATE-AUTH-004 再送が429なら Retry-After の秒を待ちに入れ、上限の旨を出して再送のボタンを引っ込める', async () => {
      await renderPage();
      await sendFirstRequest();
      advance(60000);
      handlers.request = () => res(429, { error: 'rate' }, { 'Retry-After': '120' });

      await user.click(screen.getByRole('button', { name: '再送信する' }));

      expect(await screen.findByText(RATE_LIMIT_MESSAGE)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: '再送信する' })).toBeNull();
      expect(screen.queryByText(/後に再送可能/)).toBeNull();

      advance(119000);
      expect(screen.getByText(RATE_LIMIT_MESSAGE)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: '再送信する' })).toBeNull();

      advance(1000);
      expect(screen.queryByText(RATE_LIMIT_MESSAGE)).toBeNull();
      expect(screen.getByRole('button', { name: '再送信する' })).toBeInTheDocument();
    });

    it.each([
      ['Retry-After が無い', {}],
      ['Retry-After が数でない', { 'Retry-After': 'Wed, 21 Oct 2026 07:28:00 GMT' }],
      ['Retry-After が 0', { 'Retry-After': '0' }],
    ])('STATE-AUTH-004 再送が429で%s時は1時間（3600秒）の保険を待ちに入れる', async (_label, headers) => {
      await renderPage();
      await sendFirstRequest();
      advance(60000);
      handlers.request = () => res(429, { error: 'rate' }, headers);

      await user.click(screen.getByRole('button', { name: '再送信する' }));
      await screen.findByText(RATE_LIMIT_MESSAGE);

      advance(3599000);
      expect(screen.queryByRole('button', { name: '再送信する' })).toBeNull();
      advance(1000);
      expect(screen.getByRole('button', { name: '再送信する' })).toBeInTheDocument();
    });

    it('STATE-AUTH-004 再送が429以外で断ると、窓口の文を出して再送のボタンを残す', async () => {
      await renderPage();
      await sendFirstRequest();
      advance(60000);
      handlers.request = () => res(500, { error: 'メールを送れませんでした' });

      await user.click(screen.getByRole('button', { name: '再送信する' }));

      expect(await screen.findByText('メールを送れませんでした')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '再送信する' })).toBeEnabled();
      expect(screen.queryByText(RATE_LIMIT_MESSAGE)).toBeNull();
    });

    it('STATE-AUTH-004 再送の通信が落ちた時は「送信に失敗しました」を出して送ったに留まる', async () => {
      await renderPage();
      await sendFirstRequest();
      advance(60000);
      handlers.request = () => {
        throw new TypeError('Failed to fetch');
      };

      await user.click(screen.getByRole('button', { name: '再送信する' }));

      expect(await screen.findByText('送信に失敗しました')).toBeInTheDocument();
      expect(screen.getByRole('heading', { level: 1, name: '再設定メールを送信しました' })).toBeInTheDocument();
    });

    it('STATE-AUTH-004 再送の失敗の文は、次の再送が通ると消える', async () => {
      await renderPage();
      await sendFirstRequest();
      advance(60000);
      handlers.request = () => res(500, { error: '一時的な失敗' });
      await user.click(screen.getByRole('button', { name: '再送信する' }));
      await screen.findByText('一時的な失敗');

      handlers.request = () => res(200, { ok: true });
      await user.click(screen.getByRole('button', { name: '再送信する' }));

      await screen.findByText('1分 00秒後に再送可能');
      expect(screen.queryByText('一時的な失敗')).toBeNull();
    });

    it('STATE-AUTH-004 「別のアドレスで送信」で申請へ戻り、待ちと誤りの文を捨てる（再送のボタンは出ない）', async () => {
      await renderPage();
      await sendFirstRequest();
      advance(60000);
      handlers.request = () => res(500, { error: '一時的な失敗' });
      await user.click(screen.getByRole('button', { name: '再送信する' }));
      await screen.findByText('一時的な失敗');

      await user.click(screen.getByRole('button', { name: '別のアドレスで送信' }));

      expect(screen.getByRole('heading', { level: 1, name: 'パスワード再設定' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '再設定メールを送信' })).toBeInTheDocument();
      expect(screen.queryByText('一時的な失敗')).toBeNull();
      expect(screen.queryByText(/後に再送可能/)).toBeNull();
      expect(screen.queryByRole('button', { name: '再送信する' })).toBeNull();
    });

    it('STATE-AUTH-004 上限の旨が出ている間に「別のアドレスで送信」へ戻ると、上限の旨を捨てて新しい申請を送れる', async () => {
      await renderPage();
      await sendFirstRequest();
      advance(60000);
      handlers.request = () => res(429, { error: 'rate' }, { 'Retry-After': '600' });
      await user.click(screen.getByRole('button', { name: '再送信する' }));
      await screen.findByText(RATE_LIMIT_MESSAGE);

      await user.click(screen.getByRole('button', { name: '別のアドレスで送信' }));
      handlers.request = () => res(200, { ok: true });
      await user.clear(screen.getByLabelText('Email'));
      await user.type(screen.getByLabelText('Email'), 'other@example.com');
      await user.click(screen.getByRole('button', { name: '再設定メールを送信' }));

      expect(await screen.findByText('1分 00秒後に再送可能')).toBeInTheDocument();
      expect(screen.queryByText(RATE_LIMIT_MESSAGE)).toBeNull();
      expect(JSON.parse((callsTo(REQUEST_PATH)[2][1] as { body: string }).body).email).toBe('other@example.com');
    });
  });

  describe('再送も Turnstile を通す', () => {
    beforeEach(() => {
      process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY = 'site-key-1';
    });

    it('STATE-AUTH-004 サイトキーがある時は、待ちが明けても新しいトークンが届くまで再送のボタンを押せない', async () => {
      await renderPage();
      await user.type(screen.getByLabelText('Email'), 'owner@example.com');
      act(() => turnstileCallback?.('token-1'));
      await user.click(screen.getByRole('button', { name: '再設定メールを送信' }));
      await screen.findByRole('heading', { level: 1, name: '再設定メールを送信しました' });
      // 送った時点でトークンは使い捨てとして引き直されている
      expect(turnstileReset).toHaveBeenCalled();

      advance(60000);
      const resend = screen.getByRole('button', { name: '再送信する' });
      expect(resend).toBeDisabled();

      act(() => turnstileCallback?.('token-2'));
      expect(resend).toBeEnabled();
    });

    it('STATE-AUTH-004 待ちが明けると Turnstile を描き直し、再送には新しいトークンを渡して再び引き直す', async () => {
      await renderPage();
      await user.type(screen.getByLabelText('Email'), 'owner@example.com');
      act(() => turnstileCallback?.('token-1'));
      await user.click(screen.getByRole('button', { name: '再設定メールを送信' }));
      await screen.findByRole('heading', { level: 1, name: '再設定メールを送信しました' });
      const rendersBefore = turnstileRender.mock.calls.length;
      turnstileReset.mockClear();

      advance(60000);
      expect(turnstileRender.mock.calls.length).toBeGreaterThan(rendersBefore);
      act(() => turnstileCallback?.('token-2'));
      await user.click(screen.getByRole('button', { name: '再送信する' }));

      await screen.findByText('1分 00秒後に再送可能');
      const lastRequest = callsTo(REQUEST_PATH).pop() as [string, { body: string }];
      expect(JSON.parse(lastRequest[1].body)).toEqual({ email: 'owner@example.com', turnstileToken: 'token-2' });
      expect(turnstileReset).toHaveBeenCalled();
    });
  });

  describe('新しいパスワード', () => {
    beforeEach(() => {
      handlers.session = () => res(200, { ready: true, email: 'owner@example.com' });
    });

    it('STATE-AUTH-004 confirm が200なら変えたへ移り、新しいパスワードの欄を畳む', async () => {
      await renderPage();

      await typeNewPasswords();
      await user.click(screen.getByRole('button', { name: 'パスワードを更新' }));

      expect(await screen.findByRole('heading', { level: 1, name: 'パスワードを更新しました' })).toBeInTheDocument();
      expect(screen.queryByLabelText('New Password (16+ characters)')).toBeNull();
      expect(screen.queryByRole('button', { name: 'パスワードを更新' })).toBeNull();
    });

    it('STATE-AUTH-004 変えたの結果には待ちも再送も出さない（送ったとは別の結果）', async () => {
      await renderPage();

      await typeNewPasswords();
      await user.click(screen.getByRole('button', { name: 'パスワードを更新' }));
      await screen.findByRole('heading', { level: 1, name: 'パスワードを更新しました' });

      advance(120000);
      expect(screen.queryByText(/後に再送可能/)).toBeNull();
      expect(screen.queryByRole('button', { name: '再送信する' })).toBeNull();
      expect(screen.queryByRole('button', { name: '別のアドレスで送信' })).toBeNull();
    });

    it('STATE-AUTH-004 confirm が断ると、窓口の文を出して新しいパスワードに留まる', async () => {
      handlers.confirm = () => res(401, { error: '再設定のセッションが切れました' });
      await renderPage();

      await typeNewPasswords();
      await user.click(screen.getByRole('button', { name: 'パスワードを更新' }));

      expect(await screen.findByText('再設定のセッションが切れました')).toBeInTheDocument();
      expect(screen.getByLabelText('New Password (16+ characters)')).toHaveValue(NEW_PASSWORD);
      expect(screen.queryByRole('heading', { name: 'パスワードを更新しました' })).toBeNull();
    });

    it.each([
      ['窓口が文を持たずに断った', () => ({ ...res(500), json: async () => null })],
      ['窓口の答えが読めない', () => ({ ...res(500), json: async () => { throw new SyntaxError('bad'); } })],
      [
        '通信が落ちた',
        () => {
          throw new TypeError('Failed to fetch');
        },
      ],
    ])('STATE-AUTH-004 confirm で%s時は「再設定に失敗しました」を出す', async (_label, handler) => {
      handlers.confirm = handler as Handler;
      await renderPage();

      await typeNewPasswords();
      await user.click(screen.getByRole('button', { name: 'パスワードを更新' }));

      expect(await screen.findByText('再設定に失敗しました')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'パスワードを更新' })).toBeEnabled();
    });

    it('STATE-AUTH-004 送っている間は更新のボタンを押せず、二重には送らない', async () => {
      let answer: (value: MockResponse) => void = () => undefined;
      handlers.confirm = () =>
        new Promise<MockResponse>((resolve) => {
          answer = resolve;
        });
      await renderPage();

      await typeNewPasswords();
      await user.click(screen.getByRole('button', { name: 'パスワードを更新' }));

      expect(screen.getByRole('button', { name: 'パスワードを更新' })).toBeDisabled();
      expect(callsTo(CONFIRM_PATH)).toHaveLength(1);

      await act(async () => {
        answer(res(200, { ok: true }));
      });
      expect(await screen.findByRole('heading', { name: 'パスワードを更新しました' })).toBeInTheDocument();
    });

    it('STATE-AUTH-004 失敗の文は、直して送り直すと消えて変えたへ移る', async () => {
      handlers.confirm = () => res(400, { error: '一時的な失敗' });
      await renderPage();
      await typeNewPasswords();
      await user.click(screen.getByRole('button', { name: 'パスワードを更新' }));
      await screen.findByText('一時的な失敗');

      handlers.confirm = () => res(200, { ok: true });
      await user.click(screen.getByRole('button', { name: 'パスワードを更新' }));

      await screen.findByRole('heading', { name: 'パスワードを更新しました' });
      expect(screen.queryByText('一時的な失敗')).toBeNull();
    });

    it('STATE-AUTH-004 入力の誤り（長さ・不一致）は送る前に捨て、新しいパスワードに留まる', async () => {
      await renderPage();

      await typeNewPasswords(NEW_PASSWORD, `${NEW_PASSWORD}-x`);
      await user.click(screen.getByRole('button', { name: 'パスワードを更新' }));

      expect(await screen.findByText('パスワードが一致しません')).toBeInTheDocument();
      expect(callsTo(CONFIRM_PATH)).toHaveLength(0);
      expect(screen.getByLabelText('New Password (16+ characters)')).toBeInTheDocument();
    });
  });
});
