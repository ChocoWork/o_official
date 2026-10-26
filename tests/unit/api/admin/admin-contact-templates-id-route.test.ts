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

const { PUT, DELETE } = require('@/app/api/admin/contact/templates/[id]/route');

const TPL_ID = '5b0f4c1e-7a2d-4e6f-8b3c-9d1e2f3a4b5c';
const TPL_ID_9 = '5b0f4c1e-7a2d-4e6f-8b3c-9d1e2f3a4b09';
const DENIED = { status: 403, json: async () => ({ error: 'Forbidden' }) };
const LIMITED = { status: 429, json: async () => ({ error: 'Too many requests' }) };
const ctx = (id = TPL_ID) => ({ params: Promise.resolve({ id }) });

function makeRequest(body?: unknown, opts: { brokenJson?: boolean } = {}) {
  return {
    json: opts.brokenJson ? () => Promise.reject(new SyntaxError('bad json')) : async () => body,
    headers: { get: (name: string) => (name.toLowerCase() === 'user-agent' ? 'jest-agent' : null) },
  } as unknown as Request;
}

// 更新・削除は .eq('id').select('id') で変えた行を受け取る。既定は1行を変えた形
function makeUpdateClient(result: { error: unknown; data?: unknown }) {
  const select = jest.fn().mockResolvedValue({ data: [{ id: TPL_ID }], ...result });
  const eq = jest.fn().mockReturnValue({ select });
  const update = jest.fn().mockReturnValue({ eq });
  const from = jest.fn().mockReturnValue({ update });
  return { client: { from }, from, update, eq, select };
}

function makeDeleteClient(result: { error: unknown; data?: unknown }) {
  const select = jest.fn().mockResolvedValue({ data: [{ id: TPL_ID }], ...result });
  const eq = jest.fn().mockReturnValue({ select });
  const del = jest.fn().mockReturnValue({ eq });
  const from = jest.fn().mockReturnValue({ delete: del });
  return { client: { from }, from, del, eq, select };
}

const validBody = { title: '発送のご案内', body: '本日発送しました。' };

