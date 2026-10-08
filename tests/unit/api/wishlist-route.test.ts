import { NextRequest, NextResponse } from 'next/server';
import { GET, POST } from '@/app/api/wishlist/route';
import { denyIfCsrfInvalid, openShoppingContext } from '@/features/cart/services/shopping-context';
import { createPublicClient, createServiceRoleClient } from '@/lib/supabase/server';
import { enforceRateLimit } from '@/features/auth/middleware/rateLimit';
import { logAudit } from '@/lib/audit';
import { signItemImageUrl } from '@/lib/storage/item-images';

jest.mock('@/features/cart/services/shopping-context', () => ({
  openShoppingContext: jest.fn(),
  denyIfCsrfInvalid: jest.fn(),
}));
jest.mock('@/lib/supabase/server', () => ({
  createServiceRoleClient: jest.fn(),
  createPublicClient: jest.fn(),
}));
jest.mock('@/features/auth/middleware/rateLimit', () => ({ enforceRateLimit: jest.fn() }));
jest.mock('@/lib/audit', () => ({ logAudit: jest.fn() }));
jest.mock('@/lib/storage/item-images', () => ({ signItemImageUrl: jest.fn() }));

// 既存の Jest の Response は json() を持たないため、実際の NextResponse を使えるよう補う。
if (typeof Response.json !== 'function') {
  Response.json = (body: unknown, init?: ResponseInit) => new Response(JSON.stringify(body), {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
}

type QueryResult = { data: unknown; error: unknown };

/** Supabase のクエリの代わり。呼ばれたメソッドと引数を残し、await するとそのまま結果を返す */
function fakeQuery(result: QueryResult) {
  return {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    in: jest.fn().mockReturnThis(),
    order: jest.fn().mockReturnThis(),
    insert: jest.fn().mockReturnThis(),
    single: jest.fn().mockResolvedValue(result),
    then: (resolve: (value: QueryResult) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject),
  };
}

/** 決めた表だけを持つクライアント。持たない表を読んだら落ちる（読むクライアントの取り違えに気づくため） */
function clientOf(queries: Record<string, ReturnType<typeof fakeQuery>>) {
  return {
    from: jest.fn((table: string) => {
      if (!(table in queries)) {
        throw new Error(`unexpected table: ${table}`);
      }
      return queries[table];
    }),
  };
}

/**
 * お気に入りの表・バリアントの表は service role のクライアントが、商品の表は匿名のクライアントが読む。
 * 後から呼ぶと、そのテストだけ結果を差し替えられる。
 */
function useDb(results: Partial<Record<'wishlist_lines' | 'item_variants' | 'items', QueryResult>> = {}) {
  const lines = fakeQuery(results.wishlist_lines ?? { data: [], error: null });
  const variants = fakeQuery(results.item_variants ?? { data: [], error: null });
  const items = fakeQuery(results.items ?? { data: [], error: null });
  const supabase = clientOf({ wishlist_lines: lines, item_variants: variants });
  const publicSupabase = clientOf({ items });
  (createServiceRoleClient as jest.Mock).mockResolvedValue(supabase);
  (createPublicClient as jest.Mock).mockResolvedValue(publicSupabase);
  return { supabase, publicSupabase, lines, variants, items };
}

const TOKEN_HASH = 'f'.repeat(64);
const COOKIE_TOKEN = 'private-guest-cookie-value';
const context = {
  kind: 'wishlist',
  owner: { kind: 'guest', tokenHash: TOKEN_HASH },
  rateLimitSubject: `guest:${TOKEN_HASH}` as string | null,
  auditOwner: { owner: 'guest', guest_hash_prefix: 'ffffffffffff' } as Record<string, string>,
  findOwnerId: jest.fn(),
  ensureOwnerId: jest.fn(),
  finish: jest.fn((res: NextResponse) => res),
};

const lineRows = [
  { id: 'line-3', item_id: 45, added_at: '2026-10-08T03:00:00Z' },
  { id: 'line-2', item_id: 99, added_at: '2026-10-08T02:00:00Z' }, // 非公開で items に出てこない商品
  { id: 'line-1', item_id: 46, added_at: '2026-10-08T01:00:00Z' },
];
const publishedItems = [
  { id: 45, name: 'リネンシャツ', price: 12000, image_url: 'items/45.png', category: 'shirt', colors: ['ブラック'], sizes: ['M', 'L'], status: 'published' },
  { id: 46, name: 'ウールパンツ', price: 18000, image_url: null, category: 'pants', colors: [], sizes: [], status: 'published' },
];
const variantRows = [
  { id: 1201, item_id: 45, is_active: true, item_colors: { name: 'ブラック' }, item_sizes: { label: 'M' } },
  { id: 1202, item_id: 45, is_active: true, item_colors: { name: 'ブラック' }, item_sizes: { label: 'L' } },
  { id: 1301, item_id: 46, is_active: true, item_colors: null, item_sizes: null },
];

beforeEach(() => {
  jest.resetAllMocks();
  context.rateLimitSubject = `guest:${TOKEN_HASH}`;
  context.auditOwner = { owner: 'guest', guest_hash_prefix: 'ffffffffffff' };
  context.findOwnerId.mockResolvedValue('wishlist-1');
  context.ensureOwnerId.mockResolvedValue('wishlist-1');
  context.finish.mockImplementation((res: NextResponse) => res);
  (openShoppingContext as jest.Mock).mockResolvedValue({ ok: true, context });
  (denyIfCsrfInvalid as jest.Mock).mockResolvedValue(null);
  (enforceRateLimit as jest.Mock).mockResolvedValue(undefined);
  (logAudit as jest.Mock).mockResolvedValue(undefined);
  (signItemImageUrl as jest.Mock).mockImplementation(async (_supabase: unknown, url: string | null) => (url ? `${url}?signed` : null));
  useDb();
});

afterEach(() => jest.restoreAllMocks());

function get() {
  return new NextRequest('http://localhost:3000/api/wishlist');
}

describe('GET /api/wishlist', () => {
  test('持ち主の確認が 401 ならその応答をそのまま返し、持ち主ごとの制限も読み込みもしない', async () => {
    const denied = NextResponse.json({ error: 'session_expired' }, { status: 401 });
    (openShoppingContext as jest.Mock).mockResolvedValueOnce({ ok: false, response: denied });
    const { supabase, publicSupabase } = useDb();
    const req = get();

    expect(await GET(req)).toBe(denied);
    expect(openShoppingContext).toHaveBeenCalledWith(req, 'wishlist', supabase, { write: false });
    // IP の制限は持ち主を決める前に済んでいる。持ち主が決まっていないので、持ち主ごとの制限は呼ばない
    expect(enforceRateLimit).toHaveBeenCalledTimes(1);
    expect(enforceRateLimit).toHaveBeenCalledWith({ request: req, endpoint: 'wishlist:get', limit: 120, windowSeconds: 60 });
    expect(supabase.from).not.toHaveBeenCalled();
    expect(publicSupabase.from).not.toHaveBeenCalled();
  });

  test('持ち主の行が無ければ 200 の [] を返し、明細を読まずに finish を通す', async () => {
    context.findOwnerId.mockResolvedValueOnce(null);
    const { supabase, publicSupabase } = useDb();

    const res = await GET(get());

    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(await res.json()).toEqual([]);
    expect(supabase.from).not.toHaveBeenCalled();
    expect(publicSupabase.from).not.toHaveBeenCalled();
    expect(context.ensureOwnerId).not.toHaveBeenCalled();
    expect(context.finish).toHaveBeenCalledWith(res);
  });

  test('明細が 0 件なら 200 の [] を返し、商品を読まずに finish を通す', async () => {
    const { supabase, publicSupabase } = useDb({ wishlist_lines: { data: [], error: null } });

    const res = await GET(get());

    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(await res.json()).toEqual([]);
    expect(supabase.from).toHaveBeenCalledTimes(1);
    expect(publicSupabase.from).not.toHaveBeenCalled();
    expect(context.finish).toHaveBeenCalledWith(res);
  });

  test('wishlist_id で明細を読み、公開中の商品だけを今と同じ形で返して各行に販売中のバリアントを足す', async () => {
    const { supabase, publicSupabase, lines, items, variants } = useDb({
      wishlist_lines: { data: lineRows, error: null },
      items: { data: publishedItems, error: null },
      item_variants: { data: variantRows, error: null },
    });

    const res = await GET(get());

    expect(supabase.from).toHaveBeenCalledWith('wishlist_lines');
    expect(lines.select).toHaveBeenCalledWith('id, item_id, added_at');
    expect(lines.eq).toHaveBeenCalledWith('wishlist_id', 'wishlist-1');
    expect(lines.order).toHaveBeenCalledWith('added_at', { ascending: false });

    expect(publicSupabase.from).toHaveBeenCalledWith('items');
    expect(items.select).toHaveBeenCalledWith('id, name, price, image_url, category, colors, sizes, status');
    expect(items.in).toHaveBeenCalledWith('id', [45, 99, 46]);
    expect(items.eq).toHaveBeenCalledWith('status', 'published');

    // バリアントは公開中の商品の分だけを、販売中（is_active）に絞って読む
    expect(supabase.from).toHaveBeenCalledWith('item_variants');
    expect(variants.select).toHaveBeenCalledWith('id, item_id, is_active, item_colors(name), item_sizes(label)');
    expect(variants.in).toHaveBeenCalledWith('item_id', [45, 46]);
    expect(variants.eq).toHaveBeenCalledWith('is_active', true);
    // 商品ごとのバリアントの並びが読み込みのたびに変わらないよう、商品の番号・バリアントの番号の昇順で読む
    expect(variants.order).toHaveBeenCalledTimes(2);
    expect(variants.order).toHaveBeenNthCalledWith(1, 'item_id', { ascending: true });
    expect(variants.order).toHaveBeenNthCalledWith(2, 'id', { ascending: true });

    // 画像の署名は service role のクライアントで行う
    expect(signItemImageUrl).toHaveBeenCalledWith(supabase, 'items/45.png');

    expect(res.status).toBe(200);
    // 中身が持ち主ごとで、持ち主を決めた後は Set-Cookie も載るため、キャッシュに残さない
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(await res.json()).toEqual([
      {
        id: 'line-3',
        item_id: 45,
        added_at: '2026-10-08T03:00:00Z',
        items: { ...publishedItems[0], image_url: 'items/45.png?signed' },
        variants: [
          { id: 1201, color: 'ブラック', size: 'M' },
          { id: 1202, color: 'ブラック', size: 'L' },
        ],
      },
      {
        id: 'line-1',
        item_id: 46,
        added_at: '2026-10-08T01:00:00Z',
        items: { ...publishedItems[1], image_url: null },
        variants: [{ id: 1301, color: null, size: null }],
      },
    ]);
    expect(context.finish).toHaveBeenCalledWith(res);
  });

  test('販売中のバリアントが無い商品は variants が空の配列', async () => {
    useDb({
      wishlist_lines: { data: [lineRows[0]], error: null },
      items: { data: [publishedItems[0]], error: null },
      item_variants: { data: [], error: null },
    });

    const res = await GET(get());

    expect(await res.json()).toEqual([
      expect.objectContaining({ id: 'line-3', item_id: 45, variants: [] }),
    ]);
  });

  test('公開中の商品が 1 つも無ければバリアントを読まずに [] を返す', async () => {
    const { supabase } = useDb({
      wishlist_lines: { data: lineRows, error: null },
      items: { data: [], error: null },
    });

    const res = await GET(get());

    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(await res.json()).toEqual([]);
    expect(supabase.from).not.toHaveBeenCalledWith('item_variants');
    expect(context.finish).toHaveBeenCalledWith(res);
  });

  test('回数の制限は IP ごとに 120 回・60 秒（持ち主を決める前）、持ち主ごとに 60 回・60 秒（決めた後）', async () => {
    const req = get();

    await GET(req);

    expect(enforceRateLimit).toHaveBeenCalledTimes(2);
    expect(enforceRateLimit).toHaveBeenNthCalledWith(1, { request: req, endpoint: 'wishlist:get', limit: 120, windowSeconds: 60 });
    expect(enforceRateLimit).toHaveBeenNthCalledWith(2, {
      request: req, endpoint: 'wishlist:get', limit: 60, windowSeconds: 60, subject: context.rateLimitSubject,
    });
    // ログインの確かめと合わせ込み（DB への書き込み）は、IP の制限を通った要求にだけ走らせる
    const [ipLimit, ownerLimit] = (enforceRateLimit as jest.Mock).mock.invocationCallOrder;
    const open = (openShoppingContext as jest.Mock).mock.invocationCallOrder[0];
    expect(ipLimit).toBeLessThan(open);
    expect(open).toBeLessThan(ownerLimit);
  });

  test('印の無いゲストには持ち主ごとの制限を呼ばず、IP ごとの制限だけで数える', async () => {
    context.rateLimitSubject = null;
    const req = get();

    const res = await GET(req);

    expect(res.status).toBe(200);
    expect(enforceRateLimit).toHaveBeenCalledTimes(1);
    expect(enforceRateLimit).toHaveBeenCalledWith({ request: req, endpoint: 'wishlist:get', limit: 120, windowSeconds: 60 });
  });

  test('IP ごとの制限が 429 ならその応答を返し、持ち主を決めず、持ち主の情報を入れずに監査する', async () => {
    const denied = NextResponse.json({ error: 'Too many requests' }, { status: 429 });
    (enforceRateLimit as jest.Mock).mockImplementation(async (options: { subject?: string }) => (options.subject ? undefined : denied));
    const { supabase } = useDb();

    expect(await GET(get())).toBe(denied);
    expect(logAudit).toHaveBeenCalledTimes(1);
    const audit = (logAudit as jest.Mock).mock.calls[0][0];
    expect(audit).toMatchObject({
      action: 'wishlist.get',
      outcome: 'rate_limited',
      detail: 'Rate limit exceeded for wishlist GET endpoint',
    });
    // IP で数えているので、持ち主の情報は入れない（持ち主はまだ決めていない）
    expect(audit).not.toHaveProperty('metadata');
    expect(createServiceRoleClient).not.toHaveBeenCalled();
    expect(openShoppingContext).not.toHaveBeenCalled();
    expect(supabase.from).not.toHaveBeenCalled();
  });

  test('持ち主ごとの制限が 429 ならその応答を返し、持ち主の情報つきで監査して何も読まない', async () => {
    const denied = NextResponse.json({ error: 'Too many requests' }, { status: 429 });
    (enforceRateLimit as jest.Mock).mockImplementation(async (options: { subject?: string }) => (options.subject ? denied : undefined));
    const { supabase } = useDb();

    expect(await GET(get())).toBe(denied);
    // 持ち主ごとの制限は持ち主を決めた後に数える
    expect(openShoppingContext).toHaveBeenCalledTimes(1);
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'wishlist.get',
      outcome: 'rate_limited',
      detail: 'Owner rate limit exceeded for wishlist GET endpoint',
      metadata: { ...context.auditOwner },
    }));
    expect(supabase.from).not.toHaveBeenCalled();
  });

  test('明細の読み込みが失敗したら 500 を返して finish を通す', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    useDb({ wishlist_lines: { data: null, error: { message: 'db down' } } });

    const res = await GET(get());

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to fetch wishlist' });
    expect(context.finish).toHaveBeenCalledWith(res);
  });

  test('商品の読み込みが失敗したら 500 を返して finish を通す', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    useDb({
      wishlist_lines: { data: lineRows, error: null },
      items: { data: null, error: { message: 'db down' } },
    });

    const res = await GET(get());

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to fetch items' });
    expect(context.finish).toHaveBeenCalledWith(res);
  });

  test('バリアントの読み込みが失敗したら 500 を返す', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    useDb({
      wishlist_lines: { data: lineRows, error: null },
      items: { data: publishedItems, error: null },
      item_variants: { data: null, error: { message: 'db down' } },
    });

    const res = await GET(get());

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
  });

  test('持ち主の行を引くのが失敗したら 500 を返す', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    context.findOwnerId.mockRejectedValueOnce(new Error('db down'));

    const res = await GET(get());

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
  });

  test('応答と監査に Cookie の印も完全なハッシュも入れない', async () => {
    const req = get();
    req.headers.set('cookie', `wishlist=${COOKIE_TOKEN}`);
    // 1回目は IP の制限を通し、持ち主ごとの制限で止めて、持ち主の情報つきの監査を残させる
    (enforceRateLimit as jest.Mock)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(NextResponse.json({ error: 'Too many requests' }, { status: 429 }));

    await GET(req);
    useDb({
      wishlist_lines: { data: lineRows, error: null },
      items: { data: publishedItems, error: null },
      item_variants: { data: variantRows, error: null },
    });
    const res = await GET(req);

    const audit = JSON.stringify((logAudit as jest.Mock).mock.calls);
    expect(audit).toContain('rate_limited');
    expect(audit).toContain('guest_hash_prefix');
    expect(audit).not.toContain(COOKIE_TOKEN);
    expect(audit).not.toContain(TOKEN_HASH);
    expect(audit).not.toContain('guest_token_hash');
    const body = await res.text();
    expect(body).not.toContain(COOKIE_TOKEN);
    expect(body).not.toContain(TOKEN_HASH);
    expect(body).not.toContain('guest_token_hash');
  });
});

