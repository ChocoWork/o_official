import { minimalGif, minimalJpeg, minimalPng, minimalWebp, textAsImage } from '../../../../fixtures/images';

jest.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));

jest.mock('@/lib/supabase/server', () => ({
  createClient: jest.fn(),
  createServiceRoleClient: jest.fn(),
}));

jest.mock('@/lib/auth/admin-rbac', () => ({
  authorizeAdminPermission: jest.fn(),
}));

jest.mock('@/lib/audit', () => ({
  logAudit: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/lib/storage/news-images', () => ({
  ...jest.requireActual('@/lib/storage/news-images'),
  signNewsImageFields: jest.fn(),
}));

const { createClient: mockCreateClient, createServiceRoleClient: mockCreateServiceRoleClient } =
  require('@/lib/supabase/server');
const { authorizeAdminPermission: mockAuthorize } = require('@/lib/auth/admin-rbac');
const { logAudit: mockLogAudit } = require('@/lib/audit');
const { signNewsImageFields: mockSign } = require('@/lib/storage/news-images');

const { GET, PUT, PATCH, DELETE } = require('@/app/api/admin/news/[id]/route');

const FIVE_MB = 5 * 1024 * 1024;

const validFields: Record<string, string> = {
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

function makeRequest(options: {
  fields?: Record<string, unknown>;
  body?: unknown;
  jsonError?: Error;
  formDataError?: Error;
  userAgent?: string | null;
} = {}) {
  const fields = options.fields ?? { ...validFields };
  const form = { get: (key: string) => (key in fields ? fields[key] : null) };
  return {
    headers: {
      get: (name: string) => (name.toLowerCase() === 'user-agent' ? options.userAgent ?? null : null),
    },
    formData: jest.fn(async () => {
      if (options.formDataError) throw options.formDataError;
      return form;
    }),
    json: jest.fn(async () => {
      if (options.jsonError) throw options.jsonError;
      return options.body;
    }),
  } as unknown as Request;
}

function paramsFor(id: string) {
  return { params: Promise.resolve({ id }) };
}

const OLD_IMAGE = 'news/2026-01-01/old.png';

/**
 * 変更・削除は .eq().select(...) で変えた行を返す形（SEC-NEWS-016）。rows が空なら 0 行（無い、または RLS が隠した）。
 * 1件の読み（GET と、画像つき PUT が上げる前に古い image_url を読む所）は .eq().maybeSingle()。
 * data を渡さない時の読みは古い画像の行、null を渡すと「無い記事」、readError を渡すと読みの失敗。
 */
function setupDb(result: {
  data?: unknown;
  error: unknown;
  readError?: unknown;
  rows?: Array<{ id: string; image_url?: string | null }>;
}) {
  const rows = result.rows ?? [{ id: '7', image_url: OLD_IMAGE }];
  const rowsResult = { data: result.error ? null : rows, error: result.error };
  const readData = 'data' in result ? result.data : { image_url: OLD_IMAGE };
  const maybeSingle = jest.fn().mockResolvedValue({ data: result.readError ? null : readData, error: result.readError ?? null });
  const selectEq = jest.fn().mockReturnValue({ maybeSingle });
  const select = jest.fn().mockReturnValue({ eq: selectEq });
  const updateSelect = jest.fn().mockResolvedValue(rowsResult);
  const updateEq = jest.fn().mockReturnValue({ select: updateSelect });
  const update = jest.fn().mockReturnValue({ eq: updateEq });
  const deleteSelect = jest.fn().mockResolvedValue(rowsResult);
  const deleteEq = jest.fn().mockReturnValue({ select: deleteSelect });
  const del = jest.fn().mockReturnValue({ eq: deleteEq });
  const from = jest.fn().mockReturnValue({ select, update, delete: del });
  mockCreateClient.mockResolvedValue({ from });
  return { from, select, selectEq, maybeSingle, update, updateEq, updateSelect, del, deleteEq, deleteSelect };
}

function setupStorage(uploadError: unknown = null, removeError: unknown = null) {
  const upload = jest.fn().mockResolvedValue({ error: uploadError });
  const remove = jest.fn().mockResolvedValue({ error: removeError });
  const storageFrom = jest.fn().mockReturnValue({ upload, remove });
  const service = { storage: { from: storageFrom } };
  mockCreateServiceRoleClient.mockResolvedValue(service);
  return { upload, remove, storageFrom, service };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAuthorize.mockResolvedValue({ ok: true, userId: 'admin-1' });
  mockLogAudit.mockResolvedValue(undefined);
  Object.defineProperty(globalThis.crypto, 'randomUUID', {
    configurable: true,
    value: jest.fn(() => 'uuid-1'),
  });
  jest.useFakeTimers({ now: new Date('2026-10-24T15:00:00.000Z'), doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('authorization', () => {
  it.each([
    ['GET', 'admin.news.read'],
    ['PUT', 'admin.news.manage'],
    ['PATCH', 'admin.news.manage'],
    ['DELETE', 'admin.news.manage'],
  ])('DD-NEWS-065 %s は認可が ok:false の時にその応答を返し、表を触らない（求める権限 %s）', async (method, permission) => {
    const handlers: Record<string, (req: Request, ctx: unknown) => Promise<unknown>> = { GET, PUT, PATCH, DELETE };
    const denied = { status: 403, json: async () => ({ error: 'Forbidden' }) };
    mockAuthorize.mockResolvedValue({ ok: false, response: denied });
    const request = makeRequest({ body: { status: 'private' } });

    const res = await handlers[method](request, paramsFor('7'));

    expect(res).toBe(denied);
    expect(mockAuthorize).toHaveBeenCalledWith(permission, request);
    expect(mockCreateClient).not.toHaveBeenCalled();
    expect(mockCreateServiceRoleClient).not.toHaveBeenCalled();
    expect(request.formData).not.toHaveBeenCalled();
    expect(request.json).not.toHaveBeenCalled();
  });
});

describe('GET /api/admin/news/:id', () => {
  it('DD-NEWS-065 GET で読み出しの error がある時は 500 Failed to fetch news article で、誤りの文を記録に出さない（SEC-NEWS-020）', async () => {
    setupDb({ data: null, error: null, readError: Object.assign(new Error('db down secret'), { code: 'XX000' }) });
    setupStorage();

    const res = await GET(makeRequest(), paramsFor('7'));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to fetch news article' });
    expect(mockSign).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith('Failed to fetch news article:', { name: 'Error', code: 'XX000' });
    expect(JSON.stringify((console.error as jest.Mock).mock.calls)).not.toContain('secret');
  });

  it.each(['abc', '..%2F..%2Fadmin', '0', '007', '1'.repeat(19), '-1', '1.5', '7;drop'])(
    'DD-NEWS-065 GET で id が %p の時は DB も service role の client も呼ばず 404 Article not found（SEC-NEWS-012）',
    async (badId) => {
      const db = setupDb({ error: null });
      setupStorage();

      const res = await GET(makeRequest(), paramsFor(badId));

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'Article not found' });
      expect(mockCreateClient).not.toHaveBeenCalled();
      expect(mockCreateServiceRoleClient).not.toHaveBeenCalled();
      expect(db.maybeSingle).not.toHaveBeenCalled();
    },
  );

  it('DD-NEWS-065 GET で error も行も無い時は 404 Article not found', async () => {
    setupDb({ data: null, error: null });
    setupStorage();

    const res = await GET(makeRequest(), paramsFor('7'));

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Article not found' });
  });

  it('DD-NEWS-065 GET の成功で eq(id, 道の id) で読み、signNewsImageFields の結果を 200 で返す', async () => {
    const row = { id: 7, image_url: 'news/a.jpg', status: 'private' };
    const db = setupDb({ data: row, error: null });
    const storage = setupStorage();
    mockSign.mockResolvedValue({ ...row, image_url: 'https://signed/a.jpg' });
    const request = makeRequest();

    const res = await GET(request, paramsFor('7'));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { id: 7, image_url: 'https://signed/a.jpg', status: 'private' } });
    expect(mockCreateClient).toHaveBeenCalledWith(request);
    expect(db.from).toHaveBeenCalledWith('news_articles');
    expect(db.select).toHaveBeenCalledWith('*');
    expect(db.selectEq).toHaveBeenCalledWith('id', '7');
    expect(mockSign).toHaveBeenCalledWith(storage.service, row);
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it('DD-NEWS-065 GET で params が例外を投げた時は 500 Internal server error', async () => {
    const res = await GET(makeRequest(), { params: Promise.reject(new Error('bad params')) });

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
    expect(mockAuthorize).not.toHaveBeenCalled();
  });
});

describe('PUT /api/admin/news/:id', () => {
  it.each([
    ['題が空白だけ', { title: '   ' }],
    ['分類が BLOG', { category: 'BLOG' }],
    ['日付が 2026/10/24', { date: '2026/10/24' }],
    ['状態が draft', { status: 'draft' }],
  ])('DD-NEWS-065 PUT で欄の形が合わない時（%s）は 400 Invalid request と details', async (_label, override) => {
    setupDb({ error: null });
    setupStorage();

    const res = await PUT(makeRequest({ fields: { ...validFields, ...override } }), paramsFor('7'));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Invalid request');
    expect(body.details).toEqual(expect.objectContaining({ fieldErrors: expect.any(Object) }));
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  it('DD-NEWS-065 PUT で image が無い時は置き場を呼ばず、更新に image_url を入れない', async () => {
    const db = setupDb({ error: null });
    const storage = setupStorage();

    const res = await PUT(makeRequest(), paramsFor('7'));

    expect(res.status).toBe(200);
    expect(storage.upload).not.toHaveBeenCalled();
    expect(db.update).toHaveBeenCalledWith({
      title: 'Autumn collection',
      category: 'EVENT',
      published_date: '2026-10-24',
      content: 'Short summary',
      detailed_content: 'Long body',
      status: 'published',
    });
    expect(db.update.mock.calls[0][0]).not.toHaveProperty('image_url');
    expect(db.updateEq).toHaveBeenCalledWith('id', '7');
    expect(db.updateSelect).toHaveBeenCalledWith('id');
  });

  it('DD-NEWS-065 PUT で HTML を image/png と申告した画像は 400 Unsupported image type で、古い値の読みも置き場も更新もしない（SEC-NEWS-017）', async () => {
    const db = setupDb({ error: null });
    const storage = setupStorage();

    const res = await PUT(
      makeRequest({
        fields: { ...validFields, image: makeImage('x.png', 'image/png', undefined, Buffer.from('<html><script>1</script></html>')) },
      }),
      paramsFor('7'),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Unsupported image type' });
    expect(db.maybeSingle).not.toHaveBeenCalled();
    expect(storage.upload).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

  it('DD-NEWS-065 PUT で種類が4つの外の画像は 400 Unsupported image type', async () => {
    const db = setupDb({ error: null });
    const storage = setupStorage();

    const res = await PUT(
      makeRequest({ fields: { ...validFields, image: makeImage('a.svg', 'image/svg+xml') } }),
      paramsFor('7'),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Unsupported image type' });
    expect(storage.upload).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

  it('DD-NEWS-065 PUT で 5MB を超える画像は 400 Image size must be 5MB or less', async () => {
    const db = setupDb({ error: null });
    const storage = setupStorage();

    const res = await PUT(
      makeRequest({ fields: { ...validFields, image: makeImage('a.png', 'image/png', FIVE_MB + 1) } }),
      paramsFor('7'),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Image size must be 5MB or less' });
    expect(storage.upload).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

  it.each([
    ['x.html', 'image/png', 'png'],
    ['photo.final.PNG', 'image/jpeg', 'jpg'],
    ['noextension', 'image/webp', 'webp'],
    ['a.exe', 'image/gif', 'gif'],
  ])('DD-NEWS-065 PUT で名前 %s の画像は送られた名前でなく種類 %s から決めた拡張子 %s の道で上げ、更新に image_url を入れる（SEC-NEWS-017）', async (name, type, ext) => {
    const db = setupDb({ error: null });
    const storage = setupStorage();

    const res = await PUT(makeRequest({ fields: { ...validFields, image: makeImage(name, type) } }), paramsFor('7'));

    const path = `news/2026-10-24/uuid-1.${ext}`;
    expect(res.status).toBe(200);
    expect(storage.storageFrom).toHaveBeenCalledWith('news-images');
    expect(storage.upload).toHaveBeenCalledWith(path, expect.any(Buffer), {
      contentType: type,
      cacheControl: '3600',
      upsert: false,
    });
    expect(db.update).toHaveBeenCalledWith(expect.objectContaining({ image_url: path }));
  });

  it('DD-NEWS-065 PUT で画像ありかつ記事が無い時（古い値の読みが null）は 404 で、何も上げず更新もしない（SEC-NEWS-018）', async () => {
    const db = setupDb({ data: null, error: null });
    const storage = setupStorage();

    const res = await PUT(
      makeRequest({ fields: { ...validFields, image: makeImage('a.png', 'image/png') } }),
      paramsFor('7'),
    );

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Article not found' });
    expect(db.select).toHaveBeenCalledWith('image_url');
    expect(db.selectEq).toHaveBeenCalledWith('id', '7');
    expect(storage.upload).not.toHaveBeenCalled();
    expect(storage.remove).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'admin.news.update.not_found', outcome: 'failure', resource_id: '7' }),
    );
  });

  it('DD-NEWS-065 PUT で古い値の読みが失敗した時は 500 Failed to update news article で、何も上げない', async () => {
    const db = setupDb({ error: null, readError: { code: 'XX000', message: 'secret' } });
    const storage = setupStorage();

    const res = await PUT(
      makeRequest({ fields: { ...validFields, image: makeImage('a.png', 'image/png') } }),
      paramsFor('7'),
    );

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to update news article' });
    expect(storage.upload).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
    expect(JSON.stringify((console.error as jest.Mock).mock.calls)).not.toContain('secret');
  });

  it('DD-NEWS-065 PUT の画像なしでは古い値を読まず、置き場も呼ばない', async () => {
    const db = setupDb({ error: null });
    const storage = setupStorage();

    await PUT(makeRequest(), paramsFor('7'));

    expect(db.maybeSingle).not.toHaveBeenCalled();
    expect(storage.upload).not.toHaveBeenCalled();
    expect(storage.remove).not.toHaveBeenCalled();
  });

  it('DD-NEWS-065 PUT で更新が成功したら、古い道筋を service role の client で 1 回 remove し、新しい道筋は消さない（SEC-NEWS-018）', async () => {
    setupDb({ error: null });
    const storage = setupStorage();

    const res = await PUT(
      makeRequest({ fields: { ...validFields, image: makeImage('a.png', 'image/png') } }),
      paramsFor('7'),
    );

    expect(res.status).toBe(200);
    expect(storage.remove).toHaveBeenCalledTimes(1);
    expect(storage.remove).toHaveBeenCalledWith([OLD_IMAGE]);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'admin.news.update',
        metadata: { articleId: '7', status: 'published', category: 'EVENT', imageCleanup: 'ok' },
      }),
    );
  });

  it('DD-NEWS-065 PUT で古い画像の remove が失敗しても 200 success のままで、監査に imageCleanup:failed を残す', async () => {
    setupDb({ error: null });
    setupStorage(null, { name: 'StorageApiError', code: '500', message: 'secret' });

    const res = await PUT(
      makeRequest({ fields: { ...validFields, image: makeImage('a.png', 'image/png') } }),
      paramsFor('7'),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'admin.news.update',
        outcome: 'success',
        metadata: expect.objectContaining({ imageCleanup: 'failed' }),
      }),
    );
    expect(JSON.stringify((console.error as jest.Mock).mock.calls)).not.toContain('secret');
  });

  it.each([
    ['null（まだ画像が無い記事）', null],
    ['外の URL', 'https://evil.example/news/a.png'],
    ['古い見本の道筋', 'e2e/news-1.png'],
  ])('DD-NEWS-065 PUT で古い image_url が %s の時は、置き場から何も消さない', async (_label, oldUrl) => {
    setupDb({ error: null, data: { image_url: oldUrl } });
    const storage = setupStorage();

    const res = await PUT(
      makeRequest({ fields: { ...validFields, image: makeImage('a.png', 'image/png') } }),
      paramsFor('7'),
    );

    expect(res.status).toBe(200);
    expect(storage.remove).not.toHaveBeenCalled();
  });

  it('DD-NEWS-065 PUT で更新が error の時は、その要求で上げた新しい道筋を remove し（古い画像は消さない）500 を返す', async () => {
    setupDb({ error: { message: 'rls' } });
    const storage = setupStorage();

    const res = await PUT(
      makeRequest({ fields: { ...validFields, image: makeImage('a.png', 'image/png') } }),
      paramsFor('7'),
    );

    expect(res.status).toBe(500);
    expect(storage.remove).toHaveBeenCalledTimes(1);
    expect(storage.remove).toHaveBeenCalledWith(['news/2026-10-24/uuid-1.png']);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'admin.news.update.failed',
        metadata: expect.objectContaining({ imageCleanup: 'ok' }),
      }),
    );
  });

  it('DD-NEWS-065 PUT で更新が 0 行の時は、新しい道筋を remove して 404 を返す', async () => {
    setupDb({ error: null, rows: [] });
    const storage = setupStorage();

    const res = await PUT(
      makeRequest({ fields: { ...validFields, image: makeImage('a.png', 'image/png') } }),
      paramsFor('7'),
    );

    expect(res.status).toBe(404);
    expect(storage.remove).toHaveBeenCalledTimes(1);
    expect(storage.remove).toHaveBeenCalledWith(['news/2026-10-24/uuid-1.png']);
  });

  it('DD-NEWS-065 PUT で更新が例外を投げた時も、上げた新しい道筋を remove して 500 Internal server error', async () => {
    const db = setupDb({ error: null });
    db.updateSelect.mockRejectedValue(new Error('boom'));
    const storage = setupStorage();

    const res = await PUT(
      makeRequest({ fields: { ...validFields, image: makeImage('a.png', 'image/png') } }),
      paramsFor('7'),
    );

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
    expect(storage.remove).toHaveBeenCalledWith(['news/2026-10-24/uuid-1.png']);
  });

  it('DD-NEWS-065 PUT で置き場の失敗の時に監査 admin.news.update.upload_failed（resource_id が id）と 500', async () => {
    const db = setupDb({ error: null });
    const storage = setupStorage({ message: 'storage down' });

    const res = await PUT(
      makeRequest({ fields: { ...validFields, image: makeImage('a.gif', 'image/gif') }, userAgent: 'UA/1' }),
      paramsFor('7'),
    );

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to upload image' });
    expect(db.update).not.toHaveBeenCalled();
    expect(mockLogAudit).toHaveBeenCalledWith({
      action: 'admin.news.update.upload_failed',
      actor_id: 'admin-1',
      resource: 'news_article',
      resource_id: '7',
      outcome: 'failure',
      detail: 'Image upload failed',
      user_agent: 'UA/1',
      metadata: { storagePath: 'news/2026-10-24/uuid-1.gif', articleId: '7', imageType: 'image/gif' },
    });
    expect(storage.remove).not.toHaveBeenCalled();
  });

  it('DD-NEWS-065 PUT で表の失敗の時に監査 admin.news.update.failed と 500', async () => {
    setupDb({ error: { message: 'rls' } });
    setupStorage();

    const res = await PUT(makeRequest(), paramsFor('7'));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to update news article' });
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'admin.news.update.failed',
        outcome: 'failure',
        resource_id: '7',
        detail: 'News article update failed',
        metadata: { articleId: '7', status: 'published', category: 'EVENT' },
      }),
    );
  });

  it('DD-NEWS-065 PUT の成功で監査 admin.news.update と 200 success', async () => {
    setupDb({ error: null });
    setupStorage();

    const res = await PUT(makeRequest(), paramsFor('7'));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'admin.news.update',
        outcome: 'success',
        resource_id: '7',
        detail: 'News article updated',
        metadata: { articleId: '7', status: 'published', category: 'EVENT' },
      }),
    );
  });

  it('DD-NEWS-065 PUT で request.formData() が例外を投げた時は 500 Internal server error', async () => {
    const res = await PUT(makeRequest({ formDataError: new Error('bad multipart') }), paramsFor('7'));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
    expect(mockLogAudit).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/admin/news/:id', () => {
  it('DD-NEWS-065 PATCH で本文が JSON でない時は 500 Internal server error', async () => {
    setupDb({ error: null });

    const res = await PATCH(makeRequest({ jsonError: new SyntaxError('Unexpected token') }), paramsFor('7'));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  it('DD-NEWS-065 PATCH で値が draft の時は 400 Invalid request と details', async () => {
    setupDb({ error: null });

    const res = await PATCH(makeRequest({ body: { status: 'draft' } }), paramsFor('7'));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Invalid request');
    expect(body.details).toEqual(expect.objectContaining({ fieldErrors: expect.any(Object) }));
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  it('DD-NEWS-065 PATCH で表の失敗の時に監査 admin.news.status_update.failed と 500', async () => {
    setupDb({ error: { message: 'rls' } });

    const res = await PATCH(makeRequest({ body: { status: 'private' } }), paramsFor('7'));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to update status' });
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'admin.news.status_update.failed',
        outcome: 'failure',
        resource_id: '7',
        detail: 'News article status update failed',
        metadata: { articleId: '7', status: 'private' },
      }),
    );
  });

  it('DD-NEWS-065 PATCH の成功で status だけを書き、監査 admin.news.status_update と 200', async () => {
    const db = setupDb({ error: null });

    const res = await PATCH(makeRequest({ body: { status: 'published', title: 'ignored' } }), paramsFor('7'));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(db.update).toHaveBeenCalledWith({ status: 'published' });
    expect(db.updateEq).toHaveBeenCalledWith('id', '7');
    expect(db.updateSelect).toHaveBeenCalledWith('id');
    expect(db.select).not.toHaveBeenCalled();
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'admin.news.status_update',
        outcome: 'success',
        resource_id: '7',
        detail: 'News article status updated',
        metadata: { articleId: '7', status: 'published' },
      }),
    );
  });
});

