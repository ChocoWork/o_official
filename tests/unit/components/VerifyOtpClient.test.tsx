import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import VerifyOtpClient from '@/app/login/verify/VerifyOtpClient';

const mockReplace = jest.fn();
const mockVerifyOtp = jest.fn();
jest.mock('next/navigation', () => ({ useRouter: () => ({ replace: mockReplace }) }));
jest.mock('@/contexts/LoginContext', () => ({ useLogin: () => ({ verifyOtp: mockVerifyOtp }) }));

const EMAIL = 'one@example.invalid';

function otpInputs() {
  return Array.from({ length: 8 }, (_, i) => screen.getByLabelText(`認証コード ${i + 1} 桁目`) as HTMLInputElement);
}

function otpValues() {
  return otpInputs().map(input => input.value);
}

function pasteAt(index: number, text: string) {
  return fireEvent.paste(otpInputs()[index], { clipboardData: { getData: () => text } });
}

function submitForm() {
  const form = screen.getByRole('button', { name: 'サインイン' }).closest('form') as HTMLFormElement;
  return act(async () => { fireEvent.submit(form); });
}

function flushZeroDelayTimers() {
  act(() => { jest.advanceTimersByTime(0); });
}

describe('OTP verification and resend feedback', () => {
  const originalFetch = global.fetch;
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-05T02:00:00Z'));
    jest.clearAllMocks();
    global.fetch = jest.fn();
  });
  afterEach(() => {
    jest.useRealTimers();
    global.fetch = originalFetch;
  });
  async function resend(status: number, retryAfter?: string) {
    jest.mocked(global.fetch).mockResolvedValue(new Response('{"error":"private DB detail"}', {
      status, headers: retryAfter ? { 'Retry-After': retryAfter } : {},
    }));
    const view = render(<VerifyOtpClient email="one@example.invalid" />);
    act(() => jest.advanceTimersByTime(60000));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '再送信' })); });
    return view;
  }
  test('DD-AUTH-002 successful resend clears digits and restarts cooldown', async () => {
    await resend(200);
    expect(screen.getByRole('status')).toHaveTextContent('認証コードを再送信しました。');
    expect(screen.queryByRole('button', { name: '再送信' })).not.toBeInTheDocument();
    expect(global.fetch).toHaveBeenCalledWith('/api/auth/login/resend', {
      method: 'POST', credentials: 'same-origin',
    });
  });
  test('DD-AUTH-002 401 returns to login', async () => {
    await resend(401);
    expect(mockReplace).toHaveBeenCalledWith('/login');
  });
  test.each(['120', 'Sat, 05 Sep 2026 02:03:00 GMT'])('DD-AUTH-002 429 honors Retry-After %s', async retryAfter => {
    await resend(429, retryAfter);
    expect(screen.getByRole('alert')).toHaveTextContent('送信回数の上限');
    act(() => jest.advanceTimersByTime(119000));
    expect(screen.queryByRole('button', { name: '再送信' })).not.toBeInTheDocument();
    act(() => jest.advanceTimersByTime(1000));
    expect(screen.getByRole('button', { name: '再送信' })).toBeEnabled();
  });
  test.each([undefined, 'invalid', '-1', '0', 'Sat, 05 Sep 2026 01:00:00 GMT'])('DD-AUTH-002 invalid Retry-After %s uses 60 seconds', async retryAfter => {
    await resend(429, retryAfter);
    act(() => jest.advanceTimersByTime(59000));
    expect(screen.queryByRole('button', { name: '再送信' })).not.toBeInTheDocument();
    act(() => jest.advanceTimersByTime(1000));
    expect(screen.getByRole('button', { name: '再送信' })).toBeEnabled();
  });
  test.each([
    [503, '一時的に認証処理を利用できません'],
    [500, '認証コードの送信に失敗しました'],
  ])('DD-AUTH-002 %s displays safe feedback', async (status, message) => {
    await resend(status as number);
    expect(screen.getByRole('alert')).toHaveTextContent(message as string);
    expect(screen.queryByText(/private DB detail/)).not.toBeInTheDocument();
  });
  test('DD-AUTH-002 network failure displays resend failure', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.mocked(global.fetch).mockRejectedValue(new Error('offline'));
    render(<VerifyOtpClient email="one@example.invalid" />);
    act(() => jest.advanceTimersByTime(60000));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '再送信' })); });
    expect(screen.getByRole('alert')).toHaveTextContent('認証コードの送信に失敗しました');
    consoleError.mockRestore();
  });
  test('DD-AUTH-002 valid OTP completes login using the verified account response', async () => {
    mockVerifyOtp.mockResolvedValue({ success: true });
    jest.mocked(global.fetch).mockResolvedValue(new Response('{"authenticated":true,"user":{"role":"user"}}'));
    render(<VerifyOtpClient email="one@example.invalid" />);
    fireEvent.paste(screen.getByLabelText('認証コード 1 桁目'), {
      clipboardData: { getData: () => '12345678' },
    });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'サインイン' })); });
    expect(mockVerifyOtp).toHaveBeenCalledWith('12345678');
    expect(mockReplace).toHaveBeenCalledWith('/account');
  });

  describe('resend after a successful request', () => {
    test('DD-AUTH-002 再送の成功で埋めた欄を空にし、成功の文を出して 1 つ目の欄へ移る', async () => {
      jest.mocked(global.fetch).mockResolvedValue(new Response('{}', { status: 200 }));
      render(<VerifyOtpClient email={EMAIL} />);
      pasteAt(0, '1234');
      expect(otpValues().slice(0, 4)).toEqual(['1', '2', '3', '4']);
      act(() => jest.advanceTimersByTime(60000));
      otpInputs()[7].focus();

      await act(async () => { fireEvent.click(screen.getByRole('button', { name: '再送信' })); });
      flushZeroDelayTimers();

      expect(otpValues()).toEqual(Array(8).fill(''));
      expect(screen.getByRole('status')).toHaveTextContent('認証コードを再送信しました。');
      expect(document.activeElement).toBe(otpInputs()[0]);
      expect(screen.getByText('1分 00秒後に再送可能')).toBeInTheDocument();
    });

    test('DD-AUTH-002 再送の成功が前の誤りを消す', async () => {
      jest.mocked(global.fetch)
        .mockResolvedValueOnce(new Response('{}', { status: 500 }))
        .mockResolvedValueOnce(new Response('{}', { status: 200 }));
      render(<VerifyOtpClient email={EMAIL} />);
      act(() => jest.advanceTimersByTime(60000));
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: '再送信' })); });
      expect(screen.getByRole('alert')).toHaveTextContent('認証コードの送信に失敗しました');

      act(() => jest.advanceTimersByTime(0));
      expect(screen.getByRole('button', { name: '再送信' })).toBeEnabled();
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: '再送信' })); });

      expect(screen.getByRole('alert')).toBeEmptyDOMElement();
      expect(screen.getByRole('status')).toHaveTextContent('認証コードを再送信しました。');
    });

    test('DD-AUTH-002 欄の参照が無くなっていれば再送の後でも移らず落ちない', async () => {
      const { unmount } = await resend(200);

      unmount();

      expect(() => flushZeroDelayTimers()).not.toThrow();
    });

    test('DD-AUTH-002 再送の通信中は再送信を押せない', async () => {
      let finish: (response: Response) => void = () => {};
      jest.mocked(global.fetch).mockReturnValue(new Promise<Response>(resolve => { finish = resolve; }));
      render(<VerifyOtpClient email={EMAIL} />);
      act(() => jest.advanceTimersByTime(60000));

      await act(async () => { fireEvent.click(screen.getByRole('button', { name: '再送信' })); });

      expect(screen.getByRole('button', { name: '再送信' })).toBeDisabled();
      await act(async () => { finish(new Response('{}', { status: 200 })); });
      expect(screen.queryByRole('button', { name: '再送信' })).not.toBeInTheDocument();
    });
  });

  describe('layout and resend countdown', () => {
    test('DD-AUTH-002 見出し・伏せたメール・有効時間・8 つの欄・サインインを出す', () => {
      render(<VerifyOtpClient email={EMAIL} />);

      expect(screen.getByRole('heading', { name: '認証コードを入力' })).toBeInTheDocument();
      expect(screen.getByText('o***@example.invalid 宛に送信しました')).toBeInTheDocument();
      expect(screen.queryByText(EMAIL, { exact: false })).not.toBeInTheDocument();
      expect(screen.getByText('コードは5分間有効です')).toBeInTheDocument();
      expect(otpInputs()).toHaveLength(8);
      expect(otpInputs()[0]).toHaveAttribute('autocomplete', 'one-time-code');
      expect(otpInputs()[1]).toHaveAttribute('autocomplete', 'off');
      expect(screen.getByRole('button', { name: 'サインイン' })).toBeDisabled();
      expect(screen.getByRole('button', { name: '別のアドレスでやり直す' })).toBeInTheDocument();
    });

    test('DD-AUTH-002 伏せたメールが空なら宛先の文を出さない', () => {
      render(<VerifyOtpClient email="not-an-email" />);

      expect(screen.queryByText(/宛に送信しました/)).not.toBeInTheDocument();
      expect(screen.getByText('コードは5分間有効です')).toBeInTheDocument();
    });

    test('DD-AUTH-002 再送の待ちは 60 秒から始まり、1 秒ごとに減る', () => {
      render(<VerifyOtpClient email={EMAIL} />);
      expect(screen.getByText('1分 00秒後に再送可能')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: '再送信' })).not.toBeInTheDocument();

      act(() => jest.advanceTimersByTime(1000));

      expect(screen.getByText('0分 59秒後に再送可能')).toBeInTheDocument();
    });

    test('DD-AUTH-002 タイマーが間引かれても残りは経過した時刻から引き直す', () => {
      render(<VerifyOtpClient email={EMAIL} />);

      jest.setSystemTime(new Date('2026-09-05T02:00:30Z'));
      act(() => jest.advanceTimersByTime(1000));

      expect(screen.getByText('0分 29秒後に再送可能')).toBeInTheDocument();
    });

    test('DD-AUTH-002 残りが 0 になると時計を止め、待ちの文の代わりに再送信を出す', () => {
      render(<VerifyOtpClient email={EMAIL} />);

      act(() => jest.advanceTimersByTime(60000));

      expect(screen.getByRole('button', { name: '再送信' })).toBeEnabled();
      expect(screen.queryByText(/後に再送可能/)).not.toBeInTheDocument();
      expect(jest.getTimerCount()).toBe(0);
    });
  });

  describe('digit entry', () => {
    test('DD-AUTH-002 数字 1 つを打つと入れて次の欄へ移る', () => {
      render(<VerifyOtpClient email={EMAIL} />);

      fireEvent.change(otpInputs()[2], { target: { value: '9' } });

      expect(otpValues()[2]).toBe('9');
      expect(document.activeElement).toBe(otpInputs()[3]);
    });

    test('DD-AUTH-002 複数の数字は順に入れ、入れた数の先の欄へ移る', () => {
      render(<VerifyOtpClient email={EMAIL} />);

      fireEvent.change(otpInputs()[0], { target: { value: '123' } });

      expect(otpValues().slice(0, 4)).toEqual(['1', '2', '3', '']);
      expect(document.activeElement).toBe(otpInputs()[3]);
    });

    test('DD-AUTH-002 数字以外は捨て、数字だけを入れる', () => {
      render(<VerifyOtpClient email={EMAIL} />);

      fireEvent.change(otpInputs()[0], { target: { value: 'a1b2' } });

      expect(otpValues().slice(0, 3)).toEqual(['1', '2', '']);
    });

    test('DD-AUTH-002 入力に数字が無ければその欄を空にし、移らない', () => {
      render(<VerifyOtpClient email={EMAIL} />);
      fireEvent.change(otpInputs()[1], { target: { value: '5' } });
      otpInputs()[1].focus();

      fireEvent.change(otpInputs()[1], { target: { value: 'x' } });

      expect(otpValues()[1]).toBe('');
      expect(document.activeElement).toBe(otpInputs()[1]);
    });

    test('DD-AUTH-002 数字が欄の残りより多ければ 8 つ目で止め、最後の欄に留まる', () => {
      render(<VerifyOtpClient email={EMAIL} />);

      fireEvent.change(otpInputs()[6], { target: { value: '1234' } });

      expect(otpValues().slice(5)).toEqual(['', '1', '2']);
      expect(document.activeElement).toBe(otpInputs()[7]);
    });

    test('DD-AUTH-002 8 桁が揃うとサインインを押せる', () => {
      render(<VerifyOtpClient email={EMAIL} />);

      pasteAt(0, '1234567');
      expect(screen.getByRole('button', { name: 'サインイン' })).toBeDisabled();
      fireEvent.change(otpInputs()[7], { target: { value: '8' } });

      expect(screen.getByRole('button', { name: 'サインイン' })).toBeEnabled();
    });
  });

  describe('keyboard handling', () => {
    test('DD-AUTH-002 Backspace で欄に数字があればその欄を空にする', () => {
      render(<VerifyOtpClient email={EMAIL} />);
      pasteAt(0, '1234');

      const notPrevented = fireEvent.keyDown(otpInputs()[2], { key: 'Backspace' });

      expect(notPrevented).toBe(false);
      expect(otpValues().slice(0, 4)).toEqual(['1', '2', '', '4']);
    });

    test('DD-AUTH-002 Backspace で欄が空で先頭でなければ前の欄を空にして前へ移る', () => {
      render(<VerifyOtpClient email={EMAIL} />);
      pasteAt(0, '1234');

      fireEvent.keyDown(otpInputs()[4], { key: 'Backspace' });
      flushZeroDelayTimers();

      expect(otpValues().slice(0, 5)).toEqual(['1', '2', '3', '', '']);
      expect(document.activeElement).toBe(otpInputs()[3]);
    });

    test('DD-AUTH-002 Backspace で先頭の欄が空なら何もしない', () => {
      render(<VerifyOtpClient email={EMAIL} />);
      otpInputs()[1].focus();

      fireEvent.keyDown(otpInputs()[0], { key: 'Backspace' });
      flushZeroDelayTimers();

      expect(otpValues()).toEqual(Array(8).fill(''));
      expect(document.activeElement).toBe(otpInputs()[1]);
    });

    test('DD-AUTH-002 左の矢印で先頭でなければ前の欄へ移る', () => {
      render(<VerifyOtpClient email={EMAIL} />);

      const notPrevented = fireEvent.keyDown(otpInputs()[3], { key: 'ArrowLeft' });

      expect(notPrevented).toBe(false);
      expect(document.activeElement).toBe(otpInputs()[2]);
    });

    test('DD-AUTH-002 左の矢印が先頭の欄では何もしない', () => {
      render(<VerifyOtpClient email={EMAIL} />);
      otpInputs()[0].focus();

      const notPrevented = fireEvent.keyDown(otpInputs()[0], { key: 'ArrowLeft' });

      expect(notPrevented).toBe(true);
      expect(document.activeElement).toBe(otpInputs()[0]);
    });

    test('DD-AUTH-002 右の矢印で最後でなければ次の欄へ移る', () => {
      render(<VerifyOtpClient email={EMAIL} />);

      const notPrevented = fireEvent.keyDown(otpInputs()[3], { key: 'ArrowRight' });

      expect(notPrevented).toBe(false);
      expect(document.activeElement).toBe(otpInputs()[4]);
    });

    test('DD-AUTH-002 右の矢印が最後の欄では何もしない', () => {
      render(<VerifyOtpClient email={EMAIL} />);
      otpInputs()[7].focus();

      const notPrevented = fireEvent.keyDown(otpInputs()[7], { key: 'ArrowRight' });

      expect(notPrevented).toBe(true);
      expect(document.activeElement).toBe(otpInputs()[7]);
    });

    test('DD-AUTH-002 そのほかのキーは何もしない', () => {
      render(<VerifyOtpClient email={EMAIL} />);
      otpInputs()[3].focus();

      const notPrevented = fireEvent.keyDown(otpInputs()[3], { key: 'a' });

      expect(notPrevented).toBe(true);
      expect(document.activeElement).toBe(otpInputs()[3]);
      expect(otpValues()).toEqual(Array(8).fill(''));
    });
  });

  describe('paste handling', () => {
    test('DD-AUTH-002 貼り付けの数字を順に入れ、数字以外は捨てる', () => {
      render(<VerifyOtpClient email={EMAIL} />);

      const notPrevented = pasteAt(1, '12-34');

      expect(notPrevented).toBe(false);
      expect(otpValues().slice(0, 6)).toEqual(['', '1', '2', '3', '4', '']);
      expect(document.activeElement).toBe(otpInputs()[5]);
    });

    test('DD-AUTH-002 貼り付けに数字が無ければ何も変えず移らない', () => {
      render(<VerifyOtpClient email={EMAIL} />);
      otpInputs()[2].focus();

      const notPrevented = pasteAt(2, 'abc');

      expect(notPrevented).toBe(false);
      expect(otpValues()).toEqual(Array(8).fill(''));
      expect(document.activeElement).toBe(otpInputs()[2]);
    });

    test('DD-AUTH-002 貼り付けの数字が欄の残りより多ければ 8 つ目で止める', () => {
      render(<VerifyOtpClient email={EMAIL} />);

      pasteAt(5, '123456789');

      expect(otpValues().slice(4)).toEqual(['', '1', '2', '3']);
      expect(document.activeElement).toBe(otpInputs()[7]);
    });
  });

  describe('submitting the code', () => {
    test('DD-AUTH-002 8 桁でない送信は文を出して verifyOtp を呼ばない', async () => {
      render(<VerifyOtpClient email={EMAIL} />);
      pasteAt(0, '123');

      await submitForm();

      expect(screen.getByRole('alert')).toHaveTextContent('認証コードは8桁で入力してください');
      expect(mockVerifyOtp).not.toHaveBeenCalled();
      expect(mockReplace).not.toHaveBeenCalled();
    });

    test('DD-AUTH-002 verifyOtp が失敗すれば窓口の文を出して移らない', async () => {
      mockVerifyOtp.mockResolvedValue({ success: false, error: 'コードが違います' });
      render(<VerifyOtpClient email={EMAIL} />);
      pasteAt(0, '12345678');

      await submitForm();

      expect(screen.getByRole('alert')).toHaveTextContent('コードが違います');
      expect(global.fetch).not.toHaveBeenCalled();
      expect(mockReplace).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: 'サインイン' })).toBeEnabled();
    });

    test('DD-AUTH-002 verifyOtp が失敗して文が無ければ既定の文を出す', async () => {
      mockVerifyOtp.mockResolvedValue({ success: false });
      render(<VerifyOtpClient email={EMAIL} />);
      pasteAt(0, '12345678');

      await submitForm();

      expect(screen.getByRole('alert')).toHaveTextContent('認証コードの確認に失敗しました');
      expect(mockReplace).not.toHaveBeenCalled();
    });

    test('DD-AUTH-002 verifyOtp が投げれば既定の文を出し、送信中の表示を戻す', async () => {
      const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
      mockVerifyOtp.mockRejectedValue(new Error('boom'));
      render(<VerifyOtpClient email={EMAIL} />);
      pasteAt(0, '12345678');

      await submitForm();

      expect(screen.getByRole('alert')).toHaveTextContent('認証コードの確認に失敗しました');
      expect(screen.getByRole('button', { name: 'サインイン' })).toBeEnabled();
      expect(mockReplace).not.toHaveBeenCalled();
      consoleError.mockRestore();
    });

    test('DD-AUTH-002 送信中はボタンを押せず「処理中...」を出す', async () => {
      let finish: (value: { success: boolean }) => void = () => {};
      mockVerifyOtp.mockReturnValue(new Promise(resolve => { finish = resolve; }));
      render(<VerifyOtpClient email={EMAIL} />);
      pasteAt(0, '12345678');

      await submitForm();

      expect(screen.getByRole('button', { name: '処理中...' })).toBeDisabled();
      await act(async () => { finish({ success: false }); });
      expect(screen.getByRole('button', { name: 'サインイン' })).toBeEnabled();
    });
  });

  describe('destination after a successful code', () => {
    async function confirmWith(meResponse: Response | Error) {
      mockVerifyOtp.mockResolvedValue({ success: true });
      if (meResponse instanceof Error) {
        jest.mocked(global.fetch).mockRejectedValue(meResponse);
      } else {
        jest.mocked(global.fetch).mockResolvedValue(meResponse);
      }
      render(<VerifyOtpClient email={EMAIL} />);
      pasteAt(0, '12345678');
      await submitForm();
    }

    test.each(['admin', 'supporter'])('DD-AUTH-002 me の役割が %s なら /auth/verified へ置き換える', async role => {
      await confirmWith(new Response(JSON.stringify({ authenticated: true, user: { role } })));

      expect(global.fetch).toHaveBeenCalledWith('/api/auth/me', {
        method: 'GET', cache: 'no-store', credentials: 'same-origin',
      });
      expect(mockReplace).toHaveBeenCalledWith('/auth/verified');
    });

    test('DD-AUTH-002 me の役割がほかなら /account へ置き換える', async () => {
      await confirmWith(new Response('{"authenticated":true,"user":{"role":"customer"}}'));

      expect(mockReplace).toHaveBeenCalledWith('/account');
    });

    test('DD-AUTH-002 me に user が無くても認証済みなら /account へ置き換える', async () => {
      await confirmWith(new Response('{"authenticated":true}'));

      expect(mockReplace).toHaveBeenCalledWith('/account');
    });

    test('DD-AUTH-002 me が 200 以外なら /login へ置き換える', async () => {
      await confirmWith(new Response('{"authenticated":true,"user":{"role":"admin"}}', { status: 401 }));

      expect(mockReplace).toHaveBeenCalledWith('/login');
    });

    test('DD-AUTH-002 me の本文が JSON でなければ /login へ置き換える', async () => {
      await confirmWith(new Response('<html>not json</html>'));

      expect(mockReplace).toHaveBeenCalledWith('/login');
    });

    test('DD-AUTH-002 me の authenticated が真でなければ /login へ置き換える', async () => {
      await confirmWith(new Response('{"authenticated":false}'));

      expect(mockReplace).toHaveBeenCalledWith('/login');
    });

    test('DD-AUTH-002 me の通信が投げれば /account へ置き換える', async () => {
      await confirmWith(new Error('offline'));

      expect(mockReplace).toHaveBeenCalledWith('/account');
    });
  });

  describe('using another address', () => {
    test('DD-AUTH-002 やり直しで取り消しの窓口を呼び /login へ置き換える', async () => {
      jest.mocked(global.fetch).mockResolvedValue(new Response('{}', { status: 200 }));
      render(<VerifyOtpClient email={EMAIL} />);

      await act(async () => { fireEvent.click(screen.getByRole('button', { name: '別のアドレスでやり直す' })); });

      expect(global.fetch).toHaveBeenCalledWith('/api/auth/login/cancel', {
        method: 'POST', credentials: 'same-origin',
      });
      expect(mockReplace).toHaveBeenCalledWith('/login');
    });

    test('DD-AUTH-002 取り消しの通信が失敗しても /login へ置き換える', async () => {
      jest.mocked(global.fetch).mockRejectedValue(new Error('offline'));
      render(<VerifyOtpClient email={EMAIL} />);

      await act(async () => { fireEvent.click(screen.getByRole('button', { name: '別のアドレスでやり直す' })); });

      expect(mockReplace).toHaveBeenCalledWith('/login');
    });
  });
});
