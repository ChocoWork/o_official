jest.mock('server-only', () => ({}), { virtual: true });
const mockCsrf = jest.fn();
const mockRateLimit = jest.fn();
jest.mock('@/lib/csrfMiddleware', () => ({ requireCsrfOrDeny: () => mockCsrf() }));
jest.mock('@/features/auth/middleware/rateLimit', () => ({ enforceRateLimit: (...args: unknown[]) => mockRateLimit(...args) }));
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
// 在庫の履歴の返品の番号の読み出し（order_returns の select(列).in('id', 番号)）
const mockReturnsSelect = jest.fn();
const mockReturnsIn = jest.fn();

jest.mock('@/lib/supabase/server', () => ({
  createServiceRoleClient: jest.fn().mockResolvedValue({ from: mockFrom, rpc: mockRpc }),
}));

const mockAuthorize = jest.fn();
const mockAuthorizeMany = jest.fn();
jest.mock('@/lib/auth/admin-rbac', () => ({
  authorizeAdminPermission: (...args: unknown[]) => mockAuthorize(...args),
  authorizeAdminPermissions: (...args: unknown[]) => mockAuthorizeMany(...args),
}));

/**
 * 実際の認可（src/lib/auth/admin-rbac.ts）と同じ規則の代役: 要るコードを全部持つ時だけ通し、
 * 足りない最初のコードを 403 の permission に入れる。窓口が正しいコードを要求しているかを確かめるのに使う
 * （認可そのものの試験は tests/unit/lib/auth/admin-rbac.test.ts）
 */
function useAcl(granted: readonly string[]) {
  const decide = (required: readonly string[]) => {
    const missing = required.find((code) => !granted.includes(code));
    return missing === undefined
      ? { ok: true, userId: 'admin-1' }
      : { ok: false, response: { status: 403, body: { error: 'Forbidden', permission: missing, role: 'admin' } } };
  };
  mockAuthorize.mockImplementation(async (code: string) => decide([code]));
  mockAuthorizeMany.mockImplementation(async (codes: readonly string[]) => decide(codes));
}

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
  /** 在庫の履歴の返品で動いた行の、返品の番号の材料（order_returns の id・order_id・number） */
  returns?: unknown[];
  returnsError?: DbError | null;
} = {}) {
  const {
    variants = [variantRow(11, 999)],
    variantsError = null,
    states = [{ variant_id: 11, free: 4, paid_allocated: 2, payment_held: 1, on_hand: 7, waiting: 2 }],
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
    returns = [],
    returnsError = null,
  } = options;

  mockReturnsSelect.mockReturnValue({ in: mockReturnsIn });
  mockReturnsIn.mockResolvedValue({ data: returnsError ? null : returns, error: returnsError });

  // 台帳や view は直接読まない。item_variants と、返品の番号を引く order_returns 以外を読もうとすると、from が空の物を返して落ちる
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
    if (table === 'order_returns') {
      return { select: mockReturnsSelect };
    }

    return {};
  });

  mockRpc.mockImplementation(async (name: string) => {
    if (name === 'list_group_g_variant_inventory') {
      return { data: statesError ? null : states, error: statesError };
    }
    if (name === 'list_item_stock_history') {
      return { data: historyError ? null : history, error: historyError };
    }
    if (name === 'list_item_allocation_history') return { data: [], error: null };
    // backfill_item_variants
    return { data: null, error: null };
  });
}

