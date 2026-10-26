export {};

jest.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number; headers?: Record<string, string> }) => ({
      status: init?.status ?? 200,
      body,
      headers: new Headers(init?.headers),
      json: async () => body,
    }),
  },
}));

jest.mock('@/lib/supabase/server', () => ({
  createClient: jest.fn(),
}));

jest.mock('@/lib/auth/admin-rbac', () => ({
  authorizeAdminPermission: jest.fn(),
}));

jest.mock('@/lib/audit', () => ({
  logAudit: jest.fn(),
}));

jest.mock('@/features/stockist/services/admin-security', () => ({
  applyRotatedCsrfCookie: jest.fn(),
  enforceAdminStockistMutationRateLimit: jest.fn(),
  enforceAdminStockistReadRateLimit: jest.fn(),
  requireAdminStockistCsrf: jest.fn(),
  toCsrfDenyResponse: jest.fn(),
}));

const { createClient: mockCreateClient } = require('@/lib/supabase/server');
const { authorizeAdminPermission: mockAuthorize } = require('@/lib/auth/admin-rbac');
const { logAudit: mockLogAudit } = require('@/lib/audit');
const {
  applyRotatedCsrfCookie: mockApplyCookie,
  enforceAdminStockistMutationRateLimit: mockMutationLimit,
  enforceAdminStockistReadRateLimit: mockReadLimit,
  requireAdminStockistCsrf: mockRequireCsrf,
  toCsrfDenyResponse: mockToDeny,
} = require('@/features/stockist/services/admin-security');

const { ADMIN_STOCKIST_COLUMNS } = require('@/features/stockist/schemas');
const { GET, PUT, PATCH, DELETE } = require('@/app/api/admin/stockists/[id]/route');

type Method = 'GET' | 'PUT' | 'PATCH' | 'DELETE';

const handlers: Record<Method, (request: Request, ctx: unknown) => Promise<any>> = {
  GET,
  PUT,
  PATCH,
  DELETE,
};

const ALL_METHODS: Method[] = ['GET', 'PUT', 'PATCH', 'DELETE'];
const MUTATION_METHODS: Method[] = ['PUT', 'PATCH', 'DELETE'];

const validBody = {
  name: 'Flagship',
  address: 'Tokyo Shibuya 1-1',
  phone: '03-0000-0000',
  time: '11:00-20:00',
  holiday: 'Wed',
  status: 'private',
};

const csrfResult = { rotatedCsrfToken: 'rotated' };

function bodyFor(method: Method): unknown {
  if (method === 'PUT') return validBody;
  if (method === 'PATCH') return { status: 'published' };
  return undefined;
}

function makeRequest(method: Method, body?: unknown, headers: Record<string, string> = {}) {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Request('http://localhost/api/admin/stockists/5', {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    ...(method === 'GET' || method === 'DELETE' ? {} : { body: payload }),
  });
}

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

function setupSelectSingle(result: { data?: unknown; error: unknown }) {
  const single = jest.fn().mockResolvedValue(result);
  const eq = jest.fn().mockReturnValue({ single });
  const select = jest.fn().mockReturnValue({ eq });
  const from = jest.fn().mockReturnValue({ select });
  mockCreateClient.mockResolvedValue({ from });
  return { from, select, eq, single };
}

const DELETED_ROW = {
  id: 5,
  name: 'Flagship',
  address: 'Tokyo Shibuya 1-1',
  status: 'private',
};

// update().eq().select('id') の形。data を渡さなければ誤り無し = 1 行、誤り有り = null
function setupUpdate(error: unknown, data?: unknown) {
  const resolved = data !== undefined ? data : error ? null : [{ id: 5 }];
  const select = jest.fn().mockResolvedValue({ data: resolved, error });
  const eq = jest.fn().mockReturnValue({ select });
  const update = jest.fn().mockReturnValue({ eq });
  const from = jest.fn().mockReturnValue({ update });
  mockCreateClient.mockResolvedValue({ from });
  return { from, update, eq, select };
}