function post(body: unknown) {
  return new NextRequest('http://localhost:3000/api/wishlist', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('POST /api/wishlist', () => {
  const publishedItem = { id: 45, name: 'リネンシャツ', status: 'published' };
  const insertedLine = { id: 'line-1', item_id: 45, added_at: '2026-10-08T03:00:00Z' };

  function useAddDb(results: Parameters<typeof useDb>[0] = {}) {
    return useDb({
      items: { data: publishedItem, error: null },
      wishlist_lines: { data: insertedLine, error: null },
      ...results,
    });
  }

  beforeEach(() => {
    useAddDb();
  });

  test('持ち主の確認が 401 ならその応答をそのまま返し、持ち主ごとの制限も書き込みもしない', async () => {
    const denied = NextResponse.json({ error: 'session_expired' }, { status: 401 });
    (openShoppingContext as jest.Mock).mockResolvedValueOnce({ ok: false, response: denied });
    const { supabase, publicSupabase } = useAddDb();
    const req = post({ item_id: 45 });

    expect(await POST(req)).toBe(denied);
    expect(openShoppingContext).toHaveBeenCalledWith(req, 'wishlist', supabase, { write: true });
    // IP の制限と CSRF の確認は持ち主を決める前に済んでいる。持ち主が決まっていないので、持ち主ごとの制限は呼ばない
    expect(enforceRateLimit).toHaveBeenCalledTimes(1);
    expect(enforceRateLimit).toHaveBeenCalledWith({ request: req, endpoint: 'wishlist:add', limit: 60, windowSeconds: 60 });
    expect(denyIfCsrfInvalid).toHaveBeenCalledTimes(1);
    expect(supabase.from).not.toHaveBeenCalled();
    expect(publicSupabase.from).not.toHaveBeenCalled();
  });

  test('回数の制限は IP ごとに 60 回・60 秒（持ち主を決める前）、持ち主ごとに 30 回・60 秒（決めた後）', async () => {
    const req = post({ item_id: 45 });

    const res = await POST(req);

    expect(res.status).toBe(201);
    expect(enforceRateLimit).toHaveBeenCalledTimes(2);
    expect(enforceRateLimit).toHaveBeenNthCalledWith(1, { request: req, endpoint: 'wishlist:add', limit: 60, windowSeconds: 60 });
    expect(enforceRateLimit).toHaveBeenNthCalledWith(2, {
      request: req, endpoint: 'wishlist:add', limit: 30, windowSeconds: 60, subject: context.rateLimitSubject,
    });
  });

  test('印の無いゲストには持ち主ごとの制限を呼ばず、IP ごとの制限だけで数える', async () => {
    context.rateLimitSubject = null;

    const res = await POST(post({ item_id: 45 }));

    expect(res.status).toBe(201);
    expect(enforceRateLimit).toHaveBeenCalledTimes(1);
  });

  test('IP ごとの制限が 429 ならその応答を返し、CSRF の確認も持ち主を決めることも書き込みもしない', async () => {
    const denied = NextResponse.json({ error: 'Too many requests' }, { status: 429 });
    (enforceRateLimit as jest.Mock).mockImplementation(async (options: { subject?: string }) => (options.subject ? undefined : denied));
    const { supabase, publicSupabase } = useAddDb();

    expect(await POST(post({ item_id: 45 }))).toBe(denied);
    expect(denyIfCsrfInvalid).not.toHaveBeenCalled();
    expect(createServiceRoleClient).not.toHaveBeenCalled();
    expect(openShoppingContext).not.toHaveBeenCalled();
    expect(context.ensureOwnerId).not.toHaveBeenCalled();
    expect(supabase.from).not.toHaveBeenCalled();
    expect(publicSupabase.from).not.toHaveBeenCalled();
  });

  test('持ち主ごとの制限が 429 ならその応答を返し、書き込みもしない', async () => {
    const denied = NextResponse.json({ error: 'Too many requests' }, { status: 429 });
    (enforceRateLimit as jest.Mock).mockImplementation(async (options: { subject?: string }) => (options.subject ? denied : undefined));
    const { supabase, publicSupabase } = useAddDb();

    expect(await POST(post({ item_id: 45 }))).toBe(denied);
    expect(context.ensureOwnerId).not.toHaveBeenCalled();
    expect(supabase.from).not.toHaveBeenCalled();
    expect(publicSupabase.from).not.toHaveBeenCalled();
  });

  test('CSRF の確認が 403 ならその応答を返し、持ち主を決めることも書き込みもしない', async () => {
    const denied = NextResponse.json({ error: 'Forbidden', reason: 'CSRF validation failed' }, { status: 403 });
    (denyIfCsrfInvalid as jest.Mock).mockResolvedValueOnce(denied);
    const { supabase, publicSupabase } = useAddDb();

    expect(await POST(post({ item_id: 45 }))).toBe(denied);
    // IP の制限は CSRF より前に数えるが、持ち主ごとの制限は持ち主を決めた後なので呼ばない
    expect(enforceRateLimit).toHaveBeenCalledTimes(1);
    expect(createServiceRoleClient).not.toHaveBeenCalled();
    expect(openShoppingContext).not.toHaveBeenCalled();
    expect(context.ensureOwnerId).not.toHaveBeenCalled();
    expect(supabase.from).not.toHaveBeenCalled();
    expect(publicSupabase.from).not.toHaveBeenCalled();
  });

  test('CSRF の確認は IP ごとの制限の後、持ち主を決める前に行う', async () => {
    await POST(post({ item_id: 45 }));

    const [ipLimit, ownerLimit] = (enforceRateLimit as jest.Mock).mock.invocationCallOrder;
    const csrf = (denyIfCsrfInvalid as jest.Mock).mock.invocationCallOrder[0];
    const open = (openShoppingContext as jest.Mock).mock.invocationCallOrder[0];
    expect(ipLimit).toBeLessThan(csrf);
    expect(csrf).toBeLessThan(open);
    expect(open).toBeLessThan(ownerLimit);
  });

  test.each([
    ['item_id が 0', { item_id: 0 }],
    ['item_id が文字列', { item_id: 'x' }],
    ['item_id が負の数', { item_id: -3 }],
    ['item_id が小数', { item_id: 1.5 }],
    ['item_id が無い', {}],
    ['壊れた JSON', '{'],
  ])('%s は 400 にして、商品を確かめず持ち主の行も作らない', async (_name, body) => {
    const { supabase, publicSupabase } = useAddDb();

    const res = await POST(post(body));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid request body' });
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'wishlist.add', outcome: 'failure', detail: 'Invalid request body', metadata: { ...context.auditOwner },
    }));
    expect(publicSupabase.from).not.toHaveBeenCalled();
    expect(context.ensureOwnerId).not.toHaveBeenCalled();
    expect(supabase.from).not.toHaveBeenCalled();
    expect(context.finish).toHaveBeenCalledWith(res);
  });

  test.each([
    ['無い商品', { data: null, error: { code: 'PGRST116', message: 'no rows' } }],
    ['公開中でない商品', { data: { id: 45, name: 'リネンシャツ', status: 'draft' }, error: null }],
  ])('%s は 404 にして、持ち主の行も作らない', async (_name, itemResult) => {
    const { supabase, publicSupabase, items } = useAddDb({ items: itemResult });

    const res = await POST(post({ item_id: 45 }));

    expect(publicSupabase.from).toHaveBeenCalledWith('items');
    expect(items.select).toHaveBeenCalledWith('id, name, status');
    expect(items.eq).toHaveBeenCalledWith('id', 45);
    expect(items.eq).toHaveBeenCalledWith('status', 'published');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Item not found' });
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'wishlist.add',
      outcome: 'failure',
      detail: 'Item not found or not published',
      metadata: { ...context.auditOwner, item_id: 45 },
    }));
    expect(context.ensureOwnerId).not.toHaveBeenCalled();
    expect(supabase.from).not.toHaveBeenCalled();
    expect(context.finish).toHaveBeenCalledWith(res);
  });

  test('持ち主の行を確保してから wishlist_lines に入れ、201 で { id, item_id, added_at } を返して finish を通す', async () => {
    const { supabase, lines } = useAddDb();

    const res = await POST(post({ item_id: 45 }));

    expect(context.ensureOwnerId).toHaveBeenCalledTimes(1);
    expect(supabase.from).toHaveBeenCalledWith('wishlist_lines');
    expect(lines.insert).toHaveBeenCalledWith({ wishlist_id: 'wishlist-1', item_id: 45 });
    expect(lines.select).toHaveBeenCalledWith('id, item_id, added_at');
    expect(context.ensureOwnerId.mock.invocationCallOrder[0]).toBeLessThan(lines.insert.mock.invocationCallOrder[0]);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual(insertedLine);
    expect(context.finish).toHaveBeenCalledWith(res);
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'wishlist.add',
      outcome: 'success',
      resource: 'wishlist',
      resource_id: 'line-1',
      metadata: { ...context.auditOwner, item_id: 45 },
    }));
  });

  test('印の無いゲストの最初の追加では、作った持ち主の情報を監査に入れる', async () => {
    context.rateLimitSubject = null;
    context.auditOwner = { owner: 'guest' };
    context.ensureOwnerId.mockImplementation(async () => {
      context.rateLimitSubject = `guest:${'a'.repeat(64)}`;
      context.auditOwner = { owner: 'guest', guest_hash_prefix: 'aaaaaaaaaaaa' };
      return 'wishlist-new';
    });
    const { lines } = useAddDb();

    const res = await POST(post({ item_id: 45 }));

    expect(res.status).toBe(201);
    expect(enforceRateLimit).toHaveBeenCalledTimes(1);
    expect(lines.insert).toHaveBeenCalledWith({ wishlist_id: 'wishlist-new', item_id: 45 });
    expect(context.finish).toHaveBeenCalledWith(res);
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'success', metadata: { owner: 'guest', guest_hash_prefix: 'aaaaaaaaaaaa', item_id: 45 },
    }));
  });

  test('同じ商品（一意の決まりの 23505）は 409 にして finish を通す', async () => {
    useAddDb({ wishlist_lines: { data: null, error: { code: '23505', message: 'duplicate key value' } } });

    const res = await POST(post({ item_id: 45 }));

    // 返す文言は今の窓口のまま（画面は状態の番号だけを見る）
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'Item already in wishlist' });
    expect(context.finish).toHaveBeenCalledWith(res);
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'wishlist.add',
      outcome: 'conflict',
      detail: 'Item already in wishlist',
      metadata: { ...context.auditOwner, item_id: 45 },
    }));
  });

  test('それ以外の書き込みの失敗は 500 にして finish を通す', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    useAddDb({ wishlist_lines: { data: null, error: { code: '08006', message: 'db down' } } });

    const res = await POST(post({ item_id: 45 }));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to add to wishlist' });
    expect(context.finish).toHaveBeenCalledWith(res);
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'wishlist.add',
      outcome: 'error',
      detail: 'Failed to add to wishlist',
      metadata: { ...context.auditOwner, item_id: 45 },
    }));
  });

  test('持ち主の行の確保が失敗したら 500 を返し、書き込まない', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    context.ensureOwnerId.mockRejectedValueOnce(new Error('db down'));
    const { lines } = useAddDb();

    const res = await POST(post({ item_id: 45 }));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
    expect(lines.insert).not.toHaveBeenCalled();
  });

  test('監査と応答に Cookie の印も完全なハッシュも入れない', async () => {
    const req = post({ item_id: 45 });
    req.headers.set('cookie', `wishlist=${COOKIE_TOKEN}`);

    const res = await POST(req);

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
