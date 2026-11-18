/**
 * @jest-environment jsdom
 */
/**
 * SCR-AUTH-016 /admin の「ユーザー」タブの店員の操作: UserSection・3つの部品・送りの部品（postStaffAction）を本物で動かし、
 * 境界（窓口への fetch）だけを差し替える。招待を送った後に一覧が読み直されて「招待中」が出て、取り消すと消えるところまで通しで確かめる。
 */
import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import UserSection from '@/components/UserSection';

const mockFetch = jest.fn();
jest.mock('@/lib/client-fetch', () => ({ clientFetch: (...args: unknown[]) => mockFetch(...args) }));

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const ME = '11111111-1111-4111-8111-111111111111';
const NEW_USER = '22222222-2222-4222-8222-222222222222';

let listed: Array<Record<string, unknown>>;
const posted: string[] = [];

const base = (id: string, email: string, roleValue: string, extra: Record<string, unknown> = {}) => ({
  id, name: `名前 ${email.split('@')[0]}`, email, role: roleValue, roleValue, lastLogin: '-', status: 'アクティブ', ...extra,
});

beforeEach(() => {
  jest.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  posted.length = 0;
  listed = [base(ME, 'me@example.com', 'admin', { approvedPasskeys: 2, invitePending: false })];
  mockFetch.mockReset();
  mockFetch.mockImplementation(async (url: string, init?: { method?: string }) => {
    if (url === '/api/auth/me') return json(200, { authenticated: true, user: { id: ME } });
    if (init?.method === 'POST') {
      posted.push(url);
      if (url === '/api/admin/staff/invites') {
        listed = [...listed, base(NEW_USER, 'new@example.com', 'user', { approvedPasskeys: 0, invitePending: true })];
      }
      if (url.endsWith('/invite/cancel')) {
        listed = listed.map((row) => (row.id === NEW_USER ? { ...row, invitePending: false } : row));
      }
      return json(200, { success: true });
    }
    return json(200, { data: listed });
  });
});

afterEach(() => jest.restoreAllMocks());

describe('SCR-AUTH-016 管理画面のユーザーの店員の操作', () => {
  test('SCR-AUTH-016 招待を送ると一覧に「招待中」が出て、取り消すと消える。自分の行は押せない', async () => {
    const user = userEvent.setup();
    render(<UserSection />);

    const me = (await screen.findByText('me@example.com')).closest('tr') as HTMLElement;
    await waitFor(() => expect(within(me).getByRole('button', { name: 'お客さんに戻す' })).toBeDisabled());
    expect(within(me).getByText('認めた鍵 2本')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '店員を招待' }));
    const dialog = await screen.findByRole('dialog', { name: '店員を招待' });
    await user.click(within(dialog).getByRole('button', { name: '戻る' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: '店員を招待' }));
    const again = await screen.findByRole('dialog', { name: '店員を招待' });
    await user.type(within(again).getByLabelText(/メールアドレス/), 'new@example.com');
    await user.click(within(again).getByRole('button', { name: '招待を送る' }));

    expect(await screen.findByText('new@example.com へ、招待のメールを送りました。')).toBeInTheDocument();
    const invited = (await screen.findByText('new@example.com', { selector: 'p' })).closest('tr') as HTMLElement;
    await user.click(await within(invited).findByRole('button', { name: '招待を取り消す' }));
    expect(await screen.findByText('new@example.com への招待を取り消しました。')).toBeInTheDocument();
    await waitFor(() => expect(within((screen.getByText('new@example.com', { selector: 'p' })).closest('tr') as HTMLElement).queryByText('招待中')).not.toBeInTheDocument());
    expect(posted).toEqual(['/api/admin/staff/invites', `/api/admin/staff/${NEW_USER}/invite/cancel`]);
  });
});