// delete().eq().select('id, name, address, status') の形
function setupDelete(error: unknown, data?: unknown) {
  const resolved = data !== undefined ? data : error ? null : [DELETED_ROW];
  const select = jest.fn().mockResolvedValue({ data: resolved, error });
  const eq = jest.fn().mockReturnValue({ select });
  const del = jest.fn().mockReturnValue({ eq });
  const from = jest.fn().mockReturnValue({ delete: del });
  mockCreateClient.mockResolvedValue({ from });
  return { from, delete: del, eq, select };
}

function setupDb(method: Method, error: unknown = null) {
  if (method === 'GET') return setupSelectSingle({ data: { id: 5 }, error });
  if (method === 'DELETE') return setupDelete(error);
  return setupUpdate(error);
}

beforeEach(() => {
  jest.resetAllMocks();
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  mockAuthorize.mockResolvedValue({
    ok: true,
    userId: 'admin-user',
    actorEmail: 'admin@example.com',
  });
  mockReadLimit.mockResolvedValue(null);
  mockMutationLimit.mockResolvedValue(null);
  mockRequireCsrf.mockResolvedValue(csrfResult);
  mockToDeny.mockReturnValue(null);
  mockLogAudit.mockResolvedValue(undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('道の id の確かめ', () => {
  const invalidIds = ['abc', '0', '-1', '1.5', '', '1e30', '9007199254740993'];

  for (const method of ALL_METHODS) {
    it.each(invalidIds)(
      `DD-STOCKIST-035 ${method} は id が %j の時に 400 Invalid stockist id を返し、認可を呼ばない`,
      async (id) => {
        const response = await handlers[method](makeRequest(method, bodyFor(method)), ctx(id));

        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: 'Invalid stockist id' });
        expect(mockAuthorize).not.toHaveBeenCalled();
        expect(mockCreateClient).not.toHaveBeenCalled();
      },
    );
  }

  it('DD-STOCKIST-035 GET は Number が数として読む ` 5 ` のような id を正の整数として通す', async () => {
    const { eq } = setupSelectSingle({ data: { id: 5 }, error: null });

    const response = await GET(makeRequest('GET'), ctx(' 5 '));

    expect(response.status).toBe(200);
    expect(eq).toHaveBeenCalledWith('id', 5);
  });
});

describe('認可と回数の制限', () => {
  const expectedPermission: Record<Method, string> = {
    GET: 'admin.stockists.read',
    PUT: 'admin.stockists.manage',
    PATCH: 'admin.stockists.manage',
    DELETE: 'admin.stockists.manage',
  };

  for (const method of ALL_METHODS) {
    it(`DD-STOCKIST-035 ${method} は認可が失敗した時にその応答を返し、${expectedPermission[method]} を求め、回数も表も見ない`, async () => {
      const denied = { status: 403, headers: new Headers({ 'Cache-Control': 's-maxage=60' }), body: { error: 'Forbidden' } };
      mockAuthorize.mockResolvedValue({ ok: false, response: denied });
      const request = makeRequest(method, bodyFor(method));

      const response = await handlers[method](request, ctx('5'));

      expect(response).toBe(denied);
      expect(mockAuthorize).toHaveBeenCalledWith(expectedPermission[method], request);
      expect(mockReadLimit).not.toHaveBeenCalled();
      expect(mockMutationLimit).not.toHaveBeenCalled();
      expect(mockCreateClient).not.toHaveBeenCalled();
    });
  }

  it('DD-STOCKIST-035 GET は回数の制限が応答を返した時にそれを返し、読みの枠を authz.userId で呼ぶ', async () => {
    const limited = { status: 429, headers: new Headers({ 'Cache-Control': 's-maxage=60' }), body: { error: 'Too many requests' } };
    mockReadLimit.mockResolvedValue(limited);
    const request = makeRequest('GET');

    const response = await GET(request, ctx('5'));

    expect(response).toBe(limited);
    expect(mockReadLimit).toHaveBeenCalledWith(request, 'admin-user');
    expect(mockMutationLimit).not.toHaveBeenCalled();
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  for (const method of MUTATION_METHODS) {
    it(`DD-STOCKIST-035 ${method} は回数の制限が応答を返した時にそれを返し、変更の枠を呼んで CSRF も表も見ない`, async () => {
      const limited = { status: 429, headers: new Headers({ 'Cache-Control': 's-maxage=60' }), body: { error: 'Too many requests' } };
      mockMutationLimit.mockResolvedValue(limited);
      const request = makeRequest(method, bodyFor(method));

      const response = await handlers[method](request, ctx('5'));

      expect(response).toBe(limited);
      expect(mockMutationLimit).toHaveBeenCalledWith(request, 'admin-user');
      expect(mockReadLimit).not.toHaveBeenCalled();
      expect(mockRequireCsrf).not.toHaveBeenCalled();
      expect(mockCreateClient).not.toHaveBeenCalled();
    });

    it(`DD-STOCKIST-035 ${method} は CSRF の拒否の応答をそのまま返し、表にも監査にも触らない`, async () => {
      const deny = { status: 403, headers: new Headers({ 'Cache-Control': 's-maxage=60' }), body: { error: 'Forbidden', reason: 'CSRF validation failed' } };
      mockToDeny.mockReturnValue(deny);

      const response = await handlers[method](makeRequest(method, bodyFor(method)), ctx('5'));

      expect(response).toBe(deny);
      expect(mockToDeny).toHaveBeenCalledWith(csrfResult);
      expect(mockCreateClient).not.toHaveBeenCalled();
      expect(mockLogAudit).not.toHaveBeenCalled();
    });
  }
});

describe('GET /api/admin/stockists/[id]', () => {
  it('DD-STOCKIST-035 GET は id に合う1行を管理用の 8 列で読み 200 で data を返す', async () => {
    const row = { id: 5, name: 'Flagship', status: 'private' };
    const { from, select, eq, single } = setupSelectSingle({ data: row, error: null });
    const request = makeRequest('GET');

    const response = await GET(request, ctx('5'));

    expect(mockCreateClient).toHaveBeenCalledWith(request);
    expect(from).toHaveBeenCalledWith('stockists');
    expect(select).toHaveBeenCalledWith(ADMIN_STOCKIST_COLUMNS);
    expect(select.mock.calls[0][0]).not.toContain('created_at');
    expect(select.mock.calls[0][0]).not.toContain('*');
    expect(eq).toHaveBeenCalledWith('id', 5);
    expect(single).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: row });
  });

  it('DD-STOCKIST-035 GET は表の誤りがある時に 404 Stockist not found を返す', async () => {
    setupSelectSingle({ data: null, error: { message: 'PGRST116' } });

    const response = await GET(makeRequest('GET'), ctx('5'));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Stockist not found' });
  });

  it('DD-STOCKIST-035 GET は誤りが無くても data が null の時に 404 Stockist not found を返す', async () => {
    setupSelectSingle({ data: null, error: null });

    const response = await GET(makeRequest('GET'), ctx('5'));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Stockist not found' });
  });
});

describe('PUT /api/admin/stockists/[id]', () => {
  it('DD-STOCKIST-035 PUT は更新の本文が6つの値だけで、eq に数の id を渡す', async () => {
    const { from, update, eq } = setupUpdate(null);

    await PUT(
      makeRequest('PUT', {
        name: '  Flagship  ',
        address: ' Tokyo ',
        phone: ' 03 ',
        time: ' 11-20 ',
        holiday: ' Wed ',
        status: 'published',
        type: 'extra',
      }),
      ctx('5'),
    );

    expect(from).toHaveBeenCalledWith('stockists');
    expect(update).toHaveBeenCalledWith({
      name: 'Flagship',
      address: 'Tokyo',
      phone: '03',
      time: '11-20',
      holiday: 'Wed',
      status: 'published',
    });
    expect(eq).toHaveBeenCalledWith('id', 5);
  });

  it('DD-STOCKIST-035 PUT は成功で監査 success と 200 を返し、回した CSRF の token を応答に付ける', async () => {
    setupUpdate(null);

    const response = await PUT(makeRequest('PUT', validBody), ctx('5'));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    expect(mockLogAudit).toHaveBeenCalledTimes(1);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'admin.stockists.update',
        actor_id: 'admin-user',
        actor_email: 'admin@example.com',
        resource: 'stockists',
        resource_id: '5',
        outcome: 'success',
        detail: 'Updated stockist: Flagship',
      }),
    );
    expect(mockApplyCookie).toHaveBeenCalledWith(response, csrfResult);
  });

  it('DD-STOCKIST-035 PUT は共有の確かめが何も返さない本番の形（undefined）でも成功し、Cookie の付け直しに undefined を渡す', async () => {
    mockRequireCsrf.mockResolvedValue(undefined);
    setupUpdate(null);

    const response = await PUT(makeRequest('PUT', validBody), ctx('5'));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    expect(mockLogAudit).toHaveBeenCalledTimes(1);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'admin.stockists.update',
        actor_id: 'admin-user',
        actor_email: 'admin@example.com',
        resource: 'stockists',
        resource_id: '5',
        outcome: 'success',
        detail: 'Updated stockist: Flagship',
      }),
    );
    expect(mockApplyCookie).toHaveBeenCalledWith(response, undefined);
  });

  it.each([
    ['店舗名が空白だけ', { name: '   ' }, 'name'],
    ['住所が501字', { address: 'a'.repeat(501) }, 'address'],
    ['状態が draft', { status: 'draft' }, 'status'],
    ['店舗名に改行', { name: '本店\nInjected' }, 'name'],
    ['電話に漢字', { phone: '03-1234-5678（代表）' }, 'phone'],
  ])(
    'DD-STOCKIST-035 PUT は値の形が合わない（%s）時に監査 failure と、項目の名前だけの固定の本文の 400 を返す',
    async (_label, patch, field) => {
      const response = await PUT(makeRequest('PUT', { ...validBody, ...patch }), ctx('5'));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body).toEqual({ error: 'Invalid request', fields: [field] });
      expect(JSON.stringify(body)).not.toMatch(/details|fieldErrors|formErrors/);
      expect(mockCreateClient).not.toHaveBeenCalled();
      expect(mockLogAudit).toHaveBeenCalledTimes(1);
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'admin.stockists.update',
          resource_id: '5',
          outcome: 'failure',
          detail: 'Validation failed',
        }),
      );
    },
  );

  it('DD-STOCKIST-035 PUT は更新の結果が 0 行の時に 404 Stockist not found を返し、成功の監査を書かず failure を残す', async () => {
    const { select } = setupUpdate(null, []);

    const response = await PUT(makeRequest('PUT', validBody), ctx('5'));

    expect(select).toHaveBeenCalledWith('id');
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Stockist not found' });
    expect(mockLogAudit).toHaveBeenCalledTimes(1);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'admin.stockists.update',
        resource_id: '5',
        outcome: 'failure',
        detail: 'Stockist not found',
      }),
    );
    expect(mockLogAudit).not.toHaveBeenCalledWith(expect.objectContaining({ outcome: 'success' }));
    expect(mockApplyCookie).not.toHaveBeenCalled();
  });

  it('DD-STOCKIST-035 PUT は本文が JSON でない時に 400 Invalid request を返し、表に触れず監査 failure を残す', async () => {
    const request = new Request('http://localhost/api/admin/stockists/5', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    });

    const response = await PUT(request, ctx('5'));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Invalid request' });
    expect(mockCreateClient).not.toHaveBeenCalled();
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'failure', detail: 'Invalid JSON', resource_id: '5' }),
    );
  });

  it('DD-STOCKIST-035 PUT は表の更新に失敗した時に監査 error と 500 Failed to update stockist を返し、記録には符号だけを残す', async () => {
    setupUpdate({ message: 'db secret', code: '23505' });

    const response = await PUT(makeRequest('PUT', validBody), ctx('5'));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Failed to update stockist' });
    expect(console.error).toHaveBeenCalledWith('Failed to update stockist:', { code: '23505' });
    expect(mockLogAudit).toHaveBeenCalledTimes(1);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'admin.stockists.update',
        resource_id: '5',
        outcome: 'error',
        detail: 'DB update failed',
      }),
    );
    expect(mockApplyCookie).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/admin/stockists/[id]', () => {
  it('DD-STOCKIST-035 PATCH は status だけを書き換え、eq に数の id を渡す', async () => {
    const { from, update, eq } = setupUpdate(null);

    await PATCH(makeRequest('PATCH', { status: 'published' }), ctx('5'));

    expect(from).toHaveBeenCalledWith('stockists');
    expect(update).toHaveBeenCalledWith({ status: 'published' });
    expect(eq).toHaveBeenCalledWith('id', 5);
  });

  it('DD-STOCKIST-035 PATCH は成功で監査 success と 200 を返し、回した CSRF の token を応答に付ける', async () => {
    setupUpdate(null);

    const response = await PATCH(makeRequest('PATCH', { status: 'private' }), ctx('5'));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    expect(mockLogAudit).toHaveBeenCalledTimes(1);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'admin.stockists.patch',
        actor_id: 'admin-user',
        actor_email: 'admin@example.com',
        resource: 'stockists',
        resource_id: '5',
        outcome: 'success',
        detail: 'Status changed to: private',
      }),
    );
    expect(mockApplyCookie).toHaveBeenCalledWith(response, csrfResult);
  });

  it('DD-STOCKIST-035 PATCH は共有の確かめが何も返さない本番の形（undefined）でも成功し、Cookie の付け直しに undefined を渡す', async () => {
    mockRequireCsrf.mockResolvedValue(undefined);
    setupUpdate(null);

    const response = await PATCH(makeRequest('PATCH', { status: 'private' }), ctx('5'));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    expect(mockLogAudit).toHaveBeenCalledTimes(1);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'admin.stockists.patch',
        actor_id: 'admin-user',
        actor_email: 'admin@example.com',
        resource: 'stockists',
        resource_id: '5',
        outcome: 'success',
        detail: 'Status changed to: private',
      }),
    );
    expect(mockApplyCookie).toHaveBeenCalledWith(response, undefined);
  });

  it.each([
    ['status が draft', { status: 'draft' }],
    ['status が無い', {}],
  ])(
    'DD-STOCKIST-035 PATCH は %s の時に監査 failure と 400 を返す',
    async (_label, payload) => {
      const response = await PATCH(makeRequest('PATCH', payload), ctx('5'));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body).toEqual({ error: 'Invalid request', fields: ['status'] });
      expect(mockCreateClient).not.toHaveBeenCalled();
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'admin.stockists.patch',
          resource_id: '5',
          outcome: 'failure',
          detail: 'Validation failed',
        }),
      );
    },
  );

  it('DD-STOCKIST-035 PATCH は更新の結果が 0 行の時に 404 Stockist not found を返し、成功の監査を書かず failure を残す', async () => {
    const { select } = setupUpdate(null, []);

    const response = await PATCH(makeRequest('PATCH', { status: 'published' }), ctx('5'));

    expect(select).toHaveBeenCalledWith('id');
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Stockist not found' });
    expect(mockLogAudit).toHaveBeenCalledTimes(1);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'admin.stockists.patch',
        resource_id: '5',
        outcome: 'failure',
        detail: 'Stockist not found',
      }),
    );
    expect(mockLogAudit).not.toHaveBeenCalledWith(expect.objectContaining({ outcome: 'success' }));
    expect(mockApplyCookie).not.toHaveBeenCalled();
  });

  it('DD-STOCKIST-035 PATCH は本文が JSON でない時に 400 Invalid request を返し、表に触れず監査 failure を残す', async () => {
    const request = new Request('http://localhost/api/admin/stockists/5', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    });

    const response = await PATCH(request, ctx('5'));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Invalid request' });
    expect(mockCreateClient).not.toHaveBeenCalled();
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'failure', detail: 'Invalid JSON', resource_id: '5' }),
    );
  });

  it('DD-STOCKIST-035 PATCH は表の更新に失敗した時に監査 error と 500 Failed to update status を返し、記録には符号だけを残す', async () => {
    setupUpdate({ message: 'db secret', code: '23505' });

    const response = await PATCH(makeRequest('PATCH', { status: 'published' }), ctx('5'));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Failed to update status' });
    expect(console.error).toHaveBeenCalledWith('Failed to update stockist status:', {
      code: '23505',
    });
    expect(mockLogAudit).toHaveBeenCalledTimes(1);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'admin.stockists.patch',
        resource_id: '5',
        outcome: 'error',
        detail: 'DB update failed',
      }),
    );
    expect(mockApplyCookie).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/admin/stockists/[id]', () => {
  it('DD-STOCKIST-035 DELETE は id の行を消し、成功で監査 success と 200 を返して CSRF の token を付ける', async () => {
    const { from, delete: del, eq } = setupDelete(null);

    const response = await DELETE(makeRequest('DELETE'), ctx('5'));

    expect(from).toHaveBeenCalledWith('stockists');
    expect(del).toHaveBeenCalledTimes(1);
    expect(eq).toHaveBeenCalledWith('id', 5);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    expect(mockLogAudit).toHaveBeenCalledTimes(1);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'admin.stockists.delete',
        actor_id: 'admin-user',
        actor_email: 'admin@example.com',
        resource: 'stockists',
        resource_id: '5',
        outcome: 'success',
        detail: 'Deleted stockist id: 5',
      }),
    );
    expect(mockApplyCookie).toHaveBeenCalledWith(response, csrfResult);
  });

  it('DD-STOCKIST-035 DELETE は共有の確かめが何も返さない本番の形（undefined）でも成功し、Cookie の付け直しに undefined を渡す', async () => {
    mockRequireCsrf.mockResolvedValue(undefined);
    const { from, delete: del, eq } = setupDelete(null);

    const response = await DELETE(makeRequest('DELETE'), ctx('5'));

    expect(from).toHaveBeenCalledWith('stockists');
    expect(del).toHaveBeenCalledTimes(1);
    expect(eq).toHaveBeenCalledWith('id', 5);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    expect(mockLogAudit).toHaveBeenCalledTimes(1);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'admin.stockists.delete',
        actor_id: 'admin-user',
        actor_email: 'admin@example.com',
        resource: 'stockists',
        resource_id: '5',
        outcome: 'success',
        detail: 'Deleted stockist id: 5',
      }),
    );
    expect(mockApplyCookie).toHaveBeenCalledWith(response, undefined);
  });

  it('DD-STOCKIST-035 DELETE は消した行の id・name・address・status だけを監査の metadata.deleted に残す', async () => {
    const { select } = setupDelete(null, [
      {
        id: 5,
        name: 'Flagship',
        address: 'Tokyo Shibuya 1-1',
        status: 'published',
        phone: '03-0000-0000',
        time: '11:00-20:00',
      },
    ]);

    const response = await DELETE(makeRequest('DELETE'), ctx('5'));

    expect(select).toHaveBeenCalledWith('id, name, address, status');
    expect(response.status).toBe(200);
    const audit = mockLogAudit.mock.calls[0][0];
    expect(audit.outcome).toBe('success');
    expect(audit.metadata).toEqual({
      deleted: { id: 5, name: 'Flagship', address: 'Tokyo Shibuya 1-1', status: 'published' },
    });
    expect(JSON.stringify(audit)).not.toContain('03-0000-0000');
    expect(JSON.stringify(audit)).not.toContain('11:00-20:00');
  });

  it('DD-STOCKIST-035 DELETE は削除の結果が 0 行の時に 404 Stockist not found を返し、成功の監査を書かず failure を残す', async () => {
    setupDelete(null, []);

    const response = await DELETE(makeRequest('DELETE'), ctx('5'));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Stockist not found' });
    expect(mockLogAudit).toHaveBeenCalledTimes(1);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'admin.stockists.delete',
        resource_id: '5',
        outcome: 'failure',
        detail: 'Stockist not found',
      }),
    );
    expect(mockLogAudit).not.toHaveBeenCalledWith(expect.objectContaining({ outcome: 'success' }));
    expect(mockApplyCookie).not.toHaveBeenCalled();
  });

  it('DD-STOCKIST-035 DELETE は表の削除に失敗した時に監査 error と 500 Failed to delete stockist を返し、記録には符号だけを残す', async () => {
    setupDelete({ message: 'db secret', code: '23503' });

    const response = await DELETE(makeRequest('DELETE'), ctx('5'));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Failed to delete stockist' });
    expect(console.error).toHaveBeenCalledWith('Failed to delete stockist:', { code: '23503' });
    expect(mockLogAudit).toHaveBeenCalledTimes(1);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'admin.stockists.delete',
        resource_id: '5',
        outcome: 'error',
        detail: 'DB delete failed',
      }),
    );
    expect(mockApplyCookie).not.toHaveBeenCalled();
  });
});

