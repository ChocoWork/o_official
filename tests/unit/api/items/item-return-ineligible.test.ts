export {};

jest.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));

jest.mock('@/lib/supabase/server', () => ({
  createClient: jest.fn(),
  // 画像URLの署名にサービスロールのクライアントを使う。
  createServiceRoleClient: jest.fn().mockResolvedValue({}),
}));

// 署名処理そのものはストレージ側の責務なので、ここでは行をそのまま返す（署名の部品に渡された行は、試験の中で確かめる）。
jest.mock('@/lib/storage/item-images', () => ({
  signItemImageFields: jest.fn(async (_client: unknown, row: unknown) => row),
}));

jest.mock('@/features/auth/middleware/rateLimit', () => ({
  enforceRateLimit: jest.fn(),
}));

jest.mock('@/lib/items/availability', () => ({
  getItemAvailability: jest.fn(),
}));

const route = require('@/app/api/items/[id]/route');
const { createClient } = require('@/lib/supabase/server');
const { signItemImageFields } = require('@/lib/storage/item-images');
const { enforceRateLimit } = require('@/features/auth/middleware/rateLimit');
const { getItemAvailability } = require('@/lib/items/availability');

function itemRow(extra: Record<string, unknown> = {}) {
  return {
    id: 101,
    name: 'Silk Blouse',
    description: 'desc',
    price: 12000,
    category: 'TOPS',
    image_url: '/images/1.jpg',
    image_urls: ['/images/1.jpg'],
    colors: [{ hex: '#000', name: 'Black' }],
    sizes: ['M'],
    product_details: ['Silk 100%'],
    ...extra,
  };
}

/** 公開の商品を1件返す問い合わせの差し替え。select に渡された文字は、試験の中で確かめる */
function mockItemQuery(row: unknown) {
  const query = {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    single: jest.fn().mockResolvedValue({ data: row, error: null }),
  };
  createClient.mockResolvedValue({ from: jest.fn().mockReturnValue(query) });
  return query;
}

async function getItem() {
  const response = await route.GET(new Request('http://localhost/api/items/101'), {
    params: Promise.resolve({ id: '101' }),
  });
  return { status: response.status as number, body: (await response.json()) as Record<string, unknown> };
}

describe('GET /api/items/[id] の返品不可の印 returnIneligible（グループ E-3 段2）', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    enforceRateLimit.mockResolvedValue(undefined);
    getItemAvailability.mockResolvedValue({ madeToOrder: false, combinations: [] });
  });

  it('返品不可の商品（return_ineligible が真）は returnIneligible: true を返す。列の名前のままの値は返さず、署名の部品にも渡さない', async () => {
    const query = mockItemQuery(itemRow({ return_ineligible: true }));

    const { status, body } = await getItem();

    expect(status).toBe(200);
    expect(body.returnIneligible).toBe(true);
    expect(body).not.toHaveProperty('return_ineligible');
    expect(String(query.select.mock.calls[0][0])).toContain('return_ineligible');
    expect(signItemImageFields.mock.calls[0][1]).not.toHaveProperty('return_ineligible');
  });

  it('返品できる商品（偽）は returnIneligible: false', async () => {
    mockItemQuery(itemRow({ return_ineligible: false }));

    const { body } = await getItem();

    expect(body.returnIneligible).toBe(false);
    expect(body).not.toHaveProperty('return_ineligible');
  });

  it('列が読めなかった・空の行は、返品不可にしない（false）', async () => {
    mockItemQuery(itemRow());
    expect((await getItem()).body.returnIneligible).toBe(false);

    mockItemQuery(itemRow({ return_ineligible: null }));
    expect((await getItem()).body.returnIneligible).toBe(false);
  });

  it('今までの項目（商品の情報・受注生産・色とサイズの在庫）は変わらない', async () => {
    mockItemQuery(itemRow({ return_ineligible: true }));
    getItemAvailability.mockResolvedValue({
      madeToOrder: true,
      combinations: [{ colorName: 'Black', sizeLabel: 'M', inStock: true }],
    });

    const { body } = await getItem();

    expect(body).toMatchObject({
      id: 101,
      name: 'Silk Blouse',
      price: 12000,
      madeToOrder: true,
      variantAvailability: [{ colorName: 'Black', sizeLabel: 'M', inStock: true }],
    });
  });
});
