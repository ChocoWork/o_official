export {};

jest.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      _body: body,
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

jest.mock('@/features/auth/middleware/rateLimit', () => ({
  enforceRateLimit: jest.fn(),
}));

import { DELETE } from '@/app/api/admin/item-color-presets/[id]/route';

const { createServiceRoleClient } = require('@/lib/supabase/server');
const { authorizeAdminPermission } = require('@/lib/auth/admin-rbac');
const { enforceRateLimit } = require('@/features/auth/middleware/rateLimit');

const selectDeleted = jest.fn();
const eq = jest.fn();
const del = jest.fn();
const from = jest.fn();

type MockRes = { status: number; _body: unknown };

const denied = { status: 403, _body: { error: 'Forbidden' } };

function makeRequest() {
  return new Request('http://localhost/api/admin/item-color-presets/p-1', { method: 'DELETE' });
}

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

describe('DELETE /api/admin/item-color-presets/[id]', () => {
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    authorizeAdminPermission.mockReset().mockResolvedValue({ ok: true, userId: 'admin-1' });
    enforceRateLimit.mockReset().mockResolvedValue(null);
    selectDeleted.mockReset().mockResolvedValue({ data: [{ id: 1 }], error: null });
    eq.mockReset().mockReturnValue({ select: selectDeleted });
    del.mockReset().mockReturnValue({ eq });
    from.mockReset().mockReturnValue({ delete: del });
    createServiceRoleClient.mockReset().mockResolvedValue({ from });
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('DD-ADMIN-012 認可が ok:false の時に認可の応答をそのまま返し DB を作らない', async () => {
    authorizeAdminPermission.mockResolvedValue({ ok: false, response: denied });

    const res = (await DELETE(makeRequest(), ctx('p-1'))) as unknown as MockRes;

    expect(res).toBe(denied);
    expect(authorizeAdminPermission).toHaveBeenCalledWith('admin.items.manage', expect.any(Request));
    expect(createServiceRoleClient).not.toHaveBeenCalled();
  });

  it('DD-ADMIN-012 道の id の行を消して 200 success:true を返す', async () => {
    const res = (await DELETE(makeRequest(), ctx('12'))) as unknown as MockRes;

    expect(res.status).toBe(200);
    expect(res._body).toEqual({ success: true });
    expect(from).toHaveBeenCalledWith('item_color_presets');
    expect(del).toHaveBeenCalledTimes(1);
    expect(eq).toHaveBeenCalledWith('id', '12');
    expect(selectDeleted).toHaveBeenCalledWith('id');
  });

  it('DD-ADMIN-012 消した行が0行なら 404 Color preset not found を返す（成功と偽らない）', async () => {
    selectDeleted.mockResolvedValue({ data: [], error: null });

    const res = (await DELETE(makeRequest(), ctx('999'))) as unknown as MockRes;

    expect(res.status).toBe(404);
    expect(res._body).toEqual({ error: 'Color preset not found' });
  });

  it('DD-ADMIN-012 消した行の結果が null でも 404 を返す', async () => {
    selectDeleted.mockResolvedValue({ data: null, error: null });

    const res = (await DELETE(makeRequest(), ctx('999'))) as unknown as MockRes;

    expect(res.status).toBe(404);
  });

  it.each([['abc'], ['1; drop'], ['-1'], ['1.5'], [''], ['9'.repeat(19)], ['9'.repeat(20)]])(
    'DD-ADMIN-012 id が %s のように数字18桁以下でない時は DB を呼ばず 404 を返す',
    async (id) => {
      const res = (await DELETE(makeRequest(), ctx(id))) as unknown as MockRes;

      expect(res.status).toBe(404);
      expect(res._body).toEqual({ error: 'Color preset not found' });
      expect(createServiceRoleClient).not.toHaveBeenCalled();
      expect(del).not.toHaveBeenCalled();
    }
  );

  it('DD-ADMIN-012 id が数字18桁ちょうどなら DB に渡す', async () => {
    const id = '9'.repeat(18);

    const res = (await DELETE(makeRequest(), ctx(id))) as unknown as MockRes;

    expect(res.status).toBe(200);
    expect(eq).toHaveBeenCalledWith('id', id);
  });

  it('DD-ADMIN-012 回数の枠は認可の直後に管理者の ID だけで数え、超えたら 429 を返して DB を呼ばない', async () => {
    const limited = { status: 429, _body: { error: 'Too many requests' } };
    enforceRateLimit.mockResolvedValue(limited);

    const res = (await DELETE(makeRequest(), ctx('12'))) as unknown as MockRes;

    expect(res).toBe(limited);
    expect(enforceRateLimit).toHaveBeenCalledWith({
      request: expect.any(Request),
      endpoint: 'admin:color-presets:write',
      limit: 60,
      windowSeconds: 600,
      subject: 'admin-1',
    });
    expect(createServiceRoleClient).not.toHaveBeenCalled();
  });

  it('DD-ADMIN-012 認可で断った要求は回数に数えない', async () => {
    authorizeAdminPermission.mockResolvedValue({ ok: false, response: denied });

    await DELETE(makeRequest(), ctx('12'));

    expect(enforceRateLimit).not.toHaveBeenCalled();
  });

  it('DD-ADMIN-012 削除が誤りを返した時に 500 Failed to delete color preset を返す', async () => {
    const dbError = { message: 'connection reset' };
    selectDeleted.mockResolvedValue({ data: null, error: dbError });

    const res = (await DELETE(makeRequest(), ctx('12'))) as unknown as MockRes;

    expect(res.status).toBe(500);
    expect(res._body).toEqual({ error: 'Failed to delete color preset' });
    expect(errorSpy).toHaveBeenCalledWith('Failed to delete item color preset:', dbError);
  });

  it('DD-ADMIN-012 createServiceRoleClient が例外を投げた時に 500 Internal server error を返す', async () => {
    const failure = new Error('no client');
    createServiceRoleClient.mockRejectedValue(failure);

    const res = (await DELETE(makeRequest(), ctx('12'))) as unknown as MockRes;

    expect(res.status).toBe(500);
    expect(res._body).toEqual({ error: 'Internal server error' });
    expect(errorSpy).toHaveBeenCalledWith('DELETE /api/admin/item-color-presets/:id error:', failure);
  });

  it('DD-ADMIN-012 params の解決が失敗した時も 500 Internal server error を返す', async () => {
    const params = Promise.reject(new Error('bad params'));
    params.catch(() => undefined);

    const res = (await DELETE(makeRequest(), { params })) as unknown as MockRes;

    expect(res.status).toBe(500);
    expect(res._body).toEqual({ error: 'Internal server error' });
    expect(authorizeAdminPermission).not.toHaveBeenCalled();
  });
});
