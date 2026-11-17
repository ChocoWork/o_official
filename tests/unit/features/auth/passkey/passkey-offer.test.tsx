import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import PasskeyOffer from '@/features/auth/passkey/components/PasskeyOffer';

const mockReplace = jest.fn();
const mockRegister = jest.fn();
const mockResolve = jest.fn();
let loginState: { isAuthResolved: boolean; isLoggedIn: boolean; userRole: string } = {
  isAuthResolved: true,
  isLoggedIn: true,
  userRole: 'user',
};
const mockPlatformAvailable = jest.fn();

jest.mock('next/navigation', () => ({ useRouter: () => ({ replace: mockReplace }) }));
jest.mock('@/contexts/LoginContext', () => ({ useLogin: () => loginState }));
jest.mock('@/lib/client-fetch', () => ({ clientFetch: jest.fn() }));
jest.mock('@/features/auth/passkey/passkey-client', () => ({
  registerPasskey: (...a: unknown[]) => mockRegister(...a),
}));
jest.mock('@/features/auth/passkey/webauthn-browser', () => ({ requestAttestation: jest.fn() }));
jest.mock('@/features/auth/passkey/post-login', () => ({ resolvePostLoginPath: () => mockResolve() }));

const originalPkc = (window as unknown as { PublicKeyCredential?: unknown }).PublicKeyCredential;

function setPlatform(value: 'available' | 'unavailable' | 'throws' | 'missing') {
  if (value === 'missing') {
    Object.defineProperty(window, 'PublicKeyCredential', { configurable: true, value: undefined });
    return;
  }
  mockPlatformAvailable.mockImplementation(async () => {
    if (value === 'throws') throw new Error('x');
    return value === 'available';
  });
  Object.defineProperty(window, 'PublicKeyCredential', {
    configurable: true,
    value: { isUserVerifyingPlatformAuthenticatorAvailable: mockPlatformAvailable },
  });
}

async function renderOffer() {
  const view = render(<PasskeyOffer />);
  await waitFor(() => expect(screen.getByRole('heading', { name: 'パスキーを作りませんか' })).toBeInTheDocument());
  return view;
}

async function clickCreate(name = 'パスキーを作る') {
  const button = screen.getByRole('button', { name });
  button.focus();
  await act(async () => {
    fireEvent.click(button);
  });
}