type GetResponse = {
  status: number;
  body: { variants: Array<Record<string, unknown>>; movements: Array<Record<string, unknown>>; allocationEvents: unknown[] };
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

  it('FREQ-540-AC-06: admin.stock.read を要求する（admin.items.read は要求しない）', async () => {
    await GET(makeRequest(), params());

    expect(mockAuthorize).toHaveBeenCalledTimes(1);
    expect(mockAuthorize).toHaveBeenCalledWith('admin.stock.read', expect.anything());
    expect(mockAuthorizeMany).not.toHaveBeenCalled();
  });

  it('FREQ-540-AC-06: admin.items.read/manage だけでは読めず、403 の permission は admin.stock.read。DB には触らない', async () => {
    useAcl(['admin.items.read', 'admin.items.manage']);

    const res = (await GET(makeRequest(), params())) as unknown as { status: number; body: unknown };

    expect(res).toEqual({ status: 403, body: { error: 'Forbidden', permission: 'admin.stock.read', role: 'admin' } });
    expect(mockFrom).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('FREQ-540-AC-06: admin.stock.read だけで読める', async () => {
    useAcl(['admin.stock.read']);

    const res = await callGet();

    expect(res.status).toBe(200);
    expect(res.body.variants).toHaveLength(1);
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
        { variant_id: 12, free: 0, paid_allocated: 1, payment_held: 0, on_hand: 1, waiting: 5 },
        { variant_id: 11, free: 4, paid_allocated: 2, payment_held: 1, on_hand: 7, waiting: 2 },
      ],
    });

    const res = await callGet();

    expect(mockRpc).toHaveBeenCalledWith('list_group_g_variant_inventory', { _variant_ids: [11, 12] });
    expect(res.body.variants).toEqual([
      expect.objectContaining({ id: 11, committedQuantity: 3, onHandQuantity: 7, backorderQuantity: 2 }),
      expect.objectContaining({ id: 12, committedQuantity: 1, onHandQuantity: 1, backorderQuantity: 5 }),
    ]);
  });

  it('reads empty commitment from the inventory snapshot', async () => {
    setupReads({ states: [{ variant_id: 11, free: 4, paid_allocated: 0, payment_held: 0, on_hand: 4, waiting: 0 }] });

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
        returnNumber: null,
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
        returnNumber: null,
      },
    ]);
  });

  it('返金で動いた行は返金の番号を refundId で返す。返金に結び付かない行は null', async () => {
    const refundId = 'e1e1e1e1-1111-4222-8333-444455556666';
    setupReads({
      history: [
        {
          movement_id: 12, variant_id: 11, delta: -1, reason: 'adjustment', note: null, created_at: '2026-10-11T00:00:01Z',
          actor_email: null, order_id: 'a1b2c3d4-1111-4222-8333-444455556666', balance_after: 3, refund_id: refundId,
        },
        {
          movement_id: 11, variant_id: 11, delta: 1, reason: 'refund', note: null, created_at: '2026-10-11T00:00:01Z',
          actor_email: null, order_id: 'a1b2c3d4-1111-4222-8333-444455556666', balance_after: 4, refund_id: refundId,
        },
        {
          movement_id: 5, variant_id: 11, delta: 4, reason: 'restock', note: '入荷', created_at: '2026-09-21T00:00:00Z',
          actor_email: 'admin@example.com', order_id: null, balance_after: 4, refund_id: null,
        },
      ],
    });

    const res = await callGet();

    expect(res.body.movements.map((movement) => [movement.reason, movement.refundId])).toEqual([
      ['adjustment', refundId],
      ['refund', refundId],
      ['restock', null],
    ]);
  });

  it('返品の受け取り（return）と交換の品の確保（exchange）で動いた行は、返品の番号を returnId と returnNumber（{注文番号}-R{n}）で返す。返品に結び付かない行は null', async () => {
    const returnId = 'c1c1c1c1-1111-4222-8333-444455556666';
    setupReads({
      history: [
        {
          movement_id: 14, variant_id: 11, delta: -1, reason: 'exchange', note: null, created_at: '2026-10-12T00:00:01Z',
          actor_email: null, order_id: 'a1b2c3d4-1111-4222-8333-444455556666', balance_after: 2, refund_id: null, return_id: returnId,
        },
        {
          movement_id: 13, variant_id: 11, delta: 1, reason: 'return', note: null, created_at: '2026-10-12T00:00:01Z',
          actor_email: null, order_id: 'a1b2c3d4-1111-4222-8333-444455556666', balance_after: 3, refund_id: null, return_id: returnId,
        },
        {
          movement_id: 5, variant_id: 11, delta: 4, reason: 'restock', note: '入荷', created_at: '2026-09-21T00:00:00Z',
          actor_email: 'admin@example.com', order_id: null, balance_after: 4, refund_id: null, return_id: null,
        },
      ],
      returns: [{ id: returnId, order_id: 'a1b2c3d4-1111-4222-8333-444455556666', number: 2 }],
    });

    const res = await callGet();

    expect(res.body.movements.map((movement) => [movement.reason, movement.returnId, movement.returnNumber])).toEqual([
      ['exchange', returnId, 'ORD-A1B2C3D4-R2'],
      ['return', returnId, 'ORD-A1B2C3D4-R2'],
      ['restock', null, null],
    ]);
    expect(res.body.movements[0]).toMatchObject({ orderNumber: 'ORD-A1B2C3D4', delta: -1, balanceAfter: 2 });
    // 返品の番号は、履歴に出た返品だけを1回で読む（同じ返品は1つにまとめる）
    expect(mockReturnsSelect).toHaveBeenCalledWith('id, order_id, number');
    expect(mockReturnsIn).toHaveBeenCalledTimes(1);
    expect(mockReturnsIn).toHaveBeenCalledWith('id', [returnId]);
  });

  it('返品の番号が読めなければ 500 を返す。ログは名前と code だけで、DB の文は出さない', async () => {
    setupReads({
      history: [{
        movement_id: 13, variant_id: 11, delta: 1, reason: 'return', note: null, created_at: '2026-10-12T00:00:01Z',
        actor_email: null, order_id: 'a1b2c3d4-1111-4222-8333-444455556666', balance_after: 3, refund_id: null,
        return_id: 'c1c1c1c1-1111-4222-8333-444455556666',
      }],
      returnsError: { message: 'MESSAGE-MARKER', details: 'DETAILS-MARKER', hint: 'HINT-MARKER', code: '42501' },
    });
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const res = await callGet();

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'Failed to fetch stock history' });
      expect(consoleError).toHaveBeenCalledWith('Failed to fetch stock history returns:', 7, 'UnknownError', '42501');
      expect(inspect(consoleError.mock.calls, { depth: null })).not.toMatch(/MESSAGE-MARKER|DETAILS-MARKER|HINT-MARKER/);
    } finally {
      consoleError.mockRestore();
    }
  });

  it('バリアントが無い商品は、数も履歴も DB の関数を呼ばずに空で返す', async () => {
    setupReads({ variants: [] });

    const res = await callGet();

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ variants: [], movements: [], allocationEvents: [] });
    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(mockRpc).toHaveBeenCalledWith('backfill_item_variants', { target_item_id: 7 });
  });

  it('台帳の表や、前の受注生産の view は直接読まない', async () => {
    await callGet();

    expect(mockFrom.mock.calls.map(([table]) => table)).toEqual(['item_variants']);
  });

  it('adds allocationEvents from the new reader while retaining both existing arrays', async () => {
    const row = { event_id: 'event', allocation_id: 'allocation', order_id: 'order', order_item_id: 'line', variant_id: 11,
      event_type: 'promote', quantity: 2, operation_id: 'operation', counterpart_allocation_id: null, reverses_event_id: null,
      stock_movement_id: null, reason: null, actor_id: null, created_at: '2026-10-24T00:00:00Z' };
    const previous = mockRpc.getMockImplementation();
    mockRpc.mockImplementation((name: string, args: unknown) => name === 'list_item_allocation_history'
      ? Promise.resolve({ data: [row], error: null }) : previous?.(name,args));
    const res = await callGet();
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['allocationEvents','movements','variants']);
    expect(res.body.allocationEvents).toEqual([{ id: 'event', allocationId: 'allocation', orderId: 'order', orderItemId: 'line',
      variantId: 11, type: 'promote', quantity: 2, operationId: 'operation', counterpartAllocationId: null, reversesEventId: null,
      stockMovementId: null, reason: null, actorId: null, createdAt: row.created_at }]);
    expect(mockRpc).toHaveBeenCalledWith('list_item_allocation_history',{ _item_id: 7, _limit: 50 });
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

const REQUEST_KEY = '11111111-1111-4111-8111-111111111111';
const postBody = { variantId: 11, delta: -1, reason: 'adjustment', requestKey: REQUEST_KEY };
async function post(body: unknown = postBody) {
  return await POST(makeRequest(body), params()) as unknown as { status: number; body: unknown };
}
describe('POST /api/admin/items/[id]/variants', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAuthorize.mockReset();
    mockAuthorizeMany.mockReset().mockResolvedValue({ ok: true, userId: 'admin-1' });
    mockCsrf.mockResolvedValue(undefined);
    mockRateLimit.mockResolvedValue(null);
    mockRpc.mockReset().mockResolvedValue({ data: { movementId: '5', releasedQuantity: 0, allocatedQuantity: 1, replayed: false }, error: null });
  });
  it('uses one RPC, no direct INSERT, the authorized actor and audits the result', async () => {
    expect(await post({ ...postBody, actorId: 'forged' })).toEqual({ status: 201, body: { success: true } });
    expect(mockAuthorizeMany).toHaveBeenCalledWith(['admin.stock.manage', 'admin.stock.read'], expect.anything());
    expect(mockAuthorize).not.toHaveBeenCalled();
    expect(mockCsrf).toHaveBeenCalledTimes(1);
    expect(mockRateLimit).toHaveBeenCalledTimes(2);
    expect(mockRateLimit).toHaveBeenNthCalledWith(2, expect.objectContaining({ subject: 'admin-1' }));
    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(mockRpc).toHaveBeenCalledWith('admin_record_stock_movement', { _item_id: 7, _variant_id: 11, _delta: -1,
      _reason: 'adjustment', _note: null, _actor_id: 'admin-1', _request_key: REQUEST_KEY, _expected_release_quantity: null });
    expect(mockFrom).not.toHaveBeenCalled();
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({ actor_id: 'admin-1', outcome: 'success',
      metadata: expect.objectContaining({ movement_id: '5', released_quantity: 0, allocated_quantity: 1, replayed: false }) }));
  });
  it.each([401,403])('preserves authorization/MFA denial %i before CSRF', async (status) => {
    const response = { status, body: { error: 'Denied' } };
    mockAuthorizeMany.mockResolvedValue({ ok: false, response });
    expect(await post()).toBe(response);
    expect(mockCsrf).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
  });
  it('FREQ-540-AC-06: admin.items.read/manage だけでは書けず、403 の permission は admin.stock.manage。CSRF・制限・RPC には進まない', async () => {
    useAcl(['admin.items.read', 'admin.items.manage']);
    expect(await post()).toEqual({ status: 403, body: { error: 'Forbidden', permission: 'admin.stock.manage', role: 'admin' } });
    expect(mockCsrf).not.toHaveBeenCalled();
    expect(mockRateLimit).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockLogAudit).not.toHaveBeenCalled();
  });
  it('FREQ-540-AC-06: admin.stock.read だけでは書けず、403 の permission は admin.stock.manage', async () => {
    useAcl(['admin.stock.read']);
    expect(await post()).toEqual({ status: 403, body: { error: 'Forbidden', permission: 'admin.stock.manage', role: 'admin' } });
    expect(mockRpc).not.toHaveBeenCalled();
  });
  it('FREQ-540-AC-06: admin.stock.manage だけでも書けず、403 の permission は admin.stock.read', async () => {
    useAcl(['admin.stock.manage']);
    expect(await post()).toEqual({ status: 403, body: { error: 'Forbidden', permission: 'admin.stock.read', role: 'admin' } });
    expect(mockRpc).not.toHaveBeenCalled();
  });
  it('FREQ-540-AC-06: admin.stock.manage と admin.stock.read の両方があれば進み、台帳の RPC を1回呼ぶ', async () => {
    useAcl(['admin.stock.manage', 'admin.stock.read']);
    expect(await post()).toEqual({ status: 201, body: { success: true } });
    expect(mockRpc).toHaveBeenCalledTimes(1);
  });
  it('認可 → CSRF → IP の回数制限 → actor の回数制限 → 検証 → RPC の順は変えない', async () => {
    const order: string[] = [];
    mockAuthorizeMany.mockImplementation(async () => { order.push('authorize'); return { ok: true, userId: 'admin-1' }; });
    mockCsrf.mockImplementation(async () => { order.push('csrf'); });
    mockRateLimit.mockImplementation(async (arg: { subject?: string }) => { order.push(arg.subject ? 'rate:actor' : 'rate:ip'); return null; });
    mockRpc.mockImplementation(async () => { order.push('rpc'); return { data: { movementId: '5', releasedQuantity: 0, allocatedQuantity: 0, replayed: false }, error: null }; });

    expect((await post()).status).toBe(201);
    expect(order).toEqual(['authorize', 'csrf', 'rate:ip', 'rate:actor', 'rpc']);

    order.length = 0;
    expect((await post({ ...postBody, delta: 0 })).status).toBe(400);
    expect(order).toEqual(['authorize', 'csrf', 'rate:ip', 'rate:actor']);
  });
  it('preserves a real CSRF Response and stops before limits', async () => {
    const response = new Response('Denied', { status: 403 });
    mockCsrf.mockResolvedValue(response);
    expect(await post()).toBe(response);
    expect(mockRateLimit).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
  });
  it.each([1,2])('preserves rate-limit response at stage %i', async (stage) => {
    const response = new Response('Limited', { status: 429 });
    if (stage === 2) mockRateLimit.mockResolvedValueOnce(null);
    mockRateLimit.mockResolvedValueOnce(response);
    expect(await post()).toBe(response);
    expect(mockRpc).not.toHaveBeenCalled();
  });
  it.each([{ ...postBody, requestKey: undefined }, { ...postBody, requestKey: 'invalid' },
    { ...postBody, expectedReleaseQuantity: -1 }, { ...postBody, expectedReleaseQuantity: 1.5 },
    { ...postBody, delta: 0 }, { ...postBody, reason: 'purchase' }, { ...postBody, reason: 'exchange' },
    { ...postBody, reason: 'cancel' }, { ...postBody, reason: 'refund' }, { ...postBody, reason: 'return' },
    { ...postBody, reason: 'allocation_release' }])('rejects invalid input before RPC %p', async (body) => {
    expect((await post(body)).status).toBe(400);
    expect(mockRpc).not.toHaveBeenCalled();
  });
  it.each([
    ['GROUP_G_ARGUMENT_INVALID','22023',400,'入力を確かめてください。'],
    ['GROUP_G_FORBIDDEN','42501',403,'在庫を変更する権限がありません。'],
    ['GROUP_G_STOCK_INSUFFICIENT','23514',409,'在庫が足りないため、この数量は引けません。'],
    ['GROUP_G_STOCK_RELEASE_REASON_REQUIRED','22023',400,'割り当てを外す理由を入力してください。'],
    ['GROUP_G_REQUEST_KEY_CONFLICT','23505',409,'同じ要求番号で異なる在庫操作は実行できません。'],
  ])('returns exact business error %s', async (message, code, status, error) => {
    mockRpc.mockResolvedValue({ error: { message, code, details: 'PRIVATE-MARKER' } });
    expect(await post()).toEqual({ status, body: { code: message, error } });
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failure' }));
    expect(JSON.stringify(mockLogAudit.mock.calls)).not.toContain('PRIVATE-MARKER');
  });
  it('returns the recomputed release count; forwards confirmed inputs without replacing the key', async () => {
    mockRpc.mockResolvedValue({ error: { message: 'GROUP_G_STOCK_RELEASE_CONFIRMATION_REQUIRED', code: '55000', details: '{"releasedQuantity":2}' } });
    expect(await post({ ...postBody, expectedReleaseQuantity: 1, note: '棚卸' })).toEqual({ status: 409,
      body: { code: 'GROUP_G_STOCK_RELEASE_CONFIRMATION_REQUIRED', error: '割り当て済みの品を外す必要があります。数量を確認してください。', releasedQuantity: 2 } });
    expect(mockRpc).toHaveBeenCalledWith('admin_record_stock_movement', expect.objectContaining({ _request_key: REQUEST_KEY, _expected_release_quantity: 1, _note: '棚卸' }));
  });
  it('unknown or mismatched DB errors return fixed 500 without raw logs/audit data', async () => {
    mockRpc.mockResolvedValue({ error: { code: '23514', message: 'PRIVATE-MARKER', details: 'PRIVATE-MARKER' } });
    const log = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await post()).toEqual({ status: 500, body: { error: '在庫の記録に失敗しました' } });
      expect(JSON.stringify([log.mock.calls, mockLogAudit.mock.calls])).not.toContain('PRIVATE-MARKER');
    } finally { log.mockRestore(); }
  });
  it('an unexpected throw outside the RPC logs only the error name and code, then returns the fixed 500', async () => {
    mockAuthorizeMany.mockRejectedValue(Object.assign(new TypeError('PRIVATE-MARKER'), { code: 'XX000', details: 'PRIVATE-MARKER' }));
    const log = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await post()).toEqual({ status: 500, body: { error: '在庫の記録に失敗しました' } });
      expect(log).toHaveBeenCalledWith('POST /api/admin/items/:id/variants error:', 'TypeError', 'XX000');
      expect(inspect(log.mock.calls, { depth: null })).not.toContain('PRIVATE-MARKER');
      expect(mockRpc).not.toHaveBeenCalled();
    } finally { log.mockRestore(); }
  });
});
