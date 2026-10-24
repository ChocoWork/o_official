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

import { DELETE } from '@/app/api/admin/item-color-presets/[id]/route';

const { createServiceRoleClient } = require('@/lib/supabase/server');
const { authorizeAdminPermission } = require('@/lib/auth/admin-rbac');

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
    eq.mockReset().mockResolvedValue({ error: null });
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
    const res = (await DELETE(makeRequest(), ctx('p-1'))) as unknown as MockRes;

    expect(res.status).toBe(200);
    expect(res._body).toEqual({ success: true });
    expect(from).toHaveBeenCalledWith('item_color_presets');
    expect(del).toHaveBeenCalledTimes(1);
    expect(eq).toHaveBeenCalledWith('id', 'p-1');
  });

  it('DD-ADMIN-012 対象の行が無くても誤りが無ければ 200 を返す', async () => {
    eq.mockResolvedValue({ error: null, count: 0 });

    const res = (await DELETE(makeRequest(), ctx('missing'))) as unknown as MockRes;

    expect(res.status).toBe(200);
    expect(res._body).toEqual({ success: true });
  });

  it('DD-ADMIN-012 削除が誤りを返した時に 500 Failed to delete color preset を返す', async () => {
    const dbError = { message: 'invalid input syntax' };
    eq.mockResolvedValue({ error: dbError });

    const res = (await DELETE(makeRequest(), ctx('not-a-number'))) as unknown as MockRes;

    expect(res.status).toBe(500);
    expect(res._body).toEqual({ error: 'Failed to delete color preset' });
    expect(errorSpy).toHaveBeenCalledWith('Failed to delete item color preset:', dbError);
  });

  it('DD-ADMIN-012 createServiceRoleClient が例外を投げた時に 500 Internal server error を返す', async () => {
    const failure = new Error('no client');
    createServiceRoleClient.mockRejectedValue(failure);

    const res = (await DELETE(makeRequest(), ctx('p-1'))) as unknown as MockRes;

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
