import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import AdminCreateUserPage from '@/app/admin/create-user/page';

const fetchMock = jest.fn();
const PASSWORD_16 = 'abcdefghijklmnop';
const PASSWORD_15 = 'abcdefghijklmno';

function jsonResponse(status: number, body: unknown) {
  return { status, json: async () => body };
}

function unreadableResponse(status: number) {
  return {
    status,
    json: async () => {
      throw new SyntaxError('Unexpected token');
    },
  };
}

function fill(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

function submit() {
  fireEvent.submit(screen.getByRole('button', { name: '作成' }).closest('form') as HTMLFormElement);
}

function fillAll(email = 'new@example.com', password = PASSWORD_16, name = '新人') {
  fill('NAME', name);
  fill('EMAIL', email);
  fill('PASSWORD', password);
}

describe('AdminCreateUserPage', () => {
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchMock as unknown as typeof fetch;
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('DD-ADMIN-001 3つの欄と「作成」のボタンが出て、初めは知らせが無い', () => {
    const { container } = render(<AdminCreateUserPage />);

    expect(screen.getByLabelText('NAME')).toHaveValue('');
    expect(screen.getByLabelText('EMAIL')).toHaveAttribute('type', 'email');
    expect(screen.getByLabelText('PASSWORD')).toHaveAttribute('type', 'password');
    expect(screen.getByRole('button', { name: '作成' })).toBeEnabled();
    expect(container.querySelector('p')).toBeNull();
  });

  it('DD-ADMIN-001 メールが空の時は「メールとパスワードを入力してください」が出て fetch を呼ばない', () => {
    render(<AdminCreateUserPage />);
    fill('PASSWORD', PASSWORD_16);
    submit();

    expect(screen.getByText('メールとパスワードを入力してください')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('DD-ADMIN-001 パスワードが空の時は「メールとパスワードを入力してください」が出て fetch を呼ばない', () => {
    render(<AdminCreateUserPage />);
    fill('EMAIL', 'new@example.com');
    submit();

    expect(screen.getByText('メールとパスワードを入力してください')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('DD-ADMIN-001 15文字のパスワードでは「パスワードは16文字以上にしてください」が出て fetch を呼ばない', () => {
    render(<AdminCreateUserPage />);
    fillAll('new@example.com', PASSWORD_15);
    submit();

    expect(screen.getByText('パスワードは16文字以上にしてください')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('DD-ADMIN-001 送る時に前の知らせを消す', () => {
    render(<AdminCreateUserPage />);
    submit();
    expect(screen.getByText('メールとパスワードを入力してください')).toBeInTheDocument();

    fillAll('new@example.com', PASSWORD_15);
    submit();

    expect(screen.queryByText('メールとパスワードを入力してください')).not.toBeInTheDocument();
    expect(screen.getByText('パスワードは16文字以上にしてください')).toBeInTheDocument();
  });

  it('DD-ADMIN-001 16文字のパスワードで POST /api/admin/create-user に3つの値の JSON を送り、送っている間はボタンが押せない', async () => {
    let resolveFetch: (value: unknown) => void = () => {};
    fetchMock.mockReturnValue(new Promise((resolve) => { resolveFetch = resolve; }));
    render(<AdminCreateUserPage />);
    fillAll('new@example.com', PASSWORD_16, '新人');
    submit();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/admin/create-user');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(init.headers).not.toHaveProperty('x-csrf-token');
    expect(JSON.parse(init.body)).toEqual({
      email: 'new@example.com',
      password: PASSWORD_16,
      display_name: '新人',
    });
    expect(screen.getByRole('button', { name: '作成' })).toBeDisabled();

    await act(async () => {
      resolveFetch(jsonResponse(201, { id: 'u1', email: 'new@example.com' }));
    });
    await waitFor(() => expect(screen.getByRole('button', { name: '作成' })).toBeEnabled());
  });

  it('DD-ADMIN-001 201 で応答にメールがある時は「ユーザ作成しました: <メール>」が出て3つの欄が空になる', async () => {
    fetchMock.mockResolvedValue(jsonResponse(201, { id: 'u1', email: 'created@example.com' }));
    render(<AdminCreateUserPage />);
    fillAll();
    submit();

    expect(await screen.findByText('ユーザ作成しました: created@example.com')).toBeInTheDocument();
    expect(screen.getByLabelText('NAME')).toHaveValue('');
    expect(screen.getByLabelText('EMAIL')).toHaveValue('');
    expect(screen.getByLabelText('PASSWORD')).toHaveValue('');
  });

  it('DD-ADMIN-001 201 で応答が読めない時は「ユーザ作成しました: 」だけになり欄が空になる', async () => {
    fetchMock.mockResolvedValue(unreadableResponse(201));
    render(<AdminCreateUserPage />);
    fillAll();
    submit();

    const note = await screen.findByText((_, el) => el?.tagName === 'P' && el.textContent === 'ユーザ作成しました: ');
    expect(note).toBeInTheDocument();
    expect(screen.getByLabelText('EMAIL')).toHaveValue('');
  });

  it('DD-ADMIN-001 201 で応答にメールが無い時も「ユーザ作成しました: 」だけになる', async () => {
    fetchMock.mockResolvedValue(jsonResponse(201, { id: 'u1' }));
    render(<AdminCreateUserPage />);
    fillAll();
    submit();

    const note = await screen.findByText((_, el) => el?.tagName === 'P' && el.textContent === 'ユーザ作成しました: ');
    expect(note).toBeInTheDocument();
  });

  it('DD-ADMIN-001 201 でなく error がある時はその文を出し、入力は残る', async () => {
    fetchMock.mockResolvedValue(jsonResponse(409, { error: 'Email already registered' }));
    render(<AdminCreateUserPage />);
    fillAll('dup@example.com');
    submit();

    expect(await screen.findByText('Email already registered')).toBeInTheDocument();
    expect(screen.getByLabelText('EMAIL')).toHaveValue('dup@example.com');
    expect(screen.getByLabelText('PASSWORD')).toHaveValue(PASSWORD_16);
  });

  it('DD-ADMIN-001 201 でなく error が無い時は「作成に失敗しました」が出る', async () => {
    fetchMock.mockResolvedValue(jsonResponse(500, {}));
    render(<AdminCreateUserPage />);
    fillAll();
    submit();

    expect(await screen.findByText('作成に失敗しました')).toBeInTheDocument();
  });

  it('DD-ADMIN-001 201 でなく本文が読めない時は「作成に失敗しました」が出る', async () => {
    fetchMock.mockResolvedValue(unreadableResponse(502));
    render(<AdminCreateUserPage />);
    fillAll();
    submit();

    expect(await screen.findByText('作成に失敗しました')).toBeInTheDocument();
  });

  it('DD-ADMIN-001 fetch が例外を投げた時は「ネットワークエラーが発生しました」が出て、ボタンがまた押せる', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    render(<AdminCreateUserPage />);
    fillAll();
    submit();

    expect(await screen.findByText('ネットワークエラーが発生しました')).toBeInTheDocument();
    expect(errorSpy).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '作成' })).toBeEnabled();
  });
});
