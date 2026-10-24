export {};

// 窓口・認可（admin-rbac）・監査（audit）は本物を通し、外との境目（Supabase の client・token の検証・応答の型）だけを差し替える
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
}));

jest.mock('@/lib/auth/authenticate', () => ({
  verifyAccessToken: jest.fn(),
  checkAuthSessionLiveness: jest.fn(),
}));

const { createClient, createServiceRoleClient } = require('@/lib/supabase/server');
const { verifyAccessToken, checkAuthSessionLiveness } = require('@/lib/auth/authenticate');
const { POST } = require('@/app/api/admin/news/route');

type Result = { data: unknown; error: unknown };
type Call = [string, unknown[]];
type TableOp = { table: string; calls: Call[] };
type Upload = { bucket: string; path: string; body: unknown; options: Record<string, unknown> };

function createFakeClient(tables: Record<string, Result>, uploadResult: Result = { data: {}, error: null }) {
  const ops: TableOp[] = [];
  const uploads: Upload[] = [];
  const removes: unknown[] = [];
  const client = {
    ops,
    uploads,
    removes,
    from: jest.fn((table: string) => {
      const op: TableOp = { table, calls: [] };
      ops.push(op);
      const result = () => tables[table] ?? { data: null, error: null };
      const builder: Record<string, unknown> = {};
      for (const m of ['select', 'insert', 'update', 'delete', 'eq', 'or', 'order']) {
        builder[m] = (...args: unknown[]) => {
          op.calls.push([m, args]);
          return builder;
        };
      }
      builder.single = () => Promise.resolve(result());
      builder.then = (onF: (v: Result) => unknown, onR?: (e: unknown) => unknown) => Promise.resolve(result()).then(onF, onR);
      return builder;
    }),
    storage: {
      from: jest.fn((bucket: string) => ({
        upload: jest.fn(async (path: string, body: unknown, options: Record<string, unknown>) => {
          uploads.push({ bucket, path, body, options });
          return uploadResult;
        }),
        remove: jest.fn(async (paths: unknown) => {
          removes.push(paths);
          return { data: null, error: null };
        }),
      })),
    },
  };
  return client;
}

function aclRows(codes: string[]) {
  return [{ roles: { role_permissions: codes.map((code) => ({ permissions: { code } })) } }];
}

const FIVE_MB = 5 * 1024 * 1024;

function makeImage(name: string, type: string, size?: number): File {
  const file = new File(['img'], name, { type });
  Object.defineProperty(file, 'arrayBuffer', { configurable: true, value: async () => new Uint8Array([1, 2, 3]).buffer });
  if (size !== undefined) Object.defineProperty(file, 'size', { configurable: true, value: size });
  return file;
}

const validFields = {
  title: 'Autumn collection',
  category: 'COLLECTION',
  date: '2026-10-24',
  content: 'Short summary',
  detailedContent: 'Long body',
  status: 'private',
};

function makeRequest(fields: Record<string, unknown> = { ...validFields, image: makeImage('a.jpg', 'image/jpeg') }, options: { formDataError?: Error } = {}) {
  return {
    headers: { get: (name: string) => (name.toLowerCase() === 'user-agent' ? 'jest-agent' : null) },
    formData: jest.fn(async () => {
      if (options.formDataError) throw options.formDataError;
      return { get: (key: string) => (key in fields ? fields[key] : null) };
    }),
  } as unknown as Request;
}

let userClient: ReturnType<typeof createFakeClient>;
let serviceClient: ReturnType<typeof createFakeClient>;

function setup(options: { insertResult?: Result; uploadResult?: Result; codes?: string[] } = {}) {
  userClient = createFakeClient({ news_articles: options.insertResult ?? { data: { id: 42 }, error: null } });
  serviceClient = createFakeClient(
    {
      user_roles: { data: aclRows(options.codes ?? ['admin.news.read', 'admin.news.manage']), error: null },
      audit_logs: { data: null, error: null },
    },
    options.uploadResult,
  );
  createClient.mockResolvedValue(userClient);
  createServiceRoleClient.mockResolvedValue(serviceClient);
  verifyAccessToken.mockResolvedValue({ ok: true, claims: { sub: 'admin-1', session_id: 'sess-1', aal: 'aal2', app_metadata: { role: 'admin' } } });
  checkAuthSessionLiveness.mockResolvedValue('active');
}

function insertedRows() {
  const op = userClient.ops.find((o) => o.table === 'news_articles');
  return op?.calls.find(([m]) => m === 'insert')?.[1][0] as Array<Record<string, unknown>> | undefined;
}