describe('PasskeyOffer', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    loginState = { isAuthResolved: true, isLoggedIn: true, userRole: 'user' };
    mockResolve.mockResolvedValue('/after');
    setPlatform('available');
  });
  afterAll(() => {
    Object.defineProperty(window, 'PublicKeyCredential', { configurable: true, value: originalPkc });
  });

  test('DD-AUTH-064 文言・2つのボタン・見出しへの初期フォーカス', async () => {
    await renderOffer();
    expect(screen.getByRole('heading', { name: 'パスキーを作りませんか' })).toHaveFocus();
    expect(
      screen.getByText('次回からは、この端末の顔認証・指紋・PIN でログインできます。メールでコードを待つ必要はありません。'),
    ).toBeInTheDocument();
    expect(screen.getByText('あとからでも、アカウントの「ログイン方法」で作れます。')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'パスキーを作る' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'あとで' })).toBeEnabled();
    expect(mockReplace).not.toHaveBeenCalled();
    expect(mockResolve).not.toHaveBeenCalled();
  });

  test('DD-AUTH-064 判定が終わるまでは何も描かない', () => {
    loginState = { isAuthResolved: false, isLoggedIn: false, userRole: 'user' };
    const { container } = render(<PasskeyOffer />);
    expect(container).toBeEmptyDOMElement();
    expect(mockReplace).not.toHaveBeenCalled();
  });

  test('DD-AUTH-064 ログインしていなければ /login へ送り、勧めを出さない', async () => {
    loginState = { isAuthResolved: true, isLoggedIn: false, userRole: 'user' };
    const { container } = render(<PasskeyOffer />);
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/login'));
    expect(container).toBeEmptyDOMElement();
    expect(mockResolve).not.toHaveBeenCalled();
  });

  test('DD-AUTH-064 店員には勧めず、行き先へ送る', async () => {
    loginState = { isAuthResolved: true, isLoggedIn: true, userRole: 'admin' };
    const { container } = render(<PasskeyOffer />);
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/after'));
    expect(container).toBeEmptyDOMElement();
    expect(mockResolve).toHaveBeenCalledTimes(1);
    expect(mockRegister).not.toHaveBeenCalled();
  });

  test.each(['unavailable', 'throws', 'missing'] as const)(
    'DD-AUTH-064 顔・指紋・PIN の使えない端末（%s）には勧めず、行き先へ送る',
    async (kind) => {
      setPlatform(kind);
      const { container } = render(<PasskeyOffer />);
      await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/after'));
      expect(container).toBeEmptyDOMElement();
      expect(mockResolve).toHaveBeenCalledTimes(1);
    },
  );

  test('DD-AUTH-064 「あとで」で行き先を1回だけ引いて移る（二重に押しても1回）', async () => {
    await renderOffer();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'あとで' }));
      fireEvent.click(screen.getByRole('button', { name: 'あとで' }));
    });
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/after'));
    expect(mockResolve).toHaveBeenCalledTimes(1);
    expect(mockReplace).toHaveBeenCalledTimes(1);
    expect(mockRegister).not.toHaveBeenCalled();
  });

  test('DD-AUTH-064 作っている間は無効・aria-busy・「作成しています…」で、無効のボタンは押せず1回', async () => {
    let finish: (value: unknown) => void = () => undefined;
    mockRegister.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    await renderOffer();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'パスキーを作る' }));
    });
    const busy = screen.getByRole('button', { name: '作成しています…' });
    expect(busy).toBeDisabled();
    expect(busy).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('button', { name: 'あとで' })).toBeDisabled();
    fireEvent.click(busy);
    expect(mockRegister).toHaveBeenCalledTimes(1);
    await act(async () => {
      finish({ ok: true, passkey: { id: 'k', friendly_name: 'Windows', created_at: 't' }, nameApplied: true });
    });
  });

  test('DD-AUTH-064 成功は自動で進まず、文と「続ける」を出してフォーカスを移す。押すと行き先へ', async () => {
    mockRegister.mockResolvedValue({ ok: true, passkey: { id: 'k', friendly_name: 'Windows', created_at: 't' }, nameApplied: true });
    await renderOffer();
    jest.useFakeTimers();
    try {
      await clickCreate();
      expect(screen.getByRole('status')).toHaveTextContent('パスキーを作りました。');
      expect(screen.queryByText('名前は、アカウントのログイン方法から変えられます。', { exact: false })).not.toBeInTheDocument();
      const next = screen.getByRole('button', { name: '続ける' });
      expect(next).toHaveFocus();
      expect(screen.queryByRole('button', { name: 'パスキーを作る' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'あとで' })).not.toBeInTheDocument();
      await act(async () => {
        jest.advanceTimersByTime(10_000);
      });
      expect(mockResolve).not.toHaveBeenCalled();
      expect(mockReplace).not.toHaveBeenCalled();
      jest.useRealTimers();
      await act(async () => {
        fireEvent.click(next);
      });
      await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/after'));
      expect(mockResolve).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  test('DD-AUTH-064 名前が付かなかった時は、あとから変えられると足す', async () => {
    mockRegister.mockResolvedValue({ ok: true, passkey: { id: 'k', friendly_name: null, created_at: 't' }, nameApplied: false });
    await renderOffer();
    await clickCreate();
    expect(screen.getByRole('status')).toHaveTextContent('パスキーを作りました。名前は、アカウントのログイン方法から変えられます。');
  });

  test('DD-AUTH-064 中止は文を出し、作り直しと「あとで」が残り、フォーカスが戻る', async () => {
    let finish: (value: unknown) => void = () => undefined;
    mockRegister.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    await renderOffer();
    const create = screen.getByRole('button', { name: 'パスキーを作る' });
    create.focus();
    await act(async () => {
      fireEvent.click(create);
    });
    // 実ブラウザでは、無効になったボタンからフォーカスが落ちて body になる（jsdom は落とさないので、読み取りを差し替える）。
    const active = jest.spyOn(document, 'activeElement', 'get').mockReturnValue(document.body);
    try {
      await act(async () => {
        finish({ ok: false, reason: 'cancelled' });
      });
    } finally {
      active.mockRestore();
    }
    expect(screen.getByRole('alert')).toHaveTextContent('パスキーの作成を中止しました。');
    expect(screen.getByRole('button', { name: 'パスキーを作る' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'あとで' })).toBeEnabled();
    await waitFor(() => expect(screen.getByRole('button', { name: 'パスキーを作る' })).toHaveFocus());
  });

  test('DD-AUTH-064 失敗の後、フォーカスをほかへ移していたら奪わない', async () => {
    let finish: (value: unknown) => void = () => undefined;
    mockRegister.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    await renderOffer();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'パスキーを作る' }));
    });
    const heading = screen.getByRole('heading', { name: 'パスキーを作りませんか' });
    heading.focus();
    await act(async () => {
      finish({ ok: false, reason: 'cancelled' });
    });
    expect(heading).toHaveFocus();
  });

  test.each(['retry', 'failed'] as const)('DD-AUTH-064 %s は「うまく作れませんでした」と「もう一度」（始めから）', async (reason) => {
    mockRegister.mockResolvedValueOnce({ ok: false, reason });
    await renderOffer();
    await clickCreate();
    expect(screen.getByRole('alert')).toHaveTextContent('うまく作れませんでした。もう一度お試しください。');
    expect(screen.getByRole('button', { name: 'あとで' })).toBeEnabled();
    mockRegister.mockResolvedValueOnce({ ok: true, passkey: { id: 'k', friendly_name: 'x', created_at: 't' }, nameApplied: true });
    await clickCreate('もう一度');
    expect(mockRegister).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('status')).toHaveTextContent('パスキーを作りました。');
    expect(screen.getByRole('alert')).toBeEmptyDOMElement();
  });

  test.each([
    ['already_registered', 'この端末のパスキーは、すでにアカウントに登録されています。'],
    ['unsupported', 'この端末ではパスキーを作れません。'],
  ] as const)('DD-AUTH-064 %s は文と「続ける」だけで、続けると行き先へ', async (reason, message) => {
    mockRegister.mockResolvedValue({ ok: false, reason });
    await renderOffer();
    // 実ブラウザでは、消えたボタンからフォーカスが落ちて body になる（読み取りを差し替える）。
    const active = jest.spyOn(document, 'activeElement', 'get').mockReturnValue(document.body);
    try {
      await clickCreate();
    } finally {
      active.mockRestore();
    }
    expect(screen.getByRole('alert')).toHaveTextContent(message);
    expect(screen.queryByRole('button', { name: 'パスキーを作る' })).not.toBeInTheDocument();
    const next = screen.getByRole('button', { name: '続ける' });
    await waitFor(() => expect(next).toHaveFocus());
    await act(async () => {
      fireEvent.click(next);
    });
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/after'));
  });

  test.each(['reauth_required', 'unauthorized'] as const)('DD-AUTH-064 %s は「もう一度ログインしてください。」と /login へのボタン', async (reason) => {
    mockRegister.mockResolvedValue({ ok: false, reason });
    await renderOffer();
    await clickCreate();
    expect(screen.getByRole('alert')).toHaveTextContent('もう一度ログインしてください。');
    expect(mockReplace).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'ログインへ' }));
    });
    expect(mockReplace).toHaveBeenCalledWith('/login');
    expect(mockResolve).not.toHaveBeenCalled();
  });

  test('DD-AUTH-064 rate_limited と unavailable の文', async () => {
    mockRegister.mockResolvedValueOnce({ ok: false, reason: 'rate_limited' });
    await renderOffer();
    await clickCreate();
    expect(screen.getByRole('alert')).toHaveTextContent('試行が集中しています。しばらくしてからやり直してください。');
    mockRegister.mockResolvedValueOnce({ ok: false, reason: 'unavailable' });
    await clickCreate();
    expect(screen.getByRole('alert')).toHaveTextContent('ただいまパスキーを作れません。時間をおいてお試しください。');
  });

  test('DD-AUTH-064 作る処理が投げても「うまく作れませんでした」で止まる', async () => {
    mockRegister.mockRejectedValue(new Error('boom'));
    await renderOffer();
    await clickCreate();
    expect(screen.getByRole('alert')).toHaveTextContent('うまく作れませんでした。もう一度お試しください。');
  });
});
