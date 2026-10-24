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

function setupUpdate(error: unknown) {
  const eq = jest.fn().mockResolvedValue({ error });
  const update = jest.fn().mockReturnValue({ eq });
  const from = jest.fn().mockReturnValue({ update });
  mockCreateClient.mockResolvedValue({ from });
  return { from, update, eq };
}

function setupDelete(error: unknown) {
  const eq = jest.fn().mockResolvedValue({ error });
  const del = jest.fn().mockReturnValue({ eq });
  const from = jest.fn().mockReturnValue({ delete: del });
  mockCreateClient.mockResolvedValue({ from });
  return { from, delete: del, eq };
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
  const invalidIds = ['abc', '0', '-1', '1.5', ''];

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
      const denied = { status: 403, body: { error: 'Forbidden' } };
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
    const limited = { status: 429, body: { error: 'Too many requests' } };
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
      const limited = { status: 429, body: { error: 'Too many requests' } };
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
      const deny = { status: 403, body: { error: 'Forbidden', reason: 'CSRF validation failed' } };
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
  it('DD-STOCKIST-035 GET は id に合う1行を全部の列で読み 200 で data を返す', async () => {
    const row = { id: 5, name: 'Flagship', status: 'private' };
    const { from, select, eq, single } = setupSelectSingle({ data: row, error: null });
    const request = makeRequest('GET');

    const response = await GET(request, ctx('5'));

    expect(mockCreateClient).toHaveBeenCalledWith(request);
    expect(from).toHaveBeenCalledWith('stockists');
    expect(select).toHaveBeenCalledWith('*');
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
  ])(
    'DD-STOCKIST-035 PUT は値の形が合わない（%s）時に監査 failure と 400 を返す',
    async (_label, patch, field) => {
      const response = await PUT(makeRequest('PUT', { ...validBody, ...patch }), ctx('5'));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Invalid request');
      expect(Object.keys(body.details.fieldErrors)).toEqual([field]);
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

  it('DD-STOCKIST-035 PUT は表の更新に失敗した時に監査 error と 500 Failed to update stockist を返す', async () => {
    setupUpdate({ message: 'db' });

    const response = await PUT(makeRequest('PUT', validBody), ctx('5'));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Failed to update stockist' });
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
      expect(body.error).toBe('Invalid request');
      expect(body.details.fieldErrors).toHaveProperty('status');
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

  it('DD-STOCKIST-035 PATCH は表の更新に失敗した時に監査 error と 500 Failed to update status を返す', async () => {
    setupUpdate({ message: 'db' });

    const response = await PATCH(makeRequest('PATCH', { status: 'published' }), ctx('5'));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Failed to update status' });
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

  it('DD-STOCKIST-035 DELETE は表の削除に失敗した時に監査 error と 500 Failed to delete stockist を返す', async () => {
    setupDelete({ message: 'db' });

    const response = await DELETE(makeRequest('DELETE'), ctx('5'));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Failed to delete stockist' });
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
    it(`DD-STOCKIST-035 ${method} は本文が JSON でない時に 500 Internal server error を返し、監査を残さない`, async () => {
      const request = new Request('http://localhost/api/admin/stockists/5', {
        method,
        headers: { 'content-type': 'application/json' },
        body: 'not json',
      });

      const response = await handlers[method](request, ctx('5'));

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: 'Internal server error' });
      expect(mockLogAudit).not.toHaveBeenCalled();
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
