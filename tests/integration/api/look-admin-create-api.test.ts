export {};

// 窓口・認可（admin-rbac）・監査（audit）・変更の回数の制限（admin-rate-limit と ratelimit）は本物を通し、
// 外との境目（Supabase の client・token の検証・応答の型）だけを差し替える。
// 回数の数え場所は service role の client の rpc なので、rpc の返す数で上限の手前と超えた側を作る
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
const { POST } = require('@/app/api/admin/looks/route');
const { fileOf, minimalGif, minimalJpeg, minimalPng, minimalWebp, textAsImage } = require('../../fixtures/images');

type Result = { data: unknown; error: unknown };
type Method = 'select' | 'insert' | 'update' | 'delete';
type TableSpec = Partial<Record<Method, Result>>;
type Call = [string, unknown[]];
type TableOp = { table: string; calls: Call[] };
type Upload = { bucket: string; path: string; body: unknown; options: Record<string, unknown> };
type Removal = { bucket: string; paths: string[] };
type RpcCall = { name: string; args: Record<string, unknown> };

const WRITE_METHODS = ['insert', 'update', 'delete'];
const MEBIBYTE = 1024 * 1024;
const NONE: Result = { data: null, error: null };

function createFakeClient(
  tables: Record<string, TableSpec>,
  options: {
    uploadImpl?: (path: string, index: number) => Result;
    removeImpl?: () => Result;
    rpcImpl?: (call: RpcCall) => Result;
  } = {},
) {
  const ops: TableOp[] = [];
  const uploads: Upload[] = [];
  const removals: Removal[] = [];
  const rpcCalls: RpcCall[] = [];
  const order: string[] = [];
  const client = {
    ops,
    uploads,
    removals,
    rpcCalls,
    order,
    rpc: jest.fn(async (name: string, args: Record<string, unknown>) => {
      const call = { name, args };
      rpcCalls.push(call);
      return options.rpcImpl ? options.rpcImpl(call) : { data: 1, error: null };
    }),
    from: jest.fn((table: string) => {
      const op: TableOp = { table, calls: [] };
      ops.push(op);
      const result = (): Result => {
        const written = op.calls.map(([m]) => m).find((m) => WRITE_METHODS.includes(m)) as Method | undefined;
        order.push(`${table}.${written ?? 'select'}`);
        return tables[table]?.[written ?? 'select'] ?? NONE;
      };
      const builder: Record<string, unknown> = {};
      for (const m of ['select', 'insert', 'update', 'delete', 'eq', 'in', 'or', 'order']) {
        builder[m] = (...args: unknown[]) => {
          op.calls.push([m, args]);
          return builder;
        };
      }
      builder.single = () => Promise.resolve(result());
      builder.then = (onF: (v: Result) => unknown, onR?: (e: unknown) => unknown) =>
        Promise.resolve(result()).then(onF, onR);
      return builder;
    }),
    storage: {
      from: jest.fn((bucket: string) => ({
        upload: jest.fn(async (path: string, body: unknown, uploadOptions: Record<string, unknown>) => {
          order.push('storage.upload');
          uploads.push({ bucket, path, body, options: uploadOptions });
          return options.uploadImpl ? options.uploadImpl(path, uploads.length - 1) : { data: {}, error: null };
        }),
        remove: jest.fn(async (paths: string[]) => {
          order.push('storage.remove');
          removals.push({ bucket, paths });
          return options.removeImpl ? options.removeImpl() : { data: [], error: null };
        }),
      })),
    },
  };
  return client;
}

function aclRows(codes: string[]) {
  return [{ roles: { role_permissions: codes.map((code) => ({ permissions: { code } })) } }];
}

const IMAGE_BYTES: Record<string, () => Buffer> = {
  'image/jpeg': minimalJpeg,
  'image/png': minimalPng,
  'image/webp': minimalWebp,
  'image/gif': minimalGif,
};

// 申告の種類に合う本物の先頭の印を持つ画像。bytes を渡すと中身をそれにする（申告とずらす試験用）。
function makeImage(name: string, type: string, size?: number, bytes?: Buffer): File {
  const content: Buffer = bytes ?? (IMAGE_BYTES[type]?.() ?? textAsImage());
  const file = fileOf(content, name, type);
  Object.defineProperty(file, 'arrayBuffer', { configurable: true, value: async () => new Uint8Array(content).buffer });
  if (size !== undefined) Object.defineProperty(file, 'size', { configurable: true, value: size });
  return file;
}

