/** @jest-environment node */

// 商品の編集の返品不可（グループ E-3 段2、決め事 P15・T8-11）。FormData の return_ineligible を、作る（POST）と直す（PUT）で
// items.return_ineligible（boolean）に書く。商品の一覧・1件の答えは select('*') なので、列がそのまま入る

jest.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, body }),
  },
}));

const mockAuthorize = jest.fn();
jest.mock('@/lib/auth/admin-rbac', () => ({
  authorizeAdminPermission: (...args: unknown[]) => mockAuthorize(...args),
}));

const mockInsert = jest.fn();
const mockInsertSingle = jest.fn();
const mockUpdate = jest.fn();
const mockUpdateEq = jest.fn();
const mockSelectSingle = jest.fn();
const mockListOrder = jest.fn();
const mockUpload = jest.fn();
const mockClient = {
  from: () => ({
    insert: (rows: unknown) => {
      mockInsert(rows);
      return { select: () => ({ single: mockInsertSingle }) };
    },
    update: (payload: unknown) => {
      mockUpdate(payload);
      return { eq: mockUpdateEq };
    },
    select: () => ({
      eq: () => ({ single: mockSelectSingle }),
      order: mockListOrder,
    }),
  }),
  storage: {
    from: () => ({
      upload: mockUpload,
      getPublicUrl: () => ({ data: { publicUrl: 'https://cdn.example.test/item.jpg' } }),
    }),
  },
};
jest.mock('@/lib/supabase/server', () => ({
  createServiceRoleClient: jest.fn(async () => mockClient),
}));
jest.mock('@/lib/storage/item-images', () => ({
  signItemImageFields: jest.fn(async (_client: unknown, item: unknown) => item),
}));
jest.mock('@/lib/stripe/server', () => ({ getStripeServerClient: jest.fn() }));
jest.mock('@/lib/items/item-checkout-guards', () => ({
  ...jest.requireActual('@/lib/items/item-checkout-guards'),
  fetchItemDeleteBlockers: jest.fn(async () => new Map([
    [7, { hasOrders: false, hasStockMovements: false, hasOpenCheckouts: false }],
    [8, { hasOrders: false, hasStockMovements: false, hasOpenCheckouts: false }],
  ])),
  expireOpenCheckoutsForItem: jest.fn(async () => ({ expired: 0, failed: 0 })),
}));

import { GET as listItems, POST } from '@/app/api/admin/items/route';
import { GET as getItem, PUT } from '@/app/api/admin/items/[id]/route';

type RouteResponse = { status: number; body: Record<string, unknown> };

const CONTEXT = { params: Promise.resolve({ id: '7' }) };
const FORBIDDEN = { status: 403, body: { error: 'Forbidden' } };

/** 商品の編集の FormData。return_ineligible は extra で渡した時だけ入る（無い時の動きを確かめるため） */
function itemForm(extra: Record<string, string | File> = {}, options: { withImage?: boolean } = {}): FormData {
  const formData = new FormData();
  const fields: Record<string, string | File> = {
    name: 'シルクブラウス',
    description: '絹のブラウス',
    price: '28000',
    category: 'TOPS',
    status: 'published',
    sizes: JSON.stringify(['M']),
    colors: JSON.stringify([{ name: 'BLACK', hex: '#000000' }]),
    ...extra,
  };
  for (const [key, value] of Object.entries(fields)) {
    formData.set(key, value);
  }
  if (options.withImage) {
    formData.append('images', new File([new Uint8Array([1, 2, 3])], 'item.jpg', { type: 'image/jpeg' }));
  }
  return formData;
}

function requestOf(formData: FormData): Request {
  return { formData: async () => formData } as unknown as Request;
}

function post(formData: FormData) {
  return POST(requestOf(formData)) as unknown as Promise<RouteResponse>;
}

function put(formData: FormData) {
  return PUT(requestOf(formData), CONTEXT) as unknown as Promise<RouteResponse>;
}

const INVALID_VALUES: Array<[string, string | File]> = [
  ['yes', 'yes'],
  ['1', '1'],
  ['TRUE', 'TRUE'],
  ['空', ''],
  ['ファイル', new File([new Uint8Array([1])], 'x.txt', { type: 'text/plain' })],
];

beforeEach(() => {
  jest.clearAllMocks();
  mockAuthorize.mockResolvedValue({ ok: true, userId: 'admin-1', role: 'admin' });
  mockInsertSingle.mockResolvedValue({ data: { id: 7 }, error: null });
  mockUpdateEq.mockResolvedValue({ error: null });
  mockUpload.mockResolvedValue({ error: null });
});

