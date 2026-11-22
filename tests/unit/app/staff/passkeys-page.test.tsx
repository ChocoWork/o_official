import React from 'react';

/**
 * DD-AUTH-082 /admin/passkeys のページ（サーバー）。入口の確かめの結果で、送る・出す画面を決める。
 */
jest.mock('server-only', () => ({}), { virtual: true });
const mockRedirect = jest.fn((to: string) => {
  throw new Error(`NEXT_REDIRECT:${to}`);
});
jest.mock('next/navigation', () => ({ redirect: (to: string) => mockRedirect(to), useRouter: () => ({ replace: jest.fn() }) }));
const mockGuard = jest.fn();
jest.mock('@/lib/auth/staff-passkey-page-guard', () => ({ requireStaffPasskeyPage: () => mockGuard() }));
jest.mock('@/features/auth/staff/components/StaffPasskeyManager', () => ({ __esModule: true, default: () => <div data-testid="manager" /> }));
jest.mock('@/features/auth/staff/components/StaffOneMoreKey', () => ({ __esModule: true, default: () => <div data-testid="one-more" /> }));

import StaffPasskeysPage, { metadata } from '@/app/admin/passkeys/page';
import StaffOneMoreKey from '@/features/auth/staff/components/StaffOneMoreKey';
import StaffPasskeyManager from '@/features/auth/staff/components/StaffPasskeyManager';

const search = (more?: string) => Promise.resolve(more === undefined ? {} : { more });

/** 返った要素が、どちらの画面かを返す（管理の画面は main に包まれる）。 */
function screenOf(element: unknown): unknown {
  const node = element as React.ReactElement<{ children?: React.ReactElement }>;
  return node.type === 'main' ? node.props.children!.type : node.type;
}

beforeEach(() => {
  mockRedirect.mockClear();
  mockGuard.mockReset();
});

describe('DD-AUTH-082 /admin/passkeys のページ（サーバー）', () => {
  test('DD-AUTH-082 検索に載せない', () => {
    expect(metadata.robots).toEqual({ index: false, follow: false });
  });

  test('DD-AUTH-082 入口が外れたら、その行き先（/login ...）へ送る。この画面へは送り返さない', async () => {
    mockGuard.mockResolvedValue({ ok: false, redirectTo: '/login?reason=idle' });
    await expect(StaffPasskeysPage({ searchParams: search('1') })).rejects.toThrow('NEXT_REDIRECT:/login?reason=idle');
    expect(mockRedirect).toHaveBeenCalledTimes(1);
    expect(mockRedirect.mock.calls[0][0]).not.toContain('/admin/passkeys');
  });

  test('DD-AUTH-082 確かめが読めない時は、送らずに「しばらくしてからお試しください。」を出す', async () => {
    mockGuard.mockResolvedValue({ ok: false, unavailable: true });
    const element = await StaffPasskeysPage({ searchParams: search() });
    expect(mockRedirect).not.toHaveBeenCalled();
    expect(JSON.stringify(element)).toContain('しばらくしてからお試しください。');
  });

  test('DD-AUTH-082 認めた鍵が1本で ?more=1 なら「もう1本」の画面', async () => {
    mockGuard.mockResolvedValue({ ok: true, userId: 'u', approvedCount: 1 });
    const element = await StaffPasskeysPage({ searchParams: search('1') });
    expect(mockRedirect).not.toHaveBeenCalled();
    expect(screenOf(element)).toBe(StaffOneMoreKey);
  });

  test('DD-AUTH-082 認めた鍵が1本でも ?more=1 が無ければ管理の画面（1本の店員も入れる）', async () => {
    mockGuard.mockResolvedValue({ ok: true, userId: 'u', approvedCount: 1 });
    expect(screenOf(await StaffPasskeysPage({ searchParams: search() }))).toBe(StaffPasskeyManager);
  });

  test('DD-AUTH-082 認めた鍵が2本なら ?more=1 でも管理の画面', async () => {
    mockGuard.mockResolvedValue({ ok: true, userId: 'u', approvedCount: 2 });
    expect(screenOf(await StaffPasskeysPage({ searchParams: search('1') }))).toBe(StaffPasskeyManager);
  });
});
