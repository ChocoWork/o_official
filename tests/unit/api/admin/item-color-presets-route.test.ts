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

import { GET, POST } from '@/app/api/admin/item-color-presets/route';

const { createServiceRoleClient } = require('@/lib/supabase/server');
const { authorizeAdminPermission } = require('@/lib/auth/admin-rbac');
const { enforceRateLimit } = require('@/features/auth/middleware/rateLimit');

const order = jest.fn();
const selectList = jest.fn();
const maybeSingle = jest.fn();
const eqHex = jest.fn();
const eqName = jest.fn();
const selectExisting = jest.fn();
const single = jest.fn();
const selectInserted = jest.fn();
const insert = jest.fn();
const from = jest.fn();

type MockRes = { status: number; _body: unknown };

const denied = { status: 403, _body: { error: 'Forbidden' } };

function makeGet() {
  return new Request('http://localhost/api/admin/item-color-presets', { method: 'GET' });
}

function makePost(body: unknown) {
  return new Request('http://localhost/api/admin/item-color-presets', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('item-color-presets route', () => {
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    authorizeAdminPermission.mockReset().mockResolvedValue({ ok: true, userId: 'admin-1' });
    enforceRateLimit.mockReset().mockResolvedValue(null);
    order.mockReset().mockResolvedValue({ data: [], error: null });
    selectList.mockReset().mockReturnValue({ order });
    maybeSingle.mockReset().mockResolvedValue({ data: null, error: null });
    eqHex.mockReset().mockReturnValue({ maybeSingle });
    eqName.mockReset().mockReturnValue({ eq: eqHex });
    selectExisting.mockReset().mockReturnValue({ eq: eqName });
    single.mockReset().mockResolvedValue({ data: { id: 'p-1' }, error: null });
    selectInserted.mockReset().mockReturnValue({ single });
    insert.mockReset().mockReturnValue({ select: selectInserted });
    from.mockReset().mockReturnValue({
      select: (cols: string) => (cols === '*' ? selectList(cols) : selectExisting(cols)),
      insert,
    });
    createServiceRoleClient.mockReset().mockResolvedValue({ from });
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  describe('GET', () => {
    it('DD-ADMIN-011 GET は認可が ok:false の時に認可の応答をそのまま返し DB を作らない', async () => {
      authorizeAdminPermission.mockResolvedValue({ ok: false, response: denied });

      const res = (await GET(makeGet())) as unknown as MockRes;

      expect(res).toBe(denied);
      expect(authorizeAdminPermission).toHaveBeenCalledWith('admin.items.read', expect.any(Request));
      expect(createServiceRoleClient).not.toHaveBeenCalled();
    });

    it('DD-ADMIN-011 GET は作った時刻の降順で全列を読み 200 で返す', async () => {
      const rows = [
        { id: 'p-2', name: '黒', hex: '#000000', created_at: '2026-10-02' },
        { id: 'p-1', name: '白', hex: '#ffffff', created_at: '2026-10-01' },
      ];
      order.mockResolvedValue({ data: rows, error: null });

      const res = (await GET(makeGet())) as unknown as MockRes;

      expect(res.status).toBe(200);
      expect(res._body).toEqual({ data: rows });
      expect(from).toHaveBeenCalledWith('item_color_presets');
      expect(selectList).toHaveBeenCalledWith('*');
      expect(order).toHaveBeenCalledWith('created_at', { ascending: false });
    });

    it('DD-ADMIN-011 GET は読みが誤りを返した時に 500 Failed to fetch color presets を返す', async () => {
      const dbError = { message: 'boom' };
      order.mockResolvedValue({ data: null, error: dbError });

      const res = (await GET(makeGet())) as unknown as MockRes;

      expect(res.status).toBe(500);
      expect(res._body).toEqual({ error: 'Failed to fetch color presets' });
      expect(errorSpy).toHaveBeenCalledWith('Failed to fetch item color presets:', dbError);
    });

    it('DD-ADMIN-011 GET は createServiceRoleClient が例外を投げた時に 500 Internal server error を返す', async () => {
      const failure = new Error('no client');
      createServiceRoleClient.mockRejectedValue(failure);

      const res = (await GET(makeGet())) as unknown as MockRes;

      expect(res.status).toBe(500);
      expect(res._body).toEqual({ error: 'Internal server error' });
      expect(errorSpy).toHaveBeenCalledWith('GET /api/admin/item-color-presets error:', failure);
    });
  });

  describe('POST', () => {
    it('DD-ADMIN-011 POST は認可が ok:false の時に認可の応答をそのまま返し本文も DB も触らない', async () => {
      authorizeAdminPermission.mockResolvedValue({ ok: false, response: denied });

      const res = (await POST(makePost({ name: '赤', hex: '#ff0000' }))) as unknown as MockRes;

      expect(res).toBe(denied);
      expect(authorizeAdminPermission).toHaveBeenCalledWith('admin.items.manage', expect.any(Request));
      expect(createServiceRoleClient).not.toHaveBeenCalled();
    });

    it('DD-ADMIN-011 POST は本文が JSON でない時に 400 を返し、500 にしない', async () => {
      const res = (await POST(makePost('not json'))) as unknown as MockRes;

      expect(res.status).toBe(400);
      expect(res._body).toEqual(
        expect.objectContaining({ error: 'Invalid request', details: expect.any(Object) })
      );
      expect(createServiceRoleClient).not.toHaveBeenCalled();
    });

    it('DD-ADMIN-011 POST の回数の枠は認可の直後に管理者の ID だけで数え、超えたら 429 を返して本文も DB も触らない', async () => {
      const limited = { status: 429, _body: { error: 'Too many requests' } };
      enforceRateLimit.mockResolvedValue(limited);

      const res = (await POST(makePost({ name: '赤', hex: '#ff0000' }))) as unknown as MockRes;

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

    it('DD-ADMIN-011 POST は認可で断った要求を回数に数えない', async () => {
      authorizeAdminPermission.mockResolvedValue({ ok: false, response: denied });

      await POST(makePost({ name: '赤', hex: '#ff0000' }));

      expect(enforceRateLimit).not.toHaveBeenCalled();
    });

    it('DD-ADMIN-011 GET は回数の枠を使わない', async () => {
      await GET(makeGet());

      expect(enforceRateLimit).not.toHaveBeenCalled();
    });

    it.each([
      ['名前が空白だけ', { name: '   ', hex: '#ff0000' }],
      ['名前が 41 字', { name: 'あ'.repeat(41), hex: '#ff0000' }],
      ['色の値が #12345', { name: '赤', hex: '#12345' }],
      ['色の値が # なし', { name: '赤', hex: 'ff0000' }],
      ['名前が無い', { hex: '#ff0000' }],
    ])('DD-ADMIN-011 POST は %s の時に 400 で details を返し DB を作らない', async (_label, body) => {
      const res = (await POST(makePost(body))) as unknown as MockRes;

      expect(res.status).toBe(400);
      expect(res._body).toEqual(
        expect.objectContaining({ error: 'Invalid request', details: expect.any(Object) })
      );
      expect(createServiceRoleClient).not.toHaveBeenCalled();
    });

    it('DD-ADMIN-011 POST は名前が 40 字ちょうど・大文字の色の値でも受け付ける', async () => {
      const name = 'あ'.repeat(40);

      const res = (await POST(makePost({ name, hex: '#ABCDEF' }))) as unknown as MockRes;

      expect(res.status).toBe(201);
      expect(insert).toHaveBeenCalledWith([{ name, hex: '#ABCDEF' }]);
    });

    it('DD-ADMIN-011 POST は同じ組の行がある時に 200 でその行を返し作らない', async () => {
      const existing = { id: 'p-9', name: '赤', hex: '#ff0000', created_at: '2026-10-01' };
      maybeSingle.mockResolvedValue({ data: existing, error: null });

      const res = (await POST(makePost({ name: '赤', hex: '#ff0000' }))) as unknown as MockRes;

      expect(res.status).toBe(200);
      expect(res._body).toEqual({ data: existing });
      expect(selectExisting).toHaveBeenCalledWith('id, name, hex, created_at');
      expect(eqName).toHaveBeenCalledWith('name', '赤');
      expect(eqHex).toHaveBeenCalledWith('hex', '#ff0000');
      expect(insert).not.toHaveBeenCalled();
    });

    it('DD-ADMIN-011 POST は名前の前後の空白を除いてから引いて作る', async () => {
      const created = { id: 'p-3', name: '赤', hex: '#ff0000', created_at: '2026-10-03' };
      single.mockResolvedValue({ data: created, error: null });

      const res = (await POST(makePost({ name: '  赤  ', hex: '#ff0000' }))) as unknown as MockRes;

      expect(res.status).toBe(201);
      expect(res._body).toEqual({ data: created });
      expect(eqName).toHaveBeenCalledWith('name', '赤');
      expect(insert).toHaveBeenCalledWith([{ name: '赤', hex: '#ff0000' }]);
      expect(selectInserted).toHaveBeenCalledWith('*');
    });

    it('DD-ADMIN-011 POST は引く時に誤りが返ったら 500 Failed to save color preset を返し、作らない', async () => {
      maybeSingle.mockResolvedValue({ data: null, error: { code: 'XX000', message: 'lookup failed for 赤' } });

      const res = (await POST(makePost({ name: '赤', hex: '#ff0000' }))) as unknown as MockRes;

      expect(res.status).toBe(500);
      expect(res._body).toEqual({ error: 'Failed to save color preset' });
      expect(insert).not.toHaveBeenCalled();
      expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('lookup failed');
      expect(errorSpy).toHaveBeenCalledWith('Failed to look up item color preset:', { code: 'XX000' });
    });

    it('DD-ADMIN-011 POST は作成が誤りを返した時に 500 Failed to save color preset を返す', async () => {
      const dbError = { message: 'duplicate key' };
      single.mockResolvedValue({ data: null, error: dbError });

      const res = (await POST(makePost({ name: '赤', hex: '#ff0000' }))) as unknown as MockRes;

      expect(res.status).toBe(500);
      expect(res._body).toEqual({ error: 'Failed to save color preset' });
      expect(errorSpy).toHaveBeenCalledWith('Failed to create item color preset:', dbError);
    });

    it('DD-ADMIN-011 POST は createServiceRoleClient が例外を投げた時に 500 Internal server error を返す', async () => {
      createServiceRoleClient.mockRejectedValue(new Error('no client'));

      const res = (await POST(makePost({ name: '赤', hex: '#ff0000' }))) as unknown as MockRes;

      expect(res.status).toBe(500);
      expect(res._body).toEqual({ error: 'Internal server error' });
    });
  });
});
