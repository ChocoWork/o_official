import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import LoginVerifyPage, { metadata } from '@/app/login/verify/page';
import { loginTwoFactorSessionCookieName } from '@/lib/cookie';

// 判定はサーバーの頁が持つ。Cookie と保留の検証だけを差し替え、画面の部品は本物を通す。
const mockCookieGet = jest.fn();
const mockVerifySession = jest.fn();
const mockRedirect = jest.fn((path: string) => {
  throw new Error(`NEXT_REDIRECT:${path}`);
});
const mockReplace = jest.fn();
const mockVerifyOtp = jest.fn();

jest.mock('next/headers', () => ({
  cookies: async () => ({ get: mockCookieGet }),
}));
jest.mock('next/navigation', () => ({
  redirect: (path: string) => mockRedirect(path),
  useRouter: () => ({ replace: (...args: unknown[]) => mockReplace(...args) }),
}));
jest.mock('@/features/auth/services/login-2fa-session', () => ({
  verifyLoginTwoFactorSessionToken: (token: unknown) => mockVerifySession(token),
}));
jest.mock('@/contexts/LoginContext', () => ({
  useLogin: () => ({ verifyOtp: (...args: unknown[]) => mockVerifyOtp(...args) }),
}));

type FetchInit = { method?: string };

const fetchMock = jest.fn();

function jsonResponse(status: number, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers[name] ?? null },
    json: async () => ({}),
  };
}

async function renderScreen(email = 'one@example.invalid') {
  mockCookieGet.mockReturnValue({ value: 'pending-token' });
  mockVerifySession.mockReturnValue({ email });
  render(await LoginVerifyPage());
}

function otpInputs() {
  return Array.from({ length: 8 }, (_, i) =>
    screen.getByLabelText(`認証コード ${i + 1} 桁目`),
  ) as HTMLInputElement[];
}

function fillCode(code: string) {
  otpInputs().forEach((input, i) => {
    fireEvent.change(input, { target: { value: code[i] ?? '' } });
  });
}

function pasteInto(input: HTMLElement, text: string) {
  fireEvent.paste(input, { clipboardData: { getData: () => text } });
}

function advance(ms: number) {
  act(() => {
    jest.advanceTimersByTime(ms);
  });
}

// 読み上げの入れ物は空のまま常に置かれるので、文言が入るまで待って確かめる。
async function expectLive(role: 'alert' | 'status', text: string) {
  await waitFor(() => expect(screen.getByRole(role)).toHaveTextContent(text));
}

async function openResend() {
  advance(60_000);
  return screen.findByRole('button', { name: '再送信' });
}

