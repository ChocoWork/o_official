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

jest.mock('@/lib/audit', () => ({
  logAudit: jest.fn(),
}));

jest.mock('@/lib/auth/admin-rbac', () => ({
  authorizeAdminPermission: jest.fn(),
}));

jest.mock('@/features/auth/middleware/rateLimit', () => ({
  enforceRateLimit: jest.fn(),
}));

import { GET, PATCH } from '@/app/api/admin/contact/[id]/route';

const { createServiceRoleClient } = require('@/lib/supabase/server');
const { logAudit } = require('@/lib/audit');
const { authorizeAdminPermission } = require('@/lib/auth/admin-rbac');
const { enforceRateLimit } = require('@/features/auth/middleware/rateLimit');

// モックの NextResponse.json が持たせる _body を型を通して読む
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const bodyOf = (res: unknown): any => (res as { _body: unknown })._body;

const INQUIRY_COLUMNS =
  'id, created_at, updated_at, last_message_at, name, email, inquiry_type, subject, message, status, order_id, user_id';
const MESSAGE_COLUMNS = 'id, sender_role, author_id, body, channel, created_at';

const INQUIRY_ID = '3f2b8c1e-5d4a-4b7e-9c2d-1a2b3c4d5e6f';
const ctx = { params: Promise.resolve({ id: INQUIRY_ID }) };

const inquiryRow = {
  id: INQUIRY_ID,
  name: '山田',
  email: 'y@example.com',
  subject: '質問',
  status: 'open',
  order_id: null as string | null,
};

// 問い合わせ1件の読み
const inquirySingle = jest.fn();
const inquiryEq = jest.fn();
const inquirySelect = jest.fn();
// やり取りの読み
const messagesOrder = jest.fn();
const messagesEq = jest.fn();
const messagesSelect = jest.fn();
// 状態の更新
const updateSelect = jest.fn();
const updateEq = jest.fn();
const update = jest.fn();
const from = jest.fn();

