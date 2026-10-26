import { minimalGif, minimalJpeg, minimalPng, minimalWebp, textAsImage } from '../../fixtures/images';

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
const { PUT } = require('@/app/api/admin/news/[id]/route');

type Result = { data: unknown; error: unknown };
type Call = [string, unknown[]];
type TableOp = { table: string; calls: Call[] };
type Upload = { bucket: string; path: string; body: unknown; options: Record<string, unknown> };

// 1件の読み（maybeSingle）は '<表>:read' の結果を返す。無ければ表の結果と同じ物を返す
function createFakeClient(tables: Record<string, Result>, uploadResult: Result = { data: {}, error: null }) {
  const ops: TableOp[] = [];
  const uploads: Upload[] = [];
  const removes: unknown[] = [];
  return {
    ops,
    uploads,
    removes,
    from: jest.fn((table: string) => {
      const op: TableOp = { table, calls: [] };
      ops.push(op);
      const result = () => tables[table] ?? { data: null, error: null };
      const builder: Record<string, unknown> = {};
      for (const m of ['select', 'insert', 'update', 'delete', 'eq', 'or']) {
        builder[m] = (...args: unknown[]) => {
          op.calls.push([m, args]);
          return builder;
        };
      }
      builder.maybeSingle = () => Promise.resolve(tables[`${table}:read`] ?? result());
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
}

function aclRows(codes: string[]) {
  return [{ roles: { role_permissions: codes.map((code) => ({ permissions: { code } })) } }];
}

const FIVE_MB = 5 * 1024 * 1024;

const validFields: Record<string, unknown> = {
  title: 'Autumn collection',
  category: 'EVENT',
  date: '2026-10-24',
  content: 'Short summary',
  detailedContent: 'Long body',
  status: 'published',
};

const REAL_BYTES: Record<string, () => Buffer> = {
  'image/jpeg': minimalJpeg,
  'image/png': minimalPng,
  'image/webp': minimalWebp,
  'image/gif': minimalGif,
};

function makeImage(name: string, type: string, size?: number, bytes?: Buffer): File {
  const content = bytes ?? REAL_BYTES[type]?.() ?? textAsImage();
  const file = new File([new Uint8Array(content)], name, { type });
  Object.defineProperty(file, 'arrayBuffer', {
    configurable: true,
    value: async () => new Uint8Array(content).buffer,
  });
  if (size !== undefined) {
    Object.defineProperty(file, 'size', { configurable: true, value: size });
  }
  return file;
}

// 試験の環境の Request は multipart を解析できないので、route が使う formData と headers だけを持つ形を渡す
function makeRequest(options: {
  fields?: Record<string, unknown>;
  userAgent?: string | null;
  formDataError?: Error;
} = {}) {
  const fields = options.fields ?? { ...validFields };
  const form = { get: (key: string) => (key in fields ? fields[key] : null) };
  return {
    headers: {
      get: (name: string) =>
        name.toLowerCase() === 'user-agent' ? (options.userAgent === undefined ? 'jest-agent' : options.userAgent) : null,
    },
    formData: jest.fn(async () => {
      if (options.formDataError) throw options.formDataError;
      return form;
    }),
  } as unknown as Request;
}

function ctx(id = '7') {
  return { params: Promise.resolve({ id }) };
}

let userClient: ReturnType<typeof createFakeClient>;
let serviceClient: ReturnType<typeof createFakeClient>;

const OLD_IMAGE = 'news/2026-01-01/old.png';

function setup(options: { uploadResult?: Result; updateResult?: Result; readResult?: Result; codes?: string[] } = {}) {
  // 更新は .select('id') で変えた行を返す。既定は 1 行（0 行は 404 になる: SEC-NEWS-016）
  // 画像つきの更新が上げる前に読む古い image_url は、既定で古い画像の行（SEC-NEWS-018）
  userClient = createFakeClient({
    news_articles: options.updateResult ?? { data: [{ id: '7' }], error: null },
    'news_articles:read': options.readResult ?? { data: { image_url: OLD_IMAGE }, error: null },
  });
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

function newsOps() {
  return userClient.ops.filter((o) => o.table === 'news_articles');
}

function updatePayload() {
  return newsOps()
    .flatMap((op) => op.calls)
    .find(([m]) => m === 'update')?.[1][0] as Record<string, unknown> | undefined;
}

function auditRows() {
  return serviceClient.ops
    .filter((o) => o.table === 'audit_logs')
    .map((o) => (o.calls.find(([m]) => m === 'insert')?.[1][0] as Array<Record<string, unknown>>)[0]);
}

const expectedPayload = {
  title: 'Autumn collection',
  category: 'EVENT',
  published_date: '2026-10-24',
  content: 'Short summary',
  detailed_content: 'Long body',
  status: 'published',
};

const realRandomUUID = globalThis.crypto.randomUUID;
const datePrefix = () => `news/${new Date().toISOString().slice(0, 10)}/`;

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

describe('PUT /api/admin/news/[id]（管理の記事1件の更新）', () => {
  beforeEach(() => {
    freezeDateOnly();
    jest.clearAllMocks();
    delete process.env.ALERT_AUDIT_URL;
    Object.defineProperty(globalThis.crypto, 'randomUUID', {
      configurable: true,
      value: jest.fn(() => 'uuid-1'),
    });
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    Object.defineProperty(globalThis.crypto, 'randomUUID', { configurable: true, value: realRandomUUID });
    jest.useRealTimers();
  });

  test('API-NEWS-005 admin.news.manage が無ければ 403 で断り、本文を読まず表も監査も触らない', async () => {
    setup({ codes: ['admin.news.read'] });
    const request = makeRequest();

    const res = await PUT(request, ctx());

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'Forbidden', permission: 'admin.news.manage' });
    expect((request as unknown as { formData: jest.Mock }).formData).not.toHaveBeenCalled();
    expect(createClient).not.toHaveBeenCalled();
    expect(auditRows()).toHaveLength(0);
  });

  test('API-NEWS-005 token が検証で断られたら 401 で断り、本文を読まない', async () => {
    setup();
    verifyAccessToken.mockResolvedValue({ ok: false, reason: 'expired' });
    const request = makeRequest();

    const res = await PUT(request, ctx());

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
    expect((request as unknown as { formData: jest.Mock }).formData).not.toHaveBeenCalled();
  });

  test('API-NEWS-005 画像なしでも行を更新し、image_url を変えずに 200 と成功の監査を残す', async () => {
    setup();
    const request = makeRequest();

    const res = await PUT(request, ctx('7'));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(serviceClient.uploads).toHaveLength(0);
    expect(createClient).toHaveBeenCalledWith(request);
    expect(newsOps()).toHaveLength(1);
    expect(newsOps()[0].calls).toEqual([
      ['update', [expectedPayload]],
      ['eq', ['id', '7']],
      ['select', ['id']],
    ]);
    expect(serviceClient.ops.some((o) => o.table === 'news_articles')).toBe(false);
    const rows = auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'admin.news.update',
      actor_id: 'admin-1',
      resource: 'news_article',
      resource_id: '7',
      outcome: 'success',
      detail: 'News article updated',
      user_agent: 'jest-agent',
      metadata: { articleId: '7', status: 'published', category: 'EVENT' },
    });
    expect(rows[0].ip).toBeUndefined();
  });

  test('API-NEWS-005 文字の image は画像として扱わず、上げずに更新する', async () => {
    setup();

    const res = await PUT(makeRequest({ fields: { ...validFields, image: 'not-a-file' } }), ctx());

    expect(res.status).toBe(200);
    expect(serviceClient.uploads).toHaveLength(0);
    expect(updatePayload()).not.toHaveProperty('image_url');
  });

  test('API-NEWS-005 画像があれば置き場へ上げ、拡張子を送られた名前でなく検出した種類から決めて image_url に入れる（SEC-NEWS-017）', async () => {
    setup();
    const image = makeImage('photo.final.html', 'image/png');

    const res = await PUT(makeRequest({ fields: { ...validFields, image } }), ctx());

    expect(res.status).toBe(200);
    const expectedPath = `${datePrefix()}uuid-1.png`;
    expect(serviceClient.uploads).toHaveLength(1);
    expect(serviceClient.uploads[0]).toMatchObject({
      bucket: 'news-images',
      path: expectedPath,
      options: { contentType: 'image/png', cacheControl: '3600', upsert: false },
    });
    expect(Buffer.isBuffer(serviceClient.uploads[0].body)).toBe(true);
    expect(updatePayload()).toEqual({ ...expectedPayload, image_url: expectedPath });
  });

  test('API-NEWS-005 ファイル名に . が無くても、拡張子は種類 image/webp から webp にする', async () => {
    setup();
    const image = makeImage('photo', 'image/webp');

    await PUT(makeRequest({ fields: { ...validFields, image } }), ctx());

    const expectedPath = `${datePrefix()}uuid-1.webp`;
    expect(serviceClient.uploads[0].path).toBe(expectedPath);
    expect(updatePayload()).toEqual({ ...expectedPayload, image_url: expectedPath });
  });

  test('API-NEWS-005 許さない種類の画像は 400 Unsupported image type で上げも更新もしない', async () => {
    setup();
    const image = makeImage('a.svg', 'image/svg+xml');

    const res = await PUT(makeRequest({ fields: { ...validFields, image } }), ctx());

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Unsupported image type' });
    expect(serviceClient.uploads).toHaveLength(0);
    expect(newsOps()).toHaveLength(0);
  });

  test('API-NEWS-005 HTML を image/png と申告した画像は 400 Unsupported image type で、古い値の読みも上げも更新もしない（SEC-NEWS-017）', async () => {
    setup();
    const image = makeImage('a.png', 'image/png', undefined, Buffer.from('<html><script>1</script></html>'));

    const res = await PUT(makeRequest({ fields: { ...validFields, image } }), ctx());

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Unsupported image type' });
    expect(serviceClient.uploads).toHaveLength(0);
    expect(newsOps()).toHaveLength(0);
    expect(serviceClient.removes).toHaveLength(0);
  });

  test('API-NEWS-005 画像ありで記事が無い時（古い値の読みが null）は 404 で、何も上げず、置き場も消さない（SEC-NEWS-018）', async () => {
    setup({ readResult: { data: null, error: null } });
    const image = makeImage('a.png', 'image/png');

    const res = await PUT(makeRequest({ fields: { ...validFields, image } }), ctx('7'));

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Article not found' });
    expect(serviceClient.uploads).toHaveLength(0);
    expect(serviceClient.removes).toHaveLength(0);
    expect(updatePayload()).toBeUndefined();
    expect(auditRows()[0]).toMatchObject({ action: 'admin.news.update.not_found', outcome: 'failure', resource_id: '7' });
  });

  test('API-NEWS-005 画像ありの更新が成功したら、読んでおいた古い画像を置き場から消し、新しい画像は消さない（SEC-NEWS-018）', async () => {
    setup();
    const image = makeImage('a.png', 'image/png');

    const res = await PUT(makeRequest({ fields: { ...validFields, image } }), ctx('7'));

    expect(res.status).toBe(200);
    const newPath = serviceClient.uploads[0].path;
    expect(serviceClient.removes).toEqual([[OLD_IMAGE]]);
    expect(serviceClient.removes.flat()).not.toContain(newPath);
    expect(auditRows()[0]).toMatchObject({
      action: 'admin.news.update',
      metadata: { articleId: '7', status: 'published', category: 'EVENT', imageCleanup: 'ok' },
    });
  });

  test('API-NEWS-005 画像ありの更新が失敗したら、その要求で上げた新しい画像を消し、古い画像は消さない（SEC-NEWS-018）', async () => {
    setup({ updateResult: { data: null, error: { message: 'rls denied' } } });
    const image = makeImage('a.png', 'image/png');

    const res = await PUT(makeRequest({ fields: { ...validFields, image } }), ctx('7'));

    expect(res.status).toBe(500);
    expect(serviceClient.removes).toEqual([[serviceClient.uploads[0].path]]);
    expect(serviceClient.removes.flat()).not.toContain(OLD_IMAGE);
  });

  test('API-NEWS-005 画像ありの更新が 0 行なら 404 を返し、新しい画像を消す（SEC-NEWS-018）', async () => {
    setup({ updateResult: { data: [], error: null } });
    const image = makeImage('a.png', 'image/png');

    const res = await PUT(makeRequest({ fields: { ...validFields, image } }), ctx('7'));

    expect(res.status).toBe(404);
    expect(serviceClient.removes).toEqual([[serviceClient.uploads[0].path]]);
  });

  test('API-NEWS-005 画像なしの更新は、置き場から何も消さない', async () => {
    setup();

    await PUT(makeRequest(), ctx('7'));

    expect(serviceClient.removes).toHaveLength(0);
  });

  test('API-NEWS-005 5MB ちょうどは通り、5MB を超える画像は 400 で上げない', async () => {
    setup();
    const atLimit = await PUT(
      makeRequest({ fields: { ...validFields, image: makeImage('a.gif', 'image/gif', FIVE_MB) } }),
      ctx()
    );
    expect(atLimit.status).toBe(200);
    expect(serviceClient.uploads).toHaveLength(1);

    setup();
    const tooBig = await PUT(
      makeRequest({ fields: { ...validFields, image: makeImage('a.gif', 'image/gif', FIVE_MB + 1) } }),
      ctx()
    );
    expect(tooBig.status).toBe(400);
    expect(await tooBig.json()).toEqual({ error: 'Image size must be 5MB or less' });
    expect(serviceClient.uploads).toHaveLength(0);
    expect(newsOps()).toHaveLength(0);
  });

  test.each([
    ['空の題', { title: '   ' }],
    ['201字の題', { title: 'a'.repeat(201) }],
    ['決まりに無い分類', { category: 'SALE' }],
    ['形の違う日付', { date: '2026/10/24' }],
    ['2001字の概要', { content: 'a'.repeat(2001) }],
    ['10001字の本文', { detailedContent: 'a'.repeat(10001) }],
    ['決まりに無い状態', { status: 'draft' }],
    ['欠けた題', { title: null }],
  ])('API-NEWS-005 %s は 400 Invalid request で表に触らない', async (_label, override) => {
    setup();

    const res = await PUT(makeRequest({ fields: { ...validFields, ...override } }), ctx());
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toBe('Invalid request');
    expect(json.details).toHaveProperty('fieldErrors');
    expect(createClient).not.toHaveBeenCalled();
    expect(auditRows()).toHaveLength(0);
  });

  test('API-NEWS-005 上限ちょうどの長さと前後の空白は通り、空白を除いて保存する', async () => {
    setup();

    const res = await PUT(
      makeRequest({
        fields: {
          ...validFields,
          title: ` ${'t'.repeat(200)} `,
          content: 'c'.repeat(2000),
          detailedContent: 'd'.repeat(10000),
        },
      }),
      ctx()
    );

    expect(res.status).toBe(200);
    expect(updatePayload()).toEqual({
      ...expectedPayload,
      title: 't'.repeat(200),
      content: 'c'.repeat(2000),
      detailed_content: 'd'.repeat(10000),
    });
  });

  test('API-NEWS-005 置き場の失敗は 500 と upload_failed の監査を残し、表を更新しない', async () => {
    setup({ uploadResult: { data: null, error: { message: 'bucket full' } } });
    const image = makeImage('a.jpg', 'image/jpeg');

    const res = await PUT(makeRequest({ fields: { ...validFields, image }, userAgent: null }), ctx('9'));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to upload image' });
    expect(updatePayload()).toBeUndefined();
    expect(serviceClient.removes).toHaveLength(0);
    const rows = auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'admin.news.update.upload_failed',
      actor_id: 'admin-1',
      resource: 'news_article',
      resource_id: '9',
      outcome: 'failure',
      detail: 'Image upload failed',
      user_agent: null,
      metadata: { storagePath: `${datePrefix()}uuid-1.jpg`, articleId: '9', imageType: 'image/jpeg' },
    });
  });

  test('API-NEWS-005 表の更新の失敗は 500 と update.failed の監査を残す', async () => {
    setup({ updateResult: { data: null, error: { message: 'rls denied' } } });

    const res = await PUT(makeRequest(), ctx('7'));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to update news article' });
    const rows = auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'admin.news.update.failed',
      actor_id: 'admin-1',
      resource: 'news_article',
      resource_id: '7',
      outcome: 'failure',
      detail: 'News article update failed',
      user_agent: 'jest-agent',
      metadata: { articleId: '7', status: 'published', category: 'EVENT' },
    });
  });

  test('API-NEWS-005 変えた行が0件なら 404 と update.not_found の失敗の監査を残し、成功の監査は残さない（SEC-NEWS-016）', async () => {
    setup({ updateResult: { data: [], error: null } });

    const res = await PUT(makeRequest(), ctx('7'));

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Article not found' });
    const rows = auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'admin.news.update.not_found',
      actor_id: 'admin-1',
      resource: 'news_article',
      resource_id: '7',
      outcome: 'failure',
      detail: 'News article not found',
      metadata: { articleId: '7' },
    });
  });

  test.each(['0', '007', '1'.repeat(19)])('API-NEWS-005 id が %p なら表も置き場も触らず 404 にする（SEC-NEWS-012）', async (badId) => {
    setup();

    const res = await PUT(makeRequest({ fields: { ...validFields, image: makeImage('a.png', 'image/png') } }), ctx(badId));

    expect(res.status).toBe(404);
    expect(newsOps()).toHaveLength(0);
    expect(serviceClient.uploads).toHaveLength(0);
  });

  test('API-NEWS-005 id が数字でなければ表も置き場も触らず 404 にする（22P02 を 500 にしない）', async () => {
    setup();

    const res = await PUT(makeRequest({ fields: { ...validFields, image: makeImage('a.png', 'image/png') } }), ctx('abc'));

    expect(res.status).toBe(404);
    expect(newsOps()).toHaveLength(0);
    expect(serviceClient.uploads).toHaveLength(0);
    expect(auditRows()[0]).toMatchObject({ action: 'admin.news.update.not_found', outcome: 'failure', resource_id: null });
  });

  test('API-NEWS-005 監査の書き込みが失敗しても更新の成功は 200 のまま返す', async () => {
    setup();
    serviceClient = createFakeClient({
      user_roles: { data: aclRows(['admin.news.manage']), error: null },
      audit_logs: { data: null, error: { message: 'audit down' } },
    });
    createServiceRoleClient.mockResolvedValue(serviceClient);

    const res = await PUT(makeRequest(), ctx('7'));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(auditRows()).toHaveLength(1);
  });

  test('API-NEWS-005 本文の解析の例外は 500 Internal server error を返す', async () => {
    setup();

    const res = await PUT(makeRequest({ formDataError: new Error('bad multipart') }), ctx());

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
    expect(createClient).not.toHaveBeenCalled();
    expect(auditRows()).toHaveLength(0);
  });
});
