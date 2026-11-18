import React from 'react';

jest.mock('server-only', () => ({}), { virtual: true });
const mockRedirect = jest.fn((to: string) => {
  throw new Error(`NEXT_REDIRECT:${to}`);
});
jest.mock('next/navigation', () => ({ redirect: (to: string) => mockRedirect(to), useRouter: () => ({ replace: jest.fn() }) }));
const mockAccess = jest.fn();
jest.mock('@/features/auth/staff/staff-register-access', () => ({ readStaffRegisterAccess: () => mockAccess() }));
jest.mock('@/features/auth/staff/components/StaffRegisterScreen', () => ({
  __esModule: true,
  default: (props: { initialRegistered: number }) => <div data-testid="screen">{props.initialRegistered}</div>,
}));

import StaffRegisterPage, { metadata } from '@/app/staff/register/page';

beforeEach(() => {
  mockRedirect.mockClear();
  mockAccess.mockReset();
});

describe('DD-AUTH-080 /staff/register のページ（サーバー）', () => {
  test('DD-AUTH-080 検索に載せない', () => {
    expect(metadata.robots).toEqual({ index: false, follow: false });
  });

  test('DD-AUTH-080 窓が開いたセッションでなければ /login へ送り、画面を作らない', async () => {
    mockAccess.mockResolvedValue({ ok: false });
    await expect(StaffRegisterPage()).rejects.toThrow('NEXT_REDIRECT:/login');
    expect(mockRedirect).toHaveBeenCalledWith('/login');
  });

  test('DD-AUTH-080 窓が開いていれば、認めた鍵の本数を画面に渡す', async () => {
    mockAccess.mockResolvedValue({ ok: true, registered: 1 });
    const element = (await StaffRegisterPage()) as React.ReactElement<{ initialRegistered: number }>;
    expect(element.props.initialRegistered).toBe(1);
    expect(mockRedirect).not.toHaveBeenCalled();
  });
});
