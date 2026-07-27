import { NextRequest } from 'next/server';

// NextResponse.json は platform の Response を使うため Jest 環境では動かない。
// ハンドラのロジックだけを走らせたいので単純なオブジェクトへ差し替える。
jest.mock('next/server', () => {
  const original = jest.requireActual('next/server');
  return {
    ...original,
    NextResponse: {
      json: jest.fn((body: any, init?: any) => ({ body, status: init?.status || 200 })),
    },
  };
});

// ルートは @supabase/supabase-js ではなく @/lib/supabase/server 経由でクライアントを作る。
jest.mock('@/lib/supabase/server', () => ({
  createClient: jest.fn(),
}));

jest.mock('@/lib/audit', () => ({
  logAudit: jest.fn().mockResolvedValue(undefined),
}));

// PATCH は IP 単位とセッション単位でレート制限をかける。
// 制限に掛かっていない場合は undefined を返す契約。
jest.mock('@/features/auth/middleware/rateLimit', () => ({
  enforceRateLimit: jest.fn().mockResolvedValue(undefined),
}));

const { createClient } = require('@/lib/supabase/server');
const { enforceRateLimit } = require('@/features/auth/middleware/rateLimit');

function makeRequest(json: () => Promise<unknown>, sessionId: string | null = 'sess') {
  return {
    cookies: { get: jest.fn().mockReturnValue(sessionId ? { value: sessionId } : undefined) },
    headers: { get: jest.fn().mockReturnValue(null) },
    json,
  } as unknown as NextRequest;
}

describe('cart PATCH route', () => {
  const { PATCH } = require('@/app/api/cart/[id]/route');

  beforeEach(() => {
    jest.clearAllMocks();
    enforceRateLimit.mockResolvedValue(undefined);
    createClient.mockResolvedValue({ rpc: jest.fn().mockResolvedValue({ data: null, error: null }) });
  });

  it('セッションが無ければ400を返す', async () => {
    const req = makeRequest(async () => ({ quantity: 1 }), null);

    const res = await PATCH(req, { params: Promise.resolve({ id: '1' }) });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'Session not found' });
  });

  it('quantity が無ければ400を返す', async () => {
    const req = makeRequest(async () => ({}));

    const res = await PATCH(req, { params: Promise.resolve({ id: '1' }) });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'Invalid request body' });
  });

  it('JSON として壊れたボディでも400を返す', async () => {
    const req = makeRequest(async () => {
      throw new SyntaxError('Unexpected end of JSON input');
    });

    const res = await PATCH(req, { params: Promise.resolve({ id: '1' }) });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'Invalid request body' });
  });

  it('quantity が 0 以下なら400を返す', async () => {
    const req = makeRequest(async () => ({ quantity: 0 }));

    const res = await PATCH(req, { params: Promise.resolve({ id: '1' }) });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'Invalid request body' });
  });

  it('レート制限に掛かった場合はその応答をそのまま返す', async () => {
    const limited = { body: { error: 'Too many requests' }, status: 429 };
    enforceRateLimit.mockResolvedValueOnce(limited);

    const req = makeRequest(async () => ({ quantity: 1 }));
    const res = await PATCH(req, { params: Promise.resolve({ id: '1' }) });

    expect(res).toBe(limited);
  });

  it('IP 単位とセッション単位の両方でレート制限を掛ける', async () => {
    const req = makeRequest(async () => ({ quantity: 1 }));

    await PATCH(req, { params: Promise.resolve({ id: '1' }) });

    expect(enforceRateLimit).toHaveBeenCalledTimes(2);
    expect(enforceRateLimit).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ endpoint: 'cart:update', limit: 120 }),
    );
    expect(enforceRateLimit).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ endpoint: 'cart:update', limit: 60, subject: 'sess' }),
    );
  });
});
