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

jest.mock('@/lib/mail', () => ({
  __esModule: true,
  default: jest.fn(),
}));

jest.mock('@/lib/contact/reply-address', () => ({
  buildReplyAddress: jest.fn(),
}));

jest.mock('@/features/auth/middleware/rateLimit', () => ({
  enforceRateLimit: jest.fn(),
}));

import { POST } from '@/app/api/admin/contact/[id]/reply/route';

const { createServiceRoleClient } = require('@/lib/supabase/server');
const { logAudit } = require('@/lib/audit');
const { authorizeAdminPermission } = require('@/lib/auth/admin-rbac');
const { enforceRateLimit } = require('@/features/auth/middleware/rateLimit');

// モックの NextResponse.json が持たせる _body を型を通して読む
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const bodyOf = (res: unknown): any => (res as { _body: unknown })._body;
const sendMail = require('@/lib/mail').default;
const { buildReplyAddress } = require('@/lib/contact/reply-address');

const INQUIRY_ID = '3f2b8c1e-5d4a-4b7e-9c2d-1a2b3c4d5e6f';
const ctx = { params: Promise.resolve({ id: INQUIRY_ID }) };

const inquirySingle = jest.fn();
const inquiryEq = jest.fn();
const inquirySelect = jest.fn();
const insert = jest.fn();
const updateEq = jest.fn();
const update = jest.fn();
const from = jest.fn();

