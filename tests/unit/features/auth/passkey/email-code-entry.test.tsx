import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import EmailCodeEntry from '@/features/auth/passkey/components/EmailCodeEntry';

const mockReplace = jest.fn();
const mockRefresh = jest.fn();
const mockSupported = jest.fn();
const mockResolve = jest.fn();
jest.mock('next/navigation', () => ({ useRouter: () => ({ replace: mockReplace }) }));
jest.mock('@/contexts/LoginContext', () => ({ useLogin: () => ({ refreshAuthState: mockRefresh }) }));
jest.mock('@/features/auth/passkey/webauthn-browser', () => ({ isPasskeySupported: () => mockSupported() }));
jest.mock('@/features/auth/passkey/post-login', () => ({ resolvePostLoginPath: () => mockResolve() }));

const EMAIL = 'one@example.invalid';
const CODE = '12345678';

function inputs() {
  return Array.from({ length: 8 }, (_, i) => screen.getByLabelText(`確認コード ${i + 1}桁目`) as HTMLInputElement);
}

function pasteAt(index: number, text: string) {
  return fireEvent.paste(inputs()[index], { clipboardData: { getData: () => text } });
}

function loginButton() {
  return screen.getByRole('button', { name: 'ログイン' });
}

function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

async function submitCode() {
  render(<EmailCodeEntry email={EMAIL} />);
  pasteAt(0, CODE);
  await act(async () => {
    fireEvent.submit(loginButton().closest('form') as HTMLFormElement);
  });
}

