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

import { GET, PATCH } from '@/app/api/admin/contact/[id]/route';

const { createServiceRoleClient } = require('@/lib/supabase/server');
const { logAudit } = require('@/lib/audit');
const { authorizeAdminPermission } = require('@/lib/auth/admin-rbac');

// モックの NextResponse.json が持たせる _body を型を通して読む
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const bodyOf = (res: unknown): any => (res as { _body: unknown })._body;

const INQUIRY_COLUMNS =
  'id, created_at, updated_at, last_message_at, name, email, inquiry_type, subject, message, status, order_id, user_id, submitted_ip, user_agent';
const MESSAGE_COLUMNS = 'id, sender_role, author_id, body, channel, created_at';

const ctx = { params: Promise.resolve({ id: 'inq-1' }) };

const inquiryRow = {
  id: 'inq-1',
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
const updateEq = jest.fn();
const update = jest.fn();
const from = jest.fn();

function makeJsonRequest(body: unknown, headers: Record<string, string> = {}) {
  return new Request('http://localhost/api/admin/contact/inq-1', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function makeGetRequest() {
  return new Request('http://localhost/api/admin/contact/inq-1');
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
    updateEq.mockReset().mockResolvedValue({ error: null });
    update.mockReset().mockReturnValue({ eq: updateEq });
    from.mockReset().mockImplementation((table: string) =>
      table === 'contact_messages'
        ? { select: messagesSelect }
        : { select: inquirySelect, update }
    );
    createServiceRoleClient.mockReset().mockResolvedValue({ from });
    logAudit.mockReset();
    authorizeAdminPermission.mockReset().mockResolvedValue({ ok: true, userId: 'admin-1' });
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
      expect(inquiryEq).toHaveBeenCalledWith('id', 'inq-1');
    });

    it('DD-ADMIN-007 GET はやり取りを created_at の昇順で読む', async () => {
      await GET(makeGetRequest(), ctx);

      expect(from).toHaveBeenCalledWith('contact_messages');
      expect(messagesSelect).toHaveBeenCalledWith(MESSAGE_COLUMNS);
      expect(messagesEq).toHaveBeenCalledWith('inquiry_id', 'inq-1');
      expect(messagesOrder).toHaveBeenCalledWith('created_at', { ascending: true });
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
        makeJsonRequest({ status: 'closed' }, { 'user-agent': 'jest-agent' }),
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
      expect(updateEq).toHaveBeenCalledWith('id', 'inq-1');
      expect(logAudit).toHaveBeenCalledWith({
        action: 'admin.contact.status_update',
        actor_id: 'admin-1',
        resource: 'contact',
        resource_id: 'inq-1',
        outcome: 'success',
        detail: 'status=closed',
        user_agent: 'jest-agent',
      });
    });

    it('DD-ADMIN-007 PATCH は更新が誤りを返した時は記録して 500 Failed to update status で、監査を書かない', async () => {
      const dbError = { message: 'boom' };
      updateEq.mockResolvedValue({ error: dbError });

      const res = await PATCH(makeJsonRequest({ status: 'pending' }), ctx);

      expect(res.status).toBe(500);
      expect(bodyOf(res)).toEqual({ error: 'Failed to update status' });
      expect(errorSpy).toHaveBeenCalledWith('Failed to update inquiry status:', dbError);
      expect(logAudit).not.toHaveBeenCalled();
    });

    it('DD-ADMIN-007 PATCH は createServiceRoleClient が例外を投げた時は 500 Internal server error', async () => {
      createServiceRoleClient.mockRejectedValue(new Error('no client'));

      const res = await PATCH(makeJsonRequest({ status: 'open' }), ctx);

      expect(res.status).toBe(500);
      expect(bodyOf(res)).toEqual({ error: 'Internal server error' });
    });
  });
});
