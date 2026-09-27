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

const mockFrom = jest.fn();
const mockRpc = jest.fn();

jest.mock('@/lib/supabase/server', () => ({
  createServiceRoleClient: jest.fn().mockResolvedValue({ from: mockFrom, rpc: mockRpc }),
}));

const mockAuthorize = jest.fn();
jest.mock('@/lib/auth/admin-rbac', () => ({
  authorizeAdminPermission: (...args: unknown[]) => mockAuthorize(...args),
}));

const mockLogAudit = jest.fn().mockResolvedValue(undefined);
jest.mock('@/lib/audit', () => ({
  logAudit: (...args: unknown[]) => mockLogAudit(...args),
}));

import { GET, POST } from '@/app/api/admin/items/[id]/variants/route';

const ITEM_ID = '7';

function params() {
  return { params: Promise.resolve({ id: ITEM_ID }) };
}

function makeRequest(body?: unknown): Request {
  return new Request('http://localhost/api/admin/items/7/variants', {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

/** item_variants / stock_movements / variant_backorder_summary の読み取りを組み立てる。 */
function setupReads(options: {
  variants?: unknown[];
  variantsError?: { message: string } | null;
  movements?: unknown[];
  backorders?: unknown[];
} = {}) {
  const {
    variants = [
      {
        id: 11,
        stock_quantity: 4,
        is_active: true,
        sku: null,
        item_colors: { name: 'BLACK', hex: '#000000', position: 0 },
        item_sizes: { label: 'M', position: 1 },
      },
    ],
    variantsError = null,
    movements = [
      { id: 5, variant_id: 11, delta: 4, reason: 'restock', note: '入荷', created_at: '2026-09-21T00:00:00Z' },
    ],
    backorders = [{ variant_id: 11, backorder_quantity: 2 }],
  } = options;

  mockFrom.mockImplementation((table: string) => {
    if (table === 'item_variants') {
      return {
        select: jest.fn().mockReturnValue({
          eq: jest.fn().mockReturnValue({
            order: jest.fn().mockResolvedValue({ data: variants, error: variantsError }),
          }),
        }),
      };
    }

    if (table === 'stock_movements') {
      return {
        select: jest.fn().mockReturnValue({
          in: jest.fn().mockReturnValue({
            order: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue({ data: movements, error: null }),
            }),
          }),
        }),
        insert: jest.fn().mockResolvedValue({ error: null }),
      };
    }

    if (table === 'variant_backorder_summary') {
      return {
        select: jest.fn().mockReturnValue({
          in: jest.fn().mockResolvedValue({ data: backorders, error: null }),
        }),
      };
    }

    return {};
  });
}

describe('GET /api/admin/items/[id]/variants', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAuthorize.mockResolvedValue({ ok: true, userId: 'admin-1' });
    mockRpc.mockResolvedValue({ error: null });
    setupReads();
  });

  it('admin.items.read を要求する', async () => {
    await GET(makeRequest(), params());

    expect(mockAuthorize).toHaveBeenCalledWith('admin.items.read', expect.anything());
  });

  it('権限が無ければ認可側の応答をそのまま返す', async () => {
    mockAuthorize.mockResolvedValue({ ok: false, response: { status: 403, body: { error: 'Forbidden' } } });

    const res = (await GET(makeRequest(), params())) as unknown as { status: number };

    expect(res.status).toBe(403);
    expect(mockFrom).not.toHaveBeenCalled();
  });

  /**
   * 商品の色・サイズはバリアントとは別のテーブルにある。読む前にそろえないと、
   * 管理画面で色を足した直後に在庫を入れる先が無い（FREQ-399）。
   */
  it('読む前にバリアントをそろえる', async () => {
    await GET(makeRequest(), params());

    expect(mockRpc).toHaveBeenCalledWith('backfill_item_variants', { target_item_id: 7 });
  });

  it('色・サイズ・在庫・受注生産の受注数を返す', async () => {
    const res = (await GET(makeRequest(), params())) as unknown as {
      status: number;
      body: { variants: Array<Record<string, unknown>>; movements: unknown[] };
    };

    expect(res.status).toBe(200);
    expect(res.body.variants).toEqual([
      expect.objectContaining({
        id: 11,
        colorName: 'BLACK',
        colorHex: '#000000',
        sizeLabel: 'M',
        stockQuantity: 4,
        isActive: true,
        backorderQuantity: 2,
      }),
    ]);
    expect(res.body.movements).toHaveLength(1);
  });

  it('受注生産の受注が無いバリアントは 0 で返す', async () => {
    setupReads({ backorders: [] });

    const res = (await GET(makeRequest(), params())) as unknown as {
      body: { variants: Array<{ backorderQuantity: number }> };
    };

    expect(res.body.variants[0].backorderQuantity).toBe(0);
  });

  it('バリアントが引けなければ 500 を返す', async () => {
    setupReads({ variantsError: { message: 'boom' } });

    const res = (await GET(makeRequest(), params())) as unknown as { status: number };

    expect(res.status).toBe(500);
  });

  it('商品 id が数値でなければ 400 を返す', async () => {
    const res = (await GET(makeRequest(), { params: Promise.resolve({ id: 'abc' }) })) as unknown as {
      status: number;
    };

    expect(res.status).toBe(400);
    expect(mockRpc).not.toHaveBeenCalled();
  });
});

