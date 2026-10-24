import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AdminCreateUserPage from '@/app/admin/create-user/page';

const mockFetch = jest.fn();
const realFetch = global.fetch;

beforeAll(() => {
  global.fetch = mockFetch as unknown as typeof fetch;
});

afterAll(() => {
  global.fetch = realFetch;
});

const LONG_PASSWORD = 'a-very-long-pass-1';

function reply(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: body === undefined ? async () => { throw new SyntaxError('no json'); } : async () => body,
  } as unknown as Response;
}

function name() {
  return screen.getByLabelText('NAME') as HTMLInputElement;
}
function email() {
  return screen.getByLabelText('EMAIL') as HTMLInputElement;
}
function password() {
  return screen.getByLabelText('PASSWORD') as HTMLInputElement;
}
function submit() {
  return screen.getByRole('button', { name: '作成' });
}

describe('利用者の作成の画面（SCR-ADMIN-001）', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('SCR-ADMIN-001 見出しと NAME・EMAIL・PASSWORD の欄と作成ボタンを出し、メールは email 型・パスワードは伏せ字', () => {
    render(<AdminCreateUserPage />);

    expect(screen.getByRole('heading', { level: 1, name: '管理者: ユーザ作成' })).toBeInTheDocument();
    expect(name()).toBeInTheDocument();
    expect(email()).toHaveAttribute('type', 'email');
    expect(password()).toHaveAttribute('type', 'password');
    expect(submit()).toBeEnabled();
    expect(screen.queryByText(/ユーザ作成しました|失敗|エラー/)).not.toBeInTheDocument();
  });

  it('SCR-ADMIN-001 素の fetch で窓口に JSON を送り、CSRF の見出しは付けない', async () => {
    mockFetch.mockResolvedValue(reply(201, { email: 'new@example.test' }));
    const user = userEvent.setup();
    render(<AdminCreateUserPage />);

    await user.type(name(), '店長');
    await user.type(email(), 'new@example.test');
    await user.type(password(), LONG_PASSWORD);
    await user.click(submit());

    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('/api/admin/create-user');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(init.body)).toEqual({
      email: 'new@example.test',
      password: LONG_PASSWORD,
      display_name: '店長',
    });
  });

  it('SCR-ADMIN-001 201 なら作ったメールを出して欄を空にし、同じ画面に留まる', async () => {
    mockFetch.mockResolvedValue(reply(201, { email: 'new@example.test' }));
    const user = userEvent.setup();
    render(<AdminCreateUserPage />);

    await user.type(name(), '店長');
    await user.type(email(), 'new@example.test');
    await user.type(password(), LONG_PASSWORD);
    await user.click(submit());

    expect(await screen.findByText('ユーザ作成しました: new@example.test')).toBeInTheDocument();
    expect(name()).toHaveValue('');
    expect(email()).toHaveValue('');
    expect(password()).toHaveValue('');
    expect(screen.getByRole('heading', { level: 1, name: '管理者: ユーザ作成' })).toBeInTheDocument();
  });
});
