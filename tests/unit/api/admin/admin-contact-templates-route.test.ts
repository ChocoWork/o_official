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
  createServiceRoleClient: jest.fn(),
}));

jest.mock('@/lib/auth/admin-rbac', () => ({
  authorizeAdminPermission: jest.fn(),
}));

jest.mock('@/lib/audit', () => ({
  logAudit: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/features/auth/middleware/rateLimit', () => ({
  enforceRateLimit: jest.fn(),
}));

const { createServiceRoleClient: mockCreateServiceRoleClient } = require('@/lib/supabase/server');
const { authorizeAdminPermission: mockAuthorize } = require('@/lib/auth/admin-rbac');
const { logAudit: mockLogAudit } = require('@/lib/audit');
const { enforceRateLimit: mockEnforceRateLimit } = require('@/features/auth/middleware/rateLimit');

const { GET, POST } = require('@/app/api/admin/contact/templates/route');

const DENIED = { status: 403, json: async () => ({ error: 'Forbidden' }) };

function makeRequest(body: unknown, opts: { brokenJson?: boolean } = {}) {
  return {
    json: opts.brokenJson ? () => Promise.reject(new SyntaxError('bad json')) : async () => body,
    headers: {
      get: (name: string) => {
        const key = name.toLowerCase();
        return key === 'user-agent' ? 'jest-agent' : key === 'x-real-ip' ? '198.51.100.7' : null;
      },
    },
  } as unknown as Request;
}

function makeListClient(result: { data: unknown; error: unknown }) {
  const order = jest.fn();
  order.mockReturnValueOnce({ order });
  order.mockResolvedValueOnce(result);
  const select = jest.fn().mockReturnValue({ order });
  const from = jest.fn().mockReturnValue({ select });
  return { client: { from }, from, select, order };
}

function makeInsertClient(result: { data: unknown; error: unknown }) {
  const single = jest.fn().mockResolvedValue(result);
  const select = jest.fn().mockReturnValue({ single });
  const insert = jest.fn().mockReturnValue({ select });
  const from = jest.fn().mockReturnValue({ insert });
  return { client: { from }, from, insert, select, single };
}

const validBody = { title: '発送のご案内', body: '本日発送しました。' };

