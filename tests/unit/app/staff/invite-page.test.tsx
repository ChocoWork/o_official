import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import StaffInvitePage, { metadata } from '@/app/staff/invite/page';

const replace = jest.fn();
jest.mock('next/navigation', () => ({ useRouter: () => ({ replace }) }));

const TOKEN = 'A'.repeat(43);
const fetchMock = jest.fn();

function open(hash: string) {
  window.history.replaceState(null, '', `/staff/invite${hash}`);
  return render(<StaffInvitePage />);
}

beforeEach(() => {
  replace.mockReset();
  fetchMock.mockReset();
  (global as unknown as { fetch: jest.Mock }).fetch = fetchMock;
});

describe('/staff/invite 画面', () => {
  test('DD-AUTH-078 検索に載せない', () => {
    expect(metadata.robots).toEqual({ index: false, follow: false });
  });

  test('DD-AUTH-078 # が無いと「リンクが正しくありません」で、ボタンを出さない', async () => {
    open('');
    expect(await screen.findByText(/リンクが正しくありません/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '登録を始める' })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('DD-AUTH-078 形の違う合言葉も「リンクが正しくありません」で、# は消える', async () => {
    open('#short');
    expect(await screen.findByText(/リンクが正しくありません/)).toBeInTheDocument();
    expect(window.location.hash).toBe('');
  });

  test('DD-AUTH-078 読んだ後 location.hash が空になり、開いただけではサーバーに送らない', async () => {
    open(`#${TOKEN}`);
    expect(await screen.findByRole('heading', { name: '店員のパスキーを登録します' })).toBeInTheDocument();
    expect(window.location.hash).toBe('');
    expect(window.location.href).not.toContain(TOKEN);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('DD-AUTH-078 ボタンで合言葉を POST し、成功したら登録の画面へ移る', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ redirectTo: '/staff/register' }) });
    open(`#${TOKEN}`);
    fireEvent.click(await screen.findByRole('button', { name: '登録を始める' }));
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/staff/register'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/auth/staff/invite/start');
    expect(JSON.parse(init.body)).toEqual({ token: TOKEN });
  });

  test('DD-AUTH-078 400 は「このリンクは使えません」で、ボタンを消す', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 400, body: { cancel: jest.fn() } });
    open(`#${TOKEN}`);
    fireEvent.click(await screen.findByRole('button', { name: '登録を始める' }));
    expect(await screen.findByText(/このリンクは使えません/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '登録を始める' })).toBeNull();
    expect(replace).not.toHaveBeenCalled();
  });

  test('DD-AUTH-078 500 は「店長に、もう一度招待を出してもらってください」で、同じ合言葉を繰り返せない', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, body: { cancel: jest.fn() } });
    open(`#${TOKEN}`);
    fireEvent.click(await screen.findByRole('button', { name: '登録を始める' }));
    expect(await screen.findByText(/店長に、もう一度招待を出してもらってください/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '登録を始める' })).toBeNull();
  });

  test('DD-AUTH-078 通信が落ちても同じ文を出す', async () => {
    fetchMock.mockRejectedValue(new Error('net'));
    open(`#${TOKEN}`);
    fireEvent.click(await screen.findByRole('button', { name: '登録を始める' }));
    expect(await screen.findByText(/店長に、もう一度招待を出してもらってください/)).toBeInTheDocument();
  });

  test('DD-AUTH-078 429 は少し待つ文で、ボタンは残る', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 429, body: { cancel: jest.fn() } });
    open(`#${TOKEN}`);
    fireEvent.click(await screen.findByRole('button', { name: '登録を始める' }));
    expect(await screen.findByText(/しばらくしてから/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '登録を始める' })).toBeEnabled();
  });

  test('DD-AUTH-078 503（回数の見張りが使えない時）も 429 と同じ待つ文で、ボタンは残る', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503, body: { cancel: jest.fn() } });
    open(`#${TOKEN}`);
    fireEvent.click(await screen.findByRole('button', { name: '登録を始める' }));
    expect(await screen.findByText(/しばらくしてから/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '登録を始める' })).toBeEnabled();
  });

  test('DD-AUTH-078 説明に、登録は30分以内で、そのあいだ管理画面は使えないと出す', async () => {
    open(`#${TOKEN}`);
    expect(await screen.findByText('登録は30分以内に終えてください。このあいだ、管理画面は使えません。')).toBeInTheDocument();
    expect(screen.getByText('別の端末か、セキュリティキーでの登録をおすすめします。')).toBeInTheDocument();
  });

  test.each(['//evil.example', '/\\evil.example'])('DD-AUTH-078 redirectTo が %s のように別のホストを指す形なら使わない', async (to) => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ redirectTo: to }) });
    open(`#${TOKEN}`);
    fireEvent.click(await screen.findByRole('button', { name: '登録を始める' }));
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/staff/register'));
  });

  test('DD-AUTH-078 429 で応答に body が無くても、待つ文を出す', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 429 });
    open(`#${TOKEN}`);
    fireEvent.click(await screen.findByRole('button', { name: '登録を始める' }));
    expect(await screen.findByText(/しばらくしてから/)).toBeInTheDocument();
  });

  test('DD-AUTH-078 redirectTo が無い・外への道なら、既定の /staff/register へ移る', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => null });
    open(`#${TOKEN}`);
    fireEvent.click(await screen.findByRole('button', { name: '登録を始める' }));
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/staff/register'));
  });

  test('DD-AUTH-078 StrictMode（効果が2回走る）でも、正しいリンクにボタンが出て「正しくありません」は出ない', async () => {
    window.history.replaceState(null, '', `/staff/invite#${TOKEN}`);
    render(
      <React.StrictMode>
        <StaffInvitePage />
      </React.StrictMode>,
    );
    expect(await screen.findByRole('button', { name: '登録を始める' })).toBeInTheDocument();
    expect(screen.queryByText(/リンクが正しくありません/)).toBeNull();
  });

  test('DD-AUTH-078 redirectTo が / で始まらなければ使わない', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ redirectTo: 'https://evil.example' }) });
    open(`#${TOKEN}`);
    fireEvent.click(await screen.findByRole('button', { name: '登録を始める' }));
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/staff/register'));
  });
});
