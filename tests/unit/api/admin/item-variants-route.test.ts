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

import { inspect } from 'util';
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

/** バリアントの行（色・サイズつき）。 */
function variantRow(id: number, stockQuantity: number) {
  return {
    id,
    stock_quantity: stockQuantity,
    is_active: true,
    sku: null,
    item_colors: { name: 'BLACK', hex: '#000000', position: 0 },
    item_sizes: { label: id === 11 ? 'M' : 'L', position: id === 11 ? 1 : 2 },
  };
}

/** PostgREST が返す誤りの形。message・details・hint は DB の文を持つ */
type DbError = { message: string; details?: string; hint?: string; code?: string };

/** item_variants の読み取りと、DB の関数（引き当て・受注生産・在庫の履歴）の答えを組み立てる。 */
function setupReads(options: {
  variants?: unknown[];
  variantsError?: { message: string } | null;
  states?: unknown[];
  statesError?: DbError | null;
  history?: unknown[];
  historyError?: DbError | null;
} = {}) {
  const {
    variants = [variantRow(11, 4)],
    variantsError = null,
    states = [{ variant_id: 11, committed: 3, backorder: 2 }],
    statesError = null,
    history = [
      {
        movement_id: 5,
        variant_id: 11,
        delta: 4,
        reason: 'restock',
        note: '入荷',
        created_at: '2026-09-21T00:00:00Z',
        actor_email: 'admin@example.com',
        order_id: null,
        balance_after: 4,
      },
    ],
    historyError = null,
  } = options;

  // 台帳や view は直接読まない。item_variants 以外を読もうとすると、from が空の物を返して落ちる
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

    return {};
  });

  mockRpc.mockImplementation(async (name: string) => {
    if (name === 'list_variant_stock_states') {
      return { data: statesError ? null : states, error: statesError };
    }
    if (name === 'list_item_stock_history') {
      return { data: historyError ? null : history, error: historyError };
    }
    // backfill_item_variants
    return { data: null, error: null };
  });
}

type GetResponse = {
  status: number;
  body: { variants: Array<Record<string, unknown>>; movements: Array<Record<string, unknown>> };
};

async function callGet(): Promise<GetResponse> {
  return (await GET(makeRequest(), params())) as unknown as GetResponse;
}

