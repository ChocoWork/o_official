import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import EmailCodeStartForm from '@/features/auth/passkey/components/EmailCodeStartForm';

const mockReplace = jest.fn();
const mockReset = jest.fn();
jest.mock('next/navigation', () => ({ useRouter: () => ({ replace: mockReplace }) }));

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function setup(props: Partial<React.ComponentProps<typeof EmailCodeStartForm>> = {}) {
  return render(
    <EmailCodeStartForm siteKey="" turnstileToken="" turnstileRef={() => undefined} resetTurnstile={mockReset} {...props} />,
  );
}

async function submit(email = 'a@example.com') {
  fireEvent.change(screen.getByRole('textbox', { name: 'Email' }), { target: { value: email } });
  await act(async () => {
    fireEvent.submit(
      screen.getByRole('button', { name: /メールでコードを受け取る|送信しています/ }).closest('form') as HTMLFormElement,
    );
  });
}

describe('EmailCodeStartForm', () => {
  const originalFetch = global.fetch;
  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn();
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('DD-AUTH-063 空のメールではボタンが disabled', () => {
    setup();
    expect(screen.getByRole('button', { name: 'メールでコードを受け取る' })).toBeDisabled();
  });

  test('DD-AUTH-063 形の誤りは送らずに止める', async () => {
    setup();
    await submit('not-an-email');
    expect(global.fetch).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).not.toBeEmptyDOMElement();
  });

  test('DD-AUTH-063 202 なら本文を読んで /login/code へ置き換え、戻り先と Turnstile を本文に載せる', async () => {
    const response = json(202, { step: 'code' });
    const spy = jest.spyOn(response, 'json');
    (global.fetch as jest.Mock).mockResolvedValue(response);
    setup({ returnTo: '/account', siteKey: 'k', turnstileToken: 'tok' });
    await submit();
    const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('/api/auth/email-code/start');
    expect(init.cache).toBe('no-store');
    expect(JSON.parse(init.body)).toEqual({ email: 'a@example.com', turnstileToken: 'tok', next: '/account' });
    expect(spy).toHaveBeenCalled();
    expect(mockReplace).toHaveBeenCalledWith('/login/code');
    expect(mockReset).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /送信しています/ })).toBeDisabled();
  });

  test('DD-AUTH-063 Turnstile が必要で未完了なら送らない', async () => {
    setup({ siteKey: 'k' });
    await submit();
    expect(global.fetch).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('ボット検証を完了してください');
  });

  test('DD-AUTH-063 400 は本文の文を表示し、入力を戻す', async () => {
    (global.fetch as jest.Mock).mockResolvedValue(json(400, { error: 'メールアドレスの形式が正しくありません。' }));
    setup();
    await submit();
    expect(screen.getByRole('alert')).toHaveTextContent('メールアドレスの形式が正しくありません。');
    expect(screen.getByRole('button', { name: 'メールでコードを受け取る' })).toBeEnabled();
    expect(mockReplace).not.toHaveBeenCalled();
  });

  test('DD-AUTH-063 400 の本文が message だけなら、その文を出す', async () => {
    (global.fetch as jest.Mock).mockResolvedValue(json(400, { message: '入力に誤りがあります' }));
    setup();
    await submit();
    expect(screen.getByRole('alert')).toHaveTextContent('入力に誤りがあります');
  });

  test.each([
    ['空の本文', json(400, {})],
    ['配列の本文', json(400, [1])],
    ['JSON でない本文', new Response('oops', { status: 400 })],
  ])('DD-AUTH-063 400 の本文が読めない・文が無い（%s）なら送れなかった文', async (_label, response) => {
    (global.fetch as jest.Mock).mockResolvedValue(response);
    setup();
    await submit();
    expect(screen.getByRole('alert')).toHaveTextContent('確認コードを送れませんでした。時間をおいてやり直してください。');
  });

  test('DD-AUTH-063 メール欄の初めの値を入れる', () => {
    setup({ initialEmail: 'a@example.com' });
    expect(screen.getByRole('textbox', { name: 'Email' })).toHaveValue('a@example.com');
  });

  test('DD-AUTH-063 403 Bot detection failed は「ボット検証を完了してください」', async () => {
    (global.fetch as jest.Mock).mockResolvedValue(json(403, { error: 'Bot detection failed' }));
    setup();
    await submit();
    expect(screen.getByRole('alert')).toHaveTextContent('ボット検証を完了してください');
    expect(mockReset).toHaveBeenCalled();
  });

  test.each([
    ['別の理由', json(403, { error: 'Forbidden' })],
    ['本文が読めない', new Response('oops', { status: 403 })],
  ])('DD-AUTH-063 403 でもボット検証の拒否でなければ送れなかった文（%s）', async (_label, response) => {
    (global.fetch as jest.Mock).mockResolvedValue(response);
    setup();
    await submit();
    expect(screen.getByRole('alert')).toHaveTextContent('確認コードを送れませんでした。時間をおいてやり直してください。');
  });

  test('DD-AUTH-063 失敗の後はフォーカスをメール欄へ戻す', async () => {
    jest.useFakeTimers();
    (global.fetch as jest.Mock).mockResolvedValue(json(500, {}));
    setup();
    await submit();
    await act(async () => {
      jest.runAllTimers();
    });
    expect(screen.getByRole('textbox', { name: 'Email' })).toHaveFocus();
    jest.useRealTimers();
  });

  test('DD-AUTH-063 フォーカスを戻す前に画面が消えても落ちない', async () => {
    jest.useFakeTimers();
    (global.fetch as jest.Mock).mockResolvedValue(json(500, {}));
    const { unmount } = setup();
    await submit();
    unmount();
    await act(async () => {
      jest.runAllTimers();
    });
    jest.useRealTimers();
  });

  test('DD-AUTH-063 429 は集中の文', async () => {
    (global.fetch as jest.Mock).mockResolvedValue(json(429, { error: 'Too many requests' }));
    setup();
    await submit();
    expect(screen.getByRole('alert')).toHaveTextContent('試行が集中しています。しばらくしてからやり直してください。');
  });

  test.each([[500], [503]])('DD-AUTH-063 %i は「確認コードを送れませんでした」', async (status) => {
    (global.fetch as jest.Mock).mockResolvedValue(json(status, {}));
    setup();
    await submit();
    expect(screen.getByRole('alert')).toHaveTextContent('確認コードを送れませんでした。時間をおいてやり直してください。');
  });

  test('DD-AUTH-063 通信の失敗でも同じ文で、入力を戻す', async () => {
    (global.fetch as jest.Mock).mockRejectedValue(new Error('network'));
    setup();
    await submit();
    expect(screen.getByRole('alert')).toHaveTextContent('確認コードを送れませんでした。時間をおいてやり直してください。');
    expect(screen.getByRole('button', { name: 'メールでコードを受け取る' })).toBeEnabled();
  });

  test('DD-AUTH-063 送信中は二重に送らない', async () => {
    let release: (r: Response) => void = () => undefined;
    (global.fetch as jest.Mock).mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    setup();
    await submit();
    await submit();
    expect(global.fetch).toHaveBeenCalledTimes(1);
    await act(async () => {
      release(json(500, {}));
    });
  });
});
