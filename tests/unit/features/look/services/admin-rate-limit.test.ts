jest.mock('@/features/auth/middleware/rateLimit', () => ({
  enforceRateLimit: jest.fn(),
}));

jest.mock('@/features/auth/ratelimit', () => ({
  incrementCounterBy: jest.fn(),
}));

import {
  MAX_LOOK_IMAGES_PER_REQUEST,
  MAX_LOOK_TOTAL_BYTES_PER_HOUR,
  MAX_LOOK_TOTAL_BYTES_PER_REQUEST,
  consumeAdminLookUploadQuota,
  enforceAdminLookMutationRateLimit,
  validateLookImageBatch,
} from '@/features/look/services/admin-rate-limit';
import { enforceRateLimit } from '@/features/auth/middleware/rateLimit';
import { incrementCounterBy } from '@/features/auth/ratelimit';

function createFileMock(size: number): File {
  return {
    size,
  } as File;
}

describe('admin look rate limit', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (enforceRateLimit as jest.Mock).mockResolvedValue(undefined);
    (incrementCounterBy as jest.Mock).mockResolvedValue(1);
  });

  test('DD-LOOK-067 blocks when image count exceeds the per-request cap', () => {
    const files = Array.from({ length: MAX_LOOK_IMAGES_PER_REQUEST + 1 }, () => createFileMock(1024));

    expect(validateLookImageBatch(files)).toBe(
      `A maximum of ${MAX_LOOK_IMAGES_PER_REQUEST} images is allowed per request`,
    );
  });

  test('DD-LOOK-066 runs IP and actor based mutation rate limits', async () => {
    const request = new Request('http://localhost/api/admin/looks', {
      headers: { 'x-real-ip': '1.2.3.4' },
    });

    await enforceAdminLookMutationRateLimit({
      request,
      actorId: 'admin-user-id',
      kind: 'create',
    });

    expect(enforceRateLimit).toHaveBeenNthCalledWith(1, {
      request,
      endpoint: 'admin:looks:create',
      limit: 10,
      windowSeconds: 600,
    });
    expect(enforceRateLimit).toHaveBeenNthCalledWith(2, {
      request,
      endpoint: 'admin:looks:create',
      limit: 10,
      windowSeconds: 600,
      subject: 'admin-user-id',
    });
  });

  test('DD-LOOK-067 returns 429 when hourly upload quota is exceeded', async () => {
    (incrementCounterBy as jest.Mock).mockResolvedValueOnce(MAX_LOOK_TOTAL_BYTES_PER_HOUR + 1);

    const response = await consumeAdminLookUploadQuota({
      actorId: 'admin-user-id',
      kind: 'create',
      totalBytes: 5 * 1024 * 1024,
    });

    expect(response?.status).toBe(429);
    await expect(response?.json()).resolves.toEqual({ error: 'Upload quota exceeded' });
  });
});
describe('admin look rate limit (DD-LOOK-066, DD-LOOK-067 branches)', () => {
  const request = new Request('http://localhost/api/admin/looks');
  const limited = (status: number) => new Response(null, { status });

  beforeEach(() => {
    jest.clearAllMocks();
    (enforceRateLimit as jest.Mock).mockResolvedValue(undefined);
    (incrementCounterBy as jest.Mock).mockResolvedValue(1);
  });

  describe('enforceAdminLookMutationRateLimit', () => {
    test('DD-LOOK-066 送り元の段で断られたら、その応答を返し操作者の段を数えない', async () => {
      const ipResponse = limited(429);
      (enforceRateLimit as jest.Mock).mockResolvedValueOnce(ipResponse);

      const result = await enforceAdminLookMutationRateLimit({
        request,
        actorId: 'admin-user-id',
        kind: 'create',
      });

      expect(result).toBe(ipResponse);
      expect(enforceRateLimit).toHaveBeenCalledTimes(1);
    });

    test('DD-LOOK-066 操作者の段で断られたら、subject 付きの2回目の応答を返す', async () => {
      const actorResponse = limited(429);
      (enforceRateLimit as jest.Mock)
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(actorResponse);

      const result = await enforceAdminLookMutationRateLimit({
        request,
        actorId: 'admin-user-id',
        kind: 'delete',
      });

      expect(result).toBe(actorResponse);
      expect(enforceRateLimit).toHaveBeenCalledTimes(2);
      expect(enforceRateLimit).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ subject: 'admin-user-id' }),
      );
    });

    test('DD-LOOK-066 両方の段を通れば undefined を返す', async () => {
      await expect(
        enforceAdminLookMutationRateLimit({ request, actorId: 'admin-user-id', kind: 'update' }),
      ).resolves.toBeUndefined();
      expect(enforceRateLimit).toHaveBeenCalledTimes(2);
    });

    test.each([
      ['create', 10],
      ['update', 15],
      ['status', 30],
      ['delete', 30],
    ] as const)(
      'DD-LOOK-066 種類 %s の上限は %i 回・窓 600 秒・鍵 admin:looks:<種類>',
      async (kind, limit) => {
        await enforceAdminLookMutationRateLimit({ request, actorId: 'admin-user-id', kind });

        expect(enforceRateLimit).toHaveBeenNthCalledWith(1, {
          request,
          endpoint: `admin:looks:${kind}`,
          limit,
          windowSeconds: 600,
        });
        expect(enforceRateLimit).toHaveBeenNthCalledWith(2, {
          request,
          endpoint: `admin:looks:${kind}`,
          limit,
          windowSeconds: 600,
          subject: 'admin-user-id',
        });
      },
    );
  });

  describe('validateLookImageBatch', () => {
    const MIB = 1024 * 1024;
    const fiveFiles = () =>
      Array.from({ length: MAX_LOOK_IMAGES_PER_REQUEST - 1 }, () => createFileMock(MIB));
    const remainder = MAX_LOOK_TOTAL_BYTES_PER_REQUEST - (MAX_LOOK_IMAGES_PER_REQUEST - 1) * MIB;

    test('DD-LOOK-067 6枚で合計が 20MiB ちょうどなら null', () => {
      const files = [...fiveFiles(), createFileMock(remainder)];

      expect(files).toHaveLength(6);
      expect(validateLookImageBatch(files)).toBeNull();
    });

    test('DD-LOOK-067 6枚で合計が 20MiB を1バイト超えたら合計の文を返す', () => {
      const files = [...fiveFiles(), createFileMock(remainder + 1)];

      expect(validateLookImageBatch(files)).toBe(
        'Total image payload must be 20MB or less per request',
      );
    });

    test('DD-LOOK-067 画像が0枚なら null', () => {
      expect(validateLookImageBatch([])).toBeNull();
    });

    test('DD-LOOK-067 枚数の超過は合計が小さくても枚数の文を返す', () => {
      const files = Array.from({ length: 7 }, () => createFileMock(1));

      expect(validateLookImageBatch(files)).toBe('A maximum of 6 images is allowed per request');
    });
  });

  describe('consumeAdminLookUploadQuota', () => {
    const fixedNow = Date.UTC(2026, 9, 24, 13, 47, 21);

    beforeEach(() => {
      jest.spyOn(Date, 'now').mockReturnValue(fixedNow);
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    test.each([0, -1])('DD-LOOK-067 量が %i の時は数えずに undefined を返す', async (totalBytes) => {
      await expect(
        consumeAdminLookUploadQuota({ actorId: 'admin-user-id', kind: 'update', totalBytes }),
      ).resolves.toBeUndefined();
      expect(incrementCounterBy).not.toHaveBeenCalled();
    });

    test('DD-LOOK-067 足した結果が 60MiB ちょうどなら undefined。鍵と区切りの印は1時間の切り下げ', async () => {
      (incrementCounterBy as jest.Mock).mockResolvedValueOnce(MAX_LOOK_TOTAL_BYTES_PER_HOUR);

      const result = await consumeAdminLookUploadQuota({
        actorId: 'admin-user-id',
        kind: 'create',
        totalBytes: 1024,
      });

      expect(result).toBeUndefined();
      expect(incrementCounterBy).toHaveBeenCalledWith({
        endpoint: 'admin:looks:create:upload-bytes',
        bucket: '2026-10-24T13:00:00.000Z',
        increment: 1024,
        subject: 'admin-user-id',
      });
    });

    test('DD-LOOK-067 update の量は update 用の鍵で数える', async () => {
      await consumeAdminLookUploadQuota({
        actorId: 'admin-user-id',
        kind: 'update',
        totalBytes: 10,
      });

      expect(incrementCounterBy).toHaveBeenCalledWith(
        expect.objectContaining({ endpoint: 'admin:looks:update:upload-bytes' }),
      );
    });

    test('DD-LOOK-067 足した結果が 60MiB+1 なら 429 と Retry-After 3600 を返す', async () => {
      (incrementCounterBy as jest.Mock).mockResolvedValueOnce(MAX_LOOK_TOTAL_BYTES_PER_HOUR + 1);

      const response = await consumeAdminLookUploadQuota({
        actorId: 'admin-user-id',
        kind: 'create',
        totalBytes: 1024,
      });

      expect(response?.status).toBe(429);
      expect(response?.headers.get('Retry-After')).toBe('3600');
      expect(response?.headers.get('Content-Type')).toBe('application/json');
    });

    test('DD-LOOK-067 数え場所が投げたら記録して 503 Rate limiter unavailable を返す', async () => {
      const failure = new Error('db down');
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      (incrementCounterBy as jest.Mock).mockRejectedValueOnce(failure);

      const response = await consumeAdminLookUploadQuota({
        actorId: 'admin-user-id',
        kind: 'create',
        totalBytes: 1024,
      });

      expect(response?.status).toBe(503);
      expect(response?.headers.get('Retry-After')).toBe('3600');
      await expect(response?.json()).resolves.toEqual({ error: 'Rate limiter unavailable' });
      expect(errorSpy).toHaveBeenCalledWith('consumeAdminLookUploadQuota error:', failure);
    });
  });
});
