import { NextRequest } from 'next/server';

/**
 * POST /api/checkout/update-shipping の書き込み順の保証（FREQ-365、レビュー指摘⑤）。
 *
 * 配送先は3経路から書き換わるため、無条件の上書きだと遅れて届いた古い内容が新しい内容を
 * 消してしまう（lost update）。クライアントが見た版と一致するときだけ書き込む。
 */

jest.mock('next/server', () => {
  const original = jest.requireActual('next/server');
  return {
    ...original,
    NextResponse: {
      json: jest.fn((body: unknown, init?: { status?: number }) => ({
        body,
        status: init?.status ?? 200,
        cookies: { set: jest.fn() },
        headers: { set: jest.fn() },
      })),
    },
  };
});

type RecordedCall = { method: string; args: unknown[] };

let recorded: RecordedCall[] = [];
let updateResult: { data: unknown; error: unknown } = { data: null, error: null };
let currentDraftResult: { data: unknown; error: unknown } = { data: null, error: null };

function makeChain(terminal: () => { data: unknown; error: unknown }) {
  const chain: Record<string, unknown> = {};
  for (const method of ['eq', 'neq', 'select']) {
    chain[method] = (...args: unknown[]) => {
      recorded.push({ method, args });
      return chain;
    };
  }
  chain.maybeSingle = () => Promise.resolve(terminal());
  return chain;
}

const mockFrom = jest.fn((table: string) => ({
  update: (payload: unknown) => {
    recorded.push({ method: 'update', args: [table, payload] });
    return makeChain(() => updateResult);
  },
  select: (columns: unknown) => {
    recorded.push({ method: 'selectCurrent', args: [table, columns] });
    return makeChain(() => currentDraftResult);
  },
}));

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn().mockReturnValue({ from: (table: string) => mockFrom(table) }),
}));

const mockEnforceRateLimit = jest.fn();
jest.mock('@/features/auth/middleware/rateLimit', () => ({
  enforceRateLimit: (...args: unknown[]) => mockEnforceRateLimit(...args),
}));

const mockRequireCsrfOrDeny = jest.fn();
jest.mock('@/lib/csrfMiddleware', () => ({
  requireCsrfOrDeny: () => mockRequireCsrfOrDeny(),
}));

const mockLogAudit = jest.fn().mockResolvedValue(undefined);
jest.mock('@/lib/audit', () => ({
  logAudit: (...args: unknown[]) => mockLogAudit(...args),
}));

import { POST } from '@/app/api/checkout/update-shipping/route';

const SHIPPING = {
  email: 'buyer@example.com',
  fullName: '山田太郎',
  postalCode: '1000001',
  prefecture: '東京都',
  city: '千代田区',
  address: '1-1-1',
  building: '',
  phone: '0312345678',
};

function makeRequest(body: Record<string, unknown>, sessionId: string | null = 'sess-abc'): NextRequest {
  const req = new NextRequest('http://localhost/api/checkout/update-shipping', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  Object.defineProperty(req, 'cookies', {
    value: {
      get: (name: string) => (name === 'session_id' && sessionId ? { value: sessionId } : undefined),
    },
  });
  return req;
}

function findCall(method: string, index = 0): RecordedCall | undefined {
  return recorded.filter((call) => call.method === method)[index];
}

describe('POST /api/checkout/update-shipping', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    recorded = [];
    updateResult = { data: { shipping_revision: 4 }, error: null };
    currentDraftResult = { data: null, error: null };
    mockEnforceRateLimit.mockResolvedValue(undefined);
    mockRequireCsrfOrDeny.mockResolvedValue({});
  });

  it('見た版と一致するときだけ書き込み、次の版番号を返す', async () => {
    const response = (await POST(
      makeRequest({ checkoutSessionId: 'cs_test_1', shipping: SHIPPING, expectedRevision: 3 })
    )) as unknown as { status: number; body: Record<string, unknown> };

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true, revision: 4 });

    const update = findCall('update');
    expect(update?.args[0]).toBe('checkout_drafts');
    expect(update?.args[1]).toMatchObject({ shipping_revision: 4 });

    // 絞り込み: checkout_session_id / session_id / 版番号、かつ確定済みは除く
    const eqArgs = recorded.filter((call) => call.method === 'eq').map((call) => call.args);
    expect(eqArgs).toEqual(
      expect.arrayContaining([
        ['checkout_session_id', 'cs_test_1'],
        ['session_id', 'sess-abc'],
        ['shipping_revision', 3],
      ])
    );
    expect(findCall('neq')?.args).toEqual(['status', 'completed']);
  });

  it('版が古くて1件も更新できないときは 409 と現在の版番号を返す', async () => {
    updateResult = { data: null, error: null };
    currentDraftResult = { data: { shipping_revision: 7 }, error: null };

    const response = (await POST(
      makeRequest({ checkoutSessionId: 'cs_test_1', shipping: SHIPPING, expectedRevision: 3 })
    )) as unknown as { status: number; body: Record<string, unknown> };

    expect(response.status).toBe(409);
    expect(response.body).toEqual({ error: 'stale_shipping_revision', revision: 7 });
  });

  it('draft が見つからないときは 404 を返す', async () => {
    updateResult = { data: null, error: null };
    currentDraftResult = { data: null, error: null };

    const response = (await POST(
      makeRequest({ checkoutSessionId: 'cs_test_1', shipping: SHIPPING, expectedRevision: 3 })
    )) as unknown as { status: number; body: Record<string, unknown> };

    expect(response.status).toBe(404);
  });

  // RFC 6585: 条件付きでないと lost update が起きる更新は 428 で条件付きの再送を求め、
  // どう再送すればよいかを応答に含める。古いタブが残っている場合に起きる。
  it('版番号が無い要求は 428 で拒否し、再読み込みを促す', async () => {
    const response = (await POST(
      makeRequest({ checkoutSessionId: 'cs_test_1', shipping: SHIPPING })
    )) as unknown as { status: number; body: Record<string, unknown> };

    expect(response.status).toBe(428);
    expect(response.body).toEqual({
      error: 'shipping_revision_required',
      message: expect.stringContaining('再読み込み'),
    });
    expect(findCall('update')).toBeUndefined();
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'checkout.shipping.update', outcome: 'failure' })
    );
  });

  it('版番号が負・整数でない要求は 400 で拒否する', async () => {
    for (const expectedRevision of [-1, 1.5, 'abc']) {
      recorded = [];
      const response = (await POST(
        makeRequest({ checkoutSessionId: 'cs_test_1', shipping: SHIPPING, expectedRevision })
      )) as unknown as { status: number };

      expect(response.status).toBe(400);
      expect(findCall('update')).toBeUndefined();
    }
  });

  it('書き込み失敗（DB エラー）は 500 を返し監査ログに残す', async () => {
    updateResult = { data: null, error: { message: 'boom' } };

    const response = (await POST(
      makeRequest({ checkoutSessionId: 'cs_test_1', shipping: SHIPPING, expectedRevision: 3 })
    )) as unknown as { status: number };

    expect(response.status).toBe(500);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'checkout.shipping.update', outcome: 'error' })
    );
  });
});
