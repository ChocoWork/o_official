jest.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, body }),
  },
}));

jest.mock('@/lib/auth/admin-rbac', () => ({
  authorizeAdminPermission: jest.fn().mockResolvedValue({ ok: true, userId: 'admin-1', role: 'admin' }),
}));

const mockOrder = jest.fn();
const mockUpdateEq = jest.fn();
const mockDeleteEq = jest.fn();
const mockClient = {
  from: () => ({
    select: () => ({ order: mockOrder }),
    update: () => ({ eq: mockUpdateEq }),
    delete: () => ({ eq: mockDeleteEq }),
  }),
};
jest.mock('@/lib/supabase/server', () => ({
  createServiceRoleClient: jest.fn(async () => mockClient),
}));

const mockStripe = { name: 'stripe' };
const mockGetStripeServerClient = jest.fn();
jest.mock('@/lib/stripe/server', () => ({
  getStripeServerClient: () => mockGetStripeServerClient(),
}));

const mockFetchBlockers = jest.fn();
const mockExpireForItem = jest.fn();
jest.mock('@/lib/items/item-checkout-guards', () => ({
  ...jest.requireActual('@/lib/items/item-checkout-guards'),
  fetchItemDeleteBlockers: (...args: unknown[]) => mockFetchBlockers(...args),
  expireOpenCheckoutsForItem: (...args: unknown[]) => mockExpireForItem(...args),
}));

jest.mock('@/lib/storage/item-images', () => ({
  signItemImageFields: jest.fn(async (_client: unknown, item: unknown) => item),
}));

import { GET as listItems, POST } from '@/app/api/admin/items/route';
import { DELETE, PATCH, PUT } from '@/app/api/admin/items/[id]/route';

type RouteResponse = { status: number; body: Record<string, unknown> };
const CONTEXT = { params: Promise.resolve({ id: '7' }) };
const NO_BLOCKERS = { hasOrders: false, hasStockMovements: false, hasOpenCheckouts: false };

function list() {
  return listItems(new Request('http://localhost/api/admin/items')) as unknown as Promise<RouteResponse>;
}

function patch(status: 'private' | 'published') {
  return PATCH(
    new Request('http://localhost/api/admin/items/7', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    }),
    CONTEXT,
  ) as unknown as Promise<RouteResponse>;
}

function put(status: 'private' | 'published') {
  const formData = new FormData();
  formData.set('name', 'シルクブラウス');
  formData.set('description', '絹のブラウス');
  formData.set('price', '28000');
  formData.set('category', 'TOPS');
  formData.set('status', status);
  formData.set('sizes', JSON.stringify(['M']));
  formData.set('colors', JSON.stringify([{ name: 'BLACK', hex: '#000000' }]));
  return PUT({ formData: async () => formData } as unknown as Request, CONTEXT) as unknown as Promise<RouteResponse>;
}

function remove() {
  return DELETE(new Request('http://localhost/api/admin/items/7', { method: 'DELETE' }), CONTEXT) as unknown as Promise<RouteResponse>;
}

// 商品の変更（非公開・削除）が済んだあとに決済を失効させる3つの経路
const EXPIRING_FLOWS: Array<[string, () => Promise<RouteResponse>]> = [
  ['PATCH で非公開にしたとき', () => patch('private')],
  ['PUT で非公開にしたとき', () => put('private')],
  ['DELETE で削除したとき', () => remove()],
];

