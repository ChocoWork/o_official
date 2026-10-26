export {};

// 窓口・認可（admin-rbac）・回数の制限（rateLimit）・監査（audit）・画像の署名は本物を通し、
// 外との境目（Supabase の client・token の検証・回数の数え場所・応答の型）だけを差し替える
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

jest.mock('@/features/auth/ratelimit', () => ({
  incrementCounter: jest.fn(),
  incrementCounterBy: jest.fn(),
}));

const { createServiceRoleClient } = require('@/lib/supabase/server');
const { verifyAccessToken, checkAuthSessionLiveness } = require('@/lib/auth/authenticate');
const { incrementCounter, incrementCounterBy } = require('@/features/auth/ratelimit');

type Result = { data: unknown; error: unknown };
type Outcome = Result | { throws: unknown };
type Op = 'select' | 'insert' | 'update' | 'delete';
type Call = [string, unknown[]];
type TableOp = { table: string; op: Op; calls: Call[] };
type Tables = Record<string, Partial<Record<Op, Outcome>>>;
type Upload = { bucket: string; path: string; body: unknown; options: Record<string, unknown> };
type Signed = { bucket: string; path: string; expiresIn: number };
type Removal = { bucket: string; paths: string[] };

// 表への呼び出しを、最初の操作（select・insert・update・delete）ごとに用意した結果で返す
function createFakeClient(
  tables: Tables,
  storage: {
    uploadResult?: Result;
    /** 何回目（0 始まり）の上げで uploadResult を返すか。既定は全部 */
    uploadResultAt?: number;
    sign?: (path: string) => Result;
    removeResult?: Outcome;
  } = {}
) {
  const removals: Removal[] = [];
  const ops: TableOp[] = [];
  const seq: string[] = [];
  const uploads: Upload[] = [];
  const signed: Signed[] = [];
  const client = {
    ops,
    seq,
    uploads,
    signed,
    removals,
    from: jest.fn((table: string) => {
      const op: TableOp = { table, op: 'select', calls: [] };
      ops.push(op);
      const builder: Record<string, unknown> = {};
      for (const m of ['select', 'insert', 'update', 'delete', 'eq', 'in', 'or', 'single', 'maybeSingle']) {
        builder[m] = (...args: unknown[]) => {
          if (op.calls.length === 0 && (m === 'select' || m === 'insert' || m === 'update' || m === 'delete')) {
            op.op = m;
            seq.push(`${table}.${m}`);
          }
          op.calls.push([m, args]);
          return builder;
        };
      }
      builder.then = (onF: (v: Result) => unknown, onR?: (e: unknown) => unknown) => {
        const outcome = tables[table]?.[op.op] ?? { data: null, error: null };
        if ('throws' in outcome) return Promise.reject(outcome.throws).then(onF, onR);
        return Promise.resolve(outcome).then(onF, onR);
      };
      return builder;
    }),
    storage: {
      from: jest.fn((bucket: string) => ({
        upload: jest.fn(async (path: string, body: unknown, options: Record<string, unknown>) => {
          uploads.push({ bucket, path, body, options });
          const failing = storage.uploadResultAt === undefined || storage.uploadResultAt === uploads.length - 1;
          return (failing ? storage.uploadResult : undefined) ?? { data: {}, error: null };
        }),
        remove: jest.fn(async (paths: string[]) => {
          removals.push({ bucket, paths });
          const outcome = storage.removeResult ?? { data: [], error: null };
          if ('throws' in outcome) throw outcome.throws;
          return outcome;
        }),
        createSignedUrl: jest.fn(async (path: string, expiresIn: number) => {
          signed.push({ bucket, path, expiresIn });
          return storage.sign ? storage.sign(path) : { data: { signedUrl: `https://signed.example/${path}` }, error: null };
        }),
      })),
    },
  };
  return client;
}

function aclRows(codes: string[]) {
  return [{ roles: { role_permissions: codes.map((code) => ({ permissions: { code } })) } }];
}

function ctx(id = '7') {
  return { params: Promise.resolve({ id }) };
}

let client: ReturnType<typeof createFakeClient>;

// 認可に使う user_roles と監査の audit_logs は既定で用意し、LOOK の表の結果だけを呼び側が渡す
function setup(
  options: {
    codes?: string[];
    aal?: string;
    tables?: Tables;
    storage?: Parameters<typeof createFakeClient>[1];
  } = {}
) {
  client = createFakeClient(
    {
      user_roles: { select: { data: aclRows(options.codes ?? ['admin.looks.read', 'admin.looks.manage']), error: null } },
      audit_logs: { insert: { data: null, error: null } },
      ...options.tables,
    },
    options.storage
  );
  createServiceRoleClient.mockResolvedValue(client);
  verifyAccessToken.mockResolvedValue({
    ok: true,
    claims: { sub: 'admin-1', session_id: 'sess-1', aal: options.aal ?? 'aal2', app_metadata: { role: 'admin' } },
  });
  checkAuthSessionLiveness.mockResolvedValue('active');
  incrementCounter.mockResolvedValue(1);
  incrementCounterBy.mockResolvedValue(1);
}

function auditRows() {
  return client.ops
    .filter((o) => o.table === 'audit_logs')
    .map((o) => (o.calls.find(([m]) => m === 'insert')?.[1][0] as Array<Record<string, unknown>>)[0]);
}