function makeJsonRequest(body: unknown, headers: Record<string, string> = {}) {
  return new Request('http://localhost/api/admin/contact/3f2b8c1e-5d4a-4b7e-9c2d-1a2b3c4d5e6f', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function makeGetRequest() {
  return new Request('http://localhost/api/admin/contact/3f2b8c1e-5d4a-4b7e-9c2d-1a2b3c4d5e6f', {
    headers: { 'x-real-ip': '198.51.100.7', 'user-agent': 'jest-agent' },
  });
}

describe('/api/admin/contact/[id]', () => {
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    inquirySingle.mockReset().mockResolvedValue({ data: inquiryRow, error: null });
    inquiryEq.mockReset().mockReturnValue({ single: inquirySingle });
    inquirySelect.mockReset().mockReturnValue({ eq: inquiryEq });
    messagesOrder.mockReset().mockResolvedValue({ data: [], error: null });
    messagesEq.mockReset().mockReturnValue({ order: messagesOrder });
    messagesSelect.mockReset().mockReturnValue({ eq: messagesEq });
    updateSelect.mockReset().mockResolvedValue({ data: [{ id: INQUIRY_ID }], error: null });
    updateEq.mockReset().mockReturnValue({ select: updateSelect });
    enforceRateLimit.mockReset().mockResolvedValue(null);
    update.mockReset().mockReturnValue({ eq: updateEq });
    from.mockReset().mockImplementation((table: string) =>
      table === 'contact_messages'
        ? { select: messagesSelect }
        : { select: inquirySelect, update }
    );
    createServiceRoleClient.mockReset().mockResolvedValue({ from });
    logAudit.mockReset();
    authorizeAdminPermission
      .mockReset()
      .mockResolvedValue({ ok: true, userId: 'admin-1', actorEmail: 'owner@example.com' });
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  describe('GET', () => {
    it('DD-ADMIN-007 GET は認可が ok:false の時は認可の応答を返し、DB を読まない', async () => {
      const response = { status: 403, json: async () => ({ error: 'Forbidden' }) };
      authorizeAdminPermission.mockResolvedValue({ ok: false, response });
      const request = makeGetRequest();

      const res = await GET(request, ctx);

      expect(res).toBe(response);
      expect(authorizeAdminPermission).toHaveBeenCalledWith('admin.contact.read', request);
      expect(createServiceRoleClient).not.toHaveBeenCalled();
    });

    it('DD-ADMIN-007 GET は問い合わせの読みが誤りの時は 404', async () => {
      inquirySingle.mockResolvedValue({ data: null, error: { message: 'bad id' } });

      const res = await GET(makeGetRequest(), ctx);

      expect(res.status).toBe(404);
      expect(bodyOf(res)).toEqual({ error: 'Inquiry not found' });
      expect(messagesSelect).not.toHaveBeenCalled();
    });

    it('DD-ADMIN-007 GET は行が空の時は 404', async () => {
      inquirySingle.mockResolvedValue({ data: null, error: null });

      const res = await GET(makeGetRequest(), ctx);

      expect(res.status).toBe(404);
      expect(bodyOf(res)).toEqual({ error: 'Inquiry not found' });
    });

    it('DD-ADMIN-007 GET はやり取りの読みが誤りの時は記録して 500 Failed to fetch messages', async () => {
      const dbError = { message: 'boom' };
      messagesOrder.mockResolvedValue({ data: null, error: dbError });

      const res = await GET(makeGetRequest(), ctx);

      expect(res.status).toBe(500);
      expect(bodyOf(res)).toEqual({ error: 'Failed to fetch messages' });
      expect(errorSpy).toHaveBeenCalledWith('Failed to fetch contact messages:', dbError);
    });

    it('DD-ADMIN-007 GET は注文の id がある時は注文番号が入る', async () => {
      inquirySingle.mockResolvedValue({
        data: { ...inquiryRow, order_id: 'a1b2c3d4-0000-0000-0000-000000000000' },
        error: null,
      });

      const res = await GET(makeGetRequest(), ctx);

      expect(res.status).toBe(200);
      expect(bodyOf(res).data.orderNumber).toBe('ORD-A1B2C3D4');
    });

    it('DD-ADMIN-007 GET は注文の id が無い時は注文番号が空で、やり取りが空なら空の配列', async () => {
      messagesOrder.mockResolvedValue({ data: null, error: null });

      const res = await GET(makeGetRequest(), ctx);

      expect(res.status).toBe(200);
      expect(bodyOf(res).data.orderNumber).toBeNull();
      expect(bodyOf(res).data.messages).toEqual([]);
    });

    it('DD-ADMIN-007 GET は問い合わせの列にやり取りを足して 200 で返す', async () => {
      const messages = [{ id: 'm1', sender_role: 'customer', body: 'こんにちは' }];
      messagesOrder.mockResolvedValue({ data: messages, error: null });

      const res = await GET(makeGetRequest(), ctx);

      expect(res.status).toBe(200);
      expect(bodyOf(res)).toEqual({ data: { ...inquiryRow, orderNumber: null, messages } });
      expect(from).toHaveBeenCalledWith('contact_inquiries');
      expect(inquirySelect).toHaveBeenCalledWith(INQUIRY_COLUMNS);
      expect(inquiryEq).toHaveBeenCalledWith('id', '3f2b8c1e-5d4a-4b7e-9c2d-1a2b3c4d5e6f');
    });

    it('DD-ADMIN-007 GET はやり取りを created_at の昇順で読む', async () => {
      await GET(makeGetRequest(), ctx);

      expect(from).toHaveBeenCalledWith('contact_messages');
      expect(messagesSelect).toHaveBeenCalledWith(MESSAGE_COLUMNS);
      expect(messagesEq).toHaveBeenCalledWith('inquiry_id', '3f2b8c1e-5d4a-4b7e-9c2d-1a2b3c4d5e6f');
      expect(messagesOrder).toHaveBeenCalledWith('created_at', { ascending: true });
    });

    it('DD-ADMIN-007 GET は select の文字列にも応答の data にも submitted_ip・user_agent を含めない', async () => {
      // DB の行が万一余分な列を持っていても、選ぶ列を名指ししているので送り元の情報は取り出さない
      const res = await GET(makeGetRequest(), ctx);

      const selected = inquirySelect.mock.calls[0][0] as string;
      expect(selected).not.toContain('submitted_ip');
      expect(selected).not.toContain('user_agent');
      expect(Object.keys(bodyOf(res).data)).not.toContain('submitted_ip');
      expect(Object.keys(bodyOf(res).data)).not.toContain('user_agent');
    });

    it('DD-ADMIN-007 GET は 200 の後に読んだ記録を1行残し、名前・メール・本文・件名を入れない', async () => {
      inquirySingle.mockResolvedValue({
        data: { ...inquiryRow, message: '本文のひみつ', subject: '件名のひみつ' },
        error: null,
      });

      const res = await GET(makeGetRequest(), ctx);

      expect(res.status).toBe(200);
      expect(logAudit).toHaveBeenCalledTimes(1);
      expect(logAudit).toHaveBeenCalledWith({
        action: 'admin.contact.read',
        actor_id: 'admin-1',
        actor_email: 'owner@example.com',
        resource: 'contact',
        resource_id: INQUIRY_ID,
        outcome: 'success',
        ip: '198.51.100.7',
        user_agent: 'jest-agent',
      });
      const logged = JSON.stringify(logAudit.mock.calls);
      for (const secret of ['山田', 'y@example.com', '質問', '本文のひみつ', '件名のひみつ']) {
        expect(logged).not.toContain(secret);
      }
    });

    it('DD-ADMIN-007 GET は 404・やり取りの読みの誤りの時は読んだ記録を書かない', async () => {
      inquirySingle.mockResolvedValueOnce({ data: null, error: null });
      await GET(makeGetRequest(), ctx);
      messagesOrder.mockResolvedValueOnce({ data: null, error: { message: 'boom' } });
      await GET(makeGetRequest(), ctx);

      expect(logAudit).not.toHaveBeenCalled();
    });

    it('DD-ADMIN-007 GET は監査の記録が例外を投げても 200 で返す（読み出しを止めない）', async () => {
      logAudit.mockRejectedValue(new Error('audit down'));

      const res = await GET(makeGetRequest(), ctx);

      expect(res.status).toBe(200);
      expect(bodyOf(res).data.id).toBe(INQUIRY_ID);
      expect(errorSpy).toHaveBeenCalledWith('Failed to write contact read audit');
    });

    it('DD-ADMIN-007 GET は createServiceRoleClient が例外を投げた時は 500 Internal server error', async () => {
      createServiceRoleClient.mockRejectedValue(new Error('no client'));

      const res = await GET(makeGetRequest(), ctx);

      expect(res.status).toBe(500);
      expect(bodyOf(res)).toEqual({ error: 'Internal server error' });
    });
  });

  describe('PATCH', () => {
    it('DD-ADMIN-007 PATCH は認可が ok:false の時は認可の応答を返し、何も書かない', async () => {
      const response = { status: 403, json: async () => ({ error: 'Forbidden' }) };
      authorizeAdminPermission.mockResolvedValue({ ok: false, response });
      const request = makeJsonRequest({ status: 'closed' });

      const res = await PATCH(request, ctx);

      expect(res).toBe(response);
      expect(authorizeAdminPermission).toHaveBeenCalledWith('admin.contact.manage', request);
      expect(update).not.toHaveBeenCalled();
      expect(logAudit).not.toHaveBeenCalled();
    });

    it('DD-ADMIN-007 PATCH は本文が JSON でない時は 400 で details を返す', async () => {
      const res = await PATCH(makeJsonRequest('not-json{'), ctx);

      expect(res.status).toBe(400);
      expect(bodyOf(res).error).toBe('Invalid request');
      expect(bodyOf(res).details).toBeDefined();
      expect(update).not.toHaveBeenCalled();
      expect(logAudit).not.toHaveBeenCalled();
    });

    it('DD-ADMIN-007 PATCH は status=done の時は 400 で details を返す', async () => {
      const res = await PATCH(makeJsonRequest({ status: 'done' }), ctx);

      expect(res.status).toBe(400);
      expect(bodyOf(res).error).toBe('Invalid request');
      expect(bodyOf(res).details.fieldErrors.status).toBeDefined();
      expect(update).not.toHaveBeenCalled();
    });

    it('DD-ADMIN-007 PATCH は status=closed で状態と直した時刻を更新し、200 で監査に status=closed を書く', async () => {
      const res = await PATCH(
        makeJsonRequest({ status: 'closed' }, { 'user-agent': 'jest-agent', 'x-real-ip': '198.51.100.7' }),
        ctx
      );

      expect(res.status).toBe(200);
      expect(bodyOf(res)).toEqual({ success: true });
      expect(from).toHaveBeenCalledWith('contact_inquiries');
      expect(update).toHaveBeenCalledWith({
        status: 'closed',
        updated_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      });
      expect(update.mock.calls[0][0]).not.toHaveProperty('last_message_at');
      expect(updateEq).toHaveBeenCalledWith('id', '3f2b8c1e-5d4a-4b7e-9c2d-1a2b3c4d5e6f');
      expect(logAudit).toHaveBeenCalledWith({
        action: 'admin.contact.status_update',
        actor_id: 'admin-1',
        actor_email: 'owner@example.com',
        resource: 'contact',
        resource_id: '3f2b8c1e-5d4a-4b7e-9c2d-1a2b3c4d5e6f',
        outcome: 'success',
        detail: 'status=closed',
        ip: '198.51.100.7',
        user_agent: 'jest-agent',
      });
    });

    it('DD-ADMIN-007 PATCH は更新が誤りを返した時は記録して 500 Failed to update status で、監査を書かない', async () => {
      const dbError = { message: 'boom' };
      updateSelect.mockResolvedValue({ data: null, error: dbError });

      const res = await PATCH(makeJsonRequest({ status: 'pending' }), ctx);

      expect(res.status).toBe(500);
      expect(bodyOf(res)).toEqual({ error: 'Failed to update status' });
      expect(errorSpy).toHaveBeenCalledWith('Failed to update inquiry status:', dbError);
      expect(logAudit).not.toHaveBeenCalled();
    });

    it('DD-ADMIN-007 PATCH は回数の枠を認可の直後に管理者の ID だけで数え（admin:contact:write・60・600秒）、超えたら 429 で DB に触らない', async () => {
      const limited = { status: 429, _body: { error: 'Too many requests' } };
      enforceRateLimit.mockResolvedValue(limited);
      const request = makeJsonRequest({ status: 'closed' });

      const res = await PATCH(request, ctx);

      expect(res).toBe(limited);
      expect(enforceRateLimit).toHaveBeenCalledWith({
        request,
        endpoint: 'admin:contact:write',
        limit: 60,
        windowSeconds: 600,
        subject: 'admin-1',
      });
      expect(createServiceRoleClient).not.toHaveBeenCalled();
      expect(logAudit).not.toHaveBeenCalled();
    });

    it('DD-ADMIN-007 PATCH は認可で断った要求を回数に数えない', async () => {
      authorizeAdminPermission.mockResolvedValue({ ok: false, response: { status: 403 } });

      await PATCH(makeJsonRequest({ status: 'closed' }), ctx);

      expect(enforceRateLimit).not.toHaveBeenCalled();
    });

    it('DD-ADMIN-007 PATCH は id が UUID でない時は DB に渡さず 404 を返し、何も書かない', async () => {
      const res = await PATCH(makeJsonRequest({ status: 'closed' }), { params: Promise.resolve({ id: 'inq-1' }) });

      expect(res.status).toBe(404);
      expect(bodyOf(res)).toEqual({ error: 'Inquiry not found' });
      expect(createServiceRoleClient).not.toHaveBeenCalled();
      expect(logAudit).not.toHaveBeenCalled();
    });

    it.each([
      ['0 行', []],
      ['行が空', null],
    ])('DD-ADMIN-007 PATCH は更新が %s の時は 404 で、失敗を監査に残し、成功は書かない', async (_label, data) => {
      updateSelect.mockResolvedValue({ data, error: null });

      const res = await PATCH(
        makeJsonRequest({ status: 'closed' }, { 'user-agent': 'jest-agent', 'x-real-ip': '198.51.100.7' }),
        ctx
      );

      expect(updateSelect).toHaveBeenCalledWith('id');
      expect(res.status).toBe(404);
      expect(bodyOf(res)).toEqual({ error: 'Inquiry not found' });
      expect(logAudit).toHaveBeenCalledTimes(1);
      expect(logAudit).toHaveBeenCalledWith({
        action: 'admin.contact.status_update',
        actor_id: 'admin-1',
        actor_email: 'owner@example.com',
        resource: 'contact',
        resource_id: INQUIRY_ID,
        outcome: 'failure',
        detail: 'inquiry_not_found',
        ip: '198.51.100.7',
        user_agent: 'jest-agent',
      });
    });

    it('DD-ADMIN-007 PATCH は更新が1行なら 200 で success を書く', async () => {
      const res = await PATCH(makeJsonRequest({ status: 'answered' }), ctx);

      expect(res.status).toBe(200);
      expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'success', detail: 'status=answered' }));
    });

    it('DD-ADMIN-007 PATCH は createServiceRoleClient が例外を投げた時は 500 Internal server error', async () => {
      createServiceRoleClient.mockRejectedValue(new Error('no client'));

      const res = await PATCH(makeJsonRequest({ status: 'open' }), ctx);

      expect(res.status).toBe(500);
      expect(bodyOf(res)).toEqual({ error: 'Internal server error' });
    });
  });
});
