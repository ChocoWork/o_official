export {};

jest.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      body,
      json: async () => body,
    }),
  },
}));

jest.mock('@/lib/supabase/server', () => ({
  createServiceRoleClient: jest.fn(),
}));

jest.mock('@/lib/auth/admin-rbac', () => ({
  authorizeAdminPermission: jest.fn(),
}));

jest.mock('@/features/look/services/admin-rate-limit', () => ({
  enforceAdminLookMutationRateLimit: jest.fn(),
  consumeAdminLookUploadQuota: jest.fn(),
  validateLookImageBatch: jest.fn(),
}));

jest.mock('@/features/look/services/admin-audit', () => ({
  logAdminLookAudit: jest.fn(),
}));

jest.mock('@/lib/storage/look-images', () => ({
  signLookImageUrls: jest.fn(),
}));

import { GET } from '@/app/api/admin/looks/route';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';
import {
  consumeAdminLookUploadQuota,
  enforceAdminLookMutationRateLimit,
} from '@/features/look/services/admin-rate-limit';
import { logAdminLookAudit } from '@/features/look/services/admin-audit';
import { signLookImageUrls } from '@/lib/storage/look-images';

const mockCreateServiceRoleClient = createServiceRoleClient as jest.Mock;
const mockAuthorize = authorizeAdminPermission as jest.Mock;
const mockSign = signLookImageUrls as jest.Mock;
const mockAudit = logAdminLookAudit as jest.Mock;
const mockMutationRateLimit = enforceAdminLookMutationRateLimit as jest.Mock;
const mockUploadQuota = consumeAdminLookUploadQuota as jest.Mock;

function createListService(result: { data: unknown; error: unknown }) {
  const order = jest.fn().mockResolvedValue(result);
  const select = jest.fn().mockReturnValue({ order });
  const client = { from: jest.fn().mockReturnValue({ select }) };
  return { client, select, order };
}

function buildRequest() {
  return new Request('http://localhost/api/admin/looks', { method: 'GET' });
}

async function callGet(request: Request) {
  return (await GET(request)) as unknown as { status: number; body: unknown };
}

