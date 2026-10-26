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
const { GET, POST } = require('@/app/api/admin/stockists/route');

const validBody = {
  name: 'Flagship',
  address: 'Tokyo Shibuya 1-1',
  phone: '03-0000-0000',
  time: '11:00-20:00',
  holiday: 'Wed',
  status: 'private',
};

const csrfResult = { rotatedCsrfToken: 'rotated' };

function jsonRequest(body: unknown, headers: Record<string, string> = {}) {
  return new Request('http://localhost/api/admin/stockists', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

function getRequest() {
  return new Request('http://localhost/api/admin/stockists', { method: 'GET' });
}

function setupSelect(result: { data?: unknown; error: unknown }) {
  const order = jest.fn().mockResolvedValue(result);
  const select = jest.fn().mockReturnValue({ order });
  const from = jest.fn().mockReturnValue({ select });
  mockCreateClient.mockResolvedValue({ from });
  return { from, select, order };
}

function setupInsert(result: { data?: unknown; error: unknown }) {
  const single = jest.fn().mockResolvedValue(result);
  const select = jest.fn().mockReturnValue({ single });
  const insert = jest.fn().mockReturnValue({ select });
  const from = jest.fn().mockReturnValue({ insert });
  mockCreateClient.mockResolvedValue({ from });
  return { from, insert, select, single };
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

describe('GET /api/admin/stockists', () => {
  it('DD-STOCKIST-034 GET は認可が失敗した時にその応答をそのまま返し、表に触らない', async () => {
    const denied = { status: 403, headers: new Headers({ 'Cache-Control': 's-maxage=60' }), body: { error: 'Forbidden' } };
    mockAuthorize.mockResolvedValue({ ok: false, response: denied });

    const response = await GET(getRequest());

    expect(response).toBe(denied);
    expect(mockReadLimit).not.toHaveBeenCalled();
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  it('DD-STOCKIST-034 GET は読みの権限 admin.stockists.read で認可する', async () => {
    setupSelect({ data: [], error: null });
    const request = getRequest();

    await GET(request);

    expect(mockAuthorize).toHaveBeenCalledWith('admin.stockists.read', request);
  });

  it('DD-STOCKIST-034 GET は回数の制限が応答を返した時にそれを返し、表に触らない', async () => {
    const limited = { status: 429, headers: new Headers({ 'Cache-Control': 's-maxage=60' }), body: { error: 'Too many requests' } };
    mockReadLimit.mockResolvedValue(limited);
    const request = getRequest();

    const response = await GET(request);

    expect(response).toBe(limited);
    expect(mockReadLimit).toHaveBeenCalledWith(request, 'admin-user');
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  it('DD-STOCKIST-034 GET は管理用の 8 列を id の昇順で読み 200 で data を返す', async () => {
    const rows = [
      { id: 1, name: 'A' },
      { id: 2, name: 'B' },
    ];
    const { from, select, order } = setupSelect({ data: rows, error: null });
    const request = getRequest();

    const response = await GET(request);

    expect(mockCreateClient).toHaveBeenCalledWith(request);
    expect(from).toHaveBeenCalledWith('stockists');
    expect(select).toHaveBeenCalledWith(ADMIN_STOCKIST_COLUMNS);
    expect(ADMIN_STOCKIST_COLUMNS).toBe(
      'id, name, address, phone, time, holiday, status, updated_at',
    );
    expect(select.mock.calls[0][0]).not.toContain('created_at');
    expect(select.mock.calls[0][0]).not.toContain('*');
    expect(order).toHaveBeenCalledWith('id', { ascending: true });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: rows });
  });

  it('DD-STOCKIST-034 GET は表の読み出しに失敗した時に 500 Failed to fetch stockists を返し、記録には符号だけを残す', async () => {
    setupSelect({ data: null, error: { message: 'db down secret', code: '57P01' } });

    const response = await GET(getRequest());

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Failed to fetch stockists' });
    expect(console.error).toHaveBeenCalledWith('Failed to fetch stockists:', { code: '57P01' });
  });

  it('DD-STOCKIST-034 GET は例外の時に 500 Internal server error を返す', async () => {
    mockCreateClient.mockRejectedValue(new Error('boom'));

    const response = await GET(getRequest());

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Internal server error' });
  });
});

describe('POST /api/admin/stockists', () => {
  it('DD-STOCKIST-034 POST は認可が失敗した時にその応答をそのまま返し、表に触らない', async () => {
    const denied = { status: 401, headers: new Headers({ 'Cache-Control': 's-maxage=60' }), body: { error: 'Unauthorized' } };
    mockAuthorize.mockResolvedValue({ ok: false, response: denied });

    const response = await POST(jsonRequest(validBody));

    expect(response).toBe(denied);
    expect(mockMutationLimit).not.toHaveBeenCalled();
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  it('DD-STOCKIST-034 POST は変更の権限 admin.stockists.manage で認可する', async () => {
    setupInsert({ data: { id: 1 }, error: null });
    const request = jsonRequest(validBody);

    await POST(request);

    expect(mockAuthorize).toHaveBeenCalledWith('admin.stockists.manage', request);
  });

  it('DD-STOCKIST-034 POST は回数の制限が応答を返した時にそれを返し、CSRF も表も見ない', async () => {
    const limited = { status: 429, headers: new Headers({ 'Cache-Control': 's-maxage=60' }), body: { error: 'Too many requests' } };
    mockMutationLimit.mockResolvedValue(limited);
    const request = jsonRequest(validBody);

    const response = await POST(request);

    expect(response).toBe(limited);
    expect(mockMutationLimit).toHaveBeenCalledWith(request, 'admin-user');
    expect(mockReadLimit).not.toHaveBeenCalled();
    expect(mockRequireCsrf).not.toHaveBeenCalled();
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  it('DD-STOCKIST-034 POST は CSRF の確かめが拒否の応答を返した時にそれを返し、本文を読まない', async () => {
    const deny = { status: 403, headers: new Headers({ 'Cache-Control': 's-maxage=60' }), body: { error: 'Forbidden', reason: 'CSRF validation failed' } };
    mockToDeny.mockReturnValue(deny);
    const request = jsonRequest(validBody);
    const jsonSpy = jest.spyOn(request, 'json');

    const response = await POST(request);

    expect(response).toBe(deny);
    expect(mockToDeny).toHaveBeenCalledWith(csrfResult);
    expect(jsonSpy).not.toHaveBeenCalled();
    expect(mockCreateClient).not.toHaveBeenCalled();
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it('DD-STOCKIST-034 POST は本文が JSON でない時に 400 Invalid request を返し、表に触れず監査 failure を残す', async () => {
    const request = new Request('http://localhost/api/admin/stockists', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    });

    const response = await POST(request);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Invalid request' });
    expect(mockCreateClient).not.toHaveBeenCalled();
    expect(mockLogAudit).toHaveBeenCalledTimes(1);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'admin.stockists.create',
        outcome: 'failure',
        detail: 'Invalid JSON',
      }),
    );
  });

  it.each([
    ['店舗名が空白だけ', { name: '   ' }, 'name'],
    ['店舗名が256字', { name: 'a'.repeat(256) }, 'name'],
    ['住所が501字', { address: 'a'.repeat(501) }, 'address'],
    ['電話が51字', { phone: '1'.repeat(51) }, 'phone'],
    ['時間が121字', { time: 't'.repeat(121) }, 'time'],
    ['定休日が121字', { holiday: 'h'.repeat(121) }, 'holiday'],
    ['状態が draft', { status: 'draft' }, 'status'],
    ['店舗名に改行', { name: '本店\nInjected' }, 'name'],
    ['住所に制御文字', { address: 'Tokyo\u0007' }, 'address'],
    ['時間に書式文字（ゼロ幅空白）', { time: '11:00\u200b-20:00' }, 'time'],
    ['定休日に行区切り', { holiday: 'Wed\u2028Thu' }, 'holiday'],
    ['電話に漢字', { phone: '03-1234-5678（代表）' }, 'phone'],
    ['電話に改行', { phone: '03-1234-5678\n03-0000-0000' }, 'phone'],
  ])(
    'DD-STOCKIST-034 POST は値の形が合わない（%s）時に 400 と項目の名前だけの固定の本文を返し、監査 failure を残す',
    async (_label, patch, field) => {
      const response = await POST(jsonRequest({ ...validBody, ...patch }));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body).toEqual({ error: 'Invalid request', fields: [field] });
      expect(JSON.stringify(body)).not.toMatch(/details|fieldErrors|formErrors/);
      expect(mockCreateClient).not.toHaveBeenCalled();
      expect(mockLogAudit).toHaveBeenCalledTimes(1);
      const audit = mockLogAudit.mock.calls[0][0];
      expect(audit).toEqual(
        expect.objectContaining({
          action: 'admin.stockists.create',
          actor_id: 'admin-user',
          actor_email: 'admin@example.com',
          resource: 'stockists',
          outcome: 'failure',
          detail: 'Validation failed',
        }),
      );
      expect(audit).not.toHaveProperty('resource_id');
    },
  );

  it('DD-STOCKIST-034 POST は欄が足りない時に 400 を返す', async () => {
    const { holiday: _holiday, ...rest } = validBody;

    const response = await POST(jsonRequest(rest));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Invalid request', fields: ['holiday'] });
  });

  it('DD-STOCKIST-034 POST の insert の本文は前後の空白を除いた6つの値で type を含まない', async () => {
    const { from, insert, select } = setupInsert({ data: { id: 5 }, error: null });

    await POST(
      jsonRequest({
        name: '  Flagship  ',
        address: ' Tokyo ',
        phone: ' 03 ',
        time: ' 11-20 ',
        holiday: ' Wed ',
        status: 'published',
      }),
    );

    expect(from).toHaveBeenCalledWith('stockists');
    expect(insert).toHaveBeenCalledWith([
      {
        name: 'Flagship',
        address: 'Tokyo',
        phone: '03',
        time: '11-20',
        holiday: 'Wed',
        status: 'published',
      },
    ]);
    expect(insert.mock.calls[0][0][0]).not.toHaveProperty('type');
    expect(select).toHaveBeenCalledWith('id');
  });

  it('DD-STOCKIST-034 POST は insert に失敗した時に監査 error と 500 Failed to save stockist を返し、記録には符号だけを残す', async () => {
    setupInsert({ data: null, error: { message: 'null value in column type', code: '23502' } });

    const response = await POST(jsonRequest(validBody));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Failed to save stockist' });
    expect(mockLogAudit).toHaveBeenCalledTimes(1);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'admin.stockists.create',
        outcome: 'error',
        detail: 'DB insert failed',
      }),
    );
    expect(console.error).toHaveBeenCalledWith('Failed to create stockist:', { code: '23502' });
    expect(mockApplyCookie).not.toHaveBeenCalled();
  });

  it('DD-STOCKIST-034 POST は成功で監査 success と 201 を返し、回した CSRF の token を応答に付ける', async () => {
    setupInsert({ data: { id: 77 }, error: null });

    const response = await POST(jsonRequest(validBody));

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ success: true, id: 77 });
    expect(mockLogAudit).toHaveBeenCalledTimes(1);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'admin.stockists.create',
        actor_id: 'admin-user',
        actor_email: 'admin@example.com',
        resource: 'stockists',
        resource_id: '77',
        outcome: 'success',
        detail: 'Created stockist: Flagship',
      }),
    );
    expect(mockApplyCookie).toHaveBeenCalledWith(response, csrfResult);
  });

  it('DD-STOCKIST-034 POST は共有の確かめが何も返さない本番の形（undefined）でも成功し、Cookie の付け直しに undefined を渡す', async () => {
    mockRequireCsrf.mockResolvedValue(undefined);
    setupInsert({ data: { id: 77 }, error: null });

    const response = await POST(jsonRequest(validBody));

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ success: true, id: 77 });
    expect(mockLogAudit).toHaveBeenCalledTimes(1);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'admin.stockists.create',
        actor_id: 'admin-user',
        actor_email: 'admin@example.com',
        resource: 'stockists',
        resource_id: '77',
        outcome: 'success',
        detail: 'Created stockist: Flagship',
      }),
    );
    expect(mockApplyCookie).toHaveBeenCalledWith(response, undefined);
  });

  it('DD-STOCKIST-034 POST は監査の ip に x-forwarded-for の先頭を空白を除いて入れ、user_agent はその値を入れる', async () => {
    setupInsert({ data: { id: 1 }, error: null });

    await POST(
      jsonRequest(validBody, {
        'x-forwarded-for': ' 1.2.3.4 , 5.6.7.8',
        'user-agent': 'jest-agent',
      }),
    );

    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ ip: '1.2.3.4', user_agent: 'jest-agent' }),
    );
  });

  it('DD-STOCKIST-034 POST は x-forwarded-for と user-agent が無い時に監査の ip と user_agent を null にする', async () => {
    setupInsert({ data: { id: 1 }, error: null });
    const request = jsonRequest(validBody);
    request.headers.delete('user-agent');

    await POST(request);

    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ ip: null, user_agent: null }),
    );
  });

  it('DD-STOCKIST-034 POST は認可の後に例外が出た時に 500 Internal server error を返す', async () => {
    mockCreateClient.mockRejectedValue(new Error('boom'));

    const response = await POST(jsonRequest(validBody));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Internal server error' });
  });
});