describe('商品を作る（POST /api/admin/items）の返品不可', () => {
  it.each<[string, boolean]>([
    ['true', true],
    ['false', false],
  ])('return_ineligible が %s なら、返品不可の印を %s で書く', async (text, expected) => {
    const response = await post(itemForm({ return_ineligible: text }, { withImage: true }));

    expect(response.status).toBe(201);
    expect(mockInsert).toHaveBeenCalledTimes(1);
    expect(mockInsert).toHaveBeenCalledWith([expect.objectContaining({ return_ineligible: expected })]);
  });

  it('return_ineligible が無ければ false で書く（返品できる商品）', async () => {
    const response = await post(itemForm({}, { withImage: true }));

    expect(response.status).toBe(201);
    expect(mockInsert).toHaveBeenCalledWith([expect.objectContaining({ return_ineligible: false })]);
  });

  it.each(INVALID_VALUES)('return_ineligible が知らない値（%s）なら 400 で断り、画像も商品も書かない', async (_name, value) => {
    const response = await post(itemForm({ return_ineligible: value }, { withImage: true }));

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ error: 'Invalid request', details: { fieldErrors: { return_ineligible: expect.any(Array) } } });
    expect(mockUpload).not.toHaveBeenCalled();
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('商品の編集の権限（admin.items.manage）が無ければ、認可の応答をそのまま返し、何も書かない', async () => {
    mockAuthorize.mockResolvedValue({ ok: false, response: FORBIDDEN });

    const response = await post(itemForm({ return_ineligible: 'true' }, { withImage: true }));

    expect(response).toBe(FORBIDDEN);
    expect(mockAuthorize).toHaveBeenCalledWith('admin.items.manage', expect.anything());
    expect(mockInsert).not.toHaveBeenCalled();
  });
});

describe('商品を直す（PUT /api/admin/items/[id]）の返品不可', () => {
  it.each<[string, boolean]>([
    ['true', true],
    ['false', false],
  ])('return_ineligible が %s なら、返品不可の印を %s で更新する', async (text, expected) => {
    const response = await put(itemForm({ return_ineligible: text }));

    expect(response.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({ return_ineligible: expected }));
    expect(mockUpdateEq).toHaveBeenCalledWith('id', '7');
  });

  it('return_ineligible が無ければ false で更新する（PUT は送られなかった印を false に戻す。画面はいつも送る）', async () => {
    const response = await put(itemForm());

    expect(response.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({ return_ineligible: false }));
  });

  it.each(INVALID_VALUES)('return_ineligible が知らない値（%s）なら 400 で断り、何も更新しない', async (_name, value) => {
    const response = await put(itemForm({ return_ineligible: value }));

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ error: 'Invalid request', details: { fieldErrors: { return_ineligible: expect.any(Array) } } });
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('商品の編集の権限（admin.items.manage）が無ければ、認可の応答をそのまま返し、何も更新しない', async () => {
    mockAuthorize.mockResolvedValue({ ok: false, response: FORBIDDEN });

    const response = await put(itemForm({ return_ineligible: 'true' }));

    expect(response).toBe(FORBIDDEN);
    expect(mockAuthorize).toHaveBeenCalledWith('admin.items.manage', expect.anything());
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});

describe('商品の答え（GET）に return_ineligible が入る', () => {
  it('1件の答え（GET /api/admin/items/[id]）は、列をそのまま返す', async () => {
    mockSelectSingle.mockResolvedValue({
      data: { id: 7, name: 'シルクブラウス', image_url: null, image_urls: [], return_ineligible: true },
      error: null,
    });

    const response = (await getItem(new Request('http://localhost/api/admin/items/7'), CONTEXT)) as unknown as RouteResponse;

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: expect.objectContaining({ id: 7, return_ineligible: true }) });
    expect(mockAuthorize).toHaveBeenCalledWith('admin.items.read', expect.any(Request));
  });

  it('一覧の答え（GET /api/admin/items）の各商品にも、列がそのまま入る', async () => {
    mockListOrder.mockResolvedValue({
      data: [
        { id: 7, name: 'シルクブラウス', image_url: null, image_urls: [], return_ineligible: true },
        { id: 8, name: 'ウールコート', image_url: null, image_urls: [], return_ineligible: false },
      ],
      error: null,
    });

    const response = (await listItems(new Request('http://localhost/api/admin/items'))) as unknown as RouteResponse;

    const items = response.body.data as Array<{ id: number; return_ineligible: boolean }>;
    expect(response.status).toBe(200);
    expect(items.map((item) => [item.id, item.return_ineligible])).toEqual([[7, true], [8, false]]);
  });
});