describe('本文・送り元・例外', () => {
  for (const method of ['PUT', 'PATCH'] as Method[]) {
    it(`DD-STOCKIST-035 ${method} は本文が JSON でない時に 500 でなく 400 Invalid request を返す`, async () => {
      const request = new Request('http://localhost/api/admin/stockists/5', {
        method,
        headers: { 'content-type': 'application/json' },
        body: 'not json',
      });

      const response = await handlers[method](request, ctx('5'));

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'Invalid request' });
    });
  }

  for (const method of MUTATION_METHODS) {
    it(`DD-STOCKIST-035 ${method} は監査の ip に x-forwarded-for の先頭を空白を除いて入れ、user_agent はその値を入れる`, async () => {
      setupDb(method);

      await handlers[method](
        makeRequest(method, bodyFor(method), {
          'x-forwarded-for': ' 1.2.3.4 , 5.6.7.8',
          'user-agent': 'jest-agent',
        }),
        ctx('5'),
      );

      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({ ip: '1.2.3.4', user_agent: 'jest-agent' }),
      );
    });

    it(`DD-STOCKIST-035 ${method} は x-forwarded-for と user-agent が無い時に監査の ip と user_agent を null にする`, async () => {
      setupDb(method);
      const request = makeRequest(method, bodyFor(method));
      request.headers.delete('user-agent');

      await handlers[method](request, ctx('5'));

      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({ ip: null, user_agent: null }),
      );
    });
  }

  for (const method of ALL_METHODS) {
    it(`DD-STOCKIST-035 ${method} は params が例外を投げた時に 500 Internal server error を返す`, async () => {
      const response = await handlers[method](makeRequest(method, bodyFor(method)), {
        params: Promise.reject(new Error('bad params')),
      });

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: 'Internal server error' });
      expect(mockAuthorize).not.toHaveBeenCalled();
    });

    it(`DD-STOCKIST-035 ${method} は認可の後に例外が出た時に 500 Internal server error を返す`, async () => {
      mockCreateClient.mockRejectedValue(new Error('boom'));

      const response = await handlers[method](makeRequest(method, bodyFor(method)), ctx('5'));

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: 'Internal server error' });
    });
  }
});

