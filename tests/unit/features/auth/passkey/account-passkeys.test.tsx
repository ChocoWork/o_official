/**
 * @jest-environment jsdom
 */
/**
 * DD-AUTH-065 アカウントの「ログイン方法」のパスキー（一覧・追加・名前・削除）
 */
import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import AccountPasskeys from '@/features/auth/passkey/components/AccountPasskeys';

const mockList = jest.fn();
const mockRename = jest.fn();
const mockDelete = jest.fn();
const mockRegister = jest.fn();
const mockSupported = jest.fn();

jest.mock('@/lib/client-fetch', () => ({ clientFetch: jest.fn() }));
jest.mock('@/features/auth/passkey/passkey-client', () => ({
  listPasskeys: (...a: unknown[]) => mockList(...a),
  renamePasskey: (...a: unknown[]) => mockRename(...a),
  deletePasskey: (...a: unknown[]) => mockDelete(...a),
  registerPasskey: (...a: unknown[]) => mockRegister(...a),
}));
jest.mock('@/features/auth/passkey/webauthn-browser', () => ({
  isPasskeySupported: () => mockSupported(),
  requestAttestation: jest.fn(),
}));

const A = { id: 'a', friendly_name: 'Mac', created_at: '2026-11-17T20:00:00Z', last_used_at: '2026-11-18T01:00:00Z' };
const B = { id: 'b', friendly_name: null, created_at: '2026-01-05T00:00:00Z', last_used_at: null };

async function renderWith(passkeys: unknown[] = [A, B]) {
  mockList.mockResolvedValue({ ok: true, passkeys });
  const view = render(<AccountPasskeys />);
  await waitFor(() => expect(screen.queryByTestId('account-passkeys-loading')).not.toBeInTheDocument());
  return view;
}

