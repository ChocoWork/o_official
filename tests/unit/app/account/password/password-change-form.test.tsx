/**
 * @jest-environment jsdom
 */
/**
 * DD-AUTH-042 /account/password の頁と本体（PasswordChangeForm）の分岐。
 * 段の見え方と移り変わりは結合テスト（tests/integration/ui/auth-password-change.test.tsx）が通す。
 * ここは応答ごとの文の選び方、入力の確かめ、二重送信、成功の後始末を 1 つずつ確かめる。
 */
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PasswordChangePage, { metadata } from '@/app/account/password/page';

const mockReplace = jest.fn();
const mockRefreshAuthState = jest.fn();
const mockRefreshSessionOnce = jest.fn();
const mockLoginState = { isLoggedIn: true, isAuthResolved: true };

jest.mock('next/navigation', () => ({
  usePathname: () => '/account/password',
  useRouter: () => ({ push: jest.fn(), replace: mockReplace, refresh: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

jest.mock('@/contexts/LoginContext', () => ({
  useLogin: () => ({ ...mockLoginState, refreshAuthState: mockRefreshAuthState }),
}));

const mockClientFetch = jest.fn();
jest.mock('@/lib/client-fetch', () => ({
  clientFetch: (...args: unknown[]) => mockClientFetch(...args),
  refreshSessionOnce: (...args: unknown[]) => mockRefreshSessionOnce(...args),
}));

const FAILED = '処理に失敗しました。時間をおいて、もう一度お試しください。';
const CODE_ERROR = '確認コードが正しくないか、期限が切れています。もう一度コードを送ってください。';
const CURRENT_ERROR = '現行のパスワードが正しくありません。';
const NEW_PASSWORD = 'correct-horse-battery-staple';

function response(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => body };
}

async function submitStage1(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText('現行のパスワード'), 'current-password-value');
  await user.click(screen.getByRole('button', { name: '確認コードをメールに送る' }));
}

async function toStage2(user: ReturnType<typeof userEvent.setup>) {
  mockClientFetch.mockResolvedValueOnce(response(200, { ok: true }));
  render(<PasswordChangePage />);
  await submitStage1(user);
  await screen.findByLabelText('確認コード');
}

async function submitStage2(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText('確認コード'), '12345678');
  await user.type(screen.getByLabelText('新しいパスワード'), NEW_PASSWORD);
  await user.type(screen.getByLabelText('新しいパスワード（確認）'), NEW_PASSWORD);
  await user.click(screen.getByRole('button', { name: 'パスワードを変更する' }));
}

describe('DD-AUTH-042 パスワード変更の画面の分岐', () => {
  beforeEach(() => {
    mockClientFetch.mockReset();
    mockReplace.mockReset();
    mockRefreshAuthState.mockReset();
    mockRefreshAuthState.mockResolvedValue(undefined);
    mockRefreshSessionOnce.mockReset();
    mockLoginState.isLoggedIn = true;
    mockLoginState.isAuthResolved = true;
  });

  afterEach(() => {
    cleanup();
  });

  it('DD-AUTH-042 頁は題を返し、索引に載せない指定を持つ', () => {
    expect(metadata.title).toBe('PASSWORD | Le Fil des Heures');
    expect(metadata.robots).toEqual({ index: false });
  });

  it('DD-AUTH-042 現行パスワードが空なら送らずに「現行のパスワードが正しくありません。」を出す', async () => {
    const user = userEvent.setup();
    render(<PasswordChangePage />);

    await user.click(screen.getByRole('button', { name: '確認コードをメールに送る' }));

    expect(await screen.findByText(CURRENT_ERROR)).toBeInTheDocument();
    expect(mockClientFetch).not.toHaveBeenCalled();
  });

  it('DD-AUTH-042 start の 401 で本文に文が無ければ、現行パスワードの誤りの文にする', async () => {
    const user = userEvent.setup();
    mockClientFetch.mockResolvedValueOnce(response(401, {}));
    render(<PasswordChangePage />);

    await submitStage1(user);

    expect(await screen.findByText(CURRENT_ERROR)).toBeInTheDocument();
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('DD-AUTH-042 confirm の 401 で本文に文が無ければ、コードの誤りの文にする', async () => {
    const user = userEvent.setup();
    await toStage2(user);
    mockClientFetch.mockResolvedValueOnce(response(401, null));

    await submitStage2(user);

    expect(await screen.findByText(CODE_ERROR)).toBeInTheDocument();
  });

  it('DD-AUTH-042 400 で本文に文が無ければ「入力に誤りがあります。」を出す', async () => {
    const user = userEvent.setup();
    mockClientFetch.mockResolvedValueOnce(response(400, {}));
    render(<PasswordChangePage />);

    await submitStage1(user);

    expect(await screen.findByText('入力に誤りがあります。')).toBeInTheDocument();
  });

  it('DD-AUTH-042 400 の validation_error は窓口の message をそのまま出す', async () => {
    const user = userEvent.setup();
    mockClientFetch.mockResolvedValueOnce(response(400, { code: 'validation_error', message: '入力に誤りがあります' }));
    render(<PasswordChangePage />);

    await submitStage1(user);

    expect(await screen.findByText('入力に誤りがあります')).toBeInTheDocument();
  });

  it('DD-AUTH-042 403 は二段階認証の案内の文、429 はしばらく待つ文', async () => {
    const user = userEvent.setup();
    mockClientFetch.mockResolvedValueOnce(response(403, { error: 'Forbidden' }));
    render(<PasswordChangePage />);
    await submitStage1(user);
    expect(await screen.findByText('二段階認証を完了してから、もう一度お試しください。')).toBeInTheDocument();

    mockClientFetch.mockResolvedValueOnce(response(429, { error: 'Too many requests' }));
    await user.click(screen.getByRole('button', { name: '確認コードをメールに送る' }));
    expect(await screen.findByText('しばらくしてからお試しください。')).toBeInTheDocument();
    expect(screen.queryByText('二段階認証を完了してから、もう一度お試しください。')).toBeNull();
  });

  it('DD-AUTH-042 5xx は窓口の文を出さず固定の文だけ。本文が JSON でなくても本文を読み切って固定の文', async () => {
    const user = userEvent.setup();
    mockClientFetch.mockResolvedValueOnce(response(500, { error: 'internal detail that must not be shown' }));
    render(<PasswordChangePage />);
    await submitStage1(user);
    expect(await screen.findByText(FAILED)).toBeInTheDocument();
    expect(screen.queryByText(/internal detail/)).toBeNull();

    const notJson = { ok: false, status: 503, headers: { get: () => null }, json: async () => { throw new SyntaxError('Unexpected token'); } };
    mockClientFetch.mockResolvedValueOnce(notJson);
    await user.click(screen.getByRole('button', { name: '確認コードをメールに送る' }));
    await waitFor(() => expect(mockClientFetch).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(FAILED)).toBeInTheDocument();
  });

  it('DD-AUTH-042 送信中はボタンを無効にし、2 回目の送信は通信しない', async () => {
    const user = userEvent.setup();
    let resolveFetch: (value: unknown) => void = () => undefined;
    mockClientFetch.mockReturnValueOnce(new Promise((resolve) => { resolveFetch = resolve; }));
    render(<PasswordChangePage />);
    await user.type(screen.getByLabelText('現行のパスワード'), 'current-password-value');

    await user.click(screen.getByRole('button', { name: '確認コードをメールに送る' }));
    const pending = await screen.findByRole('button', { name: '送信中...' });
    expect(pending).toBeDisabled();
    await user.keyboard('{Enter}');
    fireEvent.submit(pending.closest('form') as HTMLFormElement);

    resolveFetch(response(401, { error: CURRENT_ERROR }));
    await screen.findByText(CURRENT_ERROR);
    expect(mockClientFetch).toHaveBeenCalledTimes(1);
  });

  it('DD-AUTH-042 ログイン状態が確かめ終わるまでは「読み込み中...」だけを出し、フォームを出さない', () => {
    mockLoginState.isAuthResolved = false;
    render(<PasswordChangePage />);

    expect(screen.getByText('読み込み中...')).toBeInTheDocument();
    expect(screen.queryByLabelText('現行のパスワード')).toBeNull();
  });

  it('DD-AUTH-042 ログインしていなければ、フォームの代わりにログインの案内とログインへのリンクを出す', () => {
    mockLoginState.isLoggedIn = false;
    render(<PasswordChangePage />);

    expect(screen.getByText('パスワードの変更には、ログインが必要です。')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'ログイン' })).toHaveAttribute('href', expect.stringMatching(/^\/login/));
    expect(screen.queryByLabelText('現行のパスワード')).toBeNull();
  });

  it('DD-AUTH-042 start が 401 の Unauthorized で印も更新できなければ、再送せずログインへ移る', async () => {
    const user = userEvent.setup();
    mockClientFetch.mockResolvedValueOnce(response(401, { error: 'Unauthorized' }));
    mockRefreshSessionOnce.mockResolvedValueOnce('expired');
    render(<PasswordChangePage />);

    await submitStage1(user);

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith(expect.stringMatching(/^\/login/)));
    expect(mockRefreshSessionOnce).toHaveBeenCalledTimes(1);
    expect(mockClientFetch).toHaveBeenCalledTimes(1);
  });

  it('DD-AUTH-042 start が 401 の Unauthorized でも印を更新できれば、同じ本文で 1 回だけ送り直して次の段へ進む', async () => {
    const user = userEvent.setup();
    mockClientFetch
      .mockResolvedValueOnce(response(401, { error: 'Unauthorized' }))
      .mockResolvedValueOnce(response(200, { ok: true }));
    mockRefreshSessionOnce.mockResolvedValueOnce('refreshed');
    render(<PasswordChangePage />);

    await submitStage1(user);

    expect(await screen.findByLabelText('確認コード')).toBeInTheDocument();
    expect(mockClientFetch).toHaveBeenCalledTimes(2);
    expect(mockClientFetch.mock.calls[1][1].body).toBe(mockClientFetch.mock.calls[0][1].body);
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('DD-AUTH-042 confirm が 401 の Unauthorized で印を更新できなければ、ログインへ移り、成功の文は出さない', async () => {
    const user = userEvent.setup();
    await toStage2(user);
    mockClientFetch.mockResolvedValueOnce(response(401, { error: 'Unauthorized' }));
    mockRefreshSessionOnce.mockResolvedValueOnce('expired');

    await submitStage2(user);

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith(expect.stringMatching(/^\/login/)));
    expect(mockRefreshAuthState).not.toHaveBeenCalled();
    expect(screen.queryByText(/パスワードを変更しました/)).toBeNull();
  });

  it('DD-AUTH-042 確認コードが 8 桁の数字でなければ送らずに形式の文を出す', async () => {
    const user = userEvent.setup();
    await toStage2(user);
    mockClientFetch.mockClear();

    await user.type(screen.getByLabelText('確認コード'), '1234567');
    await user.type(screen.getByLabelText('新しいパスワード'), NEW_PASSWORD);
    await user.type(screen.getByLabelText('新しいパスワード（確認）'), NEW_PASSWORD);
    await user.click(screen.getByRole('button', { name: 'パスワードを変更する' }));

    expect(await screen.findByText('確認コードは8桁の数字で入力してください')).toBeInTheDocument();
    expect(mockClientFetch).not.toHaveBeenCalled();
  });

  it('DD-AUTH-042 新しいパスワードが 16 文字未満なら送らずに短い旨の文を出す', async () => {
    const user = userEvent.setup();
    await toStage2(user);
    mockClientFetch.mockClear();

    await user.type(screen.getByLabelText('確認コード'), '12345678');
    await user.type(screen.getByLabelText('新しいパスワード'), 'a'.repeat(15));
    await user.type(screen.getByLabelText('新しいパスワード（確認）'), 'a'.repeat(15));
    await user.click(screen.getByRole('button', { name: 'パスワードを変更する' }));

    expect(await screen.findByText('パスワードは16文字以上で入力してください')).toBeInTheDocument();
    expect(mockClientFetch).not.toHaveBeenCalled();
  });

  it('DD-AUTH-042 新しいパスワードが 72 バイトを超えるなら（全角は 3 バイト）送らずに長すぎる旨の文を出す', async () => {
    const user = userEvent.setup();
    await toStage2(user);
    mockClientFetch.mockClear();
    const tooLong = 'あ'.repeat(25);

    await user.type(screen.getByLabelText('確認コード'), '12345678');
    await user.type(screen.getByLabelText('新しいパスワード'), tooLong);
    await user.type(screen.getByLabelText('新しいパスワード（確認）'), tooLong);
    await user.click(screen.getByRole('button', { name: 'パスワードを変更する' }));

    expect(
      await screen.findByText('パスワードは72バイト以内にしてください（全角の文字は1文字で3バイトです）'),
    ).toBeInTheDocument();
    expect(mockClientFetch).not.toHaveBeenCalled();
  });

  it('DD-AUTH-042 確認欄が新しいパスワードと違えば送らずに一致しない旨の文を出す', async () => {
    const user = userEvent.setup();
    await toStage2(user);
    mockClientFetch.mockClear();

    await user.type(screen.getByLabelText('確認コード'), '12345678');
    await user.type(screen.getByLabelText('新しいパスワード'), NEW_PASSWORD);
    await user.type(screen.getByLabelText('新しいパスワード（確認）'), `${NEW_PASSWORD}x`);
    await user.click(screen.getByRole('button', { name: 'パスワードを変更する' }));

    expect(await screen.findByText('新しいパスワードが一致しません')).toBeInTheDocument();
    expect(mockClientFetch).not.toHaveBeenCalled();
  });

  it('DD-AUTH-042 変更中はボタンを無効にし、2 回目の送信は通信しない', async () => {
    const user = userEvent.setup();
    await toStage2(user);
    mockClientFetch.mockClear();
    let resolveFetch: (value: unknown) => void = () => undefined;
    mockClientFetch.mockReturnValueOnce(new Promise((resolve) => { resolveFetch = resolve; }));

    await submitStage2(user);
    const pending = await screen.findByRole('button', { name: '変更中...' });
    expect(pending).toBeDisabled();
    await user.keyboard('{Enter}');
    fireEvent.submit(pending.closest('form') as HTMLFormElement);

    resolveFetch(response(401, { error: CODE_ERROR }));
    await screen.findByText(CODE_ERROR);
    expect(mockClientFetch).toHaveBeenCalledTimes(1);
  });

  it('DD-AUTH-042 start が 200 になったら現行パスワードの欄の値を捨てる（コードを送り直すで戻っても空）', async () => {
    const user = userEvent.setup();
    await toStage2(user);

    await user.click(screen.getByRole('button', { name: 'コードを送り直す' }));

    expect(screen.getByLabelText('現行のパスワード')).toHaveValue('');
  });

  it('DD-AUTH-042 ログイン状態の引き直しが失敗しても /login へ移る', async () => {
    const user = userEvent.setup();
    await toStage2(user);
    mockClientFetch.mockResolvedValueOnce(response(200, { ok: true }));
    mockRefreshAuthState.mockRejectedValueOnce(new Error('network'));

    await submitStage2(user);

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/login'));
    expect(mockRefreshAuthState).toHaveBeenCalledTimes(1);
  });

  it('DD-AUTH-042 成功の後は成功の文だけを出し、フォームの欄は残さない', async () => {
    const user = userEvent.setup();
    await toStage2(user);
    mockClientFetch.mockResolvedValueOnce(response(200, { ok: true }));

    await submitStage2(user);

    expect(
      await screen.findByText('パスワードを変更しました。全ての端末からログアウトしました。新しいパスワードでログインしてください。'),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('新しいパスワード')).toBeNull();
    expect(screen.queryByLabelText('確認コード')).toBeNull();
  });
});