const validFields: Record<string, unknown> = {
  seasonYear: '2026',
  seasonType: 'AW',
  theme: 'Quiet morning',
  themeDescription: 'Soft light',
  status: 'private',
  linkedItemIds: JSON.stringify([3, 5]),
};

function makeRequest(
  fields: Record<string, unknown> = validFields,
  images: unknown[] = [makeImage('a.jpg', 'image/jpeg')],
  options: { formDataError?: Error } = {},
) {
  const formData = jest.fn(async () => {
    if (options.formDataError) throw options.formDataError;
    return {
      get: (key: string) => (key in fields ? fields[key] : null),
      getAll: (key: string) => (key === 'images' ? images : []),
    };
  });
  return {
    headers: {
      get: (name: string) => {
        const key = name.toLowerCase();
        if (key === 'user-agent') return 'jest-agent';
        if (key === 'x-forwarded-for') return '203.0.113.9';
        return null;
      },
    },
    formData,
  } as unknown as Request & { formData: jest.Mock };
}

let serviceClient: ReturnType<typeof createFakeClient>;

function setup(
  options: {
    items?: Result;
    lookInsert?: Result;
    lookItemsInsert?: Result;
    auditResult?: Result;
    codes?: string[];
    aal?: string;
    verified?: unknown;
    liveness?: string;
    uploadImpl?: (path: string, index: number) => Result;
    removeImpl?: () => Result;
    rpcImpl?: (call: RpcCall) => Result;
  } = {},
) {
  serviceClient = createFakeClient(
    {
      user_roles: { select: { data: aclRows(options.codes ?? ['admin.looks.read', 'admin.looks.manage']), error: null } },
      audit_logs: { insert: options.auditResult ?? NONE },
      items: { select: options.items ?? { data: [{ id: 3 }, { id: 5 }], error: null } },
      looks: {
        insert: options.lookInsert ?? { data: { id: 11 }, error: null },
        delete: NONE,
      },
      look_items: { insert: options.lookItemsInsert ?? NONE },
    },
    { uploadImpl: options.uploadImpl, removeImpl: options.removeImpl, rpcImpl: options.rpcImpl },
  );
  createServiceRoleClient.mockResolvedValue(serviceClient);
  verifyAccessToken.mockResolvedValue(
    options.verified ?? {
      ok: true,
      claims: {
        sub: 'admin-1',
        email: 'admin@example.com',
        session_id: 'sess-1',
        aal: options.aal ?? 'aal2',
        app_metadata: { role: 'admin' },
      },
    },
  );
  checkAuthSessionLiveness.mockResolvedValue(options.liveness ?? 'active');
}

function opsOf(table: string) {
  return serviceClient.ops.filter((o) => o.table === table);
}

function argOf(table: string, method: string): unknown {
  return opsOf(table)
    .flatMap((o) => o.calls)
    .find(([m]) => m === method)?.[1][0];
}

function auditRows() {
  return opsOf('audit_logs').map((o) => (o.calls.find(([m]) => m === 'insert')?.[1][0] as Array<Record<string, unknown>>)[0]);
}

const PATH_PATTERN = /^looks\/\d{4}-\d{2}-\d{2}\/[0-9a-f-]{36}\.(jpg|png|webp|gif)$/;

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