// 認可と監査の呼び出しを除いた、LOOK 関連の表への操作の順番
function dataSeq() {
  return client.seq.filter((s) => s !== 'user_roles.select' && s !== 'audit_logs.insert');
}

function tableCalls(table: string, op: Op) {
  return client.ops.filter((o) => o.table === table && o.op === op).map((o) => o.calls);
}

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

function baseHeaders(name: string, userAgent: string | null | undefined) {
  const lower = name.toLowerCase();
  if (lower === 'user-agent') return userAgent === undefined ? 'jest-agent' : userAgent;
  if (lower === 'x-forwarded-for') return '203.0.113.9, 10.0.0.1';
  return null;
}

const { PUT } = require('@/app/api/admin/looks/[id]/route');
const { fileOf, minimalGif, minimalJpeg, minimalPng, minimalWebp, textAsImage } = require('../../fixtures/images');

const MEBIBYTE = 1024 * 1024;
const FIVE_MB = 5 * MEBIBYTE;

const validFields: Record<string, unknown> = {
  seasonYear: '2026',
  seasonType: 'AW',
  theme: 'Dusk',
  themeDescription: 'Quiet evening',
  status: 'published',
  linkedItemIds: '[3,5]',
};

const existingImages = ['looks/2026-10-01/old-a.jpg', 'looks/2026-10-01/old-b.jpg'];

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
  images?: File[];
  userAgent?: string | null;
  formDataError?: Error;
} = {}) {
  const fields = options.fields ?? { ...validFields };
  const images = options.images ?? [];
  const form = {
    get: (key: string) => (key in fields ? fields[key] : null),
    getAll: (key: string) => (key === 'images' ? images : []),
  };
  return {
    headers: { get: (name: string) => baseHeaders(name, options.userAgent) },
    formData: jest.fn(async () => {
      if (options.formDataError) throw options.formDataError;
      return form;
    }),
  } as unknown as Request;
}

function formDataMock(request: Request) {
  return (request as unknown as { formData: jest.Mock }).formData;
}

type Overrides = {
  existing?: Outcome;
  items?: Outcome;
  lookUpdate?: Outcome;
  linksDelete?: Outcome;
  linksInsert?: Outcome;
};

function lookTables(overrides: Overrides = {}): Tables {
  return {
    looks: {
      select: overrides.existing ?? { data: { id: 7, status: 'private', image_urls: existingImages }, error: null },
      update: overrides.lookUpdate ?? { data: null, error: null },
    },
    items: { select: overrides.items ?? { data: [{ id: 3 }, { id: 5 }], error: null } },
    look_items: {
      delete: overrides.linksDelete ?? { data: null, error: null },
      insert: overrides.linksInsert ?? { data: null, error: null },
    },
  };
}

function updatePayload() {
  return tableCalls('looks', 'update')[0]?.find(([m]) => m === 'update')?.[1][0] as Record<string, unknown> | undefined;
}

const expectedPayload = {
  season_year: 2026,
  season_type: 'AW',
  theme: 'Dusk',
  theme_description: 'Quiet evening',
  image_urls: existingImages,
  status: 'published',
};

const realRandomUUID = globalThis.crypto.randomUUID;
const datePrefix = () => `looks/${new Date().toISOString().slice(0, 10)}/`;
const BUCKET_ISO = '2026-10-24T12:00:00.000Z';