describe('DELETE /api/admin/news/:id', () => {
  it('DD-NEWS-065 DELETE で表の失敗の時に監査 admin.news.delete.failed と 500 を返し、置き場は消さず service role の client も作らない', async () => {
    setupDb({ error: { message: 'rls' } });
    const storage = setupStorage();

    const res = await DELETE(makeRequest(), paramsFor('7'));

    expect(storage.remove).not.toHaveBeenCalled();
    expect(mockCreateServiceRoleClient).not.toHaveBeenCalled();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to delete article' });
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'admin.news.delete.failed',
        outcome: 'failure',
        resource_id: '7',
        detail: 'News article delete failed',
        metadata: { articleId: '7' },
      }),
    );
  });

  it('DD-NEWS-065 DELETE の成功で delete().eq(id) を呼び、監査 admin.news.delete と 200', async () => {
    const db = setupDb({ error: null });
    setupStorage();

    const res = await DELETE(makeRequest(), paramsFor('7'));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(db.del).toHaveBeenCalled();
    expect(db.deleteEq).toHaveBeenCalledWith('id', '7');
    expect(db.deleteSelect).toHaveBeenCalledWith('id, image_url');
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'admin.news.delete',
        outcome: 'success',
        resource_id: '7',
        detail: 'News article deleted',
        metadata: { articleId: '7', imageCleanup: 'ok' },
      }),
    );
  });

  it('DD-NEWS-065 DELETE の成功で消した行の image_url を service role の client で remove する。利用者の session の client の storage は呼ばない（SEC-NEWS-018）', async () => {
    const sessionStorageFrom = jest.fn();
    const db = setupDb({ error: null });
    mockCreateClient.mockResolvedValue({ from: db.from, storage: { from: sessionStorageFrom } });
    const storage = setupStorage();

    const res = await DELETE(makeRequest(), paramsFor('7'));

    expect(res.status).toBe(200);
    expect(storage.storageFrom).toHaveBeenCalledWith('news-images');
    expect(storage.remove).toHaveBeenCalledTimes(1);
    expect(storage.remove).toHaveBeenCalledWith([OLD_IMAGE]);
    expect(sessionStorageFrom).not.toHaveBeenCalled();
  });

  it('DD-NEWS-065 DELETE で置き場の remove が失敗しても 200 success のままで、監査に imageCleanup:failed を残す', async () => {
    setupDb({ error: null });
    setupStorage(null, { name: 'StorageApiError', code: '500', message: 'secret' });

    const res = await DELETE(makeRequest(), paramsFor('7'));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'admin.news.delete',
        outcome: 'success',
        metadata: { articleId: '7', imageCleanup: 'failed' },
      }),
    );
    expect(JSON.stringify((console.error as jest.Mock).mock.calls)).not.toContain('secret');
  });

  it('DD-NEWS-065 DELETE で service role の client を作れなくても、行は消えているので 200 success で imageCleanup:failed を残す', async () => {
    setupDb({ error: null });
    mockCreateServiceRoleClient.mockRejectedValue(new Error('no key'));

    const res = await DELETE(makeRequest(), paramsFor('7'));

    expect(res.status).toBe(200);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'admin.news.delete',
        metadata: { articleId: '7', imageCleanup: 'failed' },
      }),
    );
  });

  it('DD-NEWS-065 DELETE で消した行の image_url が見本・外の URL・null なら、置き場から何も消さない', async () => {
    setupDb({ error: null, rows: [{ id: '7', image_url: 'e2e/news-1.png' }] });
    const storage = setupStorage();

    const res = await DELETE(makeRequest(), paramsFor('7'));

    expect(res.status).toBe(200);
    expect(storage.remove).not.toHaveBeenCalled();
  });

  it('DD-NEWS-065 DELETE で createClient が例外を投げた時は 500 Internal server error', async () => {
    mockCreateClient.mockRejectedValue(new Error('client boom'));

    const res = await DELETE(makeRequest(), paramsFor('7'));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
    expect(mockLogAudit).not.toHaveBeenCalled();
  });
});