describe('EmailCodeEntry', () => {
  const originalFetch = global.fetch;
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-11-18T02:00:00Z'));
    jest.clearAllMocks();
    mockSupported.mockReturnValue(true);
    mockResolve.mockResolvedValue('/account');
    global.fetch = jest.fn();
  });
  afterEach(() => {
    jest.useRealTimers();
    global.fetch = originalFetch;
  });

  test('DD-AUTH-062 見出し・説明・いつも出す案内・入力の属性', () => {
    render(<EmailCodeEntry email={EMAIL} />);
    expect(screen.getByRole('heading', { name: '確認コードを入力してください' })).toBeInTheDocument();
    expect(screen.getByText('o***@example.invalid に8桁のコードをお送りしました。5分以内に入力してください。', { exact: false })).toBeInTheDocument();
    expect(screen.getByText('コードの無い確認のメールが届いた時は、そのメールのリンクを押してから、もう一度お試しください。')).toBeInTheDocument();
    const first = inputs()[0];
    expect(first).toHaveAttribute('autocomplete', 'one-time-code');
    expect(first).toHaveAttribute('inputmode', 'numeric');
    expect(first).toHaveFocus();
    expect(screen.getByRole('button', { name: 'メールアドレスを入れ直す' })).toBeInTheDocument();
  });

  test('DD-AUTH-062 8桁そろうまでログインは disabled、貼り付けで8桁が割り振られる', () => {
    render(<EmailCodeEntry email={EMAIL} />);
    expect(loginButton()).toBeDisabled();
    pasteAt(0, '1234');
    expect(inputs().map((i) => i.value)).toEqual(['1', '2', '3', '4', '', '', '', '']);
    expect(loginButton()).toBeDisabled();
    pasteAt(4, '5a678-9');
    expect(inputs().map((i) => i.value)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8']);
    expect(loginButton()).toBeEnabled();
  });

  test('DD-AUTH-062 Backspace で空の欄なら前の欄を消して戻る', () => {
    render(<EmailCodeEntry email={EMAIL} />);
    pasteAt(0, '12');
    fireEvent.keyDown(inputs()[2], { key: 'Backspace' });
    act(() => {
      jest.advanceTimersByTime(0);
    });
    expect(inputs().map((i) => i.value).slice(0, 3)).toEqual(['1', '', '']);
    expect(inputs()[1]).toHaveFocus();
  });

  test('DD-AUTH-062 成功で offerPasskey が真かつ対応のブラウザなら /login/passkey へ置き換える', async () => {
    jest.mocked(global.fetch).mockResolvedValue(json(200, { user: { id: 'u' }, offerPasskey: true }));
    await submitCode();
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/auth/email-code/verify',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ code: CODE }) }),
    );
    expect(mockRefresh).toHaveBeenCalled();
    expect(mockReplace).toHaveBeenCalledWith('/login/passkey');
    expect(mockResolve).not.toHaveBeenCalled();
  });

  test('DD-AUTH-062 offerPasskey が偽なら post-login の行き先へ置き換える', async () => {
    jest.mocked(global.fetch).mockResolvedValue(json(200, { user: { id: 'u' }, offerPasskey: false }));
    await submitCode();
    expect(mockRefresh).toHaveBeenCalled();
    expect(mockReplace).toHaveBeenCalledWith('/account');
  });

  test('DD-AUTH-062 offerPasskey が真でも未対応のブラウザなら勧めを飛ばす', async () => {
    mockSupported.mockReturnValue(false);
    jest.mocked(global.fetch).mockResolvedValue(json(200, { user: { id: 'u' }, offerPasskey: true }));
    await submitCode();
    expect(mockReplace).toHaveBeenCalledWith('/account');
    expect(mockReplace).not.toHaveBeenCalledWith('/login/passkey');
  });

  test('DD-AUTH-062 offerPasskey が無い・読めない本文でも勧めない', async () => {
    jest.mocked(global.fetch).mockResolvedValue(new Response('not json', { status: 200 }));
    await submitCode();
    expect(mockReplace).toHaveBeenCalledWith('/account');
  });

  test('DD-AUTH-062 401（コードの誤り）は文言を出し、入力を続けられる', async () => {
    jest.mocked(global.fetch).mockResolvedValue(json(401, { error: '認証コードが無効、または期限切れです。' }));
    await submitCode();
    expect(screen.getByRole('alert')).toHaveTextContent('確認コードが無効、または期限切れです。');
    expect(mockReplace).not.toHaveBeenCalled();
    expect(inputs()[0]).toBeEnabled();
  });

  test('DD-AUTH-062 401（保留の Cookie 切れ）は文言を出して /login へ戻す', async () => {
    jest.mocked(global.fetch).mockResolvedValue(
      json(401, { error: 'セッションの有効期限が切れました。もう一度メールアドレスを入力してください。' }),
    );
    await submitCode();
    expect(screen.getByRole('alert')).toHaveTextContent('時間がたちました。もう一度メールアドレスを入れてください。');
    expect(loginButton()).toBeDisabled();
    act(() => {
      jest.advanceTimersByTime(3000);
    });
    expect(mockReplace).toHaveBeenCalledWith('/login');
  });

  test('DD-AUTH-062 429 は保留を閉じ、文言を出して /login へ戻す', async () => {
    jest.mocked(global.fetch).mockResolvedValue(json(429, { error: 'Too many requests' }));
    await submitCode();
    expect(screen.getByRole('alert')).toHaveTextContent('試行が集中しています。しばらくしてからやり直してください。');
    expect(loginButton()).toBeDisabled();
    act(() => {
      jest.advanceTimersByTime(3000);
    });
    expect(mockReplace).toHaveBeenCalledWith('/login');
  });

  test('DD-AUTH-062 403 staff_passkey_required は案内だけを出し、再送を止めて自動では戻さない', async () => {
    jest.mocked(global.fetch).mockResolvedValue(json(403, { error: 'staff_passkey_required' }));
    await submitCode();
    expect(screen.getByRole('alert')).toHaveTextContent('店員の方は、パスキーでログインしてください。');
    expect(screen.queryByRole('button', { name: 'コードを再送する' })).not.toBeInTheDocument();
    expect(loginButton()).toBeDisabled();
    inputs().forEach((i) => expect(i).toBeDisabled());
    act(() => {
      jest.advanceTimersByTime(10000);
    });
    expect(mockReplace).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'ログイン画面へ戻る' }));
    expect(mockReplace).toHaveBeenCalledWith('/login');
  });

  test('DD-AUTH-062 通信の失敗と想定外の状態は、やさしい文言を出す', async () => {
    jest.mocked(global.fetch).mockRejectedValue(new Error('network'));
    await submitCode();
    expect(screen.getByRole('alert')).toHaveTextContent('確認できませんでした。時間をおいて、もう一度お試しください。');
    expect(mockReplace).not.toHaveBeenCalled();
  });

  test('DD-AUTH-062 欄の入力: 数字は次の欄へ進み、数字以外は欄を空にし、Backspace・矢印で動く', () => {
    render(<EmailCodeEntry email={EMAIL} />);
    fireEvent.change(inputs()[0], { target: { value: '5' } });
    expect(inputs()[0].value).toBe('5');
    expect(inputs()[1]).toHaveFocus();
    fireEvent.change(inputs()[0], { target: { value: 'a' } });
    expect(inputs()[0].value).toBe('');
    fireEvent.change(inputs()[2], { target: { value: '7' } });
    fireEvent.keyDown(inputs()[2], { key: 'Backspace' });
    expect(inputs()[2].value).toBe('');
    fireEvent.keyDown(inputs()[2], { key: 'ArrowLeft' });
    expect(inputs()[1]).toHaveFocus();
    fireEvent.keyDown(inputs()[1], { key: 'ArrowRight' });
    expect(inputs()[2]).toHaveFocus();
    fireEvent.keyDown(inputs()[0], { key: 'ArrowLeft' });
    fireEvent.keyDown(inputs()[7], { key: 'ArrowRight' });
    expect(inputs()[2]).toHaveFocus();
    fireEvent.keyDown(inputs()[2], { key: 'a' });
    pasteAt(0, 'abc');
    expect(inputs().map((i) => i.value).join('')).toBe('');
  });

  test('DD-AUTH-062 伏せたメールが空なら宛先の文を出さない（いつも出す案内は残る）', () => {
    render(<EmailCodeEntry email="not-an-email" />);
    expect(screen.queryByText(/お送りしました/)).not.toBeInTheDocument();
    expect(screen.getByText(/コードの無い確認のメール/)).toBeInTheDocument();
  });

  test('DD-AUTH-062 本文が配列・JSON でない 200 は勧めずに行き先へ置き換える', async () => {
    jest.mocked(global.fetch).mockResolvedValue(json(200, []));
    await submitCode();
    expect(mockReplace).toHaveBeenCalledWith('/account');
  });

  test('DD-AUTH-062 401 の本文が読めない・文でない時はコードの誤りとして扱う', async () => {
    jest.mocked(global.fetch).mockResolvedValue(json(401, { error: 5 }));
    await submitCode();
    expect(screen.getByRole('alert')).toHaveTextContent('確認コードが無効、または期限切れです。');
  });

  test('DD-AUTH-062 本文が JSON でない 401・403 でも落ちず、コードの誤り・汎用の文になる', async () => {
    jest.mocked(global.fetch).mockResolvedValue(new Response('<html>', { status: 401 }));
    const view = render(<EmailCodeEntry email={EMAIL} />);
    pasteAt(0, CODE);
    await act(async () => {
      fireEvent.submit(loginButton().closest('form') as HTMLFormElement);
    });
    expect(screen.getByRole('alert')).toHaveTextContent('確認コードが無効、または期限切れです。');
    jest.mocked(global.fetch).mockResolvedValue(new Response('<html>', { status: 403 }));
    await act(async () => {
      fireEvent.submit(loginButton().closest('form') as HTMLFormElement);
    });
    expect(screen.getByRole('alert')).toHaveTextContent('確認できませんでした。');
    view.unmount();
  });

  test('DD-AUTH-062 403 でも印が違えば、店員の案内にせず汎用の文にする', async () => {
    jest.mocked(global.fetch).mockResolvedValue(json(403, { error: 'other' }));
    await submitCode();
    expect(screen.getByRole('alert')).toHaveTextContent('確認できませんでした。');
    expect(screen.getByRole('button', { name: 'コードを再送する' })).toBeInTheDocument();
  });

  test('DD-AUTH-062 500 は汎用の文を出し、入力を続けられる', async () => {
    jest.mocked(global.fetch).mockResolvedValue(json(500, { error: 'x' }));
    await submitCode();
    expect(screen.getByRole('alert')).toHaveTextContent('確認できませんでした。');
    expect(inputs()[0]).toBeEnabled();
  });

  describe('再送', () => {
    async function openResend(response: Response) {
      jest.mocked(global.fetch).mockResolvedValue(response);
      render(<EmailCodeEntry email={EMAIL} />);
    }
    async function clickResend() {
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'コードを再送する' }));
      });
    }

    test('DD-AUTH-062 60秒のカウントダウンの間は disabled で、0になると押せる', () => {
      render(<EmailCodeEntry email={EMAIL} />);
      const resend = screen.getByRole('button', { name: 'コードを再送する' });
      expect(resend).toBeDisabled();
      expect(screen.getByText('1分 00秒後に再送可能')).toBeInTheDocument();
      act(() => {
        jest.advanceTimersByTime(30000);
      });
      expect(screen.getByText('0分 30秒後に再送可能')).toBeInTheDocument();
      expect(resend).toBeDisabled();
      act(() => {
        jest.advanceTimersByTime(30000);
      });
      expect(resend).toBeEnabled();
      expect(screen.queryByText(/後に再送可能/)).not.toBeInTheDocument();
    });

    test('DD-AUTH-062 再送の成功は欄を空にし、待ちを60秒に戻して知らせる', async () => {
      await openResend(json(200, { ok: true }));
      pasteAt(0, CODE);
      act(() => {
        jest.advanceTimersByTime(60000);
      });
      await clickResend();
      expect(global.fetch).toHaveBeenCalledWith('/api/auth/email-code/resend', expect.objectContaining({ method: 'POST' }));
      expect(screen.getByRole('status')).toHaveTextContent('確認コードを再送しました。');
      expect(inputs().every((i) => i.value === '')).toBe(true);
      expect(screen.getByRole('button', { name: 'コードを再送する' })).toBeDisabled();
    });

    test('DD-AUTH-062 再送の 401 は期限切れの文言で /login へ戻す', async () => {
      await openResend(json(401, { error: 'x' }));
      act(() => {
        jest.advanceTimersByTime(60000);
      });
      await clickResend();
      expect(screen.getByRole('alert')).toHaveTextContent('時間がたちました。もう一度メールアドレスを入れてください。');
      act(() => {
        jest.advanceTimersByTime(3000);
      });
      expect(mockReplace).toHaveBeenCalledWith('/login');
    });

    test.each(['120', 'Wed, 18 Nov 2026 02:03:00 GMT'])('DD-AUTH-062 再送の 429 は Retry-After %s を待ちにする', async (retryAfter) => {
      await openResend(json(429, { error: 'x' }, { 'Retry-After': retryAfter }));
      act(() => {
        jest.advanceTimersByTime(60000);
      });
      await clickResend();
      expect(screen.getByRole('alert')).toHaveTextContent('送信回数の上限');
      act(() => {
        jest.advanceTimersByTime(119000);
      });
      expect(screen.getByRole('button', { name: 'コードを再送する' })).toBeDisabled();
      act(() => {
        jest.advanceTimersByTime(1000);
      });
      expect(screen.getByRole('button', { name: 'コードを再送する' })).toBeEnabled();
    });

    test.each([undefined, 'invalid', '0', 'Wed, 18 Nov 2026 01:00:00 GMT'])('DD-AUTH-062 再送の 429 で Retry-After %s が使えなければ60秒を待ちにする', async (retryAfter) => {
      await openResend(json(429, { error: 'x' }, retryAfter === undefined ? {} : { 'Retry-After': retryAfter }));
      act(() => {
        jest.advanceTimersByTime(60000);
      });
      await clickResend();
      act(() => {
        jest.advanceTimersByTime(59000);
      });
      expect(screen.getByRole('button', { name: 'コードを再送する' })).toBeDisabled();
      act(() => {
        jest.advanceTimersByTime(1000);
      });
      expect(screen.getByRole('button', { name: 'コードを再送する' })).toBeEnabled();
    });

    test('DD-AUTH-062 再送の 503 は処理できない旨を出す', async () => {
      await openResend(json(503, { error: 'x' }));
      act(() => {
        jest.advanceTimersByTime(60000);
      });
      await clickResend();
      expect(screen.getByRole('alert')).toHaveTextContent('ただいま処理できません。');
    });

    test('DD-AUTH-062 再送のそれ以外の失敗は送れなかった旨を出す', async () => {
      await openResend(json(500, { error: 'x' }));
      act(() => {
        jest.advanceTimersByTime(60000);
      });
      await clickResend();
      expect(screen.getByRole('alert')).toHaveTextContent('確認コードを送れませんでした。');
    });
  });

  test('DD-AUTH-062 取りやめは cancel を呼んで /login へ置き換える（失敗でも戻る）', async () => {
    jest.mocked(global.fetch).mockRejectedValue(new Error('network'));
    render(<EmailCodeEntry email={EMAIL} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'メールアドレスを入れ直す' }));
    });
    expect(global.fetch).toHaveBeenCalledWith('/api/auth/email-code/cancel', expect.objectContaining({ method: 'POST' }));
    expect(mockReplace).toHaveBeenCalledWith('/login');
  });

  test('DD-AUTH-062 取りやめの応答の本文を捨てる', async () => {
    const response = new Response(null, { status: 204 });
    const drain = jest.spyOn(response, 'arrayBuffer');
    jest.mocked(global.fetch).mockResolvedValue(response);
    render(<EmailCodeEntry email={EMAIL} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'メールアドレスを入れ直す' }));
    });
    expect(drain).toHaveBeenCalled();
  });

  test('DD-AUTH-062 送信中は aria-busy で、二重に送らない', async () => {
    let resolveFetch: (r: Response) => void = () => undefined;
    jest.mocked(global.fetch).mockReturnValue(new Promise<Response>((r) => (resolveFetch = r)));
    render(<EmailCodeEntry email={EMAIL} />);
    pasteAt(0, CODE);
    const form = loginButton().closest('form') as HTMLFormElement;
    await act(async () => {
      fireEvent.submit(form);
    });
    expect(form).toHaveAttribute('aria-busy', 'true');
    expect(loginButton()).toBeDisabled();
    await act(async () => {
      fireEvent.submit(form);
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveFetch(json(401, { error: 'x' }));
    });
    expect(form).toHaveAttribute('aria-busy', 'false');
  });
});
