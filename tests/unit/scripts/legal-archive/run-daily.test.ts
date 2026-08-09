jest.mock('@/lib/legal-archive/s3-storage', () => ({
  createS3ArchiveStorageFromEnv: () => null,
}));

import { runDailyArchive } from '@/../scripts/legal-archive/run-daily';
import type { ArchiveStorage } from '@/lib/legal-archive/storage';

it('paginates the JST calendar year and stores CSV plus database backup', async () => {
  const values = new Map<string, Uint8Array>();
  const target: ArchiveStorage = {
    name: 'supabase',
    putTemporary: async (key, body) => { values.set(key, body); },
    promote: async (temporary, final) => { values.set(final, values.get(temporary)!); },
    exists: async () => false,
    read: async (key) => values.get(key)!,
    removeTemporary: async () => undefined,
  };
  const fetchPage = jest.fn()
    .mockResolvedValueOnce({
      orders: [], orderItems: [], revisions: [], nextCursor: 'next',
      totals: { grossAmount: 0, refundedAmount: 0, netAmount: 0 },
    })
    .mockResolvedValueOnce({
      orders: [], orderItems: [], revisions: [], nextCursor: null,
      totals: { grossAmount: 0, refundedAmount: 0, netAmount: 0 },
    });
  const updateStatus = jest.fn().mockResolvedValue(undefined);
  await runDailyArchive({
    environment: { APP_BASE_URL: 'https://example.com', LEGAL_ARCHIVE_CRON_SECRET: 'secret', GITHUB_SHA: 'abc' },
    now: new Date('2026-08-09T16:00:00.000Z'),
    fetchPage, targets: [target], databaseDump: new Uint8Array([1, 2, 3]), updateStatus,
  });
  expect(fetchPage).toHaveBeenNthCalledWith(1, 2026, null);
  expect(fetchPage).toHaveBeenNthCalledWith(2, 2026, 'next');
  expect(values.has('legal-archive/2026/daily/2026-08-10/database.dump.gz')).toBe(true);
  expect(updateStatus).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'completed' }));
});