describe('shared audit and zero-row behaviour', () => {
  it('DD-NEWS-065 監査の user_agent は見出しがある時はその値、無い時は null', async () => {
    setupDb({ error: null });
    setupStorage();
    await DELETE(makeRequest({ userAgent: 'Mozilla/5.0' }), paramsFor('7'));
    expect(mockLogAudit).toHaveBeenLastCalledWith(expect.objectContaining({ user_agent: 'Mozilla/5.0' }));

    setupDb({ error: null });
    setupStorage();
    await DELETE(makeRequest({ userAgent: null }), paramsFor('7'));
    expect(mockLogAudit).toHaveBeenLastCalledWith(expect.objectContaining({ user_agent: null }));
  });

  it.each([
    ['PUT', 'admin.news.update.not_found'],
    ['PATCH', 'admin.news.status_update.not_found'],
    ['DELETE', 'admin.news.delete.not_found'],
  ])('DD-NEWS-065 %s で変えた行が0件（無い、または RLS が隠した）なら 404 Article not found と失敗の監査 %s だけを残す（SEC-NEWS-016）', async (method, action) => {
    setupDb({ error: null, rows: [] });
    const storage = setupStorage();
    const handlers: Record<string, (req: Request, ctx: unknown) => Promise<{ status: number; json: () => Promise<unknown> }>> = {
      PUT,
      PATCH,
      DELETE,
    };
    const request =
      method === 'PATCH' ? makeRequest({ body: { status: 'private' } }) : makeRequest({ userAgent: 'UA/2' });

    const res = await handlers[method](request, paramsFor('7'));

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Article not found' });
    expect(mockLogAudit).toHaveBeenCalledTimes(1);
    expect(mockLogAudit).toHaveBeenCalledWith({
      action,
      actor_id: 'admin-1',
      resource: 'news_article',
      resource_id: '7',
      outcome: 'failure',
      detail: 'News article not found',
      user_agent: method === 'PATCH' ? null : 'UA/2',
      metadata: { articleId: '7' },
    });
    expect(
      mockLogAudit.mock.calls.some(([entry]: [{ outcome: string }]) => entry.outcome === 'success'),
    ).toBe(false);
    expect(storage.remove).not.toHaveBeenCalled();
  });

  it.each([
    ['PUT', 'admin.news.update.not_found'],
    ['PATCH', 'admin.news.status_update.not_found'],
    ['DELETE', 'admin.news.delete.not_found'],
  ])('DD-NEWS-065 %s で id が数字でない・19桁以上なら DB を呼ばず 404 にし、生の id を監査に残さない（SEC-NEWS-016）', async (method, action) => {
    const db = setupDb({ error: null });
    const storage = setupStorage();
    const handlers: Record<string, (req: Request, ctx: unknown) => Promise<{ status: number; json: () => Promise<unknown> }>> = {
      PUT,
      PATCH,
      DELETE,
    };

    for (const badId of ['abc', '7; drop table', '1'.repeat(19), '-1', '1.5', '', '0', '007']) {
      mockLogAudit.mockClear();
      const res = await handlers[method](makeRequest({ body: { status: 'private' } }), paramsFor(badId));

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'Article not found' });
      expect(mockLogAudit).toHaveBeenCalledTimes(1);
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          action,
          outcome: 'failure',
          resource_id: null,
          metadata: { articleIdLength: badId.length },
        }),
      );
    }

    expect(mockCreateClient).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
    expect(db.del).not.toHaveBeenCalled();
    expect(storage.upload).not.toHaveBeenCalled();
    expect(storage.remove).not.toHaveBeenCalled();
  });

  it('DD-NEWS-065 id が18桁ちょうどの数字なら DB に渡す', async () => {
    const id = '9'.repeat(18);
    const db = setupDb({ error: null, rows: [{ id }] });
    setupStorage();

    const res = await DELETE(makeRequest(), paramsFor(id));

    expect(res.status).toBe(200);
    expect(db.deleteEq).toHaveBeenCalledWith('id', id);
  });
});
