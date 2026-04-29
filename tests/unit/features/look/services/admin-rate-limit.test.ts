jest.mock('@/features/auth/middleware/rateLimit', () => ({
  enforceRateLimit: jest.fn(),
}));

jest.mock('@/features/auth/ratelimit', () => ({
  incrementCounterBy: jest.fn(),
}));

import {
  MAX_LOOK_IMAGES_PER_REQUEST,
  MAX_LOOK_TOTAL_BYTES_PER_HOUR,
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

  test('blocks when image count exceeds the per-request cap', () => {
    const files = Array.from({ length: MAX_LOOK_IMAGES_PER_REQUEST + 1 }, () => createFileMock(1024));

    expect(validateLookImageBatch(files)).toBe(
      `A maximum of ${MAX_LOOK_IMAGES_PER_REQUEST} images is allowed per request`,
    );
  });

  test('runs IP and actor based mutation rate limits', async () => {
    const request = new Request('http://localhost/api/admin/looks', {
      headers: { 'x-forwarded-for': '1.2.3.4' },
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

  test('returns 429 when hourly upload quota is exceeded', async () => {
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