import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import LoginModal from '@/components/LoginModal';
import { LoginRequestSchema } from '@/features/auth/schemas/login';

const loginMock = jest.fn();
const loginWithGoogleMock = jest.fn();
const replaceMock = jest.fn();

// Turnstile のフックは差し替え、トークンの受け口・描き直し・引き直しを呼び出しの記録で確かめる。
const mockTurnstile = {
  siteKey: undefined as string | undefined,
  onToken: undefined as ((token: string) => void) | undefined,
  containerRef: jest.fn(),
  renderWidget: jest.fn(),
  resetWidget: jest.fn(),
};
// 読み込み用の Script の部品は、渡された属性だけを控える。
const mockScript = { props: null as Record<string, unknown> | null };

// FREQ-334: OTP の検証は /login/verify 側の責務になったので、
// LoginModal はもう verifyOtp を使わない。
jest.mock('@/contexts/LoginContext', () => ({
  useLogin: () => ({
    login: (...args: unknown[]) => loginMock(...args),
    loginWithGoogle: (...args: unknown[]) => loginWithGoogleMock(...args),
  }),
}));

jest.mock('next/navigation', () => ({
  useRouter: () => ({
    replace: (...args: unknown[]) => replaceMock(...args),
  }),
}));

jest.mock('next/script', () => ({
  __esModule: true,
  default: (props: Record<string, unknown>) => {
    mockScript.props = props;
    const { createElement } = require('react');
    return createElement('span', { 'data-testid': 'turnstile-script' });
  },
}));

jest.mock('@/hooks/useTurnstileWidget', () => ({
  useTurnstileWidget: (siteKey: string, onToken: (token: string) => void) => {
    mockTurnstile.siteKey = siteKey;
    mockTurnstile.onToken = onToken;
    return {
      containerRef: mockTurnstile.containerRef,
      renderWidget: mockTurnstile.renderWidget,
      resetWidget: mockTurnstile.resetWidget,
    };
  },
}));

const VALID_EMAIL = 'user@example.com';
const VALID_PASSWORD = 'password123456789';

function fillForm(email = VALID_EMAIL, password = VALID_PASSWORD) {
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: email } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: password } });
}

// 必須欄・形式の確かめで止まらないよう、form の submit を直接起こす。
function submitForm() {
  fireEvent.submit(screen.getByLabelText('Email').closest('form') as HTMLFormElement);
}

function giveTurnstileToken(token: string) {
  act(() => {
    mockTurnstile.onToken?.(token);
  });
}