describe('PUT /api/admin/looks/[id]（管理の LOOK の全体の更新）', () => {
  beforeEach(() => {
    freezeDateOnly();
    jest.clearAllMocks();
    delete process.env.ALERT_AUDIT_URL;
    let n = 0;
    Object.defineProperty(globalThis.crypto, 'randomUUID', {
      configurable: true,
      value: jest.fn(() => `uuid-${++n}`),
    });
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    Object.defineProperty(globalThis.crypto, 'randomUUID', { configurable: true, value: realRandomUUID });
    jest.useRealTimers();
  });

  test('API-LOOK-004 admin.looks.manage が無ければ 403 で断り、回数を数えず本文も読まない', async () => {
    setup({ codes: ['admin.looks.read'], tables: lookTables() });
    const request = makeRequest();

    const res = await PUT(request, ctx());

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'Forbidden', permission: 'admin.looks.manage' });
    expect(incrementCounter).not.toHaveBeenCalled();
    expect(formDataMock(request)).not.toHaveBeenCalled();
    expect(dataSeq()).toEqual([]);
    expect(auditRows()).toHaveLength(0);
  });

  test('API-LOOK-004 token が検証で断られたら 401 で断り、本文を読まない', async () => {
    setup({ tables: lookTables() });
    verifyAccessToken.mockResolvedValue({ ok: false, reason: 'expired' });
    const request = makeRequest();

    const res = await PUT(request, ctx());

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
    expect(formDataMock(request)).not.toHaveBeenCalled();
  });

  test('API-LOOK-004 aal2 でない session は 403 MFA required で断る', async () => {
    setup({ aal: 'aal1', tables: lookTables() });

    const res = await PUT(makeRequest(), ctx());

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ reason: 'MFA required', permission: 'admin.looks.manage' });
    expect(dataSeq()).toEqual([]);
  });

  test('API-LOOK-004 更新15回／10分を送り元と操作者の2段で数え、送り元の段の印は IP、操作者の段の印は操作者にする', async () => {
    setup({ tables: lookTables() });

    const res = await PUT(makeRequest(), ctx());

    expect(res.status).toBe(200);
    expect(incrementCounter).toHaveBeenCalledTimes(2);
    expect(incrementCounter).toHaveBeenNthCalledWith(1, {
      ip: '203.0.113.9',
      endpoint: 'admin:looks:update',
      bucket: BUCKET_ISO,
      subject: null,
    });
    expect(incrementCounter).toHaveBeenNthCalledWith(2, {
      ip: '203.0.113.9',
      endpoint: 'admin:looks:update',
      bucket: BUCKET_ISO,
      subject: 'admin-1',
    });
  });

  test('API-LOOK-004 送り元の段で16回目になると 429 Retry-After 600 で断り、操作者の段を数えず本文も読まない', async () => {
    setup({ tables: lookTables() });
    incrementCounter.mockResolvedValue(16);
    const request = makeRequest();

    const res = await PUT(request, ctx());

    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: 'Too many requests' });
    expect(res.headers.get('Retry-After')).toBe('600');
    expect(incrementCounter).toHaveBeenCalledTimes(1);
    expect(formDataMock(request)).not.toHaveBeenCalled();
    expect(dataSeq()).toEqual([]);
    expect(auditRows()).toHaveLength(0);
  });

  test('API-LOOK-004 両方の段が15回目までは通す', async () => {
    setup({ tables: lookTables() });
    incrementCounter.mockResolvedValue(15);

    const res = await PUT(makeRequest(), ctx());

    expect(res.status).toBe(200);
    expect(incrementCounter).toHaveBeenCalledTimes(2);
  });

  test('API-LOOK-004 送り元が空いていても操作者の段が16回目なら 429 で断る', async () => {
    setup({ tables: lookTables() });
    incrementCounter.mockResolvedValueOnce(1).mockResolvedValueOnce(16);
    const request = makeRequest();
    const res = await PUT(request, ctx());

    expect(res.status).toBe(429);
    expect(incrementCounter).toHaveBeenCalledTimes(2);
    expect(incrementCounter).toHaveBeenLastCalledWith(expect.objectContaining({ subject: 'admin-1' }));
    expect(formDataMock(request)).not.toHaveBeenCalled();
    expect(dataSeq()).toEqual([]);
  });

  test('API-LOOK-004 回数の数え場所が使えなければ 503 Retry-After 600 で断り、本文も読まない', async () => {
    setup({ tables: lookTables() });
    incrementCounter.mockRejectedValue(new Error('counter down'));
    const request = makeRequest();

    const res = await PUT(request, ctx());

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Rate limiter unavailable' });
    expect(res.headers.get('Retry-After')).toBe('600');
    expect(formDataMock(request)).not.toHaveBeenCalled();
  });

  test('API-LOOK-004 画像なしなら元の道筋のまま looks を更新し、関連を消して入れ直し、200 と成功の監査を残す', async () => {
    setup({ tables: lookTables() });

    const res = await PUT(makeRequest(), ctx('7'));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(client.uploads).toHaveLength(0);
    expect(incrementCounterBy).not.toHaveBeenCalled();
    expect(updatePayload()).toEqual(expectedPayload);
    expect(tableCalls('looks', 'select')).toEqual([[['select', ['id,status,image_urls']], ['eq', ['id', '7']], ['maybeSingle', []]]]);
    expect(tableCalls('items', 'select')).toEqual([[['select', ['id']], ['in', ['id', [3, 5]]]]]);
    expect(tableCalls('looks', 'update')[0].find(([m]) => m === 'eq')?.[1]).toEqual(['id', '7']);
    expect(tableCalls('look_items', 'delete')).toEqual([[['delete', []], ['eq', ['look_id', '7']]]]);
    expect(tableCalls('look_items', 'insert')).toEqual([
      [['insert', [[{ look_id: 7, item_id: 3 }, { look_id: 7, item_id: 5 }]]]],
    ]);
    const rows = auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'admin.look.update',
      actor_id: 'admin-1',
      resource: 'look',
      resource_id: '7',
      outcome: 'success',
      detail: 'Look updated',
      user_agent: 'jest-agent',
      metadata: {
        previous_status: 'private',
        next_status: 'published',
        linked_item_ids: [3, 5],
        image_count: 2,
        season_year: 2026,
        season_type: 'AW',
      },
    });
  });

  test('API-LOOK-004 有無の確認→商品の確認→looks の更新→関連の削除→関連の追加の順に進める', async () => {
    setup({ tables: lookTables() });

    await PUT(makeRequest(), ctx());

    expect(dataSeq()).toEqual([
      'looks.select',
      'items.select',
      'looks.update',
      'look_items.delete',
      'look_items.insert',
    ]);
  });

  test('API-LOOK-004 作成と同じ入力の決まりを当て、上限ちょうどの値と前後の空白は通して空白を除いて保存する', async () => {
    setup({ tables: lookTables() });

    const res = await PUT(
      makeRequest({
        fields: {
          ...validFields,
          seasonYear: '2100',
          theme: ` ${'t'.repeat(200)} `,
          themeDescription: 'd'.repeat(4000),
          status: 'private',
        },
      }),
      ctx()
    );

    expect(res.status).toBe(200);
    expect(updatePayload()).toEqual({
      ...expectedPayload,
      season_year: 2100,
      theme: 't'.repeat(200),
      theme_description: 'd'.repeat(4000),
      status: 'private',
    });

    setup({ tables: lookTables() });
    const lowest = await PUT(makeRequest({ fields: { ...validFields, seasonYear: '2000' } }), ctx());
    expect(lowest.status).toBe(200);
    expect(updatePayload()).toMatchObject({ season_year: 2000 });
  });

  test('API-LOOK-004 themeDescription が無ければ空の文字として保存する', async () => {
    setup({ tables: lookTables() });
    const { themeDescription: _omitted, ...fields } = validFields;

    const res = await PUT(makeRequest({ fields }), ctx());

    expect(res.status).toBe(200);
    expect(updatePayload()).toMatchObject({ theme_description: '' });
  });

  test.each([
    ['範囲より小さい年', { seasonYear: '1999' }, ['seasonYear']],
    ['範囲より大きい年', { seasonYear: '2101' }, ['seasonYear']],
    ['数でない年', { seasonYear: 'abc' }, ['seasonYear']],
    ['小数の年', { seasonYear: '2026.5' }, ['seasonYear']],
    ['決まりに無いシーズン', { seasonType: 'FW' }, ['seasonType']],
    ['空白だけのテーマ', { theme: '   ' }, ['theme']],
    ['201字のテーマ', { theme: 'a'.repeat(201) }, ['theme']],
    ['4001字の説明', { themeDescription: 'a'.repeat(4001) }, ['themeDescription']],
    ['決まりに無い状態', { status: 'draft' }, ['status']],
    ['空の商品の配列', { linkedItemIds: '[]' }, ['linkedItemIds']],
    ['0以下の商品 ID', { linkedItemIds: '[0]' }, ['linkedItemIds']],
  ])('API-LOOK-004 %s は 400 Invalid request と失敗の監査を残し、LOOK の表に触らない', async (_label, override, invalidFields) => {
    setup({ tables: lookTables() });

    const res = await PUT(makeRequest({ fields: { ...validFields, ...override } }), ctx('7'));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toBe('Invalid request');
    expect(json.details).toHaveProperty('fieldErrors');
    expect(dataSeq()).toEqual([]);
    const rows = auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'admin.look.update',
      outcome: 'failure',
      detail: 'Invalid update payload',
      resource: 'look',
      resource_id: '7',
      metadata: { invalid_fields: invalidFields },
    });
  });

  test.each([
    ['商品の配列の欄が無い', undefined],
    ['JSON でない商品の配列', '[3,'],
    ['数の配列でない商品の欄', '{"a":1}'],
  ])('API-LOOK-004 %s は例外の枝で 400 Invalid request を返し、LOOK を特定しない失敗の監査を残す', async (_label, linkedItemIds) => {
    setup({ tables: lookTables() });
    const fields: Record<string, unknown> = { ...validFields, linkedItemIds };
    if (linkedItemIds === undefined) delete fields.linkedItemIds;

    const res = await PUT(makeRequest({ fields }), ctx('7'));

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Invalid request');
    expect(dataSeq()).toEqual([]);
    const rows = auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'admin.look.update',
      outcome: 'failure',
      detail: 'Invalid update payload',
      resource_id: null,
      metadata: { invalid_fields: [] },
    });
  });

  test('API-LOOK-004 画像が7枚なら 400 で断り、枚数を監査に残して置き場にも表にも触らない', async () => {
    setup({ tables: lookTables() });
    const images = Array.from({ length: 7 }, (_, i) => makeImage(`a${i}.jpg`, 'image/jpeg'));

    const res = await PUT(makeRequest({ images }), ctx('7'));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'A maximum of 6 images is allowed per request' });
    expect(dataSeq()).toEqual([]);
    expect(client.uploads).toHaveLength(0);
    expect(auditRows()[0]).toMatchObject({
      action: 'admin.look.update',
      outcome: 'failure',
      detail: 'A maximum of 6 images is allowed per request',
      resource_id: '7',
      metadata: { image_count: 7 },
    });
  });

  test('API-LOOK-004 合計が20MBを超える画像は 400 で断り、20MBちょうどは通す', async () => {
    setup({ tables: lookTables() });
    const tooBig = [
      makeImage('a.jpg', 'image/jpeg', FIVE_MB),
      makeImage('b.jpg', 'image/jpeg', FIVE_MB),
      makeImage('c.jpg', 'image/jpeg', FIVE_MB),
      makeImage('d.jpg', 'image/jpeg', FIVE_MB),
      makeImage('e.jpg', 'image/jpeg', 1),
    ];
    const rejected = await PUT(makeRequest({ images: tooBig }), ctx());
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toEqual({ error: 'Total image payload must be 20MB or less per request' });
    expect(client.uploads).toHaveLength(0);
    expect(dataSeq()).toEqual([]);

    setup({ tables: lookTables() });
    const atLimit = await PUT(makeRequest({ images: tooBig.slice(0, 4) }), ctx());
    expect(atLimit.status).toBe(200);
    expect(client.uploads).toHaveLength(4);
  });

  test('API-LOOK-004 許さない種類の画像は 400 Unsupported image type で、種類を監査に残して上げも更新もしない', async () => {
    setup({ tables: lookTables() });
    const images = [makeImage('ok.jpg', 'image/jpeg'), makeImage('a.svg', 'image/svg+xml')];

    const res = await PUT(makeRequest({ images }), ctx('7'));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Unsupported image type' });
    expect(client.uploads).toHaveLength(0);
    expect(dataSeq()).toEqual([]);
    expect(auditRows()[0]).toMatchObject({
      detail: 'Unsupported image type',
      outcome: 'failure',
      metadata: { image_type: 'image/svg+xml' },
    });
  });

  test('API-LOOK-004 文字のファイルを image/png と申告したら 400 Unsupported image type で、上げず・量も数えず・表にも触れず、中身もファイル名も監査に残さない', async () => {
    setup({ tables: lookTables() });
    const images = [makeImage('secret-name.png', 'image/png', undefined, textAsImage())];

    const res = await PUT(makeRequest({ images }), ctx('7'));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Unsupported image type' });
    expect(client.uploads).toHaveLength(0);
    expect(client.removals).toHaveLength(0);
    expect(incrementCounterBy).not.toHaveBeenCalled();
    expect(dataSeq()).toEqual([]);
    expect(auditRows()[0]).toMatchObject({ outcome: 'failure', detail: 'Unsupported image type', resource_id: '7' });
    expect(JSON.stringify(auditRows())).not.toMatch(/secret-name|plain text/);
  });

  test('API-LOOK-004 PNG の中身を image/webp と申告したら 400 で、同じ要求の本物の画像も上げない', async () => {
    setup({ tables: lookTables() });
    const images = [makeImage('ok.png', 'image/png'), makeImage('x.webp', 'image/webp', undefined, minimalPng())];

    const res = await PUT(makeRequest({ images }), ctx('7'));

    expect(res.status).toBe(400);
    expect(client.uploads).toHaveLength(0);
    expect(incrementCounterBy).not.toHaveBeenCalled();
  });

  test('API-LOOK-004 5MB ちょうどの画像は通し、5MB を超える画像は 400 で断る', async () => {
    setup({ tables: lookTables() });
    const atLimit = await PUT(makeRequest({ images: [makeImage('a.gif', 'image/gif', FIVE_MB)] }), ctx());
    expect(atLimit.status).toBe(200);
    expect(client.uploads).toHaveLength(1);

    setup({ tables: lookTables() });
    const tooBig = await PUT(makeRequest({ images: [makeImage('a.gif', 'image/gif', FIVE_MB + 1)] }), ctx('7'));
    expect(tooBig.status).toBe(400);
    expect(await tooBig.json()).toEqual({ error: 'Image size must be 5MB or less' });
    expect(client.uploads).toHaveLength(0);
    expect(dataSeq()).toEqual([]);
    expect(auditRows()[0]).toMatchObject({
      detail: 'Image size limit exceeded',
      metadata: { image_size: FIVE_MB + 1, image_type: 'image/gif' },
    });
  });

  test('API-LOOK-004 jpeg・png・webp・gif の4種類を受け付ける', async () => {
    setup({ tables: lookTables() });
    const images = [
      makeImage('a.jpg', 'image/jpeg'),
      makeImage('b.png', 'image/png'),
      makeImage('c.webp', 'image/webp'),
      makeImage('d.gif', 'image/gif'),
    ];

    const res = await PUT(makeRequest({ images }), ctx());

    expect(res.status).toBe(200);
    expect(client.uploads.map((u) => u.options.contentType)).toEqual(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
  });

  test('API-LOOK-004 画像があれば置き場へ上げて、元の並びを捨てて上げた道筋の並びに全部差し替える', async () => {
    setup({ tables: lookTables() });
    const images = [makeImage('photo.final.PNG', 'image/png'), makeImage('plain', 'image/webp')];

    const res = await PUT(makeRequest({ images }), ctx('7'));

    expect(res.status).toBe(200);
    // 拡張子は送られた名前でなく、中身から検出した種類で決める
    const first = `${datePrefix()}uuid-1.png`;
    const second = `${datePrefix()}uuid-2.webp`;
    expect(client.uploads).toHaveLength(2);
    expect(client.uploads[0]).toMatchObject({
      bucket: 'look-images',
      path: first,
      options: { contentType: 'image/png', cacheControl: '3600', upsert: false },
    });
    expect(Buffer.isBuffer(client.uploads[0].body)).toBe(true);
    expect(client.uploads[1].path).toBe(second);
    expect(updatePayload()).toEqual({ ...expectedPayload, image_urls: [first, second] });
    expect(auditRows()[0].metadata).toMatchObject({ image_count: 2 });
  });

  test('API-LOOK-004 道筋には公開 URL でなく置き場の中の道筋だけを入れる', async () => {
    setup({ tables: lookTables() });

    await PUT(makeRequest({ images: [makeImage('a.jpg', 'image/jpeg')] }), ctx());

    const urls = (updatePayload() as { image_urls: string[] }).image_urls;
    expect(urls).toHaveLength(1);
    expect(urls[0]).toMatch(/^looks\/\d{4}-\d{2}-\d{2}\/uuid-1\.jpg$/);
    expect(urls[0]).not.toMatch(/^https?:/);
  });

  test('API-LOOK-004 画像の量は操作者の1時間の更新用の数え場所に、合計の大きさで足し込む', async () => {
    setup({ tables: lookTables() });
    const images = [makeImage('a.jpg', 'image/jpeg', 2 * MEBIBYTE), makeImage('b.jpg', 'image/jpeg', 3 * MEBIBYTE)];

    const res = await PUT(makeRequest({ images }), ctx());

    expect(res.status).toBe(200);
    expect(incrementCounterBy).toHaveBeenCalledTimes(1);
    expect(incrementCounterBy).toHaveBeenCalledWith({
      endpoint: 'admin:looks:update:upload-bytes',
      bucket: BUCKET_ISO,
      increment: 5 * MEBIBYTE,
      subject: 'admin-1',
    });
  });

  test('API-LOOK-004 1時間の量が60MBちょうどは通し、超えたら 429 Upload quota exceeded で上げも更新もしない', async () => {
    setup({ tables: lookTables() });
    incrementCounterBy.mockResolvedValue(60 * MEBIBYTE);
    const atLimit = await PUT(makeRequest({ images: [makeImage('a.jpg', 'image/jpeg')] }), ctx());
    expect(atLimit.status).toBe(200);

    setup({ tables: lookTables() });
    incrementCounterBy.mockResolvedValue(60 * MEBIBYTE + 1);
    const res = await PUT(makeRequest({ images: [makeImage('a.jpg', 'image/jpeg')] }), ctx());

    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: 'Upload quota exceeded' });
    expect(res.headers.get('Retry-After')).toBe('3600');
    expect(client.uploads).toHaveLength(0);
    expect(dataSeq()).toEqual(['looks.select', 'items.select']);
  });

  test('API-LOOK-004 量の数え場所が使えなければ 503 で断り、素通りさせない', async () => {
    setup({ tables: lookTables() });
    incrementCounterBy.mockRejectedValue(new Error('counter down'));

    const res = await PUT(makeRequest({ images: [makeImage('a.jpg', 'image/jpeg')] }), ctx());

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Rate limiter unavailable' });
    expect(client.uploads).toHaveLength(0);
    expect(dataSeq()).toEqual(['looks.select', 'items.select']);
  });

  test('API-LOOK-004 今の LOOK が無ければ 404 Look not found と失敗の監査を残し、商品も確かめない', async () => {
    setup({ tables: lookTables({ existing: { data: null, error: null } }) });

    const res = await PUT(makeRequest(), ctx('999'));

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Look not found' });
    expect(dataSeq()).toEqual(['looks.select']);
    expect(auditRows()[0]).toMatchObject({
      action: 'admin.look.update',
      outcome: 'failure',
      detail: 'Look not found',
      resource_id: '999',
    });
  });

  test('API-LOOK-004 今の LOOK の取り出しが DB の失敗なら「無い」と分けて 500 Failed to fetch look にし、何も上げない', async () => {
    setup({ tables: lookTables({ existing: { data: null, error: { code: '08006', message: 'connection reset SECRET' } } }) });

    const res = await PUT(makeRequest({ images: [makeImage('a.png', 'image/png')] }), ctx());

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to fetch look' });
    expect(client.uploads).toHaveLength(0);
    expect(dataSeq()).toEqual(['looks.select']);
    expect(auditRows()[0]).toMatchObject({ outcome: 'failure', detail: 'Failed to fetch look', resource_id: '7' });
    expect(JSON.stringify((console.error as jest.Mock).mock.calls)).not.toContain('SECRET');
  });

  test('API-LOOK-004 今の LOOK が無い id に画像つきで PUT しても、何も置き場に上げない', async () => {
    setup({ tables: lookTables({ existing: { data: null, error: null } }) });

    const res = await PUT(makeRequest({ images: [makeImage('a.png', 'image/png')] }), ctx('999'));

    expect(res.status).toBe(404);
    expect(client.uploads).toHaveLength(0);
    expect(client.removals).toHaveLength(0);
  });

  test.each(['abc', '1e3', '0', '-1', '1.5'])(
    'API-LOOK-004 id が %s の時は認可と回数の後で 400 Invalid look id と監査（id の生の値は残さず長さだけ）を返し、本文も読まず LOOK の表も引かない',
    async (badId) => {
      setup({ tables: lookTables() });
      const request = makeRequest();

      const res = await PUT(request, ctx(badId));

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'Invalid look id' });
      expect(formDataMock(request)).not.toHaveBeenCalled();
      expect(dataSeq()).toEqual([]);
      expect(auditRows()).toHaveLength(1);
      expect(auditRows()[0]).toMatchObject({
        action: 'admin.look.update',
        outcome: 'failure',
        detail: 'Invalid look id',
        resource_id: null,
        metadata: { id_length: badId.length },
      });
    },
  );

  test('API-LOOK-004 id が不正でも manage が無ければ今までの 403 を返す（id の検査より先）', async () => {
    setup({ codes: ['admin.looks.read'], tables: lookTables() });

    const res = await PUT(makeRequest(), ctx('abc'));

    expect(res.status).toBe(403);
    expect(auditRows()).toHaveLength(0);
  });

  test('API-LOOK-004 商品の確認に失敗したら 500 Failed to validate linked items と失敗の監査を残し、表を更新しない', async () => {
    setup({ tables: lookTables({ items: { data: null, error: { message: 'timeout' } } }) });

    const res = await PUT(makeRequest(), ctx('7'));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to validate linked items' });
    expect(dataSeq()).toEqual(['looks.select', 'items.select']);
    expect(auditRows()[0]).toMatchObject({
      detail: 'Failed to validate linked items',
      outcome: 'failure',
      metadata: { linked_item_ids: [3, 5], status: 'published' },
    });
  });

  test('API-LOOK-004 無い商品を含めば 400 Some linked items do not exist で、置き場にも表にも触らない', async () => {
    setup({ tables: lookTables({ items: { data: [{ id: 3 }], error: null } }) });

    const res = await PUT(makeRequest({ images: [makeImage('a.jpg', 'image/jpeg')] }), ctx('7'));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Some linked items do not exist' });
    expect(client.uploads).toHaveLength(0);
    expect(incrementCounterBy).not.toHaveBeenCalled();
    expect(dataSeq()).toEqual(['looks.select', 'items.select']);
    expect(auditRows()[0]).toMatchObject({
      detail: 'Some linked items do not exist',
      outcome: 'failure',
      metadata: { linked_item_ids: [3, 5], status: 'published' },
    });
  });

  test('API-LOOK-004 商品の確認の結果が null でも無い商品として 400 にする', async () => {
    setup({ tables: lookTables({ items: { data: null, error: null } }) });

    const res = await PUT(makeRequest(), ctx());

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Some linked items do not exist' });
  });

  test('API-LOOK-004 同じ商品 ID を2回送ると数が合わず 400 Some linked items do not exist になる', async () => {
    setup({ tables: lookTables({ items: { data: [{ id: 3 }], error: null } }) });

    const res = await PUT(makeRequest({ fields: { ...validFields, linkedItemIds: '[3,3]' } }), ctx());

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Some linked items do not exist' });
  });

  test('API-LOOK-004 image_urls が配列でなければ空の並びを元に更新する', async () => {
    setup({ tables: lookTables({ existing: { data: { id: 7, status: null, image_urls: null }, error: null } }) });

    const res = await PUT(makeRequest(), ctx());

    expect(res.status).toBe(200);
    expect(updatePayload()).toMatchObject({ image_urls: [] });
    expect(auditRows()[0].metadata).toMatchObject({ previous_status: null, image_count: 0 });
  });

  test('API-LOOK-004 置き場の失敗は 500 Failed to upload image ちょうどを返し、上げた先の道筋を監査に残して表を更新しない', async () => {
    setup({
      tables: lookTables(),
      storage: { uploadResult: { data: null, error: { message: 'bucket full SECRET' } } },
    });

    const res = await PUT(makeRequest({ images: [makeImage('a.png', 'image/png')] }), ctx('7'));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to upload image' });
    expect(JSON.stringify((console.error as jest.Mock).mock.calls)).not.toContain('SECRET');
    expect(dataSeq()).toEqual(['looks.select', 'items.select']);
    expect(auditRows()[0]).toMatchObject({
      action: 'admin.look.update',
      outcome: 'failure',
      detail: 'Failed to upload look image',
      metadata: { image_type: 'image/png' },
    });
  });

  test('API-LOOK-004 looks の更新の失敗は 500 Failed to update look と失敗の監査を残し、関連に触らない', async () => {
    setup({ tables: lookTables({ lookUpdate: { data: null, error: { message: 'rls denied' } } }) });

    const res = await PUT(makeRequest(), ctx('7'));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to update look' });
    expect(dataSeq()).toEqual(['looks.select', 'items.select', 'looks.update']);
    expect(auditRows()[0]).toMatchObject({
      detail: 'Failed to update look',
      outcome: 'failure',
      metadata: { status: 'published', linked_item_ids: [3, 5] },
    });
  });

  describe('画像の後始末', () => {
    const images = () => [makeImage('a.png', 'image/png'), makeImage('b.jpg', 'image/jpeg')];

    test('API-LOOK-004 画像なしの更新は置き場を呼ばない', async () => {
      setup({ tables: lookTables() });

      const res = await PUT(makeRequest(), ctx('7'));

      expect(res.status).toBe(200);
      expect(client.storage.from).not.toHaveBeenCalled();
    });

    test('API-LOOK-004 画像つきの更新の成功は、行を変えた後に古い道筋だけを一度に置き場から消す', async () => {
      setup({ tables: lookTables() });

      const res = await PUT(makeRequest({ images: images() }), ctx('7'));

      expect(res.status).toBe(200);
      expect(client.removals).toEqual([{ bucket: 'look-images', paths: existingImages }]);
      const newPaths = client.uploads.map((u) => u.path);
      expect(client.removals[0].paths.some((p) => newPaths.includes(p))).toBe(false);
      expect(auditRows()[0].metadata).not.toHaveProperty('image_cleanup');
    });

    test('API-LOOK-004 古い道筋のうち自分の接頭辞の外（古い見本・外の URL・..）は消さない', async () => {
      setup({
        tables: lookTables({
          existing: {
            data: {
              id: 7,
              status: 'private',
              image_urls: ['looks/2026-10-01/old-a.jpg', 'e2e/look-1-1.png', 'https://evil.example/looks/x.png', 'looks/../y.png'],
            },
            error: null,
          },
        }),
      });

      const res = await PUT(makeRequest({ images: images() }), ctx('7'));

      expect(res.status).toBe(200);
      expect(client.removals).toEqual([{ bucket: 'look-images', paths: ['looks/2026-10-01/old-a.jpg'] }]);
    });

    test('API-LOOK-004 looks の更新が失敗したら、この要求で上げた新しい画像だけを消し、古い画像は消さない', async () => {
      setup({ tables: lookTables({ lookUpdate: { data: null, error: { message: 'rls denied' } } }) });

      const res = await PUT(makeRequest({ images: images() }), ctx('7'));

      expect(res.status).toBe(500);
      expect(client.removals).toEqual([{ bucket: 'look-images', paths: client.uploads.map((u) => u.path) }]);
      expect(client.removals[0].paths.some((p) => existingImages.includes(p))).toBe(false);
    });

    test('API-LOOK-004 更新は成功し関連の保存が失敗したら、新しい画像は消さず古い画像を消して 500', async () => {
      setup({ tables: lookTables({ linksInsert: { data: null, error: { message: 'fk violation' } } }) });

      const res = await PUT(makeRequest({ images: images() }), ctx('7'));

      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'Failed to update linked items' });
      expect(client.removals).toEqual([{ bucket: 'look-images', paths: existingImages }]);
    });

    test('API-LOOK-004 2枚目の上げが失敗したら 1枚目だけを置き場から消し、行も古い画像も触れない', async () => {
      setup({
        tables: lookTables(),
        storage: { uploadResult: { data: null, error: { message: 'bucket full SECRET' } }, uploadResultAt: 1 },
      });

      const res = await PUT(makeRequest({ images: images() }), ctx('7'));

      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'Failed to upload image' });
      expect(client.removals).toEqual([{ bucket: 'look-images', paths: [client.uploads[0].path] }]);
      expect(dataSeq()).toEqual(['looks.select', 'items.select']);
    });

    test('API-LOOK-004 置き場の削除が失敗しても 200 のままで、監査 success の metadata に image_cleanup と件数を残し、置き場の文を記録しない', async () => {
      setup({
        tables: lookTables(),
        storage: { removeResult: { data: null, error: { message: 'storage SECRET' } } },
      });

      const res = await PUT(makeRequest({ images: images() }), ctx('7'));

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ success: true });
      expect(auditRows()[0]).toMatchObject({
        outcome: 'success',
        metadata: expect.objectContaining({ image_cleanup: 'failed', orphaned_count: 2 }),
      });
      expect(JSON.stringify((console.error as jest.Mock).mock.calls)).not.toContain('SECRET');
    });

    test('API-LOOK-004 置き場の削除が例外を投げても 200 のまま返す', async () => {
      setup({ tables: lookTables(), storage: { removeResult: { throws: new Error('storage down') } } });

      const res = await PUT(makeRequest({ images: images() }), ctx('7'));

      expect(res.status).toBe(200);
      expect(auditRows()[0]).toMatchObject({ outcome: 'success' });
    });
  });

  test('API-LOOK-004 関連の削除の失敗は 500 Failed to update linked items と失敗の監査を残し、入れ直さない', async () => {
    setup({ tables: lookTables({ linksDelete: { data: null, error: { message: 'locked' } } }) });

    const res = await PUT(makeRequest(), ctx('7'));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to update linked items' });
    expect(dataSeq()).toEqual(['looks.select', 'items.select', 'looks.update', 'look_items.delete']);
    expect(auditRows()[0]).toMatchObject({
      detail: 'Failed to replace look-item links',
      outcome: 'failure',
      metadata: { linked_item_ids: [3, 5] },
    });
  });

  test('API-LOOK-004 関連の追加の失敗は 500 を返すが、先に行った looks の更新と関連の削除は戻さない', async () => {
    setup({ tables: lookTables({ linksInsert: { data: null, error: { message: 'fk violation' } } }) });

    const res = await PUT(makeRequest(), ctx('7'));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to update linked items' });
    expect(dataSeq()).toEqual(['looks.select', 'items.select', 'looks.update', 'look_items.delete', 'look_items.insert']);
    expect(dataSeq().filter((s) => s.endsWith('.delete') || s.endsWith('.update'))).toEqual(['looks.update', 'look_items.delete']);
    expect(auditRows()).toHaveLength(1);
    expect(auditRows()[0]).toMatchObject({
      detail: 'Failed to update look-item links',
      outcome: 'failure',
      metadata: { linked_item_ids: [3, 5] },
    });
  });

  test('API-LOOK-004 監査の書き込みが失敗しても更新の成功は 200 のまま返す', async () => {
    setup({
      tables: { ...lookTables(), audit_logs: { insert: { data: null, error: { message: 'audit down' } } } },
    });

    const res = await PUT(makeRequest(), ctx());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(auditRows()).toHaveLength(1);
  });

  test('API-LOOK-004 認可の後の予期しない例外は 500 Internal server error を返し、Unexpected update error を監査に残す', async () => {
    setup({ tables: lookTables({ lookUpdate: { throws: new Error('boom') } }) });

    const res = await PUT(makeRequest(), ctx('7'));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
    const rows = auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'admin.look.update',
      actor_id: 'admin-1',
      outcome: 'failure',
      detail: 'Unexpected update error',
      resource_id: null,
      metadata: null,
    });
  });

  test('API-LOOK-004 本文の解析の例外も 500 Internal server error で、multipart でない要求を 400 にしない', async () => {
    setup({ tables: lookTables() });

    const res = await PUT(makeRequest({ formDataError: new Error('bad multipart') }), ctx());

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
    expect(dataSeq()).toEqual([]);
    expect(auditRows()[0]).toMatchObject({ detail: 'Unexpected update error', outcome: 'failure' });
  });

  test('API-LOOK-004 認可の前に道の params を解けなければ 500 Internal server error で、監査を残さない', async () => {
    setup({ tables: lookTables() });
    const params = Promise.reject(new Error('bad params'));
    params.catch(() => undefined);

    const res = await PUT(makeRequest(), { params });

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
    expect(auditRows()).toHaveLength(0);
    expect(incrementCounter).not.toHaveBeenCalled();
  });
});