describe('admin contact templates [id] route (update and delete)', () => {
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    mockAuthorize.mockResolvedValue({ ok: true, userId: 'admin-1' });
    mockEnforceRateLimit.mockReset().mockResolvedValue(null);
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  describe('PUT', () => {
    it('DD-ADMIN-010 PUT は admin.contact.manage で認可し、失敗なら認可の応答をそのまま返す', async () => {
      mockAuthorize.mockResolvedValue({ ok: false, response: DENIED });
      const request = makeRequest(validBody);

      const res = await PUT(request, ctx());

      expect(mockAuthorize).toHaveBeenCalledWith('admin.contact.manage', request);
      expect(res).toBe(DENIED);
      expect(mockCreateServiceRoleClient).not.toHaveBeenCalled();
      expect(mockLogAudit).not.toHaveBeenCalled();
    });

    it.each([
      ['本文が JSON でない時', () => makeRequest(undefined, { brokenJson: true })],
      ['題が空白だけの時', () => makeRequest({ ...validBody, title: '   ' })],
      ['題が 121 字の時', () => makeRequest({ ...validBody, title: 'あ'.repeat(121) })],
      ['本文が 5001 字の時', () => makeRequest({ ...validBody, body: 'あ'.repeat(5001) })],
      ['分類が bogus の時', () => makeRequest({ ...validBody, category: 'bogus' })],
      ['並び順が 10000 の時', () => makeRequest({ ...validBody, sortOrder: 10000 })],
    ])('DD-ADMIN-010 PUT は %s 400 Invalid request を返し何も書かない', async (_label, build) => {
      const res = await PUT(build(), ctx());

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe('Invalid request');
      expect(json.details).toBeDefined();
      expect(mockCreateServiceRoleClient).not.toHaveBeenCalled();
      expect(mockLogAudit).not.toHaveBeenCalled();
    });

    it('DD-ADMIN-010 PUT は並び順がある時 sort_order を含めて書き、200 と監査を返す', async () => {
      const { client, from, update, eq } = makeUpdateClient({ error: null });
      mockCreateServiceRoleClient.mockResolvedValue(client);

      const res = await PUT(makeRequest({ ...validBody, category: 'product', sortOrder: 5 }), ctx(TPL_ID_9));

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ success: true });
      expect(from).toHaveBeenCalledWith('contact_reply_templates');
      expect(update).toHaveBeenCalledWith({
        title: validBody.title,
        category: 'product',
        body: validBody.body,
        sort_order: 5,
        updated_at: expect.any(String),
      });
      expect(eq).toHaveBeenCalledWith('id', TPL_ID_9);
      expect(mockLogAudit).toHaveBeenCalledWith({
        action: 'admin.contact.template.update',
        actor_id: 'admin-1',
        resource: 'contact_reply_template',
        resource_id: TPL_ID_9,
        outcome: 'success',
        detail: 'updated',
        user_agent: 'jest-agent',
      });
    });

    it('DD-ADMIN-010 PUT は並び順が 0 の時も sort_order を書く', async () => {
      const { client, update } = makeUpdateClient({ error: null });
      mockCreateServiceRoleClient.mockResolvedValue(client);

      const res = await PUT(makeRequest({ ...validBody, sortOrder: 0 }), ctx());

      expect(res.status).toBe(200);
      expect(update.mock.calls[0][0]).toHaveProperty('sort_order', 0);
    });

    it('DD-ADMIN-010 PUT は並び順が無い時 sort_order を含めず、分類が無ければ空で書く', async () => {
      const { client, update } = makeUpdateClient({ error: null });
      mockCreateServiceRoleClient.mockResolvedValue(client);

      const res = await PUT(makeRequest({ title: '  題  ', body: '  本文  ' }), ctx());

      expect(res.status).toBe(200);
      const written = update.mock.calls[0][0];
      expect(written).not.toHaveProperty('sort_order');
      expect(written).toEqual({
        title: '題',
        category: null,
        body: '本文',
        updated_at: expect.any(String),
      });
      expect(Number.isNaN(Date.parse(written.updated_at))).toBe(false);
    });

    it('DD-ADMIN-010 PUT は更新が誤りを返した時 500 Failed to update template で監査を書かない', async () => {
      const dbError = { message: 'update failed' };
      const { client } = makeUpdateClient({ error: dbError });
      mockCreateServiceRoleClient.mockResolvedValue(client);

      const res = await PUT(makeRequest(validBody), ctx());

      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'Failed to update template' });
      expect(errorSpy).toHaveBeenCalledWith('Failed to update reply template:', dbError);
      expect(mockLogAudit).not.toHaveBeenCalled();
    });

    it.each([
      ['行が 0 件', []],
      ['行が空', null],
    ])('DD-ADMIN-010 PUT は対象の %s の時 404 Template not found で、失敗を監査に残し、成功は書かない', async (_label, data) => {
      const { client, select } = makeUpdateClient({ error: null, data });
      mockCreateServiceRoleClient.mockResolvedValue(client);

      const res = await PUT(makeRequest(validBody), ctx());

      expect(select).toHaveBeenCalledWith('id');
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'Template not found' });
      expect(mockLogAudit).toHaveBeenCalledTimes(1);
      expect(mockLogAudit).toHaveBeenCalledWith({
        action: 'admin.contact.template.update',
        actor_id: 'admin-1',
        resource: 'contact_reply_template',
        resource_id: TPL_ID,
        outcome: 'failure',
        detail: 'template_not_found',
        user_agent: 'jest-agent',
      });
    });

    it('DD-ADMIN-010 PUT は id が UUID でない時 DB に渡さず 404 Template not found を返し、何も書かない', async () => {
      const res = await PUT(makeRequest(validBody), ctx('tpl-1'));

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'Template not found' });
      expect(mockCreateServiceRoleClient).not.toHaveBeenCalled();
      expect(mockLogAudit).not.toHaveBeenCalled();
    });

    it('DD-ADMIN-010 PUT は回数の枠を認可の直後に管理者の ID だけで数え（admin:contact:write・60・600秒）、超えたら 429 で DB を呼ばない', async () => {
      mockEnforceRateLimit.mockResolvedValue(LIMITED);
      const request = makeRequest(validBody);

      const res = await PUT(request, ctx());

      expect(res).toBe(LIMITED);
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

    it('DD-ADMIN-010 PUT は認可で断った要求を回数に数えない', async () => {
      mockAuthorize.mockResolvedValue({ ok: false, response: DENIED });

      await PUT(makeRequest(validBody), ctx());

      expect(mockEnforceRateLimit).not.toHaveBeenCalled();
    });

    it('DD-ADMIN-010 PUT は createServiceRoleClient が例外を投げた時 500 Internal server error', async () => {
      mockCreateServiceRoleClient.mockRejectedValue(new Error('no client'));

      const res = await PUT(makeRequest(validBody), ctx());

      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'Internal server error' });
      expect(mockLogAudit).not.toHaveBeenCalled();
    });

    it('DD-ADMIN-010 PUT は params が拒否された時 500 Internal server error', async () => {
      const res = await PUT(makeRequest(validBody), { params: Promise.reject(new Error('bad params')) });

      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'Internal server error' });
      expect(mockAuthorize).not.toHaveBeenCalled();
    });
  });

  describe('DELETE', () => {
    it('DD-ADMIN-010 DELETE は admin.contact.manage で認可し、失敗なら認可の応答をそのまま返す', async () => {
      mockAuthorize.mockResolvedValue({ ok: false, response: DENIED });
      const request = makeRequest();

      const res = await DELETE(request, ctx());

      expect(mockAuthorize).toHaveBeenCalledWith('admin.contact.manage', request);
      expect(res).toBe(DENIED);
      expect(mockCreateServiceRoleClient).not.toHaveBeenCalled();
      expect(mockLogAudit).not.toHaveBeenCalled();
    });

    it('DD-ADMIN-010 DELETE は id で消して 200 を返し、監査に admin.contact.template.delete を書く', async () => {
      const { client, from, del, eq } = makeDeleteClient({ error: null });
      mockCreateServiceRoleClient.mockResolvedValue(client);

      const res = await DELETE(makeRequest(), ctx(TPL_ID_9));

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ success: true });
      expect(from).toHaveBeenCalledWith('contact_reply_templates');
      expect(del).toHaveBeenCalled();
      expect(eq).toHaveBeenCalledWith('id', TPL_ID_9);
      expect(mockLogAudit).toHaveBeenCalledWith({
        action: 'admin.contact.template.delete',
        actor_id: 'admin-1',
        resource: 'contact_reply_template',
        resource_id: TPL_ID_9,
        outcome: 'success',
        detail: 'deleted',
        user_agent: 'jest-agent',
      });
    });

    it('DD-ADMIN-010 DELETE は削除が誤りを返した時 500 Failed to delete template で監査を書かない', async () => {
      const dbError = { message: 'delete failed' };
      const { client } = makeDeleteClient({ error: dbError });
      mockCreateServiceRoleClient.mockResolvedValue(client);

      const res = await DELETE(makeRequest(), ctx());

      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'Failed to delete template' });
      expect(errorSpy).toHaveBeenCalledWith('Failed to delete reply template:', dbError);
      expect(mockLogAudit).not.toHaveBeenCalled();
    });

    it.each([
      ['行が 0 件', []],
      ['行が空', null],
    ])('DD-ADMIN-010 DELETE は対象の %s の時 404 Template not found で、失敗を監査に残し、成功は書かない', async (_label, data) => {
      const { client, select } = makeDeleteClient({ error: null, data });
      mockCreateServiceRoleClient.mockResolvedValue(client);

      const res = await DELETE(makeRequest(), ctx());

      expect(select).toHaveBeenCalledWith('id');
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'Template not found' });
      expect(mockLogAudit).toHaveBeenCalledTimes(1);
      expect(mockLogAudit).toHaveBeenCalledWith({
        action: 'admin.contact.template.delete',
        actor_id: 'admin-1',
        resource: 'contact_reply_template',
        resource_id: TPL_ID,
        outcome: 'failure',
        detail: 'template_not_found',
        user_agent: 'jest-agent',
      });
    });

    it('DD-ADMIN-010 DELETE は id が UUID でない時 DB に渡さず 404 Template not found を返し、何も書かない', async () => {
      const res = await DELETE(makeRequest(), ctx('tpl-1'));

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'Template not found' });
      expect(mockCreateServiceRoleClient).not.toHaveBeenCalled();
      expect(mockLogAudit).not.toHaveBeenCalled();
    });

    it('DD-ADMIN-010 DELETE は回数の枠を認可の直後に管理者の ID だけで数え（admin:contact:write・60・600秒）、超えたら 429 で DB を呼ばない', async () => {
      mockEnforceRateLimit.mockResolvedValue(LIMITED);
      const request = makeRequest();

      const res = await DELETE(request, ctx());

      expect(res).toBe(LIMITED);
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

    it('DD-ADMIN-010 DELETE は認可で断った要求を回数に数えない', async () => {
      mockAuthorize.mockResolvedValue({ ok: false, response: DENIED });

      await DELETE(makeRequest(), ctx());

      expect(mockEnforceRateLimit).not.toHaveBeenCalled();
    });

    it('DD-ADMIN-010 DELETE は createServiceRoleClient が例外を投げた時 500 Internal server error', async () => {
      mockCreateServiceRoleClient.mockRejectedValue(new Error('no client'));

      const res = await DELETE(makeRequest(), ctx());

      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'Internal server error' });
      expect(mockLogAudit).not.toHaveBeenCalled();
    });
  });
});
