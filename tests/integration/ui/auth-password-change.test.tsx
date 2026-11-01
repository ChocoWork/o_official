/**
 * @jest-environment jsdom
 */
/**
 * パスワード変更の画面 /account/password（SCR-AUTH-011、FLOW-AUTH-005。詳細設計は DD-AUTH-042）。
 *
 * 段階 1（現行パスワード）→ 段階 2（コードと新パスワード）→ 成功で /login、を本物の画面のまま辿る。
 * 差し替えるのは、Next のルーター、ログインの状態、通信（clientFetch）だけ。
 * 通信の応答は本文を読む側の `json()` が呼ばれたかを数え、本文を読み切る約束（no-store の応答を読まない呼び手が
 * networkidle を止める。波 3 の学び）を確かめる。
 */
import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PasswordChangePage from '@/app/account/password/page';
import AccountPage from '@/app/account/page';

jest.mock('@/features/account/hooks/useReorder', () => ({
  useReorder: () => ({ reorderingItemId: null, reorder: jest.fn() }),
}));

const mockReplace = jest.fn();
const mockRefreshAuthState = jest.fn(async () => undefined);
let mockLoggedIn = true;
let mockAuthResolved = true;

jest.mock('next/navigation', () => ({
  usePathname: () => '/account/password',
  useRouter: () => ({ push: jest.fn(), replace: mockReplace, refresh: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

jest.mock('@/contexts/LoginContext', () => ({
  useLogin: () => ({
    isLoggedIn: mockLoggedIn,
    isAuthResolved: mockAuthResolved,
    refreshAuthState: mockRefreshAuthState,
  }),
}));

const mockClientFetch = jest.fn();
const mockRefreshSessionOnce = jest.fn();
jest.mock('@/lib/client-fetch', () => ({
  clientFetch: (...args: unknown[]) => mockClientFetch(...args),
  refreshSessionOnce: (...args: unknown[]) => mockRefreshSessionOnce(...args),
}));

const CURRENT = 'current-password-value';
const NEW_PASSWORD = 'correct-horse-battery-staple';
const CODE = '12345678';
const CODE_ERROR = '確認コードが正しくないか、期限が切れています。もう一度コードを送ってください。';
const CURRENT_ERROR = '現行のパスワードが正しくありません。';

type Reply = { status: number; body: unknown };
const jsonSpies: jest.Mock[] = [];

function reply(status: number, body: unknown): Reply {
  return { status, body };
}

function respond({ status, body }: Reply) {
  const json = jest.fn(async () => body);
  jsonSpies.push(json);
  return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, json };
}

function queue(...replies: Reply[]) {
  for (const r of replies) mockClientFetch.mockResolvedValueOnce(respond(r));
}

function callsTo(path: string) {
  return mockClientFetch.mock.calls.filter(([url]) => url === path);
}

function bodyOf(call: unknown[]) {
  return JSON.parse((call[1] as { body: string }).body);
}

async function submitCurrentPassword(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText('現行のパスワード'), CURRENT);
  await user.click(screen.getByRole('button', { name: '確認コードをメールに送る' }));
}

async function fillStage2(
  user: ReturnType<typeof userEvent.setup>,
  values: { code?: string; password?: string; confirm?: string } = {},
) {
  await user.type(screen.getByLabelText('確認コード'), values.code ?? CODE);
  await user.type(screen.getByLabelText('新しいパスワード'), values.password ?? NEW_PASSWORD);
  await user.type(screen.getByLabelText('新しいパスワード（確認）'), values.confirm ?? values.password ?? NEW_PASSWORD);
}

async function reachStage2(user: ReturnType<typeof userEvent.setup>) {
  queue(reply(200, { ok: true }));
  render(<PasswordChangePage />);
  await submitCurrentPassword(user);
  await screen.findByLabelText('確認コード');
}

describe('SCR-AUTH-011 パスワード変更の画面', () => {
  beforeEach(() => {
    mockClientFetch.mockReset();
    mockRefreshSessionOnce.mockReset();
    mockRefreshSessionOnce.mockResolvedValue('expired');
    mockReplace.mockReset();
    mockRefreshAuthState.mockClear();
    jsonSpies.length = 0;
    mockLoggedIn = true;
    mockAuthResolved = true;
  });

  afterEach(() => {
    cleanup();
  });

  it('SCR-AUTH-011 最初は現行のパスワードの欄と送るボタンだけが出て、コードと新しいパスワードの欄は無い', () => {
    render(<PasswordChangePage />);

    expect(screen.getByLabelText('現行のパスワード')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '確認コードをメールに送る' })).toBeInTheDocument();
    expect(screen.queryByLabelText('確認コード')).toBeNull();
    expect(screen.queryByLabelText('新しいパスワード')).toBeNull();
    expect(screen.queryByLabelText('新しいパスワード（確認）')).toBeNull();
  });

  it('FLOW-AUTH-005 start が 200 なら段階 2 に変わり、コードと新しいパスワードの欄が出て、現行パスワードの欄は消える', async () => {
    const user = userEvent.setup();
    await reachStage2(user);

    expect(callsTo('/api/auth/password/change/start')).toHaveLength(1);
    const [, init] = callsTo('/api/auth/password/change/start')[0] as [string, { method: string }];
    expect(init.method).toBe('POST');
    expect(bodyOf(callsTo('/api/auth/password/change/start')[0])).toEqual({ current_password: CURRENT });
    expect(screen.getByLabelText('新しいパスワード')).toBeInTheDocument();
    expect(screen.getByLabelText('新しいパスワード（確認）')).toBeInTheDocument();
    expect(screen.queryByLabelText('現行のパスワード')).toBeNull();
  });

  it('SCR-AUTH-011 start が 401（現行パスワードの誤り）なら、その文を出して段階 1 に留まり、/login へは送らない', async () => {
    const user = userEvent.setup();
    queue(reply(401, { error: CURRENT_ERROR }));
    render(<PasswordChangePage />);

    await submitCurrentPassword(user);

    expect(await screen.findByText(CURRENT_ERROR)).toBeInTheDocument();
    expect(screen.getByLabelText('現行のパスワード')).toBeInTheDocument();
    expect(screen.queryByLabelText('確認コード')).toBeNull();
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('FLOW-AUTH-005 start が 401（未ログイン: Unauthorized）なら /login?next=/account/password へ送る', async () => {
    const user = userEvent.setup();
    queue(reply(401, { error: 'Unauthorized' }));
    render(<PasswordChangePage />);

    await submitCurrentPassword(user);

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/login?next=%2Faccount%2Fpassword'));
  });

  it('FLOW-AUTH-005 start が 401（Unauthorized）でも、印を 1 回更新できたら同じ本文で 1 回だけ送り直し、200 なら段階 2 に進む（/login へは送らない）', async () => {
    const user = userEvent.setup();
    mockRefreshSessionOnce.mockResolvedValue('refreshed');
    queue(reply(401, { error: 'Unauthorized' }), reply(200, { ok: true }));
    render(<PasswordChangePage />);

    await submitCurrentPassword(user);

    await screen.findByLabelText('確認コード');
    expect(mockRefreshSessionOnce).toHaveBeenCalledTimes(1);
    const starts = callsTo('/api/auth/password/change/start');
    expect(starts).toHaveLength(2);
    expect(bodyOf(starts[1])).toEqual({ current_password: CURRENT });
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('FLOW-AUTH-005 confirm が 401（Unauthorized）でも、印を 1 回更新できたら同じ本文で送り直し、200 なら成功の段へ進む', async () => {
    const user = userEvent.setup();
    await reachStage2(user);
    mockRefreshSessionOnce.mockResolvedValue('refreshed');
    queue(reply(401, { error: 'Unauthorized' }), reply(200, { ok: true }));

    await fillStage2(user);
    await user.click(screen.getByRole('button', { name: 'パスワードを変更する' }));

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/login'));
    expect(mockRefreshSessionOnce).toHaveBeenCalledTimes(1);
    const confirms = callsTo('/api/auth/password/change/confirm');
    expect(confirms).toHaveLength(2);
    expect(bodyOf(confirms[1])).toEqual({ code: CODE, new_password: NEW_PASSWORD });
  });

  it('FLOW-AUTH-005 401（Unauthorized）で印の更新が失敗（expired・unavailable）なら送り直さず /login?next=/account/password へ送る', async () => {
    for (const outcome of ['expired', 'unavailable']) {
      const user = userEvent.setup();
      mockClientFetch.mockReset();
      mockReplace.mockReset();
      mockRefreshSessionOnce.mockReset();
      mockRefreshSessionOnce.mockResolvedValue(outcome);
      queue(reply(401, { error: 'Unauthorized' }));
      render(<PasswordChangePage />);

      await submitCurrentPassword(user);

      await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/login?next=%2Faccount%2Fpassword'));
      expect(callsTo('/api/auth/password/change/start')).toHaveLength(1);
      cleanup();
    }
  });

  it('FLOW-AUTH-005 更新して送り直しても 401（Unauthorized）なら、それ以上は送り直さず /login へ送る（無限に繰り返さない）', async () => {
    const user = userEvent.setup();
    mockRefreshSessionOnce.mockResolvedValue('refreshed');
    queue(reply(401, { error: 'Unauthorized' }), reply(401, { error: 'Unauthorized' }));
    render(<PasswordChangePage />);

    await submitCurrentPassword(user);

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/login?next=%2Faccount%2Fpassword'));
    expect(callsTo('/api/auth/password/change/start')).toHaveLength(2);
    expect(mockRefreshSessionOnce).toHaveBeenCalledTimes(1);
  });

  it('SCR-AUTH-011 現行パスワードの誤り（401・Unauthorized ではない）では印を更新せず送り直さない', async () => {
    const user = userEvent.setup();
    queue(reply(401, { error: CURRENT_ERROR }));
    render(<PasswordChangePage />);

    await submitCurrentPassword(user);

    await screen.findByText(CURRENT_ERROR);
    expect(mockRefreshSessionOnce).not.toHaveBeenCalled();
    expect(callsTo('/api/auth/password/change/start')).toHaveLength(1);
  });

  it('SCR-AUTH-011 新しいパスワードが 15 文字なら送らずに画面で断る（confirm を呼ばない）', async () => {
    const user = userEvent.setup();
    await reachStage2(user);

    await fillStage2(user, { password: 'a'.repeat(15) });
    await user.click(screen.getByRole('button', { name: 'パスワードを変更する' }));

    expect(await screen.findByText('パスワードは16文字以上で入力してください')).toBeInTheDocument();
    expect(callsTo('/api/auth/password/change/confirm')).toHaveLength(0);
  });

  it('SCR-AUTH-011 新しいパスワードが 72 バイトを超える（日本語 25 文字）なら送らずに画面で断る', async () => {
    const user = userEvent.setup();
    await reachStage2(user);

    await fillStage2(user, { password: 'あ'.repeat(25), confirm: 'あ'.repeat(25) });
    await user.click(screen.getByRole('button', { name: 'パスワードを変更する' }));

    expect(
      await screen.findByText('パスワードは72バイト以内にしてください（全角の文字は1文字で3バイトです）'),
    ).toBeInTheDocument();
    expect(callsTo('/api/auth/password/change/confirm')).toHaveLength(0);
  });

  it('SCR-AUTH-011 確認の欄が新しいパスワードと違うと送らない', async () => {
    const user = userEvent.setup();
    await reachStage2(user);

    await fillStage2(user, { confirm: `${NEW_PASSWORD}x` });
    await user.click(screen.getByRole('button', { name: 'パスワードを変更する' }));

    expect(await screen.findByText('新しいパスワードが一致しません')).toBeInTheDocument();
    expect(callsTo('/api/auth/password/change/confirm')).toHaveLength(0);
  });

  it('SCR-AUTH-011 コードが 8 桁の数字でなければ送らずに断る', async () => {
    const user = userEvent.setup();
    await reachStage2(user);

    await fillStage2(user, { code: '1234' });
    await user.click(screen.getByRole('button', { name: 'パスワードを変更する' }));

    expect(await screen.findByText('確認コードは8桁の数字で入力してください')).toBeInTheDocument();
    expect(callsTo('/api/auth/password/change/confirm')).toHaveLength(0);
  });

  it('FLOW-AUTH-005 confirm が 200 なら成功の文を出し、ログイン状態を引き直して /login へ移る。送るのはコードと新しいパスワードだけ', async () => {
    const user = userEvent.setup();
    await reachStage2(user);
    queue(reply(200, { ok: true }));

    await fillStage2(user);
    await user.click(screen.getByRole('button', { name: 'パスワードを変更する' }));

    expect(
      await screen.findByText('パスワードを変更しました。全ての端末からログアウトしました。新しいパスワードでログインしてください。'),
    ).toBeInTheDocument();
    expect(bodyOf(callsTo('/api/auth/password/change/confirm')[0])).toEqual({ code: CODE, new_password: NEW_PASSWORD });
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/login'));
    expect(mockRefreshAuthState).toHaveBeenCalled();
  });

  it('SCR-AUTH-011 confirm が 401（コードの誤り）なら、サーバーの文を出し、残りの回数は言わない。欄は残して直せる', async () => {
    const user = userEvent.setup();
    await reachStage2(user);
    queue(reply(401, { error: CODE_ERROR }));

    await fillStage2(user);
    await user.click(screen.getByRole('button', { name: 'パスワードを変更する' }));

    const message = await screen.findByText(CODE_ERROR);
    expect(message.textContent).not.toMatch(/残り|回/);
    expect(screen.getByLabelText('確認コード')).toBeInTheDocument();
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('SCR-AUTH-011 confirm が 400（漏洩したパスワードなど）なら、サーバーの文を出す', async () => {
    const user = userEvent.setup();
    await reachStage2(user);
    queue(reply(400, { error: 'このパスワードは過去に漏洩しています。別のパスワードを入力してください。' }));

    await fillStage2(user);
    await user.click(screen.getByRole('button', { name: 'パスワードを変更する' }));

    expect(await screen.findByText('このパスワードは過去に漏洩しています。別のパスワードを入力してください。')).toBeInTheDocument();
  });

  it('SCR-AUTH-011 429 は「しばらくしてからお試しください」を出す（start・confirm とも）', async () => {
    const user = userEvent.setup();
    queue(reply(429, { error: 'Too many requests' }));
    render(<PasswordChangePage />);

    await submitCurrentPassword(user);
    expect(await screen.findByText('しばらくしてからお試しください。')).toBeInTheDocument();
    cleanup();

    await reachStage2(user);
    queue(reply(429, { error: 'Too many requests' }));
    await fillStage2(user);
    await user.click(screen.getByRole('button', { name: 'パスワードを変更する' }));
    expect(await screen.findByText('しばらくしてからお試しください。')).toBeInTheDocument();
  });

  it('SCR-AUTH-011 403（管理者・サポーターの aal2 不足）と 5xx は、それぞれ固定の文を出す', async () => {
    const user = userEvent.setup();
    queue(reply(403, { error: 'Forbidden' }));
    render(<PasswordChangePage />);

    await submitCurrentPassword(user);
    expect(await screen.findByText('二段階認証を完了してから、もう一度お試しください。')).toBeInTheDocument();
    cleanup();

    mockClientFetch.mockReset();
    queue(reply(500, { error: 'Internal server error' }));
    render(<PasswordChangePage />);
    await submitCurrentPassword(user);
    expect(await screen.findByText('処理に失敗しました。時間をおいて、もう一度お試しください。')).toBeInTheDocument();
  });

  it('SCR-AUTH-011 通信が失敗しても固定の文を出して段階 1 に留まる', async () => {
    const user = userEvent.setup();
    mockClientFetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    render(<PasswordChangePage />);

    await submitCurrentPassword(user);

    expect(await screen.findByText('処理に失敗しました。時間をおいて、もう一度お試しください。')).toBeInTheDocument();
    expect(screen.getByLabelText('現行のパスワード')).toBeInTheDocument();
  });

  it('SCR-AUTH-011 どの応答でも本文を読み切る（json() を呼ぶ）', async () => {
    const user = userEvent.setup();
    queue(reply(200, { ok: true }), reply(401, { error: CODE_ERROR }), reply(200, { ok: true }));
    render(<PasswordChangePage />);

    await submitCurrentPassword(user);
    await screen.findByLabelText('確認コード');
    await fillStage2(user);
    await user.click(screen.getByRole('button', { name: 'パスワードを変更する' }));
    await screen.findByText(CODE_ERROR);
    await user.clear(screen.getByLabelText('確認コード'));
    await user.type(screen.getByLabelText('確認コード'), CODE);
    await user.click(screen.getByRole('button', { name: 'パスワードを変更する' }));
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/login'));

    expect(jsonSpies).toHaveLength(3);
    for (const spy of jsonSpies) expect(spy).toHaveBeenCalledTimes(1);
  });

  it('SCR-AUTH-011 パスワードの欄は type=password で、autocomplete は current-password／new-password／コードは one-time-code', async () => {
    const user = userEvent.setup();
    render(<PasswordChangePage />);

    const current = screen.getByLabelText('現行のパスワード');
    expect(current).toHaveAttribute('type', 'password');
    expect(current).toHaveAttribute('autocomplete', 'current-password');

    cleanup();
    await reachStage2(user);
    const code = screen.getByLabelText('確認コード');
    expect(code).toHaveAttribute('autocomplete', 'one-time-code');
    expect(code).toHaveAttribute('inputmode', 'numeric');
    for (const name of ['新しいパスワード', '新しいパスワード（確認）']) {
      const field = screen.getByLabelText(name);
      expect(field).toHaveAttribute('type', 'password');
      expect(field).toHaveAttribute('autocomplete', 'new-password');
    }
  });

  it('SCR-AUTH-011 ラベルが入力に結ばれていて、アクセシブルな名前で取れる', async () => {
    const user = userEvent.setup();
    render(<PasswordChangePage />);
    expect(screen.getByLabelText('現行のパスワード')).toHaveAccessibleName('現行のパスワード');

    cleanup();
    await reachStage2(user);
    expect(screen.getByLabelText('確認コード')).toHaveAccessibleName('確認コード');
    expect(screen.getByLabelText('新しいパスワード')).toHaveAccessibleName('新しいパスワード');
    expect(screen.getByLabelText('新しいパスワード（確認）')).toHaveAccessibleName('新しいパスワード（確認）');
  });

  it('SCR-AUTH-011 段階 1 に Google だけで登録した会員向けの案内と /auth/password-reset へのリンクが出て、段階 2 では出ない', async () => {
    const user = userEvent.setup();
    render(<PasswordChangePage />);

    // 文の途中にリンクがあるので、段落の全文で探す
    expect(
      screen.getByText(
        (_, element) =>
          element?.tagName === 'P' &&
          element.textContent === 'Google でログインしていてパスワードを設定していない場合は、先にパスワードの再設定からパスワードを設定してください。',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'パスワードの再設定' })).toHaveAttribute('href', '/auth/password-reset');

    cleanup();
    await reachStage2(user);
    expect(screen.queryByRole('link', { name: 'パスワードの再設定' })).toBeNull();
    expect(screen.queryByText(/Google でログインしていて/)).toBeNull();
  });

  it('FLOW-AUTH-005 コードを送り直すと段階 1 へ戻り、入力済みの値は消える', async () => {
    const user = userEvent.setup();
    await reachStage2(user);
    await fillStage2(user);

    await user.click(screen.getByRole('button', { name: 'コードを送り直す' }));

    expect(screen.getByLabelText('現行のパスワード')).toHaveValue('');
    expect(screen.queryByLabelText('確認コード')).toBeNull();
    expect(callsTo('/api/auth/password/change/start')).toHaveLength(1);
  });

  it('SCR-AUTH-011 アカウントのお客様情報の欄に「パスワードを変更」のリンクがあり、/account/password へ向かう', async () => {
    mockClientFetch.mockImplementation(async () => respond(reply(200, {})));
    render(<AccountPage />);

    const link = await screen.findByRole('link', { name: 'パスワードを変更' });

    expect(link).toHaveAttribute('href', '/account/password');
  });

  it('SCR-AUTH-011 未ログインなら画面の代わりにログインの案内を出す（next つき）', () => {
    mockLoggedIn = false;
    render(<PasswordChangePage />);

    expect(screen.queryByLabelText('現行のパスワード')).toBeNull();
    expect(screen.getByRole('link', { name: 'ログイン' })).toHaveAttribute('href', '/login?next=%2Faccount%2Fpassword');
  });
});
