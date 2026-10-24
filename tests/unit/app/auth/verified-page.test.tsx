import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import VerifiedPage from '@/app/auth/verified/page';

/**
 * DD-AUTH-005 /auth/verified の頁（役割の振り分けと TOTP の登録・確認）。
 *
 * FREQ-515: ログインの確認（2要素認証）で認証要素が2つ以上あるとき、
 * 選択欄（native）で選んだ要素が検証に使われる。
 */

const mockReplace = jest.fn();
const mockRefreshAuthState = jest.fn();
// useRouter が返す物。替えて再描画すると Effect の依存が変わり、me の確認がもう一度走る
let mockRouter = { replace: mockReplace };

jest.mock('next/navigation', () => ({
  useRouter: () => mockRouter,
}));

jest.mock('@/contexts/LoginContext', () => ({
  useLogin: () => ({ refreshAuthState: mockRefreshAuthState }),
}));

const originalFetch = globalThis.fetch;
const mockFetch = jest.fn();

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as Response;
}

function brokenJsonResponse(ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => {
      throw new SyntaxError('Unexpected end of JSON input');
    },
  } as unknown as Response;
}

type Handler = Response | (() => Response | Promise<Response>);

/** URL ごとの答えを決める。決めていない URL への通信は失敗させて見つける */
function routeFetch(routes: Record<string, Handler>) {
  mockFetch.mockImplementation(async (url: string) => {
    const handler = routes[url];
    if (handler === undefined) throw new Error(`unexpected fetch: ${url}`);
    return typeof handler === 'function' ? handler() : handler;
  });
}