describe('GET /api/admin/items/[id]/variants', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAuthorize.mockResolvedValue({ ok: true, userId: 'admin-1' });
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

  it('色・サイズと4つの数を返す。手元の数は、すぐ出せる数に引き当て済みを足した数', async () => {
    const res = await callGet();

    expect(res.status).toBe(200);
    expect(res.body.variants).toEqual([
      {
        id: 11,
        colorName: 'BLACK',
        colorHex: '#000000',
        sizeLabel: 'M',
        sku: null,
        stockQuantity: 4,
        isActive: true,
        committedQuantity: 3,
        onHandQuantity: 7,
        backorderQuantity: 2,
      },
    ]);
  });

  it('バリアントごとに自分の引き当て済み・受注生産を結び付け、番号を全部まとめて DB の関数に渡す', async () => {
    setupReads({
      variants: [variantRow(11, 4), variantRow(12, 0)],
      states: [
        { variant_id: 12, committed: 1, backorder: 5 },
        { variant_id: 11, committed: 3, backorder: 2 },
      ],
    });

    const res = await callGet();

    expect(mockRpc).toHaveBeenCalledWith('list_variant_stock_states', { _variant_ids: [11, 12] });
    expect(res.body.variants).toEqual([
      expect.objectContaining({ id: 11, committedQuantity: 3, onHandQuantity: 7, backorderQuantity: 2 }),
      expect.objectContaining({ id: 12, committedQuantity: 1, onHandQuantity: 1, backorderQuantity: 5 }),
    ]);
  });

  it('引き当ても受注生産も無いバリアントは 0 で返し、手元の数はすぐ出せる数と同じ', async () => {
    setupReads({ states: [] });

    const res = await callGet();

    expect(res.body.variants[0]).toMatchObject({
      stockQuantity: 4,
      committedQuantity: 0,
      onHandQuantity: 4,
      backorderQuantity: 0,
    });
  });

  it('在庫の履歴は DB の関数で、この商品の最新50件を読む', async () => {
    await callGet();

    expect(mockRpc).toHaveBeenCalledWith('list_item_stock_history', { _item_id: 7, _limit: 50 });
  });

  it('履歴は誰が・どの注文で・変わった後の数つきで返し、注文は注文番号の形にする', async () => {
    setupReads({
      history: [
        {
          movement_id: 9,
          variant_id: 11,
          delta: -1,
          reason: 'purchase',
          note: null,
          created_at: '2026-09-22T00:00:00Z',
          actor_email: null,
          order_id: 'a1b2c3d4-1111-4222-8333-444455556666',
          balance_after: 3,
        },
        {
          movement_id: 5,
          variant_id: 11,
          delta: 4,
          reason: 'restock',
          note: '入荷',
          created_at: '2026-09-21T00:00:00Z',
          actor_email: 'admin@example.com',
          order_id: null,
          balance_after: 4,
        },
      ],
    });

    const res = await callGet();

    expect(res.body.movements).toEqual([
      {
        id: 9,
        variantId: 11,
        delta: -1,
        reason: 'purchase',
        note: null,
        createdAt: '2026-09-22T00:00:00Z',
        actorEmail: null,
        orderId: 'a1b2c3d4-1111-4222-8333-444455556666',
        orderNumber: 'ORD-A1B2C3D4',
        balanceAfter: 3,
      },
      {
        id: 5,
        variantId: 11,
        delta: 4,
        reason: 'restock',
        note: '入荷',
        createdAt: '2026-09-21T00:00:00Z',
        actorEmail: 'admin@example.com',
        orderId: null,
        orderNumber: null,
        balanceAfter: 4,
      },
    ]);
  });

  it('バリアントが無い商品は、数も履歴も DB の関数を呼ばずに空で返す', async () => {
    setupReads({ variants: [] });

    const res = await callGet();

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ variants: [], movements: [] });
    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(mockRpc).toHaveBeenCalledWith('backfill_item_variants', { target_item_id: 7 });
  });

  it('台帳の表や、前の受注生産の view は直接読まない', async () => {
    await callGet();

    expect(mockFrom.mock.calls.map(([table]) => table)).toEqual(['item_variants']);
  });

  it('引き当て済み・受注生産の数が読めなければ 500 を返す（0 に見せない）', async () => {
    setupReads({ statesError: { message: 'boom' } });
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

    const res = await callGet();

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to fetch variant stock states' });
    consoleError.mockRestore();
  });

  it('在庫の履歴が読めなければ 500 を返す', async () => {
    setupReads({ historyError: { message: 'boom' } });
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

    const res = await callGet();

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to fetch stock history' });
    consoleError.mockRestore();
  });

  /**
   * PostgREST の誤りは message・details・hint に DB の文（引数や行の値）を持つ。
   * 新しく足した2つの DB の関数の失敗は、ログに名前と code だけを残し、誤りそのものは渡さない。
   */
  it.each([
    ['引き当て済み・受注生産の数', 'Failed to fetch variant stock states:', 'statesError'],
    ['在庫の履歴', 'Failed to fetch stock history:', 'historyError'],
  ] as const)('%sが読めない時のログに、DB の誤りの文（message・details・hint）を出さない', async (_name, logLabel, failing) => {
    const fields = { details: 'DETAILS-MARKER', hint: 'HINT-MARKER', code: '42883' };
    // PostgREST の誤りの2つの形: 素のオブジェクトと、Error を継いだ PostgrestError（今の supabase-js）
    const shapes: Array<[dbError: DbError, expectedName: string]> = [
      [{ message: 'MESSAGE-MARKER', ...fields }, 'UnknownError'],
      [Object.assign(new Error('MESSAGE-MARKER'), { name: 'PostgrestError', ...fields }), 'PostgrestError'],
    ];
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

    try {
      for (const [dbError, expectedName] of shapes) {
        consoleError.mockClear();
        setupReads(failing === 'statesError' ? { statesError: dbError } : { historyError: dbError });

        const res = await callGet();

        expect(res.status).toBe(500);
        expect(consoleError).toHaveBeenCalledWith(logLabel, 7, expectedName, '42883');
        const logged = inspect(consoleError.mock.calls, { depth: null });
        for (const marker of ['MESSAGE-MARKER', 'DETAILS-MARKER', 'HINT-MARKER']) {
          expect(logged).not.toContain(marker);
        }
      }
    } finally {
      consoleError.mockRestore();
    }
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
