import { NextResponse } from 'next/server';

jest.mock('@/lib/cookie', () => ({
  refreshCookieName: 'refresh',
  accessCookieName: 'access',
  csrfCookieName: 'csrf',
  cookieOptionsForRefresh: (age: number) => ({ httpOnly: true, maxAge: age }),
  cookieOptionsForAccess: (age: number) => ({ httpOnly: true, maxAge: age }),
  cookieOptionsForCsrf: (age: number) => ({ httpOnly: false, maxAge: age }),
}));

jest.mock('@/lib/csrf', () => ({
  generateCsrfToken: () => 'csrf-token-123',
}));

jest.mock('@/lib/hash', () => ({
  tokenHashSha256: (s: string) => `hash:${s}`,
}));

const mockInsert = jest.fn();
jest.mock('@/lib/supabase/server', () => ({
  createServiceRoleClient: () => ({ from: () => ({ insert: mockInsert }) }),
}));

const { persistSessionAndCookies } = require('@/features/auth/services/register');

describe('persistSessionAndCookies', () => {
  beforeEach(() => {
    mockInsert.mockClear();
  });

  it('persists session and sets cookies on success', async () => {
    // mock NextResponse-like object
    const res: any = { cookies: { set: jest.fn() } };

    mockInsert.mockResolvedValue({ data: [{ id: 'row1' }], error: null });

    const session = { refresh_token: 'r1', expires_at: Date.now() + 1000 };
    const user = { id: 'u1', email: 'a@b.c' };

    const result = await persistSessionAndCookies(res as NextResponse, session, user);

    expect(result).toEqual({ ok: true });
    expect(res.cookies.set).toHaveBeenCalled();
    expect(mockInsert).toHaveBeenCalled();
  });

  it('returns error when DB insert fails', async () => {
    const res: any = { cookies: { set: jest.fn() } };

    mockInsert.mockResolvedValue({ data: null, error: { message: 'dup' } });

    const session = { refresh_token: 'r2', expires_at: Date.now() + 1000 };
    const user = { id: 'u2', email: 'x@y.z' };

    const result = await persistSessionAndCookies(res as NextResponse, session, user);

    expect(result.ok).toBe(false);
    expect(res.cookies.set).toHaveBeenCalled();
    expect(mockInsert).toHaveBeenCalled();
  });

  it('returns error when session or user missing', async () => {
    const res: any = { cookies: { set: jest.fn() } };
    const result = await persistSessionAndCookies(res as NextResponse, null, null);
    expect(result.ok).toBe(false);
  });
});

export {};
import { persistSessionAndCookies } from '@/features/auth/services/register';

describe('register service', () => {
  test('exports persistSessionAndCookies', async () => {
    expect(typeof persistSessionAndCookies).toBe('function');
  });
});
