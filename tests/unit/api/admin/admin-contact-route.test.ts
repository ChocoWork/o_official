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

jest.mock('@/lib/audit', () => ({
  logAudit: jest.fn(),
}));

import { GET } from '@/app/api/admin/contact/route';

const { createServiceRoleClient } = require('@/lib/supabase/server');
const { authorizeAdminPermission } = require('@/lib/auth/admin-rbac');
const { logAudit } = require('@/lib/audit');

// モックの NextResponse.json が持たせる _body を型を通して読む
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const bodyOf = (res: unknown): any => (res as { _body: unknown })._body;

const SELECT_COLUMNS =
  'id, created_at, updated_at, last_message_at, name, email, inquiry_type, subject, status, order_id, user_id';

type QueryResult = { data: unknown; error: unknown; count: number | null };

const select = jest.fn();
const eq = jest.fn();
const or = jest.fn();
const order = jest.fn();
const range = jest.fn();
const from = jest.fn();

function makeRequest(search = '') {
  return new Request(`http://localhost/api/admin/contact${search}`, {
    headers: { 'x-real-ip': '198.51.100.7', 'user-agent': 'jest-agent' },
  });
}

function setResult(result: QueryResult) {
  range.mockResolvedValue(result);
}

describe('GET /api/admin/contact', () => {
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    const builder = { select, eq, or, order, range };
    select.mockReset().mockReturnValue(builder);
    eq.mockReset().mockReturnValue(builder);
    or.mockReset().mockReturnValue(builder);
    order.mockReset().mockReturnValue(builder);
    range.mockReset();
    from.mockReset().mockReturnValue(builder);
    createServiceRoleClient.mockReset().mockResolvedValue({ from });
    authorizeAdminPermission
      .mockReset()
      .mockResolvedValue({ ok: true, userId: 'admin-1', actorEmail: 'owner@example.com' });
    logAudit.mockReset().mockResolvedValue(undefined);
    setResult({ data: [], error: null, count: 0 });
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('DD-ADMIN-006 認可が ok:false の時は認可の応答を返し、DB を読まない', async () => {
    const response = { status: 403, json: async () => ({ error: 'Forbidden' }) };
    authorizeAdminPermission.mockResolvedValue({ ok: false, response });
    const request = makeRequest();

    const res = await GET(request);

    expect(res).toBe(response);
    expect(authorizeAdminPermission).toHaveBeenCalledWith('admin.contact.read', request);
    expect(createServiceRoleClient).not.toHaveBeenCalled();
  });

  it('DD-ADMIN-006 クエリが無い時は 1 ページ目・20 件で、絞りも or も付けない', async () => {
    const res = await GET(makeRequest());

    expect(res.status).toBe(200);
    expect(from).toHaveBeenCalledWith('contact_inquiries');
    expect(select).toHaveBeenCalledWith(SELECT_COLUMNS, { count: 'exact' });
    expect(eq).not.toHaveBeenCalled();
    expect(or).not.toHaveBeenCalled();
    expect(order).toHaveBeenCalledWith('last_message_at', { ascending: false });
    expect(range).toHaveBeenCalledWith(0, 19);
    expect(bodyOf(res)).toMatchObject({ page: 1, pageSize: 20 });
  });

  it('DD-ADMIN-006 page=3&pageSize=10 で range(20, 29) を読む', async () => {
    const res = await GET(makeRequest('?page=3&pageSize=10'));

    expect(range).toHaveBeenCalledWith(20, 29);
    expect(bodyOf(res)).toMatchObject({ page: 3, pageSize: 10 });
  });

  it.each(['abc', '0', '-2'])('DD-ADMIN-006 page=%s は 1 ページ目に戻る', async (page) => {
    const res = await GET(makeRequest(`?page=${page}`));

    expect(range).toHaveBeenCalledWith(0, 19);
    expect(bodyOf(res)).toMatchObject({ page: 1 });
  });

  it.each([
    ['0', 20],
    ['abc', 20],
    ['-5', 1],
    ['500', 100],
  ])('DD-ADMIN-006 pageSize=%s は %i 件にそろえる', async (pageSize, expected) => {
    const res = await GET(makeRequest(`?pageSize=${pageSize}`));

    expect(range).toHaveBeenCalledWith(0, expected - 1);
    expect(bodyOf(res)).toMatchObject({ pageSize: expected });
  });

  it('DD-ADMIN-006 status=open で状態の絞りが付く', async () => {
    await GET(makeRequest('?status=open'));

    expect(eq).toHaveBeenCalledTimes(1);
    expect(eq).toHaveBeenCalledWith('status', 'open');
  });

  it('DD-ADMIN-006 status=bogus では状態の絞りが付かない', async () => {
    await GET(makeRequest('?status=bogus'));

    expect(eq).not.toHaveBeenCalled();
  });

  it('DD-ADMIN-006 type=order で種別の絞りが付く', async () => {
    await GET(makeRequest('?type=order'));

    expect(eq).toHaveBeenCalledTimes(1);
    expect(eq).toHaveBeenCalledWith('inquiry_type', 'order');
  });

  it('DD-ADMIN-006 type=bogus では種別の絞りが付かない', async () => {
    await GET(makeRequest('?type=bogus'));

    expect(eq).not.toHaveBeenCalled();
  });

  it('DD-ADMIN-006 状態と種別が両方正しければ両方の絞りが付く', async () => {
    await GET(makeRequest('?status=closed&type=product'));

    expect(eq).toHaveBeenCalledWith('status', 'closed');
    expect(eq).toHaveBeenCalledWith('inquiry_type', 'product');
  });

  it('DD-ADMIN-006 q の区切りの字を空白にした語で or を付ける', async () => {
    await GET(makeRequest(`?q=${encodeURIComponent('a,b(c)%d\\e')}`));

    expect(or).toHaveBeenCalledTimes(1);
    const term = 'a b c  d e';
    expect(or).toHaveBeenCalledWith(
      `name.ilike.%${term}%,email.ilike.%${term}%,subject.ilike.%${term}%`
    );
  });

  it('DD-ADMIN-006 q が空の時は or を付けない', async () => {
    await GET(makeRequest('?q='));

    expect(or).not.toHaveBeenCalled();
  });

  it('DD-ADMIN-006 q が区切りの字だけの時は or を付けない', async () => {
    await GET(makeRequest(`?q=${encodeURIComponent(',()%\\')}`));

    expect(or).not.toHaveBeenCalled();
  });

  it('DD-ADMIN-006 101 字の q は 100 字に切られる', async () => {
    await GET(makeRequest(`?q=${'a'.repeat(101)}`));

    const term = 'a'.repeat(100);
    expect(or).toHaveBeenCalledWith(
      `name.ilike.%${term}%,email.ilike.%${term}%,subject.ilike.%${term}%`
    );
  });

  it('DD-ADMIN-006 総数 45・幅 20 で総ページ 3 になり、行をそのまま返す', async () => {
    const rows = [{ id: 'c1' }, { id: 'c2' }];
    setResult({ data: rows, error: null, count: 45 });

    const res = await GET(makeRequest());

    expect(res.status).toBe(200);
    expect(bodyOf(res)).toEqual({ data: rows, page: 1, pageSize: 20, totalPages: 3, totalCount: 45 });
  });

  it('DD-ADMIN-006 総数が空の時は総数 0・総ページ 1 になる', async () => {
    setResult({ data: [], error: null, count: null });

    const res = await GET(makeRequest());

    expect(bodyOf(res)).toMatchObject({ totalCount: 0, totalPages: 1 });
  });

  it('DD-ADMIN-006 行が空の時は空の配列を返す', async () => {
    setResult({ data: null, error: null, count: 0 });

    const res = await GET(makeRequest());

    expect(res.status).toBe(200);
    expect(bodyOf(res)).toMatchObject({ data: [] });
  });

  it('DD-ADMIN-006 読みが誤りを返した時は記録して 500 Failed to fetch inquiries', async () => {
    const dbError = { message: 'boom' };
    setResult({ data: null, error: dbError, count: null });

    const res = await GET(makeRequest());

    expect(res.status).toBe(500);
    expect(bodyOf(res)).toEqual({ error: 'Failed to fetch inquiries' });
    expect(errorSpy).toHaveBeenCalledWith('Failed to fetch contact inquiries:', dbError);
  });

  it('DD-ADMIN-006 200 の後に一覧を開いた記録を1行残し、metadata は状態・種別・ページ・検索語の長さだけ（検索語は入れない）', async () => {
    const res = await GET(makeRequest('?status=open&q=taro@'));

    expect(res.status).toBe(200);
    expect(logAudit).toHaveBeenCalledTimes(1);
    expect(logAudit).toHaveBeenCalledWith({
      action: 'admin.contact.list',
      actor_id: 'admin-1',
      actor_email: 'owner@example.com',
      resource: 'contact',
      outcome: 'success',
      ip: '198.51.100.7',
      user_agent: 'jest-agent',
      metadata: { status: 'open', type: null, page: 1, q_length: 5 },
    });
    expect(JSON.stringify(logAudit.mock.calls)).not.toContain('taro');
  });

  it('DD-ADMIN-006 許可の値でない状態・種別は記録に null で残し、入力の字を入れない', async () => {
    await GET(makeRequest('?status=%3Cscript%3E&type=bogus&page=2'));

    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { status: null, type: null, page: 2, q_length: 0 } })
    );
    expect(JSON.stringify(logAudit.mock.calls)).not.toContain('script');
  });

  it('DD-ADMIN-006 読みが誤りの時と認可で断った時は、一覧を開いた記録を書かない', async () => {
    setResult({ data: null, error: { message: 'boom' }, count: null });
    await GET(makeRequest());
    authorizeAdminPermission.mockResolvedValue({ ok: false, response: { status: 403 } });
    await GET(makeRequest());

    expect(logAudit).not.toHaveBeenCalled();
  });

  it('DD-ADMIN-006 監査の記録が例外を投げても 200 で一覧を返す（読み出しを止めない）', async () => {
    logAudit.mockRejectedValue(new Error('audit down'));
    setResult({ data: [{ id: 'c1' }], error: null, count: 1 });

    const res = await GET(makeRequest());

    expect(res.status).toBe(200);
    expect(bodyOf(res).data).toEqual([{ id: 'c1' }]);
    expect(errorSpy).toHaveBeenCalledWith('Failed to write contact list read audit');
  });

  it('DD-ADMIN-006 createServiceRoleClient が例外を投げた時は 500 Internal server error', async () => {
    createServiceRoleClient.mockRejectedValue(new Error('no client'));

    const res = await GET(makeRequest());

    expect(res.status).toBe(500);
    expect(bodyOf(res)).toEqual({ error: 'Internal server error' });
  });
});
