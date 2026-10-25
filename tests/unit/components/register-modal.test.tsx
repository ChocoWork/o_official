import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import RegisterModal from '@/components/RegisterModal';

const registerMock = jest.fn();
const loginWithGoogleMock = jest.fn();

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

jest.mock('@/contexts/LoginContext', () => ({
  useLogin: () => ({
    register: (...args: unknown[]) => registerMock(...args),
    loginWithGoogle: (...args: unknown[]) => loginWithGoogleMock(...args),
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
// 16 文字ちょうど
const VALID_PASSWORD = 'abcdefghij123456';
const DEFAULT_SENT_MESSAGE = '確認メールを送信しました。メールのリンクから登録を完了してください。';

function fillForm(email = VALID_EMAIL, password = VALID_PASSWORD, confirm = VALID_PASSWORD) {
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: email } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: password } });
  fireEvent.change(screen.getByLabelText('Confirm Password'), { target: { value: confirm } });
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

describe('RegisterModal', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockScript.props = null;
    mockTurnstile.siteKey = undefined;
    mockTurnstile.onToken = undefined;
    process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY = '';
    registerMock.mockResolvedValue({ success: true });
    loginWithGoogleMock.mockResolvedValue({ success: true });
  });

  afterAll(() => {
    delete process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
  });

  describe('初めの形', () => {
    test('DD-AUTH-009 initialEmail が無ければメールの欄は空', () => {
      render(<RegisterModal />);

      expect(screen.getByLabelText('Email')).toHaveValue('');
    });

    test('DD-AUTH-009 initialEmail があればメールの欄の初めの値にする', () => {
      render(<RegisterModal initialEmail="first@example.com" />);

      expect(screen.getByLabelText('Email')).toHaveValue('first@example.com');
    });

    test('DD-AUTH-009 3つの欄・登録のボタン・OR・Google のボタンを出す', () => {
      render(<RegisterModal />);

      expect(screen.getByLabelText('Email')).toHaveAttribute('autocomplete', 'email');
      expect(screen.getByLabelText('Password')).toHaveAttribute('autocomplete', 'new-password');
      expect(screen.getByLabelText('Confirm Password')).toHaveAttribute(
        'autocomplete',
        'new-password',
      );
      expect(
        screen.getByRole('button', { name: '登録して確認メールを受け取る' }),
      ).toHaveAttribute('type', 'submit');
      expect(screen.getByText('OR')).toBeInTheDocument();
      expect(screen.getByRole('group', { name: 'その他の会員登録方法' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Googleで登録' })).toBeInTheDocument();
    });
  });

  describe('送る前の確かめ', () => {
    test('DD-AUTH-009 15 文字のパスワードは 16 文字以上の誤りを出し register を呼ばない', () => {
      render(<RegisterModal />);
      fillForm(VALID_EMAIL, 'abcdefghij12345', 'abcdefghij12345');

      submitForm();

      expect(screen.getByRole('alert')).toHaveTextContent('パスワードは16文字以上で入力してください');
      expect(registerMock).not.toHaveBeenCalled();
    });

    test('DD-AUTH-009 16 文字ちょうどなら長さの誤りを出さず register を呼ぶ', async () => {
      render(<RegisterModal />);
      fillForm();

      submitForm();

      await waitFor(() => expect(registerMock).toHaveBeenCalledTimes(1));
      expect(screen.queryByText('パスワードは16文字以上で入力してください')).not.toBeInTheDocument();
    });

    test('DD-AUTH-009 2つのパスワードが違えば「パスワードが一致しません」を出し register を呼ばない', () => {
      render(<RegisterModal />);
      fillForm(VALID_EMAIL, VALID_PASSWORD, 'abcdefghij123457');

      submitForm();

      expect(screen.getByRole('alert')).toHaveTextContent('パスワードが一致しません');
      expect(registerMock).not.toHaveBeenCalled();
    });

    test('DD-AUTH-009 直す前の誤りは送り直すと消える', async () => {
      render(<RegisterModal />);
      fillForm(VALID_EMAIL, VALID_PASSWORD, 'abcdefghij123457');
      submitForm();
      expect(screen.getByRole('alert')).toHaveTextContent('パスワードが一致しません');

      fillForm();
      submitForm();

      await waitFor(() => expect(registerMock).toHaveBeenCalledTimes(1));
      expect(screen.queryByText('パスワードが一致しません')).not.toBeInTheDocument();
    });
  });

  describe('Turnstile', () => {
    test('DD-AUTH-009 鍵が無いと Script と入れ物を描かず、トークン無しで register を呼ぶ', async () => {
      render(<RegisterModal />);
      fillForm();

      submitForm();

      await waitFor(() =>
        expect(registerMock).toHaveBeenCalledWith(VALID_EMAIL, VALID_PASSWORD, undefined, { next: undefined }),
      );
      expect(screen.queryByTestId('turnstile-script')).not.toBeInTheDocument();
      expect(mockTurnstile.siteKey).toBe('');
      expect(mockTurnstile.containerRef).not.toHaveBeenCalledWith(expect.any(HTMLElement));
    });

    test('DD-AUTH-009 鍵があると Script を読み込み、読めたら描く関数を渡し、入れ物を描く', () => {
      process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY = 'site-key';
      render(<RegisterModal />);

      expect(screen.getByTestId('turnstile-script')).toBeInTheDocument();
      expect(mockScript.props).toMatchObject({
        id: 'turnstile-register-script',
        src: 'https://challenges.cloudflare.com/turnstile/v0/api.js',
        strategy: 'afterInteractive',
        onReady: mockTurnstile.renderWidget,
      });
      expect(mockTurnstile.siteKey).toBe('site-key');
      expect(mockTurnstile.containerRef).toHaveBeenCalledWith(expect.any(HTMLDivElement));
    });

    test('DD-AUTH-009 鍵があり Turnstile が済んでいないと「ボット検証を完了してください」を出す', () => {
      process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY = 'site-key';
      render(<RegisterModal />);
      fillForm();

      submitForm();

      expect(screen.getByRole('alert')).toHaveTextContent('ボット検証を完了してください');
      expect(registerMock).not.toHaveBeenCalled();
      expect(mockTurnstile.resetWidget).not.toHaveBeenCalled();
    });

    test('DD-AUTH-009 鍵があり Turnstile が済んでいれば、そのトークンを渡して register を呼ぶ', async () => {
      process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY = 'site-key';
      render(<RegisterModal />);
      fillForm();
      giveTurnstileToken('turnstile-token');

      submitForm();

      await waitFor(() =>
        expect(registerMock).toHaveBeenCalledWith(VALID_EMAIL, VALID_PASSWORD, 'turnstile-token', {
          next: undefined,
        }),
      );
    });

    test('DD-AUTH-009 成功しても Turnstile を引き直す', async () => {
      render(<RegisterModal />);
      fillForm();

      submitForm();

      await screen.findByText(DEFAULT_SENT_MESSAGE);
      expect(mockTurnstile.resetWidget).toHaveBeenCalledTimes(1);
    });

    test('DD-AUTH-009 register が失敗しても Turnstile を引き直す', async () => {
      registerMock.mockResolvedValue({ success: false, error: '登録できません' });
      render(<RegisterModal />);
      fillForm();

      submitForm();

      await waitFor(() => expect(mockTurnstile.resetWidget).toHaveBeenCalledTimes(1));
    });

    test('DD-AUTH-009 register が投げても Turnstile を引き直す', async () => {
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      registerMock.mockRejectedValue(new Error('network'));
      render(<RegisterModal />);
      fillForm();

      submitForm();

      await waitFor(() => expect(mockTurnstile.resetWidget).toHaveBeenCalledTimes(1));
      consoleSpy.mockRestore();
    });
  });

  describe('register の結果', () => {
    test('DD-AUTH-009 失敗で窓口の文があれば出し、フォームに留まる', async () => {
      registerMock.mockResolvedValue({ success: false, error: '登録できません' });
      render(<RegisterModal />);
      fillForm();

      submitForm();

      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('登録できません'));
      expect(screen.getByLabelText('Email')).toBeInTheDocument();
      expect(screen.queryByText(DEFAULT_SENT_MESSAGE)).not.toBeInTheDocument();
    });

    test('DD-AUTH-009 失敗で窓口の文が無ければ「登録に失敗しました」を出す', async () => {
      registerMock.mockResolvedValue({ success: false });
      render(<RegisterModal />);
      fillForm();

      submitForm();

      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('登録に失敗しました'));
    });

    test('DD-AUTH-009 register が投げたら記録して「登録に失敗しました」を出す', async () => {
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      registerMock.mockRejectedValue(new Error('network'));
      render(<RegisterModal />);
      fillForm();

      submitForm();

      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('登録に失敗しました'));
      expect(consoleSpy).toHaveBeenCalledWith('Unexpected register error', expect.any(Error));
      consoleSpy.mockRestore();
    });

    test('DD-AUTH-009 成功で窓口の文があれば案内の画面に入れ、フォームを外してフォーカスを移す', async () => {
      registerMock.mockResolvedValue({ success: true, message: '窓口からの案内です' });
      render(<RegisterModal />);
      fillForm();

      submitForm();

      const message = await screen.findByText('窓口からの案内です');
      expect(message).toHaveFocus();
      expect(screen.queryByLabelText('Email')).not.toBeInTheDocument();
      expect(
        screen.getByText('メールが届かない場合は、迷惑メールフォルダをご確認ください。'),
      ).toBeInTheDocument();
    });

    test('DD-AUTH-009 成功で窓口の文が無ければ既定の確認メールの案内を入れる', async () => {
      registerMock.mockResolvedValue({ success: true });
      render(<RegisterModal />);
      fillForm();

      submitForm();

      const message = await screen.findByText(DEFAULT_SENT_MESSAGE);
      expect(message).toHaveFocus();
    });

    test('DD-AUTH-009 案内の画面を外す時は要素が無いのでフォーカスを移さず例外を出さない', async () => {
      const { unmount } = render(<RegisterModal />);
      fillForm();
      submitForm();
      await screen.findByText(DEFAULT_SENT_MESSAGE);

      expect(() => unmount()).not.toThrow();
    });

    test('DD-AUTH-009 onSwitchToLogin があれば「ログインページへ」はボタンで、押すと呼ぶ', async () => {
      const user = userEvent.setup();
      const onSwitchToLogin = jest.fn();
      render(<RegisterModal onSwitchToLogin={onSwitchToLogin} />);
      fillForm();
      submitForm();
      await screen.findByText(DEFAULT_SENT_MESSAGE);

      expect(screen.queryByRole('link', { name: 'ログインページへ' })).not.toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'ログインページへ' }));

      expect(onSwitchToLogin).toHaveBeenCalledTimes(1);
    });

    test('DD-AUTH-009 onSwitchToLogin が無ければ「ログインページへ」は /login へのリンク', async () => {
      render(<RegisterModal />);
      fillForm();
      submitForm();
      await screen.findByText(DEFAULT_SENT_MESSAGE);

      expect(screen.getByRole('link', { name: 'ログインページへ' })).toHaveAttribute('href', '/login');
      expect(screen.queryByRole('button', { name: 'ログインページへ' })).not.toBeInTheDocument();
    });
  });

  describe('欄とボタン', () => {
    test('DD-AUTH-009 パスワードの表示切替で欄の種類・読み上げの名前・押した印・アイコンを切り替える', async () => {
      const user = userEvent.setup();
      render(<RegisterModal />);

      const showButton = screen.getByRole('button', { name: 'パスワードを表示' });
      expect(showButton).toHaveAttribute('aria-pressed', 'false');
      expect(showButton.querySelector('i')).toHaveClass('ri-eye-off-line');

      await user.click(showButton);

      expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'text');
      // 確認用の欄は切り替わらない
      expect(screen.getByLabelText('Confirm Password')).toHaveAttribute('type', 'password');
      const hideButton = screen.getByRole('button', { name: 'パスワードを非表示' });
      expect(hideButton).toHaveAttribute('aria-pressed', 'true');
      expect(hideButton.querySelector('i')).toHaveClass('ri-eye-line');

      await user.click(hideButton);

      expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'password');
    });

    test('DD-AUTH-009 確認用の表示切替で欄の種類・読み上げの名前・押した印・アイコンを切り替える', async () => {
      const user = userEvent.setup();
      render(<RegisterModal />);

      const showButton = screen.getByRole('button', { name: '確認用パスワードを表示' });
      expect(showButton).toHaveAttribute('aria-pressed', 'false');
      expect(showButton.querySelector('i')).toHaveClass('ri-eye-off-line');

      await user.click(showButton);

      expect(screen.getByLabelText('Confirm Password')).toHaveAttribute('type', 'text');
      expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'password');
      const hideButton = screen.getByRole('button', { name: '確認用パスワードを非表示' });
      expect(hideButton).toHaveAttribute('aria-pressed', 'true');
      expect(hideButton.querySelector('i')).toHaveClass('ri-eye-line');

      await user.click(hideButton);

      expect(screen.getByLabelText('Confirm Password')).toHaveAttribute('type', 'password');
    });

    test('DD-AUTH-009 どれかの欄が空のあいだは登録のボタンを押せない', () => {
      render(<RegisterModal />);
      const registerButton = screen.getByRole('button', { name: '登録して確認メールを受け取る' });
      expect(registerButton).toBeDisabled();

      fireEvent.change(screen.getByLabelText('Email'), { target: { value: VALID_EMAIL } });
      expect(registerButton).toBeDisabled();

      fireEvent.change(screen.getByLabelText('Password'), { target: { value: VALID_PASSWORD } });
      expect(registerButton).toBeDisabled();

      fireEvent.change(screen.getByLabelText('Confirm Password'), { target: { value: VALID_PASSWORD } });
      expect(registerButton).toBeEnabled();

      fireEvent.change(screen.getByLabelText('Email'), { target: { value: '' } });
      expect(registerButton).toBeDisabled();
    });

    test('DD-AUTH-009 送信中は「処理中...」でボタンを押せず、失敗で戻る', async () => {
      let resolveRegister: (value: { success: boolean }) => void = () => {};
      registerMock.mockReturnValue(
        new Promise((resolve) => {
          resolveRegister = resolve;
        }),
      );
      render(<RegisterModal />);
      fillForm();

      submitForm();

      const busyButton = await screen.findByRole('button', { name: '処理中...' });
      expect(busyButton).toBeDisabled();

      await act(async () => {
        resolveRegister({ success: false });
      });

      expect(screen.getByRole('button', { name: '登録して確認メールを受け取る' })).toBeEnabled();
    });
  });

  test('DD-AUTH-009 Google のボタンで loginWithGoogle を returnTo つきで呼ぶ', async () => {
    const user = userEvent.setup();
    render(<RegisterModal returnTo="/item/3?color=red" />);

    await user.click(screen.getByRole('button', { name: 'Googleで登録' }));

    expect(loginWithGoogleMock).toHaveBeenCalledWith({ next: '/item/3?color=red' });
    expect(registerMock).not.toHaveBeenCalled();
  });

  test('DD-AUTH-009 returnTo が無ければ Google の next も無い（/auth/verified を決め打ちしない）', async () => {
    const user = userEvent.setup();
    render(<RegisterModal />);

    await user.click(screen.getByRole('button', { name: 'Googleで登録' }));

    expect(loginWithGoogleMock).toHaveBeenCalledWith({ next: undefined });
  });

  test('DD-AUTH-009 returnTo を register の next として渡す', async () => {
    render(<RegisterModal returnTo="/account" />);
    fillForm();

    submitForm();

    await waitFor(() =>
      expect(registerMock).toHaveBeenCalledWith(VALID_EMAIL, VALID_PASSWORD, undefined, { next: '/account' }),
    );
  });
});