describe('POST /api/admin/items/[id]/variants', () => {
  let insertMock: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    mockAuthorize.mockResolvedValue({ ok: true, userId: 'admin-1' });
    mockRpc.mockResolvedValue({ error: null });
    insertMock = jest.fn().mockResolvedValue({ error: null });

    mockFrom.mockImplementation((table: string) => {
      if (table === 'item_variants') {
        return {
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              eq: jest.fn().mockReturnValue({
                maybeSingle: jest.fn().mockResolvedValue({ data: { id: 11 }, error: null }),
              }),
            }),
          }),
        };
      }
      if (table === 'stock_movements') {
        return { insert: insertMock };
      }
      return {};
    });
  });

  it('admin.items.manage を要求する', async () => {
    await POST(makeRequest({ variantId: 11, delta: 3, reason: 'restock' }), params());

    expect(mockAuthorize).toHaveBeenCalledWith('admin.items.manage', expect.anything());
  });

  it('台帳へ追記し、実行者を残す', async () => {
    const res = (await POST(
      makeRequest({ variantId: 11, delta: 3, reason: 'restock', note: '入荷' }),
      params(),
    )) as unknown as { status: number };

    expect(res.status).toBe(201);
    expect(insertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        variant_id: 11,
        delta: 3,
        reason: 'restock',
        note: '入荷',
        created_by: 'admin-1',
      }),
    );
  });

  it('監査ログに残す', async () => {
    await POST(makeRequest({ variantId: 11, delta: -1, reason: 'adjustment' }), params());

    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'admin.items.stock.move',
        actor_id: 'admin-1',
        outcome: 'success',
      }),
    );
  });

  /**
   * purchase / cancel / refund は注文の処理が書く。管理画面から打てると台帳の意味が壊れる。
   */
  it.each([['purchase'], ['cancel'], ['refund']])('%s は管理画面から打てない', async (reason) => {
    const res = (await POST(makeRequest({ variantId: 11, delta: 1, reason }), params())) as unknown as {
      status: number;
    };

    expect(res.status).toBe(400);
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('増減 0 は受け付けない', async () => {
    const res = (await POST(
      makeRequest({ variantId: 11, delta: 0, reason: 'adjustment' }),
      params(),
    )) as unknown as { status: number };

    expect(res.status).toBe(400);
    expect(insertMock).not.toHaveBeenCalled();
  });

  /** 別の商品のバリアントに在庫を入れられないこと（BOLA 対策）。 */
  it('その商品に属さないバリアントは 404 を返す', async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === 'item_variants') {
        return {
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              eq: jest.fn().mockReturnValue({
                maybeSingle: jest.fn().mockResolvedValue({ data: null, error: null }),
              }),
            }),
          }),
        };
      }
      return { insert: insertMock };
    });

    const res = (await POST(
      makeRequest({ variantId: 99, delta: 1, reason: 'restock' }),
      params(),
    )) as unknown as { status: number };

    expect(res.status).toBe(404);
    expect(insertMock).not.toHaveBeenCalled();
  });

  /** item_variants.stock_quantity >= 0 の CHECK に当たったときは、理由の分かる応答にする。 */
  it('在庫が足りない引き落としは 409 で断る', async () => {
    insertMock.mockResolvedValue({
      error: { code: '23514', message: 'violates check constraint "item_variants_stock_quantity_check"' },
    });

    const res = (await POST(
      makeRequest({ variantId: 11, delta: -99, reason: 'adjustment' }),
      params(),
    )) as unknown as { status: number; body: { error: string } };

    expect(res.status).toBe(409);
    expect(res.body.error).toContain('在庫');
  });

  it('台帳の追記が失敗したら 500 を返し、監査ログに残す', async () => {
    insertMock.mockResolvedValue({ error: { code: 'XX000', message: 'boom' } });

    const res = (await POST(
      makeRequest({ variantId: 11, delta: 1, reason: 'restock' }),
      params(),
    )) as unknown as { status: number };

    expect(res.status).toBe(500);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'admin.items.stock.move', outcome: 'error' }),
    );
  });
});