describe('admin contact templates route (list and create)', () => {
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    mockAuthorize.mockResolvedValue({ ok: true, userId: 'admin-1', actorEmail: 'owner@example.com' });
    mockEnforceRateLimit.mockReset().mockResolvedValue(null);
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  describe('GET', () => {
    it('DD-ADMIN-009 GET は admin.contact.read で認可し、失敗なら認可の応答をそのまま返す', async () => {
      mockAuthorize.mockResolvedValue({ ok: false, response: DENIED });
      const request = makeRequest(undefined);

      const res = await GET(request);

      expect(mockAuthorize).toHaveBeenCalledWith('admin.contact.read', request);
      expect(res).toBe(DENIED);
      expect(mockCreateServiceRoleClient).not.toHaveBeenCalled();
    });

    it('DD-ADMIN-009 GET は sort_order と created_at の昇順で読み 200 で返す', async () => {
      const rows = [
        { id: 't1', title: 'A', category: null, body: 'a', sort_order: 0, created_at: 'c1', updated_at: 'u1' },
        { id: 't2', title: 'B', category: 'order', body: 'b', sort_order: 1, created_at: 'c2', updated_at: 'u2' },
      ];
      const { client, from, select, order } = makeListClient({ data: rows, error: null });
      mockCreateServiceRoleClient.mockResolvedValue(client);

      const res = await GET(makeRequest(undefined));

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ data: rows });
      expect(from).toHaveBeenCalledWith('contact_reply_templates');
      expect(select).toHaveBeenCalledWith('id, title, category, body, sort_order, created_at, updated_at');
      expect(order).toHaveBeenNthCalledWith(1, 'sort_order', { ascending: true });
      expect(order).toHaveBeenNthCalledWith(2, 'created_at', { ascending: true });
    });

    it('DD-ADMIN-009 GET は行が null でも空の配列を返す', async () => {
      const { client } = makeListClient({ data: null, error: null });
      mockCreateServiceRoleClient.mockResolvedValue(client);

      const res = await GET(makeRequest(undefined));

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ data: [] });
    });

    it('DD-ADMIN-009 GET は読みが誤りを返した時 500 Failed to fetch templates', async () => {
      const dbError = { message: 'boom' };
      const { client } = makeListClient({ data: null, error: dbError });
      mockCreateServiceRoleClient.mockResolvedValue(client);

      const res = await GET(makeRequest(undefined));

      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'Failed to fetch templates' });
      expect(errorSpy).toHaveBeenCalledWith('Failed to fetch reply templates:', dbError);
    });

    it('DD-ADMIN-009 GET は createServiceRoleClient が例外を投げた時 500 Internal server error', async () => {
      mockCreateServiceRoleClient.mockRejectedValue(new Error('no client'));

      const res = await GET(makeRequest(undefined));

      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'Internal server error' });
    });
  });

  describe('POST', () => {
    it('DD-ADMIN-009 POST は admin.contact.manage で認可し、失敗なら認可の応答をそのまま返す', async () => {
      mockAuthorize.mockResolvedValue({ ok: false, response: DENIED });
      const request = makeRequest(validBody);

      const res = await POST(request);

      expect(mockAuthorize).toHaveBeenCalledWith('admin.contact.manage', request);
      expect(res).toBe(DENIED);
      expect(mockCreateServiceRoleClient).not.toHaveBeenCalled();
      expect(mockLogAudit).not.toHaveBeenCalled();
    });

    it('DD-ADMIN-009 POST は回数の枠を認可の直後に管理者の ID だけで数え（admin:contact:write・60・600秒）、超えたら 429 で DB を呼ばず何も書かない', async () => {
      const limited = { status: 429, json: async () => ({ error: 'Too many requests' }) };
      mockEnforceRateLimit.mockResolvedValue(limited);
      const request = makeRequest(validBody);

      const res = await POST(request);

      expect(res).toBe(limited);
      expect(mockEnforceRateLimit).toHaveBeenCalledWith({
        request,
        endpoint: 'admin:contact:write',
        limit: 60,
        windowSeconds: 600,
        subject: 'admin-1',
      });
      expect(mockCreateServiceRoleClient).not.toHaveBeenCalled();
      expect(mockLogAudit).not.toHaveBeenCalled();
    });

    it('DD-ADMIN-009 POST は認可で断った要求を回数に数えない', async () => {
      mockAuthorize.mockResolvedValue({ ok: false, response: DENIED });

      await POST(makeRequest(validBody));

      expect(mockEnforceRateLimit).not.toHaveBeenCalled();
    });

    it.each([
      ['本文が JSON でない時', () => makeRequest(undefined, { brokenJson: true })],
      ['本文が null の時', () => makeRequest(null)],
      ['題が空白だけの時', () => makeRequest({ ...validBody, title: '   ' })],
      ['題が 121 字の時', () => makeRequest({ ...validBody, title: 'あ'.repeat(121) })],
      ['本文が空白だけの時', () => makeRequest({ ...validBody, body: '  ' })],
      ['本文が 5001 字の時', () => makeRequest({ ...validBody, body: 'あ'.repeat(5001) })],
      ['分類が bogus の時', () => makeRequest({ ...validBody, category: 'bogus' })],
      ['並び順が 10000 の時', () => makeRequest({ ...validBody, sortOrder: 10000 })],
      ['並び順が負の時', () => makeRequest({ ...validBody, sortOrder: -1 })],
      ['並び順が整数でない時', () => makeRequest({ ...validBody, sortOrder: 1.5 })],
    ])('DD-ADMIN-009 POST は %s 400 Invalid request を返し何も書かない', async (_label, build) => {
      const res = await POST(build());

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe('Invalid request');
      expect(json.details).toBeDefined();
      expect(mockCreateServiceRoleClient).not.toHaveBeenCalled();
      expect(mockLogAudit).not.toHaveBeenCalled();
    });

    it('DD-ADMIN-009 POST は分類と並び順が無い時 分類を空・並び順 0 で作り 201 と監査を返す', async () => {
      const { client, from, insert, select, single } = makeInsertClient({ data: { id: 'new-1' }, error: null });
      mockCreateServiceRoleClient.mockResolvedValue(client);

      const res = await POST(makeRequest({ title: '  題  ', body: '  本文  ' }));

      expect(res.status).toBe(201);
      expect(await res.json()).toEqual({ success: true, id: 'new-1' });
      expect(from).toHaveBeenCalledWith('contact_reply_templates');
      expect(insert).toHaveBeenCalledWith([{ title: '題', category: null, body: '本文', sort_order: 0 }]);
      expect(select).toHaveBeenCalledWith('id');
      expect(single).toHaveBeenCalled();
      expect(mockLogAudit).toHaveBeenCalledWith({
        action: 'admin.contact.template.create',
        actor_id: 'admin-1',
        actor_email: 'owner@example.com',
        resource: 'contact_reply_template',
        resource_id: 'new-1',
        outcome: 'success',
        detail: 'created',
        ip: '198.51.100.7',
        user_agent: 'jest-agent',
      });
    });

    it('DD-ADMIN-009 POST は分類と並び順がある時 その値で作る', async () => {
      const { client, insert } = makeInsertClient({ data: { id: 'new-2' }, error: null });
      mockCreateServiceRoleClient.mockResolvedValue(client);

      const res = await POST(makeRequest({ ...validBody, category: 'order', sortOrder: 7 }));

      expect(res.status).toBe(201);
      expect(insert).toHaveBeenCalledWith([
        { title: validBody.title, category: 'order', body: validBody.body, sort_order: 7 },
      ]);
    });

    it('DD-ADMIN-009 POST は分類が null で並び順が 0 でも受けて 0 を書く', async () => {
      const { client, insert } = makeInsertClient({ data: { id: 'new-3' }, error: null });
      mockCreateServiceRoleClient.mockResolvedValue(client);

      const res = await POST(makeRequest({ ...validBody, category: null, sortOrder: 0 }));

      expect(res.status).toBe(201);
      expect(insert).toHaveBeenCalledWith([
        { title: validBody.title, category: null, body: validBody.body, sort_order: 0 },
      ]);
    });

    it('DD-ADMIN-009 POST は作成が誤りを返した時 500 Failed to create template で監査を書かない', async () => {
      const dbError = { message: 'insert failed' };
      const { client } = makeInsertClient({ data: null, error: dbError });
      mockCreateServiceRoleClient.mockResolvedValue(client);

      const res = await POST(makeRequest(validBody));

      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'Failed to create template' });
      expect(errorSpy).toHaveBeenCalledWith('Failed to create reply template:', dbError);
      expect(mockLogAudit).not.toHaveBeenCalled();
    });

    it('DD-ADMIN-009 POST は作った行が返らない時 500 Failed to create template で監査を書かない', async () => {
      const { client } = makeInsertClient({ data: null, error: null });
      mockCreateServiceRoleClient.mockResolvedValue(client);

      const res = await POST(makeRequest(validBody));

      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'Failed to create template' });
      expect(mockLogAudit).not.toHaveBeenCalled();
    });

    it('DD-ADMIN-009 POST は createServiceRoleClient が例外を投げた時 500 Internal server error', async () => {
      mockCreateServiceRoleClient.mockRejectedValue(new Error('no client'));

      const res = await POST(makeRequest(validBody));

      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'Internal server error' });
      expect(mockLogAudit).not.toHaveBeenCalled();
    });
  });
});