function callsTo(url: string) {
  return mockFetch.mock.calls.filter(([calledUrl]) => calledUrl === url);
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

const adminUnverified = () =>
  jsonResponse({ authenticated: true, user: { role: 'admin', mfaVerified: false } });

const oneFactorStatus = () =>
  jsonResponse({
    data: {
      hasVerifiedFactor: true,
      factors: [{ id: 'factor-1', factorType: 'totp', friendlyName: 'iPhone' }],
    },
  });

const twoFactorStatus = () =>
  jsonResponse({
    data: {
      hasVerifiedFactor: true,
      factors: [
        { id: 'factor-1', factorType: 'totp', friendlyName: 'iPhone' },
        { id: 'factor-2', factorType: 'totp', friendlyName: 'iPad' },
      ],
    },
  });

const noFactorStatus = () => jsonResponse({ data: { hasVerifiedFactor: false, factors: [] } });

const enrollOk = () =>
  jsonResponse({
    data: {
      factorId: 'enroll-1',
      friendlyName: null,
      qrCode: 'data:image/svg+xml;base64,QUJD',
      secret: 'SECRET123',
      uri: 'otpauth://totp/lefil?secret=SECRET123',
    },
  });

const verifyOk = () => jsonResponse({ data: { verified: true } });

const CODE_LABEL = '認証コード（6〜8桁）';

beforeEach(() => {
  jest.clearAllMocks();
  mockRouter = { replace: mockReplace };
  mockRefreshAuthState.mockResolvedValue(undefined);
  routeFetch({
    '/api/auth/me': adminUnverified,
    '/api/auth/mfa/status': twoFactorStatus,
    '/api/auth/mfa/verify': verifyOk,
  });
  globalThis.fetch = mockFetch as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  jest.restoreAllMocks();
});

describe('2要素認証の認証要素の選択欄（FREQ-515）', () => {
  it('DD-AUTH-005 2つ目の認証要素を選ぶと、その要素で検証する', async () => {
    // FREQ-515-AC-02
    const user = userEvent.setup();
    render(<VerifiedPage />);

    const select = await screen.findByRole('combobox', { name: '認証要素' });
    expect(select.tagName).toBe('SELECT');
    await user.selectOptions(select, 'factor-2');
    expect(select).toHaveValue('factor-2');

    await user.type(screen.getByRole('textbox', { name: '認証コード（6〜8桁）' }), '123456');
    await user.click(screen.getByRole('button', { name: '2要素認証を完了' }));

    await waitFor(() =>
      expect(mockFetch).toHaveBeenCalledWith('/api/auth/mfa/verify', expect.anything()),
    );
    const verifyCall = mockFetch.mock.calls.find(([url]) => url === '/api/auth/mfa/verify');
    expect(JSON.parse(String(verifyCall?.[1]?.body))).toEqual({ factorId: 'factor-2', code: '123456' });
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/admin'));
  });
});

describe('/auth/verified の頁: 読み込みと振り分け', () => {
  it('DD-AUTH-005 me の答えを待つ間は題と「サインインを確認しています…」だけを出す', () => {
    routeFetch({ '/api/auth/me': () => new Promise<Response>(() => {}) });
    render(<VerifiedPage />);

    expect(screen.getByRole('heading', { name: 'Le Fil des Heures' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('サインインを確認しています…');
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('DD-AUTH-005 me を認証の Cookie 付きで保存せずに聞く', async () => {
    render(<VerifiedPage />);

    await screen.findByRole('combobox', { name: '認証要素' });
    expect(mockFetch).toHaveBeenCalledWith('/api/auth/me', {
      method: 'GET',
      cache: 'no-store',
      credentials: 'same-origin',
    });
    expect(mockFetch).toHaveBeenCalledWith('/api/auth/mfa/status', {
      method: 'GET',
      cache: 'no-store',
      credentials: 'same-origin',
    });
  });

  it.each([
    ['me が 200 以外', () => jsonResponse({ authenticated: true }, false, 401)],
    ['本文が JSON でない', () => brokenJsonResponse()],
    ['200 以外で本文も JSON でない', () => brokenJsonResponse(false, 500)],
    ['authenticated が無い', () => jsonResponse({})],
    ['authenticated が偽', () => jsonResponse({ authenticated: false })],
    ['authenticated が真に見える文字列', () => jsonResponse({ authenticated: 'true' })],
  ])('DD-AUTH-005 「%s」の時は未ログインの見せ方とログインへのリンクを出し、先へ進めない', async (_label, build) => {
    routeFetch({ '/api/auth/me': build });
    render(<VerifiedPage />);

    expect(
      await screen.findByText('ログインが必要です。ログイン後に再度お試しください。'),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'ログインページへ' })).toHaveAttribute('href', '/login');
    expect(callsTo('/api/auth/mfa/status')).toHaveLength(0);
    expect(callsTo('/api/auth/mfa/enroll-totp')).toHaveLength(0);
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it.each(['admin', 'supporter'])(
    'DD-AUTH-005 「%s」が確認済み（aal2）なら文を替えて /admin へ置き換え、TOTP の状態は聞かない',
    async (role) => {
      routeFetch({
        '/api/auth/me': () =>
          jsonResponse({ authenticated: true, user: { role, mfaVerified: true } }),
      });
      render(<VerifiedPage />);

      await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/admin'));
      expect(screen.getByRole('status')).toHaveTextContent('認証が完了しました。管理画面へ移動します…');
      expect(callsTo('/api/auth/mfa/status')).toHaveLength(0);
    },
  );

  it.each([
    ['mfaVerified が偽', { role: 'admin', mfaVerified: false }],
    ['mfaVerified が無い', { role: 'supporter' }],
    ['mfaVerified が真に見える文字列', { role: 'admin', mfaVerified: 'true' }],
  ])('DD-AUTH-005 管理者・サポーターで「%s」なら /admin へは送らず TOTP の状態を聞く', async (_label, user) => {
    routeFetch({
      '/api/auth/me': () => jsonResponse({ authenticated: true, user }),
      '/api/auth/mfa/status': oneFactorStatus,
    });
    render(<VerifiedPage />);

    expect(await screen.findByText('2要素認証コードを入力してください。')).toBeInTheDocument();
    expect(callsTo('/api/auth/mfa/status')).toHaveLength(1);
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('DD-AUTH-005 一般の会員は文を替えてリンクを出し、0.8 秒後に /account へ置き換える', async () => {
    routeFetch({
      '/api/auth/me': () =>
        jsonResponse({ authenticated: true, user: { role: 'user', mfaVerified: false } }),
    });
    render(<VerifiedPage />);

    expect(await screen.findByText('確認完了。アカウントへ移動します…')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('確認完了。アカウントへ移動します…');
    expect(screen.getByRole('link', { name: 'アカウントへ' })).toHaveAttribute('href', '/account');
    expect(mockReplace).not.toHaveBeenCalled();
    expect(callsTo('/api/auth/mfa/status')).toHaveLength(0);

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/account'), { timeout: 2000 });
    expect(mockReplace).toHaveBeenCalledTimes(1);
  });

  it('DD-AUTH-005 一般の会員の頁が 0.8 秒の前に閉じたら時計を止め、/account へは移らない', async () => {
    routeFetch({
      '/api/auth/me': () => jsonResponse({ authenticated: true, user: { role: 'user' } }),
    });
    const { unmount } = render(<VerifiedPage />);
    await screen.findByText('確認完了。アカウントへ移動します…');

    unmount();
    await new Promise((resolve) => setTimeout(resolve, 1000));

    expect(mockReplace).not.toHaveBeenCalled();
  });

  it.each([
    ['役割が許可の3つに無い', { role: 'owner', mfaVerified: true }],
    ['役割が文字列でない', { role: 5 }],
    ['役割が無い', { mfaVerified: true }],
    ['user の欄が無い', undefined],
  ])('DD-AUTH-005 「%s」の時は一般の会員として扱い、管理者用の確認へ通さない', async (_label, user) => {
    routeFetch({ '/api/auth/me': () => jsonResponse({ authenticated: true, user }) });
    const { unmount } = render(<VerifiedPage />);

    expect(await screen.findByText('確認完了。アカウントへ移動します…')).toBeInTheDocument();
    expect(callsTo('/api/auth/mfa/status')).toHaveLength(0);
    expect(callsTo('/api/auth/mfa/enroll-totp')).toHaveLength(0);
    unmount();
  });
});

describe('/auth/verified の頁: 頁が閉じた後に me の答えが来た時', () => {
  async function settle() {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  async function renderThenCloseBeforeAnswer(answer: () => Response | Promise<Response>) {
    const pending = deferred<Response>();
    routeFetch({ '/api/auth/me': () => pending.promise });
    const { unmount } = render(<VerifiedPage />);
    await waitFor(() => expect(callsTo('/api/auth/me')).toHaveLength(1));
    unmount();
    return { settleWith: async () => { pending.resolve(await answer()); await settle(); } };
  }

  it('DD-AUTH-005 未ログインの答えでも見せ方を変えず、何も呼ばない', async () => {
    const { settleWith } = await renderThenCloseBeforeAnswer(() => jsonResponse({}, false, 401));
    await settleWith();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('DD-AUTH-005 確認済みの管理者の答えでも /admin へ移らない', async () => {
    const { settleWith } = await renderThenCloseBeforeAnswer(() =>
      jsonResponse({ authenticated: true, user: { role: 'admin', mfaVerified: true } }),
    );
    await settleWith();

    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('DD-AUTH-005 確認前の管理者の答えでも TOTP の状態を聞かない', async () => {
    const { settleWith } = await renderThenCloseBeforeAnswer(adminUnverified);
    await settleWith();

    expect(callsTo('/api/auth/mfa/status')).toHaveLength(0);
  });

  it('DD-AUTH-005 一般の会員の答えでも 0.8 秒の時計を作らない', async () => {
    const { settleWith } = await renderThenCloseBeforeAnswer(() =>
      jsonResponse({ authenticated: true, user: { role: 'user' } }),
    );
    const setTimeoutSpy = jest.spyOn(globalThis, 'setTimeout');
    await settleWith();

    expect(setTimeoutSpy).not.toHaveBeenCalledWith(expect.any(Function), 800);
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('DD-AUTH-005 通信が投げても見せ方を変えず、自動の登録も走らせない', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    const pending = deferred<Response>();
    routeFetch({ '/api/auth/me': () => pending.promise });
    const { unmount } = render(<VerifiedPage />);
    await waitFor(() => expect(callsTo('/api/auth/me')).toHaveLength(1));

    unmount();
    pending.reject(new Error('network down'));
    await settle();

    expect(consoleError).toHaveBeenCalledWith(
      'Failed to initialize auth verified page:',
      expect.any(Error),
    );
    expect(callsTo('/api/auth/mfa/enroll-totp')).toHaveLength(0);
  });
});

describe('/auth/verified の頁: TOTP の状態と要素の選び方', () => {
  it('DD-AUTH-005 確かめ済みの要素が1つなら案内の文とコード欄を出し、選択欄・登録ボタン・自動の登録は出さない', async () => {
    routeFetch({
      '/api/auth/me': adminUnverified,
      '/api/auth/mfa/status': oneFactorStatus,
    });
    render(<VerifiedPage />);

    expect(await screen.findByText('2要素認証コードを入力してください。')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: CODE_LABEL })).toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '2要素認証（TOTP）を登録' })).not.toBeInTheDocument();
    expect(screen.queryByAltText('TOTP QR code')).not.toBeInTheDocument();
    expect(callsTo('/api/auth/mfa/enroll-totp')).toHaveLength(0);
  });

  it('DD-AUTH-005 要素の名前が無ければ種類、種類も無ければ「MFA Factor」を選択肢の名前にする', async () => {
    routeFetch({
      '/api/auth/me': adminUnverified,
      '/api/auth/mfa/status': () =>
        jsonResponse({
          data: {
            hasVerifiedFactor: true,
            factors: [
              { id: 'a', factorType: 'totp', friendlyName: 'iPhone' },
              { id: 'b', factorType: 'phone', friendlyName: null },
              { id: 'c', factorType: '', friendlyName: '' },
            ],
          },
        }),
    });
    render(<VerifiedPage />);

    const select = await screen.findByRole('combobox', { name: '認証要素' });
    const labels = within(select)
      .getAllByRole('option')
      .map((option) => option.textContent);
    expect(labels).toEqual(['iPhone', 'phone', 'MFA Factor']);
    expect(select).toHaveValue('a');
  });

  it.each([
    ['data の欄が無い', {}],
    ['要素の一覧が無い', { data: { hasVerifiedFactor: false } }],
    ['要素の一覧が空', { data: { hasVerifiedFactor: false, factors: [] } }],
  ])('DD-AUTH-005 「%s」の時は登録の案内を出し、自動で 1 回だけ登録を始める', async (_label, statusBody) => {
    routeFetch({
      '/api/auth/me': adminUnverified,
      '/api/auth/mfa/status': () => jsonResponse(statusBody),
      '/api/auth/mfa/enroll-totp': enrollOk,
    });
    render(<VerifiedPage />);

    expect(await screen.findByAltText('TOTP QR code')).toBeInTheDocument();
    expect(callsTo('/api/auth/mfa/enroll-totp')).toHaveLength(1);
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });

  it('DD-AUTH-005 要素が無く自動の登録が始まった時は「セットアップ中です…」の文を出す', async () => {
    const enroll = deferred<Response>();
    routeFetch({
      '/api/auth/me': adminUnverified,
      '/api/auth/mfa/status': noFactorStatus,
      '/api/auth/mfa/enroll-totp': () => enroll.promise,
    });
    render(<VerifiedPage />);

    await waitFor(() => expect(callsTo('/api/auth/mfa/enroll-totp')).toHaveLength(1));
    expect(
      screen.getByText('2要素認証（TOTP）をセットアップ中です…'),
    ).toBeInTheDocument();
    enroll.resolve(enrollOk());
    await screen.findByAltText('TOTP QR code');
  });

  it('DD-AUTH-005 自動の登録の最中は登録ボタンが「登録中...」で押せず、通ったら QR・秘密・URI・コード欄を出す', async () => {
    const enroll = deferred<Response>();
    routeFetch({
      '/api/auth/me': adminUnverified,
      '/api/auth/mfa/status': noFactorStatus,
      '/api/auth/mfa/enroll-totp': () => enroll.promise,
    });
    render(<VerifiedPage />);

    const busyButton = await screen.findByRole('button', { name: '登録中...' });
    expect(busyButton).toBeDisabled();
    expect(mockFetch).toHaveBeenCalledWith('/api/auth/mfa/enroll-totp', {
      method: 'POST',
      credentials: 'same-origin',
    });

    enroll.resolve(enrollOk());

    const qr = await screen.findByAltText('TOTP QR code');
    expect(qr).toHaveAttribute('src', 'data:image/svg+xml;base64,QUJD');
    expect(
      screen.getByText('認証アプリでQRコードを読み取り、生成されたコードを入力してください。'),
    ).toBeInTheDocument();
    expect(screen.getByText('シークレット: SECRET123')).toBeInTheDocument();
    expect(
      screen.getByText('セットアップURI: otpauth://totp/lefil?secret=SECRET123'),
    ).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: CODE_LABEL })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /登録/ })).not.toBeInTheDocument();
    expect(callsTo('/api/auth/mfa/enroll-totp')).toHaveLength(1);
  });

  it.each([
    ['秘密だけ', { secret: 'ONLYSECRET', uri: '' }, 'シークレット: ONLYSECRET', 'セットアップURI:'],
    ['URI だけ', { secret: '', uri: 'otpauth://only' }, 'セットアップURI: otpauth://only', 'シークレット:'],
  ])('DD-AUTH-005 手入力の案内には「%s」がある時、ある物だけを出す', async (_label, extra, shown, hidden) => {
    routeFetch({
      '/api/auth/me': adminUnverified,
      '/api/auth/mfa/status': noFactorStatus,
      '/api/auth/mfa/enroll-totp': () =>
        jsonResponse({ data: { factorId: 'enroll-1', friendlyName: null, qrCode: 'data:image/png;base64,AA', ...extra } }),
    });
    render(<VerifiedPage />);

    expect(await screen.findByText(shown)).toBeInTheDocument();
    expect(screen.queryByText(new RegExp(`^${hidden}`))).not.toBeInTheDocument();
  });

  it('DD-AUTH-005 QR が空なら画像を出さずコード欄は出す', async () => {
    routeFetch({
      '/api/auth/me': adminUnverified,
      '/api/auth/mfa/status': noFactorStatus,
      '/api/auth/mfa/enroll-totp': () =>
        jsonResponse({ data: { factorId: 'enroll-1', friendlyName: null, qrCode: '', secret: 'S', uri: '' } }),
    });
    render(<VerifiedPage />);

    expect(await screen.findByRole('textbox', { name: CODE_LABEL })).toBeInTheDocument();
    expect(screen.queryByAltText('TOTP QR code')).not.toBeInTheDocument();
    expect(screen.getByText('シークレット: S')).toBeInTheDocument();
  });
});

describe('/auth/verified の頁: 要素の再取得時の選択の保ち方', () => {
  async function renderWithTwoFetchesOfStatus(second: () => Response) {
    let statusCalls = 0;
    routeFetch({
      '/api/auth/me': adminUnverified,
      '/api/auth/mfa/status': () => {
        statusCalls += 1;
        return statusCalls === 1 ? twoFactorStatus() : second();
      },
      '/api/auth/mfa/verify': verifyOk,
    });
    const user = userEvent.setup();
    const view = render(<VerifiedPage />);
    const select = await screen.findByRole('combobox', { name: '認証要素' });
    await user.selectOptions(select, 'factor-2');

    mockRouter = { replace: mockReplace };
    view.rerender(<VerifiedPage />);
    await waitFor(() => expect(statusCalls).toBe(2));
    await act(async () => {});
    return { user, select };
  }

  it('DD-AUTH-005 選んでいた要素が新しい一覧にあれば、そのまま選んだままにする', async () => {
    const { select } = await renderWithTwoFetchesOfStatus(twoFactorStatus);

    expect(select).toHaveValue('factor-2');
  });

  it('DD-AUTH-005 選んでいた要素が新しい一覧に無ければ、一覧の先頭を選ぶ', async () => {
    const { select } = await renderWithTwoFetchesOfStatus(() =>
      jsonResponse({
        data: {
          hasVerifiedFactor: true,
          factors: [
            { id: 'factor-9', factorType: 'totp', friendlyName: 'Pixel' },
            { id: 'factor-8', factorType: 'totp', friendlyName: 'Galaxy' },
          ],
        },
      }),
    );

    expect(select).toHaveValue('factor-9');
  });
});

describe('/auth/verified の頁: 状態を聞けない時', () => {
  /** 登録の通信が始まった瞬間の画面を取る（その直後に誤りの文は消える） */
  function enrollSeesAlert(seen: { text: string | null }) {
    return () => {
      seen.text = document.querySelector('[role="alert"]')?.textContent ?? null;
      return enrollOk();
    };
  }

  it('DD-AUTH-005 me の通信が投げると誤りの文を出して TOTP の見せ方へ移り、自動の登録を始める', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    const seen = { text: null as string | null };
    routeFetch({
      '/api/auth/me': () => {
        throw new Error('network down');
      },
      '/api/auth/mfa/enroll-totp': enrollSeesAlert(seen),
    });
    render(<VerifiedPage />);

    expect(await screen.findByAltText('TOTP QR code')).toBeInTheDocument();
    expect(seen.text).toBe('認証状態の確認に失敗しました。もう一度ログインしてください。');
    expect(consoleError).toHaveBeenCalledWith(
      'Failed to initialize auth verified page:',
      expect.any(Error),
    );
  });

  it('DD-AUTH-005 TOTP の状態が 200 以外だと同じ誤りの文で TOTP の見せ方へ移る', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const seen = { text: null as string | null };
    routeFetch({
      '/api/auth/me': adminUnverified,
      '/api/auth/mfa/status': () => jsonResponse({}, false, 500),
      '/api/auth/mfa/enroll-totp': enrollSeesAlert(seen),
    });
    render(<VerifiedPage />);

    expect(await screen.findByAltText('TOTP QR code')).toBeInTheDocument();
    expect(seen.text).toBe('認証状態の確認に失敗しました。もう一度ログインしてください。');
  });
});

describe('/auth/verified の頁: TOTP の登録の失敗', () => {
  async function renderWithEnrollAnswer(answer: () => Response | Promise<Response>) {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    routeFetch({
      '/api/auth/me': adminUnverified,
      '/api/auth/mfa/status': noFactorStatus,
      '/api/auth/mfa/enroll-totp': answer,
    });
    render(<VerifiedPage />);
    return screen.findByRole('button', { name: '2要素認証（TOTP）を登録' });
  }

  it.each([
    ['409', () => jsonResponse({}, false, 409), '既に2要素認証は登録済みです。コード入力へ進んでください。'],
    ['500', () => jsonResponse({}, false, 500), '2要素認証の登録に失敗しました。'],
    ['500 で本文が JSON でない', () => brokenJsonResponse(false, 500), '2要素認証の登録に失敗しました。'],
    ['200 でも data が無い', () => jsonResponse({}), '2要素認証の登録に失敗しました。'],
    ['200 でも本文が JSON でない', () => brokenJsonResponse(), '2要素認証の登録に失敗しました。'],
  ])('DD-AUTH-005 登録の答えが「%s」なら決まりの文を出し、手動の登録ボタンを残す', async (_label, answer, message) => {
    const button = await renderWithEnrollAnswer(answer);

    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    expect(button).toBeEnabled();
    expect(screen.queryByAltText('TOTP QR code')).not.toBeInTheDocument();
    expect(callsTo('/api/auth/mfa/enroll-totp')).toHaveLength(1);
  });

  it('DD-AUTH-005 登録の通信が Error を投げたら、その文をそのまま出す', async () => {
    await renderWithEnrollAnswer(() => {
      throw new Error('network down');
    });

    expect(await screen.findByRole('alert')).toHaveTextContent('network down');
  });

  it('DD-AUTH-005 登録の通信が Error でない物を投げたら、決まりの文を出す', async () => {
    await renderWithEnrollAnswer(() => Promise.reject('boom'));

    expect(await screen.findByRole('alert')).toHaveTextContent('2要素認証の登録に失敗しました。');
  });

  it('DD-AUTH-005 失敗の後は自動で繰り返さず、手動のボタンで登録し直すと誤りの文が消えて QR が出る', async () => {
    const user = userEvent.setup();
    let calls = 0;
    const button = await renderWithEnrollAnswer(() => {
      calls += 1;
      return calls === 1 ? jsonResponse({}, false, 500) : enrollOk();
    });
    await screen.findByText('2要素認証の登録に失敗しました。');
    expect(calls).toBe(1);

    await user.click(button);

    expect(await screen.findByAltText('TOTP QR code')).toBeInTheDocument();
    expect(calls).toBe(2);
    expect(screen.getByRole('alert')).toBeEmptyDOMElement();
    // 手動の登録は「セットアップ中」の文には替えず、完了の文にする
    expect(
      screen.getByText('認証アプリでQRコードを読み取り、生成されたコードを入力してください。'),
    ).toBeInTheDocument();
  });

  it('DD-AUTH-005 手動の登録は押している間「登録中...」で押せない', async () => {
    const user = userEvent.setup();
    const second = deferred<Response>();
    let calls = 0;
    const button = await renderWithEnrollAnswer(() => {
      calls += 1;
      return calls === 1 ? jsonResponse({}, false, 500) : second.promise;
    });
    await screen.findByText('2要素認証の登録に失敗しました。');

    await user.click(button);

    expect(await screen.findByRole('button', { name: '登録中...' })).toBeDisabled();
    second.resolve(enrollOk());
    await screen.findByAltText('TOTP QR code');
  });
});

describe('/auth/verified の頁: 認証コードの確認', () => {
  async function renderWithOneFactor() {
    routeFetch({
      '/api/auth/me': adminUnverified,
      '/api/auth/mfa/status': oneFactorStatus,
      '/api/auth/mfa/verify': verifyOk,
    });
    const user = userEvent.setup();
    render(<VerifiedPage />);
    const input = await screen.findByRole('textbox', { name: CODE_LABEL });
    return { user, input };
  }

  const completeButton = () => screen.getByRole('button', { name: '2要素認証を完了' });

  it('DD-AUTH-005 確認が通ったら状態を同期し直してから、文を替えて /admin へ置き換える', async () => {
    const { user, input } = await renderWithOneFactor();

    await user.type(input, '654321');
    await user.click(completeButton());

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/admin'));
    const verifyCall = callsTo('/api/auth/mfa/verify')[0];
    expect(verifyCall[1]).toEqual({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ factorId: 'factor-1', code: '654321' }),
    });
    expect(mockRefreshAuthState).toHaveBeenCalledTimes(1);
    expect(mockRefreshAuthState.mock.invocationCallOrder[0]).toBeLessThan(
      mockReplace.mock.invocationCallOrder[0],
    );
    expect(screen.getByText('2要素認証が完了しました。管理画面へ移動します…')).toBeInTheDocument();
  });

  it('DD-AUTH-005 コード欄は数字だけを受け、8 桁で切る', async () => {
    const { user, input } = await renderWithOneFactor();

    await user.type(input, 'ab12-34 56789x');

    expect(input).toHaveValue('12345678');
  });

  it('DD-AUTH-005 7 桁・8 桁のコードも送れる（6〜8 桁）', async () => {
    const { user, input } = await renderWithOneFactor();

    await user.type(input, '1234567');
    await user.click(completeButton());

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/admin'));
    expect(JSON.parse(String(callsTo('/api/auth/mfa/verify')[0][1].body)).code).toBe('1234567');
  });

  it.each([
    ['空', ''],
    ['5 桁', '12345'],
  ])('DD-AUTH-005 コードが「%s」なら形の誤りを出し、確認の通信はしない', async (_label, code) => {
    const { user, input } = await renderWithOneFactor();

    if (code) await user.type(input, code);
    await user.click(completeButton());

    expect(await screen.findByRole('alert')).toHaveTextContent('認証コードは6〜8桁の数字で入力してください。');
    expect(callsTo('/api/auth/mfa/verify')).toHaveLength(0);
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('DD-AUTH-005 確かめる要素が無い（選択欄を空にした）時は要素が無い誤りを出し、通信しない', async () => {
    routeFetch({
      '/api/auth/me': adminUnverified,
      '/api/auth/mfa/status': twoFactorStatus,
      '/api/auth/mfa/verify': verifyOk,
    });
    const user = userEvent.setup();
    render(<VerifiedPage />);
    const select = await screen.findByRole('combobox', { name: '認証要素' });

    fireEvent.change(select, { target: { value: '' } });
    await user.type(screen.getByRole('textbox', { name: CODE_LABEL }), '123456');
    await user.click(completeButton());

    expect(await screen.findByRole('alert')).toHaveTextContent(
      '検証対象のMFA要素がありません。先に登録または再読み込みしてください。',
    );
    expect(callsTo('/api/auth/mfa/verify')).toHaveLength(0);
  });

  it('DD-AUTH-005 確認の最中はボタンが「検証中...」で押せず、通信を重ねない', async () => {
    const verify = deferred<Response>();
    routeFetch({
      '/api/auth/me': adminUnverified,
      '/api/auth/mfa/status': oneFactorStatus,
      '/api/auth/mfa/verify': () => verify.promise,
    });
    const user = userEvent.setup();
    render(<VerifiedPage />);
    await user.type(await screen.findByRole('textbox', { name: CODE_LABEL }), '123456');
    await user.click(completeButton());

    const busy = await screen.findByRole('button', { name: '検証中...' });
    expect(busy).toBeDisabled();
    await user.click(busy);
    expect(callsTo('/api/auth/mfa/verify')).toHaveLength(1);

    verify.resolve(verifyOk());
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/admin'));
  });

  it.each([
    ['200 以外', () => jsonResponse({}, false, 400)],
    ['200 以外で本文が JSON でない', () => brokenJsonResponse(false, 500)],
    ['verified が偽', () => jsonResponse({ data: { verified: false } })],
    ['verified が無い', () => jsonResponse({ data: {} })],
    ['本文が JSON でない', () => brokenJsonResponse()],
  ])('DD-AUTH-005 確認の答えが「%s」なら失敗の文を出し、同期も移動もしない', async (_label, answer) => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const { user, input } = await renderWithOneFactor();
    routeFetch({
      '/api/auth/me': adminUnverified,
      '/api/auth/mfa/status': oneFactorStatus,
      '/api/auth/mfa/verify': answer,
    });

    await user.type(input, '123456');
    await user.click(completeButton());

    expect(await screen.findByRole('alert')).toHaveTextContent('2要素認証コードの検証に失敗しました。');
    expect(mockRefreshAuthState).not.toHaveBeenCalled();
    expect(mockReplace).not.toHaveBeenCalled();
    expect(completeButton()).toBeEnabled();
  });

  it('DD-AUTH-005 確認の通信が Error を投げたら、その文を出す', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const { user, input } = await renderWithOneFactor();
    routeFetch({
      '/api/auth/me': adminUnverified,
      '/api/auth/mfa/status': oneFactorStatus,
      '/api/auth/mfa/verify': () => {
        throw new Error('network down');
      },
    });

    await user.type(input, '123456');
    await user.click(completeButton());

    expect(await screen.findByRole('alert')).toHaveTextContent('network down');
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('DD-AUTH-005 確認の通信が Error でない物を投げたら、決まりの文を出す', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const { user, input } = await renderWithOneFactor();
    routeFetch({
      '/api/auth/me': adminUnverified,
      '/api/auth/mfa/status': oneFactorStatus,
      '/api/auth/mfa/verify': () => Promise.reject('boom'),
    });

    await user.type(input, '123456');
    await user.click(completeButton());

    expect(await screen.findByRole('alert')).toHaveTextContent('2要素認証コードの検証に失敗しました。');
  });

  it('DD-AUTH-005 状態の同期が投げたら誤りの文を出し、/admin へは移らない', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    mockRefreshAuthState.mockRejectedValue(new Error('sync failed'));
    const { user, input } = await renderWithOneFactor();

    await user.type(input, '123456');
    await user.click(completeButton());

    expect(await screen.findByRole('alert')).toHaveTextContent('sync failed');
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('DD-AUTH-005 登録した直後のコードは、選択欄でなく登録で得た要素の id で確認する', async () => {
    routeFetch({
      '/api/auth/me': adminUnverified,
      '/api/auth/mfa/status': noFactorStatus,
      '/api/auth/mfa/enroll-totp': enrollOk,
      '/api/auth/mfa/verify': verifyOk,
    });
    const user = userEvent.setup();
    render(<VerifiedPage />);

    await user.type(await screen.findByRole('textbox', { name: CODE_LABEL }), '246810');
    await user.click(screen.getByRole('button', { name: '2要素認証を完了' }));

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/admin'));
    expect(JSON.parse(String(callsTo('/api/auth/mfa/verify')[0][1].body))).toEqual({
      factorId: 'enroll-1',
      code: '246810',
    });
  });
});
