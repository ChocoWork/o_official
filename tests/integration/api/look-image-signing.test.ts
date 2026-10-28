export {};

// 画像の書き込み（管理の POST・PUT）と配り（管理の GET・公開の取り出し・検索の署名）を、
// 窓口・admin-rbac・回数の制限・look-images・公開の取り出しを本物のまま通して確かめる。
// 差し替えるのは外との境目（Supabase の client・token の検証・応答の型）だけ
jest.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number; headers?: Record<string, string> }) => ({
      status: init?.status ?? 200,
      headers: new Map(Object.entries(init?.headers ?? {})),
      json: async () => body,
    }),
  },
}));

jest.mock('@/lib/supabase/server', () => ({
  createClient: jest.fn(),
  createServiceRoleClient: jest.fn(),
  createPublicClient: jest.fn(),
}));

jest.mock('@/lib/auth/authenticate', () => ({
  verifyAccessToken: jest.fn(),
  checkAuthSessionLiveness: jest.fn(),
}));

const { createServiceRoleClient, createPublicClient } = require('@/lib/supabase/server');
const { verifyAccessToken, checkAuthSessionLiveness } = require('@/lib/auth/authenticate');
const listRoute = require('@/app/api/admin/looks/route');
const itemRoute = require('@/app/api/admin/looks/[id]/route');
const { getPublishedLooks, getPublishedLookById } = require('@/lib/look/server');
const { signLookImageUrl, signLookImageUrls } = require('@/lib/storage/look-images');
const { fileOf, minimalPng } = require('../../fixtures/images');

type Result = { data: unknown; error: unknown };
type Method = 'select' | 'insert' | 'update' | 'delete';
type TableSpec = Partial<Record<Method, Result>>;
type Call = [string, unknown[]];
type TableOp = { table: string; calls: Call[] };
type SignCall = { bucket: string; path: string; expiresIn: number };

const WRITE_METHODS = ['insert', 'update', 'delete'];
const NONE: Result = { data: null, error: null };

function createFakeClient(
  tables: Record<string, TableSpec>,
  sign?: (path: string) => Result,
  /** admin_update_look の戻り（更新前の image_urls） */
  previousImages: unknown = ['looks/2026-01-01/old.jpg'],
) {
  const ops: TableOp[] = [];
  const updateLookCalls: Array<Record<string, unknown>> = [];
  const uploads: Array<{ bucket: string; path: string; options: Record<string, unknown> }> = [];
  const signCalls: SignCall[] = [];
  const removals: Array<{ bucket: string; paths: string[] }> = [];
  const client = {
    ops,
    uploads,
    removals,
    signCalls,
    updateLookCalls,
    rpc: jest.fn(async (name?: string, args?: Record<string, unknown>) => {
      if (name === 'admin_update_look') {
        updateLookCalls.push(args ?? {});
        return { data: previousImages, error: null };
      }
      return { data: 1, error: null };
    }),
    from: jest.fn((table: string) => {
      const op: TableOp = { table, calls: [] };
      ops.push(op);
      const result = (): Result => {
        const written = op.calls.map(([m]) => m).find((m) => WRITE_METHODS.includes(m)) as Method | undefined;
        return tables[table]?.[written ?? 'select'] ?? NONE;
      };
      const builder: Record<string, unknown> = {};
      for (const m of ['select', 'insert', 'update', 'delete', 'eq', 'in', 'or', 'order', 'limit']) {
        builder[m] = (...args: unknown[]) => {
          op.calls.push([m, args]);
          return builder;
        };
      }
      builder.single = () => Promise.resolve(result());
      builder.maybeSingle = () => Promise.resolve(result());
      builder.then = (onF: (v: Result) => unknown, onR?: (e: unknown) => unknown) =>
        Promise.resolve(result()).then(onF, onR);
      return builder;
    }),
    storage: {
      from: jest.fn((bucket: string) => ({
        upload: jest.fn(async (path: string, _body: unknown, options: Record<string, unknown>) => {
          uploads.push({ bucket, path, options });
          return { data: {}, error: null };
        }),
        remove: jest.fn(async (paths: string[]) => {
          removals.push({ bucket, paths });
          return { data: [], error: null };
        }),
        createSignedUrl: jest.fn(async (path: string, expiresIn: number) => {
          signCalls.push({ bucket, path, expiresIn });
          return sign ? sign(path) : { data: { signedUrl: `https://signed.example/${path}?e=${expiresIn}` }, error: null };
        }),
      })),
    },
  };
  return client;
}

function aclRows(codes: string[]) {
  return [{ roles: { role_permissions: codes.map((code) => ({ permissions: { code } })) } }];
}

