/**
 * @jest-environment node
 */
export {};

// 窓口・id の確かめ・公開の取り出し・道筋の確かめ・画像の種類の検出を本物のまま通して確かめる。
// 差し替えるのは外との境目（Supabase の client）だけ
jest.mock('@/lib/supabase/server', () => ({
  createPublicClient: jest.fn(),
  createServiceRoleClient: jest.fn(),
}));

const { createPublicClient, createServiceRoleClient } = require('@/lib/supabase/server');
const { GET } = require('@/app/look/[id]/og/route');

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9]);

type Row = { image_urls: unknown } | null;

function fakeClients(row: Row, download: jest.Mock) {
  const calls: Array<[string, unknown[]]> = [];
  const builder: Record<string, jest.Mock> = {};
  for (const name of ['select', 'eq']) {
    builder[name] = jest.fn((...args: unknown[]) => {
      calls.push([name, args]);
      return builder;
    });
  }
  builder.maybeSingle = jest.fn(async () => ({ data: row, error: null }));
  createPublicClient.mockResolvedValue({ from: jest.fn(() => builder) });
  const from = jest.fn(() => ({ download }));
  createServiceRoleClient.mockResolvedValue({ storage: { from } });
  return { calls, from };
}

function call(id: string) {
  return GET(new Request(`http://localhost/look/${id}/og`), { params: Promise.resolve({ id }) });
}

let warnSpy: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
});

describe('API-LOOK-007 GET /look/[id]/og', () => {
  it('API-LOOK-007 公開の LOOK は、確かめに通る最初の画像のバイトを短い共有キャッシュつきで返し、Set-Cookie を付けない', async () => {
    const download = jest.fn().mockResolvedValue({ data: new Blob([PNG]), error: null });
    const { calls, from } = fakeClients({ image_urls: ['../x.png', 'looks/2026-01-01/a.png', 'looks/2026-01-01/b.png'] }, download);

    const response = await call('12');

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('cache-control')).toBe('public, max-age=300, s-maxage=300');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG);
    expect(calls).toEqual(
      expect.arrayContaining([
        ['eq', ['status', 'published']],
        ['eq', ['id', 12]],
      ]),
    );
    expect(from).toHaveBeenCalledWith('look-images');
    expect(download).toHaveBeenCalledWith('looks/2026-01-01/a.png');
  });

  it('API-LOOK-007 非公開・無い LOOK（行が無い）は 404 で、置き場を読まない', async () => {
    const download = jest.fn();
    fakeClients(null, download);

    const response = await call('12');

    expect(response.status).toBe(404);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(download).not.toHaveBeenCalled();
  });

  it('API-LOOK-007 画像が全部、置き場の道筋の確かめに通らなければ 404 で、置き場を読まない', async () => {
    const download = jest.fn();
    fakeClients({ image_urls: ['https://evil.example/storage/v1/object/public/look-images/looks/x.png', 'other/y.png'] }, download);

    const response = await call('12');

    expect(response.status).toBe(404);
    expect(download).not.toHaveBeenCalled();
  });

  it('API-LOOK-007 数でない id は、DB にも置き場にも触れず 404 にする', async () => {
    const download = jest.fn();
    fakeClients({ image_urls: ['looks/a.png'] }, download);

    const response = await call('abc');

    expect(response.status).toBe(404);
    expect(createPublicClient).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
  });

  it('API-LOOK-007 置き場が画像でない物を返したら、置き場の Content-Type が画像でも 404 にする', async () => {
    const download = jest.fn().mockResolvedValue({
      data: new Blob([new TextEncoder().encode('<html></html>')], { type: 'image/png' }),
      error: null,
    });
    fakeClients({ image_urls: ['looks/2026-01-01/a.png'] }, download);

    const response = await call('12');

    expect(response.status).toBe(404);
  });
});
