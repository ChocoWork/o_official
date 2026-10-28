/**
 * @jest-environment node
 */
import { GET } from '@/app/look/[id]/og/route';
import { getPublishedLookCoverRaw } from '@/lib/look/server';
import { createServiceRoleClient } from '@/lib/supabase/server';

jest.mock('@/lib/look/server', () => ({
  getPublishedLookCoverRaw: jest.fn(),
}));
jest.mock('@/lib/supabase/server', () => ({
  createServiceRoleClient: jest.fn(),
}));

const mockGetCoverRaw = getPublishedLookCoverRaw as jest.Mock;
const mockCreateServiceRoleClient = createServiceRoleClient as jest.Mock;

const PNG_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPEG_BYTES = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const GIF_BYTES = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 2]);
const WEBP_BYTES = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 1]);

let download: jest.Mock;
let from: jest.Mock;
let warnSpy: jest.SpyInstance;

function call(id: string) {
  return GET(new Request(`http://localhost/look/${id}/og`), { params: Promise.resolve({ id }) });
}

async function bodyBytes(response: Response): Promise<Uint8Array> {
  return new Uint8Array(await response.arrayBuffer());
}

beforeEach(() => {
  jest.clearAllMocks();
  download = jest.fn().mockResolvedValue({ data: new Blob([PNG_BYTES]), error: null });
  from = jest.fn(() => ({ download }));
  mockCreateServiceRoleClient.mockResolvedValue({ storage: { from } });
  mockGetCoverRaw.mockResolvedValue('looks/2026-10-01/a.png');
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
});

describe('DD-LOOK-071 GET /look/[id]/og', () => {
  it('DD-LOOK-071 公開の LOOK の先頭の画像のバイトを、検出した種類・短い共有キャッシュ・nosniff で返し、Set-Cookie を付けない', async () => {
    const response = await call('5');

    expect(response.status).toBe(200);
    expect(mockGetCoverRaw).toHaveBeenCalledWith(5);
    expect(from).toHaveBeenCalledWith('look-images');
    expect(download).toHaveBeenCalledWith('looks/2026-10-01/a.png');
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('cache-control')).toBe('public, max-age=300, s-maxage=300');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(await bodyBytes(response)).toEqual(PNG_BYTES);
  });

  it.each([
    ['image/jpeg', JPEG_BYTES],
    ['image/webp', WEBP_BYTES],
    ['image/gif', GIF_BYTES],
  ])('DD-LOOK-071 先頭の印が %s ならその種類で返す', async (type, bytes) => {
    download.mockResolvedValue({ data: new Blob([bytes]), error: null });

    const response = await call('5');

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe(type);
  });

  it('DD-LOOK-071 保存先が送る Content-Type は信じず、バイトの先頭の印が画像でなければ 404 にする', async () => {
    download.mockResolvedValue({
      data: new Blob([new TextEncoder().encode('<html><script>x</script></html>')], { type: 'image/png' }),
      error: null,
    });

    const response = await call('5');

    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).not.toMatch(/^image\//);
  });

  it.each(['abc', '0', '-1', '1.5', '99999999999999999999'])(
    'DD-LOOK-071 正の整数でない id %p は、LOOK を取りに行かず 404 にする',
    async (id) => {
      const response = await call(id);

      expect(response.status).toBe(404);
      expect(mockGetCoverRaw).not.toHaveBeenCalled();
      expect(download).not.toHaveBeenCalled();
    },
  );

  it('DD-LOOK-071 非公開・無い LOOK（取り出しが null）は 404 で、置き場を読まない', async () => {
    mockGetCoverRaw.mockResolvedValue(null);

    const response = await call('5');

    expect(response.status).toBe(404);
    expect(download).not.toHaveBeenCalled();
  });

  it.each(['https://evil.example/storage/v1/object/public/look-images/looks/x.png', '../x.png', 'other/x.png'])(
    'DD-LOOK-071 取り出した値 %p が置き場の道筋の確かめに通らなければ 404 にし、置き場を読まない',
    async (raw) => {
      mockGetCoverRaw.mockResolvedValue(raw);

      const response = await call('5');

      expect(response.status).toBe(404);
      expect(download).not.toHaveBeenCalled();
    },
  );

  it('DD-LOOK-071 置き場の読み出しが誤りを返したら 404 にし、本文にも記録にも誤りの文を出さない', async () => {
    download.mockResolvedValue({ data: null, error: { message: 'SECRET_STORAGE_DETAIL looks/2026-10-01/a.png' } });

    const response = await call('5');
    const text = await response.text();

    expect(response.status).toBe(404);
    expect(text).not.toContain('SECRET_STORAGE_DETAIL');
    expect(text).not.toContain('looks/');
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain('SECRET_STORAGE_DETAIL');
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain('looks/2026');
  });

  it('DD-LOOK-071 置き場の読み出しが投げても 404 にする', async () => {
    download.mockRejectedValue(new Error('SECRET_STORAGE_DETAIL'));

    const response = await call('5');

    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain('SECRET_STORAGE_DETAIL');
  });

  it('DD-LOOK-071 404 は no-store で、Set-Cookie を付けない', async () => {
    mockGetCoverRaw.mockResolvedValue(null);

    const response = await call('5');

    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('set-cookie')).toBeNull();
  });
});