describe('DD-STOCKIST-034 Cache-Control は戻りの全分岐で private, no-store', () => {
  const NO_STORE = 'private, no-store';
  // 下の応答の元は s-maxage=60 を持つ。包みが置き換えることも同時に確かめる。
  const response = (status: number) => ({
    status,
    body: {},
    headers: new Headers({ 'Cache-Control': 's-maxage=60' }),
  });

  const getCases: Array<[string, () => void, number]> = [
    ['200 一覧', () => setupSelect({ data: [], error: null }), 200],
    [
      '401 認可の拒否',
      () => mockAuthorize.mockResolvedValue({ ok: false, response: response(401) }),
      401,
    ],
    [
      '403 認可の拒否',
      () => mockAuthorize.mockResolvedValue({ ok: false, response: response(403) }),
      403,
    ],
    ['429 読みの回数制限', () => mockReadLimit.mockResolvedValue(response(429)), 429],
    ['503 読みの回数制限', () => mockReadLimit.mockResolvedValue(response(503)), 503],
    [
      '500 DB の誤り',
      () => setupSelect({ data: null, error: { code: '57P01', message: 'secret' } }),
      500,
    ],
    ['500 外側の catch', () => mockCreateClient.mockRejectedValue(new Error('secret boom')), 500],
  ];

  it.each(getCases)('DD-STOCKIST-034 GET %s', async (_label, arrange, status) => {
    arrange();

    const res = await GET(getRequest());

    expect(res.status).toBe(status);
    expect(res.headers.get('Cache-Control')).toBe(NO_STORE);
  });

  const brokenJsonRequest = () =>
    new Request('http://localhost/api/admin/stockists', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    });

  const postCases: Array<[string, () => void, number, () => Request]> = [
    ['201 作成', () => setupInsert({ data: { id: 1 }, error: null }), 201, () => jsonRequest(validBody)],
    ['400 壊れた JSON', () => undefined, 400, brokenJsonRequest],
    ['400 検証の誤り', () => undefined, 400, () => jsonRequest({ ...validBody, name: '' })],
    [
      '401 認可の拒否',
      () => mockAuthorize.mockResolvedValue({ ok: false, response: response(401) }),
      401,
      () => jsonRequest(validBody),
    ],
    [
      '403 認可の拒否',
      () => mockAuthorize.mockResolvedValue({ ok: false, response: response(403) }),
      403,
      () => jsonRequest(validBody),
    ],
    ['403 CSRF の拒否', () => mockToDeny.mockReturnValue(response(403)), 403, () => jsonRequest(validBody)],
    [
      '429 書きの回数制限',
      () => mockMutationLimit.mockResolvedValue(response(429)),
      429,
      () => jsonRequest(validBody),
    ],
    [
      '503 書きの回数制限',
      () => mockMutationLimit.mockResolvedValue(response(503)),
      503,
      () => jsonRequest(validBody),
    ],
    [
      '500 DB の誤り',
      () => setupInsert({ data: null, error: { code: '23502', message: 'secret' } }),
      500,
      () => jsonRequest(validBody),
    ],
    [
      '500 外側の catch',
      () => mockCreateClient.mockRejectedValue(new Error('secret boom')),
      500,
      () => jsonRequest(validBody),
    ],
  ];

  it.each(postCases)('DD-STOCKIST-034 POST %s', async (_label, arrange, status, makeRequest) => {
    arrange();

    const res = await POST(makeRequest());

    expect(res.status).toBe(status);
    expect(res.headers.get('Cache-Control')).toBe(NO_STORE);
  });

  it('DD-STOCKIST-034 外側の catch の console.error の第 2 引数は { name, code } ちょうどで、投げた誤りの message を含まない', async () => {
    mockCreateClient.mockRejectedValue(new Error('secret boom'));

    await GET(getRequest());
    await POST(jsonRequest(validBody));

    expect(console.error).toHaveBeenCalledWith('GET /api/admin/stockists error:', {
      name: 'Error',
      code: null,
    });
    expect(console.error).toHaveBeenCalledWith('POST /api/admin/stockists error:', {
      name: 'Error',
      code: null,
    });
    expect(JSON.stringify((console.error as jest.Mock).mock.calls)).not.toContain('secret boom');
  });
});