describe('POST /api/admin/looks（LOOK の作成）', () => {
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

  describe('成功', () => {
    it('API-LOOK-002 正しい入力なら画像を上げて looks と look_items に入れ、201 で success と id を返す', async () => {
      setup();

      const res = await POST(makeRequest());

      expect(res.status).toBe(201);
      expect(await res.json()).toEqual({ success: true, id: 11 });
      expect(serviceClient.uploads).toHaveLength(1);
      const upload = serviceClient.uploads[0];
      expect(upload.bucket).toBe('look-images');
      expect(upload.path).toMatch(PATH_PATTERN);
      expect(upload.path.slice(6, 16)).toBe('2026-10-24');
      expect(upload.options).toEqual({ contentType: 'image/jpeg', cacheControl: '3600', upsert: false });
      expect(argOf('looks', 'insert')).toEqual([
        {
          season_year: 2026,
          season_type: 'AW',
          theme: 'Quiet morning',
          theme_description: 'Soft light',
          image_urls: [upload.path],
          status: 'private',
        },
      ]);
      expect(argOf('look_items', 'insert')).toEqual([
        { look_id: 11, item_id: 3 },
        { look_id: 11, item_id: 5 },
      ]);
    });

    it('API-LOOK-002 紐づけの確かめ → 画像の量 → 置き場 → looks → look_items の順に進める', async () => {
      setup();

      await POST(makeRequest());

      expect(serviceClient.order.filter((s) => !s.startsWith('user_roles') && !s.startsWith('audit_logs'))).toEqual([
        'items.select',
        'storage.upload',
        'looks.insert',
        'look_items.insert',
      ]);
      const quotaIndex = serviceClient.rpcCalls.findIndex((c) => String(c.args._endpoint).includes('upload-bytes'));
      expect(quotaIndex).toBeGreaterThan(-1);
    });

    it('API-LOOK-002 紐づける商品は items に全部あるかだけを id で見て、公開かどうかは見ない', async () => {
      setup();

      await POST(makeRequest());

      const calls = opsOf('items')[0].calls;
      expect(calls).toEqual([
        ['select', ['id']],
        ['in', ['id', [3, 5]]],
      ]);
    });

    it('API-LOOK-002 DB には署名前の置き場の道だけを入れ、公開 URL は入れない', async () => {
      setup();

      await POST(makeRequest());

      const [row] = argOf('looks', 'insert') as Array<{ image_urls: string[] }>;
      expect(row.image_urls.every((p) => !/^https?:/.test(p))).toBe(true);
      expect(row.image_urls).toEqual(serviceClient.uploads.map((u) => u.path));
    });

    it('API-LOOK-002 複数の画像は送られた順に上げ、道筋もその順に image_urls へ入れる（名前は別の uuid）', async () => {
      setup();
      const images = [makeImage('a.jpg', 'image/jpeg'), makeImage('b.png', 'image/png'), makeImage('c.webp', 'image/webp')];

      const res = await POST(makeRequest(validFields, images));

      expect(res.status).toBe(201);
      expect(serviceClient.uploads.map((u) => u.options.contentType)).toEqual(['image/jpeg', 'image/png', 'image/webp']);
      const paths = serviceClient.uploads.map((u) => u.path);
      expect(new Set(paths).size).toBe(3);
      expect(paths.map((p) => p.split('.').pop())).toEqual(['jpg', 'png', 'webp']);
      const [row] = argOf('looks', 'insert') as Array<{ image_urls: string[] }>;
      expect(row.image_urls).toEqual(paths);
    });

    it('API-LOOK-002 拡張子は送られた名前でなく中身から検出した種類で決める（名前が a/b.html でも png）', async () => {
      setup();

      const res = await POST(
        makeRequest(validFields, [makeImage('a/b.html', 'image/png'), makeImage('a.b.exe', 'image/gif'), makeImage('photo', 'image/jpeg')]),
      );

      expect(res.status).toBe(201);
      expect(serviceClient.uploads.map((u) => u.path)).toEqual([
        expect.stringMatching(PATH_PATTERN),
        expect.stringMatching(PATH_PATTERN),
        expect.stringMatching(PATH_PATTERN),
      ]);
      expect(serviceClient.uploads.map((u) => u.path.split('.').pop())).toEqual(['png', 'gif', 'jpg']);
      expect(serviceClient.uploads.every((u) => !u.path.includes('html') && !u.path.includes('exe'))).toBe(true);
      expect(serviceClient.removals).toHaveLength(0);
    });

    it('API-LOOK-002 成功を admin.look.create として監査に残し、LOOK の id・利用者・user agent を記録して IP は残さない', async () => {
      setup();

      await POST(makeRequest());

      const rows = auditRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        action: 'admin.look.create',
        actor_id: 'admin-1',
        actor_email: 'admin@example.com',
        resource: 'look',
        resource_id: '11',
        outcome: 'success',
        detail: 'Look created',
        user_agent: 'jest-agent',
        metadata: {
          status: 'private',
          linked_item_ids: [3, 5],
          image_count: 1,
          season_year: 2026,
          season_type: 'AW',
        },
      });
      expect(rows[0].ip).toBeUndefined();
      expect(JSON.stringify(rows[0])).not.toContain('203.0.113.9');
    });

    it('API-LOOK-002 監査の書き込みが失敗しても作成は止めず、警告だけ出す', async () => {
      setup({ auditResult: { data: null, error: { message: 'audit down' } } });

      const res = await POST(makeRequest());

      expect(res.status).toBe(201);
      expect(console.warn).toHaveBeenCalledWith('Failed to write audit log');
    });

    it('API-LOOK-002 上限ちょうどの入力（年 2000・題 200 字・説明 4000 字・画像 6 枚・1 枚 5MB・合計 20MB 未満）は受け付ける', async () => {
      setup();
      const images = [
        makeImage('a.png', 'image/png', 5 * MEBIBYTE),
        makeImage('b.png', 'image/png', 5 * MEBIBYTE),
        makeImage('c.png', 'image/png', 5 * MEBIBYTE),
        makeImage('d.png', 'image/png', 5 * MEBIBYTE - 3),
        makeImage('e.png', 'image/png', 1),
        makeImage('f.png', 'image/png', 1),
      ];

      const res = await POST(
        makeRequest(
          { ...validFields, seasonYear: '2000', theme: 't'.repeat(200), themeDescription: 'd'.repeat(4000), status: 'published' },
          images,
        ),
      );

      expect(res.status).toBe(201);
      expect(serviceClient.uploads).toHaveLength(6);
      expect((argOf('looks', 'insert') as Array<Record<string, unknown>>)[0]).toMatchObject({ season_year: 2000, status: 'published' });
    });

    it('API-LOOK-002 年 2100 と合計ちょうど 20MB も受け付ける', async () => {
      setup();
      const images = [1, 2, 3, 4].map((n) => makeImage(`${n}.jpg`, 'image/jpeg', 5 * MEBIBYTE));

      const res = await POST(makeRequest({ ...validFields, seasonYear: '2100', seasonType: 'SS' }, images));

      expect(res.status).toBe(201);
      expect((argOf('looks', 'insert') as Array<Record<string, unknown>>)[0]).toMatchObject({ season_year: 2100, season_type: 'SS' });
    });

    it('API-LOOK-002 題の前後の空白は落とし、説明が無ければ空の文字で入れる', async () => {
      setup();
      const fields: Record<string, unknown> = { ...validFields, theme: '  Spaced  ' };
      delete fields.themeDescription;

      const res = await POST(makeRequest(fields));

      expect(res.status).toBe(201);
      expect((argOf('looks', 'insert') as Array<Record<string, unknown>>)[0]).toMatchObject({
        theme: 'Spaced',
        theme_description: '',
      });
    });
  });

  describe('入力の誤り', () => {
    it.each([
      ['題が空白だけ', { theme: '   ' }],
      ['題が 201 字', { theme: 't'.repeat(201) }],
      ['題が無い', { theme: undefined }],
      ['年が 1999', { seasonYear: '1999' }],
      ['年が 2101', { seasonYear: '2101' }],
      ['年が整数でない', { seasonYear: '2026.5' }],
      ['年が数でない', { seasonYear: 'abc' }],
      ['季節が許可の外', { seasonType: 'FW' }],
      ['状態が許可の外', { status: 'draft' }],
      ['説明が 4001 字', { themeDescription: 'd'.repeat(4001) }],
      ['商品の id が空の配列', { linkedItemIds: '[]' }],
      ['商品の id が 0', { linkedItemIds: '[0]' }],
      ['商品の id が負', { linkedItemIds: '[-1]' }],
      ['商品の id が小数', { linkedItemIds: '[1.5]' }],
    ])('API-LOOK-002 %s の時は 400 Invalid request を返し、商品の確かめも上げも入れもしない', async (_label, override) => {
      setup();
      const fields: Record<string, unknown> = { ...validFields, ...override };
      for (const key of Object.keys(fields)) if (fields[key] === undefined) delete fields[key];

      const res = await POST(makeRequest(fields));
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.error).toBe('Invalid request');
      expect(body.details).toHaveProperty('fieldErrors');
      expect(opsOf('items')).toHaveLength(0);
      expect(serviceClient.uploads).toHaveLength(0);
      expect(opsOf('looks')).toHaveLength(0);
      const rows = auditRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        action: 'admin.look.create',
        outcome: 'failure',
        detail: 'Invalid create payload',
        actor_id: 'admin-1',
      });
    });

    it('API-LOOK-002 誤りのあった項目の名前を監査の invalid_fields に残す', async () => {
      setup();

      await POST(makeRequest({ ...validFields, seasonType: 'FW', status: 'draft' }));

      const metadata = auditRows()[0].metadata as { invalid_fields: string[] };
      expect([...metadata.invalid_fields].sort()).toEqual(['seasonType', 'status']);
    });

    it.each([
      ['JSON として読めない', '[3,'],
      ['配列でない', '{"a":1}'],
      ['数でない要素を含む', '["x"]'],
      ['文字の欄でない（無い）', undefined],
    ])('API-LOOK-002 linkedItemIds が%sなら 400 Invalid request を返し、失敗を監査に残す', async (_label, raw) => {
      setup();
      const fields: Record<string, unknown> = { ...validFields };
      if (raw === undefined) delete fields.linkedItemIds;
      else fields.linkedItemIds = raw;

      const res = await POST(makeRequest(fields));

      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe('Invalid request');
      expect(serviceClient.uploads).toHaveLength(0);
      expect(auditRows()[0]).toMatchObject({ action: 'admin.look.create', outcome: 'failure', detail: 'Invalid create payload' });
    });

    it.each([
      ['画像が無い', [] as unknown[]],
      ['画像が文字', ['not-a-file']],
    ])('API-LOOK-002 %sの時は 400 At least one image is required を返し、失敗を監査に残す', async (_label, images) => {
      setup();

      const res = await POST(makeRequest(validFields, images));

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'At least one image is required' });
      expect(serviceClient.uploads).toHaveLength(0);
      expect(opsOf('items')).toHaveLength(0);
      expect(auditRows()[0]).toMatchObject({
        action: 'admin.look.create',
        outcome: 'failure',
        detail: 'No image files provided',
        metadata: { linked_item_ids: [3, 5], status: 'private' },
      });
    });

    it('API-LOOK-002 画像が 7 枚なら 400 で枚数の上限を知らせ、上げない', async () => {
      setup();
      const images = Array.from({ length: 7 }, (_, i) => makeImage(`${i}.jpg`, 'image/jpeg'));

      const res = await POST(makeRequest(validFields, images));

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'A maximum of 6 images is allowed per request' });
      expect(serviceClient.uploads).toHaveLength(0);
      expect(auditRows()[0]).toMatchObject({
        outcome: 'failure',
        detail: 'A maximum of 6 images is allowed per request',
        metadata: { image_count: 7 },
      });
    });

    it('API-LOOK-002 合計が 20MB を超えたら 400 で合計の上限を知らせ、上げない', async () => {
      setup();
      const images = [
        makeImage('a.jpg', 'image/jpeg', 5 * MEBIBYTE),
        makeImage('b.jpg', 'image/jpeg', 5 * MEBIBYTE),
        makeImage('c.jpg', 'image/jpeg', 5 * MEBIBYTE),
        makeImage('d.jpg', 'image/jpeg', 5 * MEBIBYTE),
        makeImage('e.jpg', 'image/jpeg', 1),
      ];

      const res = await POST(makeRequest(validFields, images));

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'Total image payload must be 20MB or less per request' });
      expect(serviceClient.uploads).toHaveLength(0);
    });

    it('API-LOOK-002 許可の外の種類の画像は 400 Unsupported image type を返し、1枚でもあれば全部上げない', async () => {
      setup();

      const res = await POST(makeRequest(validFields, [makeImage('a.jpg', 'image/jpeg'), makeImage('a.svg', 'image/svg+xml')]));

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'Unsupported image type' });
      expect(serviceClient.uploads).toHaveLength(0);
      expect(auditRows()[0]).toMatchObject({
        outcome: 'failure',
        detail: 'Unsupported image type',
        metadata: { image_type: 'image/svg+xml', image_count: 2 },
      });
    });

    it('API-LOOK-002 文字のファイルを image/png と申告したら 400 Unsupported image type を返し、上げず・量も数えず・中身もファイル名も監査に残さない', async () => {
      setup();

      const res = await POST(
        makeRequest(validFields, [makeImage('secret-name.png', 'image/png', undefined, textAsImage())]),
      );

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'Unsupported image type' });
      expect(serviceClient.uploads).toHaveLength(0);
      expect(opsOf('items')).toHaveLength(0);
      expect(serviceClient.rpcCalls.some((c) => String(c.args._endpoint).includes('upload-bytes'))).toBe(false);
      expect(auditRows()[0]).toMatchObject({ outcome: 'failure', detail: 'Unsupported image type' });
      expect(JSON.stringify(auditRows())).not.toMatch(/secret-name|plain text/);
    });

    it('API-LOOK-002 PNG の中身を image/jpeg と申告したら 400 で、同じ要求の本物の画像も上げない', async () => {
      setup();

      const res = await POST(
        makeRequest(validFields, [makeImage('a.png', 'image/png'), makeImage('b.jpg', 'image/jpeg', undefined, minimalPng())]),
      );

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'Unsupported image type' });
      expect(serviceClient.uploads).toHaveLength(0);
    });

    it('API-LOOK-002 5MB を超える画像は 400 Image size must be 5MB or less を返し、上げない', async () => {
      setup();

      const res = await POST(makeRequest(validFields, [makeImage('a.jpg', 'image/jpeg', 5 * MEBIBYTE + 1)]));

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'Image size must be 5MB or less' });
      expect(serviceClient.uploads).toHaveLength(0);
      expect(auditRows()[0]).toMatchObject({
        outcome: 'failure',
        detail: 'Image size limit exceeded',
        metadata: { image_size: 5 * MEBIBYTE + 1, image_type: 'image/jpeg' },
      });
    });
  });

  describe('紐づける商品', () => {
    it('API-LOOK-002 商品の確かめが失敗したら 500 を返し、失敗を監査に残して上げない', async () => {
      setup({ items: { data: null, error: { message: 'db down' } } });

      const res = await POST(makeRequest());

      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'Failed to validate linked items' });
      expect(serviceClient.uploads).toHaveLength(0);
      expect(auditRows()[0]).toMatchObject({ outcome: 'failure', detail: 'Failed to validate linked items' });
    });

    it('API-LOOK-002 items に無い商品があれば 400 Some linked items do not exist を返し、上げない', async () => {
      setup({ items: { data: [{ id: 3 }], error: null } });

      const res = await POST(makeRequest());

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'Some linked items do not exist' });
      expect(serviceClient.uploads).toHaveLength(0);
      expect(opsOf('looks')).toHaveLength(0);
      expect(auditRows()[0]).toMatchObject({
        outcome: 'failure',
        detail: 'Some linked items do not exist',
        metadata: { linked_item_ids: [3, 5], status: 'private' },
      });
    });

    it('API-LOOK-002 items が null を返した時も 400 Some linked items do not exist を返す', async () => {
      setup({ items: { data: null, error: null } });

      const res = await POST(makeRequest());

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'Some linked items do not exist' });
    });
  });

  describe('操作者の1時間の画像の量', () => {
    it('API-LOOK-002 画像の合計の大きさを、操作者ごと・1時間の区切りで数える', async () => {
      setup();

      await POST(makeRequest(validFields, [makeImage('a.jpg', 'image/jpeg', 1000), makeImage('b.jpg', 'image/jpeg', 234)]));

      const quota = serviceClient.rpcCalls.find((c) => String(c.args._endpoint).includes('upload-bytes'));
      expect(quota?.name).toBe('increment_rate_limit_counter');
      expect(String(quota?.args._endpoint)).toMatch(/^admin:looks:create:upload-bytes\|acct:[0-9a-f]{128}$/);
      expect(quota?.args._endpoint).not.toContain('admin-1');
      expect(quota?.args._ip).toBeNull();
      expect(quota?.args._increment).toBe(1234);
      expect(quota?.args._bucket).toBe('2026-10-24T12:00:00.000Z');
    });

    it('API-LOOK-002 1時間の合計がちょうど 60MB までは通す', async () => {
      setup({
        rpcImpl: ({ args }) => ({ data: args._increment ? 60 * MEBIBYTE : 1, error: null }),
      });

      const res = await POST(makeRequest());

      expect(res.status).toBe(201);
    });

    it('API-LOOK-002 1時間の合計が 60MB を超えたら 429 Upload quota exceeded で断り、上げず監査にも残さない', async () => {
      setup({
        rpcImpl: ({ args }) => ({ data: args._increment ? 60 * MEBIBYTE + 1 : 1, error: null }),
      });

      const res = await POST(makeRequest());

      expect(res.status).toBe(429);
      expect(await res.json()).toEqual({ error: 'Upload quota exceeded' });
      expect(res.headers.get('Retry-After')).toBe('3600');
      expect(serviceClient.uploads).toHaveLength(0);
      expect(opsOf('looks')).toHaveLength(0);
      expect(auditRows()).toHaveLength(0);
    });

    it('API-LOOK-002 量の数え場所が使えない時は通さず 503 Rate limiter unavailable で断る', async () => {
      setup({
        rpcImpl: ({ args }) =>
          args._increment ? { data: null, error: { message: 'rpc down' } } : { data: 1, error: null },
      });

      const res = await POST(makeRequest());

      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'Rate limiter unavailable' });
      expect(res.headers.get('Retry-After')).toBe('3600');
      expect(serviceClient.uploads).toHaveLength(0);
      expect(auditRows()).toHaveLength(0);
    });
  });

  describe('送り元と操作者の回数', () => {
    it('API-LOOK-002 作成は送り元の段と操作者の段を 10 回／10 分で別々に数える', async () => {
      setup();

      await POST(makeRequest());

      const counters = serviceClient.rpcCalls.filter((c) => !String(c.args._endpoint).includes('upload-bytes'));
      expect(counters).toHaveLength(2);
      expect(counters[0].args).toMatchObject({ _ip: '203.0.113.9', _endpoint: 'admin:looks:create', _bucket: '2026-10-24T12:00:00.000Z' });
      expect(String(counters[1].args._endpoint)).toMatch(/^admin:looks:create\|acct:[0-9a-f]{128}$/);
      expect(counters[1].args._ip).toBeNull();
    });

    it('API-LOOK-002 送り元の段が 10 回ちょうどなら通し、11 回目は 429 で断る', async () => {
      setup({ rpcImpl: ({ args }) => ({ data: args._ip ? 10 : 1, error: null }) });
      expect((await POST(makeRequest())).status).toBe(201);

      setup({ rpcImpl: ({ args }) => ({ data: args._ip ? 11 : 1, error: null }) });
      const request = makeRequest();
      const res = await POST(request);

      expect(res.status).toBe(429);
      expect(await res.json()).toEqual({ error: 'Too many requests' });
      expect(res.headers.get('Retry-After')).toBe('600');
      expect(request.formData).not.toHaveBeenCalled();
      expect(serviceClient.uploads).toHaveLength(0);
      expect(auditRows()).toHaveLength(0);
    });

    it('API-LOOK-002 送り元の段で断った時は操作者の段を数えない', async () => {
      setup({ rpcImpl: ({ args }) => ({ data: args._ip ? 11 : 1, error: null }) });

      await POST(makeRequest());

      expect(serviceClient.rpcCalls).toHaveLength(1);
      expect(serviceClient.rpcCalls[0].args._endpoint).toBe('admin:looks:create');
    });

    it('API-LOOK-002 送り元を変えても操作者の段が 11 回目なら 429 で断る', async () => {
      setup({ rpcImpl: ({ args }) => ({ data: args._ip ? 1 : 11, error: null }) });
      const request = makeRequest();

      const res = await POST(request);

      expect(res.status).toBe(429);
      expect(request.formData).not.toHaveBeenCalled();
      expect(serviceClient.rpcCalls).toHaveLength(2);
    });

    it('API-LOOK-002 数え場所が使えない時は 503 Rate limiter unavailable で断り、本文を読まない', async () => {
      setup({ rpcImpl: () => ({ data: null, error: { message: 'rpc down' } }) });
      const request = makeRequest();

      const res = await POST(request);

      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'Rate limiter unavailable' });
      expect(request.formData).not.toHaveBeenCalled();
      expect(serviceClient.uploads).toHaveLength(0);
    });
  });

  describe('認可', () => {
    it('API-LOOK-002 admin.looks.manage の権限が無ければ 403 で断り、回数も数えず上げも監査もしない', async () => {
      setup({ codes: ['admin.looks.read'] });
      const request = makeRequest();

      const res = await POST(request);

      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: 'Forbidden', permission: 'admin.looks.manage' });
      expect(serviceClient.rpcCalls).toHaveLength(0);
      expect(request.formData).not.toHaveBeenCalled();
      expect(serviceClient.uploads).toHaveLength(0);
      expect(auditRows()).toHaveLength(0);
    });

    it('API-LOOK-002 aal2 でない session は 403 MFA required で断る', async () => {
      setup({ aal: 'aal1' });

      const res = await POST(makeRequest());

      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ reason: 'MFA required', permission: 'admin.looks.manage' });
      expect(serviceClient.rpcCalls).toHaveLength(0);
      expect(serviceClient.uploads).toHaveLength(0);
    });

    it('API-LOOK-002 token が無効なら 401 で断る', async () => {
      setup({ verified: { ok: false, reason: 'missing' } });

      const res = await POST(makeRequest());

      expect(res.status).toBe(401);
      expect(serviceClient.rpcCalls).toHaveLength(0);
      expect(auditRows()).toHaveLength(0);
    });

    it('API-LOOK-002 session が失効していれば 401、確認できなければ 503 で断る', async () => {
      setup({ liveness: 'revoked' });
      expect((await POST(makeRequest())).status).toBe(401);

      setup({ liveness: 'unavailable' });
      expect((await POST(makeRequest())).status).toBe(503);
      expect(serviceClient.uploads).toHaveLength(0);
    });

    it('API-LOOK-002 利用者の JWT の client は使わない', async () => {
      setup();

      await POST(makeRequest());

      expect(createClient).not.toHaveBeenCalled();
    });
  });

  describe('置き場と表の失敗', () => {
    it('API-LOOK-002 置き場への上げが失敗したら 500 Failed to upload image ちょうどを返し、置き場の文を出さず、失敗を監査に残して looks に入れない', async () => {
      setup({ uploadImpl: () => ({ data: null, error: { message: 'storage down SECRET' } }) });

      const res = await POST(makeRequest());

      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'Failed to upload image' });
      expect(JSON.stringify((console.error as jest.Mock).mock.calls)).not.toContain('SECRET');
      expect(opsOf('looks')).toHaveLength(0);
      expect(auditRows()[0]).toMatchObject({
        action: 'admin.look.create',
        outcome: 'failure',
        detail: 'Failed to upload look image',
        metadata: { image_type: 'image/jpeg', status: 'private', linked_item_ids: [3, 5] },
      });
    });

    it('API-LOOK-002 2枚目の上げが失敗したらそこで止め、3枚目は上げず looks に入れない', async () => {
      setup({ uploadImpl: (_path, index) => (index === 1 ? { data: null, error: { message: 'boom' } } : { data: {}, error: null }) });
      const images = [makeImage('a.jpg', 'image/jpeg'), makeImage('b.jpg', 'image/jpeg'), makeImage('c.jpg', 'image/jpeg')];

      const res = await POST(makeRequest(validFields, images));

      expect(res.status).toBe(500);
      expect(serviceClient.uploads).toHaveLength(2);
      expect(opsOf('looks')).toHaveLength(0);
      expect(serviceClient.removals).toEqual([{ bucket: 'look-images', paths: [serviceClient.uploads[0].path] }]);
    });

    it('API-LOOK-002 looks への挿入が失敗したら 500 Failed to save look を返し、link を作らず失敗を監査に残す', async () => {
      setup({ lookInsert: { data: null, error: { code: '23505', message: 'dup' } } });

      const res = await POST(makeRequest());

      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'Failed to save look' });
      expect(opsOf('look_items')).toHaveLength(0);
      expect(auditRows()[0]).toMatchObject({
        outcome: 'failure',
        detail: 'Failed to insert look',
        resource_id: null,
        metadata: { status: 'private', linked_item_ids: [3, 5], image_count: 1 },
      });
      expect(serviceClient.removals).toEqual([{ bucket: 'look-images', paths: serviceClient.uploads.map((u) => u.path) }]);
    });

    it('API-LOOK-002 置き場の削除が失敗しても応答は変えず、監査に orphaned_count を残す', async () => {
      setup({
        lookInsert: { data: null, error: { code: '23505', message: 'dup' } },
        removeImpl: () => ({ data: null, error: { message: 'storage SECRET' } }),
      });

      const res = await POST(makeRequest());

      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'Failed to save look' });
      expect(auditRows()[0]).toMatchObject({
        detail: 'Failed to insert look',
        metadata: { image_cleanup: 'failed', orphaned_count: 1 },
      });
      expect(JSON.stringify((console.error as jest.Mock).mock.calls)).not.toContain('SECRET');
    });

    it('API-LOOK-002 looks への挿入が id を返さない時も 500 Failed to save look を返す', async () => {
      setup({ lookInsert: { data: null, error: null } });

      const res = await POST(makeRequest());

      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'Failed to save look' });
      expect(opsOf('look_items')).toHaveLength(0);
    });

    it('API-LOOK-002 関連の保存に失敗したら作った LOOK の行を消して 500 を返し、失敗を監査に残す', async () => {
      setup({ lookItemsInsert: { data: null, error: { code: '23503', message: 'fk' } } });

      const res = await POST(makeRequest());

      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'Failed to save linked items' });
      const deleteOp = opsOf('looks').find((o) => o.calls.some(([m]) => m === 'delete'));
      expect(deleteOp?.calls).toEqual([
        ['delete', []],
        ['eq', ['id', 11]],
      ]);
      expect(serviceClient.removals).toEqual([{ bucket: 'look-images', paths: serviceClient.uploads.map((u) => u.path) }]);
      expect(serviceClient.order.indexOf('looks.delete')).toBeLessThan(serviceClient.order.indexOf('storage.remove'));
      expect(auditRows()).toHaveLength(1);
      expect(auditRows()[0]).toMatchObject({
        outcome: 'failure',
        detail: 'Failed to create look-item links',
        resource_id: '11',
        metadata: { status: 'private', linked_item_ids: [3, 5] },
      });
    });

    it('API-LOOK-002 multipart として読めない要求は 500 Internal server error を返し、失敗を監査に残す', async () => {
      setup();

      const res = await POST(makeRequest(validFields, [], { formDataError: new TypeError('Could not parse content as FormData.') }));

      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'Internal server error' });
      expect(serviceClient.uploads).toHaveLength(0);
      expect(auditRows()[0]).toMatchObject({
        action: 'admin.look.create',
        outcome: 'failure',
        detail: 'Unexpected create error',
        actor_id: 'admin-1',
      });
    });
  });
});