describe('LoginModal', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockScript.props = null;
    mockTurnstile.siteKey = undefined;
    mockTurnstile.onToken = undefined;
    process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY = '';
    loginMock.mockResolvedValue({ success: true, message: '認証コードを送信しました。' });
    loginWithGoogleMock.mockResolvedValue({ success: true });
  });

  afterAll(() => {
    delete process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
  });

  test('DD-AUTH-008 Google のサインインのボタンとパスワード再設定のリンクを出す', () => {
    render(<LoginModal open={true} onClose={jest.fn()} />);

    expect(screen.getByRole('button', { name: /Googleでサインイン/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'パスワードをお忘れの方はこちら' })).toHaveAttribute(
      'href',
      '/auth/password-reset'
    );
  });

  test('DD-AUTH-008 パスワード検証に成功したら専用画面へ replace で送る', async () => {
    const user = userEvent.setup();
    const onClose = jest.fn();

    render(<LoginModal open={true} onClose={onClose} />);

    await user.type(screen.getByLabelText('Email'), 'user@example.com');
    await user.type(screen.getByLabelText('Password'), 'password123456789');
    await user.click(screen.getByRole('button', { name: 'ログイン' }));

    await waitFor(() =>
      expect(loginMock).toHaveBeenCalledWith('user@example.com', 'password123456789', undefined, { next: undefined }),
    );

    // FREQ-334-REQ-02: push だと戻るボタンで資格情報フォームに戻れてしまい、
    // 生きた 2FA Cookie を持ったまま再ログインして 2 通目の OTP を発射できる。
    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith('/login/verify'));
    expect(onClose).toHaveBeenCalled();

    // OTP の入力欄はこの画面に残っていない
    expect(screen.queryByLabelText('認証コード 1 桁目')).not.toBeInTheDocument();
  });

  test('DD-AUTH-008 open が偽のときは何も描かない', () => {
    const { container } = render(<LoginModal open={false} onClose={jest.fn()} />);

    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByLabelText('Email')).not.toBeInTheDocument();
  });

  test('DD-AUTH-008 EMAIL・パスワード・ログイン・OR・Google のボタンを出す', () => {
    render(<LoginModal open={true} />);

    expect(screen.getByLabelText('Email')).toHaveAttribute('type', 'email');
    expect(screen.getByLabelText('Email')).toHaveAttribute('autocomplete', 'email');
    expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'password');
    expect(screen.getByLabelText('Password')).toHaveAttribute('autocomplete', 'current-password');
    expect(screen.getByRole('button', { name: 'ログイン' })).toHaveAttribute('type', 'submit');
    expect(screen.getByText('OR')).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'その他のログイン方法' })).toBeInTheDocument();
  });

  describe('形の確かめ', () => {
    test('DD-AUTH-008 形の誤りは zod の誤りの文を空白でつないで出し login を呼ばない', () => {
      render(<LoginModal open={true} />);
      fillForm('not-an-email', 'short');

      submitForm();

      expect(screen.getByRole('alert')).toHaveTextContent(
        'メールアドレスの形式が正しくありません パスワードは16文字以上で入力してください',
      );
      expect(loginMock).not.toHaveBeenCalled();
    });

    test('DD-AUTH-008 zod 以外の例外は「入力に誤りがあります」を出して login を呼ばない', () => {
      const parseSpy = jest.spyOn(LoginRequestSchema, 'parse').mockImplementationOnce(() => {
        throw new Error('unexpected');
      });
      render(<LoginModal open={true} />);
      fillForm();

      submitForm();

      expect(screen.getByRole('alert')).toHaveTextContent('入力に誤りがあります');
      expect(loginMock).not.toHaveBeenCalled();
      parseSpy.mockRestore();
    });

    test('DD-AUTH-008 直す前の誤りは形が通ると消える', async () => {
      render(<LoginModal open={true} />);
      fillForm('not-an-email', VALID_PASSWORD);
      submitForm();
      expect(screen.getByRole('alert')).toHaveTextContent('メールアドレスの形式が正しくありません');

      fillForm();
      submitForm();

      await waitFor(() => expect(loginMock).toHaveBeenCalledTimes(1));
      expect(screen.getByRole('alert')).toBeEmptyDOMElement();
    });
  });

  describe('Turnstile', () => {
    test('DD-AUTH-008 鍵が無いと Script と入れ物を描かず、トークン無しで login を呼ぶ', async () => {
      render(<LoginModal open={true} />);
      fillForm();

      submitForm();

      await waitFor(() => expect(loginMock).toHaveBeenCalledWith(VALID_EMAIL, VALID_PASSWORD, undefined, { next: undefined }),
      );
      expect(screen.queryByTestId('turnstile-script')).not.toBeInTheDocument();
      expect(mockTurnstile.siteKey).toBe('');
      expect(mockTurnstile.containerRef).not.toHaveBeenCalledWith(expect.any(HTMLElement));
    });

    test('DD-AUTH-008 鍵があると Script を読み込み、読めたら描く関数を渡し、入れ物を描く', () => {
      process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY = 'site-key';
      render(<LoginModal open={true} />);

      expect(screen.getByTestId('turnstile-script')).toBeInTheDocument();
      expect(mockScript.props).toMatchObject({
        id: 'turnstile-login-script',
        src: 'https://challenges.cloudflare.com/turnstile/v0/api.js',
        strategy: 'afterInteractive',
        onReady: mockTurnstile.renderWidget,
      });
      expect(mockTurnstile.siteKey).toBe('site-key');
      expect(mockTurnstile.containerRef).toHaveBeenCalledWith(expect.any(HTMLDivElement));
    });

    test('DD-AUTH-008 鍵があり Turnstile が済んでいないと「ボット検証を完了してください」を出す', () => {
      process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY = 'site-key';
      render(<LoginModal open={true} />);
      fillForm();

      submitForm();

      expect(screen.getByRole('alert')).toHaveTextContent('ボット検証を完了してください');
      expect(loginMock).not.toHaveBeenCalled();
      expect(mockTurnstile.resetWidget).not.toHaveBeenCalled();
    });

    test('DD-AUTH-008 鍵があり Turnstile が済んでいれば、そのトークンを渡して login を呼ぶ', async () => {
      process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY = 'site-key';
      render(<LoginModal open={true} />);
      fillForm();
      giveTurnstileToken('turnstile-token');

      submitForm();

      await waitFor(() =>
        expect(loginMock).toHaveBeenCalledWith(VALID_EMAIL, VALID_PASSWORD, 'turnstile-token', { next: undefined }),
      );
    });

    test('DD-AUTH-008 成功しても Turnstile を引き直す', async () => {
      render(<LoginModal open={true} />);
      fillForm();

      submitForm();

      await waitFor(() => expect(replaceMock).toHaveBeenCalledWith('/login/verify'));
      expect(mockTurnstile.resetWidget).toHaveBeenCalledTimes(1);
    });

    test('DD-AUTH-008 login が失敗しても Turnstile を引き直す', async () => {
      loginMock.mockResolvedValue({ success: false, error: 'メールまたはパスワードが違います' });
      render(<LoginModal open={true} />);
      fillForm();

      submitForm();

      await waitFor(() => expect(mockTurnstile.resetWidget).toHaveBeenCalledTimes(1));
    });

    test('DD-AUTH-008 login が投げても Turnstile を引き直す', async () => {
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      loginMock.mockRejectedValue(new Error('network'));
      render(<LoginModal open={true} />);
      fillForm();

      submitForm();

      await waitFor(() => expect(mockTurnstile.resetWidget).toHaveBeenCalledTimes(1));
      consoleSpy.mockRestore();
    });
  });

  describe('login の結果', () => {
    test('DD-AUTH-008 失敗で窓口の文があれば出し、移らず onClose も呼ばない', async () => {
      loginMock.mockResolvedValue({ success: false, error: 'メールまたはパスワードが違います' });
      const onClose = jest.fn();
      render(<LoginModal open={true} onClose={onClose} />);
      fillForm();

      submitForm();

      await waitFor(() =>
        expect(screen.getByRole('alert')).toHaveTextContent('メールまたはパスワードが違います'),
      );
      expect(replaceMock).not.toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();
    });

    test('DD-AUTH-008 失敗で窓口の文が無ければ「ログインに失敗しました」を出す', async () => {
      loginMock.mockResolvedValue({ success: false });
      render(<LoginModal open={true} />);
      fillForm();

      submitForm();

      await waitFor(() =>
        expect(screen.getByRole('alert')).toHaveTextContent('ログインに失敗しました'),
      );
      expect(replaceMock).not.toHaveBeenCalled();
    });

    test('DD-AUTH-008 login が投げたら記録して「ログインに失敗しました」を出し、移らない', async () => {
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      loginMock.mockRejectedValue(new Error('network'));
      render(<LoginModal open={true} />);
      fillForm();

      submitForm();

      await waitFor(() =>
        expect(screen.getByRole('alert')).toHaveTextContent('ログインに失敗しました'),
      );
      expect(consoleSpy).toHaveBeenCalledWith('Unexpected login error', expect.any(Error));
      expect(replaceMock).not.toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    test('DD-AUTH-008 onClose が無くても成功なら呼ばずに専用画面へ置き換えて移る', async () => {
      render(<LoginModal open={true} />);
      fillForm();

      submitForm();

      await waitFor(() => expect(replaceMock).toHaveBeenCalledWith('/login/verify'));
    });
  });

  describe('欄とボタン', () => {
    test('DD-AUTH-008 表示切替で欄の種類・読み上げの名前・押した印・アイコンを切り替える', async () => {
      const user = userEvent.setup();
      render(<LoginModal open={true} />);

      const showButton = screen.getByRole('button', { name: 'パスワードを表示' });
      expect(showButton).toHaveAttribute('aria-pressed', 'false');
      expect(showButton.querySelector('i')).toHaveClass('ri-eye-off-line');

      await user.click(showButton);

      expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'text');
      const hideButton = screen.getByRole('button', { name: 'パスワードを非表示' });
      expect(hideButton).toHaveAttribute('aria-pressed', 'true');
      expect(hideButton.querySelector('i')).toHaveClass('ri-eye-line');

      await user.click(hideButton);

      expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'password');
      expect(screen.getByRole('button', { name: 'パスワードを表示' })).toHaveAttribute(
        'aria-pressed',
        'false',
      );
    });

    test('DD-AUTH-008 メールかパスワードが空のあいだはログインのボタンを押せない', () => {
      render(<LoginModal open={true} />);
      const loginButton = screen.getByRole('button', { name: 'ログイン' });
      expect(loginButton).toBeDisabled();

      fireEvent.change(screen.getByLabelText('Email'), { target: { value: VALID_EMAIL } });
      expect(loginButton).toBeDisabled();

      fireEvent.change(screen.getByLabelText('Password'), { target: { value: VALID_PASSWORD } });
      expect(loginButton).toBeEnabled();

      fireEvent.change(screen.getByLabelText('Email'), { target: { value: '' } });
      expect(loginButton).toBeDisabled();
    });

    test('DD-AUTH-008 送信中は「処理中...」でボタンを押せず、終わると戻る', async () => {
      let resolveLogin: (value: { success: boolean }) => void = () => {};
      loginMock.mockReturnValue(
        new Promise((resolve) => {
          resolveLogin = resolve;
        }),
      );
      render(<LoginModal open={true} />);
      fillForm();

      submitForm();

      const busyButton = await screen.findByRole('button', { name: '処理中...' });
      expect(busyButton).toBeDisabled();

      await act(async () => {
        resolveLogin({ success: false });
      });

      expect(screen.getByRole('button', { name: 'ログイン' })).toBeEnabled();
    });
  });

  test('DD-AUTH-008 Google のボタンで loginWithGoogle を returnTo つきで呼ぶ', async () => {
    const user = userEvent.setup();
    render(<LoginModal open={true} returnTo="/item/3?color=red" />);

    await user.click(screen.getByRole('button', { name: /Googleでサインイン/ }));

    expect(loginWithGoogleMock).toHaveBeenCalledWith({ next: '/item/3?color=red' });
    expect(loginMock).not.toHaveBeenCalled();
  });

  test('DD-AUTH-008 returnTo が無ければ Google の next も無い（/auth/verified を決め打ちしない）', async () => {
    const user = userEvent.setup();
    render(<LoginModal open={true} />);

    await user.click(screen.getByRole('button', { name: /Googleでサインイン/ }));

    expect(loginWithGoogleMock).toHaveBeenCalledWith({ next: undefined });
  });

  test('DD-AUTH-008 returnTo を login の next として渡す', async () => {
    render(<LoginModal open={true} returnTo="/account" />);
    fillForm();

    submitForm();

    await waitFor(() =>
      expect(loginMock).toHaveBeenCalledWith(VALID_EMAIL, VALID_PASSWORD, undefined, { next: '/account' }),
    );
  });
});