describe('管理画面の商品 API（①・R-44）', () => {
  let consoleError: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    mockOrder.mockReset();
    mockFetchBlockers.mockReset();
    mockGetStripeServerClient.mockReset().mockReturnValue(mockStripe);
    mockUpdateEq.mockResolvedValue({ error: null });
    mockDeleteEq.mockResolvedValue({ error: null });
    mockExpireForItem.mockResolvedValue({ expired: 1, failed: 0 });
    consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleError.mockRestore();
  });

  describe.each(['POST', 'PUT'])('%s の組み合わせの入力検証', (method) => {
    test.each(['colors', 'sizes'])('%s の名前の重なりは 400 で断り、保存しない', async (field) => {
      const formData = new FormData();
      for (const [key, value] of Object.entries({ name: 'シャツ', description: '説明', price: '5000', category: 'TOPS', status: 'published' })) {
        formData.set(key, value);
      }
      formData.set('colors', JSON.stringify(field === 'colors'
        ? [{ name: ' BLACK ', hex: '#000000' }, { name: 'BLACK', hex: '#111111' }]
        : [{ name: 'BLACK', hex: '#000000' }]));
      formData.set('sizes', JSON.stringify(field === 'sizes' ? ['M', ' M '] : ['M']));
      const request = { formData: async () => formData } as unknown as Request;
      const response = (await (method === 'POST' ? POST(request) : PUT(request, CONTEXT))) as unknown as RouteResponse;
      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({ error: 'Invalid request', details: { fieldErrors: { [field]: expect.any(Array) } } });
      expect(mockUpdateEq).not.toHaveBeenCalled();
      expect(consoleError).not.toHaveBeenCalled();
    });
  });

  it('非公開にしたら、その商品を含む開いている決済を失効させる', async () => {
    expect((await patch('private')).status).toBe(200);
    expect(mockExpireForItem).toHaveBeenCalledWith({ client: mockClient, stripe: mockStripe, itemId: 7 });
  });

  it('公開にしたときは決済に触らない', async () => {
    await patch('published');

    expect(mockExpireForItem).not.toHaveBeenCalled();
  });

  it('PUT で公開のまま更新したときも決済に触らない', async () => {
    expect((await put('published')).status).toBe(200);

    expect(mockExpireForItem).not.toHaveBeenCalled();
  });

  it('注文・在庫の記録・決済中のある商品は削除せず、理由付きの 409 で非公開を促す', async () => {
    mockFetchBlockers.mockResolvedValue(new Map([[7, { hasOrders: true, hasStockMovements: true, hasOpenCheckouts: false }]]));

    const res = await remove();

    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: 'この商品は削除できません（注文がある・在庫の記録がある）。非公開にすると、お客様の画面から見えなくなります。',
      reasons: ['注文がある', '在庫の記録がある'],
    });
    expect(mockDeleteEq).not.toHaveBeenCalled();
    expect(mockExpireForItem).not.toHaveBeenCalled();
  });

  it('理由の無い商品は削除する', async () => {
    mockFetchBlockers.mockResolvedValue(new Map([[7, NO_BLOCKERS]]));

    expect((await remove()).status).toBe(200);
    expect(mockDeleteEq).toHaveBeenCalledWith('id', 7);
  });

  it('削除できたあとで、その商品を含む開いている決済を失効させる', async () => {
    mockFetchBlockers.mockResolvedValue(new Map([[7, NO_BLOCKERS]]));

    expect((await remove()).status).toBe(200);

    expect(mockExpireForItem).toHaveBeenCalledWith({ client: mockClient, stripe: mockStripe, itemId: 7 });
    expect(mockDeleteEq.mock.invocationCallOrder[0]).toBeLessThan(mockExpireForItem.mock.invocationCallOrder[0]);
  });

  it('確かめた後に記録が増えて外部キーで断られたら、汎用の500ではなく 409 を返す', async () => {
    mockFetchBlockers.mockResolvedValue(new Map([[7, NO_BLOCKERS]]));
    mockDeleteEq.mockResolvedValue({ error: { code: '23503', message: 'foreign key violation' } });

    const res = await remove();

    expect(res.status).toBe(409);
    expect(res.body.error).toContain('非公開');
    expect(mockExpireForItem).not.toHaveBeenCalled();
  });

  it('外部キー以外の理由で削除できなかったら 500 を返し、決済には触らない', async () => {
    mockFetchBlockers.mockResolvedValue(new Map([[7, NO_BLOCKERS]]));
    mockDeleteEq.mockResolvedValue({ error: { code: 'XX000', message: 'boom' } });

    const res = await remove();

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to delete item' });
    expect(mockExpireForItem).not.toHaveBeenCalled();
  });

  it('削除できない理由を読めなかったら、削除せずに 500 を返す（安全側に倒す）', async () => {
    mockFetchBlockers.mockRejectedValue(new Error('rpc down'));

    const res = await remove();

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });
    expect(mockDeleteEq).not.toHaveBeenCalled();
    expect(mockExpireForItem).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith('DELETE /api/admin/items/:id error:', expect.any(Error));
  });

  it('商品 ID の形が違えば 400', async () => {
    const res = (await DELETE(
      new Request('http://localhost/api/admin/items/abc', { method: 'DELETE' }),
      { params: Promise.resolve({ id: 'abc' }) },
    )) as unknown as RouteResponse;

    expect(res.status).toBe(400);
  });

  // 商品の変更はもう済んでいる。決済の失効は、Stripe を得られない・失効に失敗するなど何があっても応答を失敗にしない
  describe.each(EXPIRING_FLOWS)('%s', (_flow, send) => {
    beforeEach(() => {
      // DELETE が削除まで進めるように、理由の無い商品にしておく（PATCH・PUT はこの読みを使わない）
      mockFetchBlockers.mockResolvedValue(new Map([[7, NO_BLOCKERS]]));
    });

    it('その商品を含む開いている決済を失効させ、失敗が無ければログに出さない', async () => {
      expect((await send()).status).toBe(200);

      expect(mockExpireForItem).toHaveBeenCalledWith({ client: mockClient, stripe: mockStripe, itemId: 7 });
      expect(consoleError).not.toHaveBeenCalled();
    });

    it('Stripe のクライアントを得られなくても成功の応答を返し、ログに残す', async () => {
      mockGetStripeServerClient.mockImplementation(() => {
        throw new Error('STRIPE_SECRET_KEY is not set');
      });

      expect((await send()).status).toBe(200);

      expect(mockExpireForItem).not.toHaveBeenCalled();
      expect(consoleError).toHaveBeenCalledWith('[admin.items] could not expire checkout sessions', 7, expect.any(Error));
    });

    it('失効の処理が例外を投げても成功の応答を返し、ログに残す', async () => {
      mockExpireForItem.mockRejectedValue(new Error('unexpected'));

      expect((await send()).status).toBe(200);

      expect(consoleError).toHaveBeenCalledWith('[admin.items] could not expire checkout sessions', 7, expect.any(Error));
    });

    it('失効できなかった決済があっても成功の応答を返し、失敗の数をログに残す', async () => {
      mockExpireForItem.mockResolvedValue({ expired: 0, failed: 2 });

      expect((await send()).status).toBe(200);

      expect(consoleError).toHaveBeenCalledWith(
        '[admin.items] some checkout sessions could not be expired',
        7,
        { expired: 0, failed: 2 },
      );
    });
  });

  describe('商品一覧（GET）', () => {
    it('各商品に、削除できるかと削除できない理由を付ける。読めなかった商品は削除できない扱いにする', async () => {
      mockOrder.mockResolvedValue({
        data: [
          { id: 7, name: 'シルクブラウス' },
          { id: 8, name: 'タックスカート' },
          { id: 9, name: 'リネンシャツ' },
        ],
        error: null,
      });
      mockFetchBlockers.mockResolvedValue(new Map([
        [7, { hasOrders: true, hasStockMovements: false, hasOpenCheckouts: true }],
        [8, NO_BLOCKERS],
      ]));

      const res = await list();

      expect(res.status).toBe(200);
      expect(mockFetchBlockers).toHaveBeenCalledWith(mockClient, [7, 8, 9]);
      expect(res.body.data).toEqual([
        { id: 7, name: 'シルクブラウス', canDelete: false, deleteBlockedReasons: ['注文がある', '決済中のお客様がいる'] },
        { id: 8, name: 'タックスカート', canDelete: true, deleteBlockedReasons: [] },
        { id: 9, name: 'リネンシャツ', canDelete: false, deleteBlockedReasons: [] },
      ]);
    });

    it('削除できない理由を読めなくても一覧は返し、判定の欄は付けない（削除のときに API が確かめる）', async () => {
      mockOrder.mockResolvedValue({ data: [{ id: 7, name: 'シルクブラウス' }], error: null });
      mockFetchBlockers.mockRejectedValue(new Error('rpc down'));

      const res = await list();

      expect(res.status).toBe(200);
      const [item] = res.body.data as Array<Record<string, unknown>>;
      expect(item).toEqual({ id: 7, name: 'シルクブラウス' });
      expect(item).not.toHaveProperty('canDelete');
      expect(item).not.toHaveProperty('deleteBlockedReasons');
      expect(consoleError).toHaveBeenCalledWith('Failed to fetch item delete blockers:', expect.any(Error));
    });
  });
});