function auditRows() {
  return serviceClient.ops
    .filter((o) => o.table === 'audit_logs')
    .map((o) => (o.calls.find(([m]) => m === 'insert')?.[1][0] as Array<Record<string, unknown>>)[0]);
}

const PATH_PATTERN = /^news\/\d{4}-\d{2}-\d{2}\/[0-9a-f-]{36}\.(jpg|png|webp|gif)$/;


// 日付だけ固定する（タイマーと microtask は本物のまま）。0時をまたぐ実行で「今日」が割れないようにする
const FROZEN_NOW = new Date('2026-10-24T12:00:00.000Z');
function freezeDateOnly() {
  jest.useFakeTimers({
    now: FROZEN_NOW,
    doNotFake: [
      'hrtime', 'nextTick', 'performance', 'queueMicrotask', 'requestAnimationFrame', 'cancelAnimationFrame',
      'requestIdleCallback', 'cancelIdleCallback', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval',
      'setTimeout', 'clearTimeout',
    ],
  });
}

describe('POST /api/admin/news（記事の作成）', () => {
  beforeEach(() => {
    freezeDateOnly();
    jest.clearAllMocks();
    delete process.env.ALERT_AUDIT_URL;
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('API-NEWS-003 正しい入力なら画像を上げて表に入れ、201 で success と id を返す', async () => {
    setup();

    const res = await POST(makeRequest());

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ success: true, id: 42 });
    expect(serviceClient.uploads).toHaveLength(1);
    const upload = serviceClient.uploads[0];
    expect(upload.bucket).toBe('news-images');
    expect(upload.path).toMatch(PATH_PATTERN);
    expect(upload.path.slice(5, 15)).toBe(new Date().toISOString().slice(0, 10));
    expect(upload.options).toEqual({ contentType: 'image/jpeg', cacheControl: '3600', upsert: false });
    expect(insertedRows()).toEqual([
      {
        title: 'Autumn collection',
        category: 'COLLECTION',
        published_date: '2026-10-24',
        image_url: upload.path,
        content: 'Short summary',
        detailed_content: 'Long body',
        status: 'private',
      },
    ]);
  });

  it('API-NEWS-003 成功を admin.news.create として監査に残し、記事の id と user agent を記録して IP は残さない', async () => {
    setup();

    await POST(makeRequest());

    const rows = auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'admin.news.create',
      actor_id: 'admin-1',
      resource: 'news_article',
      resource_id: '42',
      outcome: 'success',
      user_agent: 'jest-agent',
      metadata: { storagePath: serviceClient.uploads[0].path, status: 'private', category: 'COLLECTION' },
    });
    expect(rows[0].ip).toBeUndefined();
  });

  it('API-NEWS-003 表が id を返さない時は監査の resource_id を null にする', async () => {
    setup({ insertResult: { data: { id: null }, error: null } });

    const res = await POST(makeRequest());

    expect(res.status).toBe(201);
    expect(auditRows()[0]).toMatchObject({ action: 'admin.news.create', resource_id: null });
  });

  it.each([
    ['image/jpeg', 'jpg'],
    ['image/png', 'png'],
    ['image/webp', 'webp'],
    ['image/gif', 'gif'],
  ])('API-NEWS-003 拡張子は送られた名前でなく種類 %s から %s に決める', async (type, ext) => {
    setup();

    const res = await POST(makeRequest({ ...validFields, image: makeImage('evil.php', type) }));

    expect(res.status).toBe(201);
    expect(serviceClient.uploads[0].path.endsWith(`.${ext}`)).toBe(true);
    expect(serviceClient.uploads[0].path).not.toContain('evil');
  });

  it('API-NEWS-003 保存の名前は要求ごとに別の uuid にする', async () => {
    setup();

    await POST(makeRequest());
    await POST(makeRequest());

    expect(serviceClient.uploads).toHaveLength(2);
    expect(serviceClient.uploads[0].path).not.toBe(serviceClient.uploads[1].path);
  });

  it('API-NEWS-003 上限ちょうど（題 200 字・要約 2000 字・本文 10000 字・画像 5MB）は受け付ける', async () => {
    setup();

    const res = await POST(
      makeRequest({
        ...validFields,
        title: 'a'.repeat(200),
        content: 'b'.repeat(2000),
        detailedContent: 'c'.repeat(10000),
        status: 'published',
        image: makeImage('a.png', 'image/png', FIVE_MB),
      }),
    );

    expect(res.status).toBe(201);
    expect(insertedRows()?.[0]).toMatchObject({ status: 'published' });
  });

  it('API-NEWS-003 文字の前後の空白は落として入れる', async () => {
    setup();

    await POST(makeRequest({ ...validFields, title: '  Spaced  ', image: makeImage('a.jpg', 'image/jpeg') }));

    expect(insertedRows()?.[0].title).toBe('Spaced');
  });

  it('API-NEWS-003 日付は形だけを確かめ、実在しない日も受け付ける', async () => {
    setup();

    const res = await POST(makeRequest({ ...validFields, date: '2026-02-31', image: makeImage('a.jpg', 'image/jpeg') }));

    expect(res.status).toBe(201);
    expect(insertedRows()?.[0].published_date).toBe('2026-02-31');
  });

  it.each([
    ['題が空白だけ', { title: '   ' }],
    ['題が 201 字', { title: 'a'.repeat(201) }],
    ['題が無い', { title: undefined }],
    ['分類が許可の外', { category: 'SALE' }],
    ['日付の形が違う', { date: '2026/10/24' }],
    ['要約が 2001 字', { content: 'b'.repeat(2001) }],
    ['要約が空', { content: '' }],
    ['本文が 10001 字', { detailedContent: 'c'.repeat(10001) }],
    ['状態が許可の外', { status: 'draft' }],
  ])('API-NEWS-003 %s の時は 400 Invalid request を返し、上げも入れもしない', async (_label, override) => {
    setup();
    const fields: Record<string, unknown> = { ...validFields, ...override, image: makeImage('a.jpg', 'image/jpeg') };
    for (const key of Object.keys(fields)) if (fields[key] === undefined) delete fields[key];

    const res = await POST(makeRequest(fields));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe('Invalid request');
    expect(body.details).toHaveProperty('fieldErrors');
    expect(serviceClient.uploads).toHaveLength(0);
    expect(userClient.ops).toHaveLength(0);
  });

  it.each([
    ['画像が無い', undefined],
    ['画像が文字', 'not-a-file'],
  ])('API-NEWS-003 %s の時は 400 Image file is required を返す', async (_label, image) => {
    setup();
    const fields: Record<string, unknown> = { ...validFields };
    if (image !== undefined) fields.image = image;

    const res = await POST(makeRequest(fields));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Image file is required' });
    expect(serviceClient.uploads).toHaveLength(0);
  });

  it('API-NEWS-003 許可の外の種類の画像は 400 Unsupported image type を返す', async () => {
    setup();

    const res = await POST(makeRequest({ ...validFields, image: makeImage('a.svg', 'image/svg+xml') }));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Unsupported image type' });
    expect(serviceClient.uploads).toHaveLength(0);
  });

  it('API-NEWS-003 5MB を超える画像は 400 Image size must be 5MB or less を返す', async () => {
    setup();

    const res = await POST(makeRequest({ ...validFields, image: makeImage('a.jpg', 'image/jpeg', FIVE_MB + 1) }));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Image size must be 5MB or less' });
    expect(serviceClient.uploads).toHaveLength(0);
  });

  it('API-NEWS-003 置き場への上げが失敗したら 500 を返し、upload_failed を監査に残して表に入れない', async () => {
    setup({ uploadResult: { data: null, error: { message: 'storage down' } } });

    const res = await POST(makeRequest());

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to upload image' });
    expect(insertedRows()).toBeUndefined();
    const rows = auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'admin.news.create.upload_failed',
      outcome: 'failure',
      resource_id: null,
      metadata: { status: 'private', imageType: 'image/jpeg' },
    });
  });

  it('API-NEWS-003 表への挿入が失敗したら 500 を返し、db_insert_failed を監査に残す（上げた画像は消さない）', async () => {
    setup({ insertResult: { data: null, error: { code: '42501', message: 'rls' } } });

    const res = await POST(makeRequest());

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to save news article' });
    const rows = auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'admin.news.create.db_insert_failed',
      outcome: 'failure',
      metadata: { storagePath: serviceClient.uploads[0].path, status: 'private', category: 'COLLECTION' },
    });
    expect(serviceClient.removes).toHaveLength(0);
  });

  it('API-NEWS-003 admin.news.manage の権限が無ければ 403 で断り、上げも監査もしない', async () => {
    setup({ codes: ['admin.news.read'] });

    const res = await POST(makeRequest());

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'Forbidden', permission: 'admin.news.manage' });
    expect(serviceClient.uploads).toHaveLength(0);
    expect(auditRows()).toHaveLength(0);
  });

  it('API-NEWS-003 multipart として読めない要求は 500 Internal server error を返す', async () => {
    setup();

    const res = await POST(makeRequest(undefined, { formDataError: new TypeError('Could not parse content as FormData.') }));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
    expect(serviceClient.uploads).toHaveLength(0);
  });
});
