import { NextRequest, NextResponse } from 'next/server';
import { DELETE } from '@/app/api/wishlist/[id]/route';
import { denyIfCsrfInvalid, openShoppingContext } from '@/features/cart/services/shopping-context';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { enforceRateLimit } from '@/features/auth/middleware/rateLimit';
import { logAudit } from '@/lib/audit';

jest.mock('@/features/cart/services/shopping-context', () => ({
  openShoppingContext: jest.fn(),
  denyIfCsrfInvalid: jest.fn(),
}));
jest.mock('@/lib/supabase/server', () => ({ createServiceRoleClient: jest.fn() }));
jest.mock('@/features/auth/middleware/rateLimit', () => ({ enforceRateLimit: jest.fn() }));
jest.mock('@/lib/audit', () => ({ logAudit: jest.fn() }));

// 既存の Jest の Response は json() を持たないため、実際の NextResponse を使えるよう補う。
if (typeof Response.json !== 'function') {
  Response.json = (body: unknown, init?: ResponseInit) => new Response(JSON.stringify(body), {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
}

const LINE_ID = '4f3365cd-6c5b-4f7c-8838-6041b0858c5c';
const TOKEN_HASH = 'f'.repeat(64);
const COOKIE_TOKEN = 'private-guest-cookie-value';

type QueryResult = { data: unknown; error: unknown };

/** 消す問い合わせの代わり。呼ばれたメソッドと引数を残し、await するとそのまま結果を返す */
function fakeDeleteQuery(result: QueryResult) {
  return {
    delete: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    then: (resolve: (value: QueryResult) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject),
  };
}

function useDb(result: QueryResult = { data: [{ id: LINE_ID }], error: null }) {
  const lines = fakeDeleteQuery(result);
  const supabase = {
    from: jest.fn((table: string) => {
      if (table !== 'wishlist_lines') {
        throw new Error(`unexpected table: ${table}`);
      }
      return lines;
    }),
  };
  (createServiceRoleClient as jest.Mock).mockResolvedValue(supabase);
  return { supabase, lines };
}

const context = {
  kind: 'wishlist',
  owner: { kind: 'guest', tokenHash: TOKEN_HASH },
  rateLimitSubject: `guest:${TOKEN_HASH}` as string | null,
  auditOwner: { owner: 'guest', guest_hash_prefix: 'ffffffffffff' },
  findOwnerId: jest.fn(),
  ensureOwnerId: jest.fn(),
  finish: jest.fn((res: NextResponse) => res),
};

function del(id = LINE_ID) {
  return new NextRequest(`http://localhost:3000/api/wishlist/${id}`, { method: 'DELETE' });
}

function call(req: NextRequest, id = LINE_ID) {
  return DELETE(req, { params: Promise.resolve({ id }) });
}

describe('DELETE /api/wishlist/[id]', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    context.rateLimitSubject = `guest:${TOKEN_HASH}`;
    context.findOwnerId.mockResolvedValue('wishlist-1');
    context.finish.mockImplementation((res: NextResponse) => res);
    (openShoppingContext as jest.Mock).mockResolvedValue({ ok: true, context });
    (denyIfCsrfInvalid as jest.Mock).mockResolvedValue(null);
    (enforceRateLimit as jest.Mock).mockResolvedValue(undefined);
    (logAudit as jest.Mock).mockResolvedValue(undefined);
    useDb();
  });

  afterEach(() => jest.restoreAllMocks());

  test('持ち主の確認が 401 ならその応答をそのまま返し、何も消さない', async () => {
    const denied = NextResponse.json({ error: 'session_expired' }, { status: 401 });
    (openShoppingContext as jest.Mock).mockResolvedValueOnce({ ok: false, response: denied });
    const { supabase } = useDb();
    const req = del();

    expect(await call(req)).toBe(denied);
    expect(openShoppingContext).toHaveBeenCalledWith(req, 'wishlist', supabase, { write: true });
    expect(enforceRateLimit).not.toHaveBeenCalled();
    expect(denyIfCsrfInvalid).not.toHaveBeenCalled();
    expect(supabase.from).not.toHaveBeenCalled();
  });

  test('UUID でない id は 400 にして、消さない', async () => {
    const { supabase } = useDb();

    const res = await call(del('not-a-uuid'), 'not-a-uuid');

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid wishlist id' });
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'wishlist.delete', outcome: 'failure', detail: 'Invalid wishlist id', metadata: { ...context.auditOwner },
    }));
    expect(context.findOwnerId).not.toHaveBeenCalled();
    expect(supabase.from).not.toHaveBeenCalled();
    expect(context.finish).toHaveBeenCalledWith(res);
  });

  test('回数の制限は IP ごとに 60 回・60 秒、持ち主ごとに 30 回・60 秒', async () => {
    const req = del();

    const res = await call(req);

    expect(res.status).toBe(200);
    expect(enforceRateLimit).toHaveBeenCalledTimes(2);
    expect(enforceRateLimit).toHaveBeenCalledWith({ request: req, endpoint: 'wishlist:delete', limit: 60, windowSeconds: 60 });
    expect(enforceRateLimit).toHaveBeenCalledWith({
      request: req, endpoint: 'wishlist:delete', limit: 30, windowSeconds: 60, subject: context.rateLimitSubject,
    });
  });

  test('印の無いゲストには持ち主ごとの制限を呼ばず、IP ごとの制限だけで数える', async () => {
    context.rateLimitSubject = null;
    const req = del();

    const res = await call(req);

    expect(res.status).toBe(200);
    expect(enforceRateLimit).toHaveBeenCalledTimes(1);
    expect(enforceRateLimit).toHaveBeenCalledWith({ request: req, endpoint: 'wishlist:delete', limit: 60, windowSeconds: 60 });
  });

  test('IP ごとの制限が 429 ならその応答を返し、CSRF の確認も削除もしない', async () => {
    const denied = NextResponse.json({ error: 'Too many requests' }, { status: 429 });
    (enforceRateLimit as jest.Mock).mockImplementation(async (options: { subject?: string }) => (options.subject ? undefined : denied));
    const { supabase } = useDb();

    expect(await call(del())).toBe(denied);
    expect(denyIfCsrfInvalid).not.toHaveBeenCalled();
    expect(context.findOwnerId).not.toHaveBeenCalled();
    expect(supabase.from).not.toHaveBeenCalled();
  });

  test('持ち主ごとの制限が 429 ならその応答を返し、CSRF の確認も削除もしない', async () => {
    const denied = NextResponse.json({ error: 'Too many requests' }, { status: 429 });
    (enforceRateLimit as jest.Mock).mockImplementation(async (options: { subject?: string }) => (options.subject ? denied : undefined));
    const { supabase } = useDb();

    expect(await call(del())).toBe(denied);
    expect(denyIfCsrfInvalid).not.toHaveBeenCalled();
    expect(context.findOwnerId).not.toHaveBeenCalled();
    expect(supabase.from).not.toHaveBeenCalled();
  });

  test('CSRF の確認が 403 ならその応答を返し、削除しない', async () => {
    const denied = NextResponse.json({ error: 'Forbidden', reason: 'CSRF validation failed' }, { status: 403 });
    (denyIfCsrfInvalid as jest.Mock).mockResolvedValueOnce(denied);
    const { supabase } = useDb();

    expect(await call(del())).toBe(denied);
    expect(context.findOwnerId).not.toHaveBeenCalled();
    expect(supabase.from).not.toHaveBeenCalled();
  });

  test('CSRF の確認は回数の制限の後に行う', async () => {
    await call(del());

    const rateLimitCalls = (enforceRateLimit as jest.Mock).mock.invocationCallOrder;
    const csrfCall = (denyIfCsrfInvalid as jest.Mock).mock.invocationCallOrder[0];
    expect(csrfCall).toBeGreaterThan(rateLimitCalls[rateLimitCalls.length - 1]);
  });

  test('持ち主の行が無ければ 404 にして、削除の問い合わせを出さず finish を通す', async () => {
    context.findOwnerId.mockResolvedValueOnce(null);
    const { supabase } = useDb();

    const res = await call(del());

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Wishlist item not found' });
    expect(supabase.from).not.toHaveBeenCalled();
    expect(context.finish).toHaveBeenCalledWith(res);
  });

  test('id と wishlist_id が合う明細が無ければ 404 にして finish を通す', async () => {
    useDb({ data: [], error: null });

    const res = await call(del());

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Wishlist item not found' });
    expect(context.finish).toHaveBeenCalledWith(res);
    expect(logAudit).not.toHaveBeenCalled();
  });

  test('合えば持ち主の明細を消して 200 の { success: true } を返し、finish を通す', async () => {
    const { supabase, lines } = useDb();

    const res = await call(del());

    expect(supabase.from).toHaveBeenCalledWith('wishlist_lines');
    expect(lines.delete).toHaveBeenCalledTimes(1);
    expect(lines.select).toHaveBeenCalledWith('id');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(context.finish).toHaveBeenCalledWith(res);
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'wishlist.delete',
      outcome: 'success',
      resource: 'wishlist',
      resource_id: LINE_ID,
      metadata: { ...context.auditOwner },
    }));
  });

  test('消す問い合わせは必ず wishlist_id の条件を持つ（他人の明細を消せない）', async () => {
    context.findOwnerId.mockResolvedValueOnce('wishlist-mine');
    const { lines } = useDb();

    await call(del());

    expect(lines.eq).toHaveBeenCalledTimes(2);
    expect(lines.eq).toHaveBeenCalledWith('id', LINE_ID);
    expect(lines.eq).toHaveBeenCalledWith('wishlist_id', 'wishlist-mine');
    // delete() で始めた問い合わせに、2つの条件が付いてから結果を読む
    const deleteOrder = lines.delete.mock.invocationCallOrder[0];
    const selectOrder = lines.select.mock.invocationCallOrder[0];
    for (const eqOrder of lines.eq.mock.invocationCallOrder) {
      expect(eqOrder).toBeGreaterThan(deleteOrder);
      expect(eqOrder).toBeLessThan(selectOrder);
    }
  });

  test('削除の失敗は 500 にして finish を通し、成功の監査は残さない', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    useDb({ data: null, error: { code: '08006', message: 'db down' } });

    const res = await call(del());

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to remove from wishlist' });
    expect(context.finish).toHaveBeenCalledWith(res);
    expect(logAudit).not.toHaveBeenCalled();
  });

  test('持ち主の行を引くのが失敗したら 500 を返す', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    context.findOwnerId.mockRejectedValueOnce(new Error('db down'));

    const res = await call(del());

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
  });

  test('監査と応答に Cookie の印も完全なハッシュも入れない', async () => {
    const req = del();
    req.headers.set('cookie', `wishlist=${COOKIE_TOKEN}`);

    const res = await call(req);

    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'success' }));
    const audit = JSON.stringify((logAudit as jest.Mock).mock.calls);
    expect(audit).not.toContain(COOKIE_TOKEN);
    expect(audit).not.toContain(TOKEN_HASH);
    expect(audit).not.toContain('guest_token_hash');
    const body = await res.text();
    expect(body).not.toContain(COOKIE_TOKEN);
    expect(body).not.toContain(TOKEN_HASH);
    expect(body).not.toContain('guest_token_hash');
  });
});