describe('DD-STOCKIST-035 Cache-Control は戻りの全分岐で private, no-store', () => {
  const NO_STORE = 'private, no-store';
  const staleResponse = (status: number) => ({
    status,
    body: {},
    headers: new Headers({ 'Cache-Control': 's-maxage=60' }),
  });

  async function call(method: Method, id = '5') {
    return handlers[method](makeRequest(method, bodyFor(method)), ctx(id));
  }

  for (const method of ALL_METHODS) {
    it(`DD-STOCKIST-035 ${method} 200 成功`, async () => {
      setupDb(method);
      const res = await call(method);
      expect(res.status).toBe(200);
      expect(res.headers.get('Cache-Control')).toBe(NO_STORE);
    });

    it(`DD-STOCKIST-035 ${method} 400 id が不正`, async () => {
      const res = await call(method, 'abc');
      expect(res.status).toBe(400);
      expect(res.headers.get('Cache-Control')).toBe(NO_STORE);
    });

    for (const status of [401, 403, 503]) {
      it(`DD-STOCKIST-035 ${method} ${status} 認可の拒否`, async () => {
        mockAuthorize.mockResolvedValue({ ok: false, response: staleResponse(status) });
        const res = await call(method);
        expect(res.status).toBe(status);
        expect(res.headers.get('Cache-Control')).toBe(NO_STORE);
      });
    }

    it(`DD-STOCKIST-035 ${method} 500 外側の catch`, async () => {
      mockCreateClient.mockRejectedValue(new Error('secret boom'));
      const res = await call(method);
      expect(res.status).toBe(500);
      expect(res.headers.get('Cache-Control')).toBe(NO_STORE);
    });
  }

  it('DD-STOCKIST-035 GET 404 無い id', async () => {
    setupSelectSingle({ data: null, error: { code: 'PGRST116' } });
    const res = await call('GET');
    expect(res.status).toBe(404);
    expect(res.headers.get('Cache-Control')).toBe(NO_STORE);
  });

  it('DD-STOCKIST-035 GET 429 読みの回数制限', async () => {
    mockReadLimit.mockResolvedValue(staleResponse(429));
    const res = await call('GET');
    expect(res.status).toBe(429);
    expect(res.headers.get('Cache-Control')).toBe(NO_STORE);
  });

  for (const method of MUTATION_METHODS) {
    for (const status of [429, 503]) {
      it(`DD-STOCKIST-035 ${method} ${status} 書きの回数制限`, async () => {
        mockMutationLimit.mockResolvedValue(staleResponse(status));
        const res = await call(method);
        expect(res.status).toBe(status);
        expect(res.headers.get('Cache-Control')).toBe(NO_STORE);
      });
    }

    it(`DD-STOCKIST-035 ${method} 403 CSRF の拒否`, async () => {
      mockToDeny.mockReturnValue(staleResponse(403));
      const res = await call(method);
      expect(res.status).toBe(403);
      expect(res.headers.get('Cache-Control')).toBe(NO_STORE);
    });

    it(`DD-STOCKIST-035 ${method} 404 更新または削除が 0 行`, async () => {
      if (method === 'DELETE') setupDelete(null, []);
      else setupUpdate(null, []);
      const res = await call(method);
      expect(res.status).toBe(404);
      expect(res.headers.get('Cache-Control')).toBe(NO_STORE);
    });

    it(`DD-STOCKIST-035 ${method} 500 DB の誤り`, async () => {
      setupDb(method, { code: '23505', message: 'secret' });
      const res = await call(method);
      expect(res.status).toBe(500);
      expect(res.headers.get('Cache-Control')).toBe(NO_STORE);
    });
  }

  for (const method of ['PUT', 'PATCH'] as Method[]) {
    it(`DD-STOCKIST-035 ${method} 400 壊れた JSON`, async () => {
      const request = new Request('http://localhost/api/admin/stockists/5', {
        method,
        headers: { 'content-type': 'application/json' },
        body: 'not json',
      });
      const res = await handlers[method](request, ctx('5'));
      expect(res.status).toBe(400);
      expect(res.headers.get('Cache-Control')).toBe(NO_STORE);
    });
  }

  it('DD-STOCKIST-035 PUT 400 検証の誤り', async () => {
    const res = await handlers.PUT(makeRequest('PUT', { ...validBody, name: '' }), ctx('5'));
    expect(res.status).toBe(400);
    expect(res.headers.get('Cache-Control')).toBe(NO_STORE);
  });

  it('DD-STOCKIST-035 PATCH 400 status が不正', async () => {
    const res = await handlers.PATCH(makeRequest('PATCH', { status: 'draft' }), ctx('5'));
    expect(res.status).toBe(400);
    expect(res.headers.get('Cache-Control')).toBe(NO_STORE);
  });

  it('DD-STOCKIST-035 外側の catch の console.error の第 2 引数は { name, code } ちょうどで、投げた誤りの message を含まない', async () => {
    mockCreateClient.mockRejectedValue(new Error('secret boom'));

    for (const method of ALL_METHODS) {
      await call(method);
      expect(console.error).toHaveBeenCalledWith(`${method} /api/admin/stockists/:id error:`, {
        name: 'Error',
        code: null,
      });
    }
    expect(JSON.stringify((console.error as jest.Mock).mock.calls)).not.toContain('secret boom');
  });
});