function makeRequest(body: unknown, headers: Record<string, string> = {}) {
  return new Request('http://localhost/api/admin/contact/3f2b8c1e-5d4a-4b7e-9c2d-1a2b3c4d5e6f/reply', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('POST /api/admin/contact/[id]/reply', () => {
  let errorSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;
  const originalMailFrom = process.env.MAIL_FROM_ADDRESS;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.MAIL_FROM_ADDRESS = 'shop@example.com';
    inquirySingle
      .mockReset()
      .mockResolvedValue({ data: { id: '3f2b8c1e-5d4a-4b7e-9c2d-1a2b3c4d5e6f', email: 'y@example.com', subject: '質問' }, error: null });
    inquiryEq.mockReset().mockReturnValue({ single: inquirySingle });
    inquirySelect.mockReset().mockReturnValue({ eq: inquiryEq });
    insert.mockReset().mockResolvedValue({ error: null });
    updateEq.mockReset().mockResolvedValue({ error: null });
    update.mockReset().mockReturnValue({ eq: updateEq });
    from.mockReset().mockImplementation((table: string) =>
      table === 'contact_messages' ? { insert } : { select: inquirySelect, update }
    );
    createServiceRoleClient.mockReset().mockResolvedValue({ from });
    logAudit.mockReset();
    sendMail.mockReset().mockResolvedValue(undefined);
    buildReplyAddress.mockReset().mockReturnValue('reply+3f2b8c1e-5d4a-4b7e-9c2d-1a2b3c4d5e6f@mail.example.com');
    authorizeAdminPermission.mockReset().mockResolvedValue({ ok: true, userId: 'admin-1' });
    enforceRateLimit.mockReset().mockResolvedValue(null);
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
    warnSpy.mockRestore();
    if (originalMailFrom === undefined) {
      delete process.env.MAIL_FROM_ADDRESS;
    } else {
      process.env.MAIL_FROM_ADDRESS = originalMailFrom;
    }
  });

  it('DD-ADMIN-008 認可が ok:false の時は認可の応答を返し、何も書かない', async () => {
    const response = { status: 403, json: async () => ({ error: 'Forbidden' }) };
    authorizeAdminPermission.mockResolvedValue({ ok: false, response });
    const request = makeRequest({ body: 'ありがとうございます' });

    const res = await POST(request, ctx);

    expect(res).toBe(response);
    expect(authorizeAdminPermission).toHaveBeenCalledWith('admin.contact.manage', request);
    expect(createServiceRoleClient).not.toHaveBeenCalled();
    expect(sendMail).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });

  it.each([
    ['JSON でない本文', 'not-json{'],
    ['空白だけの body', { body: '   ' }],
    ['5001 字の body', { body: 'a'.repeat(5001) }],
  ])('DD-ADMIN-008 %s の時は 400 で details を返し、何も保存しない', async (_label, payload) => {
    const res = await POST(makeRequest(payload), ctx);

    expect(res.status).toBe(400);
    expect(bodyOf(res).error).toBe('Invalid request');
    expect(bodyOf(res).details).toBeDefined();
    expect(createServiceRoleClient).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
    expect(sendMail).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });

  it('DD-ADMIN-008 5000 字ちょうどの body は受け付ける', async () => {
    const res = await POST(makeRequest({ body: 'a'.repeat(5000) }), ctx);

    expect(res.status).toBe(201);
  });

  it('DD-ADMIN-008 問い合わせの読みが誤りの時は 404 で、保存しない', async () => {
    inquirySingle.mockResolvedValue({ data: null, error: { message: 'bad id' } });

    const res = await POST(makeRequest({ body: 'こんにちは' }), ctx);

    expect(res.status).toBe(404);
    expect(bodyOf(res)).toEqual({ error: 'Inquiry not found' });
    expect(insert).not.toHaveBeenCalled();
  });

  it('DD-ADMIN-008 行が空の時は 404 で、保存しない', async () => {
    inquirySingle.mockResolvedValue({ data: null, error: null });

    const res = await POST(makeRequest({ body: 'こんにちは' }), ctx);

    expect(res.status).toBe(404);
    expect(bodyOf(res)).toEqual({ error: 'Inquiry not found' });
    expect(insert).not.toHaveBeenCalled();
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('DD-ADMIN-008 保存が誤りを返した時は 500 Failed to save reply で、状態更新・メール・監査に触らない', async () => {
    const dbError = { message: 'boom' };
    insert.mockResolvedValue({ error: dbError });

    const res = await POST(makeRequest({ body: 'こんにちは' }), ctx);

    expect(res.status).toBe(500);
    expect(bodyOf(res)).toEqual({ error: 'Failed to save reply' });
    expect(errorSpy).toHaveBeenCalledWith('Failed to insert admin reply:', dbError);
    expect(update).not.toHaveBeenCalled();
    expect(sendMail).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });

  it('DD-ADMIN-008 やり取りに送り手の役 admin・書いた人・本文・経路 web で1行足す', async () => {
    await POST(makeRequest({ body: '  ご連絡ありがとうございます  ' }), ctx);

    expect(inquirySelect).toHaveBeenCalledWith('id, email, subject');
    expect(inquiryEq).toHaveBeenCalledWith('id', '3f2b8c1e-5d4a-4b7e-9c2d-1a2b3c4d5e6f');
    expect(insert).toHaveBeenCalledWith([
      {
        inquiry_id: '3f2b8c1e-5d4a-4b7e-9c2d-1a2b3c4d5e6f',
        sender_role: 'admin',
        author_id: 'admin-1',
        body: 'ご連絡ありがとうございます',
        channel: 'web',
      },
    ]);
  });

  it('DD-ADMIN-008 状態の更新に answered と時刻を渡す', async () => {
    await POST(makeRequest({ body: 'こんにちは' }), ctx);

    expect(from).toHaveBeenCalledWith('contact_inquiries');
    const payload = update.mock.calls[0][0];
    expect(payload.status).toBe('answered');
    expect(payload.last_message_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(payload.updated_at).toBe(payload.last_message_at);
    expect(updateEq).toHaveBeenCalledWith('id', '3f2b8c1e-5d4a-4b7e-9c2d-1a2b3c4d5e6f');
  });

  it('DD-ADMIN-008 状態の更新が誤りを返した時は 500 Failed to update inquiry status で、保存した返信は残し、メールは送らず、監査は error・status_update_failed（誤りの文を残さない）', async () => {
    updateEq.mockResolvedValue({ error: { message: 'boom secret@example.com', code: 'XX000' } });

    const res = await POST(makeRequest({ body: 'こんにちは' }, { 'user-agent': 'jest-agent' }), ctx);

    expect(res.status).toBe(500);
    expect(bodyOf(res)).toEqual({ error: 'Failed to update inquiry status' });
    expect(insert).toHaveBeenCalledTimes(1);
    expect(sendMail).not.toHaveBeenCalled();
    expect(logAudit).toHaveBeenCalledTimes(1);
    expect(logAudit).toHaveBeenCalledWith({
      action: 'admin.contact.reply',
      actor_id: 'admin-1',
      resource: 'contact',
      resource_id: INQUIRY_ID,
      outcome: 'error',
      detail: 'status_update_failed',
      user_agent: 'jest-agent',
    });
    expect(JSON.stringify(logAudit.mock.calls)).not.toContain('secret@example.com');
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('secret@example.com');
  });

  it('DD-ADMIN-008 回数の枠は認可の直後に管理者の ID だけで数え（admin:contact:reply・30・600秒）、超えたら 429 で DB・メールに触らない', async () => {
    const limited = { status: 429, _body: { error: 'Too many requests' } };
    enforceRateLimit.mockResolvedValue(limited);
    const request = makeRequest({ body: 'こんにちは' });

    const res = await POST(request, ctx);

    expect(res).toBe(limited);
    expect(enforceRateLimit).toHaveBeenCalledWith({
      request,
      endpoint: 'admin:contact:reply',
      limit: 30,
      windowSeconds: 600,
      subject: 'admin-1',
    });
    expect(createServiceRoleClient).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
    expect(sendMail).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });

  it('DD-ADMIN-008 認可で断った要求は回数に数えない', async () => {
    authorizeAdminPermission.mockResolvedValue({ ok: false, response: { status: 403 } });

    await POST(makeRequest({ body: 'こんにちは' }), ctx);

    expect(enforceRateLimit).not.toHaveBeenCalled();
  });

  it('DD-ADMIN-008 id が UUID でない時は DB に渡さず 404 で、保存もメールもしない', async () => {
    const res = await POST(makeRequest({ body: 'こんにちは' }), { params: Promise.resolve({ id: 'inq-1' }) });

    expect(res.status).toBe(404);
    expect(bodyOf(res)).toEqual({ error: 'Inquiry not found' });
    expect(createServiceRoleClient).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
    expect(sendMail).not.toHaveBeenCalled();
  });

  it.each([
    ['CR LF で Bcc を差し込もうとする件名', '注文\r\nBcc: attacker@example.com', 'Re: 注文 Bcc: attacker@example.com'],
    ['LF だけの件名', '注文\nX-Evil: 1', 'Re: 注文 X-Evil: 1'],
    ['制御文字を挟んだ件名', '注\u0000文\u001f確認\u007f', 'Re: 注 文 確認'],
    ['前後に空白と改行がある件名', '  \r\n質問\r\n  ', 'Re: 質問'],
    ['制御文字だけの件名', '\u0000\u001f', 'Re: (件名なし)'],
    ['空の件名', '', 'Re: (件名なし)'],
    ['Re: で始まる件名', 'Re: 既存', 'Re: 既存'],
    ['Re: の後に改行がある件名', 'Re:\r\n既存', 'Re: 既存'],
  ])('DD-ADMIN-008 返信の件名は %s で、制御文字を除いて %s になる', async (_label, subject, expected) => {
    inquirySingle.mockResolvedValue({ data: { id: INQUIRY_ID, email: 'y@example.com', subject }, error: null });

    const res = await POST(makeRequest({ body: 'こんにちは' }), ctx);

    expect(res.status).toBe(201);
    expect(bodyOf(res)).toEqual({ success: true, mailSent: true });
    const sentSubject = sendMail.mock.calls[0][0].subject;
    expect(sentSubject).toBe(expected);
    expect(sentSubject).not.toMatch(/[\r\n\u0000-\u001f\u007f]/);
  });

  it('DD-ADMIN-008 MAIL_FROM_ADDRESS がある時、件名が 質問 なら Re: 質問 で送り、本文の後に店の名前が付き、201 で mailSent が真・監査が reply_sent', async () => {
    const res = await POST(
      makeRequest({ body: 'ご連絡ありがとうございます' }, { 'user-agent': 'jest-agent' }),
      ctx
    );

    expect(res.status).toBe(201);
    expect(bodyOf(res)).toEqual({ success: true, mailSent: true });
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(sendMail).toHaveBeenCalledWith({
      to: 'y@example.com',
      subject: 'Re: 質問',
      text: 'ご連絡ありがとうございます\n\n---\nLe Fil des Heures',
      replyTo: 'reply+3f2b8c1e-5d4a-4b7e-9c2d-1a2b3c4d5e6f@mail.example.com',
    });
    expect(logAudit).toHaveBeenCalledWith({
      action: 'admin.contact.reply',
      actor_id: 'admin-1',
      resource: 'contact',
      resource_id: '3f2b8c1e-5d4a-4b7e-9c2d-1a2b3c4d5e6f',
      outcome: 'success',
      detail: 'reply_sent',
      user_agent: 'jest-agent',
    });
  });

  it('DD-ADMIN-008 件名が Re: 質問 ならそのままで送る', async () => {
    inquirySingle.mockResolvedValue({
      data: { id: '3f2b8c1e-5d4a-4b7e-9c2d-1a2b3c4d5e6f', email: 'y@example.com', subject: 'Re: 質問' },
      error: null,
    });

    await POST(makeRequest({ body: 'こんにちは' }), ctx);

    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ subject: 'Re: 質問' }));
  });

  it('DD-ADMIN-008 返信の宛先が作れる時は Reply-To にその宛先を入れる', async () => {
    await POST(makeRequest({ body: 'こんにちは' }), ctx);

    expect(buildReplyAddress).toHaveBeenCalledWith('3f2b8c1e-5d4a-4b7e-9c2d-1a2b3c4d5e6f');
    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({ replyTo: 'reply+3f2b8c1e-5d4a-4b7e-9c2d-1a2b3c4d5e6f@mail.example.com' })
    );
  });

  it('DD-ADMIN-008 返信の宛先が作れない時は Reply-To を付けずに送る', async () => {
    buildReplyAddress.mockReturnValue(null);

    const res = await POST(makeRequest({ body: 'こんにちは' }), ctx);

    expect(res.status).toBe(201);
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(sendMail.mock.calls[0][0].replyTo).toBeUndefined();
  });

  it('DD-ADMIN-008 メールが例外を投げた時は 201 で mailSent が偽、保存は残り、監査が error・reply_saved_mail_failed', async () => {
    const mailError = new Error('smtp down');
    sendMail.mockRejectedValue(mailError);

    const res = await POST(makeRequest({ body: 'こんにちは' }, { 'user-agent': 'jest-agent' }), ctx);

    expect(res.status).toBe(201);
    expect(bodyOf(res)).toEqual({ success: true, mailSent: false });
    expect(insert).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith('Contact reply mail failed. Reply is saved:', mailError);
    expect(logAudit).toHaveBeenCalledWith({
      action: 'admin.contact.reply',
      actor_id: 'admin-1',
      resource: 'contact',
      resource_id: '3f2b8c1e-5d4a-4b7e-9c2d-1a2b3c4d5e6f',
      outcome: 'error',
      detail: 'reply_saved_mail_failed',
      user_agent: 'jest-agent',
    });
  });

  it('DD-ADMIN-008 MAIL_FROM_ADDRESS が無い時はメールを送らずに 201 で mailSent が偽、保存は残り、監査は error・reply_saved_mail_not_configured（reply_sent にしない）', async () => {
    delete process.env.MAIL_FROM_ADDRESS;

    const res = await POST(makeRequest({ body: 'こんにちは' }), ctx);

    expect(res.status).toBe(201);
    expect(bodyOf(res)).toEqual({ success: true, mailSent: false });
    expect(insert).toHaveBeenCalledTimes(1);
    expect(sendMail).not.toHaveBeenCalled();
    expect(logAudit).toHaveBeenCalledTimes(1);
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'error', detail: 'reply_saved_mail_not_configured' })
    );
  });

  it('DD-ADMIN-008 createServiceRoleClient が例外を投げた時は 500 Internal server error', async () => {
    createServiceRoleClient.mockRejectedValue(new Error('no client'));

    const res = await POST(makeRequest({ body: 'こんにちは' }), ctx);

    expect(res.status).toBe(500);
    expect(bodyOf(res)).toEqual({ error: 'Internal server error' });
    expect(sendMail).not.toHaveBeenCalled();
  });
});