function makeImage(): File {
  const file = fileOf(minimalPng(), 'photo.png', 'image/png');
  Object.defineProperty(file, 'arrayBuffer', {
    configurable: true,
    value: async () => new Uint8Array(minimalPng()).buffer,
  });
  return file;
}

const formFields: Record<string, unknown> = {
  seasonYear: '2026',
  seasonType: 'AW',
  theme: 'Quiet morning',
  themeDescription: '',
  status: 'private',
  linkedItemIds: JSON.stringify([3]),
};

function makeRequest(form: Record<string, unknown> = {}, images: unknown[] = []) {
  return {
    headers: { get: () => null },
    formData: jest.fn(async () => ({
      get: (key: string) => (key in form ? form[key] : null),
      getAll: (key: string) => (key === 'images' ? images : []),
    })),
  } as unknown as Request;
}

const params = () => ({ params: Promise.resolve({ id: '7' }) });

const EXISTING_LOOK = { id: 7, status: 'private', image_urls: ['looks/2026-01-01/old.jpg'] };

let publicClient: ReturnType<typeof createFakeClient>;
let serviceClient: ReturnType<typeof createFakeClient>;

function setup(
  options: {
    lookSelect?: Result;
    sign?: (path: string) => Result;
    publicTables?: Record<string, TableSpec>;
    /** admin_update_look の戻り（更新前の image_urls） */
    previousImages?: unknown;
  } = {},
) {
  const lookSelect = options.lookSelect ?? { data: EXISTING_LOOK, error: null };
  serviceClient = createFakeClient(
    {
      user_roles: { select: { data: aclRows(['admin.looks.read', 'admin.looks.manage']), error: null } },
      audit_logs: { insert: NONE },
      items: { select: { data: [{ id: 3 }], error: null } },
      looks: { select: lookSelect, insert: { data: { id: 11 }, error: null }, update: NONE, delete: NONE },
      look_items: { select: { data: [{ item_id: 3 }, { item_id: 9 }], error: null }, insert: NONE, delete: NONE },
    },
    options.sign,
    'previousImages' in options ? options.previousImages : undefined,
  );
  publicClient = createFakeClient(options.publicTables ?? {});
  createServiceRoleClient.mockResolvedValue(serviceClient);
  createPublicClient.mockResolvedValue(publicClient);
  verifyAccessToken.mockResolvedValue({
    ok: true,
    claims: { sub: 'admin-1', session_id: 'sess-1', aal: 'aal2', app_metadata: { role: 'admin' } },
  });
  checkAuthSessionLiveness.mockResolvedValue('active');
}

function writtenImageUrls(table: string, method: 'insert' | 'update'): unknown {
  const args = serviceClient.ops
    .filter((o) => o.table === table)
    .flatMap((o) => o.calls)
    .find(([m]) => m === method)?.[1][0];
  const row = Array.isArray(args) ? args[0] : args;
  return (row as Record<string, unknown> | undefined)?.image_urls;
}

async function listImageUrls(rawUrls: Array<string | null>) {
  setup({
    lookSelect: {
      data: [{ id: 1, season_year: 2026, season_type: 'SS', theme: 't', theme_description: '', status: 'published', created_at: '', look_items: [], image_urls: rawUrls }],
      error: null,
    },
  });
  const body = (await (await listRoute.GET(makeRequest())).json()) as { data: Array<{ image_urls: string[] }> };
  return body.data[0].image_urls;
}

const BASE = 'https://proj.supabase.co/storage/v1/object';

