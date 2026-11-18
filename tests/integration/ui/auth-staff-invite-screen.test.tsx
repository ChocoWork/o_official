/**
 * @jest-environment jsdom
 */
/**
 * SCR-AUTH-013 /staff/invite: ページと画面の部品を本物で描き、境界（router・fetch）だけを差し替える。
 */
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import StaffInvitePage from '@/app/staff/invite/page';

const replace = jest.fn();
jest.mock('next/navigation', () => ({ useRouter: () => ({ replace }) }));

const TOKEN = 'Q'.repeat(43);
const fetchMock = jest.fn();

beforeEach(() => {
  replace.mockReset();
  fetchMock.mockReset();
  (global as unknown as { fetch: jest.Mock }).fetch = fetchMock;
});

describe('SCR-AUTH-013 招待のリンクの画面', () => {
  test('SCR-AUTH-013 開いただけでは送らず、# を消してから、ボタンで1回だけ送る', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ redirectTo: '/staff/register' }) });
    window.history.replaceState(null, '', `/staff/invite#${TOKEN}`);
    render(<StaffInvitePage />);

    const button = await screen.findByRole('button', { name: '登録を始める' });
    expect(window.location.hash).toBe('');
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.click(button);
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/staff/register'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('SCR-AUTH-013 合言葉が無いリンクでは、ボタンを出さずに説明だけ出す', async () => {
    window.history.replaceState(null, '', '/staff/invite');
    render(<StaffInvitePage />);

    expect(await screen.findByText(/リンクが正しくありません/)).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });
});
