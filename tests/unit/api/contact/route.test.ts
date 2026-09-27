/**
 * POST /api/contact のレート制限
 * 対応 FREQ: FREQ-360（回数制限をメール・セッション単位でも正しく数える）
 */

jest.mock('@/features/auth/middleware/rateLimit', () => ({
  enforceRateLimit: jest.fn(),
}));
jest.mock('@/lib/mail', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('@/lib/supabase/server', () => ({ createServiceRoleClient: jest.fn() }));
jest.mock('@/lib/auth/authenticate', () => ({ authenticateRequest: jest.fn() }));
jest.mock('@/lib/audit', () => ({ logAudit: jest.fn().mockResolvedValue(undefined) }));
jest.mock('@/lib/contact/reply-address', () => ({ buildReplyAddress: jest.fn() }));
jest.mock('@/lib/orders/order-number', () => ({ toOrderNumber: jest.fn() }));
jest.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));

import { enforceRateLimit } from '@/features/auth/middleware/rateLimit';
import { createServiceRoleClient } from '@/lib/supabase/server';

// enforceRateLimit は上限超過時に 429 の Response を返す。ルートはそれをそのまま返すだけなので、
// 形だけ合わせた値で足りる。
const rateLimitedResponse = { status: 429 } as unknown as Response;

function buildContactRequest(email: string): Request {
  return new Request('http://localhost/api/contact', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'テスト太郎',
      email,
      inquiryType: 'other',
      subject: '件名',
      message: '本文',
    }),
  });
}

describe('POST /api/contact - rate limit', () => {
  let POST: (request: Request) => Promise<Response>;

  beforeAll(async () => {
    POST = (await import('@/app/api/contact/route')).POST;
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  // 大文字小文字を変えただけのアドレスは同じ受信箱に届く。別の枠として数えると、
  // 同じ宛先へ確認メールを送らせない、という上限の目的を回避できてしまう。
  test('同じメールアドレスの上限は、大文字小文字を区別せずに数える', async () => {
    (enforceRateLimit as jest.Mock)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(rateLimitedResponse);

    const res = await POST(buildContactRequest('Tester@Example.COM'));

    expect(res.status).toBe(429);
    expect(enforceRateLimit).toHaveBeenLastCalledWith(
      expect.objectContaining({ endpoint: 'contact:submit', subject: 'tester@example.com' }),
    );
    expect(createServiceRoleClient).not.toHaveBeenCalled();
  });
});
