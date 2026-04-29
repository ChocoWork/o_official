import { NextRequest } from 'next/server';

jest.mock('next/server', () => {
  const original = jest.requireActual('next/server');
  return {
    ...original,
    NextResponse: {
      json: jest.fn((body: unknown, init?: { status?: number }) => ({
        body,
        status: init?.status ?? 200,
      })),
    },
  };
});

const mockDelete = jest.fn();
const mockEnforceRateLimit = jest.fn();
const mockLogAudit = jest.fn();

jest.mock('@/lib/supabase/server', () => ({
  createClient: jest.fn().mockResolvedValue({
    from: jest.fn(() => ({
      delete: mockDelete,
    })),
  }),
}));

jest.mock('@/features/auth/middleware/rateLimit', () => ({
  enforceRateLimit: (...args: unknown[]) => mockEnforceRateLimit(...args),
}));

jest.mock('@/lib/audit', () => ({
  logAudit: (...args: unknown[]) => mockLogAudit(...args),
}));

import { DELETE } from '@/app/api/wishlist/[id]/route';

function makeRequest(sessionId = 'sess-abc'): NextRequest {
  const req = new NextRequest('http://localhost/api/wishlist/wish-1', {
    method: 'DELETE',
  });

  Object.defineProperty(req, 'cookies', {
    value: { get: (name: string) => (name === 'session_id' ? { value: sessionId } : undefined) },
  });

  return req;
}

describe('DELETE /api/wishlist/[id]', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockEnforceRateLimit.mockResolvedValue(undefined);
    mockLogAudit.mockResolvedValue(undefined);
  });

  test('UUID でない id は 400 を返す', async () => {
    const res = await DELETE(makeRequest(), {
      params: Promise.resolve({ id: 'not-a-uuid' }),
    });

    expect((res as { status: number }).status).toBe(400);
    expect((res as { body: { error: string } }).body.error).toBe('Invalid wishlist id');
    expect(mockDelete).not.toHaveBeenCalled();
  });

  test('対象が存在しない場合は 404 を返す', async () => {
    const maybeSingle = jest.fn().mockResolvedValue({ data: null, error: null });
    const select = jest.fn().mockReturnValue({ maybeSingle });
    mockDelete.mockReturnValue({
      eq: jest.fn().mockReturnValue({ select }),
    });

    const res = await DELETE(makeRequest(), {
      params: Promise.resolve({ id: '4f3365cd-6c5b-4f7c-8838-6041b0858c5c' }),
    });

    expect((res as { status: number }).status).toBe(404);
  });
});