describe('画像の非公開の置き場と署名つき URL（ARC-LOOK-003）', () => {
  const envBackup = { ...process.env };

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.ALERT_AUDIT_URL;
    // 信頼する origin は自分のプロジェクト 1 つだけ（parseOwnObjectPath）
    delete process.env.SUPABASE_URL;
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://proj.supabase.co';
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = { ...envBackup };
    jest.restoreAllMocks();
  });

  describe('書く', () => {
    it('ARC-LOOK-003 作成は service role で置き場 look-images に上げ、表には署名前の道だけを入れて、書く時には署名しない', async () => {
      setup();

      const res = await listRoute.POST(makeRequest(formFields, [makeImage()]));

      expect(res.status).toBe(201);
      expect(serviceClient.uploads).toHaveLength(1);
      expect(serviceClient.uploads[0]).toMatchObject({ bucket: 'look-images', options: { upsert: false, cacheControl: '3600' } });
      const imageUrls = writtenImageUrls('looks', 'insert') as string[];
      expect(imageUrls).toEqual([serviceClient.uploads[0].path]);
      expect(imageUrls[0]).toMatch(/^looks\/\d{4}-\d{2}-\d{2}\/[0-9a-f-]{36}\.png$/);
      expect(imageUrls[0]).not.toMatch(/^https?:/);
      expect(serviceClient.signCalls).toHaveLength(0);
    });

    it('ARC-LOOK-003 更新で画像を付けた時は service role で上げ、image_urls を新しい道だけに差し替える', async () => {
      setup();

      const res = await itemRoute.PUT(makeRequest(formFields, [makeImage(), makeImage()]), params());

      expect(res.status).toBe(200);
      expect(serviceClient.uploads).toHaveLength(2);
      expect(serviceClient.uploads.every((u) => u.bucket === 'look-images')).toBe(true);
      expect(serviceClient.updateLookCalls[0]._image_urls).toEqual(serviceClient.uploads.map((u) => u.path));
      expect(serviceClient.signCalls).toHaveLength(0);
    });

    it('ARC-LOOK-003 更新で画像を差し替えたら、更新の後に rpc の戻り（更新前）の古い道を service role で同じ置き場から消し、新しい道は消さない', async () => {
      setup();

      const res = await itemRoute.PUT(makeRequest(formFields, [makeImage()]), params());

      expect(res.status).toBe(200);
      expect(serviceClient.removals).toEqual([{ bucket: 'look-images', paths: ['looks/2026-01-01/old.jpg'] }]);
      expect(serviceClient.removals[0].paths).not.toContain(serviceClient.uploads[0].path);
    });

    it('ARC-LOOK-003 更新で画像を付けない時は上げず、_image_urls に NULL を渡して今ある道を関数に保たせ、何も消さない', async () => {
      setup();

      const res = await itemRoute.PUT(makeRequest(formFields), params());

      expect(res.status).toBe(200);
      expect(serviceClient.uploads).toHaveLength(0);
      expect(serviceClient.updateLookCalls[0]._image_urls).toBeNull();
      expect(serviceClient.removals).toEqual([]);
    });

    it('ARC-LOOK-003 更新の戻り（更新前の image_urls）が配列でなくても、画像を付けない時は成功で何も消さない', async () => {
      setup({ previousImages: null });

      const res = await itemRoute.PUT(makeRequest(formFields), params());

      expect(res.status).toBe(200);
      expect(serviceClient.removals).toEqual([]);
    });
  });

  describe('管理の画面へ配る', () => {
    it('ARC-LOOK-003 管理の一覧は保存の道を service role で期限 3600 秒の署名つき URL にして返す', async () => {
      const urls = await listImageUrls(['looks/2026-10-24/a.png', 'looks/2026-10-24/b.jpg']);

      expect(urls).toEqual([
        'https://signed.example/looks/2026-10-24/a.png?e=3600',
        'https://signed.example/looks/2026-10-24/b.jpg?e=3600',
      ]);
      expect(serviceClient.signCalls).toEqual([
        { bucket: 'look-images', path: 'looks/2026-10-24/a.png', expiresIn: 3600 },
        { bucket: 'look-images', path: 'looks/2026-10-24/b.jpg', expiresIn: 3600 },
      ]);
    });

    it('ARC-LOOK-003 管理の1件の GET も image_urls を署名つき URL にして返し、紐づく商品の id を付ける', async () => {
      setup({ lookSelect: { data: { id: 7, theme: 'T', image_urls: ['looks/2026-10-24/b.webp'] }, error: null } });

      const res = await itemRoute.GET(makeRequest(), params());
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.data.image_urls).toEqual(['https://signed.example/looks/2026-10-24/b.webp?e=3600']);
      expect(body.data.linkedItemIds).toEqual([3, 9]);
    });

    it('ARC-LOOK-003 管理の1件の GET で image_urls が配列でなければ署名せず空の配列で返す', async () => {
      setup({ lookSelect: { data: { id: 7, theme: 'T', image_urls: null }, error: null } });

      const body = await (await itemRoute.GET(makeRequest(), params())).json();

      expect(body.data.image_urls).toEqual([]);
      expect(serviceClient.signCalls).toHaveLength(0);
    });

    it.each([
      ['旧 public の URL', `${BASE}/public/look-images/looks/old/a.jpg`, 'looks/old/a.jpg'],
      ['署名つき URL（token 付き）', `${BASE}/sign/look-images/looks/old/b.jpg?token=abc`, 'looks/old/b.jpg'],
      ['authenticated の URL', `${BASE}/authenticated/look-images/looks/old/c.jpg`, 'looks/old/c.jpg'],
      ['符号化した安全な文字の道の URL', `${BASE}/public/look-images/looks/old/%61-b.jpg`, 'looks/old/a-b.jpg'],
      ['先頭に / と空白のある道', '  /looks/old/e.jpg ', 'looks/old/e.jpg'],
    ])('ARC-LOOK-003 %s からも置き場の中の道を取り出して署名する', async (_label, raw, path) => {
      const urls = await listImageUrls([raw]);

      expect(serviceClient.signCalls).toEqual([{ bucket: 'look-images', path, expiresIn: 3600 }]);
      expect(urls).toEqual([`https://signed.example/${path}?e=3600`]);
    });

    it.each([
      ['ほかの置き場の URL', `${BASE}/public/other-bucket/a.jpg`],
      ['置き場の印の後が空の URL', `${BASE}/public/look-images/`],
      ['URL として読めない値', 'https://'],
      ['外の host の URL', 'https://evil.example/storage/v1/object/public/look-images/looks/a.jpg'],
      ['別のプロジェクトの URL', 'https://other.supabase.co/storage/v1/object/public/look-images/looks/a.jpg'],
      ['.. で上へ出る道', '../dir/x.png'],
      ['looks/ の外の道', 'dir/x.png'],
    ])('ARC-LOOK-003 %s は道にできないので署名せず、元の値を返さず落とす', async (_label, raw) => {
      const urls = await listImageUrls([raw]);

      expect(serviceClient.signCalls).toHaveLength(0);
      expect(urls).toEqual([]);
    });

    it('ARC-LOOK-003 空の値は結果から落とし、残りだけを署名して返す', async () => {
      const urls = await listImageUrls([null, '', 'looks/2026-10-24/a.png']);

      expect(serviceClient.signCalls).toHaveLength(1);
      expect(urls).toEqual(['https://signed.example/looks/2026-10-24/a.png?e=3600']);
    });

    it.each([
      ['署名が error を返す', { data: null, error: { message: 'not found' } }],
      ['署名が URL を返さない', { data: { signedUrl: '' }, error: null }],
      ['署名が data を返さない', { data: null, error: null }],
    ])('ARC-LOOK-003 %s の時は元の値を返さず落とす', async (_label, signResult) => {
      setup({
        lookSelect: {
          data: [{ id: 1, season_year: 2026, season_type: 'SS', theme: 't', theme_description: '', status: 'published', created_at: '', look_items: [], image_urls: ['looks/x/a.png'] }],
          error: null,
        },
        sign: () => signResult,
      });

      const body = await (await listRoute.GET(makeRequest())).json();

      expect(serviceClient.signCalls).toHaveLength(1);
      expect(body.data[0].image_urls).toEqual([]);
    });
  });

  describe('署名の関数（検索のサムネイルも同じ関数を使う）', () => {
    it('ARC-LOOK-003 1枚の署名は期限を指定しなければ 3600 秒、指定すればその秒数にする', async () => {
      setup();

      await signLookImageUrl(serviceClient, 'looks/a.jpg');
      await signLookImageUrl(serviceClient, 'looks/b.jpg', 120);

      expect(serviceClient.signCalls).toEqual([
        { bucket: 'look-images', path: 'looks/a.jpg', expiresIn: 3600 },
        { bucket: 'look-images', path: 'looks/b.jpg', expiresIn: 120 },
      ]);
    });

    it('ARC-LOOK-003 値が null・undefined・空なら 1枚の署名は null を返し、署名しない', async () => {
      setup();

      expect(await signLookImageUrl(serviceClient, null)).toBeNull();
      expect(await signLookImageUrl(serviceClient, undefined)).toBeNull();
      expect(await signLookImageUrl(serviceClient, '')).toBeNull();
      expect(serviceClient.signCalls).toHaveLength(0);
    });

    it('ARC-LOOK-003 検索のサムネイルの旧 public URL も署名つき URL にして返す', async () => {
      setup();

      const signed = await signLookImageUrl(serviceClient, `${BASE}/public/look-images/looks/s/thumb.jpg`);

      expect(signed).toBe('https://signed.example/looks/s/thumb.jpg?e=3600');
    });

    it('ARC-LOOK-003 配列の署名は互いに待たず同時に始め、並びを保つ', async () => {
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started: string[] = [];
      const supabase = {
        storage: {
          from: () => ({
            createSignedUrl: async (path: string) => {
              started.push(path);
              await gate;
              return { data: { signedUrl: `signed:${path}` }, error: null };
            },
          }),
        },
      };

      const pending = signLookImageUrls(supabase, ['looks/1.jpg', 'looks/2.jpg', 'looks/3.jpg']);
      await Promise.resolve();
      await Promise.resolve();

      expect(started).toEqual(['looks/1.jpg', 'looks/2.jpg', 'looks/3.jpg']);
      release();
      expect(await pending).toEqual(['signed:looks/1.jpg', 'signed:looks/2.jpg', 'signed:looks/3.jpg']);
    });
  });

  describe('公開の画面へ配る', () => {
    const LOOK_ROWS = [
      { id: 2, season_year: 2026, season_type: 'AW', theme: 'Newer', theme_description: 'd', image_urls: ['looks/p/b.jpg', `${BASE}/public/look-images/looks/p/c.jpg`], created_at: '2026-10-20T00:00:00Z' },
      { id: 1, season_year: 2026, season_type: 'SS', theme: 'Older', theme_description: '', image_urls: [], created_at: '2026-04-01T00:00:00Z' },
    ];

    function publicTables(): Record<string, TableSpec> {
      return {
        looks: { select: { data: LOOK_ROWS, error: null } },
        look_items: { select: { data: [{ look_id: 2, item_id: 4 }], error: null } },
        items: { select: { data: [{ id: 4, category: 'TOPS', name: 'Shirt', price: 9000, image_url: 'items/look-signing-test/shirt.jpg' }], error: null } },
      };
    }

    it('ARC-LOOK-003 公開の一覧は匿名の client で公開済みを読み、画像は service role で期限 3600 秒の署名つき URL にする', async () => {
      setup({ publicTables: publicTables() });

      const looks = await getPublishedLooks();

      expect(looks.map((l: { id: number }) => l.id)).toEqual([2, 1]);
      expect(looks[0].imageUrls).toEqual([
        'https://signed.example/looks/p/b.jpg?e=3600',
        'https://signed.example/looks/p/c.jpg?e=3600',
      ]);
      expect(looks[1].imageUrls).toEqual([]);
      const lookOp = publicClient.ops.find((o) => o.table === 'looks');
      expect(lookOp?.calls).toEqual(expect.arrayContaining([['eq', ['status', 'published']]]));
      expect(serviceClient.signCalls.filter((c) => c.bucket === 'look-images')).toEqual([
        { bucket: 'look-images', path: 'looks/p/b.jpg', expiresIn: 3600 },
        { bucket: 'look-images', path: 'looks/p/c.jpg', expiresIn: 3600 },
      ]);
    });

    it('ARC-LOOK-003 公開の取り出しで service role は画像の署名だけに使い、表は読まない', async () => {
      setup({ publicTables: publicTables() });

      await getPublishedLooks();

      expect(serviceClient.ops).toHaveLength(0);
      expect(publicClient.signCalls).toHaveLength(0);
    });

    it('ARC-LOOK-003 公開の一覧が 0 件なら署名の client を用意せず空の配列を返す', async () => {
      setup({ publicTables: { looks: { select: { data: [], error: null } } } });

      const looks = await getPublishedLooks();

      expect(looks).toEqual([]);
      expect(createServiceRoleClient).not.toHaveBeenCalled();
    });

    it('ARC-LOOK-003 公開の詳細も画像を署名し、LOOK が無ければ署名しない', async () => {
      setup({
        publicTables: {
          looks: { select: { data: LOOK_ROWS[0], error: null } },
          look_items: { select: { data: [{ look_id: 2, item_id: 4 }], error: null } },
          items: publicTables().items,
        },
      });
      const found = await getPublishedLookById(2);
      expect(found.imageUrls).toEqual([
        'https://signed.example/looks/p/b.jpg?e=3600',
        'https://signed.example/looks/p/c.jpg?e=3600',
      ]);
      expect(found.linkedItems).toHaveLength(1);

      setup({ publicTables: { looks: { select: { data: null, error: null } } } });
      const missing = await getPublishedLookById(404);
      expect(missing).toBeNull();
      expect(serviceClient.signCalls).toHaveLength(0);
    });

    it('ARC-LOOK-003 公開の取り出しが DB の失敗で終わった時は、無い LOOK として返さず投げ、画像も署名しない', async () => {
      const { LookFetchError } = require('@/lib/look/server');
      setup({ publicTables: { looks: { select: { data: null, error: { code: '57014', message: 'timeout' } } } } });
      jest.spyOn(console, 'error').mockImplementation(() => undefined);

      await expect(getPublishedLookById(2)).rejects.toBeInstanceOf(LookFetchError);

      setup({ publicTables: { looks: { select: { data: LOOK_ROWS, error: null } }, look_items: { select: { data: null, error: { code: '57014', message: 'timeout' } } } } });
      await expect(getPublishedLooks()).resolves.toEqual([]);
      expect(serviceClient.signCalls).toHaveLength(0);
    });
  });
});