describe('AccountPasskeys', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSupported.mockReturnValue(true);
  });

  test('DD-AUTH-065 見出し・説明・読み込み中のスケルトン', async () => {
    mockList.mockReturnValue(new Promise(() => undefined));
    render(<AccountPasskeys />);
    expect(screen.getByRole('heading', { name: 'パスキー' })).toBeInTheDocument();
    expect(screen.getByText('パスキーを登録すると、この端末の顔認証・指紋・PIN でログインできます。')).toBeInTheDocument();
    expect(screen.getByTestId('account-passkeys-loading')).toHaveClass('animate-pulse');
  });

  test('DD-AUTH-065 一覧: 名前・作成日・最後に使った日を日本時間で出し、名前が無ければ「名前なし」', async () => {
    await renderWith();
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(within(items[0]).getByText('Mac')).toBeInTheDocument();
    // 2026-11-17T20:00Z は日本時間で 11月18日
    expect(within(items[0]).getByText('2026年11月18日 に作成')).toBeInTheDocument();
    expect(within(items[0]).getByText('最後に使った日: 2026年11月18日')).toBeInTheDocument();
    expect(within(items[1]).getByText('名前なし')).toBeInTheDocument();
    expect(within(items[1]).getByText('2026年1月5日 に作成')).toBeInTheDocument();
    expect(within(items[1]).queryByText(/最後に使った日/)).not.toBeInTheDocument();
    for (const item of items) {
      expect(within(item).getByRole('button', { name: /名前を変更/ })).toHaveAttribute('data-ui-button-size', 'md');
      expect(within(item).getByRole('button', { name: /削除/ })).toBeInTheDocument();
    }
  });

  test('DD-AUTH-065 空: 文と「パスキーを追加」', async () => {
    await renderWith([]);
    expect(screen.getByText('パスキーはまだありません。作ると、メールのコードを待たずにログインできます。')).toBeInTheDocument();
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'パスキーを追加' })).toBeEnabled();
  });

  test('DD-AUTH-065 読み込みの失敗: 文と「再読み込み」で引き直せる', async () => {
    mockList.mockResolvedValueOnce({ ok: false, reason: 'failed' });
    render(<AccountPasskeys />);
    expect(await screen.findByText('パスキーの一覧を読み込めませんでした。')).toBeInTheDocument();
    mockList.mockResolvedValueOnce({ ok: true, passkeys: [A] });
    fireEvent.click(screen.getByRole('button', { name: '再読み込み' }));
    expect(await screen.findByText('Mac')).toBeInTheDocument();
    expect(mockList).toHaveBeenCalledTimes(2);
  });

  test('DD-AUTH-065 対応していないブラウザ: 一覧と名前・削除は出し、追加は無効で一文を出す', async () => {
    mockSupported.mockReturnValue(false);
    await renderWith();
    expect(screen.getByRole('button', { name: 'パスキーを追加' })).toBeDisabled();
    expect(screen.getByText('この端末ではパスキーを追加できません。')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /名前を変更/ })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: /削除/ })).toHaveLength(2);
  });

  test('DD-AUTH-065 名前の変更: その場で入力欄になり、保存で名前が替わる', async () => {
    await renderWith();
    mockRename.mockResolvedValue({ ok: true, passkey: { id: 'a', friendly_name: 'Work PC' } });
    fireEvent.click(screen.getAllByRole('button', { name: /名前を変更/ })[0]);
    const input = screen.getByLabelText('名前');
    expect(input).toHaveValue('Mac');
    fireEvent.change(input, { target: { value: '  Work PC ' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '保存' }));
    });
    expect(mockRename).toHaveBeenCalledWith('a', 'Work PC');
    expect(screen.getByText('Work PC')).toBeInTheDocument();
    expect(screen.queryByLabelText('名前')).not.toBeInTheDocument();
  });

  test('DD-AUTH-065 名前の変更: 名前なしの行は空の入力欄から始まる', async () => {
    await renderWith();
    fireEvent.click(screen.getAllByRole('button', { name: /名前を変更/ })[1]);
    expect(screen.getByLabelText('名前')).toHaveValue('');
  });

  test('DD-AUTH-065 名前の変更: キャンセルで元に戻り、窓口は呼ばない', async () => {
    await renderWith();
    fireEvent.click(screen.getAllByRole('button', { name: /名前を変更/ })[0]);
    fireEvent.change(screen.getByLabelText('名前'), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }));
    expect(screen.getByText('Mac')).toBeInTheDocument();
    expect(mockRename).not.toHaveBeenCalled();
  });

  test('DD-AUTH-065 名前の変更: 空・65字は送らず、64字は送る', async () => {
    await renderWith();
    fireEvent.click(screen.getAllByRole('button', { name: /名前を変更/ })[0]);
    const input = screen.getByLabelText('名前');
    fireEvent.change(input, { target: { value: '   ' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '保存' }));
    });
    expect(screen.getByText('名前は1〜64字で入力してください。')).toHaveAttribute('role', 'alert');
    fireEvent.change(input, { target: { value: 'あ'.repeat(65) } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '保存' }));
    });
    expect(mockRename).not.toHaveBeenCalled();
    mockRename.mockResolvedValue({ ok: true, passkey: { id: 'a', friendly_name: 'あ'.repeat(64) } });
    fireEvent.change(input, { target: { value: 'あ'.repeat(64) } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '保存' }));
    });
    expect(mockRename).toHaveBeenCalledWith('a', 'あ'.repeat(64));
  });

  test('DD-AUTH-065 名前の変更の失敗: 文を出し、入力欄は残る', async () => {
    await renderWith();
    mockRename.mockResolvedValue({ ok: false, reason: 'failed' });
    fireEvent.click(screen.getAllByRole('button', { name: /名前を変更/ })[0]);
    fireEvent.change(screen.getByLabelText('名前'), { target: { value: 'New' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '保存' }));
    });
    expect(screen.getByText('名前を変更できませんでした。もう一度お試しください。')).toHaveAttribute('role', 'alert');
    expect(screen.getByLabelText('名前')).toHaveValue('New');
  });

  test('DD-AUTH-065 削除: 確認の文（2本以上）。成功で一覧から消える', async () => {
    await renderWith();
    mockDelete.mockResolvedValue({ ok: true });
    fireEvent.click(screen.getAllByRole('button', { name: /削除/ })[0]);
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'このパスキーを削除しますか' })).toBeInTheDocument();
    expect(within(dialog).getByText('削除すると、このパスキーではログインできなくなります。')).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: '削除する' }));
    });
    expect(mockDelete).toHaveBeenCalledWith('a');
    expect(screen.queryByText('Mac')).not.toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
  });

  test('DD-AUTH-065 削除: 最後の1本の時だけ本文に追加の文が出る。消すと空の文になる', async () => {
    await renderWith([A]);
    mockDelete.mockResolvedValue({ ok: true });
    fireEvent.click(screen.getByRole('button', { name: /削除/ }));
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('最後のパスキーです。削除しても、メールのコードか Google でログインできます。');
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: '削除する' }));
    });
    expect(screen.getByText('パスキーはまだありません。作ると、メールのコードを待たずにログインできます。')).toBeInTheDocument();
  });

  test('DD-AUTH-065 削除: キャンセルでは窓口を呼ばない。失敗は文を出し、一覧は減らない', async () => {
    await renderWith();
    fireEvent.click(screen.getAllByRole('button', { name: /削除/ })[0]);
    expect(within(screen.getByRole('dialog')).queryByText(/最後のパスキーです/)).not.toBeInTheDocument();
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'キャンセル' }));
    expect(mockDelete).not.toHaveBeenCalled();

    mockDelete.mockResolvedValue({ ok: false, reason: 'failed' });
    fireEvent.click(screen.getAllByRole('button', { name: /削除/ })[0]);
    await act(async () => {
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '削除する' }));
    });
    expect(screen.getByText('削除できませんでした。もう一度お試しください。')).toHaveAttribute('role', 'alert');
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });

  test('DD-AUTH-065 追加の成功: 一覧を引き直して「パスキーを追加しました。」を status で出し、自動では消えない', async () => {
    jest.useFakeTimers();
    try {
      await renderWith([]);
      mockRegister.mockResolvedValue({ ok: true, passkey: A, nameApplied: true });
      mockList.mockResolvedValue({ ok: true, passkeys: [A] });
      screen.getByRole('button', { name: 'パスキーを追加' }).focus();
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'パスキーを追加' }));
      });
      // 一覧の引き直しの間にボタンが消えてフォーカスが落ちるので、戻っている
      expect(screen.getByRole('button', { name: 'パスキーを追加' })).toHaveFocus();
      expect(mockRegister).toHaveBeenCalledTimes(1);
      expect(mockList).toHaveBeenCalledTimes(2);
      expect(screen.getByRole('status')).toHaveTextContent('パスキーを追加しました。');
      expect(screen.getByText('Mac')).toBeInTheDocument();
      act(() => {
        jest.advanceTimersByTime(30_000);
      });
      expect(screen.getByRole('status')).toHaveTextContent('パスキーを追加しました。');
    } finally {
      jest.useRealTimers();
    }
  });

  test.each([
    ['cancelled', 'パスキーの作成を中止しました。'],
    ['already_registered', 'この端末のパスキーは、すでにアカウントに登録されています。'],
    ['unsupported', 'この端末ではパスキーを作れません。'],
    ['retry', 'うまく作れませんでした。もう一度お試しください。'],
    ['failed', 'うまく作れませんでした。もう一度お試しください。'],
    ['rate_limited', '試行が集中しています。しばらくしてからやり直してください。'],
    ['unavailable', 'ただいまパスキーを作れません。時間をおいてお試しください。'],
    ['unauthorized', 'もう一度ログインしてください。'],
  ])('DD-AUTH-065 追加の失敗 %s: 文を出し、メールのコードのリンクは出さない', async (reason, message) => {
    await renderWith([]);
    mockRegister.mockResolvedValue({ ok: false, reason });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'パスキーを追加' }));
    });
    expect(screen.getByText(message)).toHaveAttribute('role', 'alert');
    expect(screen.queryByRole('link', { name: 'メールのコードでログイン' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'パスキーを追加' })).toBeEnabled();
  });

  test('DD-AUTH-065 追加の途中で例外が出ても、うまく作れなかった文を出して続けられる', async () => {
    await renderWith([]);
    mockRegister.mockRejectedValue(new Error('x'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'パスキーを追加' }));
    });
    expect(screen.getByText('うまく作れませんでした。もう一度お試しください。')).toHaveAttribute('role', 'alert');
    expect(screen.getByRole('button', { name: 'パスキーを追加' })).toBeEnabled();
  });

  test('DD-AUTH-065 reauth_required: 文と、戻り先付きの「メールのコードでログイン」', async () => {
    await renderWith([]);
    mockRegister.mockResolvedValue({ ok: false, reason: 'reauth_required' });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'パスキーを追加' }));
    });
    expect(screen.getByText('安全のため、メールのコードでもう一度ログインしてから追加してください。')).toHaveAttribute('role', 'alert');
    expect(screen.getByRole('link', { name: 'メールのコードでログイン' })).toHaveAttribute(
      'href',
      '/login?next=%2Faccount%3Ftab%3Dsecurity',
    );
  });

  test('DD-AUTH-065 追加の間は無効・aria-busy で、二重に押しても1回。フォーカスが落ちたら戻す', async () => {
    await renderWith([]);
    let resolve!: (value: unknown) => void;
    mockRegister.mockReturnValue(new Promise((r) => (resolve = r)));
    const button = screen.getByRole('button', { name: 'パスキーを追加' });
    button.focus();
    fireEvent.click(button);
    fireEvent.click(button);
    expect(mockRegister).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: '追加しています…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '追加しています…' })).toHaveAttribute('aria-busy', 'true');
    (document.activeElement as HTMLElement | null)?.blur();
    await act(async () => {
      resolve({ ok: false, reason: 'cancelled' });
    });
    expect(screen.getByRole('button', { name: 'パスキーを追加' })).toHaveFocus();
  });

  test('DD-AUTH-065 追加の失敗の後、フォーカスをほかへ移していたら奪わない', async () => {
    await renderWith([]);
    let resolve!: (value: unknown) => void;
    mockRegister.mockReturnValue(new Promise((r) => (resolve = r)));
    fireEvent.click(screen.getByRole('button', { name: 'パスキーを追加' }));
    const other = document.createElement('button');
    document.body.appendChild(other);
    other.focus();
    await act(async () => {
      resolve({ ok: false, reason: 'cancelled' });
    });
    expect(other).toHaveFocus();
    other.remove();
  });
});