describe('GET /api/admin/looks', () => {
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.resetAllMocks();
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockAuthorize.mockResolvedValue({
      ok: true,
      userId: 'admin-user',
      actorEmail: 'admin@example.com',
      permissions: new Set(['admin.looks.read', 'admin.looks.manage']),
    });
    mockSign.mockImplementation(async (_client: unknown, urls: string[]) =>
      urls.map((url) => `signed:${url}`),
    );
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  test('DD-LOOK-063 一覧の認可が通らない時は認可の応答を返し、DB に触れない', async () => {
    const denied = { status: 401, body: { error: 'Unauthorized' } };
    mockAuthorize.mockResolvedValue({ ok: false, response: denied });

    const response = await callGet(buildRequest());

    expect(response).toBe(denied);
    expect(mockAuthorize).toHaveBeenCalledWith('admin.looks.read', expect.any(Request));
    expect(mockCreateServiceRoleClient).not.toHaveBeenCalled();
  });

  test('DD-LOOK-063 一覧の取り出しに失敗したら 500 Failed to fetch looks で、監査も回数も使わない', async () => {
    const service = createListService({ data: null, error: { message: 'db down' } });
    mockCreateServiceRoleClient.mockResolvedValue(service.client);

    const response = await callGet(buildRequest());

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: 'Failed to fetch looks' });
    expect(mockSign).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  test('DD-LOOK-063 一覧は作った日時の新しい順に取り、画像を署名つきにして返す。image_urls が null なら空として署名する', async () => {
    const rows = [
      {
        id: 1,
        theme: 'A',
        image_urls: ['looks/2026-01-01/a.jpg', 'looks/2026-01-01/b.jpg'],
        look_items: [{ item_id: 5 }],
      },
      { id: 2, theme: 'B', image_urls: null, look_items: [] },
    ];
    const service = createListService({ data: rows, error: null });
    mockCreateServiceRoleClient.mockResolvedValue(service.client);

    const response = await callGet(buildRequest());

    expect(response.status).toBe(200);
    expect(service.client.from).toHaveBeenCalledWith('looks');
    expect(service.select).toHaveBeenCalledWith(expect.stringContaining('look_items(item_id)'));
    expect(service.order).toHaveBeenCalledWith('created_at', { ascending: false });
    expect(mockSign).toHaveBeenCalledTimes(2);
    expect(mockSign).toHaveBeenNthCalledWith(1, service.client, rows[0].image_urls);
    expect(mockSign).toHaveBeenNthCalledWith(2, service.client, []);
    expect(response.body).toEqual({
      data: [
        {
          id: 1,
          theme: 'A',
          image_urls: ['signed:looks/2026-01-01/a.jpg', 'signed:looks/2026-01-01/b.jpg'],
          look_items: [{ item_id: 5 }],
        },
        { id: 2, theme: 'B', image_urls: [], look_items: [] },
      ],
      meta: { canManage: true },
    });
    expect(mockMutationRateLimit).not.toHaveBeenCalled();
    expect(mockUploadQuota).not.toHaveBeenCalled();
  });

  test('DD-LOOK-063 一覧の data が空（null）の時は 200 で空の配列を返す', async () => {
    const service = createListService({ data: null, error: null });
    mockCreateServiceRoleClient.mockResolvedValue(service.client);

    const response = await callGet(buildRequest());

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: [], meta: { canManage: true } });
    expect(mockSign).not.toHaveBeenCalled();
  });

  describe('meta.canManage', () => {
    const authorizeWith = (permissions: unknown) =>
      mockAuthorize.mockResolvedValue({
        ok: true,
        userId: 'admin-user',
        actorEmail: 'admin@example.com',
        ...(permissions === undefined ? {} : { permissions }),
      });

    test('DD-LOOK-063 認可の成功の結果の permissions に管理の権限があれば meta.canManage は true。認可は 1 回だけ呼ぶ', async () => {
      authorizeWith(new Set(['admin.looks.read', 'admin.looks.manage']));
      mockCreateServiceRoleClient.mockResolvedValue(createListService({ data: [], error: null }).client);

      const response = await callGet(buildRequest());

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ data: [], meta: { canManage: true } });
      expect(mockAuthorize).toHaveBeenCalledTimes(1);
      expect(mockAuthorize).toHaveBeenCalledWith('admin.looks.read', expect.any(Request));
    });

    test('DD-LOOK-063 読み出しの権限だけなら canManage は false で、一覧は返す', async () => {
      authorizeWith(new Set(['admin.looks.read']));
      mockCreateServiceRoleClient.mockResolvedValue(createListService({ data: [], error: null }).client);

      const response = await callGet(buildRequest());

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ data: [], meta: { canManage: false } });
      expect(mockAuthorize).toHaveBeenCalledTimes(1);
    });

    test('DD-LOOK-063 成功の結果に permissions が無い（モックなど）なら canManage は false（権限が分からない時は出さない）', async () => {
      authorizeWith(undefined);
      mockCreateServiceRoleClient.mockResolvedValue(createListService({ data: [], error: null }).client);

      const response = await callGet(buildRequest());

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ data: [], meta: { canManage: false } });
    });

    test('DD-LOOK-063 認可が 403 なら 403 をそのまま返し、DB に触れない', async () => {
      const forbidden = { status: 403, body: { error: 'Forbidden' } };
      mockAuthorize.mockResolvedValue({ ok: false, response: forbidden });

      const response = await callGet(buildRequest());

      expect(response).toBe(forbidden);
      expect(mockCreateServiceRoleClient).not.toHaveBeenCalled();
    });

    test('DD-LOOK-063 認可が 503 ならその 503 をそのまま返し、DB に触れない', async () => {
      const unavailable = { status: 503, body: { error: 'Service unavailable' } };
      mockAuthorize.mockResolvedValue({ ok: false, response: unavailable });

      const response = await callGet(buildRequest());

      expect(response).toBe(unavailable);
      expect(mockCreateServiceRoleClient).not.toHaveBeenCalled();
    });
  });

  test('DD-LOOK-063 一覧の処理が例外を投げたら 500 Internal server error', async () => {
    mockCreateServiceRoleClient.mockRejectedValue(new Error('client exploded'));

    const response = await callGet(buildRequest());

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: 'Internal server error' });
    expect(consoleErrorSpy).toHaveBeenCalled();
  });
});