describe('/login/verify の画面', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCookieGet.mockReturnValue(undefined);
    mockVerifySession.mockReturnValue(null);
    global.fetch = fetchMock as unknown as typeof fetch;
    fetchMock.mockResolvedValue(jsonResponse(200));
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('サーバーの描画', () => {
    test('SCR-AUTH-004 保留の Cookie が無ければ入力の画面を描かず /login へ送る', async () => {
      await expect(LoginVerifyPage()).rejects.toThrow('NEXT_REDIRECT:/login');

      expect(mockVerifySession).toHaveBeenCalledWith(undefined);
      expect(mockRedirect).toHaveBeenCalledWith('/login');
      expect(screen.queryByLabelText('認証コード 1 桁目')).not.toBeInTheDocument();
    });

    test('SCR-AUTH-004 偽り・期限切れの印は無い時と同じに /login へ送る', async () => {
      mockCookieGet.mockReturnValue({ value: 'forged-or-expired' });
      mockVerifySession.mockReturnValue(null);

      await expect(LoginVerifyPage()).rejects.toThrow('NEXT_REDIRECT:/login');

      expect(mockCookieGet).toHaveBeenCalledWith(loginTwoFactorSessionCookieName);
      expect(mockVerifySession).toHaveBeenCalledWith('forged-or-expired');
    });

    test('SCR-AUTH-004 検索に載せない', () => {
      expect(metadata.robots).toEqual({ index: false, follow: false });
    });

    test('SCR-AUTH-004 保留が有効なら宛先を伏せて出し、8つの欄と5分の案内を出す', async () => {
      await renderScreen('one@example.invalid');

      expect(mockRedirect).not.toHaveBeenCalled();
      expect(screen.getByRole('heading', { name: '認証コードを入力' })).toBeInTheDocument();
      expect(screen.getByText('o***@example.invalid 宛に送信しました')).toBeInTheDocument();
      expect(screen.queryByText(/one@example\.invalid/)).not.toBeInTheDocument();
      expect(screen.getByText('コードは5分間有効です')).toBeInTheDocument();
      expect(otpInputs()).toHaveLength(8);
      expect(otpInputs()[0]).toHaveAttribute('autocomplete', 'one-time-code');
      expect(otpInputs()[1]).toHaveAttribute('autocomplete', 'off');
    });

    test('SCR-AUTH-004 伏せられない宛先は宛先の行ごと出さない', async () => {
      await renderScreen('not-an-address');

      expect(screen.queryByText(/宛に送信しました/)).not.toBeInTheDocument();
      expect(screen.getByText('コードは5分間有効です')).toBeInTheDocument();
    });
  });

  describe('コードの入力', () => {
    test('SCR-AUTH-004 数字以外を捨て、1桁入れると次の欄へ移る', async () => {
      await renderScreen();
      const inputs = otpInputs();

      fireEvent.change(inputs[0], { target: { value: 'a' } });
      expect(inputs[0]).toHaveValue('');
      expect(document.activeElement).not.toBe(inputs[1]);

      fireEvent.change(inputs[0], { target: { value: '7' } });
      expect(inputs[0]).toHaveValue('7');
      expect(document.activeElement).toBe(inputs[1]);
    });

    test('SCR-AUTH-004 空にすると、その欄だけ消える', async () => {
      await renderScreen();
      const inputs = otpInputs();
      fireEvent.change(inputs[0], { target: { value: '7' } });

      fireEvent.change(inputs[0], { target: { value: '' } });

      expect(inputs[0]).toHaveValue('');
    });

    test('SCR-AUTH-004 複数桁を入れると並べて入れ、最後の欄で止まる', async () => {
      await renderScreen();
      const inputs = otpInputs();

      fireEvent.change(inputs[6], { target: { value: '123' } });

      expect(inputs[6]).toHaveValue('1');
      expect(inputs[7]).toHaveValue('2');
      expect(document.activeElement).toBe(inputs[7]);
    });

    test('SCR-AUTH-004 貼り付けを順に入れ、数字だけを拾う', async () => {
      await renderScreen();
      const inputs = otpInputs();

      pasteInto(inputs[0], '12-34 5678');

      expect(inputs.map((i) => i.value).join('')).toBe('12345678');
      expect(document.activeElement).toBe(inputs[7]);
    });

    test('SCR-AUTH-004 数字の無い貼り付けは何も入れない', async () => {
      await renderScreen();
      const inputs = otpInputs();

      pasteInto(inputs[0], 'abc');

      expect(inputs.every((i) => i.value === '')).toBe(true);
    });

    test('SCR-AUTH-004 Backspace は入っていれば消し、空なら前の欄を消して戻る', async () => {
      await renderScreen();
      const inputs = otpInputs();
      fireEvent.change(inputs[0], { target: { value: '1' } });
      fireEvent.change(inputs[1], { target: { value: '2' } });

      fireEvent.keyDown(inputs[1], { key: 'Backspace' });
      expect(inputs[1]).toHaveValue('');
      expect(inputs[0]).toHaveValue('1');

      fireEvent.keyDown(inputs[1], { key: 'Backspace' });
      advance(0);
      expect(inputs[0]).toHaveValue('');
      expect(document.activeElement).toBe(inputs[0]);
    });

    test('SCR-AUTH-004 先頭の空の欄の Backspace は何もしない', async () => {
      await renderScreen();
      const inputs = otpInputs();

      fireEvent.keyDown(inputs[0], { key: 'Backspace' });

      expect(inputs.every((i) => i.value === '')).toBe(true);
    });

    test('SCR-AUTH-004 矢印の左右で隣の欄へ移り、端では動かない', async () => {
      await renderScreen();
      const inputs = otpInputs();
      inputs[3].focus();

      fireEvent.keyDown(inputs[3], { key: 'ArrowRight' });
      expect(document.activeElement).toBe(inputs[4]);
      fireEvent.keyDown(inputs[4], { key: 'ArrowLeft' });
      expect(document.activeElement).toBe(inputs[3]);

      inputs[0].focus();
      fireEvent.keyDown(inputs[0], { key: 'ArrowLeft' });
      expect(document.activeElement).toBe(inputs[0]);
      inputs[7].focus();
      fireEvent.keyDown(inputs[7], { key: 'ArrowRight' });
      expect(document.activeElement).toBe(inputs[7]);
    });

    test('SCR-AUTH-004 そのほかのキーは素通しにする', async () => {
      await renderScreen();
      const inputs = otpInputs();

      const notPrevented = fireEvent.keyDown(inputs[2], { key: 'a' });

      expect(notPrevented).toBe(true);
    });
  });

  describe('送信', () => {
    test('SCR-AUTH-004 8桁に満たない間は送信のボタンを押せない', async () => {
      await renderScreen();
      expect(screen.getByRole('button', { name: 'サインイン' })).toBeDisabled();

      fillCode('1234567');
      expect(screen.getByRole('button', { name: 'サインイン' })).toBeDisabled();

      fillCode('12345678');
      expect(screen.getByRole('button', { name: 'サインイン' })).toBeEnabled();
    });

    test('SCR-AUTH-004 8桁でなければ送らずに文を出す', async () => {
      await renderScreen();
      fillCode('123');

      fireEvent.submit(document.querySelector('form') as HTMLFormElement);

      await expectLive('alert', '認証コードは8桁で入力してください');
      expect(mockVerifyOtp).not.toHaveBeenCalled();
    });

    test('SCR-AUTH-004 失敗の文は窓口の文をそのまま出し、移らない', async () => {
      mockVerifyOtp.mockResolvedValue({ success: false, error: 'コードが正しくありません' });
      await renderScreen();
      fillCode('12345678');

      fireEvent.click(screen.getByRole('button', { name: 'サインイン' }));

      await expectLive('alert', 'コードが正しくありません');
      expect(mockVerifyOtp).toHaveBeenCalledWith('12345678');
      expect(mockReplace).not.toHaveBeenCalled();
    });

    test('SCR-AUTH-004 失敗の理由が無ければ既定の文を出す', async () => {
      mockVerifyOtp.mockResolvedValue({ success: false });
      await renderScreen();
      fillCode('12345678');

      fireEvent.click(screen.getByRole('button', { name: 'サインイン' }));

      await expectLive('alert', '認証コードの確認に失敗しました');
    });

    test('SCR-AUTH-004 予期しない例外は握って文を出し、ボタンを戻す', async () => {
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      mockVerifyOtp.mockRejectedValue(new Error('boom'));
      await renderScreen();
      fillCode('12345678');

      fireEvent.click(screen.getByRole('button', { name: 'サインイン' }));

      await expectLive('alert', '認証コードの確認に失敗しました');
      await waitFor(() => expect(screen.getByRole('button', { name: 'サインイン' })).toBeEnabled());
      errorSpy.mockRestore();
    });

    test('SCR-AUTH-004 確認の間は処理中を出して二重に押せない', async () => {
      let resolveVerify: (v: { success: boolean; error?: string }) => void = () => undefined;
      mockVerifyOtp.mockReturnValue(new Promise((resolve) => { resolveVerify = resolve; }));
      await renderScreen();
      fillCode('12345678');

      fireEvent.click(screen.getByRole('button', { name: 'サインイン' }));

      expect(await screen.findByRole('button', { name: '処理中...' })).toBeDisabled();
      await act(async () => {
        resolveVerify({ success: false, error: 'x' });
      });
      expect(screen.getByRole('button', { name: 'サインイン' })).toBeEnabled();
    });
  });

  describe('再送の待ち', () => {
    test('SCR-AUTH-004 最初は 60 秒の待ちを出し、1秒ごとに減らす', async () => {
      await renderScreen();

      expect(screen.getByText('1分 00秒後に再送可能')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: '再送信' })).not.toBeInTheDocument();

      advance(1000);
      expect(screen.getByText('0分 59秒後に再送可能')).toBeInTheDocument();
    });

    test('SCR-AUTH-004 待ちが明けたら再送のボタンに替わる', async () => {
      await renderScreen();

      expect(await openResend()).toBeEnabled();
      expect(screen.queryByText(/後に再送可能/)).not.toBeInTheDocument();
    });

    test('SCR-AUTH-004 経過時刻から引き直すので、タイマーが間引かれても待ちはずれない', async () => {
      await renderScreen();
      const base = Date.now();
      const spy = jest.spyOn(Date, 'now').mockReturnValue(base + 45_000);

      advance(1000);

      expect(screen.getByText('0分 15秒後に再送可能')).toBeInTheDocument();
      spy.mockRestore();
    });
  });

  describe('再送', () => {
    test('SCR-AUTH-004 パスワードも宛先も送らずに再送の窓口を呼び、欄を空にして待ちを戻す', async () => {
      await renderScreen();
      fillCode('1234');
      const button = await openResend();

      fireEvent.click(button);

      await expectLive('status', '認証コードを再送信しました。');
      const [url, init] = fetchMock.mock.calls[0] as [string, FetchInit & { body?: unknown }];
      expect(url).toBe('/api/auth/login/resend');
      expect(init.method).toBe('POST');
      expect(init.body).toBeUndefined();
      expect(otpInputs().every((i) => i.value === '')).toBe(true);
      expect(screen.getByText('1分 00秒後に再送可能')).toBeInTheDocument();
      advance(0);
      expect(document.activeElement).toBe(otpInputs()[0]);
    });

    test('SCR-AUTH-004 401 は /login へ置き換えて移る', async () => {
      fetchMock.mockResolvedValue(jsonResponse(401));
      await renderScreen();

      fireEvent.click(await openResend());

      await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/login'));
    });

    test('SCR-AUTH-004 429 の Retry-After が秒なら、その秒を待ちに入れる', async () => {
      fetchMock.mockResolvedValue(jsonResponse(429, { 'Retry-After': '120' }));
      await renderScreen();

      fireEvent.click(await openResend());

      await expectLive('alert', '送信回数の上限に達しました。時間をおいて再度お試しください。');
      expect(screen.getByText('2分 00秒後に再送可能')).toBeInTheDocument();
    });

    test('SCR-AUTH-004 429 の Retry-After が日付なら、その日付までの秒を待ちに入れる', async () => {
      const retryAt = new Date(Date.now() + 60_000 + 90_000).toUTCString();
      fetchMock.mockResolvedValue(jsonResponse(429, { 'Retry-After': retryAt }));
      await renderScreen();

      fireEvent.click(await openResend());

      await expectLive('alert', '送信回数の上限');
      expect(screen.getByText(/^1分 [0-9]{2}秒後に再送可能$/)).toBeInTheDocument();
    });

    test('SCR-AUTH-004 429 で Retry-After が読めなければ 60 秒を待つ', async () => {
      fetchMock.mockResolvedValue(jsonResponse(429, { 'Retry-After': 'soon' }));
      await renderScreen();

      fireEvent.click(await openResend());

      expect(await screen.findByText('1分 00秒後に再送可能')).toBeInTheDocument();
    });

    test('SCR-AUTH-004 429 で Retry-After が無ければ 60 秒を待つ', async () => {
      fetchMock.mockResolvedValue(jsonResponse(429));
      await renderScreen();

      fireEvent.click(await openResend());

      expect(await screen.findByText('1分 00秒後に再送可能')).toBeInTheDocument();
    });

    test('SCR-AUTH-004 503 は一時的に使えない案内を出し、再送のボタンを残す', async () => {
      fetchMock.mockResolvedValue(jsonResponse(503));
      await renderScreen();

      fireEvent.click(await openResend());

      await expectLive('alert', '一時的に認証処理を利用できません。時間をおいて再度お試しください。');
      expect(screen.getByRole('button', { name: '再送信' })).toBeEnabled();
    });

    test('SCR-AUTH-004 そのほかの失敗は送信失敗の文を出す', async () => {
      fetchMock.mockResolvedValue(jsonResponse(500));
      await renderScreen();

      fireEvent.click(await openResend());

      await expectLive('alert', '認証コードの送信に失敗しました');
    });

    test('SCR-AUTH-004 通信が落ちても握って送信失敗の文を出す', async () => {
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      fetchMock.mockRejectedValue(new Error('network'));
      await renderScreen();

      fireEvent.click(await openResend());

      await expectLive('alert', '認証コードの送信に失敗しました');
      errorSpy.mockRestore();
    });
  });

  describe('やり直し', () => {
    test('SCR-AUTH-004 保留を捨てる窓口を呼んでから /login へ置き換える', async () => {
      await renderScreen();

      fireEvent.click(screen.getByRole('button', { name: '別のアドレスでやり直す' }));

      await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/login'));
      const [url, init] = fetchMock.mock.calls[0] as [string, FetchInit];
      expect(url).toBe('/api/auth/login/cancel');
      expect(init.method).toBe('POST');
      expect(fetchMock.mock.invocationCallOrder[0]).toBeLessThan(mockReplace.mock.invocationCallOrder[0]);
    });

    test('SCR-AUTH-004 窓口が落ちていても /login へ置き換える', async () => {
      fetchMock.mockRejectedValue(new Error('network'));
      await renderScreen();

      fireEvent.click(screen.getByRole('button', { name: '別のアドレスでやり直す' }));

      await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/login'));
    });
  });
});
